// Configuration ESLint commune (format « flat config »), partagée par l'API, le web et packages/shared.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	{
		ignores: [
			'**/dist/',
			'**/build/',
			'**/.svelte-kit/',
			'**/node_modules/',
			'maquette/',
			'**/migrations/',
			'**/test-results/',
			'**/playwright-report/'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.node, ...globals.browser } },
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			// Pas de console dans le code : on journalise avec pino (API) ; le web n'a rien à écrire en console.
			'no-console': 'error'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: { parserOptions: { parser: ts.parser, extraFileExtensions: ['.svelte'] } }
	},
	{
		// Les décorateurs de NestJS injectent les dépendances par leur type : l'import ne doit pas devenir « import type ».
		files: ['apps/api/**/*.ts'],
		rules: { '@typescript-eslint/consistent-type-imports': 'off' }
	},
	{
		files: ['scripts/**', '**/scripts/**', '**/*.config.{js,ts}', '**/test/**', '**/e2e/**'],
		rules: { 'no-console': 'off' }
	}
);
