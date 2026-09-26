// Standalone indexing benchmark harness. Runs the REAL scanning + indexing pipeline
// (src/find-files.js, src/indexer.js, src/index-queue.js) against a target folder, with the
// SQLite index living in /tmp, so we can measure and tune indexing performance outside VS Code.
//
// Usage:
//   node bench/index-bench.js [targetDir] [--key=value ...]
//
// Tunables (all optional, defaults match production):
//   --rows_per_chunk=500          file_content multi-row insert size
//   --min_word_length=3           minimum indexed word length
//   --read_group_size=20          files read in parallel per group
//   --docs_batch_bytes=5          flush the index batch after this many MB read
//   --max_index_size=20           skip content-indexing files larger than this many MB
//   --yield_interval=90           ms of work between disk-yield pauses
//   --yield_sleep=7               ms to sleep on each disk-yield pause
//   --pragmas="..."               extra PRAGMA statements run at db open
//   --drop_word_indexes=0|1       drop file_content secondary indexes during bulk load, recreate after
//   --scan_only=0|1               only run the scan phase
//   --limit=N                     only index the first N scanned files (0 = all)
//   --keep_db=0|1                 keep the /tmp index dir afterwards (default: delete first, keep after)
const path = require('path')
const os = require('os')
const Module = require('module')
const { rmSync, existsSync, mkdirSync, statSync, readdirSync } = require('fs')
const { stat } = require('fs/promises')

// ---- install the vscode shim before requiring any of our modules ----
const vscode_shim = require('./vscode-shim')
const original_load = Module._load
Module._load = function(request, parent, isMain) {
	if (request === 'vscode')
		return vscode_shim
	return original_load.call(this, request, parent, isMain)
}

const { find_files } = require('../src/find-files')
const { Indexer } = require('../src/indexer')
const { IndexQueue } = require('../src/index-queue')

// ---- args ----
/** @type {Record<string,string>} */
let flags = {}
let positional = []
for (let a of process.argv.slice(2)) {
	let m = /^--([^=]+)=(.*)$/.exec(a)
	if (m)
		flags[m[1]] = m[2]
	else if (a.startsWith('--'))
		flags[a.slice(2)] = '1'
	else
		positional.push(a)
}
let num = (/** @type string */ k, /** @type number */ d) => flags[k] != null ? Number(flags[k]) : d

let target = positional[0] || path.join(os.homedir(), 'code', 'gastronovi_eeecore')
target = path.resolve(target.replace(/^~(?=$|\/)/, os.homedir()))
if (! existsSync(target)) {
	console.error('target folder does not exist:', target)
	process.exit(1)
}

let rows_per_chunk = num('rows_per_chunk', 500)
let min_word_length = num('min_word_length', 3)
let read_group_size = num('read_group_size', 20)
let docs_batch_bytes_threshold = num('docs_batch_bytes', 5) * 1024 * 1024
let max_index_size = num('max_index_size', 20) * 1024 * 1024
let yield_interval_ms = num('yield_interval', 90)
let yield_sleep_ms = num('yield_sleep', 7)
let max_docs_per_batch = num('max_docs_per_batch', 5000)
let max_avg_line_length = num('max_avg_line_length', 300)
let extra_pragmas = flags.pragmas || ''
let drop_word_indexes = flags.drop_word_indexes === '1'
let scan_only = flags.scan_only === '1'
let limit = num('limit', 0)
let keep_db = flags.keep_db === '1'

vscode_shim.set_workspace_folders([target])

// ---- default excludes (mirrors extension.js get_exclude_patterns defaults) ----
const exclude_patterns = ['**/.DS_Store', '**/.git', '**/.git/objects/**', '**/.git/subtree-cache/**', '**/.hg', '**/.hg/store/**', '**/.svn', '**/*.code-search', '**/bower_components', '**/CVS', '**/node_modules', '**/node_modules/*/**', '**/Thumbs.db', '**/.git/**']

// ---- storage in /tmp ----
const storage_path = path.join(os.tmpdir(), 'spp-bench')
if (! keep_db && existsSync(storage_path))
	rmSync(storage_path, { recursive: true, force: true })
mkdirSync(storage_path, { recursive: true })

function dir_size(/** @type string */ dir) {
	let total = 0
	if (! existsSync(dir))
		return 0
	for (let name of readdirSync(dir)) {
		let full = path.join(dir, name)
		let st = statSync(full)
		total += st.isDirectory() ? dir_size(full) : st.size
	}
	return total
}
let mb = (/** @type number */ b) => (b / 1024 / 1024).toFixed(1) + ' MB'
let secs = (/** @type number */ ms) => (ms / 1000).toFixed(2) + 's'

