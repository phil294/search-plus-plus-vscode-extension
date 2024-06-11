module.exports.hashCode = (/** @type string */ string) => {
	let hash = 0
	for (let i = 0; i < string.length; i++) {
		hash = (hash << 5) - hash + string.charCodeAt(i)
		hash = hash & hash
	}
	return hash
}

/** @type {Record<number,NodeJS.Timeout>} */
let debounce_timeout_map = {}
/** @deprecated relies on the unique hash value of *fun*, so use with care */
module.exports.debounce = (/** @type {()=>any} */ fun, /** @type number */ time) => {
	let hash = module.exports.hashCode(fun.toString() + time)
	clearTimeout(debounce_timeout_map[hash])
	debounce_timeout_map[hash] = setTimeout(fun, time)
}

module.exports.sleep = (/** @type number */ ms) =>
	new Promise(r => setTimeout(r, ms))
