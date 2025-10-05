let vscode = require('vscode')
const { EXT_NAME } = require('./global')

// todo proper log with timestamps like e.g. git or extension host
let log = vscode.window.createOutputChannel(EXT_NAME)

module.exports.log_error = async (/** @type any[] */...s) => {
	console.error('Search++', ...s)
	console.trace()
	try {
		await vscode.window.showErrorMessage(`Search++: ${s[0]} (For stack trace see VSCode dev tools)`) // at exit sometimes fails with "Canceled"
		log.appendLine(`[error] [${new Date().toISOString()}] ${JSON.stringify([...s])} (For stack trace see VSCode dev tools)`)
	} catch (e1) {
		console.warn(e1)
	}
}
module.exports.log_debug = (/** @type any[] */...s) => {
	// if(!config.debuggi) return TODO
	log.appendLine(`[debug] [${new Date().toISOString()}] ${JSON.stringify([...s])}`)
}

module.exports.log_warn = (/** @type any[] */...s) => {
	console.warn('Search++', ...s)
	console.trace()
	// if(!config.debuggi) return TODO
	log.appendLine(`[warn] [${new Date().toISOString()}] ${JSON.stringify([...s])}`)
}