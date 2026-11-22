/**
 * Règles vérifiées par la base (triggers, contraintes) traduites en erreurs métier : l'API les vérifie
 * d'abord elle-même, la base reste le dernier rempart (concurrence, oubli).
 */
import { AppError } from './app-error.js';

const RULES: Record<string, { status: number; message: string }> = {
	LANDLORD_SINGLE_MEMBER: { status: 409, message: 'Un bailleur particulier gère seul ses logements : pas de second membre.' },
	LAST_DIRECTOR: { status: 409, message: 'L’organisation doit garder au moins un directeur.' },
	MEMBER_IMMUTABLE: { status: 409, message: 'Un membre ne change ni d’organisation ni de personne.' },
	AUDIT_APPEND_ONLY: { status: 409, message: 'Le journal d’audit est en ajout seul.' },
	// Lot 07 : biens, unités, photos, règle 12.
	UNIT_PROPERTY_IMMUTABLE: { status: 409, message: 'Une unité ne change pas de bien.' },
	UNIT_AGENT_NOT_FIELD_AGENT: { status: 409, message: 'Seule une personne active au rôle agent de terrain peut être affectée.' },
	MANDATE_SCOPE_OWNER: { status: 409, message: 'Un mandat ne couvre que les biens de son propriétaire.' },
	PROPERTY_OWNER_LOCKED: { status: 409, message: 'Ce bien est sous mandat de gestion actif : son propriétaire ne change pas.' },
	MEDIA_QUOTA: { status: 409, message: '15 photos au plus par unité : retirez-en une avant d’en ajouter.' },
	MEDIA_OBJECT_IMMUTABLE: { status: 409, message: 'Une photo ne change pas d’objet.' },
	MEDIA_FINAL: { status: 409, message: 'Une photo refusée ou retirée le reste.' },
	// Lot 08 : baux, échéances, cautions (migration 0013).
	LEASE_BORN_DRAFT_OR_VALIDATED: { status: 409, message: 'Un bail naît brouillon ou validé.' },
	LEASE_RENT_EFFECTIVE: { status: 409, message: 'Un nouveau loyer prend effet après le précédent, pendant le bail.' },
	LEASE_IMMUTABLE: { status: 409, message: 'L’unité d’un bail ne change pas.' },
	LEASE_CLOSED: { status: 409, message: 'Ce bail est terminé ou annulé : il ne change plus.' },
	LEASE_STATUS: { status: 409, message: 'Ce changement de statut n’est pas permis.' },
	LEASE_TERMS_LOCKED: {
		status: 409,
		message: 'Les conditions d’un bail validé ne changent pas ; seul le loyer change, par une nouvelle version.'
	},
	LEASE_VERSION: { status: 409, message: 'Le bail a changé entre-temps : rechargez-le avant de modifier le loyer.' },
	LANDLORD_IS_LESSOR: { status: 409, message: 'Un bailleur particulier est lui-même le bailleur désigné.' },
	LANDLORD_IS_HOLDER: { status: 409, message: 'Un bailleur particulier détient lui-même la caution.' },
	RENT_DUE_LEASE_NOT_VALIDATED: { status: 409, message: 'Pas d’échéance pour un bail brouillon, terminé ou annulé.' },
	RENT_DUE_IMMUTABLE: { status: 409, message: 'La période d’une échéance ne change pas.' },
	RENT_DUE_ISSUED: { status: 409, message: 'Une échéance émise ne change plus de montant.' },
	RENT_DUE_WAIVED: { status: 409, message: 'Une échéance abandonnée le reste.' },
	DEPOSIT_BORN_PENDING: { status: 409, message: 'Un compte de caution naît en attente de versement.' },
	DEPOSIT_IMMUTABLE: { status: 409, message: 'Le bail et le type d’un compte de caution ne changent pas.' },
	DEPOSIT_TERMS_LOCKED: { status: 409, message: 'Le montant convenu ne change plus après la validation du bail.' },
	DEPOSIT_OVERPAID: { status: 409, message: 'Ce versement dépasse le montant convenu de la caution.' },
	DEPOSIT_OUTFLOW_EXCEEDS_RECEIVED: { status: 409, message: 'Les sorties ne dépassent jamais la caution reçue.' },
	DEPOSIT_ACCOUNT_CLOSED: { status: 409, message: 'Ce compte de caution est soldé.' },
	DEPOSIT_HOLDER_MISMATCH: { status: 409, message: 'Le détenteur a changé entre-temps : rechargez le compte de caution.' },
	APPEND_ONLY: { status: 409, message: 'Cet enregistrement est en ajout seul.' },
	// Lot 09 : encaissements, imputations, reçus (migration 0015).
	PAYMENT_LEASE_NOT_VALIDATED: { status: 409, message: 'On n’encaisse que sur un bail signé, en vigueur ou terminé.' },
	PAYMENT_DEPOSIT_ACCOUNT_LEASE: { status: 409, message: 'Le compte de caution appartient à un autre bail.' },
	PAYMENT_INITIAL_STATUS: { status: 409, message: 'Ce statut ne se choisit pas à la saisie : il est décidé par le serveur.' },
	PAYMENT_CONFIRMED_BY: { status: 409, message: 'Une validation a son auteur et sa date.' },
	PAYMENT_REVERSAL_INVALID: { status: 409, message: 'Une contre-écriture compense un encaissement confirmé puis annulé, à l’identique.' },
	PAYMENT_AMOUNT_IMMUTABLE: { status: 409, message: 'Le montant d’un encaissement ne change jamais : corrigez par une annulation.' },
	PAYMENT_IMMUTABLE: { status: 409, message: 'Un encaissement enregistré ne se modifie pas.' },
	PAYMENT_TRANSITION_FORBIDDEN: { status: 409, message: 'Ce changement de statut n’est pas permis.' },
	// Lot 10 bis : sortie du locataire (migrations 0019 et 0020).
	NOTICE_STATUS: { status: 409, message: 'Un congé naît demandé ou enregistré.' },
	NOTICE_LOCKED: { status: 409, message: 'Un congé enregistré ne change plus.' },
	NOTICE_LEASE_NOT_IN_FORCE: { status: 409, message: 'Un congé s’enregistre sur un bail en vigueur.' },
	NOTICE_PROOF_INVALID: { status: 400, message: 'La preuve est un document « preuve du congé » de ce bail.' },
	LEASE_NOTICE_REQUIRED: { status: 409, message: 'Le préavis suit un congé enregistré.' },
	LEASE_NOTICE_LOCKED: { status: 409, message: 'Les dates du préavis ne changent pas.' },
	// Lot 10 ter : liens entre fiches et comptes, signalements (migrations 0022 et 0023). Clés longues d'abord (préfixes).
	PERSON_LINK_REQUEST_ORGANIZATION: { status: 409, message: 'Une demande de liaison ne vise qu’une agence vérifiée.' },
	PERSON_LINK_REQUEST: { status: 409, message: 'La personne demande elle-même ; l’organisation accepte ensuite.' },
	PERSON_LINK_LANDLORD_SELF: { status: 409, message: 'Seule la propre fiche d’un bailleur particulier se lie ainsi, par son directeur.' },
	PERSON_LINK_REVOKED: { status: 409, message: 'Ce lien est révoqué : une nouvelle liaison crée un nouveau lien.' },
	PERSON_LINK_REVOKE: { status: 403, message: 'Vous ne révoquez que vos propres liens.' },
	PERSON_LINK_IMMUTABLE: { status: 409, message: 'Ce lien ne change plus.' },
	PERSON_LINK_STATUS: { status: 409, message: 'Ce changement de statut n’est pas permis.' },
	PERSON_LINK_MEMBER: { status: 403, message: 'Seules la direction et la gestion invitent, acceptent ou révoquent un lien.' },
	PERSON_LINK_INVITE: { status: 409, message: 'Cette invitation n’est plus valable.' },
	LINK_PHONE_MISMATCH: { status: 409, message: 'Le numéro de votre compte n’est pas celui de la fiche.' },
	MAINTENANCE_STATUS: { status: 409, message: 'Ce changement de statut n’est pas permis.' },
	MAINTENANCE_IMMUTABLE: { status: 409, message: 'Un signalement ne se réécrit pas ; seul son suivi change.' },
	MAINTENANCE_LEASE: { status: 409, message: 'Un signalement vise un bail en vigueur ou en préavis.' },
	MAINTENANCE_MEMBER: { status: 403, message: 'Seules la direction et la gestion traitent un signalement.' },
	INSPECTION_BORN_DRAFT: { status: 409, message: 'Un état des lieux naît brouillon.' },
	INSPECTION_LEASE: { status: 409, message: 'Pas d’état des lieux sur ce bail à ce stade.' },
	INSPECTION_IMMUTABLE: { status: 409, message: 'Le bail et le type d’un état des lieux ne changent pas.' },
	INSPECTION_LOCKED: { status: 409, message: 'Un état des lieux signé ou contesté ne change plus.' },
	INSPECTION_STATUS: { status: 409, message: 'Ce changement de statut n’est pas permis.' },
	INSPECTION_DISPUTE_OUTCOME: { status: 400, message: 'L’issue d’une contestation s’enregistre avec son document.' },
	INSPECTION_SCAN_INVALID: { status: 400, message: 'Le scan est un document « état des lieux signé » de cet état des lieux.' },
	INSPECTION_DESCRIPTION_VAGUE: { status: 400, message: 'Décrivez l’état : « bon état » seul ne suffit pas (article 9).' },
	INSPECTION_FINDING_REQUIRED: { status: 400, message: 'À la sortie, chaque élément a son constat.' },
	INSPECTION_FINDING_ON_ENTRY: { status: 400, message: 'L’état des lieux d’entrée n’a pas de constat.' },
	INSPECTION_COMPARISON: { status: 400, message: 'Une ligne de sortie se compare à une ligne d’entrée du même bail.' },
	AGREEMENT_BORN_PROPOSED: { status: 409, message: 'Un accord naît proposé.' },
	AGREEMENT_MONTH_STARTED: { status: 409, message: 'Les mois imputés sont à venir : l’accord se décide avant eux.' },
	AGREEMENT_ALREADY_DECIDED: { status: 409, message: 'Cet accord est déjà décidé.' },
	AGREEMENT_IMMUTABLE: { status: 409, message: 'Une proposition ne change pas : elle s’accepte ou se refuse.' },
	AGREEMENT_DOCUMENT_INVALID: { status: 400, message: 'L’accord écrit est un document de ce bail.' },
	AGREEMENT_MISSING: { status: 409, message: 'Sans accord d’imputation sur loyer, la caution ne paie pas de loyer.' },
	AGREEMENT_NOT_ACCEPTED: { status: 409, message: 'L’accord n’est pas accepté.' },
	AGREEMENT_AFTER_PERIOD: { status: 409, message: 'L’accord est accepté avant le mois concerné, et le couvre.' },
	REPAIR_NOT_TENANT_DAMAGE: { status: 409, message: 'Une réparation vise une ligne de sortie imputable au locataire.' },
	REPAIR_BORN_PLANNED: { status: 409, message: 'Une réparation naît prévue.' },
	REPAIR_IMMUTABLE: { status: 409, message: 'La ligne et l’auteur d’une réparation ne changent pas.' },
	REPAIR_TRANSITION_FORBIDDEN: { status: 409, message: 'Ce changement de statut n’est pas permis.' },
	REPAIR_LOCKED: { status: 409, message: 'Une réparation faite ne change plus.' },
	REPAIR_PROOF_INVALID: { status: 400, message: 'Le justificatif n’est pas un devis ou une facture de ce bail.' },
	REPAIR_SELF_REPAIR_NOT_AGREED: { status: 409, message: 'Le locataire ne répare qu’avec un accord accepté.' },
	REPAIR_EXPENSE_INVALID: {
		status: 409,
		message: 'La dépense de la réparation est supportée par le locataire et récupérée sur la caution.'
	},
	SETTLEMENT_BORN_DRAFT: { status: 409, message: 'Un décompte naît brouillon.' },
	SETTLEMENT_LEASE_NOT_ENDING: { status: 409, message: 'Le décompte suit un préavis ou une fin de bail.' },
	SETTLEMENT_IMMUTABLE: { status: 409, message: 'Le compte d’un décompte ne change pas.' },
	SETTLEMENT_CLOSED: { status: 409, message: 'Ce décompte est clos.' },
	SETTLEMENT_TRANSITION_FORBIDDEN: { status: 409, message: 'Ce changement de statut n’est pas permis.' },
	SETTLEMENT_REVISION: { status: 409, message: 'Une nouvelle révision se fait en brouillon.' },
	SETTLEMENT_LOCKED: { status: 409, message: 'Le décompte est proposé : revenez au brouillon pour le modifier.' },
	SETTLEMENT_DISPUTE_OUTCOME: { status: 400, message: 'L’issue est un document « issue d’une contestation » de ce bail.' },
	SETTLEMENT_MOVEMENTS_MISSING: { status: 409, message: 'Les mouvements du décompte ne sont pas tous écrits.' },
	SETTLEMENT_ACCOUNT_MISMATCH: { status: 409, message: 'Le décompte est celui d’un autre compte de caution.' },
	RETENTION_NOT_TENANT_DAMAGE: { status: 409, message: 'Une retenue vise une ligne d’état des lieux imputable au locataire.' },
	RETENTION_PROOF_MISSING: { status: 409, message: 'Une retenue a son devis ou sa facture.' },
	DEBT_NOT_THIS_LEASE: { status: 409, message: 'L’échéance est celle du bail de la caution.' },
	DEBT_NOT_CLAIMED: { status: 409, message: 'La dépense n’est pas réclamée au locataire de ce bail.' },
	DEBT_PROOF_MISSING: { status: 409, message: 'Une dépense retenue sur la caution a son justificatif.' },
	DEBT_NOT_UTILITY_BILL: { status: 409, message: 'La garantie des factures ne couvre que l’eau et l’électricité.' },
	DEPOSIT_OFFSET_MISMATCH: { status: 409, message: 'L’encaissement lié est une imputation sur caution de ce bail, du même montant.' },
	DEPOSIT_OFFSET_UNBACKED: { status: 409, message: 'Une imputation sur caution est portée par un mouvement de caution.' },
	RENT_DUE_EXIT_ADJUSTMENT: { status: 409, message: 'La dernière période ne se raccourcit qu’une fois, à la sortie.' },
	MANDATE_SCOPE_ENDED: { status: 409, message: 'La fin d’une portée ne se réécrit pas.' },
	PAYMENT_ALLOCATION_MISMATCH: { status: 409, message: 'Les imputations ne correspondent pas au montant de l’encaissement.' },
	ALLOCATION_ON_REVERSAL: { status: 409, message: 'Une contre-écriture n’est jamais imputée.' },
	ALLOCATION_LEASE: { status: 409, message: 'Une imputation reste sur le bail de son encaissement.' },
	ALLOCATION_NOT_CONFIRMED: { status: 409, message: 'Seul un encaissement confirmé est imputé.' },
	ALLOCATION_PURPOSE: { status: 409, message: 'Un loyer s’impute sur les échéances, une caution sur son compte.' },
	ALLOCATION_DUE_WAIVED: { status: 409, message: 'Une échéance abandonnée ne reçoit rien.' },
	ALLOCATION_NEGATIVE: { status: 409, message: 'On ne contrepasse pas plus que ce qui a été imputé.' },
	RENT_DUE_PAID_BY_ALLOCATIONS: { status: 409, message: 'Le montant payé d’une échéance vient de ses imputations.' },
	DEPOSIT_CANCELLATION_BELOW_OUTFLOWS: {
		status: 409,
		message: 'Annuler ce versement ferait passer la caution reçue sous les sorties déjà faites (règle 14).'
	},
	DEPOSIT_RECEIPT_VIA_PAYMENT: {
		status: 409,
		message: 'Un versement de caution s’encaisse, avec son reçu : passez par « Encaisser ».'
	},
	DEPOSIT_CANCELLATION_UNMATCHED: { status: 409, message: 'On n’annule que ce que cet encaissement a versé.' },
	RECEIPT_PAYMENT_NOT_FOUND: { status: 404, message: 'Encaissement introuvable.' },
	RECEIPT_ON_REVERSAL: { status: 409, message: 'Une contre-écriture n’a pas de reçu.' },
	RECEIPT_NUMBER_BY_SERVER: { status: 409, message: 'Le numéro d’un reçu est attribué par le serveur, à la validation.' },
	RECEIPT_IMMUTABLE: { status: 409, message: 'Un reçu émis ne change plus.' },
	RECEIPT_TRANSITION_FORBIDDEN: { status: 409, message: 'Ce changement de statut du reçu n’est pas permis.' },
	RECEIPT_CANCELLED_WITH_PAYMENT: { status: 409, message: 'Un reçu s’annule avec son encaissement.' },
	RECEIPT_PAYMENT_NOT_CONFIRMED: { status: 409, message: 'Un reçu n’est numéroté qu’à la confirmation de son encaissement.' },
	RECEIPT_SNAPSHOT_REQUIRED: { status: 409, message: 'Un reçu émis porte sa date et sa copie figée.' },
	RECEIPT_PREFIX_MISSING: { status: 409, message: 'Le préfixe des reçus n’est pas réglé.' },
	RECEIPT_PREFIX_LOCKED: {
		status: 409,
		message: 'Le préfixe des reçus est figé depuis le premier reçu ; seul le support de la plateforme peut le changer.'
	},
	RECEIPT_PREFIX_REQUIRED: { status: 409, message: 'Un préfixe de reçu ne s’efface pas.' },
	RECEIPT_NUMBERING_STARTED: { status: 409, message: 'La date du premier reçu ne change pas.' },
	RECEIPT_FIRST_NUMBER_LOCKED: { status: 409, message: 'Un reçu a déjà été émis : le premier numéro ne se fixe plus.' },
	RECEIPT_FIRST_NUMBER_ALREADY_SET: { status: 409, message: 'Le premier numéro a déjà été fixé ; il ne se fixe qu’une fois.' },
	RECEIPT_FIRST_NUMBER_INVALID: { status: 400, message: 'Le premier numéro vaut 1 au moins.' },
	RECEIPT_TOKEN_REVOKED: { status: 409, message: 'Ce lien est déjà révoqué.' },
	// Lot 10 : relances, dépenses, relevés, reversements (migrations 0017 et 0018).
	REMINDER_SUBJECT_INVALID: { status: 409, message: 'Une échéance ou une dépense visée n’est pas celle de ce locataire.' },
	EXPENSE_IMMUTABLE: { status: 409, message: 'Une dépense enregistrée ne se modifie pas : corrigez par une annulation.' },
	EXPENSE_DATE_IN_FUTURE: { status: 400, message: 'La date de la dépense est dans le futur.' },
	EXPENSE_COMBINATION_UNSUPPORTED: { status: 400, message: 'Cette combinaison n’est pas prise en charge.' },
	EXPENSE_LEASE_MISMATCH: { status: 409, message: 'Le bail n’est pas celui de ce bien ou de cette unité.' },
	EXPENSE_CLAIM_RECOVERED: {
		status: 409,
		message: 'Une dépense déjà remboursée en partie ne s’annule pas : annulez d’abord ses encaissements.'
	},
	EXPENSE_CLAIM_PENDING: { status: 409, message: 'Un encaissement de cette dépense attend sa validation.' },
	EXPENSE_OVERPAID: { status: 409, message: 'Le remboursement dépasse le montant de la dépense.' },
	PAYMENT_EXPENSE_NOT_CLAIMED: { status: 409, message: 'Cette dépense n’est pas réclamée au locataire de ce bail.' },
	PAYMENT_EXPENSE_CANCELLED: { status: 409, message: 'Cette dépense est annulée.' },
	STATEMENT_IMMUTABLE: { status: 409, message: 'Un relevé émis est figé : corrigez par un rectificatif.' },
	STATEMENT_LANDLORD: { status: 409, message: 'Un bailleur particulier n’a pas de relevé propriétaire.' },
	STATEMENT_RECTIFICATION_INVALID: { status: 409, message: 'Un rectificatif suit la dernière version émise du même mois.' },
	STATEMENT_RECTIFICATION_NOT_LATEST: { status: 409, message: 'Un rectificatif ne vise que le dernier relevé émis.' },
	STATEMENT_PERIOD_NOT_ENDED: { status: 409, message: 'Le mois n’est pas terminé.' },
	STATEMENT_ALREADY_ISSUED: { status: 409, message: 'Le relevé de ce mois est déjà émis : faites un rectificatif.' },
	STATEMENT_OUT_OF_ORDER: { status: 409, message: 'Un relevé plus récent est déjà émis pour ce propriétaire.' },
	STATEMENT_ISSUED_BY: { status: 409, message: 'Une émission a son auteur.' },
	STATEMENT_LINES_AT_ISSUE: { status: 409, message: 'Les éléments d’un relevé s’écrivent à son émission.' },
	STATEMENT_LINE_INVALID: { status: 409, message: 'Cet élément n’entre pas dans le relevé de ce propriétaire.' },
	STATEMENT_NOT_ISSUED: { status: 409, message: 'Ce relevé n’est pas émis.' },
	STATEMENT_TOKEN_REVOKED: { status: 409, message: 'Ce lien est déjà révoqué.' },
	PAYOUT_OWNER_MISMATCH: { status: 409, message: 'Le reversement va au propriétaire du relevé.' },
	PAYOUT_REVERSAL_INVALID: { status: 409, message: 'Une contre-écriture compense un reversement à l’identique.' },
	PAYOUT_DATE_IN_FUTURE: { status: 400, message: 'La date du reversement est dans le futur.' },
	PAYOUT_NOTHING_DUE: { status: 409, message: 'Rien à reverser sur ce relevé.' },
	PAYOUT_EXCEEDS_NET: { status: 409, message: 'Le total reversé dépasserait le net du relevé.' }
};

