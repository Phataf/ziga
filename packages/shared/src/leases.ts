/**
 * Locataires, baux, échéances et comptes de caution (lot 08, D14, D15, D20, D24), partagés par l'API, la
 * synchronisation et les formulaires. L'échéancier lui-même est dans `rent-schedule.ts`.
 *
 * - Bail : `draft` → validé (`signed` si son début est futur, `active` sinon, décidé par le serveur) → `notice` →
 *   `ended` (lot 10 bis) ; `draft` ou `signed` → `cancelled`. Le statut envoyé par un appareil n'est qu'une demande.
 * - Occupation de l'unité (règle 13) : calculée à partir des baux, jamais stockée ni saisie. Le contrat n'y entre
 *   pas : un bail en vigueur sans contrat signé porte seulement l'alerte « Contrat non signé » (D20).
 * - Caution (règle 14, D15) : compte en ajout seul, détenteur obligatoire ; au-delà de deux mois de loyer (loyer seul,
 *   hors charges, caution seulement), avertissement et audit, sans blocage. L'avance n'est pas une caution.
 */
import { z } from 'zod';
import { addDays, isIsoDate } from './dates.js';
import { idSchema } from './ids.js';
import { fcfaSchema, type Fcfa } from './money.js';
import { ID_DOCUMENT_TYPES } from './organizations.js';
import type { OrganizationType } from './permissions.js';
import { phoneSchema } from './phone.js';
import { isAvailable, occupancyOf, type AvailabilityInput, type Occupancy, type OccupancySignal } from './properties.js';
import { endOnFromDuration, isAnniversaryOf, MONTHS_PER_PERIOD, RENT_BILLING_MODES, RENT_PERIODICITIES } from './rent-schedule.js';
import { patchShape } from './schema-helpers.js';

// ---------------------------------------------------------------- valeurs légales par défaut (D24, D25)

/**
 * Paramètres du bail par défaut, issus de la loi n° 103-2015/CNT telle que lue dans docs/AUDIT.md et des réponses du
 * porteur (lot 08). À CONFIRMER PAR LE JURISTE (question ouverte de docs/DECISIONS.md) : préavis du locataire
 * (articles 45 et 46), préavis du bailleur, délai de restitution, reconduction, plafond de la caution (article 26).
 * Le jour d'échéance (le 5) vient du modèle de l'agence pilote, pas de la loi. Ni pénalité de retard ni garantie des
 * factures par défaut (D25) : elles s'ajoutent bail par bail si l'organisation les choisit.
 */
export const LEGAL_LEASE_DEFAULTS = {
	dueDay: 5,
	periodicity: 'monthly',
	noticeTenantFixedTermMonths: 2,
	noticeTenantOpenEndedMonths: 3,
	noticeLessorFixedTermMonths: 3,
	noticeLessorOpenEndedMonths: 3,
	reducedNoticeMonths: null,
	reducedNoticeCases: null,
	earlyTerminationIndemnityMonths: null,
	renewalMode: 'open_ended',
	depositRefundDays: 30,
	penaltyRateBp: null,
	penaltyGraceDays: null,
	penaltyBeneficiary: null
} as const;

/** Plafond légal de la caution, en mois de loyer hors charges (article 26, à confirmer par le juriste). */
export const DEPOSIT_LEGAL_CAP_MONTHS = 2;

// ---------------------------------------------------------------- bail : statuts et occupation

export const LEASE_STATUSES = ['draft', 'signed', 'active', 'notice', 'ended', 'cancelled'] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

/** Statuts qui occupent l'unité au sens de l'index unique (règle 8). */
export const LEASE_IN_FORCE_STATUSES = ['active', 'notice'] as const satisfies readonly LeaseStatus[];

export const LEASE_TRANSITIONS: Record<LeaseStatus, readonly LeaseStatus[]> = {
	draft: ['signed', 'active', 'cancelled'],
	signed: ['active', 'cancelled'],
	active: ['notice', 'ended'],
	notice: ['ended'],
	ended: [],
	cancelled: []
};

export function canTransitionLease(from: LeaseStatus, to: LeaseStatus): boolean {
	return LEASE_TRANSITIONS[from].includes(to);
}

export function isLeaseInForce(status: LeaseStatus): boolean {
	return (LEASE_IN_FORCE_STATUSES as readonly LeaseStatus[]).includes(status);
}

/** Statut d'un bail à sa validation : signé, à venir, si son début est futur ; en vigueur sinon. */
export function validatedLeaseStatus(startsOn: string, today: string): 'signed' | 'active' {
	return startsOn > today ? 'signed' : 'active';
}

