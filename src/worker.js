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
	// Building the file_content word indexes once at the end (drop first, recreate after) only pays off
	// when we're (re)indexing MOST of the DB, because create_word_indexes rebuilds them over the ENTIRE
	// table — an O(all rows) full sort. For an incremental sync that touches a small fraction (e.g. a
	// branch switch / npm install on a large repo), that global rebuild dwarfs the cost of just
	// maintaining the indexes in place for the changed rows, and blocked the worker for minutes
	// (create_word_indexes 273s). So only go bulk when the batch is a large share of the whole index.
	let existing = old_meta_docs.length
	let bulk = queue.size > 5000 && queue.size > existing * 0.5
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
	search_lines: (/** @type string */ word, /** @type number */ limit, /** @type any */ filter) => indexer.search_lines(word, limit, filter),
	find_definition_lines: (/** @type string */ word, /** @type number */ limit) => indexer.find_definition_lines(word, limit),
	set_verbose: (/** @type boolean */ v) => { set_verbose(v) },
}

// The worker owns ONE synchronous SQLite connection. The message handler is async, so if several
// mutating RPCs are in flight they interleave at every `await` (file reads, sleeps, drain yields) and
// end up fighting over the same connection + index queue: wall-times balloon (a 847-file index_files
// run measured 400s because a concurrent sync_files' 273s create_word_indexes blocked the thread
// mid-run) and operations appear to block each other. So chain all mutating RPCs to run strictly one
// at a time, in arrival order. Read-only RPCs (search/autocomplete/picker) bypass the chain so they
// stay responsive between index batches.
const write_methods = new Set(['sync_files', 'index_files', 'delete_paths', 'set_index_params', 'clear_index'])
let write_chain = Promise.resolve()
/** Run one RPC and reply. `took Xms` (host side) includes queue-wait; this logs the ACTUAL work time. */
async function dispatch(/** @type number */ id, /** @type string */ method, /** @type {any[]} */ call_args) {
	let t = Date.now()
	try {
		let fn = methods[method]
		if (! fn)
			throw new Error('unknown worker method: ' + method)
		let result = await fn(...call_args)
		parentPort?.postMessage({ type: 'rpc-reply', id, result })
	} catch (e) {
		parentPort?.postMessage({ type: 'rpc-reply', id, error: String(e?.stack || e) })
	} finally {
		let dur = Date.now() - t
		if (dur > 2000)
			log_info(`worker rpc ${method} ran ${(dur / 1000).toFixed(1)}s of actual work`)
	}
}

parentPort.on('message', (msg) => {
	if (! msg || msg.type !== 'rpc')
		return
	let { id, method, args } = msg
	let call_args = args || []
	if (write_methods.has(method))
		// Serialize mutations: run strictly one at a time in arrival order.
		write_chain = write_chain.then(() => dispatch(id, method, call_args))
	else
		// Reads bypass the chain so search/autocomplete/picker stay responsive between index batches.
		dispatch(id, method, call_args)
})

process.on('unhandledRejection', (/** @type any */ err) => {
	log_error('worker unhandledRejection', err && (err.stack || err.message || err))
})
