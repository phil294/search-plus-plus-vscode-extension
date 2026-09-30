const { spawn } = require('child_process')
const { existsSync, readdirSync } = require('fs')
const path = require('path')
let vscode = require('vscode')
const { log_debug, log_error } = require('./log')

// ripgrep binary path, resolved lazily + memoised. We deliberately do NOT bundle our own rg: VS Code
// already ships one built for the user's exact platform, so reusing it is universal and keeps the VSIX
// small. Its location is an internal detail that has changed across versions (vscode-ripgrep ->
// @vscode/ripgrep -> @vscode/ripgrep-universal), so we probe the known layouts under env.appRoot.
/** @type {string|undefined} */
let rg_path_cache
function rg_path() {
	if (rg_path_cache)
		return rg_path_cache
	let exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
	let target = `${process.platform}-${process.arch}` // e.g. linux-arm64, win32-x64
	let node_dirs = app_roots().flatMap(root => [
		path.join(root, 'node_modules.asar.unpacked'),
		path.join(root, 'node_modules'),
	])
	let candidates = node_dirs.flatMap(dir => [
		path.join(dir, '@vscode', 'ripgrep-universal', 'bin', target, exe),
		path.join(dir, '@vscode', 'ripgrep', 'bin', target, exe),
		path.join(dir, '@vscode', 'ripgrep', 'bin', exe),
		path.join(dir, 'vscode-ripgrep', 'bin', exe),
	])
	rg_path_cache = candidates.find(existsSync)
	// not doing this to catch errors in dev too:
	// if (! rg_path_cache)
	// 	// Dev-only last resort: the @vscode/ripgrep devDependency (host-platform binary, not in the VSIX).
	// 	try {
	// 		let dev = require('@vscode/ripgrep').rgPath
	// 		if (existsSync(dev))
	// 			rg_path_cache = dev
	// 	} catch { /* not installed in the packaged extension */ }
	if (! rg_path_cache) {
		log_error(`could not locate ripgrep under ${vscode.env.appRoot} (tried @vscode/ripgrep-universal, @vscode/ripgrep); file search unavailable`)
		throw new Error('ripgrep binary not found')
	}
	log_debug(`using ripgrep at ${rg_path_cache}`)
	return rg_path_cache
}

// Candidate app dirs to search for the bundled rg. env.appRoot is the anchor, but VS Code 1.122.0
// nests a second copy at <appRoot>/<commitHash>/resources/app, so also include any nested app dir
// found via a single readdir (no recursive glob).
function app_roots() {
	let root = vscode.env.appRoot
	let roots = [root]
	try {
		for (let entry of readdirSync(root, { withFileTypes: true })) {
			if (! entry.isDirectory())
				continue
			let nested = path.join(root, entry.name, 'resources', 'app')
			if (existsSync(nested))
				roots.push(nested)
		}
	} catch { /* appRoot unreadable; the base root still gets probed */ }
	return roots
}

// Extra ripgrep flags for the CONTENT-INDEXED pass, from the ignore settings. Search++'s own
// `search++.useIgnoreFiles` / `search++.useGlobalIgnoreFiles` override the native `search.*` ones when
// set (null = inherit the native value):
// - useIgnoreFiles (default true): honour .gitignore/.ignore. false -> --no-ignore, so everything
//   (e.g. gitignored vendor/) gets content-indexed, not just listed name-only.
// - useGlobalIgnoreFiles (default false): honour the user's global gitignore. ripgrep honours it by
//   default, so we add --no-ignore-global unless it's explicitly enabled, matching VS Code.
function indexed_ignore_args() {
	let cfg = vscode.workspace.getConfiguration()
	let use_ignore = cfg.get('search++.useIgnoreFiles')
	if (use_ignore == null)
		use_ignore = cfg.get('search.useIgnoreFiles')
	let use_global = cfg.get('search++.useGlobalIgnoreFiles')
	if (use_global == null)
		use_global = cfg.get('search.useGlobalIgnoreFiles')
	if (use_ignore === false)
		return ['--no-ignore']
	if (use_global === true)
		return []
	return ['--no-ignore-global']
}

/** Lists workspace files using ripgrep, which natively honours .gitignore/.ignore/.rgignore as
 * well as the extra `excludes` globs (files.exclude, search.exclude, etc.). Much faster and simpler
 * than the old findFiles2 + manual gitignore path. https://github.com/microsoft/vscode/issues/48674
 *
 * Each returned file carries `index_content`: non-gitignored files are content-indexed, while
 * gitignored files are still listed (for the file picker) but recorded name-only.
 * @returns {Promise<{uri:import('vscode').Uri, index_content:boolean}[]>} */
module.exports.find_files = async (/** @type {{excludes:string[]}} */ { excludes }) => {
	log_debug('ripgrep scan...')
	let folders = vscode.workspace.workspaceFolders || []
	let files = (await Promise.all(folders.map(folder => list_folder_files(folder, excludes)))).flat()
	log_debug(`found ${files.length} files in workspace (incl. gitignored, name-only)`)
	return files
}

