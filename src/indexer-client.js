const { Worker } = require('worker_threads')
const { existsSync } = require('fs')
const { host_write, log_debug } = require('./log')

// Methods with no side effects: once the parallel read-only reader worker is up these are routed to it,
// so they run concurrently with a long index write on the writer instead of queuing behind it.
const READ_METHODS = new Set(['all_meta_docs', 'all_file_paths', 'autocomplete_word', 'find_paths_by_word', 'find_paths_fuzzy', 'search_lines', 'search_lines_regex', 'find_definition_lines'])

/** @typedef {{worker:import('worker_threads').Worker, pending:Map<number,{resolve:(v:any)=>void, reject:(e:any)=>void}>}} RpcWorker */

/** Extension-host side proxy around the indexing worker threads (a read-write 'writer' and a read-only
 * 'reader'). Writes + control go to the writer, reads to the reader when it's up. Also forwards the
 * workers' log and progress messages to the host. */
class IndexerClient {
	constructor(/** @type import('vscode').ExtensionContext */ context, /** @type {{storage_path:string, verbose:boolean, on_progress:(n:number|null)=>any, index_params?:{max_index_size?:number, max_avg_line_length?:number}}} */ { storage_path, verbose, on_progress, index_params }) {
		this.on_progress = on_progress
		this._id = 0
		/** @type {{path:string, mtime:number}[]|null} */
		this._file_paths_cache = null
		// In development the sources ship as-is (src/worker.js). In a packaged build, src/ is
		// stripped and the worker is bundled to the extension root as worker.js (see release.sh).
		let worker_path = context.asAbsolutePath('src/worker.js')
		if (! existsSync(worker_path))
			worker_path = context.asAbsolutePath('worker.js')
		this._worker_path = worker_path
		this._worker_data = { storage_path, verbose, index_params }
		// The writer owns all mutations + its read-write connection. The read-only reader is spawned once
		// the writer reports ready (db + schema exist); until then (and if it dies) reads fall back to the
		// writer, so behaviour is never worse than the single-worker setup.
		this._writer = this._spawn('writer')
		/** @type {RpcWorker|null} */
		this._reader = null
		this._reader_ready = false
	}

	/** @param {'writer'|'reader'} role @returns {RpcWorker} */
	_spawn(role) {
		let worker = new Worker(this._worker_path, { workerData: { ...this._worker_data, role } })
		/** @type {RpcWorker} */
		let wrapper = { worker, pending: new Map() }
		worker.on('message', (/** @type any */ msg) => this._on_message(msg, wrapper, role))
		worker.on('error', (/** @type any */ err) => host_write('error', [`Indexing ${role} worker error`, String(err?.stack || err)]))
		worker.on('exit', (/** @type number */ code) => {
			if (role === 'reader') { // reads fall back to the writer; don't auto-respawn
				this._reader = null
				this._reader_ready = false
			}
			if (code !== 0)
				host_write('error', [`Indexing ${role} worker stopped unexpectedly (exit code ${code})`])
		})
		return wrapper
	}

	_on_message(/** @type any */ msg, /** @type RpcWorker */ wrapper, /** @type {'writer'|'reader'} */ role) {
		if (! msg)
			return
		if (msg.type === 'rpc-reply') {
			let pending = wrapper.pending.get(msg.id)
			if (! pending)
				return
			wrapper.pending.delete(msg.id)
			if (msg.error)
				pending.reject(new Error(msg.error))
			else
				pending.resolve(msg.result)
		} else if (msg.type === 'ready') {
			if (role === 'writer' && ! this._reader)
				this._reader = this._spawn('reader') // writer's db + schema exist; bring up the parallel reader
			else if (role === 'reader')
				this._reader_ready = true
		} else if (msg.type === 'progress')
			this.on_progress?.(msg.value)
		else if (msg.type === 'log')
			host_write(msg.level, msg.args)
	}

	/** @param {RpcWorker} target */
	_call_on(target, /** @type string */ method, /** @type any[] */ args) {
		let id = ++this._id
		let start = Date.now()
		return new Promise((resolve, reject) => {
			target.pending.set(id, {
				resolve: (/** @type any */ v) => { log_debug(`rpc ${method} took ${Date.now() - start}ms`); resolve(v) },
				reject: (/** @type any */ e) => { log_debug(`rpc ${method} failed after ${Date.now() - start}ms`); reject(e) },
			})
			target.worker.postMessage({ type: 'rpc', id, method, args })
		})
	}

	call(/** @type string */ method, /** @type any[] */ ...args) {
		let target = READ_METHODS.has(method) && this._reader && this._reader_ready ? this._reader : this._writer
		return this._call_on(target, method, args)
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

	/** Substring search over the line index: matching lines with file path, line number and preview,
	 * resolved entirely from the DB (no file reads). */
	search_lines(/** @type string */ word, /** @type number */ limit, /** @type {{include?:string[], exclude?:string[], roots?:string[], case_sensitive?:boolean}} */ filter = {}) {
		return /** @type {Promise<{results:{path:string, matches:{line_number:number, line_text:string}[]}[], has_more:boolean}>} */ (this.call('search_lines', word, limit, filter)) // eslint-disable-line no-extra-parens
	}

	/** Regex substring search: the pattern's mandatory literals drive an FTS prefilter, then each
	 * candidate line is re-tested against the real RegExp. Requires at least one literal. */
	search_lines_regex(/** @type string */ pattern, /** @type boolean */ case_sensitive, /** @type string[] */ literals, /** @type number */ limit, /** @type {{include?:string[], exclude?:string[], roots?:string[]}} */ filter = {}) {
		return /** @type {Promise<{results:{path:string, matches:{line_number:number, line_text:string}[]}[], has_more:boolean}>} */ (this.call('search_lines_regex', pattern, case_sensitive, literals, limit, filter)) // eslint-disable-line no-extra-parens
	}

	find_definition_lines(/** @type string */ word, /** @type number */ limit) {
		return /** @type {Promise<{results:{path:string, matches:{line_number:number, line_text:string}[]}[], has_more:boolean}>} */ (this.call('find_definition_lines', word, limit)) // eslint-disable-line no-extra-parens
	}

	set_verbose(/** @type boolean */ v) {
		this._worker_data.verbose = v // so a later-spawned reader starts with the right verbosity
		let calls = [this._call_on(this._writer, 'set_verbose', [v])]
		if (this._reader)
			calls.push(this._call_on(this._reader, 'set_verbose', [v]))
		return Promise.all(calls)
	}

	set_index_params(/** @type {{max_index_size?:number, max_avg_line_length?:number}} */ params) {
		return this.call('set_index_params', params)
	}

	/** Abort the worker's in-flight (re)index at the next sub-batch boundary. Bypasses the write chain so
	 * it lands immediately; committed work persists and the next sync re-diffs what's left. */
	cancel_indexing() {
		return this.call('cancel_indexing')
	}

	clear_index() {
		this._file_paths_cache = null
		return this.call('clear_index')
	}

	dispose() {
		let ps = [this._writer.worker.terminate()]
		if (this._reader)
			ps.push(this._reader.worker.terminate())
		return Promise.all(ps)
	}
}

module.exports.IndexerClient = IndexerClient
