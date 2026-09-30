let path = require('path')
const { mkdirSync, existsSync, rmSync } = require('fs')
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

	/** Register a scalar SQL function (arity inferred from fn.length). */
	register_function(/** @type string */ name, /** @type {(...args:any[])=>any} */ fn) {
		this._db.function(name, fn)
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
 * @property {boolean} [content_indexed] whether this file's contents were meant to be full-text indexed. Persisted so a settings change (e.g. `search.useIgnoreFiles`) that flips it re-indexes the file even when its mtime is unchanged.
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

		let db_path = path.join(index_path, 'index6.db') // version bump after scheme change
		this.db = new Db(db_path)

		// path_ok() lets search_lines push the include/exclude path filter INTO the SQL, so the LIMIT
		// counts only rows that actually pass it. Filtering after a LIMIT starved restrictive filters: a
		// common term + `include: *.js` returned nothing because the first LIMIT rows (rowid order) were
		// all non-js files and got discarded before any js file was reached. The predicate is swapped in
		// per query via _search_path_ok; _search_scan_count records how many rows it examined (diagnostics).
		this._search_path_ok = /** @type {((p:string)=>boolean)|null} */ (null) // eslint-disable-line no-extra-parens
		this._search_scan_count = 0
		this.db.register_function('path_ok', (/** @type any */ p) => {
			this._search_scan_count++
			if (this._search_path_ok && ! this._search_path_ok(String(p)))
				return 0
			return 1
		})

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
		// Schema (fts5 docs @ sqlite.org/fts5.html):
		//   file          — one row per indexed path (+ mtime and the content-indexed intent flag).
		//   file_content  — the word list per file (case-preserved + lowercased) powering autocomplete
		//                   and go-to-definition. sqlite's case-insensitivity is ascii-only without ICU,
		//                   so we store both forms; fts trigram can't do whole-word/frequency lookups.
		//   line          — one row per non-empty source line (file_id, 1-based line_no, text). Storing
		//                   the line text lets a search return the matching file + line number + preview
		//                   directly from the index, with NO file reads at query time.
		//   line_search_fts_trigram — contentless trigram index over line text (substring search). Kept
		//                   in sync with `line` by the two triggers below; we retrieve text/line_no by
		//                   joining fts.rowid back to `line`. recursive_triggers is off (default), so an
		//                   FK-cascade delete of a `line` row does NOT fire line_ad — callers that need
		//                   the fts updated delete from `line` explicitly (see delete_doc_by_path).
		this.db.exec(`
			pragma page_size = 8192;
			pragma journal_mode = wal;
			pragma foreign_keys = on;
			pragma synchronous = normal;
			pragma temp_store = memory;
			pragma cache_size = -131072;
			pragma mmap_size = 536870912;
			${this.extra_pragmas}
			create table if not exists file(id integer primary key autoincrement, path text unique, mtime number, content_indexed integer);
			create table if not exists file_content(file_id integer references file(id) on delete cascade on update restrict, word text, word_lower text, primary key (file_id, word)) without rowid;
			create index if not exists idx_file_content_word on file_content(word);
			create index if not exists idx_file_content_word_lower on file_content(word_lower);
			create table if not exists line(id integer primary key, file_id integer references file(id) on delete cascade on update restrict, line_no integer, text text);
			create index if not exists idx_line_file_id on line(file_id);
			create virtual table if not exists line_search_fts_trigram using FTS5(text, content='', tokenize='trigram', contentless_delete=1);
			create trigger if not exists line_ai after insert on line begin
				insert into line_search_fts_trigram(rowid, text) values (new.id, new.text);
			end;
			create trigger if not exists line_ad after delete on line begin
				delete from line_search_fts_trigram where rowid = old.id;
			end;
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

	/** Wipe every indexed file and its content. Used by the manual "Rebuild Index" command so the next
	 * full scan reindexes from scratch. file_content and line rows cascade via the foreign key; the
	 * contentless FTS is cleared explicitly (a cascade delete of `line` does not fire the sync trigger
	 * because recursive_triggers is off). */
	clear_all() {
		this.db.exec('delete from line_search_fts_trigram; delete from file;')
	}

	/** Folds the WAL back into the main db file. Passive auto-checkpointing alone can lag far behind
	 * during a large (re)index, leaving index6.db-wal at hundreds of MB until VS Code restarts; call
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
		let file_row_placeholders = new Array(docs.length).fill('(?,?,?)').join(',')
		this.delete_doc_by_path(...paths)
		let t_delete = Date.now()
		this.db.run(`insert into file (path, mtime, content_indexed) values ${file_row_placeholders}`, docs.map(d => [d.path, d.mtime, d.content_indexed ? 1 : 0]).flat())
		let new_ids = this.db.all(`select id, path from file where path in (${single_qmarks_paths})`, paths)
		let new_id_by_path = new_ids.reduce((/** @type {Record<string, number>} */ all, { id, path }) => { all[String(path)] = Number(id); return all }, {})
		let t_file = Date.now()
		// Only docs with actual text content get their contents indexed. Binary/oversized files
		// (text === null) are still recorded above as file rows only, so the file picker can link
		// to them and so they are not rescanned every time.
		let content_docs = docs.filter(doc => doc.text != null)
		let text_chars = 0
		let word_count = 0
		let line_count = 0
		let t_fts = t_file
		let t_words = t_file
		if (content_docs.length) {
			for (let doc of content_docs)
				text_chars += String(doc.text).length
			// Line index: one row per non-empty source line. Storing the text lets a search return the
			// matching line + line number straight from the DB (no file reads at query time). The line_ai
			// trigger mirrors each inserted row into the contentless trigram FTS. line_no is 1-based over the
			// ORIGINAL file (empty lines still count) so it points at the right line when the file is opened.
			let line_rows = []
			for (let doc of content_docs) {
				let file_id = new_id_by_path[doc.path]
				let lines = String(doc.text).split('\n')
				for (let i = 0; i < lines.length; i++) {
					let text = /** @type {string} */ (lines[i]) // eslint-disable-line no-extra-parens
					if (text.charCodeAt(text.length - 1) === 13) // strip a trailing \r from CRLF files
						text = text.slice(0, -1)
					if (text.length < 3) // trigram tokenizer emits nothing for <3 chars, so such a line can never match
						continue
					line_rows.push([file_id, i + 1, text])
				}
			}
			line_count = line_rows.length
			const line_rows_per_chunk = this.rows_per_chunk
			let full_line_chunks = Math.floor(line_rows.length / line_rows_per_chunk)
			if (full_line_chunks) {
				let stmt = this.db.prepare(`insert into line (file_id, line_no, text) values ${new Array(line_rows_per_chunk).fill('(?,?,?)').join(',')}`)
				for (let i = 0; i < full_line_chunks; i++)
					stmt.run(line_rows.slice(i * line_rows_per_chunk, (i + 1) * line_rows_per_chunk).flat())
				stmt.finalize()
			}
			let line_remainder = line_rows.slice(full_line_chunks * line_rows_per_chunk)
			if (line_remainder.length)
				this.db.run(`insert into line (file_id, line_no, text) values ${new Array(line_remainder.length).fill('(?,?,?)').join(',')}`, line_remainder.flat())
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
			log_info(`slow index batch ${t_commit - t_start}ms: delete=${t_delete - t_start} file+ids=${t_file - t_delete} lines=${t_fts - t_file} words=${t_words - t_fts} commit=${t_commit - t_words} | docs=${docs.length} content=${content_docs.length} lines=${line_count} words=${word_count} text=${(text_chars / 1024 / 1024).toFixed(1)}MB biggest=${(biggest_chars / 1024 / 1024).toFixed(1)}MB ${biggest_path}`)
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
			// Delete the file's lines explicitly (not via the FK cascade of the file delete below): the
			// line_ad trigger keeps the contentless FTS in sync, and recursive_triggers is off so a cascade
			// delete would leave the FTS rows orphaned.
			if (old_ids.length)
				this.db.run(`delete from line where file_id in (${new Array(old_ids.length).fill('?').join(',')})`, old_ids)
			this.db.run(`delete from file where path in (${qmarks})`, group)
		}
	}

	/** not returning text contents here */
	// TODO: rename to path_meta everywhere
	all_meta_docs() {
		let rows = this.db.all('select path, mtime, content_indexed from file')
		for (let row of rows) {
			row.mtime = Number(row.mtime)
			row.content_indexed = !! row.content_indexed
		}
		// TODO: indexdoc has a .text prop ...?
		return /** @type {IndexDoc[]} */ (rows) // eslint-disable-line no-extra-parens
	}

	/** every recorded file path with its mtime (unix seconds), including binary/oversized files
	 * (used by the file picker). */
	all_file_paths() {
		return this.db.all('select path, mtime from file').map(r => ({ path: String(r.path), mtime: Number(r.mtime) }))
	}

	autocomplete_word(/** @type string */ word, /** @type number */ limit) {
		log_debug('autocompleting', word, 'with limit', limit)
		let start = Date.now()
		// Prefix lookup over the word table, ordered by document frequency. file_content stores each word
		// lowercased (indexed) alongside its case-preserved form, so a `glob` prefix on word_lower is a
		// fast indexed scan; the trigram index can't serve this (its terms are three-letter fragments).
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

	/** Candidate paths (with mtime, unix seconds) for the file picker's fuzzy matcher. Each lowercased
	 * token becomes a `%c1%c2%...%` LIKE pattern, i.e. exactly the subsequence the JS matcher accepts,
	 * so this prefilter is a lossless superset (no false negatives) that runs the full scan in C off the
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
		return this.db.all(`select path, mtime from file where ${clauses.join(' and ')} order by length(path) limit ?`, params)
			.map(r => ({ path: String(r.path), mtime: Number(r.mtime) }))
	}

	/** Substring search over the line index. One FTS lookup returns matching lines with their file path,
	 * line number and text directly — no files are opened. Results are grouped by file (in the FTS's
	 * rowid order, i.e. file then line order) and capped at `limit` total matches. `filter` applies the
	 * picker/panel include/exclude/roots globs per path. */
	search_lines(/** @type {string} */ word, /** @type {number} */ limit, /** @type {{include?:string[], exclude?:string[], roots?:string[], case_sensitive?:boolean}} */ filter = {}) {
		let start = Date.now()
		let fts_query = build_fts_query(word)
		if (! fts_query)
			return { results: [], has_more: false }
		// Case sensitivity is set explicitly by the caller (a UI toggle), not inferred. The trigram index
		// is case-insensitive and cannot enforce words shorter than 3 chars, so each candidate line is
		// re-checked with a same-line regex (a lookahead per word). The line text is already in hand, so
		// this costs nothing extra and keeps precision identical to a literal scan.
		let case_sensitive = !! filter.case_sensitive
		let words = word.split(/\s+/).filter(Boolean)
		let words_match = case_sensitive ? words : words.map(w => w.toLowerCase())
		let line_re = new RegExp('^' + words.map(w => '(?=[^\\n]*' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')').join('') + '[^\\n]*$', case_sensitive ? '' : 'i')
		let path_ok = build_path_filter(filter)
		// Push the include/exclude filter INTO SQL (via path_ok) so the LIMIT applies to rows that pass
		// it — filtering after the LIMIT made a common term + a restrictive include return nothing (the
		// first `limit` rows were all filtered out). roots don't filter here (build_path_filter only uses
		// them to relativise), so only real include/exclude globs need the pushdown.
		let has_include = !! (filter.include && filter.include.length)
		let has_exclude = !! (filter.exclude && filter.exclude.length)
		let has_path_filter = has_include || has_exclude
		let sql = 'select f.path as path, l.line_no as line_no, l.text as text from line_search_fts_trigram fts inner join line l on l.id = fts.rowid inner join file f on f.id = l.file_id where fts.text match ?'
		if (has_path_filter) {
			sql += ' and path_ok(f.path)'
			this._search_path_ok = path_ok
		}
		// No `order by rank`: ranking forces SQLite to materialise and sort the ENTIRE match set, whereas an
		// unordered query streams the first `limit` rows and stops. Rows arrive in rowid (file/line) order.
		sql += ' limit ?'
		this._search_scan_count = 0
		let rows = this.db.all(sql, [fts_query, limit])
		this._search_path_ok = null
		let scanned = this._search_scan_count
		let t_query = Date.now()
		/** @type {Map<string, {line_number:number, line_text:string}[]>} */
		let by_path = new Map()
		let total_matches = 0
		let has_more = false
		for (let row of rows) {
			let text = String(row.text)
			if (! line_re.test(text))
				continue
			let file_path = String(row.path)
			let matches = by_path.get(file_path)
			if (! matches) {
				matches = []
				by_path.set(file_path, matches)
			}
			matches.push({ line_number: Number(row.line_no), line_text: line_preview(text, words_match, case_sensitive) })
			total_matches++
			if (total_matches >= limit) {
				has_more = true
				break
			}
		}
		let results = [...by_path.entries()].map(([path, matches]) => ({ path, matches }))
		log_debug(`search_lines: ${Date.now() - start}ms (sql+fetch ${t_query - start}ms, filter+group ${Date.now() - t_query}ms), fetched ${rows.length} rows${has_path_filter ? ` (scanned ${scanned})` : ''} -> ${results.length} files, ${total_matches} matches | fts=${fts_query}`)
		return { results, has_more }
	}

	/** Go-to-definition support: lines that contain the exact word, in files where it appears as a whole
	 * word (via the case-preserved word table). Resolved straight from the line index — no file reads. */
	find_definition_lines(/** @type {string} */ word, /** @type {number} */ limit) {
		let like = '%' + word.replace(/[\\%_]/g, ch => '\\' + ch) + '%'
		let rows = this.db.all("select f.path as path, l.line_no as line_no, l.text as text from file_content fc inner join line l on l.file_id = fc.file_id inner join file f on f.id = fc.file_id where fc.word = ? and l.text like ? escape '\\' limit ?", [word, like, limit])
		/** @type {Map<string, {line_number:number, line_text:string}[]>} */
		let by_path = new Map()
		for (let row of rows) {
			let file_path = String(row.path)
			let matches = by_path.get(file_path)
			if (! matches) {
				matches = []
				by_path.set(file_path, matches)
			}
			matches.push({ line_number: Number(row.line_no), line_text: line_preview(String(row.text), [word], true) })
		}
		return { results: [...by_path.entries()].map(([path, matches]) => ({ path, matches })), has_more: false }
	}
}

/** FTS5 query string for a user query: AND of quoted trigram phrases. FTS5 has its own query syntax
 * (`-` = NOT, `:` = column filter, `.`/`"` special), so a raw query like `focus-visible` or `a.b` is a
 * syntax error; quoting each whitespace token as a string literal (doubling internal quotes) turns it
 * into a substring phrase under the trigram tokenizer. Returns '' when the query has no usable tokens. */
function build_fts_query(/** @type string */ word) {
	return word.trim().split(/\s+/).filter(Boolean)
		.map(t => '"' + t.replace(/"/g, '""') + '"').join(' ')
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

function line_preview(/** @type string */ line, /** @type string[] */ words, /** @type boolean */ case_sensitive) {
	// strip leading whitespace (matches VS Code's search result preview)
	let trimmed = line.replace(/^\s+/, '')
	let haystack = case_sensitive ? trimmed : trimmed.toLowerCase()
	// find the earliest match position among all search words
	let first = -1
	for (let word of words) {
		let idx = haystack.indexOf(word)
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

/** Builds a per-path predicate from the include/exclude/roots globs (approximating VSCode's
 * "files to include/exclude"). Returns a function that is true when the path should be kept. */
function build_path_filter(/** @type {{include?:string[], exclude?:string[], roots?:string[]}} */ { include, exclude, roots } = {}) {
	let include_globs = (include || []).flatMap(expand_glob)
	let exclude_globs = (exclude || []).flatMap(expand_glob)
	if (! include_globs.length && ! exclude_globs.length)
		return () => true
	return (/** @type string */ p) => {
		let rel = relativize(p, roots)
		if (include_globs.length && ! micromatch.isMatch(rel, include_globs, { dot: true }))
			return false
		if (exclude_globs.length && micromatch.isMatch(rel, exclude_globs, { dot: true }))
			return false
		return true
	}
}
