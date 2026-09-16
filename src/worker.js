// Runs in a worker_thread. Owns the single SQLite connection (node-sqlite3-wasm cannot be
// safely accessed from multiple connections/threads at once) and does all indexing work off
// the extension host, communicating via RPC messages over parentPort.

const { parentPort, workerData } = require('worker_threads')
const { Indexer } = require('./indexer')
const { IndexQueue } = require('./index-queue')
const { set_verbose, log_debug, log_info, log_error } = require('./log')

if (! parentPort)
	throw new Error('worker.js must be run as a worker_thread')

set_verbose(workerData.verbose)
const indexer = new Indexer({ storage_path: workerData.storage_path })
const queue = new IndexQueue(indexer)

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
	let old_meta_docs = indexer.all_meta_docs()
	/** @type {Record<string,number>} */
	let old_mtime_by_path = {}
	for (let doc of old_meta_docs)
		old_mtime_by_path[doc.path] = doc.mtime
	for (let meta of metas)
		if (old_mtime_by_path[meta.path] !== meta.mtime)
			queue.add(meta)
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
	}
}

/** Index a specific set of files (e.g. from file-watcher change events). */
async function index_files(/** @type {import('./indexer').FileMeta[]} */ metas) {
	for (let meta of metas)
		queue.add(meta)
	await drain()
}

async function delete_paths(/** @type {string[]} */ paths) {
	await indexer.delete_doc_by_path(...paths)
}

/** @type {Record<string, (...args:any[])=>any>} */
const methods = {
	sync_files,
	index_files,
	delete_paths,
	all_meta_docs: () => indexer.all_meta_docs(),
	all_file_paths: () => indexer.all_file_paths(),
	autocomplete_word: (/** @type string */ word, /** @type number */ limit) => indexer.autocomplete_word(word, limit),
	find_paths_by_word: (/** @type string */ word, /** @type number */ limit) => indexer.find_paths_by_word(word, limit),
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
