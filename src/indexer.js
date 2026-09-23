let path = require('path')
const { mkdirSync, existsSync, rmSync, readFileSync } = require('fs')
const micromatch = require('micromatch')
const { log_debug, log_info, log_error, log_warn } = require('./log')
const { word_split_regex } = require('./global')
const BetterSqlite3 = require('better-sqlite3')

// A single index_docs() call blocks the worker thread synchronously (better-sqlite3 is sync).
// Batches slower than this get a phase breakdown logged (at info level) so pathological files/phases
// are visible without flooding the log on healthy batches.
const index_docs_slow_ms = 1500

// Thin adapter giving better-sqlite3 the call surface the code used with node-sqlite3-wasm:
// exec(sql), run(sql, params?), all(sql, params?), and prepare(sql) -> { run(values), finalize() }.
class Db {
	/** @param {string} db_path */
	constructor(db_path) {
		this._db = new BetterSqlite3(db_path)
	}

	/** @param {string} sql */
	exec(sql) {
		this._db.exec(sql)
	}

	/**
	 * @param {string} sql
	 * @param {any[]} [params]
	 */
	run(sql, params) {
		return params === undefined ? this._db.prepare(sql).run() : this._db.prepare(sql).run(params)
	}

	/**
	 * @param {string} sql
	 * @param {any[]} [params]
	 * @returns {any[]}
	 */
	all(sql, params) {
		return params === undefined ? this._db.prepare(sql).all() : this._db.prepare(sql).all(params)
	}

	/**
	 * @param {string} sql
	 * @param {any[]} [params]
	 * @returns {any}
	 */
	get(sql, params) {
		return params === undefined ? this._db.prepare(sql).get() : this._db.prepare(sql).get(params)
	}

	/** @param {string} sql */
	prepare(sql) {
		let stmt = this._db.prepare(sql)
		// finalize() is a no-op: better-sqlite3 manages statement lifetimes itself; kept for call-site parity.
		return { run: (/** @type {any[]} */ values) => stmt.run(values), finalize: () => {} }
	}

	close() {
		this._db.close()
	}
}

/**
 * @typedef {object} FileMeta
 * @property {string} path
 * @property {number} mtime
 * @property {number} size
 * @property {boolean} [index_content] `false` records the file name-only (gitignored files, shown in the picker but not content-indexed). Defaults to indexed.
 */

/**
 * @typedef {object} IndexDoc
 * @property {string} path
 * @property {string|null} text `null` means the file is recorded but its contents are not indexed (binary/oversized).
 * @property {number} mtime
 */

/**
 * @typedef {object} IndexDocStored
 * @property {string} path
 * @property {number} mtime
 */

