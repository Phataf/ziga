/**
 * Propriétaires et mandats (lot 06, D16, D24), partagés par l'API, la synchronisation et les formulaires.
 * - Propriétaire : personne, société, ou groupe d'indivisaires avec un représentant désigné. Aucune invitation.
 * - Mandat : naît actif ; ses seules transitions sont active → revoked (révocation motivée) et active → expired
 *   (date de fin passée). Une modification d'un mandat actif crée une nouvelle version (garantie par la base).
 * - Commission (règle 2) : base stockée, avec un taux en points de base (1000 = 10 %) ou un montant entier en FCFA,
 *   jamais les deux, jamais de flottant.
 * - Statut effectif : un mandat actif dont la date de fin est passée est déjà expiré, et un mandat qui n'a pas
 *   commencé est « à venir » ; dans les deux cas, aucune autorisation.
 */
import { z } from 'zod';
import { addDays, daysBetween, isIsoDate } from './dates.js';
import { idSchema } from './ids.js';
import { fcfaSchema, NBSP } from './money.js';
import { phoneSchema } from './phone.js';

// ---------------------------------------------------------------- propriétaires

export const OWNER_TYPES = ['person', 'company', 'group'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export const OWNER_STATUSES = ['active', 'archived'] as const;
export type OwnerStatus = (typeof OWNER_STATUSES)[number];

const text = (max: number) => z.string().trim().max(max, { error: 'Champ trop long.' });
/** Texte facultatif : une chaîne vide vaut « non renseigné » (null). */
const optionalText = (max: number) =>
	text(max)
		.nullish()
		.transform((v) => (v ? v : null));

const ownerName = z.string().trim().min(2, { error: 'Indiquez le nom.' }).max(120, { error: 'Nom trop long (120 caractères au plus).' });

const email = z
	.string()
	.trim()
	.max(254, { error: 'Adresse trop longue.' })
	.refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), { error: 'Adresse e-mail invalide.' })
	.nullish()
	.transform((v) => (v ? v.toLowerCase() : null));

/** Pays de résidence : code ISO 3166-1 à deux lettres (« BF » par défaut). */
export const countrySchema = z
	.string()
	.trim()
	.transform((v) => v.toUpperCase())
	.refine((v) => /^[A-Z]{2}$/.test(v), { error: 'Pays invalide.' });

/** Représentant d'un groupe d'indivisaires : nom et téléphone. */
export const ownerRepresentativeSchema = z.object({ name: ownerName, phone: phoneSchema });
export type OwnerRepresentative = z.output<typeof ownerRepresentativeSchema>;

const ownerFields = {
	type: z.enum(OWNER_TYPES),
	name: ownerName,
	phone: phoneSchema,
	email,
	address: optionalText(200),
	country: countrySchema.default('BF'),
	representative: ownerRepresentativeSchema.nullish().transform((v) => v ?? null),
	notes: optionalText(2000)
};

/** Un groupe a un représentant ; une personne ou une société n'en a pas. */
function checkRepresentative(o: { type?: OwnerType; representative?: OwnerRepresentative | null }, ctx: z.RefinementCtx): void {
	if (o.type === 'group' && !o.representative) {
		ctx.addIssue({ code: 'custom', path: ['representative'], message: 'Indiquez le représentant du groupe.' });
	}
	if (o.type && o.type !== 'group' && o.representative) {
		ctx.addIssue({ code: 'custom', path: ['representative'], message: 'Seul un groupe d’indivisaires a un représentant.' });
	}
}

export const ownerSchema = z.object(ownerFields).superRefine(checkRepresentative);
export type OwnerInput = z.input<typeof ownerSchema>;
export type OwnerData = z.output<typeof ownerSchema>;

/** Création : identifiant UUIDv7 généré par le client (CLAUDE.md §6). */
export const createOwnerSchema = z.object({ id: idSchema, ...ownerFields }).superRefine(checkRepresentative);
export type CreateOwnerInput = z.input<typeof createOwnerSchema>;

