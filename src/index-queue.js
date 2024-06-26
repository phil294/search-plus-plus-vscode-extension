let vscode = require('vscode')
const { log_debug, log_error } = require('./log')
const { readFile } = require('fs/promises')
const { isBinary } = require('istextorbinary/edition-es2022/index.js')

/** @typedef {import('./indexer').Indexer} Indexer */
/** @typedef {import('./indexer').IndexDoc} IndexDoc */
/** @typedef {import('./indexer').FileMeta} FileMeta */

/** @augments {Map<string, FileMeta>} */
class IndexQueue extends Map {
	constructor(/** @type Indexer */ indexer) {
		super()
		this.indexer = indexer
		this.is_running = false
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
		log_debug('run index queue with ' + size + ' entries...')
		let start = Date.now()

		/** @type {IndexDoc[]} */
		let docs_batch = [] // TODO no implcit any
		// TODO: configurable
		const docs_batch_bytes_threshold = 5 * 1024 * 1024 // s2 tests with SI: 1 KB 93 sec, 1 MB 43 sec, 5 MB 30 sec, 10 MB 30 sec. similar with node-sqlite3-wasm except 3x faster
		let docs_batch_bytes_read = 0
		let flush_docs_batch = async () => {
			log_debug(`batch-index ${docs_batch.length} docs`)
			if (! docs_batch.length)
				return
			try {
				await this.indexer.index_docs(docs_batch)
			} catch (e) {
				// shouldn't throw because then is_running won't be unset, and errors, if any, are most likely to occur here
				log_error('Indexing docs failed unexpectedly: ' + JSON.stringify(e))
			}
			docs_batch_bytes_read = 0
			docs_batch = []
		}
		let uri_i = -1
		let skipped_path_EACCESS = ''
		// TODO: configurable
		const read_group_size = 20 // 100 7sec, 20 8sec, 10 9sec, 1 12sec. 20 without logging 6sec. Mustn't be too big because reading and many files at the same time and keeping them in ram can be heavy on system resources
		let entries = [...this.entries()]
		for (let i = 0; i < entries.length; i += read_group_size) {
			let read_group = entries.slice(i, i + read_group_size) // calling it "group" to distinguish from index-flush "batch"
			await Promise.all(read_group.map(async ([path, file_meta]) => {
				this.delete(path)
				uri_i++
				log_debug(`indexing (${uri_i + 1}/${size}) ${path}`)
				if (uri_i % 100 === 0)
					on_progress(uri_i / size)
				let file_buf
				try {
					file_buf = await readFile(vscode.Uri.file(file_meta.path).fsPath)
				} catch (e) {
					if (e.code === 'EISDIR') // TODO: why do some dirs appear here? via file changer it seems
						console.warn(file_meta.path, e)
					else if (e.code === 'EACCES')
						skipped_path_EACCESS = file_meta.path
					else
						// TODO check logs size and when expiring
						log_error(`Indexing: Unexpected error: Failed to read file '${path}': ${JSON.stringify(e)}`)
					return
				}
				if (await isBinary(null, file_buf)) { // check buffer contents
					log_debug('skipping: is binary (buf)')
					// We still write the file into the index as empty so to prevent unnecessary
					// re-scanning at next invocation
					file_buf = ''
				}
				docs_batch.push({ path: file_meta.path, mtime: file_meta.mtime, text: file_buf.toString() })
				docs_batch_bytes_read += file_buf.length
			}))
			if (docs_batch_bytes_read > docs_batch_bytes_threshold)
				await flush_docs_batch()
		}
		await flush_docs_batch()
		if (skipped_path_EACCESS)
			log_error(`Warning: File '${skipped_path_EACCESS}' could not be read due to permission problems.`)

		log_debug('run index queue complete')
		log_debug(`indexing took ${(Date.now() - start) / 1000} seconds`)
		console.log(`search++: indexing took ${(Date.now() - start) / 1000} seconds`)
		on_progress(null)
		this.is_running = false
	}

	async is_indexable(/** @type FileMeta */ doc) {
		return ! await isBinary(doc.path, undefined) // checks only file extension
			&& doc.size > 0
			&& doc.size < 20 * 1024 * 1024 // TODO configure. A large value here isn't really dangerous (apart from increasing index size and initial indexing time), but the product of this and read_group_size x4 will be the amount of RAM (in MB) that's needed while indexing, so be careful setting both too high.
	}
}

module.exports.IndexQueue = IndexQueue