/** Absolute paths ripgrep would content-index right now (gitignore honoured). Used to classify
 * newly-created files on the watcher path without a full rescan.
 * @returns {Promise<Set<string>>} */
module.exports.find_indexed_paths = async (/** @type {{excludes:string[]}} */ { excludes }) => {
	let folders = vscode.workspace.workspaceFolders || []
	let per = await Promise.all(folders.map(async folder => {
		let rels = await rg_list(folder, excludes, indexed_ignore_args())
		return rels.map(rel => vscode.Uri.joinPath(folder.uri, rel).path)
	}))
	return new Set(per.flat())
}

async function list_folder_files(/** @type import('vscode').WorkspaceFolder */ folder, /** @type string[] */ excludes) {
	// Two passes: the default pass honours .gitignore and is the set we content-index. The
	// --no-ignore-vcs pass additionally returns gitignored files (still respecting .ignore/.rgignore
	// and the `excludes` globs, so node_modules etc. stay out); those extras are shown in the file
	// picker but recorded name-only, never content-indexed.
	let [indexed_rels, all_rels] = await Promise.all([
		rg_list(folder, excludes, indexed_ignore_args()),
		rg_list(folder, excludes, ['--no-ignore-vcs']),
	])
	let indexed = new Set(indexed_rels)
	return all_rels.map(rel => ({
		uri: vscode.Uri.joinPath(folder.uri, rel),
		index_content: indexed.has(rel),
	}))
}

function rg_list(/** @type import('vscode').WorkspaceFolder */ folder, /** @type string[] */ excludes, /** @type string[] */ extra_args) {
	return new Promise((/** @type {(rels:string[])=>void} */ resolve, reject) => {
		// --files: list files instead of searching. --hidden: include dotfiles (gitignore still applies).
		// --null: NUL-separate paths (safe for any filename). Symlinks are deliberately NOT followed
		// (no --follow): following them traverses symlinked dirs that point inside the workspace, which
		// both indexes their target twice (e.g. novi_eeecore -> gastronovi_eeecore) and triggers
		// "File system loop found" errors. This matches VS Code's own search default.
		let args = ['--files', '--hidden', '--null', ...extra_args]
		for (let ex of excludes)
			args.push('--glob', '!' + ex)
		let cwd = folder.uri.fsPath
		let child = spawn(rg_path(), args, { cwd })
		/** @type {Buffer[]} */
		let out = []
		let err = ''
		child.stdout.on('data', (d) => out.push(d))
		child.stderr.on('data', (d) => { err += d.toString() })
		child.on('error', reject)
		child.on('close', (code) => {
			// 0 = files listed, 1 = no files matched. Both are fine; 2 = actual error.
			if (code !== 0 && code !== 1) {
				// Defensive: any stray broken-symlink / loop noise from rg is benign (it still lists
				// every other file), so it must not abort the whole scan. Any other stderr is fatal.
				let fatal = err.split('\n')
					.map(l => l.trim())
					.filter(Boolean)
					.filter(l => ! /No such file or directory \(os error 2\)/.test(l))
					.filter(l => ! /File system loop found/.test(l))
				if (fatal.length) {
					log_error('ripgrep failed while scanning ' + cwd + ': ' + err)
					return reject(new Error('ripgrep exited with code ' + code + ': ' + fatal.join('; ')))
				}
				log_debug('ripgrep reported dead symlinks/loops while scanning ' + cwd + ' (ignored): ' + err.trim())
			}
			let rels = Buffer.concat(out).toString('utf-8').split('\0').filter(Boolean)
			resolve(rels)
		})
	})
}

// Approximates expand_glob (indexer.js) for ripgrep `-g` globs: turns one raw include/exclude token
// into rg glob(s). rg supports `**` and matches globs against the path relative to the search root.
function to_rg_globs(/** @type string */ token) {
	token = token.trim()
	if (! token)
		return []
	if (token.startsWith('./'))
		token = token.slice(2)
	else if (token.startsWith('/'))
		token = token.slice(1)
	if (token.includes('/'))
		return token.endsWith('/') ? [token + '**'] : [token, token + '/**']
	if (token.includes('*'))
		return ['**/' + token]
	let globs = ['**/' + token + '/**', '**/' + token]
	if (token.startsWith('.'))
		globs.push('**/*' + token)
	return globs
}

/** Regex content search via ripgrep — the fallback for search_lines_regex when a pattern has no literal
 * long enough to drive the FTS trigram prefilter (e.g. `\d{3}-\d{4}`). Searches the content-indexed file
 * set the index uses (gitignore honoured), honouring the include/exclude tokens, and returns results
 * shaped like search_lines. Reading stops once `limit` matches are collected. `on_partial`, if given, is
 * called (throttled) with the cumulative results as matches stream in, so the UI can render early.
 * `exclude_globs` are raw gitignore-style globs (the files.exclude/search.exclude settings) applied as-is,
 * so the fallback drops the same node_modules/etc. the index omits even when gitignore is disabled.
 * @param {{pattern:string, case_sensitive:boolean, include?:string[], exclude?:string[], exclude_globs?:string[], limit:number, signal?:AbortSignal, on_partial?:(results:{path:string, matches:{line_number:number, line_text:string}[]}[], has_more:boolean)=>void}} opts
 * @returns {Promise<{results:{path:string, matches:{line_number:number, line_text:string}[]}[], has_more:boolean}>} */
