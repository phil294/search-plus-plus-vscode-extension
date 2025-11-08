// The code below is taken from https://github.com/bevry/istextorbinary,
// Copyright Benjamin Lupton,
// and licensed under Artistic License 2.0, attached below.

// Copied and reformatted into non-TS-CJS due to packaging issues (https://github.com/bevry/istextorbinary/issues/307)

/*
	# License

	Unless stated otherwise all works are:

	-   Copyright &copy; [Benjamin Lupton](https://balupton.com)

	and licensed under:

	-   [Artistic License 2.0](http://spdx.org/licenses/Artistic-2.0.html)

	## The Artistic License 2.0

	<pre>
	Copyright (c) 2000-2006, The Perl Foundation.

	Everyone is permitted to copy and distribute verbatim copies of this license document, but changing it is not allowed.

	Preamble

	This license establishes the terms under which a given free software Package may be copied, modified, distributed, and/or redistributed. The intent is that the Copyright Holder maintains some artistic control over the development of that Package while still keeping the Package available as open source and free software.

	You are always permitted to make arrangements wholly outside of this license directly with the Copyright Holder of a given Package.  If the terms of this license do not permit the full use that you propose to make of the Package, you should contact the Copyright Holder and seek a different licensing arrangement.

	Definitions

		"Copyright Holder" means the individual(s) or organization(s) named in the copyright notice for the entire Package.

		"Contributor" means any party that has contributed code or other material to the Package, in accordance with the Copyright Holder's procedures.

		"You" and "your" means any person who would like to copy, distribute, or modify the Package.

		"Package" means the collection of files distributed by the Copyright Holder, and derivatives of that collection and/or of those files. A given Package may consist of either the Standard Version, or a Modified Version.

		"Distribute" means providing a copy of the Package or making it accessible to anyone else, or in the case of a company or organization, to others outside of your company or organization.

		"Distributor Fee" means any fee that you charge for Distributing this Package or providing support for this Package to another party.  It does not mean licensing fees.

		"Standard Version" refers to the Package if it has not been modified, or has been modified only in ways explicitly requested by the Copyright Holder.

		"Modified Version" means the Package, if it has been changed, and such changes were not explicitly requested by the Copyright Holder.

		"Original License" means this Artistic License as Distributed with the Standard Version of the Package, in its current version or as it may be modified by The Perl Foundation in the future.

		"Source" form means the source code, documentation source, and configuration files for the Package.

		"Compiled" form means the compiled bytecode, object code, binary, or any other form resulting from mechanical transformation or translation of the Source form.

	Permission for Use and Modification Without Distribution

	(1) You are permitted to use the Standard Version and create and use Modified Versions for any purpose without restriction, provided that you do not Distribute the Modified Version.

	Permissions for Redistribution of the Standard Version

	(2) You may Distribute verbatim copies of the Source form of the Standard Version of this Package in any medium without restriction, either gratis or for a Distributor Fee, provided that you duplicate all of the original copyright notices and associated disclaimers.  At your discretion, such verbatim copies may or may not include a Compiled form of the Package.

	(3) You may apply any bug fixes, portability changes, and other modifications made available from the Copyright Holder.  The resulting Package will still be considered the Standard Version, and as such will be subject to the Original License.

	Distribution of Modified Versions of the Package as Source

	(4) You may Distribute your Modified Version as Source (either gratis or for a Distributor Fee, and with or without a Compiled form of the Modified Version) provided that you clearly document how it differs from the Standard Version, including, but not limited to, documenting any non-standard features, executables, or modules, and provided that you do at least ONE of the following:

		(a) make the Modified Version available to the Copyright Holder of the Standard Version, under the Original License, so that the Copyright Holder may include your modifications in the Standard Version.
		(b) ensure that installation of your Modified Version does not prevent the user installing or running the Standard Version. In addition, the Modified Version must bear a name that is different from the name of the Standard Version.
		(c) allow anyone who receives a copy of the Modified Version to make the Source form of the Modified Version available to others under

			(i) the Original License or
			(ii) a license that permits the licensee to freely copy, modify and redistribute the Modified Version using the same licensing terms that apply to the copy that the licensee received, and requires that the Source form of the Modified Version, and of any works derived from it, be made freely available in that license fees are prohibited but Distributor Fees are allowed.

	Distribution of Compiled Forms of the Standard Version or Modified Versions without the Source

	(5)  You may Distribute Compiled forms of the Standard Version without the Source, provided that you include complete instructions on how to get the Source of the Standard Version.  Such instructions must be valid at the time of your distribution.  If these instructions, at any time while you are carrying out such distribution, become invalid, you must provide new instructions on demand or cease further distribution. If you provide valid instructions or cease distribution within thirty days after you become aware that the instructions are invalid, then you do not forfeit any of your rights under this license.

	(6)  You may Distribute a Modified Version in Compiled form without the Source, provided that you comply with Section 4 with respect to the Source of the Modified Version.

	Aggregating or Linking the Package

	(7)  You may aggregate the Package (either the Standard Version or Modified Version) with other packages and Distribute the resulting aggregation provided that you do not charge a licensing fee for the Package.  Distributor Fees are permitted, and licensing fees for other components in the aggregation are permitted. The terms of this license apply to the use and Distribution of the Standard or Modified Versions as included in the aggregation.

	(8) You are permitted to link Modified and Standard Versions with other works, to embed the Package in a larger work of your own, or to build stand-alone binary or bytecode versions of applications that include the Package, and Distribute the result without restriction, provided the result does not expose a direct interface to the Package.

	Items That are Not Considered Part of a Modified Version

	(9) Works (including, but not limited to, modules and scripts) that merely extend or make use of the Package, do not, by themselves, cause the Package to be a Modified Version.  In addition, such works are not considered parts of the Package itself, and are not subject to the terms of this license.

	General Provisions

	(10)  Any use, modification, and distribution of the Standard or Modified Versions is governed by this Artistic License. By using, modifying or distributing the Package, you accept this license. Do not use, modify, or distribute the Package, if you do not accept this license.

	(11)  If your Modified Version has been derived from a Modified Version made by someone other than you, you are nevertheless required to ensure that your Modified Version complies with the requirements of this license.

	(12)  This license does not grant you the right to use any trademark, service mark, tradename, or logo of the Copyright Holder.

	(13)  This license includes the non-exclusive, worldwide, free-of-charge patent license to make, have made, use, offer to sell, sell, import and otherwise transfer the Package with respect to any patent claims licensable by the Copyright Holder that are necessarily infringed by the Package. If you institute patent litigation (including a cross-claim or counterclaim) against any party alleging that the Package constitutes direct or contributory patent infringement, then this Artistic License to you shall terminate on the date that such litigation is filed.

	(14)  Disclaimer of Warranty:
	THE PACKAGE IS PROVIDED BY THE COPYRIGHT HOLDER AND CONTRIBUTORS "AS IS" AND WITHOUT ANY EXPRESS OR IMPLIED WARRANTIES. THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT ARE DISCLAIMED TO THE EXTENT PERMITTED BY YOUR LOCAL LAW. UNLESS REQUIRED BY LAW, NO COPYRIGHT HOLDER OR CONTRIBUTOR WILL BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES ARISING IN ANY WAY OUT OF THE USE OF THE PACKAGE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
	</pre>
*/