export interface LeaseForOccupancy {
	status: LeaseStatus;
	startsOn: string;
}

/**
 * Ce qu'un bail dit de l'occupation de son unité. Un bail signé dont le début est arrivé compte déjà comme occupé,
 * avant même le passage de la tâche quotidienne qui le rend `active`.
 */
export function leaseOccupancySignal(lease: LeaseForOccupancy, today: string): OccupancySignal | null {
	switch (lease.status) {
		case 'signed':
			return lease.startsOn > today ? 'reserved' : 'occupied';
		case 'active':
			return 'occupied';
		case 'notice':
			return 'notice';
		default:
			return null;
	}
}

/** Occupation d'une unité, calculée à partir de tous ses baux (règle 13). */
export function unitOccupancy(leases: readonly LeaseForOccupancy[], today: string): Occupancy {
	return occupancyOf(leases.map((l) => leaseOccupancySignal(l, today)).filter((s): s is OccupancySignal => s !== null));
}

/** Codes de refus de la création (ou de la validation) d'un bail. */
export type LeaseCreationBlocker = 'NO_MANAGEMENT_MANDATE' | 'UNIT_NOT_AVAILABLE' | 'UNIT_ALREADY_LEASED' | 'UNIT_ALREADY_RESERVED';

export interface LeaseCreationContext {
	startsOn: string;
	today: string;
	/** Un mandat de gestion en vigueur de l'organisation couvre l'unité (le mandat `self_managed` d'un bailleur aussi). */
	hasManagementMandate: boolean;
	/** L'unité, son occupation calculée sans le bail en cours de validation. */
	unit: AvailabilityInput;
	/** Un autre bail de l'unité est en vigueur (`active` ou `notice`). */
	otherInForce: boolean;
	/** Un autre bail de l'unité est signé, à venir. */
	otherReserved: boolean;
}

/**
 * Garde-fous de la validation d'un bail (réponses du porteur, lot 08) :
 * - un mandat de gestion en vigueur, toujours ;
 * - un bail qui commence aujourd'hui ou plus tard exige une unité disponible au sens de la règle 13 (fiche active,
 *   libre ou en préavis, prête) ;
 * - un bail déjà en cours (début passé) n'exige que l'absence d'un autre bail en vigueur, quel que soit l'état
 *   technique ;
 * - un seul bail en vigueur (règle 8) et un seul bail à venir par unité. La base tient les deux en dernier ressort.
 */
export function leaseCreationBlockers(ctx: LeaseCreationContext): LeaseCreationBlocker[] {
	const out: LeaseCreationBlocker[] = [];
	const status = validatedLeaseStatus(ctx.startsOn, ctx.today);
	if (!ctx.hasManagementMandate) out.push('NO_MANAGEMENT_MANDATE');
	if (ctx.startsOn >= ctx.today && !isAvailable(ctx.unit)) out.push('UNIT_NOT_AVAILABLE');
	if (status === 'active' && ctx.otherInForce) out.push('UNIT_ALREADY_LEASED');
	if (status === 'signed' && ctx.otherReserved) out.push('UNIT_ALREADY_RESERVED');
	return out;
}

/** Alertes d'un bail. « Contrat non signé » : bail signé ou en vigueur sans scan de bail signé (D20, lot 08 bis ensuite). */
export type LeaseAlert = 'contract_unsigned';

export function leaseAlerts(lease: { status: LeaseStatus; hasSignedContract: boolean }): LeaseAlert[] {
	const binding = lease.status === 'signed' || isLeaseInForce(lease.status);
	return binding && !lease.hasSignedContract ? ['contract_unsigned'] : [];
}

// ---------------------------------------------------------------- échéances

export const RENT_DUE_STATUSES = ['upcoming', 'due', 'partial', 'paid', 'overdue', 'waived'] as const;
export type RentDueStatus = (typeof RENT_DUE_STATUSES)[number];

export interface RentDueForStatus {
	dueOn: string;
	amountDue: Fcfa;
	amountPaid: Fcfa;
	waived?: boolean;
	/**
	 * Premier jour où l'échéance peut être en retard, si ce n'est pas le lendemain de `dueOn` : les sommes dues à la
	 * signature (avance, premier mois incomplet) ne sont en retard qu'à partir du début du bail (réponse du porteur au
	 * lot 09). Voir `rentDueOverdueFrom`.
	 */
	overdueFrom?: string | null;
}

