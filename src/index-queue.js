let { log_debug, log_info, log_error, log_warn } = require('./log')
let { readFile } = require('fs/promises')
let { sleep } = require('./util')
let { isBinary } = require('./lib/istextorbinary')

/** @typedef {import('./indexer').Indexer} Indexer */
/** @typedef {import('./indexer').IndexDoc} IndexDoc */
/** @typedef {import('./indexer').FileMeta} FileMeta */

// TODO configure. A large value here isn't really dangerous (apart from increasing index size and initial
// indexing time), but the product of this and read_group_size x4 will be the amount of RAM (in MB) that's
// needed while indexing, so be careful setting both too high.
const default_max_index_size = 20 * 1024 * 1024

// Files whose average non-empty line exceeds this many characters are treated as name-only (not
// content-indexed): minified/bundled/data files blow up the trigram index without being usefully searchable.
// 300 is well above normal source (~30-60/line) so hand-written code is safe; benchmark: ~22% faster indexing.
const default_max_avg_line_length = 300

// Minified/generated/lock files: listed in the picker but never full-text indexed. Matches on the full
// path; [\\/] anchors the lock-file names to a path segment so e.g. a real 'yarn.lock' isn't a substring hit.
const content_excluded_name_re = /\.min\.(?:js|css)$|\.map$|\.lock$|[\\/](?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml)$/i

/** Average length of non-empty lines, ignoring fully empty lines (trailing \r not counted). 0 if none. */
function avg_non_empty_line_length(/** @type Buffer */ buf) {
	let lines = 0
	let total = 0
	let len = 0
	let cr = false
	for (let i = 0; i < buf.length; i++) {
		const b = buf[i]
		if (b === 10) { // \n
			const eff = len - (cr ? 1 : 0)
			if (eff > 0) {
				lines++
				total += eff
			}
			len = 0
			cr = false
		} else {
			len++
			cr = b === 13 // \r
		}
	}
	const eff = len - (cr ? 1 : 0)
	if (eff > 0) {
		lines++
		total += eff
	}
	return lines ? total / lines : 0
}

/** @augments {Map<string, FileMeta>} */
class IndexQueue extends Map {
	constructor(/** @type Indexer */ indexer, /** @type {{read_group_size?:number, docs_batch_bytes_threshold?:number, max_index_size?:number, max_docs_per_batch?:number, max_avg_line_length?:number, yield_interval_ms?:number, yield_sleep_ms?:number, flush_target_ms?:number, min_docs_per_flush?:number, docs_per_flush?:number, yield_fn?:()=>Promise<any>}} */ options = {}) {
		super()
		this.indexer = indexer
		this.is_running = false
		// read_group_size: 100 7sec, 20 8sec, 10 9sec, 1 12sec. Mustn't be too big because reading many
		// files at once and keeping them in ram can be heavy on system resources.
		this.read_group_size = options.read_group_size ?? 20
		// docs_batch_bytes_threshold: s2 tests: 1 KB 93 sec, 1 MB 43 sec, 5 MB 30 sec, 10 MB 30 sec.
		this.docs_batch_bytes_threshold = options.docs_batch_bytes_threshold ?? 5 * 1024 * 1024
		this.max_index_size = options.max_index_size ?? default_max_index_size
		// Cap docs per index batch so index_docs' multi-row INSERTs stay well under SQLite's
		// bound-parameter limit (32766): name-only files add to the batch without adding bytes, so the
		// byte threshold alone can't bound the doc count. Also keeps batch memory bounded.
		this.max_docs_per_batch = options.max_docs_per_batch ?? 5000
		this.max_avg_line_length = options.max_avg_line_length ?? default_max_avg_line_length
		this.yield_interval_ms = options.yield_interval_ms ?? 90
		this.yield_sleep_ms = options.yield_sleep_ms ?? 7
		// A single index_docs() call blocks the synchronous worker thread for its whole duration, so one
		// huge flush froze searches/the picker for the better part of a minute on a large, fragmented
		// index. Instead each flush is split into sub-batches whose size is steered toward flush_target_ms
		// of wall-time, yielding the thread between them (yield_fn) so queued read RPCs run first. Bursts
		// become roughly time-uniform regardless of per-file cost; docs_per_flush starts small and grows
		// on a healthy index (fast) or stays near min on a slow one (responsive). Clamped to
		// [min_docs_per_flush, max_docs_per_batch].
		this.flush_target_ms = options.flush_target_ms ?? 250
		this.min_docs_per_flush = options.min_docs_per_flush ?? 10
		this.docs_per_flush = options.docs_per_flush ?? this.min_docs_per_flush
		// Injected by the worker to hand the thread back to pending reads between DB bursts; a plain
		// event-loop turn when the queue is used standalone.
		this.yield_fn = options.yield_fn ?? (() => new Promise(resolve => setImmediate(resolve)))
		// Set true (via cancel()) to abort an in-flight run() at the next sub-batch / read-group boundary.
		this.cancelled = false
	}

