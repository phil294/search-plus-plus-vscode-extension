import globals from 'globals'
import neostandard from 'neostandard'

export default
neostandard({})
	.concat([
		{ ignores: ['.vscode/.history', 'todo*', 'node_modules', 'vsix-out', 'src/lib'] },
		{ files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
		{ languageOptions: { globals: { ...globals.node } } },
		{
			rules: {
				'prefer-const': 'off',
				camelcase: 'off', // TODO: write manual something because eslint-plugin-snakecasejs doesn't work properly
				'@stylistic/indent': ['error', 'tab'],
				// quotes: ['error'],
				'@stylistic/no-tabs': 'off',
				'@stylistic/space-before-function-paren': ['error', {
					anonymous: 'never',
					named: 'never',
					asyncArrow: 'always',
				}],
				curly: ['error', 'multi'],
				'nonblock-statement-body-position': ['error', 'below'],
				'comma-dangle': ['error', 'always-multiline'],
				'@stylistic/comma-dangle': 'off',
				'func-style': ['error', 'declaration', { allowArrowFunctions: true }],
				'arrow-body-style': ['error', 'as-needed'],
				'no-return-assign': 'off',
				'no-throw-literal': 'off',
				'@stylistic/space-unary-ops': ['error', {
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
				'@stylistic/object-property-newline': 'off',
				'@stylistic/operator-linebreak': 'off',
				'no-void': 'off',
			},
		},
	])
