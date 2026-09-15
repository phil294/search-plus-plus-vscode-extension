module.exports.EXT_NAME = 'Search++'
module.exports.EXT_ID = 'search++'
/** This is the default value of fergiemcdowall/search-index plus underscore. SQLite FTS splits automatically, TODO
but we need it for search also. TODO: or do we? Shared between the extension host and the indexing worker, so
this must not depend on `vscode`. */
module.exports.word_split_regex = /[\p{L}\d_]+/gu