async function main() {
	console.log('=== search++ index benchmark ===')
	console.log('target       :', target)
	console.log('storage      :', storage_path)
	console.log('params       :', JSON.stringify({ rows_per_chunk, min_word_length, read_group_size, docs_batch_mb: docs_batch_bytes_threshold / 1024 / 1024, max_index_mb: max_index_size / 1024 / 1024, yield_interval_ms, yield_sleep_ms, extra_pragmas, drop_word_indexes, limit }))

	// ---- SCAN ----
	let t0 = Date.now()
	let files = await find_files({ excludes: exclude_patterns })
	let scan_ms = Date.now() - t0
	let indexed_count = files.filter(f => f.index_content).length
	console.log(`\n[scan]  ${files.length} files (${indexed_count} content-indexed, ${files.length - indexed_count} name-only) in ${secs(scan_ms)}`)
	if (scan_only)
		return

	// ---- stat -> FileMeta ----
	t0 = Date.now()
	let metas = (await Promise.all(files.map(async f => {
		try {
			let st = await stat(f.uri.fsPath)
			return { path: f.uri.path, size: st.size, mtime: Math.round(st.mtimeMs / 1000), index_content: f.index_content }
		} catch {
			return null
		}
	}))).filter(Boolean)
	// ripgrep returns files in non-deterministic (parallel-traversal) order; sort so --limit picks the
	// same subset every run and benchmarks are comparable.
	metas.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
	if (limit > 0)
		metas = metas.slice(0, limit)
	console.log(`[stat]  ${metas.length} files stat'd in ${secs(Date.now() - t0)}`)

	// ---- INDEX ----
	let indexer = new Indexer({ storage_path, rows_per_chunk, min_word_length, extra_pragmas })
	let queue = new IndexQueue(indexer, { read_group_size, docs_batch_bytes_threshold, max_index_size, yield_interval_ms, yield_sleep_ms, max_docs_per_batch, max_avg_line_length })
	for (let m of metas)
		queue.add(/** @type {any} */ (m)) // eslint-disable-line no-extra-parens

	// instrument db time (attribute by sql keyword) without touching source
	let timings = { fts: 0, file_content: 0, file: 0, delete: 0, other: 0, calls: 0 }
	let classify = (/** @type string */ sql) => {
		if (sql.includes('fts_trigram'))
			return 'fts'
		if (sql.includes('file_content'))
			return 'file_content'
		if (/^\s*delete/i.test(sql))
			return 'delete'
		if (sql.includes(' file ') || /into file /i.test(sql))
			return 'file'
		return 'other'
	}
	let orig_run = indexer.db.run.bind(indexer.db)
	indexer.db.run = (/** @type string */ sql, /** @type any */ v) => {
		let s = Date.now()
		let r = orig_run(sql, v)
		timings[classify(sql)] += Date.now() - s
		timings.calls++
		return r
	}
	let orig_prepare = indexer.db.prepare.bind(indexer.db)
	indexer.db.prepare = (/** @type string */ sql) => {
		let stmt = orig_prepare(sql)
		let bucket = classify(sql)
		let orig_stmt_run = stmt.run.bind(stmt)
		stmt.run = (/** @type any */ v) => {
			let s = Date.now()
			let r = orig_stmt_run(v)
			timings[bucket] += Date.now() - s
			timings.calls++
			return r
		}
		return stmt
	}

	if (drop_word_indexes)
		indexer.db.exec('drop index if exists idx_file_content_word; drop index if exists idx_file_content_word_lower;')

	// surface batch failures that the queue would otherwise swallow (rollback)
	let batch_failures = 0
	let orig_index_docs = indexer.index_docs.bind(indexer)
	indexer.index_docs = (/** @type any */ docs) => {
		try {
			return orig_index_docs(docs)
		} catch (e) {
			batch_failures++
			if (batch_failures <= 3)
				console.error(`  !! batch of ${docs.length} docs failed:`, String(e?.message || e).slice(0, 200))
			throw e
		}
	}

	t0 = Date.now()
	await queue.run({ on_progress: () => {} })
	let index_ms = Date.now() - t0

	if (drop_word_indexes) {
		let s = Date.now()
		indexer.db.exec('create index if not exists idx_file_content_word on file_content(word); create index if not exists idx_file_content_word_lower on file_content(word_lower);')
		console.log(`[reindex] recreated word indexes in ${secs(Date.now() - s)}`)
	}

	let file_rows = indexer.db.get('select count(*) c from file')?.c
	let content_rows = indexer.db.get('select count(*) c from file_content')?.c
	let db_bytes = dir_size(storage_path)

	console.log(`\n[index] ${metas.length} files in ${secs(index_ms)}  (${(metas.length / (index_ms / 1000)).toFixed(0)} files/s)`)
	console.log(`        db rows: file=${file_rows}  file_content=${content_rows}  (batch_failures=${batch_failures})`)
	console.log(`        db size on disk: ${mb(db_bytes)}`)
	console.log(`        db time by area: fts=${secs(timings.fts)} file_content=${secs(timings.file_content)} file=${secs(timings.file)} delete=${secs(timings.delete)} other=${secs(timings.other)}  (${timings.calls} calls)`)
	console.log(`        non-db (read/binary/tokenize/yield): ${secs(index_ms - timings.fts - timings.file_content - timings.file - timings.delete - timings.other)}`)
	console.log(`\nSUMMARY scan=${secs(scan_ms)} index=${secs(index_ms)} files=${metas.length} files_per_s=${(metas.length / (index_ms / 1000)).toFixed(0)} db=${mb(db_bytes)}`)

	if (! keep_db)
		rmSync(storage_path, { recursive: true, force: true })
}

main().catch(e => {
	console.error('benchmark failed:', e)
	process.exit(1)
})
