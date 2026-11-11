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
	units: `SELECT * FROM units WHERE organization_id = ? ORDER BY label COLLATE NOCASE, id`,
	propertyUnits: `SELECT * FROM units WHERE organization_id = ? AND property_id = ? ORDER BY label COLLATE NOCASE, id`,
	/** Photos d'un bien et de ses unités (les retirées ne descendent pas). */
	propertyMedia: `SELECT * FROM media WHERE organization_id = ? AND property_id = ? ORDER BY position, created_at, id`,
	/** Portées des mandats sur un bien (mandat qui le couvre). */
	propertyScopes: `SELECT * FROM mandate_scopes WHERE organization_id = ? AND property_id = ? AND unit_id IS NULL`,
	/** Agents de terrain actifs de l'organisation (affectation). */
	fieldAgents: `SELECT * FROM organization_members WHERE organization_id = ? AND status = 'active' AND role = 'field_agent' ORDER BY display_name`,
	/** Métadonnées des documents privés d'un bien (direction et gestion seulement : les autres n'en reçoivent pas). */
	propertyDocuments: `SELECT * FROM documents WHERE organization_id = ? AND property_id = ? ORDER BY type, version DESC, id`,
	/** Modifications refusées par le serveur (table locale de l'appareil), de l'organisation, les plus récentes d'abord. */
	rejections: `SELECT * FROM sync_rejections WHERE organization_id = ? ORDER BY rejected_at DESC, id DESC`,
	rejectionCount: `SELECT count(*) AS n FROM sync_rejections WHERE organization_id = ?`
} as const;

/** Référentiel géographique (lot 07) : tables de la plateforme, sans organisation, identiques pour tous. */
export const GEOGRAPHY_QUERIES = {
	communes: `SELECT * FROM communes ORDER BY name`,
	neighborhoods: `SELECT * FROM neighborhoods ORDER BY name COLLATE NOCASE`
} as const;
