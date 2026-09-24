let vscode = require('vscode')
const { log_error } = require('./log')
const { load_icon_mapping, icon_file_name } = require('./file-icons')

/** @typedef {import('./indexer-client').IndexerClient} IndexerClient */

let workspace_roots = () =>
	(vscode.workspace.workspaceFolders || []).map(f => f.uri.path)

function relativize(/** @type string */ p, /** @type string[] */ roots) {
	let best = ''
	for (let root of roots)
		if ((p === root || p.startsWith(root + '/')) && root.length > best.length)
			best = root
	if (best)
		return p.slice(best.length + 1)
	let idx = p.lastIndexOf('/')
	return idx === -1 ? p : p.slice(idx + 1)
}

let basename = (/** @type string */ p) => {
	let i = p.lastIndexOf('/')
	return i === -1 ? p : p.slice(i + 1)
}

/** Directory label for the picker: the workspace-folder name plus the in-folder directory, e.g.
 * `docker • gn_dev` for ~/docker/gn_dev/.env. Mirrors the search view's get_dir_path. */
function describe_dir(/** @type string */ p, /** @type {{name:string, path:string}[]} */ folders) {
	let folder = null
	let longest = -1
	for (let f of folders)
		if ((p === f.path || p.startsWith(f.path + '/')) && f.path.length > longest) {
			folder = f
			longest = f.path.length
		}
	if (! folder) {
		let i = p.lastIndexOf('/')
		return i === -1 ? '' : p.slice(0, i)
	}
	let rel = p.slice(folder.path.length + 1)
	let i = rel.lastIndexOf('/')
	let dir = i === -1 ? '' : rel.slice(0, i)
	return dir ? `${folder.name} • ${dir}` : folder.name
}

// Ranking tuning for the file picker (see score_target / update_files below):
// - recently-OPENED files (RecencyStore) only count for this long; older opens are ignored so a file
//   opened once months ago doesn't keep floating to the top forever.
const recency_ranking_window_ms = 5 * 24 * 60 * 60 * 1000
// - recently-MODIFIED files (file mtime) get a score bonus that decays smoothly with age, so a file
//   touched today clearly outranks similar matches from a year ago without ever overriding the
//   basename-vs-path-match distinction (+1000) or dominating a much better fuzzy match.
const mtime_bonus_max = 300
const mtime_bonus_half_life_days = 14

/** Score bonus in [0, mtime_bonus_max] for a file last modified `mtime` (unix seconds) ago, halving
 * every `mtime_bonus_half_life_days` days. */
function mtime_bonus(/** @type number */ mtime) {
	let age_days = Math.max(0, (Date.now() / 1000 - mtime) / 86400)
	return mtime_bonus_max * 0.5 ** (age_days / mtime_bonus_half_life_days)
}

/** @type {import('vscode').Uri|null} */
let icons_dir = null

/** Loads the bundled SVG icon set (vscode-icons) once, given the extension root. */
function ensure_icons(/** @type import('vscode').Uri */ extension_uri) {
	if (icons_dir)
		return
	icons_dir = vscode.Uri.joinPath(extension_uri, 'img', 'file-icons')
	load_icon_mapping(extension_uri)
}

/** Per-file-type SVG icon Uri, or a generic codicon before the icon set has loaded. */
function file_icon(/** @type string */ path) {
	if (! icons_dir)
		return new vscode.ThemeIcon('file')
	return vscode.Uri.joinPath(icons_dir, icon_file_name(path))
}

const separator_codes = new Set([0x20, 0x2d, 0x5f, 0x2e, 0x2f, 0x5c]) // space - _ . / \

/** true if position `i` starts a new word (string start, after a separator, or a camelCase hump). */
function is_word_start(/** @type string */ target, /** @type number */ i) {
	if (i === 0)
		return true
	let prev = target.charCodeAt(i - 1)
	if (separator_codes.has(prev))
		return true
	let cur = target.charCodeAt(i)
	return prev >= 97 && prev <= 122 && cur >= 65 && cur <= 90
}

/** fuzzy match returning a quality score (higher = better) or null for no match. `q` and `t` are the
 * already-lowercased query token and target; `target` keeps its original case for word-boundary/camelCase
 * detection. A short DP finds the best alignment, rewarding contiguous runs and word-boundary starts and
 * penalising gaps, so a tight match like `default-data.ts` outranks a scattered `css-defaults...`. */
