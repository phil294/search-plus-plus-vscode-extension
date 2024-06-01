let vscode = require('vscode')
let path = require('path')
let search_index = require('search-index')
let { debounce } = require('./util')
let { ClassicLevel } = require('classic-level')
const { mkdirSync, existsSync } = require('fs')
const { isMatch } = require('micromatch')

const EXT_NAME = 'Search++'
const EXT_ID = 'search++'

eic()

// todo proper log with timestamps like e.g. git or extension host
let log = vscode.window.createOutputChannel(EXT_NAME)

module.exports.log = log

let log_error = (/** @type string */e) => {
	vscode.window.showErrorMessage('Search++: ' + e)
	return log.appendLine(`ERROR: ${e}`)
}
let log_debug = (/** @type any */s) => {
	// if(!config.debuggi) return TODO
	log.appendLine(`[debug] ${JSON.stringify(s)}`)
	vscode.window.showInformationMessage(`[debug] ${JSON.stringify(s)}`)
}

module.exports.activate = async (/** @type vscode.ExtensionContext */context) => {
	log_debug('extension activate')
	if (! vscode.workspace.workspaceFolders)
		// No workspace present. Once the user switches, all extension
		// will be restarted automatically, so don't have to listen to workspace changes. TODO: verify
		return
	if (! context.storageUri)
		throw `search++: missing storageUri for opened workspace with ${vscode.workspace.workspaceFolders.length} folders???`

	// vscode.workspace.onDidChangeWorkspaceFolders // TODO need to listen

	let index_path = path.join(context.storageUri.fsPath, 'index-db')
	if (! existsSync(index_path))
		mkdirSync(index_path, { recursive: true })
	log_debug('search index: ' + index_path)
	let idx = await search_index({
		db: /** @type {import('abstract-leveldown').AbstractLevelDOWNConstructor} */(/** @type unknown */
			(new ClassicLevel(index_path, { valueEncoding: 'json' }))), // eslint-disable-line no-extra-parens
		name: 'search++-index',
	})

	/** @type string[] */
	let exclude_patterns = []
	// order matters
	let update_exclude_patterns = () =>
		exclude_patterns = [...new Set(Object.entries(['files.exclude', 'search.exclude', 'files.watcherExclude', 'search++.watcherExclude']
			.map(c => vscode.workspace.getConfiguration().get(c))
			.reduce((all, c) => Object.assign(all, c)))
			.filter(c => c[1])
			.map(c => c[0]))]
	update_exclude_patterns()
	log_debug(exclude_patterns)

	let watcher = vscode.workspace.createFileSystemWatcher('**')
	let index_uri = (/** @type vscode.Uri */ uri) => {
		// files.watcherExclude files should actually never arrive here, but for the other three settings,
		// an additional filtering here is required
		if (isMatch(uri.path, exclude_patterns))
			return
		log_error('index: ' + uri)
	}
	watcher.onDidChange(index_uri)
	watcher.onDidCreate(index_uri)
	watcher.onDidDelete(uri => {
		log_error('delete index: ' + uri)
	})
	// await idx.PUT([{ path: 'banana', xyz: 'abc' }])
	let docs = await idx.QUERY('path:banana', { DOCUMENTS: true })
	log_debug(JSON.stringify(docs.RESULT))

	// global_state = (###* @type string ### key) =>
	// 	get: => context.globalState.get(key)
	// 	set: (###* @type any ### v) => context.globalState.update(key, v)
	// workspace_state = (###* @type string ### key) =>
	// 	get: => context.workspaceState.get(key)
	// 	set: (###* @type any ### v) => context.workspaceState.update(key, v)
	vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(EXT_ID))
			return debounce(() => {}, 500)
	})
	// context.subscriptions.push(vscode.commands.registerCommand(START_CMD, (args) => {}))
	// log_debug "start command"
	// webview_container?.show()

	// Side nav view setup
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(EXT_ID, {
		// Side nav view creation
		resolveWebviewView: (view) => log_debug('provide view'),
	}))
	// webview_container = view
	// populate_webview()
	// }, { webviewOptions: retainContextWhenHidden: true }
	status_bar_item_command = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
	// status_bar_item_command.command = START_CMD
	context.subscriptions.push(status_bar_item_command)
	status_bar_item_command.text = '$(git-branch) ???'
	status_bar_item_command.tooltip = '???'
	return status_bar_item_command.show()
}

// public api of this extension:
// { git, post_message, webview_container, context, state }
module.exports.deactivate = () => log_debug('extension deactivate')
