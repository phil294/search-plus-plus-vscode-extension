// Search view webview (browser ES module, loaded by webview.html; `vue` resolves via its importmap).
import { createApp, ref, shallowRef, markRaw, computed, onMounted, nextTick, watch } from 'vue'
/** @typedef {{line_number:number, line_text:string, placeholder?:boolean}} Match */
/** @typedef {{path:string, uri?:string, icon?:string, matches:Match[]}} ResultFile */
/** @typedef {{dirs:Record<string, TreeNode>, files:{fi:number}[], key:string, label:string, rank?:number}} TreeNode */
/** @typedef {{kind:'dir', key:string, label:string, depth:number} | {kind:'file', fi:number, depth:number} | {kind:'match', fi:number, mi:number, depth:number}} Row */
/** @typedef {{kind:'dir', key:string} | {kind?:undefined, path:string, line:number|null|undefined}} Selection */
const vscode = acquireVsCodeApi()
// verbose timing logs -> extension output channel (only written when search++.verboseLogging is on)
const log = (/** @type {unknown[]} */ ...args) => vscode.postMessage({ type: 'log', args: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)) })
createApp({
	setup() {
		const search_query = ref(localStorage.getItem('search_query') || '')
		const include_query = ref(localStorage.getItem('search_include') || '')
		const exclude_query = ref(localStorage.getItem('search_exclude') || '')
		const case_sensitive = ref(localStorage.getItem('search_case') === '1')
		const use_regex = ref(localStorage.getItem('search_regex') === '1')
		// Honour the explicit collapsed/expanded choice once the user has ever toggled it (persisted);
		// only fall back to auto-expanding when there's filter content on first-ever use. Otherwise the
		// panel reappeared every time the view was re-created (e.g. switching views and back).
		const saved_show_filters = localStorage.getItem('search_show_filters')
		const show_filters = ref(saved_show_filters != null ? saved_show_filters === '1' : !! (include_query.value || exclude_query.value))
		// Result file objects are markRaw'd (Vue never deep-proxies them or their match arrays), so `results`
		// is a shallowRef: the render effect tracks only the array identity, not thousands of nested
		// properties. This makes both mount and teardown near-native (a deep-reactive list of ~1000 matches
		// cost 80-160ms to tear down; raw objects cost single-digit ms).
		const results = shallowRef(/** @type {ResultFile[]} */ ([])) // eslint-disable-line no-extra-parens
		// rows only ever hold indices into the current results, so the lookup can't miss
		const file_at = (/** @type {number} */ fi) => /** @type {ResultFile} */ (results.value[fi]) // eslint-disable-line no-extra-parens
		// Collapse state lives here (keyed by path) instead of on the raw file objects, which can't be
		// reactive. Persists across result swaps for free.
		const collapsed_files = ref(/** @type {Record<string, boolean>} */ ({})) // eslint-disable-line no-extra-parens
		// Bumped on every fresh query so the keyed .results-list wrapper is remounted -> the old subtree is
		// torn down in one native removal instead of per-row.
		const results_key = ref(0)
		const has_more = ref(false)
		const loading = ref(false)
		const workspace_folders = ref(/** @type {{name:string, path:string}[]} */ ([])) // eslint-disable-line no-extra-parens
		const search_input = ref(/** @type {HTMLInputElement|null} */ (null)) // eslint-disable-line no-extra-parens
		const include_input = ref(/** @type {HTMLInputElement|null} */ (null)) // eslint-disable-line no-extra-parens
		const exclude_input = ref(/** @type {HTMLInputElement|null} */ (null)) // eslint-disable-line no-extra-parens
		const results_container = ref(/** @type {HTMLElement|null} */ (null)) // eslint-disable-line no-extra-parens
		const selected = ref(-1)
		// Process only this many result FILES on the first paint of a large result set; the rest follow a
		// macrotask later (see reveal()). The real cost is the tree/flat_rows computed (and Vue lazily
		// proxying each file/match) over the whole set, not the DOM node count — so we cap the DATA that
		// feeds them, not just the rendered rows.
		const INITIAL_FILES = 50
		const file_limit = ref(Infinity)
		// The files the tree/flat_rows actually process; a prefix slice keeps fi indices valid into results.
		const displayed_results = computed(() => {
			const r = results.value
			return r.length > file_limit.value ? r.slice(0, file_limit.value) : r
		})
		let t_search_sent = 0 // performance.now() when the current query was posted, for timing logs
		let t_input = 0 // performance.now() of the most recent raw keystroke, to measure input->sent lag
		/** @type {string|null} query string of the currently-displayed results; a change means a new search */
		let rendered_query = null
		// The Range objects currently registered as highlights. They are LIVE: the browser revalidates
		// their boundaries on every DOM mutation, synchronously, while they reference a node. Held here so
		// they can be repointed off the result rows before those rows are torn down (see release_highlights).
		/** @type {Range[]} */
		let active_ranges = []

		const result_count_text = computed(() => {
			const files = results.value.length
			if (! files)
				return ''
			const total_matches = results.value.reduce((sum, item) => sum + item.matches.length, 0)
			return total_matches + ' match' + (total_matches === 1 ? '' : 'es') +
				' in ' + files + ' file' + (files === 1 ? '' : 's') +
				(has_more.value ? ' (truncated, please refine your search)' : '')
		})

		const dir_collapsed = ref(/** @type {Record<string, boolean>} */ ({})) // eslint-disable-line no-extra-parens
		const toggle_dir = (/** @type {string} */ key) => { dir_collapsed.value[key] = ! dir_collapsed.value[key] }
		const view_mode = ref(localStorage.getItem('search_view_mode') || 'tree')
		const toggle_view_mode = () => {
			view_mode.value = view_mode.value === 'tree' ? 'list' : 'tree'
			localStorage.setItem('search_view_mode', view_mode.value)
		}

		// Directory segments for a path: the workspace-folder name first, then each dir, excluding
		// the file's own name. Falls back to raw path segments for files outside any folder.
		const path_segments = (/** @type {string} */ path) => {
			let folder = null
			let longest = -1
			for (const f of workspace_folders.value)
				if ((path === f.path || path.startsWith(f.path + '/')) && f.path.length > longest) {
					folder = f
					longest = f.path.length
				}
			if (folder) {
				const rel = path.slice(folder.path.length + 1).split('/')
				rel.pop()
				return [folder.name, ...rel]
			}
			const parts = path.split('/')
			parts.pop()
			return parts.filter(Boolean)
		}

		// Group the flat result files into a directory tree, collapsing single-child dir chains
		// (logic adapted from GitLG's files_tree). Each leaf dir node carries its files; `key` is
		// the full path from the root (stable, used for collapse state), `label` the display text.
		const tree = computed(() => {
			const root = /** @type {TreeNode} */ ({ dirs: {}, files: [], key: '', label: '' }) // eslint-disable-line no-extra-parens
			displayed_results.value.forEach((file, fi) => {
				let curr = root
				let acc = ''
				for (const seg of path_segments(file.path)) {
					acc = acc ? acc + '/' + seg : seg
					curr = curr.dirs[seg] ||= { dirs: {}, files: [], key: acc, label: seg }
				}
				curr.files.push({ fi })
			})
			const unify = (/** @type {TreeNode} */ node) => {
				let modified = true
				while (modified) {
					modified = false
					for (const [k, child] of Object.entries(node.dirs))
						if (! child.files.length) {
							for (const gc of Object.values(child.dirs)) {
								gc.label = child.label + ' / ' + gc.label
								node.dirs[gc.label] = gc
							}
							delete node.dirs[k]
							modified = true
						} else
							unify(child)
				}
			}
			unify(root)
			// results arrive relevance-ranked (fi = rank); a dir ranks as its best file
			/** @returns {number} */
			const set_rank = (/** @type {TreeNode} */ node) => {
				node.rank = Math.min(...node.files.map(f => f.fi), ...Object.values(node.dirs).map(set_rank))
				return node.rank
			}
			set_rank(root)
			return root
		})

		// A flat, ordered list of the currently-visible navigable rows (dir headers, file headers
		// and, for expanded files, their match lines), each with its tree depth for indentation.
		// Used by both the template and keyboard navigation.
		const flat_rows = computed(() => {
			/** @type {Row[]} */
			const rows = []
			if (view_mode.value === 'list') {
				displayed_results.value.forEach((file, fi) => {
					rows.push({ kind: 'file', fi, depth: 0 })
					if (! collapsed_files.value[file.path])
						file.matches.forEach((_, mi) => rows.push({ kind: 'match', fi, mi, depth: 1 }))
				})
				return rows
			}
			const walk = (/** @type {TreeNode} */ node, /** @type {number} */ depth) => {
				/** @type {{rank:number, d?:TreeNode, f?:{fi:number}}[]} */
				const entries = [
					...Object.values(node.dirs).map(d => ({ rank: d.rank ?? 0, d })),
					...node.files.map(f => ({ rank: f.fi, f })),
				]
				entries.sort((a, b) => a.rank - b.rank)
				for (const { d, f } of entries)
					if (d) {
						rows.push({ kind: 'dir', key: d.key, label: d.label, depth })
						if (! dir_collapsed.value[d.key])
							walk(d, depth + 1)
					} else if (f) {
						rows.push({ kind: 'file', fi: f.fi, depth })
						const file = file_at(f.fi)
						if (! collapsed_files.value[file.path])
							file.matches.forEach((_, mi) => rows.push({ kind: 'match', fi: f.fi, mi, depth: depth + 1 }))
					}
			}
			walk(tree.value, 0)
			return rows
		})

		// Paint a large result set in two steps: a small first batch immediately, then the rest after a
		// macrotask so the first batch actually paints AND any already-queued newer message (e.g. phase-2
		// resolved lines arriving right after phase-1 candidates) gets processed first — that newer
		// message cancels this pending expand, so a superseded set never pays for a full render.
		/** @type {ReturnType<typeof setTimeout>|null} */
		let pending_reveal = null
		const reveal = (/** @type {string} */ label, /** @type {() => void} */ on_first_paint, /** @type {() => void} */ on_full) => {
			if (pending_reveal) { clearTimeout(pending_reveal); pending_reveal = null }
			const total = results.value.length
			if (total > INITIAL_FILES) {
				const t0 = performance.now()
				file_limit.value = INITIAL_FILES
				nextTick().then(() => {
					log(label + ': first', INITIAL_FILES, 'of', total, 'files patched', (performance.now() - t0).toFixed(1) + 'ms')
					if (on_first_paint)
						on_first_paint()
				})
				pending_reveal = setTimeout(() => {
					pending_reveal = null
					const t1 = performance.now()
					file_limit.value = Infinity
					nextTick().then(() => {
						log(label + ': full', total, 'files patched', (performance.now() - t1).toFixed(1) + 'ms')
						if (on_full)
							on_full()
					})
				}, 0)
			} else {
				const t0 = performance.now()
				file_limit.value = Infinity
				nextTick().then(() => {
					log(label + ':', total, 'files patched', (performance.now() - t0).toFixed(1) + 'ms')
					if (on_first_paint)
						on_first_paint()
					if (on_full)
						on_full()
				})
			}
		}

		const row_key = (/** @type {Row} */ row) =>
			row.kind === 'dir'
				? 'd:' + row.key
				: row.kind === 'file'
					? 'f:' + file_at(row.fi).path
					: 'm:' + file_at(row.fi).path + ':' + row.mi

		const is_file_selected = (/** @type {number} */ fi) => {
			const row = flat_rows.value[selected.value]
			return !! row && row.kind === 'file' && row.fi === fi
		}
		const is_match_selected = (/** @type {number} */ fi, /** @type {number} */ mi) => {
			const row = flat_rows.value[selected.value]
			return !! row && row.kind === 'match' && row.fi === fi && row.mi === mi
		}

		const scroll_selected_into_view = (/** @type {ScrollLogicalPosition} */ block = 'nearest') => nextTick().then(() => {
			const el = results_container.value?.querySelector('.selected')
			el?.scrollIntoView({ block })
		})
		// Rendered rows map 1:1 to flat_rows (the no-results div is hidden while results exist).
		const scroll_row_into_view = (/** @type {number} */ idx, /** @type {ScrollLogicalPosition} */ block = 'nearest') => nextTick().then(() => {
			results_container.value?.querySelector('.results-list')?.children[idx]?.scrollIntoView({ block })
		})

		const move = (/** @type {number} */ delta) => {
			const rows = flat_rows.value
			if (! rows.length)
				return
			let i = selected.value < 0 ? delta > 0 ? 0 : rows.length - 1 : selected.value + delta
			if (i < 0)
				i = 0
			if (i >= rows.length)
				i = rows.length - 1
			selected.value = i
			scroll_selected_into_view()
		}

		const toggle_file = (/** @type {number} */ fi) => {
			const p = file_at(fi).path
			collapsed_files.value[p] = ! collapsed_files.value[p]
		}

		const open_match = (/** @type {number} */ fi, /** @type {number} */ mi) => {
			const file = file_at(fi)
			const match = file.matches[mi]
			if (! match)
				return
			// keep the clicked/activated row selected
			const rows = flat_rows.value
			const idx = rows.findIndex(r => r.kind === 'match' && r.fi === fi && r.mi === mi)
			if (idx !== -1)
				selected.value = idx
			vscode.postMessage({ type: 'open_file', path: file.path, uri: file.uri, line_number: match.line_number })
		}

		const activate = () => {
			const row = flat_rows.value[selected.value]
			if (! row)
				return
			if (row.kind === 'dir')
				toggle_dir(row.key)
			else if (row.kind === 'file')
				toggle_file(row.fi)
			else
				open_match(row.fi, row.mi)
		}

		const set_collapsed = (/** @type {boolean} */ val) => {
			const row = flat_rows.value[selected.value]
			if (! row)
				return
			if (row.kind === 'dir')
				dir_collapsed.value[row.key] = val
			else if (row.kind === 'file')
				collapsed_files.value[file_at(row.fi).path] = val
			else if (val) {
				// left on a match: jump up to its file header
				const rows = flat_rows.value
				for (let i = selected.value; i >= 0; i--)
					if (rows[i]?.kind === 'file') { selected.value = i; break }
				scroll_selected_into_view()
			}
		}

		// F4 / shift+F4 from the extension: go to next/previous match line and open it. Wraps around
		// at the ends, like the built-in search's F4.
		const nav = (/** @type {'next'|'prev'} */ direction) => {
			const rows = flat_rows.value
			if (! rows.length)
				return
			const step = direction === 'next' ? 1 : -1
			let i = selected.value
			for (let n = 0; n < rows.length; n++) {
				i += step
				if (i < 0)
					i = rows.length - 1
				else if (i >= rows.length)
					i = 0
				const row = rows[i]
				if (row?.kind === 'match') {
					selected.value = i
					scroll_selected_into_view()
					open_match(row.fi, row.mi)
					return
				}
			}
		}

		const focus_search = () => search_input.value?.focus()

		const on_keydown = (/** @type {KeyboardEvent} */ e) => {
			const target = e.target instanceof HTMLInputElement ? e.target : null
			if (e.altKey && (e.key === 'c' || e.key === 'C')) {
				e.preventDefault()
				toggle_case()
				return
			}
			if (e.altKey && (e.key === 'r' || e.key === 'R')) {
				e.preventDefault()
				toggle_regex()
				return
			}
			// include/exclude filters get the same Up/Down history nav and Enter-to-search as the search
			// box; all other keys behave normally.
			if (target && target.classList && target.classList.contains('filter-input')) {
				const hist = target === include_input.value
					? include_hist
					: target === exclude_input.value ? exclude_hist : null
				if (hist) {
					if (e.key === 'ArrowUp') {
						e.preventDefault()
						hist.prev()
						return
					}
					if (e.key === 'ArrowDown') {
						e.preventDefault()
						hist.next()
						return
					}
					if (e.key === 'Enter') {
						e.preventDefault()
						hist.push(target.value)
						do_search()
						return
					}
				}
				return
			}
			const in_search = target === search_input.value
			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault()
					if (in_search)
						search_hist.next()
					else
						move(1)
					break
				case 'ArrowUp':
					e.preventDefault()
					if (in_search)
						search_hist.prev()
					else
						move(-1)
					break
				case 'Enter':
					e.preventDefault()
					if (in_search)
						trigger_search_now()
					else
						activate()
					break
				case 'ArrowRight':
					if (in_search)
						break
					e.preventDefault()
					set_collapsed(false)
					break
				case 'ArrowLeft':
					if (in_search)
						break
					e.preventDefault()
					set_collapsed(true)
					break
				case 'Escape':
					if (in_search)
						break
					e.preventDefault()
					focus_search()
					break
			}
		}

		/** @type {ReturnType<typeof setTimeout>|undefined} */
		let search_debounce_timer
		const do_search = () => {
			clearTimeout(search_debounce_timer)
			localStorage.setItem('search_query', search_query.value)
			localStorage.setItem('search_include', include_query.value)
			localStorage.setItem('search_exclude', exclude_query.value)
			loading.value = !! search_query.value.trim()
			t_search_sent = performance.now()
			log('search sent:', search_query.value, t_input ? '(' + (t_search_sent - t_input).toFixed(1) + 'ms input->sent)' : '')
			vscode.postMessage({
				type: 'search',
				query: search_query.value,
				include: include_query.value,
				exclude: exclude_query.value,
				case_sensitive: case_sensitive.value,
				regex: use_regex.value,
			})
		}
		// Independent query histories (most-recent-first, de-duped, capped) for the search box and the
		// include/exclude filters: Up/Down navigate older/newer, blur commits, typing exits navigation.
		const HISTORY_MAX = 100
		const move_cursor_end = (/** @type {HTMLInputElement|null} */ el) => nextTick(() => {
			if (el)
				el.setSelectionRange(el.value.length, el.value.length)
		})
		const make_history = (/** @type {string} */ storage_key, /** @type {import('vue').Ref<string>} */ value_ref, /** @type {() => HTMLInputElement|null} */ get_el) => {
			/** @type {string[]} */
			let entries = []
			try {
				const stored = JSON.parse(localStorage.getItem(storage_key) || '[]')
				if (Array.isArray(stored))
					entries = stored
			} catch {
				entries = []
			}
			let index = -1 // -1 = editing the live draft, not navigating history
			let draft = ''
			const push = (/** @type {string} */ raw) => {
				const q = raw.trim()
				index = -1
				if (! q)
					return
				const existing = entries.indexOf(q)
				if (existing !== -1)
					entries.splice(existing, 1)
				entries.unshift(q)
				if (entries.length > HISTORY_MAX)
					entries.length = HISTORY_MAX
				localStorage.setItem(storage_key, JSON.stringify(entries))
			}
			const apply = (/** @type {string} */ value) => {
				value_ref.value = value
				do_search()
				move_cursor_end(get_el())
			}
			const prev = () => { // older query
				if (! entries.length || index >= entries.length - 1)
					return
				if (index === -1)
					draft = value_ref.value
				index++
				apply(entries[index] ?? '')
			}
			const next = () => { // newer query, back toward the live draft
				if (index === -1)
					return
				index--
				apply(index === -1 ? draft : entries[index] ?? '')
			}
			const blur = () => {
				const q = value_ref.value.trim()
				if (q && q !== entries[0])
					push(q)
			}
			return { push, prev, next, blur, reset: () => { index = -1 } }
		}
		const search_hist = make_history('search_history', search_query, () => search_input.value)
		const include_hist = make_history('search_include_history', include_query, () => include_input.value)
		const exclude_hist = make_history('search_exclude_history', exclude_query, () => exclude_input.value)
		const on_search_input = () => {
			search_hist.reset() // manual typing exits history navigation
			t_input = performance.now()
			schedule_search()
		}
		const on_include_input = () => {
			include_hist.reset()
			schedule_search()
		}
		const on_exclude_input = () => {
			exclude_hist.reset()
			schedule_search()
		}
		// Coalesce keystrokes: reflect the pending work immediately (progress bar on) but defer the
		// actual search so fast typing sends one request, not one per character. Clearing is instant.
		const schedule_search = () => {
			clearTimeout(search_debounce_timer)
			// Debounce every live search: on a cold index even a plain FTS lookup can take 1-2s, so firing
			// one per keystroke stacks a queue of slow queries the user has already typed past (regex can
			// also fall back to a slow ripgrep scan). An empty query always clears instantly.
			if (! search_query.value.trim()) {
				do_search()
				return
			}
			loading.value = true
			search_debounce_timer = setTimeout(do_search, 150)
		}
		// Leaving an input commits its current value to that input's history (like a normal search
		// box), but only when it isn't already the most recent entry.
		const on_search_blur = () => search_hist.blur()
		const on_include_blur = () => include_hist.blur()
		const on_exclude_blur = () => exclude_hist.blur()
		// Enter in the search box re-runs the search immediately to refresh stale results and commits
		// the query to the search history.
		const trigger_search_now = () => {
			search_hist.push(search_query.value)
			do_search()
		}
		// Case sensitivity is an explicit toggle (button / Alt+C); re-run the search and re-highlight.
		const toggle_case = () => {
			case_sensitive.value = ! case_sensitive.value
			localStorage.setItem('search_case', case_sensitive.value ? '1' : '0')
			if (search_query.value.trim())
				do_search()
			else
				highlight_search_terms()
		}
		// Regex mode toggle (button / Alt+R): the query is treated as a regular expression.
		const toggle_regex = () => {
			use_regex.value = ! use_regex.value
			localStorage.setItem('search_regex', use_regex.value ? '1' : '0')
			if (search_query.value.trim())
				do_search()
			else
				highlight_search_terms()
		}

		watch(show_filters, (v) => localStorage.setItem('search_show_filters', v ? '1' : '0'))
		// expanding/switching view re-creates the match rows; their highlight ranges must be rebuilt
		watch([collapsed_files, dir_collapsed, view_mode], () => highlight_search_terms(), { deep: true, flush: 'post' })
		watch(() => results.value.length, (len) =>
			vscode.postMessage({ type: 'has_results', value: len > 0 }))

		const get_file_name = (/** @type {string} */ path) =>
			path.split('/').pop()

		const get_dir_path = (/** @type {string} */ path) => {
			// Find the workspace folder this file belongs to
			let workspace_folder = null
			let longest_match = 0
			for (const folder of workspace_folders.value)
				if (path.startsWith(folder.path + '/') && folder.path.length > longest_match) {
					workspace_folder = folder
					longest_match = folder.path.length
				}

			if (! workspace_folder) {
				const parts = path.split('/')
				parts.pop()
				return parts.join('/')
			}
			let relative_path = path.substring(workspace_folder.path.length + 1)
			const parts = relative_path.split('/')
			parts.pop()
			const relative_dir = parts.join('/')
			return relative_dir ? `${workspace_folder.name} • ${relative_dir}` : workspace_folder.name
		}
		// Drop the current highlights AND detach their live Range objects from the result rows by
		// repointing each to document.body. Clearing CSS.highlights alone only unregisters the overlay;
		// the ranges stay live and keep costing a synchronous revalidation on every node removal during
		// teardown (100ms+ for a modest list). Must run BEFORE results is reassigned.
		const release_highlights = () => {
			CSS.highlights?.clear()
			for (const r of active_ranges)
				try { r.setStart(document.body, 0); r.collapse(true) } catch { /* node already gone */ }

			active_ranges = []
		}
		const highlight_search_terms = () => {
			if (! search_query.value.trim() || ! CSS.highlights) {
				release_highlights()
				return
			}
			const t_hl = performance.now()
			release_highlights()
			/** @type {Range[]} */
			const ranges = []
			// case sensitivity of highlighting follows the explicit toggle (Aa button / Alt+C)
			const q = search_query.value.trim()
			const cs = case_sensitive.value
			const line_elements = document.querySelectorAll('.line-text')
			if (use_regex.value) {
				let re = null
				try { re = new RegExp(q, cs ? 'g' : 'gi') } catch { re = null }
				if (re)
					line_elements.forEach(element => {
						const text = element.textContent
						if (! text)
							return
						const text_node = element.firstChild
						if (! text_node || text_node.nodeType !== Node.TEXT_NODE)
							return
						re.lastIndex = 0
						let m
						while ((m = re.exec(text)) !== null) {
							if (m.index === re.lastIndex)
								re.lastIndex++ // avoid an infinite loop on a zero-width match
							if (! m[0].length)
								continue
							const range = new Range()
							range.setStart(text_node, m.index)
							range.setEnd(text_node, m.index + m[0].length)
							ranges.push(range)
						}
					})
			} else {
				const search_terms = q.split(/\s+/).filter(Boolean).map(t => cs ? t : t.toLowerCase())
				// Prefer the whole query as one run (terms in order, optional whitespace between); fall back to per-term.
				const seq_re = new RegExp(search_terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), cs ? 'g' : 'gi')
				line_elements.forEach(element => {
					const text = element.textContent
					if (! text)
						return
					const text_node = element.firstChild
					if (! text_node || text_node.nodeType !== Node.TEXT_NODE)
						return
					const add = (/** @type {number} */ start, /** @type {number} */ end) => {
						const range = new Range()
						range.setStart(text_node, start)
						range.setEnd(text_node, end)
						ranges.push(range)
					}
					const seq = [...text.matchAll(seq_re)]
					if (seq.length) {
						seq.forEach(m => add(m.index, m.index + m[0].length))
						return
					}
					const haystack = cs ? text : text.toLowerCase()
					search_terms.forEach(term => {
						let index = 0
						while ((index = haystack.indexOf(term, index)) !== -1) {
							add(index, index + term.length)
							index += term.length
						}
					})
				})
			}
			if (ranges.length > 0) {
				const highlight = new Highlight(...ranges)
				CSS.highlights.set('search-match', highlight)
				active_ranges = ranges
			}
			log('highlight:', line_elements.length, 'line els,', ranges.length, 'ranges', (performance.now() - t_hl).toFixed(1) + 'ms')
		}
		// Capture the current selection as a stable identity (path + line) so it can be restored
		// after the results array is swapped (e.g. placeholder -> resolved line numbers).
		/** @returns {Selection|null} */
		const capture_selection = () => {
			const row = flat_rows.value[selected.value]
			if (! row)
				return null
			if (row.kind === 'dir')
				return { kind: 'dir', key: row.key }
			const path = file_at(row.fi).path
			if (row.kind === 'file')
				return { path, line: null }
			return { path, line: file_at(row.fi).matches[row.mi]?.line_number }
		}
		const restore_selection = (/** @type {Selection|null} */ sel) => {
			if (! sel) { selected.value = -1; return }
			const rows = flat_rows.value
			let idx = -1
			if (sel.kind === 'dir')
				idx = rows.findIndex(r => r.kind === 'dir' && r.key === sel.key)
			else if (sel.line == null)
				idx = rows.findIndex(r => r.kind === 'file' && file_at(r.fi).path === sel.path)
			else {
				idx = rows.findIndex(r => r.kind === 'match' && file_at(r.fi).path === sel.path && file_at(r.fi).matches[r.mi]?.line_number === sel.line)
				if (idx === -1) // line changed (placeholder -> real): fall back to the first match of that file
					idx = rows.findIndex(r => r.kind === 'match' && file_at(r.fi).path === sel.path)
				if (idx === -1)
					idx = rows.findIndex(r => r.kind !== 'dir' && file_at(r.fi).path === sel.path)
			}
			selected.value = idx
		}
		window.addEventListener('message', (event) => {
			const message = event.data
			if (message.type === 'results') {
				const fresh = message.query !== rendered_query
				rendered_query = message.query
				if (fresh)
					results_key.value++
				const final = message.phase === 'lines'
				// Streamed in time-budgeted chunks; each message carries the cumulative results so far
				// (a stable prefix -> no reorder). On a brand-new query (fresh) start clean (top, no
				// selection); on continuations of the same query keep scroll/selection/collapse state.
				// loading stays on until the final ('lines') chunk arrives.
				if (pending_reveal) { clearTimeout(pending_reveal); pending_reveal = null }
				const sel = fresh ? null : capture_selection()
				const container = results_container.value
				const prev_scroll = fresh ? 0 : container ? container.scrollTop : 0
				// Detach the live highlight ranges from the old rows BEFORE they are torn down: a live Range
				// still pointing into a .line-text node forces a synchronous revalidation on every node removal
				// (100ms+ teardowns for a modest list). Repointed to body here, then rebuilt post-render.
				const t_rel = performance.now()
				release_highlights()
				const t_assign = performance.now()
				results.value = /** @type {ResultFile[]} */ (message.results || []).map(r => markRaw(r))
				const t_done = performance.now()
				has_more.value = message.has_more
				if (message.workspace_folders)
					workspace_folders.value = message.workspace_folders
				loading.value = ! final
				log(final ? 'final:' : 'partial:', results.value.length, 'files,', (performance.now() - t_search_sent).toFixed(1) + 'ms since sent', '| release', (t_assign - t_rel).toFixed(1) + 'ms assign', (t_done - t_assign).toFixed(1) + 'ms')
				if (sel)
					file_limit.value = Infinity // need the full list to locate & keep the selection
				restore_selection(sel)
				if (selected.value !== -1) {
					file_limit.value = Infinity // need the whole list in the DOM to scroll to the selected row
					const row = flat_rows.value[selected.value]
					const parent = row?.kind === 'match' ? flat_rows.value.findIndex(r => r.kind === 'file' && r.fi === row.fi) : -1
					scroll_row_into_view(parent === -1 ? selected.value : parent, 'start')
					nextTick().then(highlight_search_terms)
				} else
					reveal(final ? 'final' : 'partial', () => {
						if (container)
							container.scrollTop = prev_scroll
					}, highlight_search_terms)
			} else if (message.type === 'results_live') {
				// In-place update after the index changed: drop files that no longer match and
				// refresh the matches of already-shown files (never add new file entries), keeping
				// collapse state, scroll position and the current selection.
				const new_by_path = new Map(/** @type {ResultFile[]} */ (message.results || []).map(r => [r.path, r]))
				const sel_row = flat_rows.value[selected.value]
				const sel_id = ! sel_row || sel_row.kind === 'dir'
					? null
					: sel_row.kind === 'file'
						? { path: file_at(sel_row.fi).path, line: null }
						: { path: file_at(sel_row.fi).path, line: file_at(sel_row.fi).matches[sel_row.mi]?.line_number }
				const container = results_container.value
				const prev_scroll = container ? container.scrollTop : 0
				release_highlights()
				results.value = results.value.flatMap(f => {
					const updated = new_by_path.get(f.path)
					return updated ? [markRaw(updated)] : []
				})
				has_more.value = message.has_more
				if (message.workspace_folders)
					workspace_folders.value = message.workspace_folders
				loading.value = false
				selected.value = ! sel_id
					? -1
					: flat_rows.value.findIndex(r =>
						sel_id.line == null
							? r.kind === 'file' && file_at(r.fi).path === sel_id.path
							: r.kind === 'match' && file_at(r.fi).path === sel_id.path && file_at(r.fi).matches[r.mi]?.line_number === sel_id.line)
				reveal('live', () => {
					if (container)
						container.scrollTop = prev_scroll
				}, highlight_search_terms)
			} else if (message.type === 'nav')
				nav(message.direction)
			else if (message.type === 'focus_search')
				focus_search()
		})
		window.addEventListener('keydown', on_keydown)
		onMounted(() => {
			search_input.value?.focus()
			if (search_query.value.trim())
				on_search_input()
		})
		return { search_query, include_query, exclude_query, case_sensitive, toggle_case, use_regex, toggle_regex, show_filters, view_mode, toggle_view_mode, results, has_more, loading, result_count_text, search_input, include_input, exclude_input, results_container, selected, flat_rows, dir_collapsed, collapsed_files, results_key, toggle_dir, row_key, on_search_input, on_search_blur, on_include_input, on_exclude_input, on_include_blur, on_exclude_blur, get_file_name, get_dir_path, open_match, toggle_file, is_file_selected, is_match_selected }
	},
}).mount('#app')
