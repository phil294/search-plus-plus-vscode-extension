// Runs in a worker_thread. Owns the single SQLite connection (better-sqlite3 is synchronous and
// a connection must not be shared across threads) and does all indexing work off
// the extension host, communicating via RPC messages over parentPort.

const { parentPort, workerData } = require('worker_threads')
const { Indexer } = require('./indexer')
const { IndexQueue } = require('./index-queue')
const { set_verbose, log_debug, log_info, log_error } = require('./log')

if (! parentPort)
	throw new Error('worker.js must be run as a worker_thread')

set_verbose(workerData.verbose)
const index_params = workerData.index_params || {}
const indexer = new Indexer({ storage_path: workerData.storage_path })
const queue = new IndexQueue(indexer, { max_index_size: index_params.max_index_size, max_avg_line_length: index_params.max_avg_line_length })

let on_progress = (/** @type {number|null} */ value) =>
	parentPort?.postMessage({ type: 'progress', value })

let draining = false
/** Runs the queue until empty. Guards against concurrent runs; files added while running
 * (e.g. from watcher events) are picked up by the trailing loop. */
async function drain() {
	if (draining)
		return
	draining = true
	try {
		do
			await queue.run({ on_progress })
		while (queue.size > 0)
	} finally {
		draining = false
	}
}

/** Full scan reconciliation: (re)index changed files, drop files that no longer exist. */
async function sync_files(/** @type {import('./indexer').FileMeta[]} */ metas) {
	let t_sync = Date.now()
	let old_meta_docs = indexer.all_meta_docs()
	/** @type {Record<string,import('./indexer').IndexDoc>} */
	let old_by_path = {}
	for (let doc of old_meta_docs)
		old_by_path[doc.path] = doc
	// Re-index a file when its mtime changed OR when its content-indexed intent flipped (e.g. the user
	// toggled search.useIgnoreFiles / an exclude, so a name-only file should now be full-text indexed or
	// vice versa) — the mtime alone would miss that.
	for (let meta of metas) {
		let old = old_by_path[meta.path]
		let want_content = meta.index_content !== false
		if (! old || old.mtime !== meta.mtime || !! old.content_indexed !== want_content)
			queue.add(meta)
	}
	let new_paths = new Set(metas.map(m => m.path))
	let gone = old_meta_docs.filter(doc => ! new_paths.has(doc.path)).map(doc => doc.path)
	if (gone.length) {
		log_debug('deleting docs no longer present', gone.length)
		await indexer.delete_doc_by_path(...gone)
	}
	// For a large (re)index, building the file_content word indexes once at the end is much faster
	// than maintaining them across millions of per-row inserts. Recreate is crash-safe (init_db uses
	// `if not exists`). Skipped for small syncs where the rebuild cost would outweigh the saving.
	let bulk = queue.size > 5000
	let to_index = queue.size
	log_info(`sync: ${queue.size} file(s) to (re)index, ${gone.length} gone${bulk ? ', deferred word-index build' : ''}`)
	if (bulk) {
		let t = Date.now()
		indexer.drop_word_indexes()
		log_info(`drop_word_indexes ${Date.now() - t}ms`)
	}
	let t_drain = Date.now()
	try {
		await drain()
	} finally {
		log_info(`indexing drain done in ${((Date.now() - t_drain) / 1000).toFixed(1)}s`)
		if (bulk) {
			let t = Date.now()
			indexer.create_word_indexes()
			log_info(`create_word_indexes ${((Date.now() - t) / 1000).toFixed(1)}s`)
		}
		indexer.checkpoint()
	}
	log_info(`synced ${to_index} file(s) (${gone.length} removed) in ${((Date.now() - t_sync) / 1000).toFixed(1)}s`)
}

/** Index a specific set of files (e.g. from file-watcher change events). */
async function index_files(/** @type {import('./indexer').FileMeta[]} */ metas) {
	for (let meta of metas)
		queue.add(meta)
	await drain()
	indexer.checkpoint()
}

async function delete_paths(/** @type {string[]} */ paths) {
	await indexer.delete_doc_by_path(...paths)
}

/** Apply changed index-shaping settings to the live worker so newly added/changed files use them.
 * Existing files are left untouched (rebuilding a large index is expensive); the "Rebuild Index"
 * command wipes and reindexes everything when that's actually wanted. */
function set_index_params(/** @type {{max_index_size?:number, max_avg_line_length?:number}} */ params) {
	if (params.max_index_size != null)
		queue.max_index_size = params.max_index_size
	if (params.max_avg_line_length != null)
		queue.max_avg_line_length = params.max_avg_line_length
}

/** Wipe the whole index. Used by the manual "Rebuild Index" command; the host then triggers a scan. */
function clear_index() {
	indexer.clear_all()
}

// Highest search sequence seen so far; a line scan bails as soon as a newer one arrives (see below).
let latest_lines_seq = 0

/** @type {Record<string, (...args:any[])=>any>} */
const methods = {
	sync_files,
	index_files,
	delete_paths,
	set_index_params,
	clear_index,
	all_meta_docs: () => indexer.all_meta_docs(),
	all_file_paths: () => indexer.all_file_paths(),
	autocomplete_word: (/** @type string */ word, /** @type number */ limit) => indexer.autocomplete_word(word, limit),
	find_paths_by_word: (/** @type string */ word, /** @type number */ limit) => indexer.find_paths_by_word(word, limit),
	find_paths_fuzzy: (/** @type string[] */ tokens, /** @type number */ limit) => indexer.find_paths_fuzzy(tokens, limit),
	find_candidate_paths: (/** @type string */ word, /** @type boolean */ is_partial, /** @type number */ limit, /** @type any */ filter) => indexer.find_candidate_paths(word, is_partial, limit, filter),
	find_lines_for_paths: (/** @type string[] */ paths, /** @type string */ word, /** @type number */ limit, /** @type {number|undefined} */ seq, /** @type {number|undefined} */ time_budget_ms) => {
		// A monotonic `seq` (per search keystroke) lets a newer scan supersede an in-flight one: the
		// worker runs RPCs one at a time, so a long scan on slow hardware would otherwise block every
		// later keystroke. The scan yields periodically and bails once a higher seq has arrived.
		if (typeof seq === 'number' && seq > latest_lines_seq)
			latest_lines_seq = seq
		return indexer.find_lines_for_paths(paths, word, limit, typeof seq === 'number' ? () => seq < latest_lines_seq : undefined, time_budget_ms)
	},
	find_paths_with_lines_by_word: (/** @type string */ word, /** @type boolean */ is_partial, /** @type number */ limit, /** @type any */ filter) => indexer.find_paths_with_lines_by_word(word, is_partial, limit, filter),
	set_verbose: (/** @type boolean */ v) => { set_verbose(v) },
}

parentPort.on('message', async (msg) => {
	if (! msg || msg.type !== 'rpc')
		return
	let { id, method, args } = msg
	try {
		let fn = methods[method]
		if (! fn)
			throw new Error('unknown worker method: ' + method)
		let call_args = args || []
		let result = await fn(...call_args)
		parentPort?.postMessage({ type: 'rpc-reply', id, result })
	} catch (e) {
		parentPort?.postMessage({ type: 'rpc-reply', id, error: String(e?.stack || e) })
	}
})

process.on('unhandledRejection', (/** @type any */ err) => {
	log_error('worker unhandledRejection', err && (err.stack || err.message || err))
})
