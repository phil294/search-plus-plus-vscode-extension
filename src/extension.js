let vscode = require('vscode')
let { debounce } = require('./util')
const { isMatch } = require('micromatch')
const { stat } = require('fs/promises')
const { log_debug } = require('./log')
const { Indexer } = require('./indexer')
const { IndexQueue } = require('./index-queue')
const { EXT_ID } = require('./global')
const { find_files } = require('./find-files')
const { on_git_folders_changed } = require('./git')

/** @typedef {import('./indexer').IndexDoc} IndexDoc */
/** @typedef {import('./indexer').FileMeta} FileMeta */

/** This is the default value of search-index plus underscore. We need it for search also. */
const word_split_regex = /[\p{L}\d_]+/gu

/** Too small and performance becomes a real problem */
const min_word_length = 3

module.exports.activate = async (/** @type vscode.ExtensionContext */context) => {
	log_debug('extension activate')
	if (! vscode.workspace.workspaceFolders || ! context.storageUri) {
		log_debug('no folder opened, aborting')
		// No workspace present. Once the user switches, all extension
		// will be restarted automatically, so we can simply abort here TODO: verify
		return
	}

	let indexer = new Indexer({ storage_uri: context.storageUri, word_split_regex })
	let index_queue = new IndexQueue(indexer)

	// order matters: right overwrites left
	const exclude_config_keys = ['files.exclude', 'search.exclude', 'files.watcherExclude', 'search++.watcherExclude']

	/** gitignored patterns aren't determined here but only inside find-files */
	let get_exclude_patterns = () => {
		/** @type {Record<string,boolean>} */
		let default_excludes = {
			// default values for search, files and files watcher exclude, not present in the queried config objs below (TODO: or are they?)
			'**/.DS_Store': true, '**/.git': true, '**/.git/objects/**': true, '**/.git/subtree-cache/**': true, '**/.hg': true, '**/.hg/store/**': true, '**/.svn': true, '**/*.code-search': true, '**/bower_components': true, '**/CVS': true, '**/node_modules': true, '**/node_modules/*/**': true, '**/Thumbs.db': true,
			// custom stuff which we'll never care for
			'**/.git/**': true,
		}
		// TODO: works to overwrite file excludes with search++ setting?
		return [...new Set(Object.entries(
			[default_excludes]
				.concat(
					exclude_config_keys.map(c => vscode.workspace.getConfiguration().get(c) || {}))
				.reduce((all, c) => Object.assign(all, c), {}))
			.filter(c => c[1])
			.map(c => c[0]))]
	}

	// TODO uncaught exception/promise rejection handler?

	let uri_to_file_meta = async (/** @type vscode.Uri */ uri) => {
		let file_stat = await stat(uri.fsPath)
		// TODO: eslint comment not required?
		return /** @type FileMeta */ ({ // eslint-disable-line no-extra-parens
			path: uri.path,
			size: file_stat.size,
			mtime: Math.round(file_stat.mtimeMs / 1000),
		})
	}

	const gitignore_filenames = ['.gitignore', '.rignore', '.ignore']

	let on_index_queue_progress = (/** @type number? */ p) =>
		status_bar_item_command.text = p == null ? '' : `$(search-fuzzy) 2/2 Indexing ${Math.round(p * 100)}%`

	let is_scanning = false
	let scan = async () => {
		if (is_scanning)
			throw new Error('duplicate scan. please report this error with reproduction steps') // TODO
		is_scanning = true
		log_debug('scanning...')
		status_bar_item_command.text = '$(search-fuzzy) Scanning'
		let exclude_patterns = get_exclude_patterns()
		log_debug('exclude_patterns', exclude_patterns)
		let new_files = await find_files('**', { excludes: exclude_patterns, gitignore_filenames })
		log_debug('stat files...')
		let new_file_metas = await Promise.all(new_files
			// TODO in chunks, not all at the same time (?)
			.map(uri_to_file_meta))

		log_debug('comparing with stored...')
		// TODO: how bad cpu-wise for huge repos?
		let old_meta_docs = await indexer.all_meta_docs()
		// TODO: how bad cpu-wise for huge repos?
		let old_mtime_by_path = old_meta_docs.reduce((/** @type {Record<string,number>} */ all, doc) => {
			all[doc._id] = doc.mtime
			return all
		}, {})

		// TODO: this always includes binary file ext files because they just get filtered out in the
		// next step. could reduce unnecessary stat()s and handling here by moving the isBinary ext
		// logic from is_indexable into the findFiles exclude patterns above (watchFiles?)
		let new_docs_need_indexing = new_file_metas.filter(new_file_meta =>
			old_mtime_by_path[new_file_meta.path] !== new_file_meta.mtime)
		for (let doc of new_docs_need_indexing)
			if (await indexer.is_indexable(doc))
				index_queue.add(doc)

		// TODO: perf
		let new_docs_paths = new Set(new_file_metas.map(d => d.path))
		let old_paths_need_deletion = old_meta_docs.filter(doc_meta =>
			! new_docs_paths.has(doc_meta._id.toString()),
		).map(d => d._id.toString())
		log_debug('deleting docs no longer present', old_paths_need_deletion)
		await indexer.delete_doc_by_path(...old_paths_need_deletion)

		status_bar_item_command.text = ''
		log_debug('scanning complete')
		is_scanning = false
		index_queue.run({ on_progress: on_index_queue_progress })
	}

	on_git_folders_changed(scan)

	let watcher = vscode.workspace.createFileSystemWatcher('**')
	let file_changed = async (/** @type vscode.Uri */ uri) => {
		log_debug('file changed', uri.fsPath)
		if (gitignore_filenames.some(i => uri.path.endsWith('/' + i)))
			return scan()
		// files.watcherExclude files should actually never arrive here, but for the other three settings,
		// an additional filtering here is required:
		// TODO: this doesn't check the gitignores. saving/caching those is difficult because folder-based which can themselves change etc
		if (isMatch(uri.path, get_exclude_patterns())) { // TODO test
			log_debug('but is excluded')
			return false
		}
		let file_meta = await uri_to_file_meta(uri)
		if (! await indexer.is_indexable(file_meta))
			return
		index_queue.add(file_meta)
		debounce(() => {
			if (! is_scanning && ! index_queue.is_running)
				// TODO: eslint spacing
				index_queue.run({ on_progress: on_index_queue_progress })
		}, 1000)
	}
	watcher.onDidChange(file_changed)
	watcher.onDidCreate(file_changed)
	watcher.onDidDelete(async (uri) => {
		log_debug('delete doc onDidDelete', uri.path)
		await indexer.delete_doc_by_path(uri.path)
		if (gitignore_filenames.some(i => uri.path.endsWith('/' + i)))
			scan()
	})

	vscode.workspace.onDidChangeConfiguration((event) => {
		if (exclude_config_keys.some(f => event.affectsConfiguration(f)))
			return scan()
	})
	context.subscriptions.push(vscode.commands.registerCommand('search++.search', async () => {
		log_debug('user initiated search')
		let search_term = await vscode.window.showInputBox({
			title: 'Search++',
			prompt: 'Input search term',
		})
		if (! search_term)
			return

		let words = (search_term
			.match(word_split_regex) || []) // TODO docs
			.filter(word => word.length >= min_word_length) // TODO docs
		if (! words.length)
			return
		let paths = indexer.find_paths_by_multiple_partial_words(words)
		log_debug('search result', paths)
	}))

	// Side nav view setup
	let tree_view = vscode.window.createTreeView(EXT_ID, {
		treeDataProvider: {
			getTreeItem: _ => _,
			getChildren: () => [],
		},
	})
	context.subscriptions.push(tree_view)

	let status_bar_item_command = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
	// status_bar_item_command.command = START_CMD
	context.subscriptions.push(status_bar_item_command)
	status_bar_item_command.tooltip = 'Search++ extension'
	status_bar_item_command.show()

	context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ pattern: '**' }, {
		async provideCompletionItems(doc, pos) {
			let word = (doc.getText(doc.getWordRangeAtPosition(pos)).match(word_split_regex) || [])[0]
			log_debug('provideCompletionItems', word)
			if (! word || word.length < min_word_length)
				return
			let dict = (await indexer.autocomplete_word(word))
				.slice(0, 5000) // TODO configurable
			log_debug(`${dict.length} results`)
			// TODO: configurable overall case sensitivity (which needs full re-index, and rm toLowerCase usages)
			return dict.map(d => ({
				label: d,
				detail: 'Search++',
			}))
		},
	}))

	// public api of this extension:
	return { scan, file_changed, context }
}

module.exports.deactivate = () => log_debug('extension deactivate')