/**
 * Premier jour de retard possible d'une échéance. Une échéance ordinaire est en retard le lendemain de sa date. Une
 * somme due à la signature (avance, ou premier mois incomplet en `calendar_prorata`) est exigible dès la signature,
 * mais n'est en retard qu'à partir de la date de début du bail, et jamais avant le lendemain de sa date (réponse du
 * porteur au lot 09, qui remplace la règle du lot 08 : « en retard le lendemain de la signature »).
 */
export function rentDueOverdueFrom(
	due: { dueOn: string; periodStart: string; isAdvance: boolean; prorated: boolean },
	leaseStartsOn: string
): string {
	const dayAfter = addDays(due.dueOn, 1);
	const dueAtSignature = due.isAdvance || (due.prorated && due.periodStart === leaseStartsOn);
	return dueAtSignature && leaseStartsOn > dayAfter ? leaseStartsOn : dayAfter;
}

/**
 * Statut d'une échéance au jour `today` : à venir avant sa date, due à sa date (et, pour une somme due à la
 * signature, jusqu'au début du bail), en retard ensuite si elle n'est pas soldée, payée en partie ou en entier selon
 * les imputations (lot 09). Le serveur le stocke (tâche quotidienne, imputations) ; l'appareil calcule le même pour
 * l'affichage.
 */
export function rentDueStatus(due: RentDueForStatus, today: string): RentDueStatus {
	if (due.waived) return 'waived';
	if (due.amountPaid >= due.amountDue) return 'paid';
	if (due.overdueFrom ? today >= due.overdueFrom : today > due.dueOn) return 'overdue';
	if (due.amountPaid > 0) return 'partial';
	return today >= due.dueOn ? 'due' : 'upcoming';
}

/** Reste à payer d'une échéance. */
export function rentDueBalance(due: { amountDue: Fcfa; amountPaid: Fcfa }): Fcfa {
	return Math.max(0, due.amountDue - due.amountPaid);
}

/** Solde d'un locataire : ce qui reste à payer sur les échéances déjà exigibles (dues ou en retard). */
export function outstandingBalance(dues: readonly RentDueForStatus[], today: string): Fcfa {
	let total = 0;
	for (const d of dues) {
		const status = rentDueStatus(d, today);
		if (status === 'due' || status === 'overdue' || (status === 'partial' && d.dueOn <= today)) total += rentDueBalance(d);
	}
	return total;
}

// ---------------------------------------------------------------- comptes de caution

export const DEPOSIT_TYPES = ['security_deposit', 'utilities_guarantee'] as const;
export type DepositType = (typeof DEPOSIT_TYPES)[number];

export const DEPOSIT_HOLDERS = ['organization', 'owner'] as const;
export type DepositHolder = (typeof DEPOSIT_HOLDERS)[number];
/**
 * Détenteur d'un compte : en plus de l'organisation et du propriétaire, le nouveau gestionnaire après un transfert de
 * gestion (lot 10 bis), nommé en texte (`holder_name`) ; jamais choisi à la création d'un compte.
 */
export type DepositAccountHolder = DepositHolder | 'third_party';

export const DEPOSIT_ACCOUNT_STATUSES = ['pending', 'partially_received', 'held', 'settling', 'closed'] as const;
export type DepositAccountStatus = (typeof DEPOSIT_ACCOUNT_STATUSES)[number];

/**
 * Au lot 08, seuls `received` et `holder_changed` sont créés ; au lot 09, `received` naît d'un encaissement (avec son
 * reçu) et `received_cancelled` est sa contre-écriture quand l'encaissement est annulé ; les autres types servent au
 * lot 10 bis (`deposit-settlement.ts`). D32 : `retained` est réservé aux réparations constatées à l'état des lieux ;
 * `applied_to_debt` (sommes dues et justifiées : loyers et charges impayés, dépenses réclamées) n'existe qu'au décompte
 * de sortie ; `applied_to_rent` est l'imputation sur loyer par accord, pour les mois d'avant le départ.
 */
export const DEPOSIT_MOVEMENT_TYPES = [
	'received',
	'received_cancelled',
	'retained',
	'applied_to_rent',
	'applied_to_debt',
	'refunded',
	'additional_claimed',
	'holder_changed'
] as const;
export type DepositMovementType = (typeof DEPOSIT_MOVEMENT_TYPES)[number];
export const DEPOSIT_MOVEMENT_TYPES_LOT_08 = ['received', 'holder_changed'] as const satisfies readonly DepositMovementType[];

/** Sorties d'argent du compte : leur total ne dépasse jamais ce qui a été reçu (règle 14). */
export const DEPOSIT_OUTFLOW_TYPES = [
	'retained',
	'applied_to_rent',
	'applied_to_debt',
	'refunded'
] as const satisfies readonly DepositMovementType[];

