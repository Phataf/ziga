/**
 * Schéma de la base locale du client (SQLite, PowerSync), lot 05, D30.
 *
 * Une table synchronisée a ici exactement les colonnes que ses Sync Streams envoient (infra/powersync/sync-config.yaml),
 * avec le type SQLite que PowerSync leur donne : apps/api/test/sync-streams.int.test.ts compare cette description à
 * celle que le moteur de PowerSync déduit des streams et du schéma réel. La colonne `id` (texte) est implicite.
 * Le web construit son schéma PowerSync à partir d'ici (apps/web/src/lib/sync/schema.ts).
 *
 * Types : booléens en entier (0 ou 1), dates et instants en texte ISO, tableaux PostgreSQL en texte JSON.
 */
export type LocalColumnType = 'text' | 'integer' | 'real';

export const SYNCED_TABLES = {
	organizations: {
		type: 'text',
		legal_name: 'text',
		trade_name: 'text',
		phone: 'text',
		address: 'text',
		commune: 'text',
		po_box: 'text',
		rccm: 'text',
		ifu: 'text',
		verification_status: 'text',
		plan_id: 'text',
		accepted_payment_methods: 'text',
		logo_id: 'text',
		updated_at: 'text'
	},
	organization_members: {
		organization_id: 'text',
		user_id: 'text',
		role: 'text',
		status: 'text',
		display_name: 'text',
		joined_at: 'text'
	},
	/** Directeur seulement : représentant légal de l'organisation (même `id` que l'organisation). */
	organization_representatives: {
		rep_name: 'text',
		rep_title: 'text',
		rep_profession: 'text',
		rep_address: 'text',
		rep_nationality: 'text',
		rep_id_type: 'text',
		rep_id_type_other: 'text',
		rep_id_number: 'text',
		rep_id_issued_on: 'text',
		rep_id_issued_by: 'text'
	},
	organization_feature_settings: {
		organization_id: 'text',
		feature_key: 'text',
		disabled_by_organization: 'integer'
	},
	feature_overrides: {
		feature_key: 'text',
		scope: 'text',
		organization_id: 'text',
		user_id: 'text',
		value: 'integer',
		starts_at: 'text',
		ends_at: 'text'
	},
	features: {
		global_mode: 'text',
		plan_bound: 'integer',
		requires: 'text'
	},
	plan_features: {
		plan_id: 'text',
		feature_key: 'text'
	},
	/** Lot 06 : propriétaires (sans le compte lié). */
	owners: {
		organization_id: 'text',
		type: 'text',
		name: 'text',
		phone: 'text',
		email: 'text',
		address: 'text',
		country: 'text',
		representative_name: 'text',
		representative_phone: 'text',
		notes: 'text',
		status: 'text',
		archived_at: 'text',
		created_at: 'text',
		updated_at: 'text'
	},
	/** Lot 06 : mandats ; montants et taux entiers (règle 2), autorisations en 0 ou 1. */
	mandates: {
		organization_id: 'text',
		owner_id: 'text',
		type: 'text',
		starts_on: 'text',
		ends_on: 'text',
		commission_basis: 'text',
		commission_rate_bp: 'integer',
		commission_amount: 'integer',
		can_publish: 'integer',
		can_take_photos: 'integer',
		can_collect_funds: 'integer',
		can_sign_leases: 'integer',
		exclusive: 'integer',
		status: 'text',
		revoked_at: 'text',
		revocation_reason: 'text',
		expired_at: 'text',
		version: 'integer',
		created_at: 'text',
		updated_at: 'text'
	},
	/** Lot 06 : copie de chaque version d'un mandat, écrite par la base seule. */
	mandate_versions: {
		organization_id: 'text',
		mandate_id: 'text',
		version: 'integer',
		starts_on: 'text',
		ends_on: 'text',
		commission_basis: 'text',
		commission_rate_bp: 'integer',
		commission_amount: 'integer',
		can_publish: 'integer',
		can_take_photos: 'integer',
		can_collect_funds: 'integer',
		can_sign_leases: 'integer',
		exclusive: 'integer',
		status: 'text',
		revoked_at: 'text',
		revocation_reason: 'text',
		expired_at: 'text',
		changed_by: 'text',
		recorded_at: 'text'
	},
	/** Lot 06 (remplie au lot 07) : biens et unités couverts par un mandat. */
	mandate_scopes: {
		organization_id: 'text',
		mandate_id: 'text',
		property_id: 'text',
		unit_id: 'text',
		via_property: 'integer',
		management_active: 'integer'
	}
} as const satisfies Record<string, Record<string, LocalColumnType>>;

export type SyncedTable = keyof typeof SYNCED_TABLES;

/** Tables à colonne `organization_id` : toute lecture locale y filtre par l'organisation active. */
export const ORGANIZATION_SCOPED_TABLES = [
	'organization_members',
	'organization_feature_settings',
	'owners',
	'mandates',
	'mandate_versions',
	'mandate_scopes'
] as const satisfies readonly SyncedTable[];