/** Contraintes nommées traduites en refus métier (le reste : CONFLICT). */
const CONSTRAINTS: Record<string, { code: string; status: number; message: string }> = {
	mandate_scopes_one_manager_per_unit: {
		code: 'UNIT_ALREADY_MANAGED',
		status: 409,
		message: 'Cette unité est déjà sous un mandat de gestion actif (règle 12) : passez par un transfert de gestion.'
	},
	mandate_scopes_one_manager_per_property: {
		code: 'UNIT_ALREADY_MANAGED',
		status: 409,
		message: 'Ce bien est déjà sous un mandat de gestion actif (règle 12) : passez par un transfert de gestion.'
	},
	units_label_per_property: { code: 'UNIT_LABEL_TAKEN', status: 409, message: 'Ce bien a déjà une unité avec ce libellé.' },
	// Lot 08, règle 8 : la base tranche en dernier ressort (deux appareils hors ligne, deux envois simultanés).
	leases_one_in_force_per_unit: {
		code: 'UNIT_ALREADY_LEASED',
		status: 409,
		message: 'Cette unité a déjà un bail en vigueur (règle 8) : un seul bail actif par unité.'
	},
	leases_one_reserved_per_unit: {
		code: 'UNIT_ALREADY_RESERVED',
		status: 409,
		message: 'Cette unité a déjà un bail signé qui commence plus tard.'
	},
	deposit_accounts_once: {
		code: 'DEPOSIT_ACCOUNT_EXISTS',
		status: 409,
		message: 'Ce bail a déjà un compte pour ce dépôt.'
	},
	// Lot 09, point b du porteur : la base tranche en dernier ressort (deux appareils hors ligne, deux envois simultanés).
	payments_mobile_money_reference: {
		code: 'MOBILE_MONEY_REFERENCE_DUPLICATE',
		status: 409,
		message: 'Cette référence Mobile Money est déjà enregistrée chez cet opérateur. Vérifiez la transaction.'
	},
	payments_reversed_once: { code: 'PAYMENT_ALREADY_CANCELLED', status: 409, message: 'Cet encaissement est déjà annulé.' },
	receipts_one_per_payment: { code: 'RECEIPT_EXISTS', status: 409, message: 'Cet encaissement a déjà son reçu.' },
	// Lot 10 : la base tranche en dernier ressort (deux émissions, deux reversements simultanés).
	owner_statement_lines_once: {
		code: 'STATEMENT_ITEM_TAKEN',
		status: 409,
		message: 'Un élément de ce relevé est déjà repris dans un autre relevé.'
	},
	owner_statements_version_unique: { code: 'STATEMENT_EXISTS', status: 409, message: 'Ce relevé existe déjà.' },
	owner_payouts_reversed_once: { code: 'PAYOUT_ALREADY_CANCELLED', status: 409, message: 'Ce reversement est déjà annulé.' },
	// Lot 10 ter : une fiche n'est liée qu'à une personne à la fois.
	person_links_one_per_owner: { code: 'PERSON_LINK_EXISTS', status: 409, message: 'Cette fiche est déjà liée ou en cours de liaison.' },
	person_links_one_per_tenant: { code: 'PERSON_LINK_EXISTS', status: 409, message: 'Cette fiche est déjà liée ou en cours de liaison.' }
};

