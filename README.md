VSCode extension
# Search++

WORK IN PROGRESS, NOT USABLE YET

An instant, word-based full text search (FTS) alternative to VSCode's default search panel. Maintains an index on the contents of all files in your workspace.

Also adds massive word-based autocomplete for all files (can be deactivated).

![demo](./img/demo1.png)

autocomplete demo

## Usage

You can **install the extension in VSCode from [here](https://marketplace.visualstudio.com/items?itemName=phil294.search++)** or [here](https://open-vsx.org/extension/phil294/search++).

There are several configuration options, but you don't have to configure anything.

Once the initial scan is complete, searching for text in the side bar view is instant.

The extension will immediately start reading your workspace and maintain its index, even after reload. The index is written to disk and can take up significant amounts of space if your workspace is big. The first initial index per workspace takes roughly TODO seconds per total MB of text files - typically a total TODO to TODO seconds. The index then keeps watching all files for changes that aren't explicitly excluded with any of `"search.exclude"` / `"files.exclude"`, `"files.watcherExclude"`(¹) or `"search++.watcherExclude"`.

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