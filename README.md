VSCode extension

# Search++

An instant, word-based full text search (FTS) for search, autocomplete and go to definition.

Maintains an index on the contents of all files in your workspace. Optimized for speed and very large workspaces.


Features:

images coming soon

1. Instant alternative Search panel
1. Instant text-based Autocomplete
1. Instant text-based Go to definition fallback
1. (Not yet implemented: Instant File picker)

For all text files, regardless of language.

## Usage

You can **install the extension in VSCode from [here](https://marketplace.visualstudio.com/items?itemName=phil294.search++)** or [here](https://open-vsx.org/extension/phil294/search++).

<!-- There are several configuration options, but you don't have to configure anything. -->

Once the initial indexing is complete, all actions provided by this extension are instant, *regardless* of your workspace's size. You don't need to configure anything, things should just work.

## Behavior

Search++ will immediately start reading your workspace ("Scanning" in status bar) and maintain its index, even after reload.

The first initial indexing ("Indexing" in status bar) per workspace takes roughly 2 ms per indexable file, so typically just a few seconds per workspace. It's always safe to exit VSCode any time, after relaunching the indexing process will simply resume where it left off. The index is written to disk and takes up around 200 % in size of the indexable files themselves<!-- TODO: check again -->. Once complete, this process never has needs to run again, as the extension keeps monitoring your workspace for changes only.

A file is considered indexable if it isn't explicitly excluded with any of `"search.exclude"` / `"files.exclude"`, `"files.watcherExclude"`(¹) or `"search++.watcherExclude"` settings with the latter taking precedence if conflicting respectively, or listed in some `.gitignore`, `.rignore` or `.ignore` file. The extension keeps watching all indexable files for changes, based on their modification date.

All searches are performed case insensitive, results are case preserving.

## Large workspaces

Everything has been optimized for very large repositories. Behemoths like Chromium source (more than 350,000 indexable files) take about one hour for the initial indexing. There's still definitely room for indexing speed improvements, but once the onetime indexing is done, everything behaves instantaneously forever.

In some very large projects like these with many `.gitignore` files, there might be too much delay at startup and possibly unnecessary indexing. This is because we're still waiting for VSCode's new `findFiles2` proposal to be stabilized: https://github.com/microsoft/vscode/issues/48674. The indexing won't change, but with `findFiles2`, git-excluded files can be omitted much faster in the preceding *scanning* process, resulting in less delay at every startup and possibly fixing unnecessary indexing.

<!-- ## asdf

sdfsdf you can show he index location and the path of scanned directories with the command TODO.

Additionally, in the Search++ view itself, you can specify the filter fields "Files to include" and "Files to exclude", but this won't affect the indexing mechanism.

Special characters other than "normal" letters are skipped, you can only search for (partial) words, sentences etc. -->

## Roadmap

- Explore adding a file picker too to replace the default one which is also immensely slow
- Several configuration options
- Possible speed improvements, various TODOs in the code
- Performance comparison (below)
- Search view improvements such as shortcuts or maybe even regex

## Configuration

### X

TODO

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

There's a verbose log in `Output` > `Search++`. TODO: make optional

## Building

- `npm install`
- The extension does not use any sort of bundler for development or release. Just run it with the included launch script.

## Notable dependencies

- [SQLite FTS5 Extension](https://sqlite.org/fts5.html)
- [node-sqlite3-wasm](https://github.com/tndrle/node-sqlite3-wasm)
- [bevry/istextorbinary](https://github.com/bevry/istextorbinary)

## Notes

(¹): `"files.watcherExclude"` and `"files.exclude"` do *not* extend from one another in *normal* search ([details](https://github.com/microsoft/vscode/issues/76577)). But we follow both as Search++ is both a watcher and a search tool.