export interface DepositMovementForBalance {
	type: DepositMovementType;
	amount: Fcfa;
}

export interface DepositBalances {
	received: Fcfa;
	outflows: Fcfa;
	/** Ce que le détenteur garde : reçu moins sorties. */
	held: Fcfa;
	/** Ce que le locataire doit encore verser sur le montant convenu. */
	remainingDue: Fcfa;
	/** Compléments réclamés au locataire au-delà de la caution (lot 10 bis). */
	claimed: Fcfa;
}

export function depositBalances(agreedAmount: Fcfa, movements: readonly DepositMovementForBalance[]): DepositBalances {
	let received = 0;
	let outflows = 0;
	let claimed = 0;
	for (const m of movements) {
		if (m.type === 'received') received += m.amount;
		// Contre-écriture d'un versement dont l'encaissement est annulé (lot 09) : jamais une sortie d'argent.
		else if (m.type === 'received_cancelled') received -= m.amount;
		else if ((DEPOSIT_OUTFLOW_TYPES as readonly string[]).includes(m.type)) outflows += m.amount;
		else if (m.type === 'additional_claimed') claimed += m.amount;
	}
	return { received, outflows, held: received - outflows, remainingDue: Math.max(0, agreedAmount - received), claimed };
}

/**
 * Statut du compte, déduit des versements. `settling` et `closed` sont posés par le décompte de sortie (lot 10 bis)
 * et ne reviennent jamais en arrière.
 */
export function depositAccountStatus(
	agreedAmount: Fcfa,
	balances: DepositBalances,
	current: DepositAccountStatus = 'pending'
): DepositAccountStatus {
	if (current === 'settling' || current === 'closed') return current;
	if (balances.received === 0) return 'pending';
	return balances.received < agreedAmount ? 'partially_received' : 'held';
}

export type DepositMovementBlocker =
	'DEPOSIT_OVERPAID' | 'DEPOSIT_OUTFLOW_EXCEEDS_RECEIVED' | 'DEPOSIT_ACCOUNT_CLOSED' | 'DEPOSIT_CANCELLATION_BELOW_OUTFLOWS';

/** Contrôle d'un nouveau mouvement, avant la barrière de la base. */
export function depositMovementBlocker(
	account: { agreedAmount: Fcfa; status: DepositAccountStatus },
	balances: DepositBalances,
	movement: DepositMovementForBalance
): DepositMovementBlocker | null {
	if (account.status === 'closed') return 'DEPOSIT_ACCOUNT_CLOSED';
	if (movement.type === 'received' && balances.received + movement.amount > account.agreedAmount) return 'DEPOSIT_OVERPAID';
	if ((DEPOSIT_OUTFLOW_TYPES as readonly string[]).includes(movement.type) && balances.outflows + movement.amount > balances.received) {
		return 'DEPOSIT_OUTFLOW_EXCEEDS_RECEIVED';
	}
	// Annuler un versement ne fait jamais passer le reçu sous les sorties déjà faites (règle 14, réponse du porteur).
	if (movement.type === 'received_cancelled' && balances.received - movement.amount < balances.outflows) {
		return 'DEPOSIT_CANCELLATION_BELOW_OUTFLOWS';
	}
	return null;
}

/**
 * Plafond légal (réponse du porteur) : calculé sur le loyer seul, hors charges, pour la caution seulement ; la
 * garantie des factures n'y entre pas. Au-delà : avertissement explicite et ligne d'audit, jamais de blocage.
 */
export function depositAboveLegalCap(type: DepositType, agreedAmount: Fcfa, monthlyRent: Fcfa): boolean {
	return type === 'security_deposit' && agreedAmount > DEPOSIT_LEGAL_CAP_MONTHS * monthlyRent;
}

/** Détenteurs possibles : un bailleur particulier est à la fois l'organisation et le propriétaire. */
export function allowedDepositHolders(organizationType: OrganizationType): readonly DepositHolder[] {
	return organizationType === 'landlord' ? ['organization'] : DEPOSIT_HOLDERS;
}

/** Détenteur proposé : l'organisation si le mandat qui couvre l'unité l'autorise à encaisser, le propriétaire sinon. */
export function defaultDepositHolder(organizationType: OrganizationType, mandateCanCollectFunds: boolean): DepositHolder {
	if (organizationType === 'landlord') return 'organization';
	return mandateCanCollectFunds ? 'organization' : 'owner';
}