const textExtensions = [
	'Dockerfile',
	'Makefile',
	'Rakefile',
	'ada',
	'adb',
	'ads',
	'applescript',
	'as',
	'ascx',
	'asm',
	'asmx',
	'asp',
	'aspx',
	'atom',
	'bas',
	'bash',
	'bashrc',
	'bat',
	'bbcolors',
	'bdsgroup',
	'bdsproj',
	'bib',
	'bowerrc',
	'c',
	'cbl',
	'cc',
	'cfc',
	'cfg',
	'cfm',
	'cfml',
	'cgi',
	'clj',
	'cls',
	'cmake',
	'cmd',
	'cnf',
	'cob',
	'coffee',
	'coffeekup',
	'conf',
	'cpp',
	'cpt',
	'cpy',
	'crt',
	'cs',
	'csh',
	'cson',
	'csr',
	'css',
	'csslintrc',
	'csv',
	'ctl',
	'curlrc',
	'cxx',
	'dart',
	'dfm',
	'diff',
	'dockerignore',
	'dof',
	'dpk',
	'dproj',
	'dtd',
	'eco',
	'editorconfig',
	'ejs',
	'el',
	'emacs',
	'eml',
	'ent',
	'erb',
	'erl',
	'eslintignore',
	'eslintrc',
	'ex',
	'exs',
	'f',
	'f03',
	'f77',
	'f90',
	'f95',
	'fish',
	'for',
	'fpp',
	'frm',
	'ftn',
	'gemrc',
	'gitattributes',
	'gitconfig',
	'gitignore',
	'gitkeep',
	'gitmodules',
	'go',
	'gpp',
	'gradle',
	'groovy',
	'groupproj',
	'grunit',
	'gtmpl',
	'gvimrc',
	'h',
	'haml',
	'hbs',
	'hgignore',
	'hh',
	'hpp',
	'hrl',
	'hs',
	'hta',
	'htaccess',
	'htc',
	'htm',
	'html',
	'htpasswd',
	'hxx',
	'iced',
	'inc',
	'ini',
	'ino',
	'int',
	'irbrc',
	'itcl',
	'itermcolors',
	'itk',
	'jade',
	'java',
	'jhtm',
	'jhtml',
	'js',
	'jscsrc',
	'jshintignore',
	'jshintrc',
	'json',
	'json5',
	'jsonld',
	'jsp',
	'jspx',
	'jsx',
	'ksh',
	'less',
	'lhs',
	'lisp',
	'log',
	'ls',
	'lsp',
	'lua',
	'm',
	'mak',
	'map',
	'markdown',
	'master',
	'md',
	'mdown',
	'mdwn',
	'mdx',
	'metadata',
	'mht',
	'mhtml',
	'mjs',
	'mk',
	'mkd',
	'mkdn',
	'mkdown',
	'ml',
	'mli',
	'mm',
	'mxml',
	'nfm',
	'nfo',
	'njk',
	'noon',
	'npmignore',
	'npmrc',
	'nvmrc',
	'ops',
	'pas',
	'pasm',
	'patch',
	'pbxproj',
	'pch',
	'pem',
	'pg',
	'php',
	'php3',
	'php4',
	'php5',
	'phpt',
	'phtml',
	'pir',
	'pl',
	'pm',
	'pmc',
	'pod',
	'pot',
	'properties',
	'props',
	'pt',
	'pug',
	'py',
	'r',
	'rake',
	'rb',
	'rdoc',
	'rdoc_options',
	'resx',
	'rhtml',
	'rjs',
	'rlib',
	'rmd',
	'ron',
	'rs',
	'rss',
	'rst',
	'rtf',
	'rvmrc',
	'rxml',
	's',
	'sass',
	'scala',
	'scm',
	'scss',
	'seestyle',
	'sh',
	'shtml',
	'sls',
	'spec',
	'sql',
	'sqlite',
	'ss',
	'sss',
	'st',
	'strings',
	'sty',
	'styl',
	'stylus',
	'sub',
	'sublime-build',
	'sublime-commands',
	'sublime-completions',
	'sublime-keymap',
	'sublime-macro',
	'sublime-menu',
	'sublime-project',
	'sublime-settings',
	'sublime-workspace',
	'sv',
	'svc',
	'svg',
	't',
	'tcl',
	'tcsh',
	'terminal',
	'tex',
	'text',
	'textile',
	'tg',
	'tmLanguage',
	'tmTheme',
	'tmpl',
	'toml',
	'tpl',
	'ts',
	'tsv',
	'tsx',
	'tt',
	'tt2',
	'ttml',
	'txt',
	'v',
	'vb',
	'vbs',
	'vh',
	'vhd',
	'vhdl',
	'vim',
	'viminfo',
	'vimrc',
	'vue',
	'webapp',
	'wxml',
	'wxss',
	'x-php',
	'xaml',
	'xht',
	'xhtml',
	'xml',
	'xs',
	'xsd',
	'xsl',
	'xslt',
	'yaml',
	'yml',
	'zsh',
	'zshrc',
]

