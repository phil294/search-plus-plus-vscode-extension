const { Worker } = require('worker_threads')
const { existsSync } = require('fs')
const { host_write, log_debug } = require('./log')

/** Extension-host side proxy around the indexing worker thread. All indexer/queue calls go
 * through here as RPC. Also forwards the worker's log and progress messages to the host. */
class IndexerClient {
	constructor(/** @type import('vscode').ExtensionContext */ context, /** @type {{storage_path:string, verbose:boolean, on_progress:(n:number|null)=>any, index_params?:{max_index_size?:number, max_avg_line_length?:number}}} */ { storage_path, verbose, on_progress, index_params }) {
		this.on_progress = on_progress
		this._id = 0
		/** @type {Map<number,{resolve:(v:any)=>void, reject:(e:any)=>void}>} */
		this._pending = new Map()
		/** @type {{path:string, mtime:number}[]|null} */
		this._file_paths_cache = null
		// In development the sources ship as-is (src/worker.js). In a packaged build, src/ is
		// stripped and the worker is bundled to the extension root as worker.js (see release.sh).
		let worker_path = context.asAbsolutePath('src/worker.js')
		if (! existsSync(worker_path))
			worker_path = context.asAbsolutePath('worker.js')
		this.worker = new Worker(worker_path, { workerData: { storage_path, verbose, index_params } })
		this.worker.on('message', (msg) => this._on_message(msg))
		this.worker.on('error', (err) => host_write('error', ['Indexing worker error', String(err?.stack || err)]))
		this.worker.on('exit', (code) => {
			if (code !== 0)
				host_write('error', ['Indexing worker stopped unexpectedly (exit code ' + code + ')'])
		})
	}

	_on_message(/** @type any */ msg) {
		if (! msg)
			return
		if (msg.type === 'rpc-reply') {
			let pending = this._pending.get(msg.id)
			if (! pending)
				return
			this._pending.delete(msg.id)
			if (msg.error)
				pending.reject(new Error(msg.error))
			else
				pending.resolve(msg.result)
		} else if (msg.type === 'progress')
			this.on_progress?.(msg.value)
		else if (msg.type === 'log')
			host_write(msg.level, msg.args)
	}

	call(/** @type string */ method, /** @type any[] */ ...args) {
		let id = ++this._id
		let start = Date.now()
		return new Promise((resolve, reject) => {
			this._pending.set(id, {
				resolve: (/** @type any */ v) => { log_debug(`rpc ${method} took ${Date.now() - start}ms`); resolve(v) },
				reject: (/** @type any */ e) => { log_debug(`rpc ${method} failed after ${Date.now() - start}ms`); reject(e) },
			})
			this.worker.postMessage({ type: 'rpc', id, method, args })
		})
	}

	async sync_files(/** @type import('./indexer').FileMeta[] */ metas) {
		this._file_paths_cache = null
		let result = await this.call('sync_files', metas)
		this._file_paths_cache = null
		return result
	}

	async index_files(/** @type import('./indexer').FileMeta[] */ metas) {
		let result = await this.call('index_files', metas)
		this._file_paths_cache = null
		return result
	}

	delete_paths(/** @type string[] */ paths) {
		this._file_paths_cache = null
		return this.call('delete_paths', paths)
	}

	all_meta_docs() {
		return /** @type {Promise<import('./indexer').IndexDoc[]>} */ (this.call('all_meta_docs')) // eslint-disable-line no-extra-parens
	}

	/** cached; invalidated whenever the index changes. Each entry carries mtime (unix seconds) so the
	 * file picker can rank by modification time. */
	async all_file_paths() {
		if (! this._file_paths_cache)
			this._file_paths_cache = /** @type {{path:string, mtime:number}[]} */ (await this.call('all_file_paths')) // eslint-disable-line no-extra-parens
		return this._file_paths_cache
	}

	autocomplete_word(/** @type string */ word, /** @type number */ limit) {
		return /** @type {Promise<string[]>} */ (this.call('autocomplete_word', word, limit)) // eslint-disable-line no-extra-parens
	}

	find_paths_by_word(/** @type string */ word, /** @type number */ limit) {
		return /** @type {Promise<string[]>} */ (this.call('find_paths_by_word', word, limit)) // eslint-disable-line no-extra-parens
	}

	find_paths_fuzzy(/** @type string[] */ tokens, /** @type number */ limit) {
		return /** @type {Promise<{path:string, mtime:number}[]>} */ (this.call('find_paths_fuzzy', tokens, limit)) // eslint-disable-line no-extra-parens
	}

	find_paths_with_lines_by_word(/** @type string */ word, /** @type boolean */ is_partial, /** @type number */ limit, /** @type {{include?:string[], exclude?:string[], roots?:string[]}} */ filter = {}) {
		return /** @type {Promise<{results:{path:string, matches:{line_number:number, line_text:string}[]}[], has_more:boolean}>} */ (this.call('find_paths_with_lines_by_word', word, is_partial, limit, filter)) // eslint-disable-line no-extra-parens
	}

	set_verbose(/** @type boolean */ v) {
		return this.call('set_verbose', v)
	}

	set_index_params(/** @type {{max_index_size?:number, max_avg_line_length?:number}} */ params) {
		return this.call('set_index_params', params)
	}

	clear_index() {
		this._file_paths_cache = null
		return this.call('clear_index')
	}

	dispose() {
		return this.worker.terminate()
	}
}

module.exports.IndexerClient = IndexerClient
