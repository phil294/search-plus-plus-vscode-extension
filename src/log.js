const { isMainThread, parentPort } = require('worker_threads')
const { EXT_NAME } = require('./global')

// todo proper log with timestamps like e.g. git or extension host

let verbose = false
/** debug logs are only written when verbose logging is enabled (setting `search++.verboseLogging`). */
module.exports.set_verbose = (/** @type boolean */ v) => { verbose = !! v }

/** @type {import('vscode').OutputChannel | null} */
let output_channel = null
let get_channel = () => {
	if (! output_channel) {
		let vscode = require('vscode')
		output_channel = vscode.window.createOutputChannel(EXT_NAME)
	}
	return output_channel
}

/** Writes a single line on the extension-host side (output channel), and, for errors, shows a message box.
 * Also called by indexer-client for log messages forwarded from the worker thread. */
let host_write = (/** @type string */ level, /** @type any[] */ args) => {
	get_channel().appendLine(`[${level}] [${new Date().toISOString()}] ${JSON.stringify([...args])}`)
	if (level === 'error') {
		let vscode = require('vscode')
		// at exit sometimes fails with "Canceled", hence the catch
		vscode.window.showErrorMessage(`Search++: ${args[0]} (For stack trace see VSCode dev tools)`).then(undefined, (/** @type any */ e) => console.warn(e))
	}
}
module.exports.host_write = host_write

let emit = (/** @type string */ level, /** @type any[] */ args) => {
	if (isMainThread)
		host_write(level, args)
	else
		// forward to the host, which owns the output channel. Errors are pre-stringified to
		// avoid structured-clone issues when posting across the worker boundary.
		parentPort?.postMessage({ type: 'log', level, args: args.map(a => a instanceof Error ? String(a.stack || a.message) : a) })
}

module.exports.log_error = (/** @type any[] */...s) => {
	console.error('Search++', ...s)
	console.trace()
	emit('error', s)
}
module.exports.log_debug = (/** @type any[] */...s) => {
	if (! verbose)
		return
	emit('debug', s)
}
/** Always written to the output channel (even with verbose logging off), but kept low-volume:
 * use for indexing milestones/timings only, not per-file spam. No console output. */
module.exports.log_info = (/** @type any[] */...s) => {
	emit('info', s)
}
module.exports.log_warn = (/** @type any[] */...s) => {
	console.warn('Search++', ...s)
	console.trace()
	emit('warn', s)
}