const binaryExtensions = [
	'dds',
	'eot',
	'gif',
	'ico',
	'jar',
	'jpeg',
	'jpg',
	'pdf',
	'png',
	'swf',
	'tga',
	'ttf',
	'zip',
]

const pathUtil = require('path')

/**
 * Determine if the filename and/or buffer is text.
 * Determined by extension checks first (if filename is available), otherwise if unknown extension or no filename, will perform a slower buffer encoding detection.
 * This order is done, as extension checks are quicker, and also because encoding checks cannot guarantee accuracy for chars between utf8 and utf16.
 * The extension checks are performed using the resources https://github.com/bevry/textextensions and https://github.com/bevry/binaryextensions
 * @param filename The filename for the file/buffer if available
 * @param buffer The buffer for the file if available
 * @returns Will be `null` if neither `filename` nor `buffer` were provided. Otherwise will be a boolean value with the detection result.
 */
module.exports.isText = function(
	filename,
	buffer
) {
	// Test extensions
	if (filename) {
		// Extract filename
		const parts = pathUtil.basename(filename).split('.').reverse()

		// Cycle extensions
		for (const extension of parts) {
			if (textExtensions.indexOf(extension) !== -1) {
				return true
			}
			if (binaryExtensions.indexOf(extension) !== -1) {
				return false
			}
		}
	}

	// Fallback to encoding if extension check was not enough
	if (buffer) {
		return module.exports.getEncoding(buffer) === 'utf8'
	}

	// No buffer was provided
	return null
}

