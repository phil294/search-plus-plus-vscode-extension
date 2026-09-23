VSCode extension

# Search++

An instant, word-based full text search (FTS) for search, autocomplete and go to definition.

Maintains an index on the contents of all files in your workspace. Optimized for speed and very large workspaces.


Features:

images coming soon

1. Instant alternative Search panel<br>
   <img width="495" height="284" alt="image" src="https://github.com/user-attachments/assets/b0ae1e49-dd6c-4f92-8497-081a6c7501f3" />
1. Instant text-based Autocomplete<br>
   <img width="1097" height="299" alt="image" src="https://github.com/user-attachments/assets/ef994053-456d-4b48-85e0-d2f91a989614" />
1. Instant text-based Go to definition fallback<br>
   <img width="745" height="235" alt="image" src="https://github.com/user-attachments/assets/59d82ee5-7c87-4a84-aa95-f24d0c9bcfc7" />

1. Instant File picker (Go to File / Go to Text), a fast drop-in for the built-in ones

For all text files, regardless of language.

## Usage

You can **install the extension in VSCode from [the marketplace here](https://marketplace.visualstudio.com/items?itemName=phil294.search-plusplus)** or [Open VSX here](https://open-vsx.org/extension/phil294/search-plusplus).

<!-- There are several configuration options, but you don't have to configure anything. -->

Once the initial indexing is complete, all actions provided by this extension are instant, *regardless* of your workspace's size. You don't need to configure anything, things should just work.

## Behavior

Search++ will immediately start reading your workspace ("Scanning" in status bar) and maintain its index, even after reload.

The first initial indexing ("Indexing" in status bar) per workspace takes roughly 2 ms per indexable file, so typically just a few seconds per workspace. <img width="149" height="32" alt="image" src="https://github.com/user-attachments/assets/8c0f728f-18bc-4d03-8d56-2d7fb8d20539" /> It's always safe to exit VSCode any time, after relaunching the indexing process will simply resume where it left off. The index is written to disk and takes up around 200 % in size of the indexable files themselves<!-- TODO: check again -->. Once complete, this process never has needs to run again, as the extension keeps monitoring your workspace for changes only.

A file is considered indexable if it isn't explicitly excluded with any of `"search.exclude"` / `"files.exclude"`, `"files.watcherExclude"`(¹) or `"search++.watcherExclude"` settings with the latter taking precedence if conflicting respectively, or listed in some `.gitignore`, `.rignore` or `.ignore` file. The extension keeps watching all indexable files for changes, based on their modification date.

All searches are performed case insensitive, results are case preserving.

## Full takeover from the built-in search

Search++ ships commands but deliberately does *not* rebind VSCode's built-in shortcuts, so it stays unobtrusive by default. If you want Search++ to fully replace the (slow, on very large repos) built-in Search, Go to File and Go to Symbol, add the snippet below to your `keybindings.json` (Command Palette → *Preferences: Open Keyboard Shortcuts (JSON)*).

The `-` prefixed entries unbind the built-in commands; the others map the same keys to Search++.

```json
[
    { "key": "ctrl+shift+f", "command": "-workbench.action.findInFiles" },
    { "key": "ctrl+shift+f", "command": "search++.search" },

    { "key": "ctrl+p", "command": "-workbench.action.quickOpen" },
    { "key": "ctrl+p", "command": "search++.filePicker" },

    { "key": "ctrl+shift+o", "command": "-workbench.action.gotoSymbol" },
    { "key": "ctrl+shift+o", "command": "search++.goToTextInFile" },

    { "key": "ctrl+t", "command": "-workbench.action.showAllSymbols" },
    { "key": "ctrl+t", "command": "search++.goToTextInWorkspace" }
]
```

On macOS, replace `ctrl` with `cmd`.

The file picker understands the same prefixes as the built-in one, so a single binding is enough if you prefer: type nothing to search files by name (append `:123` to jump to a line), prefix `@` to search text in the current file, or `#` to search text across the whole workspace.

Within the Search++ view, results are navigable entirely from the keyboard, just like the built-in Search view: `ArrowUp`/`ArrowDown` move through files and matches, `ArrowLeft`/`ArrowRight` collapse/expand a file, `Enter` opens the selected match, and `Escape` returns to the search box. `F4` / `Shift+F4` jump to the next / previous match (these two are bound automatically).

## Large workspaces

Everything has been optimized for very large repositories. Behemoths like Chromium source (more than 350,000 indexable files) take about one hour for the initial indexing. There's still definitely room for indexing speed improvements, but once the onetime indexing is done, everything behaves instantaneously forever.

Scanning (finding the non-ignored files to index) is done with [ripgrep](https://github.com/BurntSushi/ripgrep), bundled via `@vscode/ripgrep`. It honours your `.gitignore`/`.ignore`/`.rgignore` files natively and very quickly, so even workspaces with many `.gitignore` files start up fast. The actual indexing runs in a separate worker thread, so it never blocks the editor UI.

<!-- ## asdf

sdfsdf you can show he index location and the path of scanned directories with the command TODO.

Additionally, in the Search++ view itself, you can specify the filter fields "Files to include" and "Files to exclude", but this won't affect the indexing mechanism.

Special characters other than "normal" letters are skipped, you can only search for (partial) words, sentences etc. -->

## Roadmap

- Several configuration options
- Possible speed improvements, various TODOs in the code
- Performance comparison (below)
- Search view improvements such as maybe even regex

## Configuration

You don't need to configure anything — every setting is optional. Search++ contributes the settings below, and additionally honours several native VSCode settings so it behaves like the built-in tools.

### Search++ settings

```jsonc
{
    // Additional exclude globs for indexing, same { "**/glob": true } format as
    // files.watcherExclude / search.exclude. Takes precedence over all of them.
    "search++.watcherExclude": {},

    // Skip full-text indexing of files larger than this many megabytes (they stay
    // listed in the file picker). Applies to newly added/changed files only; run
    // "Search++: Rebuild Index" to apply it to the whole workspace.
    "search++.maxIndexSizeMb": 20,

    // Skip full-text indexing of files whose average line length exceeds this
    // (minified / generated / data files stay listed name-only). Applies to newly
    // added/changed files only; run "Search++: Rebuild Index" to apply everywhere.
    "search++.maxAverageLineLength": 300,

    // Override search.useIgnoreFiles for indexing (null = inherit the native value).
    // false also full-text indexes gitignored files, e.g. vendored dependencies.
    "search++.useIgnoreFiles": null,

    // Override search.useGlobalIgnoreFiles for indexing (null = inherit).
    "search++.useGlobalIgnoreFiles": null,

    // Verbose debug output to the "Search++" output channel. Keep off for normal use.
    "search++.verboseLogging": false
}
```

The ignore/exclude settings apply live — changing one re-indexes affected files with no reload. The two `max…` limits above apply only to files added or changed afterwards; to apply them to the entire existing index, run the **Search++: Rebuild Index** command (Command Palette), which wipes the index and reindexes from scratch. Rebuilding a very large workspace can take a while, so it's mainly meant for troubleshooting.

### Honoured VSCode settings

- `search.exclude`, `files.exclude`, `files.watcherExclude` — files excluded from indexing (see [Behavior](#behavior) for precedence).
- `search.useIgnoreFiles` — honour `.gitignore` / `.ignore` (unless overridden by `search++.useIgnoreFiles`).
- `search.useGlobalIgnoreFiles` — honour the global gitignore (unless overridden by `search++.useGlobalIgnoreFiles`).
- `workbench.quickOpen.preserveInput` — whether the file picker keeps your last query when reopened.

## Performance

### Comparison with other IDEs

TODO

## Why not LSP?

This extension might as well be an LSP ([Language Server Protocol](https://microsoft.github.io/language-server-protocol/)). However, this would mean we couldn't use the convenient `findFiles2()` and `createFileSystemWatcher()` provided by VSCode extension API. The former even takes care of gitignored files, among other things. Internally, it uses ripgrep which is shipped alongside every VSCode installation. If one were to port this project to LSP, the challenges are:

- Bundle ripgrep cross-platform somehow for a `findFiles` replacement, or explore alternatives
- Include a cross-platform file watcher library
- Properly handle multiple workspaces, adding more configuration options
- Pass on relevant VSCode settings to the server
- Persist the index to a configurable location on the system somewhere
- Figure out how to trigger progress bar updates in the client in a compatible way (scanning / indexing)
- Implement the common layers for doComplete, lookupDefinitions etc

All of that is possible, but poses significant additional work, that's why it hasn't been done so far.

## Search Provider

Currently needs its own view because providing results for default search view is not yet stable (even though the api exists since 2019) and even once it's stable, it most likely will only work with virtual file systems:

https://github.com/microsoft/vscode/issues/59921#issuecomment-3368450657

Tree view inputs also missing, need web views right now:

https://github.com/microsoft/vscode/issues/97190

## Ctags

Search++ is similar to [Ctags](https://en.wikipedia.org/wiki/Ctags), but in contrary to the latter, it does not require you to configure anything, and it keeps watching your files, and it integrates nicely with VSCode.

The persistence layer is currently implemented using SQLite3's WASM build and its FTS5 extension. It might be worth exploring changing all of that to Ctags for better compatibility with other tools. Most likely, it'd be significantly slower though, and since this very extension is supposed to be a one-click-solution, people would be rather unlikely to start hacking with it. Ctags also follows somewhat different philosophies and is usually targetted towards a single language only. It also has no support for fast partial matches mid-word.

## Contributing

Please open issues in the [GitHub Repository](https://github.com/phil294/search-plus-plus-vscode-extension) for feedback, bugs and feature requests.

## Debugging

There's an optional verbose log in `Output` > `Search++`. It is disabled by default; enable the `search++.verboseLogging` setting to turn it on (no reload required).

> [!WARNING]
> Keep `search++.verboseLogging` **off** for normal use. It emits one log line per file, which on large workspaces means tens of thousands of messages to the `Output` channel and can stall the extension host for minutes during indexing, drastically slowing it down. Only enable it briefly for troubleshooting. Indexing timings and milestones are always logged, even with verbose logging off.

## Building

- `npm install`
- The extension does not use any sort of bundler for development or release. Just run it with the included launch script.

## Notable dependencies

- [SQLite FTS5 Extension](https://sqlite.org/fts5.html)
- [node-sqlite3-wasm](https://github.com/tndrle/node-sqlite3-wasm)
- [bevry/istextorbinary](https://github.com/bevry/istextorbinary)

## Notes

(¹): `"files.watcherExclude"` and `"files.exclude"` do *not* extend from one another in *normal* search ([details](https://github.com/microsoft/vscode/issues/76577)). But we follow both as Search++ is both a watcher and a search tool.
