// Minimal `vscode` API surface used by our modules (find-files.js, log.js), so the indexing
// pipeline can run standalone in plain node for benchmarking. Installed via bench/index-bench.js.
const path = require('path')

class Uri {
	constructor(/** @type string */ fsPath) {
		this.fsPath = fsPath
		this.path = fsPath // POSIX-ish; good enough for benchmarking on Linux
		this.scheme = 'file'
	}

	static file(/** @type string */ p) {
		return new Uri(p)
	}

	static joinPath(/** @type Uri */ base, /** @type {string[]} */ ...segs) {
		return new Uri(path.join(base.fsPath, ...segs))
	}

	toString() {
		return this.fsPath
	}
}

/** @type {{uri:Uri, name:string}[]} */
let workspace_folders = []

module.exports = {
	Uri,
	set_workspace_folders(/** @type {string[]} */ dirs) {
		workspace_folders = dirs.map(d => ({ uri: Uri.file(d), name: path.basename(d) }))
	},
	get workspace() {
		return {
			get workspaceFolders() { return workspace_folders },
			getConfiguration() {
				return { get() { return {} } }
			},
			onDidChangeWorkspaceFolders() {},
			createFileSystemWatcher() {
				return { onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }
			},
		}
	},
	window: {
		createOutputChannel() {
			return { appendLine() {}, show() {}, dispose() {} }
		},
		showErrorMessage() {
			return Promise.resolve(undefined)
		},
	},
}
