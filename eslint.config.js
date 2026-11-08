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
		// Lot 04 (CLAUDE.md §8) : aucune lecture des tables d'interrupteurs hors du module features, et la connexion
		// app_admin (back-office) n'est utilisée que par le module admin. Vérifié aussi par test/architecture.test.ts.
		files: ['apps/api/src/**/*.ts'],
		ignores: ['apps/api/src/modules/features/**'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/db/schema/features', '**/db/schema/features.js', '**/schema/features.js'],
							message: 'Tables d’interrupteurs : passer par FeaturesService (module features).'
						},
						{
							group: ['**/admin/admin-database.service', '**/admin/admin-database.service.js', './admin-database.service.js'],
							message: 'Connexion app_admin réservée au module admin.'
						}
					]
				}
			]
		}
	},
	{
		// Le module admin, lui, détient sa connexion ; il passe toujours par le module features pour les interrupteurs.
		files: ['apps/api/src/modules/admin/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/db/schema/features', '**/db/schema/features.js'],
							message: 'Tables d’interrupteurs : passer par FeaturesService (module features).'
						}
					]
				}
			]
		}
	},
	{
		files: ['scripts/**', '**/scripts/**', '**/*.config.{js,ts}', '**/test/**', '**/e2e/**'],
		rules: { 'no-console': 'off' }
	}
);
