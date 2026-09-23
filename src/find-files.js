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
