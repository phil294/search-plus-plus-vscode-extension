let vscode = require('vscode')
let { debounce } = require('./util')
const { isMatch } = require('micromatch')
const { stat } = require('fs/promises')
const { log_debug, log_info, log_error, log_warn, set_verbose } = require('./log')
const { IndexerClient } = require('./indexer-client')
const { EXT_ID, word_split_regex } = require('./global')
const { find_files, find_indexed_paths } = require('./find-files')
const { show_file_picker } = require('./file-picker')
const { load_icon_mapping, icon_file_name } = require('./file-icons')
const { RecencyStore } = require('./recency')
const { readFileSync } = require('fs')

/** @typedef {import('./indexer').IndexDoc} IndexDoc */
/** @typedef {import('./indexer').FileMeta} FileMeta */

process.on('unhandledRejection', (/** @type any */ err) => {
	// Process-global: VS Code runs all extensions in one host, so this also catches rejections from
	// other extensions (e.g. the built-in Git extension's IsInSubmodule errors). Those never touch our
	// worker-thread indexing, so only surface rejections whose stack points at our own code.
	if (typeof err?.stack !== 'string' || ! err.stack.includes(__dirname))
		return log_debug('ignoring unrelated unhandledRejection', err?.gitErrorCode || err?.message || err)
	log_error('unhandledRejection-handler', err)
	log_error(err.message || JSON.stringify(err))
})

