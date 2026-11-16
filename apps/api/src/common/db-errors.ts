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
	RECEIPT_TOKEN_REVOKED: { status: 409, message: 'Ce lien est déjà révoqué.' }
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
	receipts_one_per_payment: { code: 'RECEIPT_EXISTS', status: 409, message: 'Cet encaissement a déjà son reçu.' }
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
	payment_allocations_due_fk: { code: 'RENT_DUE_NOT_FOUND', message: 'Échéance introuvable.' }
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
