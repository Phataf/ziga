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
	},
	documents: {
		group: ['**/db/schema/documents', '**/db/schema/documents.js'],
		message: 'Documents privés : passer par DocumentsService (module documents, lot 07).'
	},
	leases: {
		group: ['**/db/schema/leases', '**/db/schema/leases.js'],
		message: 'Locataires, baux, échéances et cautions : passer par LeasesService (module leases, lot 08).'
	},
	payments: {
		group: ['**/db/schema/payments', '**/db/schema/payments.js'],
		message: 'Encaissements, imputations et reçus : passer par PaymentsService (module payments, lot 09).'
	},
	collections: {
		group: ['**/db/schema/collections', '**/db/schema/collections.js'],
		message: 'Relances, dépenses, relevés et reversements : passer par les services du module collections (lot 10).'
	},
	personLinks: {
		group: ['**/db/schema/person-links', '**/db/schema/person-links.js'],
		message: 'Liens entre fiches et comptes : passer par le service du module organizations (lot 10 ter).'
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
		rules: restrictImports(
			'features',
			'admin',
			'sync',
			'owners',
			'properties',
			'documents',
			'leases',
			'payments',
			'collections',
			'personLinks'
		)
	},
	{
		// Le module admin, lui, détient sa connexion ; il passe toujours par le module features pour les interrupteurs.
		files: ['apps/api/src/modules/admin/**/*.ts'],
		rules: restrictImports('features', 'sync', 'owners', 'properties', 'documents', 'leases', 'payments', 'collections', 'personLinks')
	},
	{
		// Le module sync détient la table sync_operations ; les autres règles d'import restent.
		files: ['apps/api/src/modules/sync/**/*.ts'],
		rules: restrictImports('features', 'admin', 'owners', 'properties', 'documents', 'leases', 'payments', 'collections', 'personLinks')
	},
	{
		// Le module owners détient les propriétaires et les mandats (lot 06) ; les autres règles d'import restent.
		files: ['apps/api/src/modules/owners/**/*.ts'],
		rules: restrictImports('features', 'admin', 'sync', 'properties', 'documents', 'leases', 'payments', 'collections', 'personLinks')
	},
	{
		// Le module properties détient les biens et les unités (lot 07) ; les autres règles d'import restent.
		files: ['apps/api/src/modules/properties/**/*.ts'],
		rules: restrictImports('features', 'admin', 'sync', 'owners', 'documents', 'leases', 'payments', 'collections', 'personLinks')
	},
	{
		// Le module documents détient le registre des documents privés (lot 07, D22).
		files: ['apps/api/src/modules/documents/**/*.ts'],
		rules: restrictImports('features', 'admin', 'sync', 'owners', 'properties', 'leases', 'payments', 'collections', 'personLinks')
	},
	{
		// Le module leases détient les locataires, les baux, les échéances et les cautions (lot 08).
		files: ['apps/api/src/modules/leases/**/*.ts'],
		rules: restrictImports('features', 'admin', 'sync', 'owners', 'properties', 'documents', 'payments', 'collections', 'personLinks')
	},
	{
		// Le module payments détient les encaissements, les imputations et les reçus (lot 09).
		files: ['apps/api/src/modules/payments/**/*.ts'],
		rules: restrictImports('features', 'admin', 'sync', 'owners', 'properties', 'documents', 'leases', 'collections', 'personLinks')
	},
	{
		// Le module collections détient les relances, les dépenses, les relevés et les reversements (lot 10).
		files: ['apps/api/src/modules/collections/**/*.ts'],
		rules: restrictImports('features', 'admin', 'sync', 'owners', 'properties', 'documents', 'leases', 'payments', 'personLinks')
	},
	{
		// Le module organizations détient les liens entre fiches et comptes des personnes (lot 10 ter).
		files: ['apps/api/src/modules/organizations/**/*.ts'],
		rules: restrictImports('features', 'admin', 'sync', 'owners', 'properties', 'documents', 'leases', 'payments', 'collections')
	},
	{
		files: ['scripts/**', '**/scripts/**', '**/*.config.{js,ts}', '**/test/**', '**/e2e/**'],
		rules: { 'no-console': 'off' }
	}
);