module.exports.ripgrep_search_lines = async ({ pattern, case_sensitive, include = [], exclude = [], exclude_globs = [], limit, signal, on_partial }) => {
	let folders = vscode.workspace.workspaceFolders || []
	/** @type {Map<string, {line_number:number, line_text:string}[]>} */
	let by_path = new Map()
	let total = 0
	let has_more = false
	let last_emit = 0
	let snapshot = () => [...by_path.entries()].map(([path, matches]) => ({ path, matches }))
	let on_match = (/** @type {{path:string, line_number:number, line_text:string}} */ m) => {
		let arr = by_path.get(m.path)
		if (! arr) {
			arr = []
			by_path.set(m.path, arr)
		}
		arr.push({ line_number: m.line_number, line_text: m.line_text })
		total++
		// Stream the first matches straight away (rg may keep scanning for a while to find the rest),
		// mirroring the built-in search instead of blocking on the whole scan.
		let now = Date.now()
		if (on_partial && now - last_emit >= 150) {
			last_emit = now
			on_partial(snapshot(), has_more)
		}
	}
	for (let folder of folders) {
		if (total >= limit || signal?.aborted)
			break
		let capped = await rg_content(folder, pattern, case_sensitive, include, exclude, exclude_globs, limit - total, signal, on_match)
		if (capped)
			has_more = true
	}
	return { results: snapshot(), has_more }
}

function rg_content(/** @type import('vscode').WorkspaceFolder */ folder, /** @type string */ pattern, /** @type boolean */ case_sensitive, /** @type string[] */ include, /** @type string[] */ exclude, /** @type string[] */ exclude_globs, /** @type number */ max, /** @type {AbortSignal|undefined} */ signal, /** @type {(m:{path:string, line_number:number, line_text:string})=>void} */ on_match) {
	return new Promise((/** @type {(capped:boolean)=>void} */ resolve, reject) => {
		if (signal?.aborted)
			return resolve(false)
		// --engine auto: use rg's fast linear Rust engine (which handles `.+`, alternation, etc. without the
		// catastrophic backtracking / pathological CPU that PCRE2 hits on long minified lines) and fall back
		// to PCRE2 only for the patterns that truly need it (look-around / backreferences).
		let args = ['--json', '--hidden', '--engine', 'auto', case_sensitive ? '--case-sensitive' : '--ignore-case', ...indexed_ignore_args()]
		for (let g of include.flatMap(to_rg_globs))
			args.push('--glob', g)
		for (let g of exclude.flatMap(to_rg_globs))
			args.push('--glob', '!' + g)
		// settings excludes (files.exclude/search.exclude) as raw globs, mirroring rg_list's indexing pass
		for (let g of exclude_globs)
			args.push('--glob', '!' + g)
		args.push('--regexp', pattern, '--', '.')
		let cwd = folder.uri.fsPath
		let child = spawn(rg_path(), args, { cwd })
		let count = 0
		let capped = false
		let done = false
		let buf = ''
		/** @type {(()=>void)|null} */
		let on_abort = null
		let finish = (/** @type {any} */ err) => {
			if (done)
				return
			done = true
			if (on_abort)
				signal?.removeEventListener('abort', on_abort)
			if (err)
				reject(err)
			else
				resolve(capped)
		}
		on_abort = () => {
			child.kill()
			finish(null)
		}
		signal?.addEventListener('abort', on_abort)
		child.stdout.on('data', (/** @type Buffer */ d) => {
			buf += d.toString()
			let nl
			while ((nl = buf.indexOf('\n')) !== -1) {
				let line = buf.slice(0, nl)
				buf = buf.slice(nl + 1)
				if (! line)
					continue
				let obj
				try {
					obj = JSON.parse(line)
				} catch {
					continue
				}
				if (! obj || obj.type !== 'match')
					continue
				let rel = obj.data?.path?.text
				let text = obj.data?.lines?.text
				if (rel == null || text == null) // non-UTF8 path/line (reported as bytes) — skip
					continue
				let abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel)
				let preview = text.replace(/\r?\n$/, '').replace(/^\s+/, '').slice(0, 1000)
				on_match({ path: vscode.Uri.file(abs).path, line_number: obj.data.line_number, line_text: preview })
				if (++count >= max) {
					capped = true
					child.kill()
					finish(null)
					return
				}
			}
		})
		child.stderr.on('data', () => { /* rg content-search stderr is non-fatal noise */ })
		child.on('error', finish)
		child.on('close', () => finish(null))
	})
}