/** Clés étrangères composites : la ligne visée n'existe pas dans l'organisation (règle 1). */
const FOREIGN_KEYS: Record<string, { code: string; message: string }> = {
	documents_lease_fk: { code: 'LEASE_NOT_FOUND', message: 'Bail introuvable.' },
	documents_tenant_fk: { code: 'TENANT_NOT_FOUND', message: 'Locataire introuvable.' },
	leases_unit_fk: { code: 'UNIT_NOT_FOUND', message: 'Unité introuvable.' },
	leases_tenant_fk: { code: 'TENANT_NOT_FOUND', message: 'Locataire introuvable.' },
	deposit_accounts_lease_fk: { code: 'LEASE_NOT_FOUND', message: 'Bail introuvable.' },
	deposit_movements_account_fk: { code: 'DEPOSIT_ACCOUNT_NOT_FOUND', message: 'Compte de caution introuvable.' },
	payments_lease_fk: { code: 'LEASE_NOT_FOUND', message: 'Bail introuvable.' },
	payments_deposit_account_fk: { code: 'DEPOSIT_ACCOUNT_NOT_FOUND', message: 'Compte de caution introuvable.' },
	payment_allocations_due_fk: { code: 'RENT_DUE_NOT_FOUND', message: 'Échéance introuvable.' },
	// Lot 10.
	payments_expense_fk: { code: 'EXPENSE_NOT_FOUND', message: 'Dépense introuvable.' },
	reminders_tenant_fk: { code: 'TENANT_NOT_FOUND', message: 'Locataire introuvable.' },
	expenses_property_fk: { code: 'PROPERTY_NOT_FOUND', message: 'Bien introuvable.' },
	expenses_unit_fk: { code: 'UNIT_NOT_FOUND', message: 'Unité introuvable.' },
	expenses_lease_fk: { code: 'LEASE_NOT_FOUND', message: 'Bail introuvable.' },
	expenses_document_fk: { code: 'DOCUMENT_NOT_FOUND', message: 'Justificatif introuvable.' },
	owner_statements_owner_fk: { code: 'OWNER_NOT_FOUND', message: 'Propriétaire introuvable.' },
	owner_payouts_statement_fk: { code: 'STATEMENT_NOT_FOUND', message: 'Relevé introuvable.' },
	// Lot 10 ter.
	person_links_owner_fk: { code: 'OWNER_NOT_FOUND', message: 'Propriétaire introuvable.' },
	person_links_tenant_fk: { code: 'TENANT_NOT_FOUND', message: 'Locataire introuvable.' },
	maintenance_requests_lease_fk: { code: 'LEASE_NOT_FOUND', message: 'Bail introuvable.' }
};

interface PgLike {
	code?: string;
	message?: string;
	constraint?: string;
}

/** Erreur PostgreSQL (directe ou enveloppée par Drizzle) → AppError, ou null si elle n'est pas connue. */
export function fromDatabaseError(error: unknown): AppError | null {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current; depth += 1) {
		const pg = current as PgLike;
		if (pg.code === 'P0001' && pg.message) {
			const key = Object.keys(RULES).find((k) => pg.message!.startsWith(k));
			if (key) return new AppError(key, RULES[key]!.message, RULES[key]!.status);
		}
		if (pg.code === '23505') {
			const known = pg.constraint ? CONSTRAINTS[pg.constraint] : undefined;
			if (known) return new AppError(known.code, known.message, known.status);
			return new AppError('CONFLICT', 'Cette valeur existe déjà.', 409);
		}
		if (pg.code === '23503' && pg.constraint && FOREIGN_KEYS[pg.constraint]) {
			const fk = FOREIGN_KEYS[pg.constraint]!;
			return new AppError(fk.code, fk.message, 404);
		}
		if (pg.code === '42501') return new AppError('FORBIDDEN', 'Accès refusé.', 403);
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}