/** Modification : champs envoyés seulement ; le serveur revalide la fiche complète avec `ownerSchema`. */
export const updateOwnerSchema = z.object(ownerFields).partial();
export type UpdateOwnerInput = z.input<typeof updateOwnerSchema>;

// ---------------------------------------------------------------- mandats

export const MANDATE_TYPES = ['rental_management', 'letting', 'sale', 'self_managed', 'other'] as const;
export type MandateType = (typeof MANDATE_TYPES)[number];

/** Créés par une organisation ; `self_managed` est réservé au bailleur, créé avec son organisation. */
export const CREATABLE_MANDATE_TYPES = ['rental_management', 'letting', 'sale', 'other'] as const satisfies readonly MandateType[];

/**
 * Mandats « de gestion » (règle 12) : ils occupent l'unité, un seul actif à la fois. `letting` (mise en location
 * seule), `sale` et `other` ne l'occupent pas.
 */
export const MANAGEMENT_MANDATE_TYPES = ['rental_management', 'self_managed'] as const satisfies readonly MandateType[];
export function isManagementMandate(type: MandateType): boolean {
	return (MANAGEMENT_MANDATE_TYPES as readonly string[]).includes(type);
}

export const MANDATE_STATUSES = ['active', 'expired', 'revoked'] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

/** Machine d'états : un mandat naît actif ; il ne fait que se fermer, une seule fois. */
export const MANDATE_TRANSITIONS: Record<MandateStatus, readonly MandateStatus[]> = {
	active: ['revoked', 'expired'],
	expired: [],
	revoked: []
};
export function canTransition(from: MandateStatus, to: MandateStatus): boolean {
	return MANDATE_TRANSITIONS[from].includes(to);
}

// ---- commission

export const COMMISSION_BASES = ['percent_of_collected', 'fixed_per_month', 'fixed_per_operation'] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];

/** Taux maximal : 10 000 points de base = 100 %. */
export const MAX_RATE_BP = 10_000;

/**
 * Base proposée selon le type (jamais déduite : la base est stockée). Le taux s'applique aux loyers encaissés,
 * pas aux loyers dus.
 */
export const DEFAULT_COMMISSION_BASIS: Partial<Record<MandateType, CommissionBasis>> = {
	rental_management: 'percent_of_collected',
	letting: 'fixed_per_operation',
	sale: 'fixed_per_operation'
};

/** Types qui exigent une commission ; `self_managed` n'en a jamais ; `other` au choix. */
export const COMMISSION_REQUIRED: readonly MandateType[] = ['rental_management', 'letting', 'sale'];

const rateBp = z
	.number({ error: 'Le taux doit être un nombre.' })
	.int({ error: 'Le taux s’exprime en points de base entiers (1000 = 10 %).' })
	.min(0, { error: 'Le taux ne peut pas être négatif.' })
	.max(MAX_RATE_BP, { error: 'Le taux ne peut pas dépasser 100 %.' });

/** Un taux ou un montant selon la base, jamais les deux (objets stricts : un champ en trop est refusé). */
export const commissionSchema = z.discriminatedUnion('basis', [
	z.strictObject({ basis: z.literal('percent_of_collected'), rateBp }),
	z.strictObject({ basis: z.literal('fixed_per_month'), amount: fcfaSchema }),
	z.strictObject({ basis: z.literal('fixed_per_operation'), amount: fcfaSchema })
]);
export type Commission = z.output<typeof commissionSchema>;

/** Colonnes de la base (et de la base locale) d'une commission. */
export interface CommissionColumns {
	commission_basis: CommissionBasis | null;
	commission_rate_bp: number | null;
	commission_amount: number | null;
}

export function commissionColumns(c: Commission | null): CommissionColumns {
	if (!c) return { commission_basis: null, commission_rate_bp: null, commission_amount: null };
	return c.basis === 'percent_of_collected'
		? { commission_basis: c.basis, commission_rate_bp: c.rateBp, commission_amount: null }
		: { commission_basis: c.basis, commission_rate_bp: null, commission_amount: c.amount };
}

