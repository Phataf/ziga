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
	/**
	 * Lot 09 : baux que l'on peut encaisser (signés, en vigueur ou en préavis), avec le locataire et l'unité, pour la
	 * recherche de l'écran « Encaisser » (l'agent de terrain ne reçoit que ceux de ses unités).
	 */
	paymentTargets: `SELECT l.id, l.tenant_id, l.status, t.full_name AS tenant_name, t.phone AS tenant_phone, u.label AS unit_label,
		p.name AS property_name FROM leases l
		JOIN tenants t ON t.organization_id = l.organization_id AND t.id = l.tenant_id
		LEFT JOIN units u ON u.organization_id = l.organization_id AND u.id = l.unit_id
		LEFT JOIN properties p ON p.organization_id = u.organization_id AND p.id = u.property_id
		WHERE l.organization_id = ? AND l.status IN ('signed', 'active', 'notice') ORDER BY t.full_name COLLATE NOCASE, l.id`,
	/** Encaissements de l'organisation (les contre-écritures à part), les plus récents d'abord. */
	payments: `SELECT * FROM payments WHERE organization_id = ? AND (kind IS NULL OR kind = 'payment') ORDER BY paid_on DESC, id DESC`,
	payment: `SELECT * FROM payments WHERE organization_id = ? AND id = ?`,
	/** Liste des encaissements, avec le locataire, l'unité et le numéro du reçu (provisoire tant qu'il n'est pas émis). */
	paymentsList: `SELECT p.*, t.full_name AS tenant_name, u.label AS unit_label, r.number AS receipt_number,
		coalesce(r.provisional_number, d.provisional_number) AS receipt_provisional FROM payments p
		LEFT JOIN leases l ON l.organization_id = p.organization_id AND l.id = p.lease_id
		LEFT JOIN tenants t ON t.organization_id = l.organization_id AND t.id = l.tenant_id
		LEFT JOIN units u ON u.organization_id = l.organization_id AND u.id = l.unit_id
		LEFT JOIN receipts r ON r.organization_id = p.organization_id AND r.payment_id = p.id
		LEFT JOIN receipt_drafts d ON d.payment_id = p.id
		WHERE p.organization_id = ? AND (p.kind IS NULL OR p.kind = 'payment') ORDER BY p.paid_on DESC, p.id DESC`,
	leasePayments: `SELECT * FROM payments WHERE organization_id = ? AND lease_id = ? AND (kind IS NULL OR kind = 'payment') ORDER BY paid_on DESC, id DESC`,
	receipts: `SELECT * FROM receipts WHERE organization_id = ?`,
	paymentReceipt: `SELECT * FROM receipts WHERE organization_id = ? AND payment_id = ?`,
	/** Reçus créés sur cet appareil (table locale) : jetons du QR code et du lien partagé. */
	receiptDrafts: `SELECT * FROM receipt_drafts WHERE organization_id = ?`,
	paymentDraft: `SELECT * FROM receipt_drafts WHERE organization_id = ? AND payment_id = ?`,
	/**
	 * Lot 10 : échéances des baux validés, avec le locataire, l'unité et le début du bail (impayés, tableau de bord) ;
	 * l'agent de terrain ne reçoit que celles de ses unités.
	 */
	arrearsDues: `SELECT d.*, l.tenant_id, l.unit_id, l.starts_on AS lease_starts_on FROM rent_dues d
		JOIN leases l ON l.organization_id = d.organization_id AND l.id = d.lease_id
		WHERE d.organization_id = ? AND l.status IN ('signed', 'active', 'notice', 'ended')`,
	/** Encaissements à valider ou à rapprocher (loyers et remboursements de dépense). */
	awaitingPayments: `SELECT lease_id, purpose, expense_id, amount FROM payments
		WHERE organization_id = ? AND (kind IS NULL OR kind = 'payment') AND status IN ('to_validate', 'to_reconcile')`,
	/** Encaissements de loyer confirmés (encaissé du mois, tableau de bord). */
	confirmedRentPayments: `SELECT amount, paid_on FROM payments
		WHERE organization_id = ? AND (kind IS NULL OR kind = 'payment') AND purpose = 'rent' AND status = 'confirmed'`,
	/** Dépenses réclamées aux locataires, avec le locataire du bail et le remboursé (imputations nettes). */
	expenseClaims: `SELECT e.*, l.tenant_id, l.unit_id AS lease_unit_id, (SELECT coalesce(sum(CASE a.direction WHEN 'allocate' THEN a.amount ELSE -a.amount END), 0)
			FROM payment_allocations a WHERE a.organization_id = e.organization_id AND a.expense_id = e.id) AS recovered
		FROM expenses e JOIN leases l ON l.organization_id = e.organization_id AND l.id = e.lease_id
		WHERE e.organization_id = ? AND e.recovery = 'claimed_from_tenant'`,
	/** Relances de l'organisation, les plus récentes d'abord. */
	reminders: `SELECT * FROM reminders WHERE organization_id = ? ORDER BY sent_at DESC, id DESC`,
	reminderSettings: `SELECT * FROM reminder_settings WHERE organization_id = ?`,
	/** Unités avec leur bien : libellés, quartier, propriétaire, agent (filtres des impayés). */
	unitContexts: `SELECT u.id, u.label, u.assigned_agent_id, p.id AS property_id, p.name AS property_name, p.owner_id, p.neighborhood_id
		FROM units u JOIN properties p ON p.organization_id = u.organization_id AND p.id = u.property_id WHERE u.organization_id = ?`,
	/** Dépenses de l'organisation, avec le bien et l'unité, les plus récentes d'abord. */
	expenses: `SELECT e.*, p.name AS property_name, u.label AS unit_label FROM expenses e
		LEFT JOIN properties p ON p.organization_id = e.organization_id AND p.id = e.property_id
		LEFT JOIN units u ON u.organization_id = e.organization_id AND u.id = e.unit_id
		WHERE e.organization_id = ? ORDER BY e.spent_on DESC, e.id DESC`,
	/** Relevés propriétaires (direction, gestion, lecture), les plus récents d'abord. */
	/**
	 * Lot 10 bis : sorties de l'organisation — baux en préavis, ou terminés par une sortie, avec leur congé enregistré,
	 * l'unité, le bien, le locataire et le décompte (l'agent de terrain ne reçoit ni le décompte ni la caution).
	 */
	exits: `SELECT l.id, l.status, l.unit_id, l.tenant_id, l.exit_on, l.end_kind, l.rent, l.charges, u.label AS unit_label, u.technical_status,
		p.name AS property_name, t.full_name AS tenant_name, n.planned_exit_on, n.notified_on, n.origin AS notice_origin,
		(SELECT s.status FROM deposit_settlements s WHERE s.organization_id = l.organization_id AND s.lease_id = l.id ORDER BY s.created_at DESC LIMIT 1) AS settlement_status,
		(SELECT s.refund FROM deposit_settlements s WHERE s.organization_id = l.organization_id AND s.lease_id = l.id ORDER BY s.created_at DESC LIMIT 1) AS settlement_refund,
		(SELECT s.refund_alert FROM deposit_settlements s WHERE s.organization_id = l.organization_id AND s.lease_id = l.id ORDER BY s.created_at DESC LIMIT 1) AS refund_alert,
		(SELECT i.status FROM inspections i WHERE i.organization_id = l.organization_id AND i.lease_id = l.id AND i.type = 'exit' ORDER BY i.created_at DESC LIMIT 1) AS exit_inspection_status
		FROM leases l
		LEFT JOIN units u ON u.organization_id = l.organization_id AND u.id = l.unit_id
		LEFT JOIN properties p ON p.organization_id = u.organization_id AND p.id = u.property_id
		LEFT JOIN tenants t ON t.organization_id = l.organization_id AND t.id = l.tenant_id
		LEFT JOIN lease_notices n ON n.organization_id = l.organization_id AND n.lease_id = l.id AND n.status = 'recorded'
		WHERE l.organization_id = ? AND (l.status = 'notice' OR (l.status = 'ended' AND l.end_kind IN ('tenant_exit', 'lessor_notice')))
		ORDER BY coalesce(n.planned_exit_on, l.exit_on) DESC, l.id`,
	/** Unités à remettre en état ou en travaux (D14) : jamais disponibles tant qu'elles ne sont pas déclarées prêtes. */
	refurbishUnits: `SELECT u.*, p.name AS property_name FROM units u
		LEFT JOIN properties p ON p.organization_id = u.organization_id AND p.id = u.property_id
		WHERE u.organization_id = ? AND u.technical_status IN ('to_refurbish', 'under_works') ORDER BY p.name COLLATE NOCASE, u.label COLLATE NOCASE, u.id`,
	leaseNotices: `SELECT * FROM lease_notices WHERE organization_id = ? AND lease_id = ? ORDER BY created_at DESC, id DESC`,
	leaseInspections: `SELECT * FROM inspections WHERE organization_id = ? AND lease_id = ? ORDER BY type, created_at, id`,
	inspection: `SELECT * FROM inspections WHERE organization_id = ? AND id = ?`,
	leaseInspectionItems: `SELECT it.* FROM inspection_items it JOIN inspections i ON i.organization_id = it.organization_id AND i.id = it.inspection_id
		WHERE it.organization_id = ? AND i.lease_id = ? ORDER BY it.position, it.created_at, it.id`,
	inspectionDocuments: `SELECT * FROM documents WHERE organization_id = ? AND inspection_id = ? ORDER BY created_at, id`,
	leaseRepairs: `SELECT * FROM repairs WHERE organization_id = ? AND lease_id = ? ORDER BY created_at, id`,
	leaseAgreements: `SELECT * FROM agreements WHERE organization_id = ? AND lease_id = ? ORDER BY proposed_on, created_at, id`,
	leaseSettlements: `SELECT * FROM deposit_settlements WHERE organization_id = ? AND lease_id = ? ORDER BY created_at, id`,
	leaseSettlementLines: `SELECT ln.* FROM deposit_settlement_lines ln JOIN deposit_settlements s ON s.organization_id = ln.organization_id AND s.id = ln.settlement_id
		WHERE ln.organization_id = ? AND s.lease_id = ? ORDER BY ln.revision, ln.position, ln.id`,
	/** Lot 10 bis : transferts de gestion d'un mandat (ajout seul). */
	mandateTransfers: `SELECT * FROM management_transfers WHERE organization_id = ? AND mandate_id = ? ORDER BY created_at, id`,
	/** Baux, comptes et mouvements de caution des unités d'un bien (assistant de transfert de gestion). */
	propertyLeases: `SELECT l.*, u.label AS unit_label FROM leases l JOIN units u ON u.organization_id = l.organization_id AND u.id = l.unit_id
		WHERE l.organization_id = ? AND u.property_id = ? ORDER BY u.label COLLATE NOCASE, l.id`,
	propertyDeposits: `SELECT a.* FROM deposit_accounts a JOIN leases l ON l.organization_id = a.organization_id AND l.id = a.lease_id
		JOIN units u ON u.organization_id = l.organization_id AND u.id = l.unit_id WHERE a.organization_id = ? AND u.property_id = ? ORDER BY a.id`,
	propertyMovements: `SELECT m.* FROM deposit_movements m JOIN deposit_accounts a ON a.organization_id = m.organization_id AND a.id = m.account_id
		JOIN leases l ON l.organization_id = a.organization_id AND l.id = a.lease_id JOIN units u ON u.organization_id = l.organization_id AND u.id = l.unit_id
		WHERE m.organization_id = ? AND u.property_id = ? ORDER BY m.occurred_on, m.created_at, m.id`,
	mandate: `SELECT * FROM mandates WHERE organization_id = ? AND id = ?`,
	mandateScopes: `SELECT * FROM mandate_scopes WHERE organization_id = ? AND mandate_id = ? ORDER BY id`,
	statements: `SELECT * FROM owner_statements WHERE organization_id = ? ORDER BY month DESC, version DESC, id DESC`,
	statement: `SELECT * FROM owner_statements WHERE organization_id = ? AND id = ?`,
	statementPayouts: `SELECT * FROM owner_payouts WHERE organization_id = ? AND statement_id = ? ORDER BY created_at, id`,
	/** Tous les membres, retirés compris (nom de la personne qui a encaissé). */
	allMembers: `SELECT * FROM organization_members WHERE organization_id = ? ORDER BY display_name`,
	/** Modifications refusées par le serveur (table locale de l'appareil), de l'organisation, les plus récentes d'abord. */
	rejections: `SELECT * FROM sync_rejections WHERE organization_id = ? ORDER BY rejected_at DESC, id DESC`,
	rejectionCount: `SELECT count(*) AS n FROM sync_rejections WHERE organization_id = ?`
} as const;

/** Référentiel géographique (lot 07) : tables de la plateforme, sans organisation, identiques pour tous. */
export const GEOGRAPHY_QUERIES = {
	communes: `SELECT * FROM communes ORDER BY name`,
	neighborhoods: `SELECT * FROM neighborhoods ORDER BY name COLLATE NOCASE`
} as const;