// ---------------------------------------------------------------- bailleur désigné (D24)

export const LESSOR_TYPES = ['owner', 'organization'] as const;
export type LessorType = (typeof LESSOR_TYPES)[number];

export function allowedLessorTypes(organizationType: OrganizationType): readonly LessorType[] {
	return organizationType === 'landlord' ? ['organization'] : LESSOR_TYPES;
}

export const RENEWAL_MODES = ['open_ended', 'same_duration'] as const;
export type RenewalMode = (typeof RENEWAL_MODES)[number];

export const PENALTY_BENEFICIARIES = ['organization', 'owner'] as const;
export type PenaltyBeneficiary = (typeof PENALTY_BENEFICIARIES)[number];

// ---------------------------------------------------------------- schémas : locataires

export const TENANT_STATUSES = ['active', 'archived'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const CIVILITIES = ['mr', 'mrs', 'miss'] as const;
export type Civility = (typeof CIVILITIES)[number];

const text = (max: number) => z.string().trim().max(max, { error: 'Champ trop long.' });
const optionalText = (max: number) =>
	text(max)
		.nullish()
		.transform((v) => (v ? v : null));
const optionalDate = z
	.string()
	.refine(isIsoDate, { error: 'Date invalide.' })
	.nullish()
	.transform((v) => v ?? null);
const isoDate = z.string().refine(isIsoDate, { error: 'Date invalide.' });
const optionalPhone = phoneSchema.nullish().transform((v) => v ?? null);
const nullableInt = (min: number, max: number, label: string) =>
	z
		.number({ error: `${label} : un nombre entier.` })
		.int({ error: `${label} : un nombre entier.` })
		.min(min, { error: `${label} : ${min} au moins.` })
		.max(max, { error: `${label} : ${max} au plus.` })
		.nullish()
		.transform((v) => v ?? null);
const int = (min: number, max: number, label: string) =>
	z
		.number({ error: `${label} : un nombre entier.` })
		.int({ error: `${label} : un nombre entier.` })
		.min(min, { error: `${label} : ${min} au moins.` })
		.max(max, { error: `${label} : ${max} au plus.` });

const tenantName = z.string().trim().min(2, { error: 'Indiquez le nom.' }).max(120, { error: 'Nom trop long (120 caractères au plus).' });

/**
 * Fiche du locataire : seuls le nom est exigé (aucun champ n'est obligatoire pour créer un bail, D24 ; ils existent
 * parce que le contrat les demande).
 */
const tenantFields = {
	civility: z
		.enum(CIVILITIES)
		.nullish()
		.transform((v) => v ?? null),
	fullName: tenantName,
	phone: optionalPhone,
	secondaryPhone: optionalPhone,
	nationality: optionalText(60),
	profession: optionalText(80),
	previousAddress: optionalText(200),
	emergencyContactName: optionalText(120),
	emergencyContactPhone: optionalPhone,
	notes: optionalText(2000)
};

export const tenantSchema = z.object(tenantFields);
export type TenantData = z.output<typeof tenantSchema>;
export const createTenantSchema = z.object({ id: idSchema, ...tenantFields });
export type CreateTenantInput = z.input<typeof createTenantSchema>;
export type CreateTenantData = z.output<typeof createTenantSchema>;
export const updateTenantSchema = z.object(patchShape(tenantFields));
export type UpdateTenantData = z.output<typeof updateTenantSchema>;

/**
 * État civil et pièce d'identité du locataire : ne descendent que chez le directeur et le gestionnaire (stream à part),
 * jamais chez l'agent de terrain ni le profil lecture. La copie de la pièce est dans le registre `documents`.
 */
const tenantIdentityFields = {
	birthDate: optionalDate,
	birthPlace: optionalText(120),
	idType: z
		.enum(ID_DOCUMENT_TYPES)
		.nullish()
		.transform((v) => v ?? null),
	idTypeOther: optionalText(60),
	idNumber: optionalText(40),
	idIssuedOn: optionalDate,
	idIssuedBy: optionalText(120)
};

function checkIdentity(r: { idType?: string | null; idTypeOther?: string | null }, ctx: z.RefinementCtx): void {
	if (r.idType === 'other' && !r.idTypeOther)
		ctx.addIssue({ code: 'custom', path: ['idTypeOther'], message: 'Précisez le type de pièce.' });
}

export const tenantIdentitySchema = z
	.object(tenantIdentityFields)
	.superRefine(checkIdentity)
	.transform((r) => ({ ...r, idTypeOther: r.idType === 'other' ? r.idTypeOther : null }));
export type TenantIdentity = z.output<typeof tenantIdentitySchema>;
export const updateTenantIdentitySchema = z.object(patchShape(tenantIdentityFields));

/** Création d'un locataire en ligne, avec son état civil (directeur et gestionnaire). */
export const createTenantWithIdentitySchema = createTenantSchema.extend({
	identity: tenantIdentitySchema.nullish().transform((v) => v ?? null)
});

/** Pagination par curseur (CLAUDE.md §6) : identifiant du dernier élément reçu, 50 par page par défaut. */
export const pageQuerySchema = z.object({
	cursor: idSchema.nullish().transform((v) => v ?? null),
	limit: z.coerce.number().int().min(1).max(200).default(50)
});

/** Montant convenu d'un compte de caution, tant que le bail est un brouillon. */
export const updateDepositAccountSchema = z.object({
	agreedAmount: fcfaSchema.min(1, { error: 'Indiquez le montant.' }).optional(),
	agreedMonths: nullableInt(1, 24, 'Mois').optional()
});

// ---------------------------------------------------------------- schémas : baux

/** Conditions et paramètres du bail (D24) ; valeurs légales par défaut, modifiables bail par bail. */
const leaseTermFields = {
	startsOn: isoDate,
	endsOn: optionalDate,
	durationMonths: nullableInt(1, 600, 'Durée'),
	/** Première date facturée ; par défaut, la date d'entrée (bail repris en cours : plus tard). */
	duesStartOn: optionalDate,
	rent: fcfaSchema.min(1, { error: 'Indiquez le loyer.' }),
	charges: fcfaSchema.default(0),
	// Trimestriel prévu dans le modèle de données, pas encore proposé (MVP).
	periodicity: z
		.enum(RENT_PERIODICITIES)
		.refine((p): boolean => p === 'monthly', { error: 'Seule la périodicité mensuelle est proposée.' })
		.default('monthly'),
	dueDay: int(1, 28, 'Jour d’échéance').default(LEGAL_LEASE_DEFAULTS.dueDay),
	billingMode: z.enum(RENT_BILLING_MODES),
	advanceMonths: int(0, 24, 'Avance').default(0),
	lessorType: z.enum(LESSOR_TYPES),
	paymentTerms: optionalText(500),
	penaltyRateBp: nullableInt(1, 10_000, 'Pénalité'),
	penaltyGraceDays: nullableInt(0, 365, 'Délai de grâce'),
	penaltyBeneficiary: z
		.enum(PENALTY_BENEFICIARIES)
		.nullish()
		.transform((v) => v ?? null),
	noticeTenantFixedTermMonths: int(0, 12, 'Préavis').default(LEGAL_LEASE_DEFAULTS.noticeTenantFixedTermMonths),
	noticeTenantOpenEndedMonths: int(0, 12, 'Préavis').default(LEGAL_LEASE_DEFAULTS.noticeTenantOpenEndedMonths),
	noticeLessorFixedTermMonths: int(0, 12, 'Préavis').default(LEGAL_LEASE_DEFAULTS.noticeLessorFixedTermMonths),
	noticeLessorOpenEndedMonths: int(0, 12, 'Préavis').default(LEGAL_LEASE_DEFAULTS.noticeLessorOpenEndedMonths),
	reducedNoticeMonths: nullableInt(0, 12, 'Préavis réduit'),
	reducedNoticeCases: optionalText(500),
	earlyTerminationIndemnityMonths: nullableInt(0, 12, 'Indemnité de départ anticipé'),
	renewalMode: z.enum(RENEWAL_MODES).default(LEGAL_LEASE_DEFAULTS.renewalMode),
	depositRefundDays: int(0, 365, 'Délai de restitution').default(LEGAL_LEASE_DEFAULTS.depositRefundDays)
};

interface LeaseTermsShape {
	startsOn: string;
	endsOn: string | null;
	durationMonths: number | null;
	duesStartOn: string | null;
	periodicity: (typeof RENT_PERIODICITIES)[number];
	billingMode?: (typeof RENT_BILLING_MODES)[number];
	advanceMonths: number;
	penaltyRateBp: number | null;
	penaltyGraceDays: number | null;
	penaltyBeneficiary: PenaltyBeneficiary | null;
}

function checkLeaseTerms(t: LeaseTermsShape, ctx: z.RefinementCtx): void {
	if (t.endsOn && t.endsOn < t.startsOn) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'La fin précède le début.' });
	if (t.endsOn && t.durationMonths && endOnFromDuration(t.startsOn, t.durationMonths) !== t.endsOn) {
		ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'La date de fin ne correspond pas à la durée.' });
	}
	const duesStartOn = t.duesStartOn ?? t.startsOn;
	const endsOn = t.endsOn ?? (t.durationMonths ? endOnFromDuration(t.startsOn, t.durationMonths) : null);
	if (duesStartOn < t.startsOn || (endsOn && duesStartOn > endsOn)) {
		ctx.addIssue({ code: 'custom', path: ['duesStartOn'], message: 'La facturation commence pendant le bail.' });
	}
	const perPeriod = MONTHS_PER_PERIOD[t.periodicity];
	if (t.billingMode === 'anniversary' && !isAnniversaryOf(duesStartOn, t.startsOn, perPeriod)) {
		ctx.addIssue({
			code: 'custom',
			path: ['duesStartOn'],
			message: 'En mode anniversaire, la facturation commence un jour anniversaire de l’entrée.'
		});
	}
	if (t.advanceMonths % perPeriod !== 0)
		ctx.addIssue({ code: 'custom', path: ['advanceMonths'], message: 'Avance : un nombre entier de périodes.' });
	const penalty = [t.penaltyRateBp, t.penaltyGraceDays, t.penaltyBeneficiary];
	if (penalty.some((v) => v !== null) && penalty.some((v) => v === null)) {
		ctx.addIssue({ code: 'custom', path: ['penaltyRateBp'], message: 'Pénalité : taux, délai de grâce et bénéficiaire, ou aucun.' });
	}
}

