let vscode = require('vscode')
let path = require('path')
let search_index = require('search-index')
let { debounce, sleep } = require('./util')
let { ClassicLevel } = require('classic-level')
const { mkdirSync, existsSync } = require('fs')
const { isMatch } = require('micromatch')
const { readFile, stat } = require('fs/promises')
const { isBinary } = require('istextorbinary')

const EXT_NAME = 'Search++'
const EXT_ID = 'search++'

// todo proper log with timestamps like e.g. git or extension host
let log = vscode.window.createOutputChannel(EXT_NAME)

module.exports.log = log

let log_error = (/** @type string */e) => { // eslint-disable-line no-unused-vars
	vscode.window.showErrorMessage('Search++: ' + e)
	return log.appendLine(`ERROR: ${e}`)
}
let log_debug = (/** @type any[] */...s) => {
	// if(!config.debuggi) return TODO
	log.appendLine(`[debug] [${new Date().toISOString()}] ${JSON.stringify([...s])}`)
	// vscode.window.showInformationMessage(`[debug] ${JSON.stringify(s)}`)
}

module.exports.activate = async (/** @type vscode.ExtensionContext */context) => {
	log_debug('extension activate')
	if (! vscode.workspace.workspaceFolders || ! context.storageUri) {
		log_debug('no folder opened, aborting')
		// No workspace present. Once the user switches, all extension
		// will be restarted automatically, so we can simply abort here TODO: verify
		return
	}

	/** @type {import('./vscode.git').API} */
	let git_api = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1)
	if (! git_api)
		throw 'Search++ extension depends on the official VSCode Git extension. Did you disable it?'

	// TODO change to just 'index'
	let index_path = path.join(context.storageUri.fsPath, 'index-db')
	if (! existsSync(index_path))
		mkdirSync(index_path, { recursive: true })
	log_debug('search index: ' + index_path)
	let idx = await search_index({
		// Not persisting (using default memdown db) isn't noticeably faster
		db: /** @type {import('abstract-leveldown').AbstractLevelDOWNConstructor} */(/** @type unknown */
			(new ClassicLevel(index_path, { valueEncoding: 'json' }))), // eslint-disable-line no-extra-parens
		name: 'search++-index',
	})

	/** @type string[] */
	let exclude_patterns = []
	// order matters
	/** gitignored patterns aren't set here but only inside refresh() */
	let update_exclude_patterns = () => {
		let default_excludes = {
			// default values for search, files and fileswatcher exclude, not present in the queried config objs below (TODO: or are they?)
			'**/.DS_Store': true, '**/.git': true, '**/.git/objects/**': true, '**/.git/subtree-cache/**': true, '**/.hg': true, '**/.hg/store/**': true, '**/.svn': true, '**/*.code-search': true, '**/bower_components': true, '**/CVS': true, '**/node_modules': true, '**/node_modules/*/**': true, '**/Thumbs.db': true,
			// custom stuff which we'll never care for
			'**/.git/**': true,
		}
		// TODO: works to overwrite file excludes with search++ setting?
		exclude_patterns = [...new Set(Object.entries([default_excludes].concat(['files.exclude', 'search.exclude', 'files.watcherExclude', 'search++.watcherExclude']
			.map(c => vscode.workspace.getConfiguration().get(c) || {}))
			.reduce((all, c) => Object.assign(all, c), {}))
			.filter(c => c[1])
			.map(c => c[0]))]
	}
	update_exclude_patterns()
	log_debug('exclude_patterns', exclude_patterns)

	// TODO uncaught exception/prmoserejection handler?

	/**
	 * @typedef {object} IndexDoc
	 * @property {string} _id This is the file path
	 * @property {string} text
	 * @property {number} mtime
	 * @property {number} size
	 */

	/** This is the default value of search-index, but we need it for search also.
	It's a match not a split though, but keeping its official name */
	const index_token_split_regex = /[\p{L}\d]+/gu

	let index_docs = async (/** @type {IndexDoc[]} */ docs) => {
		// Index only _id+text
		await idx.PUT(docs
			.map(({ _id, text }) => ({ _id, text })), {
			storeRawDocs: false,
			tokenSplitRegex: index_token_split_regex,
		})
		// ...but store only _id+mtime
		await idx.PUT_RAW(docs
			// @ts-ignore wrong types (search-index#620)
			.map(({ _id, mtime }) => ({ _id, mtime })), docs.map(d => d._id), false)
	}

	/** @type {Map<string, IndexDoc>} */
	let index_queue = new Map()
	let is_index_queue_running = false
	let run_index_queue = async () => {
		if (is_index_queue_running)
			throw new Error('duplicate index queue')
		is_index_queue_running = true
		let queue_size = index_queue.size
		log_debug('run index queue with ' + queue_size + ' entries...')
		let start = Date.now()
		tree_view.title = 'Indexing...' // + uri.path
		/** @type {IndexDoc[]} */
		let docs_batch = [] // TODO no implcit any
		let docs_batch_bytes_threshold = 5 * 1024 * 1024 // s2 tests: 1 KB 93 sec, 1 MB 43 sec, 5 MB 30 sec, 10 MB 30 sec
		let docs_batch_bytes_read = 0
		let flush_docs_batch = async () => {
			log_debug(`batch-index ${docs_batch.length} docs`)
			await index_docs(docs_batch)
			docs_batch_bytes_read = 0
			docs_batch = []
		}
		let uri_i = -1
		for (let [path, doc] of index_queue.entries()) {
			index_queue.delete(path)
			uri_i++
			log_debug(`indexing (${uri_i + 1}/${queue_size}) ${path}`)
			if (uri_i % 100 === 0)
				status_bar_item_command.text = `$(search-fuzzy) 2/2 Indexing ${Math.round(uri_i / queue_size * 100)}%`
			// await sleep(1000)
			let file_buf
			try {
				file_buf = await readFile(vscode.Uri.file(doc._id).fsPath)
			} catch (e) {
				if (e.code !== 'EACCES')
					// TODO check logs size and when expiring
					log_error(`Indexing: Failed to read file '${path}': ${JSON.stringify(e)}`)
				continue
			}
			if (await isBinary(null, file_buf)) { // check buffer contents
				log_debug('skipping: is binary (buf)')
				continue
			}
			docs_batch.push({ ...doc, text: file_buf.toString() })
			docs_batch_bytes_read += file_buf.length
			if (docs_batch_bytes_read > docs_batch_bytes_threshold)
				await flush_docs_batch()
		}
		await flush_docs_batch()
		tree_view.title = 'Indexing complete'
		status_bar_item_command.text = ''
		log_debug('run index queue complete')
		log_debug(`indexing took ${(Date.now() - start) / 1000} seconds`)
		is_index_queue_running = false
	}

	let is_indexable = async (/** @type IndexDoc */ doc) => {
		// await sleep(1000)
		// vscode.Uri.file(doc._id).fsPath
		if (await isBinary(doc._id)) // check only file extension
			// log_debug('skipping: is binary (ext)', doc._id)
			return false

		if (doc.size === 0)
			// log_debug('skipping: file is empty', doc._id)
			return false

		if (doc.size > 1024 * 1024) // TODO configure
			// log_debug('skipping: is too big', doc._id)
			return false

		return true
	}

	let uri_to_doc = async (/** @type vscode.Uri */ uri) => {
		let file_stat = await stat(uri.fsPath)
		return { _id: uri.path, text: '', size: file_stat.size, mtime: Math.round(file_stat.mtimeMs / 1000) }
	}

	let find_files = async (/** @type string */glob, /** @type string[] */ excludes) => {
		log_debug('findFiles...')
		// https://github.com/microsoft/vscode/issues/48674
		// TODO cancellationtoken
		// "search.useIgnoreFiles": true, // what if false TODO
		let files = []
		try {
			files = await vscode.workspace.findFiles2(glob, {
				exclude: `{${excludes.join(',')}}`,
				useIgnoreFiles: true,
				useDefaultExcludes: true,
				useDefaultSearchExcludes: true,
				useGlobalIgnoreFiles: true,
				useParentIgnoreFiles: true,
			})
		} catch (e) {
			if (! e.message.includes('enabledApiProposals'))
				throw e
			files = (await Promise.all(vscode.workspace.workspaceFolders?.map(async (folder) => {
				let gitignores = await vscode.workspace.findFiles(
					new vscode.RelativePattern(folder.uri, '**/.{gitignore,ignore,rignore}'),
					`{${excludes.join(',')}}`)
				let git_excludes = (await Promise.all(gitignores.map(gitignore => {
					let path_to_gitignore_dir = path.relative(folder.uri.path, path.dirname(gitignore.path))
					return readFile(gitignore.fsPath, 'utf-8').then(fc => fc
						.split(/\r?\n/)
						.filter(line => line && ! line.startsWith('#'))
					// Largely transforming .gitignore syntax into VSCode glob syntax. Main difference:
					// git treats everything recursive by default unless a slash is present, vscode fancies more **s.
					// https://git-scm.com/docs/gitignore#_pattern_format
						.map(line => {
							if (line.indexOf('/') === -1 || line.indexOf('/') === line.length - 1) {
								if (! line.startsWith('**/'))
									line = '**/' + line
							} else if (line.startsWith('/'))
								line = line.slice(1)
							return [
								path.join(path_to_gitignore_dir, line),
								// in vscode files.excludeFiles *settings* syntax, `xy/**` matches xy itself even if it's a *file*. But this seems to NOT be the case in this glob argument here. So lets just add both patterns
								path.join(path_to_gitignore_dir, line, '/**'),
							]
						}))
				}))).flat().flat()
				log_debug('gitignore exclude patterns for folder', folder.uri.path, git_excludes)
				if (git_excludes.length > 1000) {
					// E2BIG errors and extreme performance problems occur with MANY exclude lines.
					// Applying them manually here in JS afterwards was even worse performance-wise: chromium (400k files, 3k excludes) would have taken about 6 hours with nanoglob or microglob (the "fastest" glob matcher), and 1-2 hours with miniglob (node's default "slow" one).
					// It seems the sanest thing to do here is skip too many of them (1k was kinda ok) and recommend findFiles2
					log_error(`Warning: ${git_excludes.length - 1000} out of your ${git_excludes.length} .gitignores' exclude patterns in your workspace will be ignored while scanning. Unneccessary indexing may ensue. Also the scanning process after each reload may take a long time. To fix these issues, you need to use VSCode insiders and enable apiProposals so this extension can use the new findFiles2 API. See the extension's Readme for details. This problem will probably resolve itself with an upcoming VSCode update some day.`) // TODO readme
					git_excludes = git_excludes.slice(0, 1000)
				}
				let all_excludes = [...new Set(excludes.concat(git_excludes))]
				return vscode.workspace.findFiles(
					new vscode.RelativePattern(folder.uri, '**'),
					`{${all_excludes.join(',')}}`)
			}) || []))
				.flat()
		}
		log_debug(`found ${files.length} non-excluded files in workspace`)
		return files
	}

	let is_refreshing = false
	let refresh = async () => {
		if (is_refreshing)
			throw new Error('duplicate refresh. please report this error with reproduction steps')
		is_refreshing = true
		log_debug('refreshing...')
		tree_view.title = 'Refreshing...'
		status_bar_item_command.text = '$(search-fuzzy) Scanning'
		let new_files = await find_files('**', exclude_patterns)
		await sleep(10000)
		log_debug('stat files...')
		let new_docs = await Promise.all(new_files
			// TODO in chunks, not all at the same time (?)
			.map(uri_to_doc))

		log_debug('comparing with stored...')
		// TODO: how bad cpu-wise for huge repos?
		let old_docs = await idx.ALL_DOCUMENTS()

		// TODO: how bad ram-wise for huge repos?
		let old_mtime_by_path = old_docs.reduce((/** @type {Record<string,number>} */ all, doc) => {
			all[doc._id] = doc._doc.mtime
			return all
		}, {})

		// TODO: this always includes binary file ext files because they just get filtered out in the
		// next step. could reduce unnecessary stat()s and handling here by moving the isBinary ext
		// logic from is_indexable into the findFiles exclude patterns above (watchFiles?)
		let new_docs_need_indexing = new_docs.filter(doc =>
			old_mtime_by_path[doc._id] !== doc.mtime)
		for (let doc of new_docs_need_indexing)
			if (await is_indexable(doc))
				index_queue.set(doc._id, doc)

		// TODO: perf
		let new_docs_paths = new Set(new_docs.map(d => d._id))
		let old_docs_need_deletion = old_docs.filter(doc =>
			! new_docs_paths.has(doc._id.toString()),
		).map(d => d._id.toString())
		log_debug('deleting docs no longer present', old_docs_need_deletion)
		await idx.DELETE(...old_docs_need_deletion)

		status_bar_item_command.text = ''
		tree_view.title = 'Refreshing complete'
		log_debug('refreshing complete')
		is_refreshing = false
		run_index_queue()
	}

	/** @type {import('./vscode.git').Repository[]} */
	let git_repos_cache = []
	let git_folders_changed = () => {
		log_debug('git_folders_changed', git_api.state)
		if (git_api.state !== 'initialized')
			return
		// onDidOpenRepository fires multiple times. At first, there isn't even a repos change
		if (git_api.repositories.length === git_repos_cache.length || git_api.repositories.length === 0)
			return
		git_repos_cache = git_api.repositories.slice()
		debounce(() => {
			log_debug('workspace: repo(s) added/removed. n folders:', git_repos_cache.length)
			refresh()
		}, 1000) // <- TODO
	}
	git_api.onDidOpenRepository(git_folders_changed)
	git_api.onDidCloseRepository(git_folders_changed)
	git_api.onDidChangeState(state => {
		if (state === 'initialized')
			git_folders_changed()
	})
	git_folders_changed()

	let watcher = vscode.workspace.createFileSystemWatcher('**')
	let file_changed = async (/** @type vscode.Uri */ uri) => {
		log_debug('file changed', uri.fsPath)
		// TODO here if file is a gitignore, run refresh
		// files.watcherExclude files should actually never arrive here, but for the other three settings,
		// an additional filtering here is required:
		// TODO: this doesnt check the gitignores. saving/caching those is difficult because folder-based which can themselves change etc
		if (isMatch(uri.path, exclude_patterns)) { // TODO test
			log_debug('but is excluded')
			return false
		}
		let doc = await uri_to_doc(uri)
		if (! await is_indexable(doc))
			return
		index_queue.set(doc._id, doc)
		debounce(() => {
			if (! is_refreshing && ! is_index_queue_running)
				run_index_queue()
		}, 1000)
	}
	watcher.onDidChange(file_changed)
	watcher.onDidCreate(file_changed)
	watcher.onDidDelete(async (uri) => {
		log_debug('delete doc onDidDelete', uri.path)
		await idx.DELETE(uri.path)
	})

	// global_state = (###* @type string ### key) =>
	// 	get: => context.globalState.get(key)
	// 	set: (###* @type any ### v) => context.globalState.update(key, v)
	// workspace_state = (###* @type string ### key) =>
	// 	get: => context.workspaceState.get(key)
	// 	set: (###* @type any ### v) => context.workspaceState.update(key, v)
	vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(EXT_ID))
			// TODO
			return debounce(() => {}, 500)
	})
	context.subscriptions.push(vscode.commands.registerCommand('search++.search', async () => {
		log_debug('user initiated search')
		let search_term = await vscode.window.showInputBox({
			title: 'Search++',
			prompt: 'Input search term',
		})
		if (! search_term)
			return
		// TODO option thingy t b able to delete docs again
		log_debug('searching for', search_term)
		let start = Date.now()
		// TODO: query first for non-dict results, then add where not already present
		// It appears there is no single "find where starts with" operation, and also no
		// "match by sentence", but we can split this into two operations (disregarding word order):
		// TODO: how to limit the first??? only via min length?
		let word_dicts = await Promise.all((search_term
			.match(index_token_split_regex) || []) // TODO docu
			.filter(word => word.length >= 3) // TODO docu
			.map(word => idx.DICTIONARY({
				FIELD: 'text', VALUE: word.toLowerCase(),
			})))
		let docs = await idx.QUERY({
			AND: word_dicts.map(dict => ({
				OR: dict
					.map(d => ({ FIELD: 'text', VALUE: d })),
			})),
		}, {
			// return mtime too
			// DOCUMENTS: true,
			// PAGE: {} // TODO
		})
		// DOCUMENT_VECTORS // TODO
		log_debug('search results', docs, `search time: ${(Date.now() - start) / 1000} seconds`)
		let match_paths = docs.RESULT.map(x => x._id)
		tree_view.title = 'Search result: \n' + match_paths.join('\n')
	}))

	// Side nav view setup
	let tree_view = vscode.window.createTreeView(EXT_ID, {
		treeDataProvider: {
			getTreeItem: _ => _,
			getChildren: () => [],
		},
	})
	context.subscriptions.push(tree_view)

	// webview_container = view
	// populate_webview()
	// }, { webviewOptions: retainContextWhenHidden: true }
	let status_bar_item_command = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
	// status_bar_item_command.command = START_CMD
	context.subscriptions.push(status_bar_item_command)
	status_bar_item_command.tooltip = 'Search++ extension'
	return status_bar_item_command.show()
}

// public api of this extension:
// { git, post_message, webview_container, context, state }
module.exports.deactivate = () => log_debug('extension deactivate')
