const { readFile } = require('fs/promises')
let vscode = require('vscode')
let path = require('path')
const { log_debug, log_error } = require('./log')

// https://github.com/microsoft/vscode/issues/48674
module.exports.find_files = async (/** @type string */ glob, /** @type {{excludes:string[],gitignore_filenames:string[]}} */ { excludes, gitignore_filenames }) => {
	log_debug('findFiles...')
	// TODO cancellationtoken
	// "search.useIgnoreFiles": true, // what if false TODO
	/** @type {vscode.Uri[]} */
	let files = []
	try {
		files = await vscode.workspace.findFiles2([glob], {
			exclude: excludes,
			useIgnoreFiles: { local: true, parent: true, global: true },
			followSymlinks: true,
			maxResults: 20000, // TODO: is standard
			useExcludeSettings: vscode.ExcludeSettingOptions.SearchAndFilesExclude,
		})
	} catch (e) {
		if (! e.message.includes('enabledApiProposals'))
			throw e
		log_debug('findFiles2 not enabled, falling back to gitignores')
		files = (await Promise.all(vscode.workspace.workspaceFolders?.map(async (folder) => {
			let gitignores = await vscode.workspace.findFiles(
				new vscode.RelativePattern(folder.uri, `**/{${gitignore_filenames.join(',')}}`),
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