/** Termes complets, fin et début de facturation résolus (durée → date de fin ; facturation → date d'entrée). */
function resolveTerms<T extends LeaseTermsShape>(t: T): T & { endsOn: string | null; duesStartOn: string } {
	return {
		...t,
		endsOn: t.endsOn ?? (t.durationMonths ? endOnFromDuration(t.startsOn, t.durationMonths) : null),
		duesStartOn: t.duesStartOn ?? t.startsOn
	};
}

export const leaseTermsSchema = z.object(leaseTermFields).superRefine(checkLeaseTerms).transform(resolveTerms);
export type LeaseTerms = z.output<typeof leaseTermsSchema>;

/**
 * Création d'un bail. `validate` : vrai pour un bail validé tout de suite (le serveur décide `signed` ou `active`),
 * faux pour un brouillon. Le mode de découpage est recopié du réglage de l'organisation et figé ensuite.
 */
export const createLeaseSchema = z
	.object({
		id: idSchema,
		unitId: idSchema,
		tenantId: idSchema,
		validate: z.boolean().default(true),
		...leaseTermFields,
		// Absent : le serveur recopie le réglage de l'organisation (rent_billing_mode).
		billingMode: z.enum(RENT_BILLING_MODES).optional()
	})
	.superRefine(checkLeaseTerms)
	.transform(resolveTerms);
