let path = require('path')
const { mkdirSync, existsSync, rmSync } = require('fs')
const { log_debug, log_error } = require('./log')
const { Database } = require('node-sqlite3-wasm')

/**
 * @typedef {object} FileMeta
 * @property {string} path
 * @property {number} mtime
 * @property {number} size
 */

/**
 * @typedef {object} IndexDoc
 * @property {string} path
 * @property {string} text
 * @property {number} mtime
 */

/**
 * @typedef {object} IndexDocStored
 * @property {string} path
 * @property {number} mtime
 */

/** wrapper around fergiemcdowall/search-index */
module.exports.Indexer = class {
	constructor(/** @type {{storage_uri:import('vscode').Uri, word_split_regex:RegExp}} */ { storage_uri, word_split_regex }) {
		let index_path = path.join(storage_uri.fsPath, 'index')
		if (! existsSync(index_path))
			mkdirSync(index_path, { recursive: true })
		log_debug('search index: ' + index_path)

		let db_path = path.join(index_path, 'index.db')
		this.db = new Database(db_path)

		try {
			this.init_db()
		} catch (e) {
			if (e.message === 'database is locked')
				if (existsSync(db_path + '.lock')) {
					log_error('Unexpected error: Database is locked. Maybe the extension crashed last time? Deleting the lock and trying again.')
					rmSync(db_path + '.lock', { recursive: true })
					this.init_db()
				} else
					throw 'Unexpected error: Database is locked, but no lock file was found. Cannot continue.'
			else
				throw e
		}

		this.token_split_regex = word_split_regex
	}

	init_db() {
		// fts: see docs @ sqlite.org/fts5.html
		// not using external content table because we don't want to store the huge text fields.
		// not using built-in cross-table rowid references because bulk inserting them doesn't seem possible easily (?)
		// pure content-less table also doesn't suffice because we need the paths, so they are now referred to from a separate table.
		// inserts into fts table can't be trigger-based because the `text` field isn't available for files inserts.
		this.db.exec(`
			pragma journal_mode = wal;
			pragma foreign_keys = on;
			create table if not exists files(path text primary key, mtime number);
			create virtual table if not exists search_index_fts using FTS5(text, content='', contentless_delete=1);
			create virtual table if not exists search_index_fts_v using fts5vocab('search_index_fts', 'col');
		`)
	}

	async index_docs(/** @type {IndexDoc[]} */ docs) {
		let paths = docs.map(d => d.path)
		this.db.exec('begin transaction')
		// all at the same time is about 40% faster than docs.length individual `.run()`s, that's why all these weird prp stmts are built up like this
		let single_qmarks = new Array(docs.length).fill('?').join(', ')
		let double_qmarks = new Array(docs.length).fill('(?, ?)').join(', ')
		await this.delete_doc_by_path(...paths)
		this.db.run(`insert into files (path, mtime) values ${double_qmarks}`, docs.map(d => [d.path, d.mtime]).flat())
		let new_ids = this.db.all(`select rowid, path from files where path in (${single_qmarks})`, paths)
		let new_id_by_path = new_ids.reduce((all, { rowid, path }) => { all[path] = rowid; return all }, {})
		this.db.run(`insert into search_index_fts (rowid, text) values ${double_qmarks}`, docs.map((doc, i) => [new_id_by_path[doc.path], doc.text]).flat())
		// TODO: insert into fts(fts) values ('optimize')
		// other optimize..?
		this.db.exec('commit')
	}

	// TODO: pass arr instead?
	async delete_doc_by_path(/** @type {string[]} */ ...paths) {
		let single_qmarks = new Array(paths.length).fill('?').join(', ')
		let old_ids = this.db.all(`select rowid from files where path in (${single_qmarks})`, paths).map(r => r.rowid)
		this.db.run(`delete from files where path in (${single_qmarks})`, paths)
		this.db.run('delete from search_index_fts where rowid in (' +
			new Array(old_ids.length).fill('?').join(', ') + ')', old_ids)
	}

	/** not returning text contents here */
	// TODO: rename to path_meta everywhere
	async all_meta_docs() {
		let rows = this.db.all('select path, mtime from files')
		for (let row of rows)
			row.mtime = Number(row.mtime)
		return /** @type {IndexDoc[]} */ (rows) // eslint-disable-line no-extra-parens
	}

	// TODO: rm all asyncs/awaits for these
	async autocomplete_word(/** @type string */ word, /** @type number */ limit) {
		return this.db.all('select term from search_index_fts_v where term glob ? order by cnt desc limit ?',
			[word.toLowerCase() + '*', limit]) // TODO casing etc
			.map(d => d.term)
	}

	async find_paths_by_multiple_partial_words(/** @type {string[]} */ words) {
		log_debug('searching for', words)
		let start = Date.now()
		log_debug(`search time: ${(Date.now() - start) / 1000} seconds`)
		// TODO: snippet()
		let paths = this.db.all('select path from files where rowid in (select rowid from search_index_fts where text match ?)', words.join(' '))
		return /** @type {string[]} */ (paths.map(w => w.path)) // eslint-disable-line no-extra-parens
	}
}
