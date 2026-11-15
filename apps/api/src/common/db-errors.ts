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
	APPEND_ONLY: { status: 409, message: 'Cet enregistrement est en ajout seul.' }
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
	}
};

/** Clés étrangères composites : la ligne visée n'existe pas dans l'organisation (règle 1). */
const FOREIGN_KEYS: Record<string, { code: string; message: string }> = {
	documents_lease_fk: { code: 'LEASE_NOT_FOUND', message: 'Bail introuvable.' },
	documents_tenant_fk: { code: 'TENANT_NOT_FOUND', message: 'Locataire introuvable.' },
	leases_unit_fk: { code: 'UNIT_NOT_FOUND', message: 'Unité introuvable.' },
	leases_tenant_fk: { code: 'TENANT_NOT_FOUND', message: 'Locataire introuvable.' },
	deposit_accounts_lease_fk: { code: 'LEASE_NOT_FOUND', message: 'Bail introuvable.' },
	deposit_movements_account_fk: { code: 'DEPOSIT_ACCOUNT_NOT_FOUND', message: 'Compte de caution introuvable.' }
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