/**
 * Determine if the filename and/or buffer is binary.
 * Determined by extension checks first (if filename is available), otherwise if unknown extension or no filename, will perform a slower buffer encoding detection.
 * This order is done, as extension checks are quicker, and also because encoding checks cannot guarantee accuracy for chars between utf8 and utf16.
 * The extension checks are performed using the resources https://github.com/bevry/textextensions and https://github.com/bevry/binaryextensions
 * @param filename The filename for the file/buffer if available
 * @param buffer The buffer for the file if available
 * @returns Will be `null` if neither `filename` nor `buffer` were provided. Otherwise will be a boolean value with the detection result.
 */
module.exports.isBinary = function(filename, buffer) {
	const text = module.exports.isText(filename, buffer)
	if (text == null) return null
	return !text
}

/**
 * Get the encoding of a buffer.
 * Checks the start, middle, and end of the buffer for characters that are unrecognized within UTF8 encoding.
 * History has shown that inspection at all three locations is necessary.
 * @returns Will be `null` if `buffer` was not provided. Otherwise will be either `'utf8'` or `'binary'`
 */
module.exports.getEncoding = function(
	buffer,
	opts
) {
	// Check
	if (!buffer) return null

	// Prepare
	const textEncoding = 'utf8'
	const binaryEncoding = 'binary'
	const chunkLength = opts?.chunkLength ?? 24
	let chunkBegin = opts?.chunkBegin ?? 0

	// Discover
	if (opts?.chunkBegin == null) {
		// Start
		let encoding = module.exports.getEncoding(buffer, { chunkLength, chunkBegin })
		if (encoding === textEncoding) {
			// Middle
			chunkBegin = Math.max(0, Math.floor(buffer.length / 2) - chunkLength)
			encoding = module.exports.getEncoding(buffer, {
				chunkLength,
				chunkBegin,
			})
			if (encoding === textEncoding) {
				// End
				chunkBegin = Math.max(0, buffer.length - chunkLength)
				encoding = module.exports.getEncoding(buffer, {
					chunkLength,
					chunkBegin,
				})
			}
		}

		// Return
		return encoding
	} else {
		// Extract
		chunkBegin = getChunkBegin(buffer, chunkBegin)
		if (chunkBegin === -1) {
			return binaryEncoding
		}

		const chunkEnd = getChunkEnd(
			buffer,
			Math.min(buffer.length, chunkBegin + chunkLength)
		)

		if (chunkEnd > buffer.length) {
			return binaryEncoding
		}

		const contentChunkUTF8 = buffer.toString(textEncoding, chunkBegin, chunkEnd)

		// Detect encoding
		for (let i = 0; i < contentChunkUTF8.length; ++i) {
			const charCode = contentChunkUTF8.charCodeAt(i)
			if (charCode === 65533 || charCode <= 8) {
				// 8 and below are control characters (e.g. backspace, null, eof, etc.)
				// 65533 is the unknown character
				// console.log(charCode, contentChunkUTF8[i])
				return binaryEncoding
			}
		}

		// Return
		return textEncoding
	}
}

