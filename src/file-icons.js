let vscode = require('vscode')
const { readFileSync } = require('fs')
const { log_error } = require('./log')

/** @type {Record<string,string>|null} */
let mapping = null

/** Loads the bundled vscode-icons extension→icon mapping once (from img/file-icons/). */
function load_icon_mapping(/** @type import('vscode').Uri */ extension_uri) {
	if (mapping)
		return
	try {
		mapping = JSON.parse(readFileSync(vscode.Uri.joinPath(extension_uri, 'img', 'file-icons', 'file-extension-icon-path-mapping.json').fsPath, 'utf-8'))
	} catch (e) {
		log_error('could not load file icon mapping', e)
		mapping = {}
	}
}

/** SVG file name (within img/file-icons/) for a path; the longest known dotted suffix of the file
 * name wins (so `x.css.map` and `.eslintrc` resolve), falling back to a generic file icon. */
function icon_file_name(/** @type string */ path) {
	if (mapping) {
		let name = (path.split('/').pop() || '').toLowerCase()
		let parts = name.split('.')
		for (let i = 0; i < parts.length; i++) {
			let mapped = mapping[parts.slice(i).join('.')]
			if (mapped)
				return mapped
		}
	}
	return 'default_file.svg'
}

module.exports = { load_icon_mapping, icon_file_name }
