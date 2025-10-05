VSCode extension
# Search++

WORK IN PROGRESS, NOT USABLE YET

An instant, word-based full text search (FTS) alternative to VSCode's default search panel. Maintains an index on the contents of all files in your workspace. Optimized for speed and very large workspaces.

Also adds massive word-based autocomplete for all files (can be deactivated).

![demo](./img/demo1.png)

autocomplete demo

## Usage

You can **install the extension in VSCode from [here](https://marketplace.visualstudio.com/items?itemName=phil294.search++)** or [here](https://open-vsx.org/extension/phil294/search++).

There are several configuration options, but you don't have to configure anything.

Once the initial indexing is complete, searching for text in the side bar view is instant.

## Behavior

Search++ will immediately start reading your workspace ("Scanning" in status bar) and maintain its index, even after reload. The first initial indexing ("Indexing" in status bar) per workspace takes roughly 1 ms per indexable file - typically a total of 1 to 15 seconds per workspace. It's safe to exit VSCode any time, after relaunching the indexing process will simply resume where it left off. The index is written to disk and takes up around 30 % in size of the indexable files themselves. Once complete, this process has to normally never be repeated again. A file is considered indexable if it isn't explicitly excluded with any of `"search.exclude"` / `"files.exclude"`, `"files.watcherExclude"`(¹) or `"search++.watcherExclude"` settings with the latter taking precedence if conflicting respectively, or listed in some `.gitignore`, `.rignore` or `.ignore` file. The extension keeps watching all indexable files for changes, based on their modification date.

TODO: uses nodesqlite3wasm internally

TODO: package.json name casing not search++

## Large workspaces

Everything has been optimized for very large repositories. Behemoths like Chromium source (more than 350,000 indexable files) behave instantaneously after the initial index which takes around five minutes. But very large projects like these with many `.gitignore` files, there might be too much delay at startup and possibly unnecessary indexing. This is because we're still waiting for VSCode's new `findFiles2` proposal to be stabilized: https://github.com/microsoft/vscode/issues/48674. If you want to speed things up, you can enable the proposed extension API `findFiles2`. The indexing won't change, but with `findFiles2`, git-excluded files can be omitted much faster in the preceding *scanning* process, resulting in less delay at every startup and possibly fixing unnecessary indexing. Enabling proposed api features requires VSCode insiders edition and is a bit complicated but explained [here](https://code.visualstudio.com/api/advanced-topics/using-proposed-api#sharing-extensions-using-the-proposed-api).

## asdf

sdfsdf you can show he index location and the path of scanned directories with the command TODO.

Additionally, in the Search++ view itself, you can specify the filter fields "Files to include" and "Files to exclude", but this won't affect the indexing mechanism.

Special characters other than "normal" letters are skipped, you can only search for (partial) words, sentences etc.

## Features

- TODO

## Configuration

### X

TODO

### Other config options

```jsonc
// VSCode settings.json
{
    // TODO
    "search++.position": {
        "description": "Decide how/where the extension should appear. Changing this option REQUIRES RELOAD.",
        "type": "string",
        "default": "editor",
        "enum": [
            "editor",
            "view"
        ],
        "enumDescriptions": [
            "As a regular editor tab, so it will be treated like one of your open files",
            "As a view in the Source Control side nav section. You will also be able to drag it to any other place in the interface."
        ]
    },
}
```

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

The persistence layer is currently implemented using SQLite3's WASM build and its FTS5 extension. It might be worth exploring changing all of that to Ctags for better compatibility with other tools. Most likely, it'd be significantly slower though, and since this very extension is supposed to be a one-click-solution, people would be rather unlikely to start hacking with it. Ctags also follows somewhat different philosophies and is usually targetted towards a single language only.

## Contributing

https://github.com/bevry/istextorbinary/issues/307

Please open issues in the [GitHub Repository](https://github.com/phil294/search++-vscode-extension) for feedback, bugs and feature requests. If you want to code for yourself, have a look into [CONTRIBUTING.md](./CONTRIBUTING.md) where the architecture is explained in more detail.

## Notes

(¹): `"files.watcherExclude"` and `"files.exclude"` do *not* extend from one another in *normal* search ([details](https://github.com/microsoft/
vscode/issues/76577)). But we follow both as Search++ is both a watcher and a search tool.