// ====================================
// The functions below are created to handle multibyte utf8 characters.
// To understand how the encoding works, check this article: https://en.wikipedia.org/wiki/UTF-8#Encoding
// @todo add documentation for these

function getChunkBegin(buf, chunkBegin) {
	// If it's the beginning, just return.
	if (chunkBegin === 0) {
		return 0
	}

	if (!isLaterByteOfUtf8(buf[chunkBegin])) {
		return chunkBegin
	}

	let begin = chunkBegin - 3

	if (begin >= 0) {
		if (isFirstByteOf4ByteChar(buf[begin])) {
			return begin
		}
	}

	begin = chunkBegin - 2

	if (begin >= 0) {
		if (
			isFirstByteOf4ByteChar(buf[begin]) ||
			isFirstByteOf3ByteChar(buf[begin])
		) {
			return begin
		}
	}

	begin = chunkBegin - 1

	if (begin >= 0) {
		// Is it a 4-byte, 3-byte utf8 character?
		if (
			isFirstByteOf4ByteChar(buf[begin]) ||
			isFirstByteOf3ByteChar(buf[begin]) ||
			isFirstByteOf2ByteChar(buf[begin])
		) {
			return begin
		}
	}

	return -1
}

function getChunkEnd(buf, chunkEnd) {
	// If it's the end, just return.
	if (chunkEnd === buf.length) {
		return chunkEnd
	}

	let index = chunkEnd - 3

	if (index >= 0) {
		if (isFirstByteOf4ByteChar(buf[index])) {
			return chunkEnd + 1
		}
	}

	index = chunkEnd - 2

	if (index >= 0) {
		if (isFirstByteOf4ByteChar(buf[index])) {
			return chunkEnd + 2
		}

		if (isFirstByteOf3ByteChar(buf[index])) {
			return chunkEnd + 1
		}
	}

	index = chunkEnd - 1

	if (index >= 0) {
		if (isFirstByteOf4ByteChar(buf[index])) {
			return chunkEnd + 3
		}

		if (isFirstByteOf3ByteChar(buf[index])) {
			return chunkEnd + 2
		}

		if (isFirstByteOf2ByteChar(buf[index])) {
			return chunkEnd + 1
		}
	}

	return chunkEnd
}

function isFirstByteOf4ByteChar(byte) {
	return byte >> 3 === 30 // 11110xxx?
}

function isFirstByteOf3ByteChar(byte) {
	return byte >> 4 === 14 // 1110xxxx?
}

function isFirstByteOf2ByteChar(byte) {
	return byte >> 5 === 6 // 110xxxxx?
}

function isLaterByteOfUtf8(byte) {
	return byte >> 6 === 2 // 10xxxxxx?
}