module.exports.activate = async (/** @type vscode.ExtensionContext */context) => {
	log_debug('extension activate')
	load_icon_mapping(context.extensionUri)
	if (! vscode.workspace.workspaceFolders || ! context.storageUri) {
		log_debug('no folder opened, aborting')
		// No workspace present. Once the user switches, all extension
		// will be restarted automatically, so we can simply abort here TODO: verify
		return
	}

	let initial_verbose = !! vscode.workspace.getConfiguration().get('search++.verboseLogging')
	set_verbose(initial_verbose)

	// Index-shaping settings read on the host and forwarded to the worker (at spawn + on change).
	let get_index_params = () => {
		let cfg = vscode.workspace.getConfiguration()
		return {
			max_index_size: Number(cfg.get('search++.maxIndexSizeMb') ?? 20) * 1024 * 1024,
			max_avg_line_length: Number(cfg.get('search++.maxAverageLineLength') ?? 300),
		}
	}

	let indexer_client = new IndexerClient(context, {
		storage_path: context.storageUri.fsPath,
		verbose: initial_verbose,
		index_params: get_index_params(),
		on_progress: (/** @type number? */ p) => on_index_queue_progress(p),
	})
	context.subscriptions.push({ dispose: () => indexer_client.dispose() })

	let recency = new RecencyStore(context.globalState)
	let remember_open = (/** @type vscode.TextEditor | undefined */ editor) => {
		if (editor?.document.uri.scheme === 'file')
			recency.touch(editor.document.uri.path)
	}
	remember_open(vscode.window.activeTextEditor)
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(remember_open))

	let update_verbose = () => {
		let verbose = !! vscode.workspace.getConfiguration().get('search++.verboseLogging')
		set_verbose(verbose)
		indexer_client.set_verbose(verbose).catch((/** @type any */ e) => log_error('set_verbose failed', e))
	}

	// order matters: right overwrites left. search.exclude wins over files.watcherExclude so a file
	// explicitly un-excluded there (e.g. `**/vendor/**: false`) is still indexed even if the watcher
	// ignores it; search++.watcherExclude stays the final override.
	const exclude_config_keys = ['files.watcherExclude', 'files.exclude', 'search.exclude', 'search++.watcherExclude']

	/** gitignored patterns are not part of this */
	let get_exclude_patterns = () => {
		/** @type {Record<string,boolean>} */
		let default_excludes = {
			// default values for search, files and files watcher exclude, not present in the queried config objs below (TODO: or are they?)
			'**/.DS_Store': true, '**/.git': true, '**/.git/objects/**': true, '**/.git/subtree-cache/**': true, '**/.hg': true, '**/.hg/store/**': true, '**/.svn': true, '**/*.code-search': true, '**/bower_components': true, '**/CVS': true, '**/node_modules': true, '**/node_modules/*/**': true, '**/Thumbs.db': true,
			// custom stuff which we'll never care for
			'**/.git/**': true,
		}
		return [...new Set(Object.entries(
			[default_excludes]
				.concat(
					// settings in the wrong format are silently ignored by Object.assign below
					exclude_config_keys.map(c => vscode.workspace.getConfiguration().get(c) || {}))
				.reduce((all, c) => Object.assign(all, c), {}))
			.filter(c => c[1])
			.map(c => c[0]))]
	}

	let uri_to_file_meta = async (/** @type vscode.Uri */ uri, /** @type boolean */ index_content = true) => {
		let file_stat = await stat(uri.fsPath)
		// TODO: eslint comment not required?
		return /** @type FileMeta */ ({ // eslint-disable-line no-extra-parens
			path: uri.path,
			size: file_stat.size,
			mtime: Math.round(file_stat.mtimeMs / 1000),
			index_content,
		})
	}

	const gitignore_filenames = ['.gitignore', '.rignore', '.ignore']

	// Paths that are gitignored: shown in the file picker but recorded name-only, so the incremental
	// watcher never content-indexes them. Both refreshed on every full scan, and extended lazily on the
	// watcher path when previously-unseen files show up.
	/** @type {Set<string>} */
	let indexed_paths = new Set()
	/** @type {Set<string>} */
	let name_only_paths = new Set()

	let on_index_queue_progress = (/** @type number? */ p) =>
		status_bar_item_command.text = p == null ? '' : `$(search-fuzzy) 2/2 Indexing ${Math.round(p * 100)}%`

	let is_scanning = false
	let scan = async () => {
		if (is_scanning)
			return log_warn('duplicate scan')
		is_scanning = true
		let start = Date.now()
		log_debug('scanning...')
		status_bar_item_command.text = '$(search-fuzzy) 1/2 Scanning'
		let exclude_patterns = get_exclude_patterns()
		log_debug('exclude_patterns', exclude_patterns)
		let new_files
		try {
			new_files = await find_files({ excludes: exclude_patterns })
		} catch (e) {
			is_scanning = false
			status_bar_item_command.text = ''
			return log_error('Scanning (ripgrep) failed: ' + (e.message || e))
		}
		log_debug('stat files...')
		name_only_paths = new Set(new_files.filter(f => ! f.index_content).map(f => f.uri.path))
		indexed_paths = new Set(new_files.filter(f => f.index_content).map(f => f.uri.path))
		let new_file_metas = (await Promise.all(new_files
			// TODO: this is the bottleneck for very large repos. how to speed up?
			// TODO in chunks, not all at the same time (?)
			.map(f => uri_to_file_meta(f.uri, f.index_content).catch(() => null)))) // file may vanish between listing and stat
			.filter((/** @type {FileMeta?} */ m) => !! m)

		status_bar_item_command.text = ''
		log_debug(`scanning took ${(Date.now() - start) / 1000} seconds`)
		is_scanning = false
		// The worker owns the index: it diffs the new file set against what's stored, (re)indexes
		// changed files and removes files that no longer exist.
		indexer_client.sync_files(/** @type {FileMeta[]} */ (new_file_metas)) // eslint-disable-line no-extra-parens
			.catch((/** @type any */ e) => log_error('sync_files failed', e))
	}
	let scan_debounced = () => debounce(scan, 2500)

	setTimeout(scan, 10)

	vscode.workspace.onDidChangeWorkspaceFolders(scan_debounced)

	let watcher = vscode.workspace.createFileSystemWatcher('**')
	// Diagnostic: indexing runs in a worker thread, so a frozen status bar/log means the extension-HOST
	// event loop is blocked, not the indexer. This heartbeat logs late ticks and attributes how many
	// `**`-watcher events (and how much isMatch/get_exclude_patterns time) landed in that window.
	let watcher_events = 0
	let file_changed_ms = 0
	let last_beat = Date.now()
	let heartbeat = setInterval(() => {
		let now = Date.now()
		let lag = now - last_beat - 1000
		last_beat = now
		if (lag > 1000)
			log_info(`host event-loop blocked ~${(lag / 1000).toFixed(1)}s | watcher_events=${watcher_events} isMatch=${file_changed_ms}ms in window`)
		watcher_events = 0
		file_changed_ms = 0
	}, 1000)
	context.subscriptions.push({ dispose: () => clearInterval(heartbeat) })
	/** @type {Map<string, vscode.Uri>} */
	let pending_changed = new Map()
	let flush_changed = async () => {
		let uris = [...pending_changed.values()]
		pending_changed.clear()
		if (! uris.length)
			return
		// Classify any paths not seen by the last scan (e.g. freshly created files) with a single
		// gitignore-honoured ripgrep listing, so gitignored files are never content-indexed.
		let unknown = uris.filter(u => ! indexed_paths.has(u.path) && ! name_only_paths.has(u.path))
		if (unknown.length)
			try {
				let indexed_now = await find_indexed_paths({ excludes: get_exclude_patterns() })
				for (let u of unknown)
					(indexed_now.has(u.path) ? indexed_paths : name_only_paths).add(u.path)
			} catch (e) {
				log_error('classifying changed files failed', e)
			}
		let metas = (await Promise.all(uris.map(u =>
			uri_to_file_meta(u, ! name_only_paths.has(u.path)).catch(() => null)))) // file may vanish between event and stat
			.filter((/** @type {FileMeta?} */ m) => !! m)
		if (metas.length)
			indexer_client.index_files(/** @type {FileMeta[]} */ (metas)) // eslint-disable-line no-extra-parens
				.then(() => rerun_search_live())
				.catch((/** @type any */ e) => log_error('index_files failed', e))
	}
	let file_changed = async (/** @type vscode.Uri */ uri) => {
		watcher_events++
		log_debug('file changed', uri.fsPath)
		if (gitignore_filenames.some(i => uri.path.endsWith('/' + i)))
			return scan_debounced()
		// files.watcherExclude files should actually never arrive here, but for the other three settings,
		// an additional filtering here is required:
		let t = Date.now()
		let excluded = isMatch(uri.path, get_exclude_patterns())
		file_changed_ms += Date.now() - t
		if (excluded) { // TODO test
			log_debug('but is excluded')
			return false
		}
		pending_changed.set(uri.path, uri)
		debounce(flush_changed, 1000)
	}
	watcher.onDidChange(file_changed)
	watcher.onDidCreate(file_changed)
	watcher.onDidDelete(async (uri) => {
		log_debug('delete doc onDidDelete', uri.path)
		indexed_paths.delete(uri.path)
		name_only_paths.delete(uri.path)
		await indexer_client.delete_paths([uri.path])
		rerun_search_live()
		if (gitignore_filenames.some(i => uri.path.endsWith('/' + i)))
			scan_debounced()
	})

	vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('search++.verboseLogging'))
			update_verbose()
		if (event.affectsConfiguration('search++.maxIndexSizeMb') ||
			event.affectsConfiguration('search++.maxAverageLineLength'))
			// applied to newly added/changed files only; existing files keep their current state until a
			// manual rebuild (wiping a huge index on every tweak would be far too expensive).
			indexer_client.set_index_params(get_index_params())
				.catch((/** @type any */ e) => log_error('set_index_params failed', e))
		if (exclude_config_keys.some(f => event.affectsConfiguration(f)) ||
			event.affectsConfiguration('search.useIgnoreFiles') ||
			event.affectsConfiguration('search.useGlobalIgnoreFiles') ||
			event.affectsConfiguration('search++.useIgnoreFiles') ||
			event.affectsConfiguration('search++.useGlobalIgnoreFiles'))
			return scan_debounced()
	})

	/** @type {vscode.WebviewView | null} */
	let webview = null
	/** @type {{query:string, include?:string, exclude?:string}|null} */
	let last_search = null
	// Runs the current search and posts the outcome. `type` is 'results' for a fresh search (webview
	// replaces its list) or 'results_live' for an in-place update after the index changed.
	let run_search = async (/** @type {{query:string, include?:string, exclude?:string}} */ params, /** @type {'results'|'results_live'} */ type) => {
		let folders = vscode.workspace.workspaceFolders || []
		let workspace_folders = folders.map(folder => ({ name: folder.name, path: folder.uri.path }))
		let filter = {
			include: parse_patterns(params.include),
			exclude: parse_patterns(params.exclude),
			roots: folders.map(f => f.uri.path),
		}
		let found = await indexer_client.find_paths_with_lines_by_word(params.query, true, 1000, filter) // TODO configurable. shouldn't be too large though as this runs at ~30 Hz
		webview?.webview.postMessage({
			type,
			...found,
			results: found.results.map(r => ({ ...r, icon: icon_file_name(r.path) })),
			workspace_folders,
		})
	}
	// After the index changes, refresh the visible results in place (only when the panel is visible and
	// there is an active query) so stale matches disappear without the user re-searching.
	let rerun_search_live = () => {
		if (webview?.visible && last_search?.query?.trim())
			run_search(last_search, 'results_live').catch((/** @type any */ e) => log_error('live re-search failed', e))
	}
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(EXT_ID, {
		resolveWebviewView(/** @type {vscode.WebviewView} */ webview_view) {
			webview = webview_view
			webview_view.webview.options = {
				enableScripts: true,
				localResourceRoots: [
					context.extensionUri,
					vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
				],
			}
			webview_view.webview.html = readFileSync(context.asAbsolutePath('./src/webview.html'), 'utf-8')
				.replace('<base href="{BASE_URL}" />', `<base href="${webview.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, '/'))}" />`)

			webview_view.webview.onDidReceiveMessage(async (message) => {
				if (message.type === 'search') {
					last_search = { query: message.query, include: message.include, exclude: message.exclude }
					if (! message.query?.trim())
						return webview?.webview.postMessage({ type: 'results', results: [], workspace_folders: [] })
					await run_search(last_search, 'results')
				} else if (message.type === 'has_results')
					vscode.commands.executeCommand('setContext', 'search++.hasResults', !! message.value)
				else if (message.type === 'open_file') {
					let uri = vscode.Uri.file(message.path)
					let doc = await vscode.window.showTextDocument(uri)
					if (! message.line_number)
						return
					let line = message.line_number - 1
					// TODO: col
					let range = new vscode.Range(line, 0, line, 0)
					// TODO: this doesn't work
					doc.selection = new vscode.Selection(range.start, range.end)
					doc.revealRange(range, vscode.TextEditorRevealType.InCenter)
				}
			})
		},
	}))

	let status_bar_item_command = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
	// status_bar_item_command.command = START_CMD
	context.subscriptions.push(status_bar_item_command)
	status_bar_item_command.tooltip = 'Search++ extension'
	status_bar_item_command.show()

	// this pattern always shows the results but with a lower specificity than language-based providers,
	// so they tend to show up lower than others. however with partial matches (while typing), there is a
	// much higher chance of showing up at the top which is not ideal. This might be unavoidable because
	// this very extension provides just *so many* results regardless of what you type.
	// Tried several other patterns / args, this is the best I could come up with.
	context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ pattern: '**' }, {
		async provideCompletionItems(doc, pos) {
			let word = (doc.getText(doc.getWordRangeAtPosition(pos)).match(word_split_regex) || [])[0]
			log_debug('provideCompletionItems', word)
			if (! word) // || word.length < min_word_length)
				return
			let dict = await indexer_client.autocomplete_word(word, 2000) // TODO configurable
			log_debug(`${dict.length} results`)
			return dict.map((d) => {
				let item = new vscode.CompletionItem(String(d), vscode.CompletionItemKind.Text)
				item.detail = 'Search++'
				// item.sortText = 'zzz' + String(i).padStart(5, '0')
				item.filterText = String(d)
				return item
			})
		},
		async resolveCompletionItem(item) {
			let word = typeof item.label === 'string' ? item.label : item.label.label
			let limit = 250
			let paths = await indexer_client.find_paths_by_word(word, limit) // TODO configurable
			if (paths.length > 0) {
				item.detail = `Search++ (found in ${paths.length} file${paths.length === 1 ? '' : 's'}${paths.length === limit ? ' (or more)' : ''})`

				let workspace_folders = vscode.workspace.workspaceFolders || []
				let relative_paths = paths.map(path => {
					// find the workspace folder this file belongs to
					let workspace_folder = null
					let longest_match = 0
					for (const folder of workspace_folders)
						if (path.startsWith(folder.uri.path + '/') && folder.uri.path.length > longest_match) {
							workspace_folder = folder
							longest_match = folder.uri.path.length
						}

					if (! workspace_folder)
						// fallback to absolute path
						return path

					let relative_path = path.substring(workspace_folder.uri.path.length + 1)
					let parts = relative_path.split('/')
					let filename = parts.pop()
					let dir_path = parts.join('/')

					return dir_path ? `${filename} • ${workspace_folder.name}/${dir_path}` : `${filename} • ${workspace_folder.name}`
				})

				item.documentation = new vscode.MarkdownString(`Found in:\n\`\`\`\n${relative_paths.join('\n')}\n\`\`\``)
			}
			return item
		},
	}))
	let skip_definition_lookup = new Set()
	// The ** matcher is very greedy and it seems to not be possible to lower its specificity, even with long delays,
	// so VSCode would always wait for us and merge our often useless results with the precise results of advanced
	// lsp providers. Therefore this definition lookup has a sub-lookup for the very same doc/pos inside (does VSCode
	// cache this? or does this slow things down a lot?) to see if there are other providers present, and if so,
	// skips providing any results. This seems to be the only way to be an actual fallback definition provider (?).
	// https://stackoverflow.com/q/79807244/
	context.subscriptions.push(vscode.languages.registerDefinitionProvider({ pattern: '**' }, {
		async provideDefinition(doc, pos) {
			let word = (doc.getText(doc.getWordRangeAtPosition(pos)).match(word_split_regex) || [])[0]
			if (! word) // || word.length < min_word_length)
				return
			let definition_hash = doc.uri.toString() + ':' + pos.line + ':' + pos.character
			if (skip_definition_lookup.has(definition_hash))
				// avoid infinite loop
				return void skip_definition_lookup.delete(definition_hash)
			skip_definition_lookup.add(definition_hash)
			let has_other_providers = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, pos)
			if (/** @type {any} */ (has_other_providers)?.length) // eslint-disable-line no-extra-parens
				return
			log_debug('provideDefinition', word)
			let results = await indexer_client.find_paths_with_lines_by_word(word, false, 250)
			return results.results.map(result => {
				let uri = vscode.Uri.file(result.path)
				return result.matches.map(({ line_number }) =>
					new vscode.Location(uri, new vscode.Position(line_number - 1, 0)),
				)
			}).flat()
		},
	}))

	context.subscriptions.push(
		vscode.commands.registerCommand('search++.search', async () => {
			// reveal & focus the Search++ view, then focus its input box
			await vscode.commands.executeCommand('search++.focus').then(undefined, () => {})
			webview?.webview.postMessage({ type: 'focus_search' })
		}),
		vscode.commands.registerCommand('search++.filePicker', () =>
			show_file_picker(indexer_client, { mode: 'file', recency, extension_uri: context.extensionUri })),
		vscode.commands.registerCommand('search++.goToTextInFile', () =>
			show_file_picker(indexer_client, { mode: 'text_in_file', recency, extension_uri: context.extensionUri })),
		vscode.commands.registerCommand('search++.goToTextInWorkspace', () =>
			show_file_picker(indexer_client, { mode: 'text_in_workspace', recency, extension_uri: context.extensionUri })),
		vscode.commands.registerCommand('search++.focusNextResult', () =>
			webview?.webview.postMessage({ type: 'nav', direction: 'next' })),
		vscode.commands.registerCommand('search++.focusPreviousResult', () =>
			webview?.webview.postMessage({ type: 'nav', direction: 'prev' })),
		vscode.commands.registerCommand('search++.rebuildIndex', async () => {
			await indexer_client.clear_index()
			vscode.window.showInformationMessage('Search++: rebuilding the index…')
			scan()
		}),
	)

	update_verbose()

	// public api of this extension:
	return { scan, file_changed, context }
}

/** Splits a comma-separated "files to include/exclude" input into individual glob tokens. */
function parse_patterns(/** @type {string|undefined} */ input) {
	return (input || '').split(',').map(s => s.trim()).filter(Boolean)
}

module.exports.deactivate = () => log_debug('extension deactivate')
