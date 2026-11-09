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
	planFeatures: `SELECT * FROM plan_features`
} as const;
