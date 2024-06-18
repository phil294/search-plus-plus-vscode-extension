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

## Large workspaces

Everything has been optimized for very large repositories. Even behemoths like Chromium source (more than 350,000 indexable files) behave instantaneously after the initial index which takes around five minutes. But for very large projects like these with many `.gitignore` files, you will be better off enabling the experimental, proposed extension API `findFiles2`. You'll get warnings if it affects you. The indexing can't be sped up, but with `findFiles2`, git-excluded files can be omitted much faster in the preceding *scanning* process (still to be optimized), resulting in less delay at every startup and possibly fixing unnecessary indexing. Enabling proposed api features is a bit complicated but explained [here](https://code.visualstudio.com/api/advanced-topics/using-proposed-api#sharing-extensions-using-the-proposed-api).

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

## Contributing

Please open issues in the [GitHub Repository](https://github.com/phil294/search++-vscode-extension) for feedback, bugs and feature requests. If you want to code for yourself, have a look into [CONTRIBUTING.md](./CONTRIBUTING.md) where the architecture is explained in more detail.

## Notes

(¹): `"files.watcherExclude"` and `"files.exclude"` do *not* extend from one another in *normal* search ([details](https://github.com/microsoft/
vscode/issues/76577)). But we follow both as Search++ is both a watcher and a search tool.