export function commissionFromColumns(row: CommissionColumns): Commission | null {
	if (!row.commission_basis) return null;
	return row.commission_basis === 'percent_of_collected'
		? { basis: row.commission_basis, rateBp: Number(row.commission_rate_bp) }
		: { basis: row.commission_basis, amount: Number(row.commission_amount) };
}

/** 1000 → « 10 % », 250 → « 2,5 % », 1234 → « 12,34 % » (espace insécable avant « % »). */
export function formatRateBp(bp: number): string {
	if (!Number.isInteger(bp) || bp < 0 || bp > MAX_RATE_BP) throw new RangeError(`Taux invalide : ${bp}`);
	const whole = Math.floor(bp / 100);
	const cents = bp % 100;
	const decimals = cents === 0 ? '' : `,${String(cents).padStart(2, '0').replace(/0$/, '')}`;
	return `${whole}${decimals}${NBSP}%`;
}

// ---- conditions d'un mandat

export const MANDATE_AUTHORIZATIONS = ['canPublish', 'canTakePhotos', 'canCollectFunds', 'canSignLeases'] as const;
export type MandateAuthorization = (typeof MANDATE_AUTHORIZATIONS)[number];
export type MandateAuthorizations = Record<MandateAuthorization, boolean>;

const isoDate = z.string().refine(isIsoDate, { error: 'Date invalide.' });

const termsFields = {
	startsOn: isoDate,
	endsOn: isoDate.nullish().transform((v) => v ?? null),
	commission: commissionSchema.nullish().transform((v) => v ?? null),
	canPublish: z.boolean().default(false),
	canTakePhotos: z.boolean().default(false),
	canCollectFunds: z.boolean().default(false),
	/** L'organisation signe les baux au nom du propriétaire (D24) ; faux par défaut. */
	canSignLeases: z.boolean().default(false),
	/** Exclusivité : information seulement. */
	exclusive: z.boolean().default(false)
};

export interface MandateTerms extends MandateAuthorizations {
	startsOn: string;
	endsOn: string | null;
	commission: Commission | null;
	exclusive: boolean;
}

/** Règles qui croisent le type et les conditions : dates, commission exigée ou interdite, mandat permanent. */
export function checkMandateTerms(
	type: MandateType,
	t: Pick<MandateTerms, 'startsOn' | 'endsOn' | 'commission'>,
	ctx: z.RefinementCtx
): void {
	if (t.endsOn && t.startsOn && t.endsOn < t.startsOn) {
		ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'La fin ne peut pas précéder le début.' });
	}
	if (COMMISSION_REQUIRED.includes(type) && !t.commission) {
		ctx.addIssue({ code: 'custom', path: ['commission'], message: 'Indiquez la commission.' });
	}
	if (type === 'self_managed' && t.commission) {
		ctx.addIssue({ code: 'custom', path: ['commission'], message: 'Un bailleur qui gère lui-même ne verse pas de commission.' });
	}
	if (type === 'self_managed' && t.endsOn) {
		ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'Le mandat d’un bailleur qui gère lui-même est permanent.' });
	}
}

/** Création d'un mandat par une organisation (`self_managed` exclu) ; il naît actif. */
export const createMandateSchema = z
	.object({ id: idSchema, ownerId: idSchema, type: z.enum(CREATABLE_MANDATE_TYPES), ...termsFields })
	.superRefine((m, ctx) => checkMandateTerms(m.type, m, ctx));
export type CreateMandateInput = z.input<typeof createMandateSchema>;
export type CreateMandateData = z.output<typeof createMandateSchema>;

/** Conditions complètes d'un mandat d'un type donné (revalidées par le serveur après une modification). */
export function mandateTermsSchema(type: MandateType) {
	return z.object(termsFields).superRefine((t, ctx) => checkMandateTerms(type, t, ctx));
}

