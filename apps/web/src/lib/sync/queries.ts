/**
 * Signaux d'occupation des baux d'une unité (lot 08, règle 13) : l'occupation n'est jamais stockée, elle se calcule
 * sur l'appareil à partir de ces baux (packages/shared, unitOccupancy), comme sur le serveur.
 */
const LEASE_SIGNALS = `(SELECT json_group_array(json_object('status', l.status, 'starts_on', l.starts_on)) FROM leases l
		WHERE l.organization_id = u.organization_id AND l.unit_id = u.id AND l.status IN ('signed', 'active', 'notice')) AS lease_signals`;

/**
 * Lectures locales des écrans (lot 05). Chaque requête d'une table d'organisation prend l'organisation active en
 * premier paramètre et filtre dessus : un écran de gestion n'affiche jamais deux organisations (CLAUDE.md §4, D17).
 * Vérifié par queries.test.ts.
 */
export const LOCAL_QUERIES = {
	/** Fiche de l'organisation, avec son représentant légal quand il est synchronisé (directeur seulement). */
	organization: `SELECT o.*, r.rep_name, r.rep_title, r.rep_profession, r.rep_address, r.rep_nationality, r.rep_id_type,
		r.rep_id_type_other, r.rep_id_number, r.rep_id_issued_on, r.rep_id_issued_by
		FROM organizations o LEFT JOIN organization_representatives r ON r.id = o.id WHERE o.id = ?`,
	/** Membres actifs de l'organisation. */
	members: `SELECT * FROM organization_members WHERE organization_id = ? AND status = 'active' ORDER BY display_name`,
	/** Réglages de fonctionnalités de l'organisation. */
	featureSettings: `SELECT * FROM organization_feature_settings WHERE organization_id = ?`,
	/** Exceptions de l'organisation et de la personne. */
	featureOverrides: `SELECT * FROM feature_overrides WHERE (scope = 'organization' AND organization_id = ?) OR (scope = 'user' AND user_id = ?)`,
	/** Catalogue et contenu des formules : identiques pour tous, sans organisation. */
	features: `SELECT * FROM features`,
	planFeatures: `SELECT * FROM plan_features`,
	/** Lot 06 : propriétaires de l'organisation, par nom. */
	owners: `SELECT * FROM owners WHERE organization_id = ? ORDER BY name COLLATE NOCASE, id`,
	/** Une fiche propriétaire de l'organisation. */
	owner: `SELECT * FROM owners WHERE organization_id = ? AND id = ?`,
	/** Mandats de l'organisation (liste, alertes), les plus récents d'abord. */
	mandates: `SELECT * FROM mandates WHERE organization_id = ? ORDER BY starts_on DESC, id DESC`,
	/** Mandats d'un propriétaire. */
	ownerMandates: `SELECT * FROM mandates WHERE organization_id = ? AND owner_id = ? ORDER BY starts_on DESC, id DESC`,
	/** Versions d'un mandat, la plus récente d'abord. */
	mandateVersions: `SELECT * FROM mandate_versions WHERE organization_id = ? AND mandate_id = ? ORDER BY version DESC`,
	/** Lot 07 : biens de l'organisation (l'agent de terrain ne reçoit que ceux de ses unités affectées), par nom. */
	properties: `SELECT * FROM properties WHERE organization_id = ? ORDER BY name COLLATE NOCASE, id`,
	property: `SELECT * FROM properties WHERE organization_id = ? AND id = ?`,
	/** Unités de l'organisation (liste, filtres), puis celles d'un bien. */
	units: `SELECT u.*, ${LEASE_SIGNALS} FROM units u WHERE u.organization_id = ? ORDER BY u.label COLLATE NOCASE, u.id`,
	propertyUnits: `SELECT u.*, ${LEASE_SIGNALS} FROM units u WHERE u.organization_id = ? AND u.property_id = ? ORDER BY u.label COLLATE NOCASE, u.id`,
	/** Lot 08 : une unité, avec les signaux de ses baux (assistant de bail). */
	unit: `SELECT u.*, ${LEASE_SIGNALS} FROM units u WHERE u.organization_id = ? AND u.id = ?`,
	/** Photos d'un bien et de ses unités (les retirées ne descendent pas). */
	propertyMedia: `SELECT * FROM media WHERE organization_id = ? AND property_id = ? ORDER BY position, created_at, id`,
	/** Toutes les portées d'un bien (le bien entier et ses unités) : autorisation des photos. */
	propertyAllScopes: `SELECT * FROM mandate_scopes WHERE organization_id = ? AND property_id = ?`,
	/** Portées des mandats sur un bien (mandat qui le couvre). */
	propertyScopes: `SELECT * FROM mandate_scopes WHERE organization_id = ? AND property_id = ? AND unit_id IS NULL`,
	/** Agents de terrain actifs de l'organisation (affectation). */
	fieldAgents: `SELECT * FROM organization_members WHERE organization_id = ? AND status = 'active' AND role = 'field_agent' ORDER BY display_name`,
	/** Métadonnées des documents privés d'un bien (direction et gestion seulement : les autres n'en reçoivent pas). */
	propertyDocuments: `SELECT * FROM documents WHERE organization_id = ? AND property_id = ? ORDER BY type, version DESC, id`,
	/** Lot 08 : locataires de l'organisation (l'agent de terrain ne reçoit que ceux des baux de ses unités). */
	tenants: `SELECT * FROM tenants WHERE organization_id = ? ORDER BY full_name COLLATE NOCASE, id`,
	tenant: `SELECT * FROM tenants WHERE organization_id = ? AND id = ?`,
	/** État civil (directeur et gestionnaire seulement : les autres rôles n'en reçoivent aucune ligne). */
	tenantIdentity: `SELECT * FROM tenant_identities WHERE organization_id = ? AND id = ?`,
	leases: `SELECT * FROM leases WHERE organization_id = ? ORDER BY starts_on DESC, id DESC`,
	lease: `SELECT * FROM leases WHERE organization_id = ? AND id = ?`,
	unitLeases: `SELECT * FROM leases WHERE organization_id = ? AND unit_id = ? ORDER BY starts_on DESC, id DESC`,
	tenantLeases: `SELECT * FROM leases WHERE organization_id = ? AND tenant_id = ? ORDER BY starts_on DESC, id DESC`,
	leaseVersions: `SELECT * FROM lease_versions WHERE organization_id = ? AND lease_id = ? ORDER BY version DESC`,
	leaseDues: `SELECT d.*, l.starts_on AS lease_starts_on FROM rent_dues d JOIN leases l ON l.id = d.lease_id AND l.organization_id = d.organization_id WHERE d.organization_id = ? AND d.lease_id = ? ORDER BY d.period_start, d.id`,
	/** Échéances des baux d'un locataire (reste à payer de sa fiche). */
	tenantDues: `SELECT d.*, l.starts_on AS lease_starts_on FROM rent_dues d JOIN leases l ON l.id = d.lease_id AND l.organization_id = d.organization_id WHERE d.organization_id = ? AND l.tenant_id = ?`,
	/** Échéances de toute l'organisation : encours des locataires (liste). */
	dues: `SELECT lease_id, due_on, amount_due, amount_paid, status FROM rent_dues WHERE organization_id = ?`,
	leaseDeposits: `SELECT * FROM deposit_accounts WHERE organization_id = ? AND lease_id = ? ORDER BY type, id`,
	leaseMovements: `SELECT m.* FROM deposit_movements m JOIN deposit_accounts a ON a.id = m.account_id
		WHERE m.organization_id = ? AND a.lease_id = ? ORDER BY m.occurred_on, m.id`,
	/** Documents du bail et de son locataire (métadonnées ; direction et gestion seulement). */
	leaseDocuments: `SELECT * FROM documents WHERE organization_id = ? AND (lease_id = ? OR tenant_id = ?) ORDER BY type, version DESC, id`,
	/** Baux qui ont un bail signé scanné en vigueur (alerte « Contrat non signé »). */
	signedScans: `SELECT DISTINCT lease_id FROM documents WHERE organization_id = ? AND type = 'signed_lease_scan' AND status = 'active'`,
	/**
	 * Lot 08 bis (direction et gestion seulement : les autres rôles ne reçoivent aucune ligne de contrat). Baux de la
	 * liste des contrats, avec l'unité et le locataire, lus dans la même organisation.
	 */
	contractLeases: `SELECT l.*, u.label AS unit_label, t.full_name AS tenant_name FROM leases l
		LEFT JOIN units u ON u.organization_id = l.organization_id AND u.id = l.unit_id
		LEFT JOIN tenants t ON t.organization_id = l.organization_id AND t.id = l.tenant_id
		WHERE l.organization_id = ? ORDER BY l.starts_on DESC, l.id DESC`,
	/** Contrats de l'organisation, avec la version du bail de leur version figée (« à régénérer »). */
	contracts: `SELECT c.*, v.lease_version AS frozen_lease_version FROM lease_contracts c
		LEFT JOIN contract_versions v ON v.organization_id = c.organization_id AND v.contract_id = c.id AND v.number = c.frozen_version
		WHERE c.organization_id = ? ORDER BY c.created_at DESC, c.id DESC`,
	contract: `SELECT c.*, v.lease_version AS frozen_lease_version FROM lease_contracts c
		LEFT JOIN contract_versions v ON v.organization_id = c.organization_id AND v.contract_id = c.id AND v.number = c.frozen_version
		WHERE c.organization_id = ? AND c.id = ?`,
	leaseContracts: `SELECT c.*, v.lease_version AS frozen_lease_version FROM lease_contracts c
		LEFT JOIN contract_versions v ON v.organization_id = c.organization_id AND v.contract_id = c.id AND v.number = c.frozen_version
		WHERE c.organization_id = ? AND c.lease_id = ? ORDER BY c.created_at DESC, c.id DESC`,
	/** Versions d'un contrat, la plus récente d'abord (ajout seul : jamais réécrites). */
	contractVersions: `SELECT * FROM contract_versions WHERE organization_id = ? AND contract_id = ? ORDER BY number DESC`,
	leaseAmendments: `SELECT * FROM lease_amendments WHERE organization_id = ? AND lease_id = ? ORDER BY number DESC`,
	amendment: `SELECT * FROM lease_amendments WHERE organization_id = ? AND id = ?`,
	/** Modèles Word de l'organisation (direction et gestion ; la direction seule les gère). */
	contractTemplates: `SELECT * FROM contract_templates WHERE organization_id = ? ORDER BY kind, version DESC, id`,
	/** Documents d'un contrat : scan signé, preuves de légalisation et d'enregistrement, versions générées. */
	contractDocuments: `SELECT * FROM documents WHERE organization_id = ? AND lease_contract_id = ? ORDER BY created_at DESC, id`,
	/** Aperçus des modèles (documents « projet de contrat » rattachés à un modèle). */
	templateDocuments: `SELECT * FROM documents WHERE organization_id = ? AND contract_template_id IS NOT NULL ORDER BY created_at DESC, id`,
	/** Modifications refusées par le serveur (table locale de l'appareil), de l'organisation, les plus récentes d'abord. */
	rejections: `SELECT * FROM sync_rejections WHERE organization_id = ? ORDER BY rejected_at DESC, id DESC`,
	rejectionCount: `SELECT count(*) AS n FROM sync_rejections WHERE organization_id = ?`
} as const;

/** Référentiel géographique (lot 07) : tables de la plateforme, sans organisation, identiques pour tous. */
export const GEOGRAPHY_QUERIES = {
	communes: `SELECT * FROM communes ORDER BY name`,
	neighborhoods: `SELECT * FROM neighborhoods ORDER BY name COLLATE NOCASE`
} as const;
