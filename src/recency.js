const two_weeks_ms = 14 * 24 * 60 * 60 * 1000
const state_key = 'file_recency'

/** Remembers when files were last opened, so the file picker can order them by recency.
 * Entries older than two weeks are forgotten. */
class RecencyStore {
	constructor(/** @type import('vscode').Memento */ memento) {
		this.memento = memento
		/** @type {Record<string, number>} */
		this.map = { ...memento.get(state_key) || {} }
		this._prune()
	}

	_prune() {
		let cutoff = Date.now() - two_weeks_ms
		let changed = false
		for (let key of Object.keys(this.map))
			if ((this.map[key] || 0) < cutoff) {
				delete this.map[key]
				changed = true
			}
		if (changed)
			this.memento.update(state_key, this.map)
	}

	touch(/** @type string */ path) {
		if (! path)
			return
		this.map[path] = Date.now()
		this.memento.update(state_key, this.map)
	}

	/** last-opened timestamp, or 0 if never opened (or forgotten) */
	get(/** @type string */ path) {
		return this.map[path] || 0
	}
}

module.exports.RecencyStore = RecencyStore