function subsequence_match(/** @type string */ q, /** @type string */ target, /** @type string */ t) {
	if (! q)
		return 0
	let n = q.length
	let m = t.length
	// fast reject: bail unless q is a subsequence of t at all (keeps the DP off the hot path).
	// charCodeAt (not t[j]) is critical: string indexing allocates a one-char string per access,
	// which over hundreds of thousands of files per keystroke dominated the whole loop.
	let qi = 0
	for (let j = 0; j < m && qi < n; j++)
		if (t.charCodeAt(j) === q.charCodeAt(qi))
			qi++
	if (qi < n)
		return null
	const NEG = -1e9
	// prev[j] = best score having matched q[0..k] with the last matched char at target position j
	let prev = new Array(m).fill(NEG)
	for (let k = 0; k < n; k++) {
		let cur = new Array(m).fill(NEG)
		let qk = q.charCodeAt(k)
		for (let j = k; j < m; j++) {
			if (t.charCodeAt(j) !== qk)
				continue
			if (k === 0) {
				let s = is_word_start(target, j) ? 5 : 0
				if (j === 0)
					s += 10 // anchored at the very start
				cur[j] = s - (j >> 2) // earlier first match is slightly better
			} else {
				let best = NEG
				for (let p = k - 1; p < j; p++) {
					if (prev[p] === NEG)
						continue
					let gap = j - p - 1
					let s = prev[p] + (gap === 0 ? 6 : -Math.min(gap, 6))
					if (s > best)
						best = s
				}
				if (best > NEG)
					cur[j] = best + (is_word_start(target, j) ? 5 : 0)
			}
		}
		prev = cur
	}
	let result = NEG
	for (let j = 0; j < m; j++)
		if (prev[j] > result)
			result = prev[j]
	return result === NEG ? null : result
}

/** True if every token occurs in `t` (already lowercased) left-to-right in the same order they were
 * typed (each as a contiguous substring after the previous one). Rewards query-order-preserving matches. */
function tokens_in_order(/** @type string[] */ tokens, /** @type string */ t) {
	let pos = 0
	for (let token of tokens) {
		let idx = t.indexOf(token, pos)
		if (idx === -1)
			return false
		pos = idx + token.length
	}
	return true
}

/** Scores `target` against pre-split, pre-lowercased query `tokens`; requires every token to match (in
 * any order). `target_lower` is the lowercased target. Returns the summed score or null if any token is
 * missing. Tokens appearing in the typed order earn a bonus, so `restaurant widget css` ranks
 * `restaurant-widget.css` above `css-restaurant-widget.tpl`. */
function score_target(/** @type string[] */ tokens, /** @type string */ target, /** @type string */ target_lower) {
	if (! tokens.length)
		return 0
	let total = 0
	for (let token of tokens) {
		let s = subsequence_match(token, target, target_lower)
		if (s === null)
			return null
		total += s
	}
	if (tokens.length > 1 && tokens_in_order(tokens, target_lower))
		total += tokens.length * 25
	return total
}

/** Last typed query per mode, used to honour workbench.quickOpen.preserveInput like VS Code's own
 * pickers. Module-level: the picker is recreated on every invocation. */
const last_input_by_mode = new Map()

/**
 * A capable "Go to File" style quick picker with three modes, switched by the first typed character:
 * - (default) fuzzy file-name search over every indexed file (incl. binary ones). `:line` suffix supported.
 * - `@` plain-text search within the currently active editor (live preview).
 * - `#` full-text search across the whole workspace (uses the index).
 * @param {IndexerClient} indexer_client
 * @param {{mode?: 'file'|'text_in_file'|'text_in_workspace', recency?: import('./recency').RecencyStore, extension_uri?: import('vscode').Uri}} [options]
 */