/** Modification d'un mandat actif : champs envoyés seulement ; elle crée une nouvelle version. */
export const updateMandateSchema = z
	.object({
		startsOn: isoDate,
		endsOn: isoDate.nullable(),
		commission: commissionSchema.nullable(),
		canPublish: z.boolean(),
		canTakePhotos: z.boolean(),
		canCollectFunds: z.boolean(),
		canSignLeases: z.boolean(),
		exclusive: z.boolean()
	})
	.partial()
	.refine((u) => Object.keys(u).length > 0, { error: 'Aucune modification.' });
export type UpdateMandateInput = z.input<typeof updateMandateSchema>;

/** Révocation : motif obligatoire. */
export const revokeMandateSchema = z.object({
	reason: z
		.string()
		.trim()
		.min(5, { error: 'Indiquez le motif de la révocation (5 caractères au moins).' })
		.max(500, { error: 'Motif trop long.' })
});
export type RevokeMandateInput = z.input<typeof revokeMandateSchema>;

// ---- statut effectif et alertes

export type EffectiveMandateStatus = 'upcoming' | 'active' | 'expired' | 'revoked';

export interface MandateDates {
	status: MandateStatus;
	startsOn: string;
	endsOn: string | null;
}

/**
 * Statut à une date (aaaa-mm-jj, à Ouagadougou) : la date de fin est le dernier jour couvert. Un mandat actif dont
 * la fin est passée est expiré dès le lendemain, même avant le passage de la tâche de nuit.
 */
export function effectiveMandateStatus(m: MandateDates, today: string): EffectiveMandateStatus {
	if (m.status !== 'active') return m.status;
	if (m.endsOn && m.endsOn < today) return 'expired';
	if (m.startsOn > today) return 'upcoming';
	return 'active';
}

/** Autorisations en vigueur : toutes fausses si le mandat n'est pas en vigueur à cette date. */
export function effectiveAuthorizations(m: MandateDates & MandateAuthorizations, today: string): MandateAuthorizations {
	const inForce = effectiveMandateStatus(m, today) === 'active';
	return {
		canPublish: inForce && m.canPublish,
		canTakePhotos: inForce && m.canTakePhotos,
		canCollectFunds: inForce && m.canCollectFunds,
		canSignLeases: inForce && m.canSignLeases
	};
}

/** Délai d'alerte avant la fin d'un mandat. */
export const MANDATE_ALERT_DAYS = 30;

/** Mandat en vigueur qui finit dans 30 jours ou moins : nombre de jours restants (0 = dernier jour). */
export function mandateAlert(m: MandateDates, today: string): { daysLeft: number } | null {
	if (!m.endsOn || effectiveMandateStatus(m, today) !== 'active') return null;
	const daysLeft = daysBetween(today, m.endsOn);
	return daysLeft <= MANDATE_ALERT_DAYS ? { daysLeft } : null;
}

/** Dernier jour où un mandat de cette date de fin est encore en vigueur, et premier jour où il est expiré. */
export function firstExpiredDay(endsOn: string): string {
	return addDays(endsOn, 1);
}

// ---------------------------------------------------------------- vues (réponses de l'API)

export interface OwnerView {
	id: string;
	type: OwnerType;
	name: string;
	phone: string;
	email: string | null;
	address: string | null;
	country: string;
	representative: OwnerRepresentative | null;
	notes: string | null;
	status: OwnerStatus;
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MandateView extends MandateTerms {
	id: string;
	ownerId: string;
	type: MandateType;
	status: MandateStatus;
	revokedAt: string | null;
	revocationReason: string | null;
	expiredAt: string | null;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface MandateVersionView extends MandateTerms {
	mandateId: string;
	version: number;
	status: MandateStatus;
	revokedAt: string | null;
	revocationReason: string | null;
	expiredAt: string | null;
	changedBy: string | null;
	recordedAt: string;
}

export interface OwnerDetailView extends OwnerView {
	mandates: MandateView[];
}
