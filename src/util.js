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

/** Where a plain (non-regex) query matches in a line: the whole query as one in-order run (optional
 * whitespace between terms) if present, else the earliest single term; -1 if none. */
module.exports.plain_match_index = (/** @type string */ text, /** @type string[] */ terms, /** @type boolean */ case_sensitive) => {
	let seq = new RegExp(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), case_sensitive ? '' : 'i').exec(text)
	if (seq)
		return seq.index
	let hay = case_sensitive ? text : text.toLowerCase()
	let first = -1
	for (let term of terms) {
		let idx = hay.indexOf(case_sensitive ? term : term.toLowerCase())
		if (idx !== -1 && (first === -1 || idx < first))
			first = idx
	}
	return first
}

/** Result preview like VS Code's search view (its `lcut(before, 26, '…')`): leading whitespace stripped
 * and the text before the match (at index `at`, -1 = unknown) cut back at a word boundary. */
module.exports.line_preview = (/** @type string */ line, /** @type number */ at) => {
	const max_before = 26
	if (at < 0)
		return line.trimStart().slice(0, 1000)
	let full_before = line.slice(0, at).trimStart()
	let before = full_before
	if (before.length >= max_before) {
		// only boundaries near the cut matter; bound the scan so huge minified lines stay cheap
		let window = before.slice(-(max_before + 100))
		let re = /\b/g
		let i = 0
		while (re.test(window)) {
			if (window.length - re.lastIndex < max_before)
				break
			i = re.lastIndex
			re.lastIndex += 1
		}
		let cut = window.slice(i).trimStart()
		before = cut.length < full_before.length ? '...' + cut : cut
	}
	return (before + line.slice(at)).slice(0, 1000)
}

/** Extracts the mandatory, contiguous literal substrings (each >= min_len chars) that MUST appear in
 * every string a regex matches, for use as an FTS trigram prefilter. Deliberately paranoid: it handles
 * only a flat concatenation of literals, character classes, quantifiers and anchors, and BAILS OUT
 * (returns []) the instant it meets anything whose meaning it can't fully guarantee — a group `(` or an
 * alternation `|`. Reasoning about those is exactly where a hand-written parser gets a match subtly
 * wrong (e.g. treating a literal inside `(a|b)` as mandatory), so we'd rather return nothing and let the
 * caller fall back to a full ripgrep scan. Everything returned is therefore guaranteed present in every
 * match, making a wrong prefilter impossible. */
module.exports.extract_required_literals = (/** @type string */ pattern, /** @type number */ min_len = 3) => {
	let n = pattern.length
	/** @type {string[]} */
	let runs = []
	let cur = ''
	let flush = () => {
		if (cur.length >= min_len)
			runs.push(cur)
		cur = ''
	}
	let quant_at = (/** @type number */ i) => {
		let c = pattern[i]
		return c === '?' || c === '*' || c === '+' || c === '{'
	}
	// index just past a quantifier ( ?, *, +, {..}, each optionally lazy `?` ) starting at i
	let skip_quantifier = (/** @type number */ i) => {
		let c = pattern[i]
		if (c === '?' || c === '*' || c === '+')
			return pattern[i + 1] === '?' ? i + 2 : i + 1
		if (c === '{') {
			let close = pattern.indexOf('}', i)
			if (close === -1)
				return i + 1
			return pattern[close + 1] === '?' ? close + 2 : close + 1
		}
		return i
	}
	// index just past a character class [...] beginning at i (a leading ] is a literal member)
	let skip_class = (/** @type number */ i) => {
		let j = i + 1
		if (pattern[j] === '^')
			j++
		if (pattern[j] === ']')
			j++
		while (j < n) {
			if (pattern[j] === '\\') {
				j += 2
				continue
			}
			if (pattern[j] === ']')
				return j + 1
			j++
		}
		return n
	}
	let i = 0
	while (i < n) {
		let c = pattern.charAt(i)
		// A group or an alternation means the parser would have to understand its contents to know which
		// literals are truly mandatory — exactly where it gets a match subtly wrong. Give up and let the
		// caller run ripgrep over everything instead.
		if (c === '(' || c === '|')
			return []
		if (c === '\\') {
			let esc = pattern.charAt(i + 1)
			let is_lit = esc !== '' && '\\^$.|?*+()[]{}/-'.includes(esc)
			if (is_lit && ! quant_at(i + 2)) {
				cur += esc // an escaped literal punctuation char
				i += 2
				continue
			}
			// class shorthand (\d \w \b \n …), a quantified escaped literal, or a trailing backslash: not
			// a fixed literal, so end the current run.
			flush()
			i = is_lit ? skip_quantifier(i + 2) : i + 2
			continue
		}
		if (c === '[') {
			flush()
			i = skip_class(i)
			if (quant_at(i))
				i = skip_quantifier(i)
			continue
		}
		if (c === '{') {
			flush()
			i = skip_quantifier(i)
			continue
		}
		if ('.*+?^$)]}'.includes(c)) {
			flush()
			i++
			continue
		}
		// plain literal char: mandatory as-is only when not immediately quantified
		if (quant_at(i + 1)) {
			flush()
			i = skip_quantifier(i + 1)
			continue
		}
		cur += c
		i++
	}
	flush()
	return runs
}
