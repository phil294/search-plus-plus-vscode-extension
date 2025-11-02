let path = require('path')
const { mkdirSync, existsSync, rmSync, readFileSync } = require('fs')
const { log_debug, log_error, log_warn } = require('./log')
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

/** wrapper around sqlite3 fts wasm */
module.exports.Indexer = class {
	constructor(/** @type {{storage_uri:import('vscode').Uri, word_split_regex:RegExp}} */ { storage_uri, word_split_regex }) {
		this.word_split_regex = word_split_regex
		let index_path = path.join(storage_uri.fsPath, 'index')
		if (! existsSync(index_path))
			mkdirSync(index_path, { recursive: true })
		log_debug('search index: ' + index_path)

		let db_path = path.join(index_path, 'index2.db') // version bump after scheme change
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
		try {
			this.db.all('select path, mtime from file limit 1')
		} catch (e) {
			if (e.message.includes('database disk image is malformed')) {
				log_warn(e.message + '. Recreating database......')
				rmSync(db_path, { recursive: true })
				rmSync(db_path + '-journal', { recursive: true })
				this.init_db()
			} else
				throw e
		}
	}

	init_db() {
		// TODO: / search fts
		// fts: see docs @ sqlite.org/fts5.html
		// not using external content table because we don't want to store the huge text fields.
		// not using built-in cross-table rowid references because bulk inserting them doesn't seem possible easily (?)
		// pure content-less table also doesn't suffice because we need the paths, so they are now referred to from a separate table.
		// inserts into fts table can't be trigger-based because the `text` field isn't available for files inserts.
		/*
		autocomplete needs a search backend that keeps reference to all stored words full (aka NO trigram)
		for case-insensitive lookup
		and also needs the results case sensitive, for which you need an extra table because sqlite fts5 can't do both.
		go-to needs full words also.
		like prefix% is too slow on large data, even with index. fts is necessary for this.
		fts is also necessary for partial matches, trigram tokenizer for search function.
		*/
		this.db.exec(`
			pragma journal_mode = wal;
			pragma foreign_keys = on;
			create table if not exists file(id integer primary key autoincrement, path text unique, mtime number);
			create table if not exists file_content(file_id integer references file(id) on delete cascade on update restrict, word text, word_lower text, primary key (file_id, word)) without rowid;
			create index if not exists idx_file_content_word on file_content(word);
			create index if not exists idx_file_content_word_lower on file_content(word_lower);
			create virtual table if not exists file_content_search_index_fts using FTS5(text, content='', contentless_delete=1);
			create virtual table if not exists file_content_search_index_fts_v using fts5vocab('file_content_search_index_fts', 'col');
			create virtual table if not exists file_content_search_index_fts_trigram using FTS5(text, content='', tokenize='trigram', contentless_delete=1);
		`)
	}

	index_docs(/** @type {IndexDoc[]} */ docs) {
		let paths = docs.map(d => d.path)
		this.db.exec('begin transaction')
		// all at the same time is about 40% faster than docs.length individual `.run()`s, that's why all these weird prp stmts are built up like this
		let single_qmarks_paths = new Array(docs.length).fill('?').join(',')
		let double_qmarks_paths = new Array(docs.length).fill('(?,?)').join(',')
		this.delete_doc_by_path(...paths)
		this.db.run(`insert into file (path, mtime) values ${double_qmarks_paths}`, docs.map(d => [d.path, d.mtime]).flat())
		let new_ids = this.db.all(`select id, path from file where path in (${single_qmarks_paths})`, paths)
		let new_id_by_path = new_ids.reduce((/** @type {Record<string, string>} */ all, { id, path }) => { all[String(path)] = String(id); return all }, {})
		// This makes the text be split by FTS internally
		this.db.run(`insert into file_content_search_index_fts (rowid, text) values ${double_qmarks_paths}`, docs.map(doc => [new_id_by_path[doc.path] || '??', doc.text]).flat())
		// this also, but trigram
		this.db.run(`insert into file_content_search_index_fts_trigram (rowid, text) values ${double_qmarks_paths}`, docs.map(doc => [new_id_by_path[doc.path] || '??', doc.text]).flat())
		// And this requires manual splitting. We need both due to
		// case presevation, unfortunately.
		let docs_with_words = docs.map(doc => ({
			path: doc.path,
			words: [...new Set((doc.text.match(this.word_split_regex) || [])
				.filter(w => w.length >= 3))], // TODO: config
		}))
		// let total_words = docs_with_words.reduce((sum, doc) => sum + doc.words.length, 0)
		// let double_qmarks_words = new Array(total_words).fill('(?,?)').join(',')
		// this.db.run(`insert or ignore into file_content (file_id, word) values ${double_qmarks_words}`,
		let path_words = docs_with_words.map(doc => doc.words.map(word => [new_id_by_path[doc.path] || '??', word, word.toLowerCase()])).flat(2)
		const file_content_insert_words_chunk_size = 3 * 30 // TODO: configure / find fastest. too large and ui lags a lot
		log_debug(`Inserting total ${path_words.length} words = ${Math.ceil(path_words.length / file_content_insert_words_chunk_size)} chunks into file_content`)
		for (let i = 0; i < path_words.length; i += file_content_insert_words_chunk_size) {
			let words_chunk = path_words.slice(i, i + file_content_insert_words_chunk_size)
			let triple_qmarks_words = new Array(words_chunk.length / 3).fill('(?,?,?)').join(',')
			this.db.run(`insert or ignore into file_content (file_id, word, word_lower) values ${triple_qmarks_words}`, words_chunk)
		}
		// TODO: insert into fts(fts) values ('optimize')
		// other optimize..?
		this.db.exec('commit')
	}

	async delete_doc_by_path(/** @type {string[]} */ ...paths) {
		let single_qmarks = new Array(paths.length).fill('?').join(',')
		let old_ids = this.db.all(`select id from file where path in (${single_qmarks})`, paths).map(r => String(r.id))
		this.db.run(`delete from file where path in (${single_qmarks})`, paths)
		this.db.run('delete from file_content_search_index_fts where rowid in (' +
			new Array(old_ids.length).fill('?').join(',') + ')', old_ids)
		this.db.run('delete from file_content_search_index_fts_trigram where rowid in (' +
			new Array(old_ids.length).fill('?').join(',') + ')', old_ids)
	}

	/** not returning text contents here */
	// TODO: rename to path_meta everywhere
	all_meta_docs() {
		let rows = this.db.all('select path, mtime from file')
		for (let row of rows)
			row.mtime = Number(row.mtime)
		// TODO: indexdoc has a .text prop ...?
		return /** @type {IndexDoc[]} */ (rows) // eslint-disable-line no-extra-parens
	}

	autocomplete_word(/** @type string */ word, /** @type number */ limit) {
		log_debug('autocompleting', word, 'with limit', limit)
		let start = Date.now()
		// TODO: escape
		// this is 100-500ms slow even though the index is there
		// let words = this.db.all('select distinct word from file_content where word like ? collate nocase limit ?', [word + '%', limit])
		// this doesn't work becaues the words aren't stored, only the entire text if not contentless which is not helpful
		// let words = this.db.all('select word from file_content_search_index_fts_trigram fts left join file_content on fts.text = file_content.word_lower and fts.rowid = file_content.file_id where text match ? limit ?', [word + '*', limit])
		// let words = this.db.all('select word from file_content_search_index_fts_trigram_v fts_v left join file_content on fts_v.term = file_content.word_lower and fts_v.rowid = file_content.file_id where term glob ? order by cnt desc limit ?',
		// and this doesn't work because of trigram tokenizer, `term` is just three-letter words.
		// let words = this.db.all('select term from file_content_search_index_fts_trigram_v fts_v where term glob ? order by cnt desc limit ?',
		let words = this.db.all('select distinct file_content.word from file_content_search_index_fts_v fts_v left join file_content on fts_v.term = file_content.word_lower where fts_v.term glob ? order by fts_v.cnt desc limit ?',
		// let words = this.db.all('select term from file_content_search_index_fts_v fts_v where term glob ? order by cnt desc limit ?',
			[word.toLowerCase() + '*', limit])
			// .map(r => r.term)
			.map(r => r.word)
		log_debug(`autocomplete search time: ${(Date.now() - start) / 1000} seconds`)
		return words
	}

	find_paths_by_word(/** @type string */ word, /** @type number */ limit) {
		let start = Date.now()
		log_debug('find paths by word', word)
		let paths = this.db.all('select path from file_content left join file on file.id = file_content.file_id where word = ? limit ?', [word, limit])
			.map(r => r.path)
		log_debug(`find paths search time: ${(Date.now() - start) / 1000} seconds`)
		return paths.map(p => String(p))
	}

	find_paths_with_lines_by_word(/** @type {string} */ word, /** @type {boolean} */ is_partial_trigram_query, /** @type {number} */ limit) {
		log_debug('find paths with lines by word starts for', word, 'is_partial_trigram_query:', is_partial_trigram_query)
		let start = Date.now()
		// TODO: escape, also below
		let paths
		let words = [word]
		if (is_partial_trigram_query) {
			paths = this.db.all('select path from file inner join file_content_search_index_fts_trigram fts on file.id = fts.rowid where fts.text match ? order by rank limit ?', [word, limit])
				.map(r => String(r.path))
			// TODO: ?? regex
			words = word.split(/\s+/).map(w => w.toLowerCase())
		} else
			paths = this.find_paths_by_word(word, limit)

		let words_lower = words.map(w => w.toLowerCase())

		let results = []
		let total_matches = 0

		for (let file_path of paths)
			try {
				let content = readFileSync(file_path, 'utf-8')
				let lines = content.split('\n')
				let matches = []

				for (let i = 0; i < lines.length; i++) {
					let line = lines[i]
					if (! line)
						continue
					let line_lower = line.toLowerCase()

					// Check if all words are in this line
					if (words_lower.every(word => line_lower.includes(word))) {
						matches.push({
							line_number: i + 1,
							line_text: line.slice(0, 100),
						})
						total_matches++
						if (total_matches >= limit)
							break
					}
				}

				if (matches.length > 0)
					results.push({
						path: String(file_path),
						matches,
					})
				if (total_matches >= limit)
					break
			} catch (err) {
				log_error('Error reading file for matches:', file_path, err.message)
			}

		log_debug(`find matches with lines time: ${(Date.now() - start) / 1000} seconds, ${results.length} files with matches, ${total_matches} total matches`)
		return { results, has_more: total_matches >= limit }
	}
}