export type CreateLeaseInput = z.input<typeof createLeaseSchema>;
export type CreateLeaseData = z.output<typeof createLeaseSchema>;

/** Modification d'un brouillon (le serveur fusionne puis revalide les termes complets avec `leaseTermsSchema`). */
export const updateLeaseDraftSchema = z.object(patchShape({ tenantId: idSchema, ...leaseTermFields }));
export type UpdateLeaseDraftData = z.output<typeof updateLeaseDraftSchema>;

/** Changement de loyer d'un bail validé : nouvelle version, date d'effet, contrôlé par la version attendue. */
export const rentChangeSchema = z.object({
	rent: fcfaSchema.min(1, { error: 'Indiquez le loyer.' }),
	charges: fcfaSchema,
	effectiveFrom: isoDate,
	expectedVersion: int(1, 1_000_000, 'Version')
});
export type RentChangeData = z.output<typeof rentChangeSchema>;

/** Annulation d'un brouillon ou d'un bail signé à venir : motif obligatoire. */
export const cancelLeaseSchema = z.object({
	reason: z.string().trim().min(3, { error: 'Indiquez le motif.' }).max(500, { error: 'Motif trop long.' })
});

// ---------------------------------------------------------------- schémas : caution

export const createDepositAccountSchema = z.object({
	id: idSchema,
	leaseId: idSchema,
	type: z.enum(DEPOSIT_TYPES),
	agreedAmount: fcfaSchema.min(1, { error: 'Indiquez le montant.' }),
	/** Montant saisi en mois de loyer : nombre de mois, pour information (le montant reste en FCFA). */
	agreedMonths: nullableInt(1, 24, 'Mois'),
	holder: z.enum(DEPOSIT_HOLDERS, { error: 'Indiquez qui détient la caution.' })
});
export type CreateDepositAccountData = z.output<typeof createDepositAccountSchema>;

