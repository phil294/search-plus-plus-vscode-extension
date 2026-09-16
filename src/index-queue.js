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
	constructor(/** @type Indexer */ indexer, /** @type {{read_group_size?:number, docs_batch_bytes_threshold?:number, max_index_size?:number, max_docs_per_batch?:number, max_avg_line_length?:number, yield_interval_ms?:number, yield_sleep_ms?:number}} */ options = {}) {
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
		let flush_docs_batch = async () => {
			log_debug(`batch-index ${docs_batch.length} docs`)
			if (! docs_batch.length)
				return
			try {
				await this.indexer.index_docs(docs_batch)
			} catch (e) {
				// shouldn't throw because then is_running won't be unset, and errors, if any, are most likely to occur here
				log_error('Indexing docs failed unexpectedly: ', e.stack, e)
				try {
					this.indexer.db.exec('rollback')
				} catch (ee) {
					log_error('rollback on Indexing docs failed unexpectedly: ', ee.stack, ee)
				}
			}
			docs_batch_bytes_read = 0
			docs_batch = []
		}
		let uri_i = -1
		let skipped_path_EACCESS = ''
		const read_group_size = this.read_group_size
		const max_docs_per_batch = this.max_docs_per_batch
		let entries = [...this.entries()]
		let last_pause = Date.now()
		for (let i = 0; i < entries.length; i += read_group_size) {
			let read_group = entries.slice(i, i + read_group_size) // calling it "group" to distinguish from index-flush "batch"
			await Promise.all(read_group.map(async ([path, file_meta]) => {
				this.delete(path)
				uri_i++
				// TODO: perf?
				log_debug(`indexing (${uri_i + 1}/${size}) ${path}`)
				if (uri_i % 100 === 0)
					on_progress(uri_i / size)
				// Binary-by-extension, empty, oversized, minified/generated (by name), and gitignored
				// (index_content === false) files are still recorded (so the file picker can link to them
				// and they aren't rescanned each time), but their contents are not indexed: text stays null
				// and no read happens.
				if (file_meta.index_content === false || file_meta.size === 0 || file_meta.size > this.max_index_size || content_excluded_name_re.test(file_meta.path) || await isBinary(file_meta.path, undefined)) {
					docs_batch.push({ path: file_meta.path, mtime: file_meta.mtime, text: null })
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
					else
						// TODO check logs size and when expiring
						log_error(`Indexing: Unexpected error: Failed to read file '${path}': ${JSON.stringify(e)}`)
					return
				}
				if (await isBinary(null, file_buf)) { // check buffer contents
					log_debug('skipping: is binary (buf)')
					// still recorded, but contents not indexed
					docs_batch.push({ path: file_meta.path, mtime: file_meta.mtime, text: null })
					return
				}
				if (avg_non_empty_line_length(file_buf) > this.max_avg_line_length) {
					log_debug('skipping content: huge average line length (minified/data)')
					// still recorded, but contents not indexed
					docs_batch.push({ path: file_meta.path, mtime: file_meta.mtime, text: null })
					return
				}
				docs_batch.push({ path: file_meta.path, mtime: file_meta.mtime, text: file_buf.toString() })
				docs_batch_bytes_read += file_buf.length
			}))
			if (docs_batch_bytes_read > docs_batch_bytes_threshold || docs_batch.length >= max_docs_per_batch)
				await flush_docs_batch()
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
		log_debug(`indexing took ${(Date.now() - start) / 1000} seconds`)
		log_info(`indexed ${size} file(s) in ${((Date.now() - start) / 1000).toFixed(1)}s`)
		console.debug(`search++: indexing took ${(Date.now() - start) / 1000} seconds`)
		on_progress(null)
		this.is_running = false
	}
}

module.exports.IndexQueue = IndexQueue
