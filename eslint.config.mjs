import globals from 'globals'

import path from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'
import pluginJs from '@eslint/js'

// mimic CommonJS variables -- not needed if using CommonJS
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({ baseDirectory: __dirname, recommendedConfig: pluginJs.configs.recommended })

export default [
	{ files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
	{ languageOptions: { globals: { ...globals.node } } },
	...compat.extends('standard'),
	{
		rules: {
			'prefer-const': 'off',
			camelcase: 'off', // TODO: write manual something because eslint-plugin-snakecasejs doesn't work properly
			indent: ['error', 'tab'],
			quotes: ['error'],
			'no-tabs': 'off',
			'space-before-function-paren': ['error', {
				anonymous: 'never',
				named: 'never',
				asyncArrow: 'always',
			}],
			curly: ['error', 'multi'],
			'nonblock-statement-body-position': ['error', 'below'],
			'comma-dangle': ['error', 'always-multiline'],
			'func-style': ['error', 'declaration', { allowArrowFunctions: true }],
			'arrow-body-style': ['error', 'as-needed'],
			'no-return-assign': 'off',
			'no-throw-literal': 'off',
			'space-unary-ops': ['error', {
				words: true,
				nonwords: true,
				overrides: {
					'++': false,
					'--': false,
					'-': false,
				},
			}],
			'no-extra-parens': ['error', 'all'],
			'promise/param-names': 'off',
			'object-property-newline': 'off',
			'operator-linebreak': 'off',
		},
	},
]
