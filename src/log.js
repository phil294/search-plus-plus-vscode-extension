let vscode = require('vscode')
const { EXT_NAME } = require('./global')

// todo proper log with timestamps like e.g. git or extension host
let log = vscode.window.createOutputChannel(EXT_NAME)

module.exports.log_error = async (/** @type string */e) => { // eslint-disable-line no-unused-vars
	console.error(e)
	try {
		await vscode.window.showErrorMessage(`Search++: ${e} (For stack trace see VSCode dev tools)`) // at exit sometimes fails with "Canceled"
		log.appendLine(`ERROR: ${e} (For stack trace see VSCode dev tools)`)
	} catch (e1) {
		console.warn(e1)
	}
}
module.exports.log_debug = (/** @type any[] */...s) => {
	// if(!config.debuggi) return TODO
	log.appendLine(`[debug] [${new Date().toISOString()}] ${JSON.stringify([...s])}`)
	// vscode.window.showInformationMessage(`[debug] ${JSON.stringify(s)}`)
}
