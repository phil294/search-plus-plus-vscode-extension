let path = require('path')
let search_index = require('search-index')
let { ClassicLevel } = require('classic-level')
const { mkdirSync, existsSync } = require('fs')
const { log_debug } = require('./log')

/**
 * @typedef {object} FileMeta
 * @property {string} path
 * @property {number} mtime
 * @property {number} size
 */

/**
 * @typedef {object} IndexDoc
 * @property {string} _id This is the file path
 * @property {string} text
 * @property {number} mtime
 */

/**
 * @typedef {object} IndexDocStored
 * @property {string} _id This is the file path
 * @property {number} mtime
 */

/** wrapper around fergiemcdowall/search-index */
module.exports.Indexer = class {
	constructor(/** @type {{storage_uri:import('vscode').Uri, word_split_regex:RegExp}} */ { storage_uri, word_split_regex }) {
		// TODO change to just 'index'
		let index_path = path.join(storage_uri.fsPath, 'index-db')
		if (! existsSync(index_path))
			mkdirSync(index_path, { recursive: true })
		log_debug('search index: ' + index_path)
		this.idx = search_index({
			// Not persisting (using default memdown db) isn't noticeably faster
			db: /** @type {import('abstract-leveldown').AbstractLevelDOWNConstructor} */(/** @type unknown */
				(new ClassicLevel(index_path, { valueEncoding: 'json' }))), // eslint-disable-line no-extra-parens
			name: 'search++-index',
		})

		this.token_split_regex = word_split_regex
	}

	async index_docs(/** @type {IndexDoc[]} */ docs) {
		// Index only _id+text
		await (await this.idx).PUT(docs
			.map(({ _id, text }) => ({ _id, text })), {
			storeRawDocs: false,
			tokenSplitRegex: this.token_split_regex,
			// caseSensitive: true,
		})
		// ...but store only _id+mtime
		await (await this.idx).PUT_RAW(docs
			// @ts-ignore wrong types (search-index#620)
			.map(({ _id, mtime }) => ({ _id, mtime })), docs.map(d => d._id), false)
	}

	async delete_doc_by_path(/** @type {string[]} */ ...paths) {
		await (await this.idx).DELETE(...paths)
	}

	/** text field from IndexDocs isn't stored, so for retrieving, only _id+mtime is available (as designed) */
	async all_meta_docs() {
		return /** @type {IndexDocStored[]} */ ((await (await this.idx) // eslint-disable-line no-extra-parens
			.ALL_DOCUMENTS()).map(doc => doc._doc))
	}

	async autocomplete_word(/** @type string */ word) {
		return await (await this.idx).DICTIONARY({
			FIELD: 'text', VALUE: word.toLowerCase(),
		})
	}

	async find_paths_by_multiple_partial_words(/** @type {string[]} */ words) {
		log_debug('searching for', words)
		let start = Date.now()
		// TODO: query first for non-dict results, then add where not already present
		// It appears search-index offers no single "find where starts with" operation, and also no
		// "match by sentence", but we can split this into two operations (disregarding word order):
		// TODO: how to limit the first??? only via min length?
		let dicts = await Promise.all(words.map(word =>
			this.autocomplete_word(word)))
		let paths = (await (await this.idx).QUERY({
			AND: dicts.map(dict => ({
				OR: dict
					.map(d => ({ FIELD: 'text', VALUE: d })),
			})),
		}, {
			// return mtime too
			// DOCUMENTS: true,
			// PAGE: {} // TODO
		})).RESULT.map(d => d._id)
		log_debug(`search time: ${(Date.now() - start) / 1000} seconds`)
		return paths
	}
}