	/** Abort the in-flight drain ASAP. Committed sub-batches persist; unread files stay queued and are
	 * re-diffed by the next sync, so nothing is lost or indexed twice. Used when a fresh scan supersedes. */
	cancel() {
		this.cancelled = true
	}

	add(/** @type FileMeta */ file_meta) {
		this.set(file_meta.path, file_meta)
	}

	/** Reads the files and runs the indexer in batches optimized for speed. Clears itself while running. */
	async run(/** @type {{on_progress:(n:number|null)=>any}} */ { on_progress }) {
		if (this.is_running)
			throw new Error('index queue already running')
		this.is_running = true
		let size = this.size
		// log_info('sleep')
		// await sleep(300000)
		log_info('run index queue with ' + size + ' entries...')
		let start = Date.now()

		/** @type {IndexDoc[]} */
		let docs_batch = [] // TODO no implcit any
		const docs_batch_bytes_threshold = this.docs_batch_bytes_threshold
		let docs_batch_bytes_read = 0
		// Flush the accumulated docs in time-bounded sub-batches, handing the thread back between each
		// (yield_fn) so queued read RPCs run promptly instead of waiting out the whole flush. Each
		// sub-batch is its own index_docs() transaction; its duration steers docs_per_flush toward
		// flush_target_ms (halve on overshoot, grow when well under budget).
		let flush_docs_batch = async () => {
			if (! docs_batch.length)
				return
			let batch = docs_batch
			docs_batch = []
			docs_batch_bytes_read = 0
			log_debug(`batch-index ${batch.length} docs (~${this.docs_per_flush}/flush)`)
			let i = 0
			while (i < batch.length) {
				if (this.cancelled)
					break
				// Capture the size BEFORE processing: the adaptive resize below changes docs_per_flush for
				// the NEXT burst, and advancing i by a different amount than we sliced would skip/duplicate docs.
				let n = this.docs_per_flush
				let sub = batch.slice(i, i + n)
				i += n
				let t = Date.now()
				try {
					this.indexer.index_docs(sub)
				} catch (e) {
					// shouldn't throw because then is_running won't be unset, and errors, if any, are most likely to occur here
					log_error('Indexing docs failed unexpectedly: ', e.stack, e)
					try {
						this.indexer.db.exec('rollback')
					} catch (ee) {
						log_error('rollback on Indexing docs failed unexpectedly: ', ee.stack, ee)
					}
				}
				let dur = Date.now() - t
				if (dur > this.flush_target_ms * 1.5)
					this.docs_per_flush = Math.max(this.min_docs_per_flush, Math.floor(this.docs_per_flush / 2))
				else if (dur < this.flush_target_ms * 0.5)
					this.docs_per_flush = Math.min(this.max_docs_per_batch, Math.ceil(this.docs_per_flush * 1.5))
				// Hand the thread back so pending read RPCs are dispatched before the next DB burst.
				await this.yield_fn()
			}
		}
		let uri_i = -1
		let skipped_path_EACCESS = ''
		const read_group_size = this.read_group_size
		const max_docs_per_batch = this.max_docs_per_batch
		let entries = [...this.entries()]
		let last_pause = Date.now()
		let last_progress = Date.now()
		for (let i = 0; i < entries.length; i += read_group_size) {
			if (this.cancelled) {
				log_info('index run cancelled; ' + this.size + ' file(s) left queued for the next sync')
				break
			}
			let read_group = entries.slice(i, i + read_group_size) // calling it "group" to distinguish from index-flush "batch"
			await Promise.all(read_group.map(async ([path, file_meta]) => {
				this.delete(path)
				uri_i++
				// TODO: perf?
				log_debug(`indexing (${uri_i + 1}/${size}) ${path}`)
				// Binary-by-extension, empty, oversized, minified/generated (by name), and gitignored
				// (index_content === false) files are still recorded (so the file picker can link to them
				// and they aren't rescanned each time), but their contents are not indexed: text stays null
				// and no read happens.
				if (file_meta.index_content === false || file_meta.size === 0 || file_meta.size > this.max_index_size || content_excluded_name_re.test(file_meta.path) || await isBinary(file_meta.path, undefined)) {
					docs_batch.push({ path: file_meta.path, mtime: file_meta.mtime, text: null, content_indexed: file_meta.index_content !== false })
					return
				}
				let file_buf
				try {
					file_buf = await readFile(file_meta.path)
				} catch (e) {
					if (e.code === 'EISDIR') // TODO: why do some dirs appear here? via file changer it seems
						log_warn(file_meta.path, e)
					else if (e.code === 'EACCES')
						skipped_path_EACCESS = file_meta.path
					else if (e.code === 'ENOENT') // deleted between enqueue and read (branch switch etc.); already removed above
						log_debug(`indexing: file vanished before read, skipping ${file_meta.path}`)
					else
						// TODO check logs size and when expiring
						log_error(`Indexing: Unexpected error: Failed to read file '${path}': ${JSON.stringify(e)}`)
					return
				}
				if (await isBinary(null, file_buf)) { // check buffer contents
					log_debug('skipping: is binary (buf)')
					// still recorded, but contents not indexed
					docs_batch.push({ path: file_meta.path, mtime: file_meta.mtime, text: null, content_indexed: true })
					return
				}
				if (avg_non_empty_line_length(file_buf) > this.max_avg_line_length) {
					log_debug('skipping content: huge average line length (minified/data)')
					// still recorded, but contents not indexed
					docs_batch.push({ path: file_meta.path, mtime: file_meta.mtime, text: null, content_indexed: true })
					return
				}
				docs_batch.push({ path: file_meta.path, mtime: file_meta.mtime, text: file_buf.toString(), content_indexed: true })
				docs_batch_bytes_read += file_buf.length
			}))
			if (docs_batch_bytes_read > docs_batch_bytes_threshold || docs_batch.length >= max_docs_per_batch)
				await flush_docs_batch()
			// Update the status bar on a fixed cadence (not per N files) so it stays smooth regardless of
			// per-file cost, and cheap on tiny files.
			if (Date.now() - last_progress > 250) {
				on_progress(uri_i / size)
				last_progress = Date.now()
			}
			// Yield the disk frequently but briefly so a long index doesn't starve other fs users
			// (editor search, file saves). Time-based, so the overhead and total index time stay small.
			if (Date.now() - last_pause > this.yield_interval_ms) {
				await sleep(this.yield_sleep_ms)
				last_pause = Date.now()
			}
		}
		await flush_docs_batch()
		if (skipped_path_EACCESS)
			log_error(`Warning: File '${skipped_path_EACCESS}' could not be read due to permission problems.`)

		log_debug('indexing complete')
		const duration = Date.now() - start
		log_debug(`indexing took ${duration / 1000} seconds`)
		log_info(`indexed ${size} file(s) in ${(duration / 1000).toFixed(1)}s`)
		console.debug(`search++: indexing took ${duration / 1000} seconds`)
		if (duration < 400) {
			on_progress(1)
			await sleep(400 - duration)
		}
		on_progress(null)
		this.is_running = false
	}
}

module.exports.IndexQueue = IndexQueue
