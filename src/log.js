let vscode = require('vscode')
const { EXT_NAME } = require('./global')

// todo proper log with timestamps like e.g. git or extension host
let log = vscode.window.createOutputChannel(EXT_NAME)

module.exports.log_error = (/** @type string */e) => { // eslint-disable-line no-unused-vars
	vscode.window.showErrorMessage('Search++: ' + e)
	return log.appendLine(`ERROR: ${e}`)
}
module.exports.log_debug = (/** @type any[] */...s) => {
	// if(!config.debuggi) return TODO
	log.appendLine(`[debug] [${new Date().toISOString()}] ${JSON.stringify([...s])}`)
	// vscode.window.showInformationMessage(`[debug] ${JSON.stringify(s)}`)
}