/** Changement de détenteur en cours de bail : un mouvement, jamais une modification du compte. */
export const depositHolderChangeSchema = z.object({
	id: idSchema,
	accountId: idSchema,
	newHolder: z.enum(DEPOSIT_HOLDERS),
	occurredOn: isoDate,
	reason: z.string().trim().min(3, { error: 'Indiquez le motif.' }).max(500, { error: 'Motif trop long.' })
});
export type DepositHolderChangeData = z.output<typeof depositHolderChangeSchema>;

// ---------------------------------------------------------------- vues (API et appareil)

export interface TenantView {
	id: string;
	civility: Civility | null;
	fullName: string;
	phone: string | null;
	secondaryPhone: string | null;
	nationality: string | null;
	profession: string | null;
	previousAddress: string | null;
	emergencyContactName: string | null;
	emergencyContactPhone: string | null;
	notes: string | null;
	status: TenantStatus;
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** État civil et pièce d'identité : directeur et gestionnaire seulement (`tenant.read_identity`). */
export type TenantIdentityView = TenantIdentity;

export interface RentDueView {
	id: string;
	leaseId: string;
	periodStart: string;
	periodEnd: string;
	dueOn: string;
	rent: Fcfa;
	charges: Fcfa;
	amountDue: Fcfa;
	amountPaid: Fcfa;
	balance: Fcfa;
	status: RentDueStatus;
	prorated: boolean;
	isAdvance: boolean;
	leaseVersion: number;
	/** Lot 11 : `opening_balance`, l'échéance « Solde antérieur » d'un bail importé (hors de l'échéancier du bail). */
	kind: RentDueKind;
}

export const RENT_DUE_KINDS = ['rent', 'opening_balance'] as const;
export type RentDueKind = (typeof RENT_DUE_KINDS)[number];

export interface DepositMovementView {
	id: string;
	accountId: string;
	type: DepositMovementType;
	amount: Fcfa;
	previousHolder: DepositAccountHolder | null;
	newHolder: DepositAccountHolder | null;
	reason: string | null;
	occurredOn: string;
	documentId: string | null;
	createdBy: string | null;
	createdAt: string;
}

export interface DepositAccountView {
	id: string;
	leaseId: string;
	type: DepositType;
	agreedAmount: Fcfa;
	agreedMonths: number | null;
	holder: DepositAccountHolder;
	/** Nouveau gestionnaire, nommé en texte, après un transfert de gestion (lot 10 bis). */
	holderName?: string | null;
	status: DepositAccountStatus;
	balances: DepositBalances;
	/** Caution au-delà de deux mois de loyer (hors charges) : avertissement, jamais un blocage. */
	aboveLegalCap: boolean;
	movements: DepositMovementView[];
}

export interface LeaseVersionView {
	version: number;
	rent: Fcfa;
	charges: Fcfa;
	rentEffectiveFrom: string;
	status: LeaseStatus;
	changedBy: string | null;
	recordedAt: string;
}

export interface LeaseView extends Omit<LeaseTerms, 'billingMode'> {
	id: string;
	unitId: string;
	tenantId: string;
	billingMode: (typeof RENT_BILLING_MODES)[number];
	rentEffectiveFrom: string;
	status: LeaseStatus;
	activatedOn: string | null;
	cancelledAt: string | null;
	cancellationReason: string | null;
	noticeGivenOn: string | null;
	exitOn: string | null;
	version: number;
	alerts: LeaseAlert[];
	createdAt: string;
	updatedAt: string;
}

export interface LeaseDetailView extends LeaseView {
	versions: LeaseVersionView[];
	rentDues: RentDueView[];
	/** Absent pour l'agent de terrain (`deposit.read`). */
	deposits: DepositAccountView[] | null;
	/** Encours exigible du bail (dû ou en retard). */
	outstanding: Fcfa;
}

export interface TenantDetailView extends TenantView {
	/** Absent sans `tenant.read_identity`. */
	identity: TenantIdentityView | null;
	leases: LeaseView[];
	/** Encours exigible, tous baux confondus. */
	outstanding: Fcfa;
}

/** Réponse d'une écriture qui peut porter un avertissement (caution au-delà de deux mois de loyer). */
export interface WithWarnings<T> {
	data: T;
	warnings: LeaseWarning[];
}

export type LeaseWarning = 'DEPOSIT_ABOVE_LEGAL_CAP';

/** Une page de résultats, pagination par curseur (CLAUDE.md §6). */
export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}
