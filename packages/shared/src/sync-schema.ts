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
	/** Lot 07 : référentiel géographique de la plateforme, identique pour tous. */
	communes: {
		name: 'text',
		lat: 'real',
		lng: 'real'
	},
	neighborhoods: {
		commune_id: 'text',
		name: 'text',
		lat: 'real',
		lng: 'real'
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
	},
	/** Lot 07 : biens (point GPS pris sur place : jamais publié). */
	properties: {
		organization_id: 'text',
		owner_id: 'text',
		type: 'text',
		operation: 'text',
		name: 'text',
		commune_id: 'text',
		neighborhood_id: 'text',
		address_hint: 'text',
		gps_lat: 'real',
		gps_lng: 'real',
		gps_accuracy_m: 'integer',
		declared_land_documents: 'text',
		notes: 'text',
		record_status: 'text',
		archived_at: 'text',
		created_at: 'text',
		updated_at: 'text'
	},
	/** Lot 07 : unités ; l'occupation n'est pas une colonne, elle se calcule (occupancyOf). */
	units: {
		organization_id: 'text',
		property_id: 'text',
		type: 'text',
		label: 'text',
		bedrooms: 'integer',
		living_rooms: 'integer',
		kitchens: 'integer',
		bathrooms: 'integer',
		terraces: 'integer',
		laundries: 'integer',
		surface_m2: 'integer',
		land_area_m2: 'integer',
		usage: 'text',
		furnished: 'integer',
		amenities: 'text',
		rent: 'integer',
		charges: 'integer',
		deposit_amount: 'integer',
		advance_months: 'integer',
		assigned_agent_id: 'text',
		record_status: 'text',
		archived_at: 'text',
		technical_status: 'text',
		technical_reason: 'text',
		technical_expected_on: 'text',
		created_at: 'text',
		updated_at: 'text'
	},
	/** Lot 07 : photos, sans l'original (storage_key) ; variantes sous variants_key. */
	media: {
		organization_id: 'text',
		property_id: 'text',
		unit_id: 'text',
		kind: 'text',
		mime_type: 'text',
		byte_size: 'integer',
		position: 'integer',
		caption: 'text',
		variants_key: 'text',
		width: 'integer',
		height: 'integer',
		status: 'text',
		error: 'text',
		created_at: 'text',
		processed_at: 'text'
	},
	/** Lot 07 : métadonnées des documents privés (direction et gestion ; jamais la clé de stockage). */
	documents: {
		organization_id: 'text',
		type: 'text',
		owner_id: 'text',
		mandate_id: 'text',
		property_id: 'text',
		unit_id: 'text',
		version: 'integer',
		replaces_id: 'text',
		file_name: 'text',
		mime_type: 'text',
		byte_size: 'integer',
		sha256: 'text',
		status: 'text',
		restriction: 'text',
		uploaded_by: 'text',
		created_at: 'text',
		activated_at: 'text',
		replaced_at: 'text',
		withdrawn_at: 'text',
		withdrawal_reason: 'text'
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
	'mandate_scopes',
	'properties',
	'units',
	'media',
	'documents'
] as const satisfies readonly SyncedTable[];