async function show_file_picker(indexer_client, { mode, recency, extension_uri } = {}) {
	if (extension_uri)
		ensure_icons(extension_uri)
	let roots = workspace_roots()
	let folder_list = (vscode.workspace.workspaceFolders || []).map(f => ({ name: f.name, path: f.uri.path }))
	let qp = vscode.window.createQuickPick()
	qp.matchOnDescription = false
	qp.matchOnDetail = false
	// We rank items ourselves (all use alwaysShow); stop VS Code re-sorting them by label-vs-input
	// score, which otherwise tie-breaks alphabetically and buries our recency/mtime order.
	// `sortByLabel` exists at runtime but is missing from our pinned @types/vscode.
	;(/** @type {any} */ (qp)).sortByLabel = false // eslint-disable-line no-extra-parens
	qp.placeholder = mode === 'text_in_file'
		? 'Search text in the current file'
		: mode === 'text_in_workspace'
			? 'Search text across the workspace'
			: 'Search files by name. Prefix @ = text in current file, # = text in workspace'
	let preserve_input = !! vscode.workspace.getConfiguration().get('workbench.quickOpen.preserveInput')
	let input_key = mode || 'file'
	if (preserve_input)
		qp.value = last_input_by_mode.get(input_key) || ''

	let preview_editor = vscode.window.activeTextEditor
	let original_selection = preview_editor?.selection
	let accepted = false

	/** @type {{path:string, mtime:number}[]} */
	let all_paths = []
	try {
		all_paths = await indexer_client.all_file_paths()
	} catch (e) {
		log_error('file picker: all_file_paths failed', e)
	}

	/** @type {NodeJS.Timeout|null} */
	let search_debounce = null
	let workspace_token = 0
	let file_token = 0
	/** @type {NodeJS.Timeout|null} */
	let files_debounce = null
	let files_running = false
	/** @type {string|null} */
	let files_pending = null

	let update_files = async (/** @type string */ query) => {
		let my_token = ++file_token
		/** @type {number|null} */
		let line_no = null
		let m = query.match(/^(.*):(\d+)$/)
		if (m) {
			query = m[1] || ''
			line_no = parseInt(m[2] || '', 10)
		}
		let tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)

		let render = (/** @type {{p:string, base:string, rel:string}[]} */ rows) => {
			if (my_token !== file_token)
				return
			qp.items = rows.slice(0, 500).map(({ p, base }) => ({
				label: base,
				description: describe_dir(p, folder_list),
				iconPath: file_icon(p),
				alwaysShow: true,
				_action: { type: 'open', path: p, line: line_no },
			}))
		}

		if (! tokens.length) {
			// no query: recently-opened files first (within the last 5 days; older opens don't count),
			// then most-recently-modified, then shortest path as a final tiebreak
			let now = Date.now()
			let rows = all_paths.map(({ path: p, mtime }) => {
				let recency_ts = recency ? recency.get(p) : 0
				if (now - recency_ts > recency_ranking_window_ms)
					recency_ts = 0
				return { p, recency_ts, mtime }
			})
			rows.sort((a, b) => b.recency_ts - a.recency_ts || b.mtime - a.mtime || a.p.length - b.p.length)
			render(rows.slice(0, 500).map(({ p }) => ({ p, base: basename(p), rel: relativize(p, roots) })))
			return
		}

		// SQL prefilters to the subsequence-matchable set (lossless superset of the JS matcher), so the
		// full per-file scan runs in C on the worker thread and JS only ranks the small candidate set.
		let candidates
		try {
			candidates = await indexer_client.find_paths_fuzzy(tokens, 10000)
		} catch (e) {
			log_error('file picker: find_paths_fuzzy failed', e)
			return
		}
		if (my_token !== file_token)
			return

		let scored = []
		// Only treat a basename subsequence match as a "filename match" (the +1000 tier) when it's
		// reasonably tight: at least half of an ideal contiguous, word-anchored match for these tokens.
		// Otherwise a long basename that merely happens to contain the tokens scattered across it
		// (e.g. `lang po .po` fuzzy-hitting `service.…testFailedDueActiveBookings.fail.html`) would
		// outrank genuine `lang/po/*.po` path matches.
		let min_base_score = 0.5 * tokens.reduce((s, t) => s + (6 * t.length - 1), 0)
		let query_len = tokens.reduce((s, t) => s + t.length, 0)
		for (let { path: p, mtime } of candidates) {
			let rel = relativize(p, roots)
			let base = basename(p)
			let base_score = score_target(tokens, base, base.toLowerCase())
			// filename matches rank above path-only matches; both fall back to the full relative path
			let is_base_match = base_score !== null && base_score >= min_base_score
			let score = is_base_match ? /** @type {number} */ (base_score) + 1000 : score_target(tokens, rel, rel.toLowerCase()) // eslint-disable-line no-extra-parens
			if (score !== null) {
				// Reward matching a larger fraction of the basename so a full/near-full name match (`.env`
				// for ".env", `note` for "notes") outranks a longer submatch (`.env.production`, `NOTES.txt`)
				// even when the latter was modified more recently (coverage weight > mtime_bonus_max). A
				// short trailing file extension (<=4 chars) is excluded from the denominator so `NOTES.txt`
				// isn't penalised for `.txt`, while a long dotted suffix like `.production` still counts.
				let dot = base.lastIndexOf('.')
				let ext_len = base.length - dot - 1
				let cov_len = dot > 0 && ext_len >= 1 && ext_len <= 4 ? dot : base.length
				let coverage = is_base_match ? query_len / Math.max(1, cov_len) : 0
				scored.push({ p, rel, base, score: score + coverage * 1000 + mtime_bonus(mtime), recency: recency ? recency.get(p) : 0 })
			}
		}
		scored.sort((a, b) => b.score - a.score || b.recency - a.recency || a.rel.length - b.rel.length)
		render(scored)
	}

	let update_text_in_file = (/** @type string */ query) => {
		let editor = preview_editor
		if (! editor) {
			qp.items = [{ label: 'No active editor', alwaysShow: true }]
			return
		}
		/** @type {any[]} */
		let items = []
		if (query) {
			let ql = query.toLowerCase()
			let doc = editor.document
			for (let i = 0; i < doc.lineCount; i++) {
				let text = doc.lineAt(i).text
				let col = text.toLowerCase().indexOf(ql)
				if (col !== -1) {
					items.push({
						label: text.trim() || '(blank line)',
						description: ':' + (i + 1),
						iconPath: new vscode.ThemeIcon('list-selection'),
						alwaysShow: true,
						_action: { type: 'reveal_editor', line: i, col },
					})
					if (items.length >= 2000)
						break
				}
			}
		}
		qp.items = items
	}

	let update_text_in_workspace = (/** @type string */ query) => {
		workspace_token++
		let my_token = workspace_token
		if (search_debounce)
			clearTimeout(search_debounce)
		if (! query.trim()) {
			qp.items = []
			qp.busy = false
			return
		}
		qp.busy = true
		search_debounce = setTimeout(async () => {
			try {
				// Phase 1: candidate file names, shown immediately (open at line 1 until lines resolve).
				let paths = await indexer_client.find_candidate_paths(query, true, 2000, { roots })
				if (my_token !== workspace_token)
					return
				qp.items = paths.map(p => ({
					label: p.split('/').pop() || p,
					description: relativize(p, roots),
					iconPath: file_icon(p),
					alwaysShow: true,
					_action: { type: 'open', path: p, line: 1 },
				}))
				// Phase 2: resolve the matching line numbers (may expand to several entries per file).
				let { results } = await indexer_client.find_lines_for_paths(paths, query, 2000)
				if (my_token !== workspace_token)
					return
				/** @type {any[]} */
				let items = []
				for (let r of results) {
					for (let match of r.matches) {
						items.push({
							label: match.line_text.trim() || '(blank line)',
							description: relativize(r.path, roots) + ':' + match.line_number,
							iconPath: file_icon(r.path),
							alwaysShow: true,
							_action: { type: 'open', path: r.path, line: match.line_number },
						})
						if (items.length >= 2000)
							break
					}
					if (items.length >= 2000)
						break
				}
				qp.items = items
			} catch (e) {
				log_error('file picker workspace search failed', e)
			} finally {
				if (my_token === workspace_token)
					qp.busy = false
			}
		}, 10)
	}

	// Single-flight: never run two update_files bodies at once. Keystrokes arriving mid-run collapse
	// into files_pending (latest wins), so the in-flight search yields to the newest query when it ends.
	let run_files = async (/** @type string */ value) => {
		files_running = true
		try {
			await update_files(value)
		} finally {
			files_running = false
			if (files_pending !== null) {
				let next = files_pending
				files_pending = null
				run_files(next)
			}
		}
	}

	let schedule_files = (/** @type string */ value) => {
		if (files_debounce)
			clearTimeout(files_debounce)
		files_debounce = setTimeout(() => {
			files_debounce = null
			if (files_running)
				files_pending = value
			else
				run_files(value)
		}, 100)
	}

	let update = () => {
		let value = qp.value
		if (value.startsWith('@'))
			return update_text_in_file(value.slice(1))
		if (value.startsWith('#'))
			return update_text_in_workspace(value.slice(1))
		if (mode === 'text_in_file')
			return update_text_in_file(value)
		if (mode === 'text_in_workspace')
			return update_text_in_workspace(value)
		return schedule_files(value)
	}

	qp.onDidChangeValue(update)

	qp.onDidChangeActive((items) => {
		let item = /** @type any */ (items[0]) // eslint-disable-line no-extra-parens
		if (! item || ! item._action || item._action.type !== 'reveal_editor' || ! preview_editor)
			return
		let pos = new vscode.Position(item._action.line, Math.max(0, item._action.col))
		preview_editor.selection = new vscode.Selection(pos, pos)
		preview_editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
	})

	qp.onDidAccept(async () => {
		let item = /** @type any */ (qp.selectedItems[0]) // eslint-disable-line no-extra-parens
		if (! item || ! item._action)
			return qp.hide()
		accepted = true
		let action = item._action
		if (action.type === 'reveal_editor')
			// preview already moved the cursor; just close and keep it
			return qp.hide()
		qp.hide()
		let editor = await vscode.window.showTextDocument(vscode.Uri.file(action.path))
		if (action.line) {
			let pos = new vscode.Position(action.line - 1, 0)
			editor.selection = new vscode.Selection(pos, pos)
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
		}
	})

	qp.onDidHide(() => {
		// restore the editor if the user cancelled after we moved the cursor for preview
		if (! accepted && preview_editor && original_selection)
			preview_editor.selection = original_selection
		if (preserve_input)
			last_input_by_mode.set(input_key, qp.value)
		qp.dispose()
	})

	update()
	qp.show()
}

module.exports.show_file_picker = show_file_picker
