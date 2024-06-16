let vscode = require('vscode')
const { debounce } = require('./util')
const { log_debug } = require('./log')

module.exports.on_git_folders_changed = (/** @type {()=>any} */ callback) => {
	/** @type {import('./vscode.git').API} */
	let git_api = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1)
	if (! git_api)
		throw new Error('Search++ extension depends on the official VSCode Git extension. Did you disable it?')

	/** @type {import('./vscode.git').Repository[]} */
	let git_repos_cache = []
	let folders_change = () => {
		log_debug('git folders change', git_api.state, git_api.repositories.length)
		if (git_api.state !== 'initialized')
			return
		// onDidOpenRepository fires multiple times. At first, there isn't even a repos change
		if (git_api.repositories.length === git_repos_cache.length || git_api.repositories.length === 0)
			return
		git_repos_cache = git_api.repositories.slice()
		debounce(callback, 1000) // <- TODO
	}
	git_api.onDidOpenRepository(folders_change)
	git_api.onDidCloseRepository(folders_change)
	git_api.onDidChangeState(state => {
		if (state === 'initialized')
			folders_change()
	})
	folders_change()
}