/** wrapper around sqlite3 fts (better-sqlite3). Owned by the indexing worker thread (single db connection). */
module.exports.Indexer = class {
	constructor(/** @type {{storage_path:string, rows_per_chunk?:number, min_word_length?:number, extra_pragmas?:string}} */ { storage_path, rows_per_chunk = 500, min_word_length = 3, extra_pragmas = '' }) {
		this.word_split_regex = word_split_regex
		this.rows_per_chunk = rows_per_chunk
		this.min_word_length = min_word_length
		this.extra_pragmas = extra_pragmas
		let index_path = path.join(storage_path, 'index')
		if (! existsSync(index_path))
			mkdirSync(index_path, { recursive: true })
		log_debug('search index: ' + index_path)

		let db_path = path.join(index_path, 'index4.db') // version bump after scheme change
		this.db = new Db(db_path)

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
		fts trigram necessary for partial matches (search).
		*/
		this.db.exec(`
			pragma page_size = 8192;
			pragma journal_mode = wal;
			pragma foreign_keys = on;
			pragma synchronous = normal;
			pragma temp_store = memory;
			pragma cache_size = -131072;
			pragma mmap_size = 536870912;
			${this.extra_pragmas}
			create table if not exists file(id integer primary key autoincrement, path text unique, mtime number);
			create table if not exists file_content(file_id integer references file(id) on delete cascade on update restrict, word text, word_lower text, primary key (file_id, word)) without rowid;
			create index if not exists idx_file_content_word on file_content(word);
			create index if not exists idx_file_content_word_lower on file_content(word_lower);
			create virtual table if not exists file_content_search_index_fts_trigram using FTS5(text, content='', tokenize='trigram', contentless_delete=1);
		`)
	}

	/** Drop the file_content word lookup indexes so a large bulk (re)index only maintains the primary
	 * key. Recreate with create_word_indexes() once done; building an index in one sorted pass is far
	 * cheaper than maintaining it across millions of random per-row inserts. Full-scan use only. */
	drop_word_indexes() {
		this.db.exec('drop index if exists idx_file_content_word; drop index if exists idx_file_content_word_lower;')
	}

	create_word_indexes() {
		this.db.exec('create index if not exists idx_file_content_word on file_content(word); create index if not exists idx_file_content_word_lower on file_content(word_lower);')
	}

	/** Folds the WAL back into the main db file. Passive auto-checkpointing alone can lag far behind
	 * during a large (re)index, leaving index4.db-wal at hundreds of MB until VS Code restarts; call
	 * this once a batch of writes is done (not per-write, since TRUNCATE blocks concurrent readers). */
	checkpoint() {
		let t = Date.now()
		let result = this.db.get('pragma wal_checkpoint(TRUNCATE)')
		log_debug(`wal_checkpoint(TRUNCATE) ${Date.now() - t}ms`, result)
	}

	index_docs(/** @type {IndexDoc[]} */ docs) {
		let t_start = Date.now()
		let paths = docs.map(d => d.path)
		this.db.exec('begin transaction')
		// all at the same time is about 40% faster than docs.length individual `.run()`s, that's why all these weird prp stmts are built up like this
		let single_qmarks_paths = new Array(docs.length).fill('?').join(',')
		let double_qmarks_paths = new Array(docs.length).fill('(?,?)').join(',')
		this.delete_doc_by_path(...paths)
		let t_delete = Date.now()
		this.db.run(`insert into file (path, mtime) values ${double_qmarks_paths}`, docs.map(d => [d.path, d.mtime]).flat())
		let new_ids = this.db.all(`select id, path from file where path in (${single_qmarks_paths})`, paths)
		let new_id_by_path = new_ids.reduce((/** @type {Record<string, number>} */ all, { id, path }) => { all[String(path)] = Number(id); return all }, {})
		let t_file = Date.now()
		// Only docs with actual text content get their contents indexed. Binary/oversized files
		// (text === null) are still recorded above as file rows only, so the file picker can link
		// to them and so they are not rescanned every time.
		let content_docs = docs.filter(doc => doc.text != null)
		let text_chars = 0
		let word_count = 0
		let t_fts = t_file
		let t_words = t_file
		if (content_docs.length) {
			for (let doc of content_docs)
				text_chars += String(doc.text).length
			let double_qmarks_content = new Array(content_docs.length).fill('(?,?)').join(',')
			// This makes the text be split by FTS internally
			this.db.run(`insert into file_content_search_index_fts_trigram (rowid, text) values ${double_qmarks_content}`, content_docs.map(doc => [new_id_by_path[doc.path], doc.text]).flat())
			t_fts = Date.now()
			// And this requires manual splitting. We need both due to
			// case presevation, unfortunately.
			let docs_with_words = content_docs.map(doc => ({
				path: doc.path,
				words: [...new Set((String(doc.text).match(this.word_split_regex) || [])
					.filter(w => w.length >= this.min_word_length))],
			}))
			// let total_words = docs_with_words.reduce((sum, doc) => sum + doc.words.length, 0)
			// let double_qmarks_words = new Array(total_words).fill('(?,?)').join(',')
			// this.db.run(`insert or ignore into file_content (file_id, word) values ${double_qmarks_words}`,
			// we need to store both as sqlite's case insensitivity is purely ascii-based unless you install icu
			// which is not included in the bundled sqlite build
			let rows = docs_with_words.flatMap(doc => doc.words.map(word => [new_id_by_path[doc.path], word, word.toLowerCase()]))
			word_count = rows.length
			// Reusing ONE prepared multi-row insert is dramatically faster than re-preparing a fresh
			// statement per chunk: statement preparation (not the actual b-tree insert) dominated indexing
			// time on word-heavy files (e.g. a single .po batch stalled minutes). 500 rows stays well below
			// SQLite's bound-parameter limit while minimising per-statement preparation overhead.
			const rows_per_chunk = this.rows_per_chunk
			log_debug(`Inserting total ${rows.length} words = ${Math.ceil(rows.length / rows_per_chunk)} chunks into file_content`)
			let full_chunks = Math.floor(rows.length / rows_per_chunk)
			if (full_chunks) {
				let stmt = this.db.prepare(`insert or ignore into file_content (file_id, word, word_lower) values ${new Array(rows_per_chunk).fill('(?,?,?)').join(',')}`)
				for (let i = 0; i < full_chunks; i++)
					stmt.run(rows.slice(i * rows_per_chunk, (i + 1) * rows_per_chunk).flat())
				stmt.finalize()
			}
			let remainder = rows.slice(full_chunks * rows_per_chunk)
			if (remainder.length)
				this.db.run(`insert or ignore into file_content (file_id, word, word_lower) values ${new Array(remainder.length).fill('(?,?,?)').join(',')}`, remainder.flat())
			t_words = Date.now()
		}
		// TODO: insert into fts(fts) values ('optimize')
		// other optimize..?
		this.db.exec('commit')
		let t_commit = Date.now()
		if (t_commit - t_start > index_docs_slow_ms) {
			let biggest_path = ''
			let biggest_chars = 0
			for (let doc of content_docs)
				if (doc.text != null && String(doc.text).length > biggest_chars) {
					biggest_chars = String(doc.text).length
					biggest_path = doc.path
				}
			log_info(`slow index batch ${t_commit - t_start}ms: delete=${t_delete - t_start} file+ids=${t_file - t_delete} fts=${t_fts - t_file} words=${t_words - t_fts} commit=${t_commit - t_words} | docs=${docs.length} content=${content_docs.length} words=${word_count} text=${(text_chars / 1024 / 1024).toFixed(1)}MB biggest=${(biggest_chars / 1024 / 1024).toFixed(1)}MB ${biggest_path}`)
		}
	}

	async delete_doc_by_path(/** @type {string[]} */ ...paths) {
		// Chunked to stay under SQLite's bound-parameter limit: a full scan can pass tens of thousands
		// of removed paths at once, which would otherwise throw "too many SQL variables".
		const chunk = 500
		for (let i = 0; i < paths.length; i += chunk) {
			let group = paths.slice(i, i + chunk)
			let qmarks = new Array(group.length).fill('?').join(',')
			let old_ids = this.db.all(`select id from file where path in (${qmarks})`, group).map(r => Number(r.id))
			this.db.run(`delete from file where path in (${qmarks})`, group)
			if (old_ids.length)
				this.db.run(`delete from file_content_search_index_fts_trigram where rowid in (${new Array(old_ids.length).fill('?').join(',')})`, old_ids)
		}
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

	/** every recorded file path, including binary/oversized files (used by the file picker). */
	all_file_paths() {
		return this.db.all('select path from file').map(r => String(r.path))
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
		// vocab/non-trigram not necessary as file_content has indexed prefix lookups
		// let words = this.db.all('select distinct file_content.word from file_content_search_index_fts_v fts_v left join file_content on fts_v.term = file_content.word_lower where fts_v.term glob ? order by fts_v.cnt desc limit ?',
		// let words = this.db.all('select term from file_content_search_index_fts_v fts_v where term glob ? order by cnt desc limit ?',
		// 	[word.toLowerCase() + '*', limit])
		// 	// .map(r => r.term)
		// 	.map(r => r.word)
		// orders by document frequency (!)
		let words = this.db.all('select word from file_content where word_lower glob ? group by word order by count(*) desc limit ?',
			[word.toLowerCase() + '*', limit])
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

	/** Candidate paths for the file picker's fuzzy matcher. Each lowercased token becomes a
	 * `%c1%c2%...%` LIKE pattern, i.e. exactly the subsequence the JS matcher accepts, so this
	 * prefilter is a lossless superset (no false negatives) that runs the full scan in C off the
	 * UI thread. Ordered by path length so a truncating LIMIT keeps the most concise candidates. */
	find_paths_fuzzy(/** @type string[] */ tokens, /** @type number */ limit) {
		if (! tokens.length)
			return []
		let clauses = []
		/** @type {any[]} */
		let params = []
		for (let token of tokens) {
			let pattern = '%'
			for (let ch of token.toLowerCase())
				pattern += (ch === '%' || ch === '_' || ch === '\\' ? '\\' + ch : ch) + '%'
			clauses.push("path like ? escape '\\'")
			params.push(pattern)
		}
		params.push(limit)
		return this.db.all(`select path from file where ${clauses.join(' and ')} order by length(path) limit ?`, params)
			.map(r => String(r.path))
	}

	find_paths_with_lines_by_word(/** @type {string} */ word, /** @type {boolean} */ is_partial_trigram_query, /** @type {number} */ limit, /** @type {{include?:string[], exclude?:string[], roots?:string[]}} */ filter = {}) {
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

		paths = filter_paths(paths, filter)

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
							line_text: line_preview(line, words_lower),
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
				// The file may have been deleted/renamed/permission-changed since it was indexed
				// (watcher events are debounced, so the index can briefly lag reality); this is
				// routine, not exceptional, so it must not spam the error log.
				if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EISDIR' || err.code === 'EPERM')
					log_debug('skipping unreadable file for matches:', file_path, err.code)
				else
					log_error('Error reading file for matches:', file_path, err.message)
			}

		log_debug(`find matches with lines time: ${(Date.now() - start) / 1000} seconds, ${results.length} files with matches, ${total_matches} total matches`)
		return { results, has_more: total_matches >= limit }
	}
}

/** Turns one user-entered "files to include/exclude" token into an array of micromatch globs,
 * approximating VSCode's search behaviour (segment names, filename globs, bare extensions). */
function expand_glob(/** @type string */ token) {
	token = token.trim()
	if (! token)
		return []
	if (token.startsWith('./'))
		token = token.slice(2)
	else if (token.startsWith('/'))
		token = token.slice(1)
	if (token.includes('/'))
		return [token, token.endsWith('/') ? token + '**' : token + '/**']
	// no slash: a folder/file segment name and/or a filename glob
	if (token.includes('*'))
		return ['**/' + token]
	let globs = ['**/' + token + '/**', '**/' + token]
	if (token.startsWith('.'))
		// bare extension like ".js" -> match any file ending in it
		globs.push('**/*' + token)
	return globs
}

function line_preview(/** @type string */ line, /** @type string[] */ words_lower) {
	// strip leading whitespace (matches VS Code's search result preview)
	let trimmed = line.replace(/^\s+/, '')
	let lower = trimmed.toLowerCase()
	// find the earliest match position among all search words
	let first = -1
	for (let word of words_lower) {
		let idx = lower.indexOf(word)
		if (idx !== -1 && (first === -1 || idx < first))
			first = idx
	}
	// if there is a lot of text before the first match, show at most 27 chars
	// of leading context prefixed with an ellipsis so the match stays visible
	const max_before = 27
	let preview = first > max_before ? '...' + trimmed.slice(first - max_before) : trimmed
	// cap length so huge minified/bundled lines can't overwhelm the webview
	return preview.slice(0, 1000)
}

function relativize(/** @type string */ p, /** @type {string[]|undefined} */ roots) {
	let best = ''
	for (let root of roots || [])
		if ((p === root || p.startsWith(root + '/')) && root.length > best.length)
			best = root
	if (best)
		return p.slice(best.length + 1)
	let idx = p.lastIndexOf('/')
	return idx === -1 ? p : p.slice(idx + 1)
}

function filter_paths(/** @type string[] */ paths, /** @type {{include?:string[], exclude?:string[], roots?:string[]}} */ { include, exclude, roots } = {}) {
	let include_globs = (include || []).flatMap(expand_glob)
	let exclude_globs = (exclude || []).flatMap(expand_glob)
	if (! include_globs.length && ! exclude_globs.length)
		return paths
	return paths.filter(p => {
		let rel = relativize(p, roots)
		if (include_globs.length && ! micromatch.isMatch(rel, include_globs, { dot: true }))
			return false
		if (exclude_globs.length && micromatch.isMatch(rel, exclude_globs, { dot: true }))
			return false
		return true
	})
}
