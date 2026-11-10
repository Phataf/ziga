// Configuration ESLint commune (format « flat config »), partagée par l'API, le web et packages/shared.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

/** Imports réservés à un module (CLAUDE.md §4) : chaque bloc ci-dessous liste ceux qui restent interdits. */
const RESTRICTED_IMPORTS = {
	features: {
		group: ['**/db/schema/features', '**/db/schema/features.js', '**/schema/features.js'],
		message: 'Tables d’interrupteurs : passer par FeaturesService (module features).'
	},
	admin: {
		group: ['**/admin/admin-database.service', '**/admin/admin-database.service.js', './admin-database.service.js'],
		message: 'Connexion app_admin réservée au module admin.'
	},
	sync: {
		group: ['**/db/schema/sync', '**/db/schema/sync.js'],
		message: 'Table sync_operations : réservée au module sync (lot 05).'
	},
	owners: {
		group: ['**/db/schema/owners', '**/db/schema/owners.js'],
		message: 'Propriétaires et mandats : passer par OwnersService (module owners, lot 06).'
	},
	properties: {
		group: ['**/db/schema/properties', '**/db/schema/properties.js'],
		message: 'Biens et unités : passer par PropertiesService (module properties, lot 07).'
	}
};

function restrictImports(...keys) {
	return { 'no-restricted-imports': ['error', { patterns: keys.map((k) => RESTRICTED_IMPORTS[k]) }] };
}

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
		// app_admin (back-office) n'est utilisée que par le module admin. Lots 05 et 06 (§4) : les tables d'un module ne
		// sont lues et écrites que par lui. Vérifié aussi par src/architecture.test.ts.
		files: ['apps/api/src/**/*.ts'],
		ignores: ['apps/api/src/modules/features/**'],
		rules: restrictImports('features', 'admin', 'sync', 'owners', 'properties')
	},
	{
		// Le module admin, lui, détient sa connexion ; il passe toujours par le module features pour les interrupteurs.
		files: ['apps/api/src/modules/admin/**/*.ts'],
		rules: restrictImports('features', 'sync', 'owners', 'properties')
	},
	{
		// Le module sync détient la table sync_operations ; les autres règles d'import restent.
		files: ['apps/api/src/modules/sync/**/*.ts'],
		rules: restrictImports('features', 'admin', 'owners', 'properties')
	},
	{
		// Le module owners détient les propriétaires et les mandats (lot 06) ; les autres règles d'import restent.
		files: ['apps/api/src/modules/owners/**/*.ts'],
		rules: restrictImports('features', 'admin', 'sync', 'properties')
	},
	{
		// Le module properties détient les biens et les unités (lot 07) ; les autres règles d'import restent.
		files: ['apps/api/src/modules/properties/**/*.ts'],
		rules: restrictImports('features', 'admin', 'sync', 'owners')
	},
	{
		files: ['scripts/**', '**/scripts/**', '**/*.config.{js,ts}', '**/test/**', '**/e2e/**'],
		rules: { 'no-console': 'off' }
	}
);
