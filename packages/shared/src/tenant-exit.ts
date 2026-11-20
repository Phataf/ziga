/**
 * Sortie du locataire (lot 10 bis, D14, D16, D24, D32 ; règles 12, 13, 14, 15 et 16), en fonctions pures partagées
 * par l'API, la synchronisation et les écrans. Le décompte de la caution est dans `deposit-settlement.ts`.
 *
 * - Préavis : délais et indemnité tirés des paramètres du bail (valeurs légales par défaut, D24). Une demande faite par
 *   le locataire depuis son espace (lot 10 ter) est une demande à traiter, jamais un congé.
 * - Dernier mois au prorata selon le mode du bail, échéances suivantes abandonnées ; départ anticipé : loyer dû
 *   jusqu'à la fin du préavis (sauf préavis réduit), plus l'indemnité prévue au bail (D32, À CONFIRMER PAR LE JURISTE).
 * - État des lieux : écrit, daté, signé des deux parties, sans formule vague (« bon état » seul est refusé, article 9) ;
 *   à la sortie, un constat par élément.
 * - Fin de bail (D14) : l'unité passe « à remettre en état » ; elle ne redevient disponible que déclarée prête.
 * - Transfert de gestion (D16, règle 12) : fin du mandat de A sur l'unité ou le bien, remise du dossier, changement de
 *   détenteur de la caution nommé en texte. Rien n'est copié vers une autre organisation (règle 15).
 */
import { addDays, addMonths, isIsoDate } from './dates.js';
import type { InspectionFinding, RepairPerformer, RepairStatus } from './deposit-settlement.js';
import type { Fcfa } from './money.js';
import { isIssued, type IssuedRentDue, type RentDueDraft } from './rent-schedule.js';
import type { TechnicalStatus } from './properties.js';

// ---------------------------------------------------------------- préavis

export const NOTICE_ORIGINS = ['tenant', 'lessor'] as const;
export type NoticeOrigin = (typeof NOTICE_ORIGINS)[number];

/** Mode de notification (prompt) ; la preuve est un document du registre. */
export const NOTICE_DELIVERY_MODES = ['registered_letter', 'bailiff', 'hand_delivery', 'other'] as const;
export type NoticeDeliveryMode = (typeof NOTICE_DELIVERY_MODES)[number];

/**
 * - `requested` : demande du locataire depuis son espace (lot 10 ter), à traiter ; le bail ne change pas.
 * - `recorded` : congé enregistré par l'organisation, avec sa preuve ; le bail passe en préavis.
 * - `declined` : demande non suivie (motif).
 */
export const NOTICE_STATUSES = ['requested', 'recorded', 'declined'] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export const NOTICE_TRANSITIONS: Record<NoticeStatus, readonly NoticeStatus[]> = {
	requested: ['recorded', 'declined'],
	recorded: [],
	declined: []
};

/** Seul un congé enregistré met le bail en préavis : une demande n'est jamais un congé. */
export function noticeChangesLease(status: NoticeStatus): boolean {
	return status === 'recorded';
}

/** Paramètres du bail utiles au préavis (D24). */
export interface NoticeLeaseTerms {
	status: string;
	/** Fin du bail à durée déterminée, ou `null` (durée indéterminée). */
	endsOn: string | null;
	rent: Fcfa;
	noticeTenantFixedTermMonths: number;
	noticeTenantOpenEndedMonths: number;
	noticeLessorFixedTermMonths: number;
	noticeLessorOpenEndedMonths: number;
	reducedNoticeMonths: number | null;
	earlyTerminationIndemnityMonths: number | null;
}

export interface NoticeInput {
	origin: NoticeOrigin;
	notifiedOn: string;
	plannedExitOn: string;
	/** Le locataire invoque un cas de préavis réduit prévu au bail. */
	reducedNotice: boolean;
	today: string;
}

export type NoticeBlocker =
	| 'NOTICE_LEASE_NOT_IN_FORCE'
	| 'NOTICE_DATE_INVALID'
	| 'NOTICE_DATE_IN_FUTURE'
	| 'NOTICE_EXIT_BEFORE_NOTIFICATION'
	| 'NOTICE_REDUCED_NOT_IN_LEASE'
	| 'NOTICE_REDUCED_LESSOR'
	| 'NOTICE_LESSOR_TOO_SHORT';

export interface NoticeTerms {
	months: number;
	/** Dernier jour du préavis (inclus) : la veille du même jour, `months` mois après la notification. */
	noticeEndsOn: string;
	/** Dernier jour facturé : la sortie, ou la fin du préavis si le locataire part avant (D32). */
	rentEndsOn: string;
	/** Indemnité de départ anticipé (bail à durée déterminée quitté avant son terme), en FCFA. */
	earlyTerminationIndemnity: Fcfa;
}

/** Délai de préavis en mois, selon l'origine, la durée du bail et un éventuel cas de préavis réduit. */
export function noticeMonths(lease: NoticeLeaseTerms, origin: NoticeOrigin, reduced: boolean): number {
	if (origin === 'tenant' && reduced && lease.reducedNoticeMonths !== null) return lease.reducedNoticeMonths;
	const fixed = lease.endsOn !== null;
	if (origin === 'tenant') return fixed ? lease.noticeTenantFixedTermMonths : lease.noticeTenantOpenEndedMonths;
	return fixed ? lease.noticeLessorFixedTermMonths : lease.noticeLessorOpenEndedMonths;
}

export function noticeBlocker(lease: NoticeLeaseTerms, input: NoticeInput): NoticeBlocker | null {
	if (lease.status !== 'active') return 'NOTICE_LEASE_NOT_IN_FORCE';
	if (!isIsoDate(input.notifiedOn) || !isIsoDate(input.plannedExitOn)) return 'NOTICE_DATE_INVALID';
	if (input.notifiedOn > input.today) return 'NOTICE_DATE_IN_FUTURE';
	if (input.plannedExitOn < input.notifiedOn) return 'NOTICE_EXIT_BEFORE_NOTIFICATION';
	if (input.reducedNotice && input.origin === 'lessor') return 'NOTICE_REDUCED_LESSOR';
	if (input.reducedNotice && lease.reducedNoticeMonths === null) return 'NOTICE_REDUCED_NOT_IN_LEASE';
	if (input.origin === 'lessor' && input.plannedExitOn < noticeEnd(input.notifiedOn, noticeMonths(lease, 'lessor', false))) {
		return 'NOTICE_LESSOR_TOO_SHORT';
	}
	return null;
}

function noticeEnd(notifiedOn: string, months: number): string {
	return months === 0 ? notifiedOn : addDays(addMonths(notifiedOn, months), -1);
}

/**
 * Délai, fin du préavis, dernier jour facturé et indemnité (D32, à confirmer par le juriste) :
 * - le locataire qui part avant la fin de son préavis doit le loyer jusqu'à cette fin, sauf préavis réduit (le délai
 *   réduit s'applique alors) ;
 * - un bail à durée déterminée quitté avant son terme par le locataire ajoute l'indemnité prévue au bail (mois de loyer,
 *   hors charges), s'il en prévoit une ;
 * - un congé du bailleur respecte son délai (`NOTICE_LESSOR_TOO_SHORT`) ; il ne crée aucune indemnité ici.
 */
export function noticeTerms(lease: NoticeLeaseTerms, input: NoticeInput): NoticeTerms {
	const months = noticeMonths(lease, input.origin, input.reducedNotice);
	const noticeEndsOn = noticeEnd(input.notifiedOn, months);
	const rentEndsOn = input.plannedExitOn > noticeEndsOn ? input.plannedExitOn : noticeEndsOn;
	const leftEarly = input.origin === 'tenant' && lease.endsOn !== null && rentEndsOn < lease.endsOn;
	const earlyTerminationIndemnity =
		leftEarly && lease.earlyTerminationIndemnityMonths ? lease.earlyTerminationIndemnityMonths * lease.rent : 0;
	return { months, noticeEndsOn, rentEndsOn, earlyTerminationIndemnity };
}

// ---------------------------------------------------------------- dernières échéances

export interface ExistingDue extends IssuedRentDue {
	id: string;
	periodEnd: string;
}

export interface ExitDueAdjustment {
	id: string;
	periodStart: string;
	/** `waive` : après le dernier jour facturé, abandonnée ; `prorate` : dernière période ramenée au dernier jour. */
	action: 'waive' | 'prorate';
	rent: Fcfa;
	charges: Fcfa;
	amountDue: Fcfa;
	periodEnd: string;
	/** Déjà payé au-delà du nouveau montant : l'argent du locataire, rendu au crédit du bail (point a du porteur). */
	excessPaid: Fcfa;
}

/**
 * Échéances à ajuster à la sortie : `regenerated` est l'échéancier recalculé avec la fin au dernier jour facturé
 * (`generateRentSchedule`, même mode de découpage : le dernier mois au prorata, ou dû en entier en mode anniversaire).
 * Les échéances qui commencent après sont abandonnées ; la dernière prend le montant recalculé. Ce qui a déjà été payé
 * au-delà revient au crédit du bail.
 */
export function exitDueAdjustments(
	existing: readonly ExistingDue[],
	regenerated: readonly RentDueDraft[],
	rentEndsOn: string
): ExitDueAdjustment[] {
	const byStart = new Map(regenerated.map((d) => [d.periodStart, d]));
	const out: ExitDueAdjustment[] = [];
	for (const due of existing) {
		if (due.status === 'waived') continue;
		if (due.periodStart > rentEndsOn) {
			out.push({
				id: due.id,
				periodStart: due.periodStart,
				action: 'waive',
				rent: due.rent,
				charges: due.charges,
				amountDue: due.amountDue,
				periodEnd: due.periodEnd,
				excessPaid: due.amountPaid
			});
			continue;
		}
		const next = byStart.get(due.periodStart);
		if (!next || (next.amountDue === due.amountDue && next.periodEnd === due.periodEnd)) continue;
		out.push({
			id: due.id,
			periodStart: due.periodStart,
			action: 'prorate',
			rent: next.rent,
			charges: next.charges,
			amountDue: next.amountDue,
			periodEnd: next.periodEnd,
			excessPaid: Math.max(0, due.amountPaid - next.amountDue)
		});
	}
	return out;
}

/** Une échéance encore à venir se recalcule ; une émise ne se réduit qu'à la sortie, par ce seul chemin (D32). */
export function exitAdjustmentTouchesIssued(due: ExistingDue): boolean {
	return isIssued(due);
}

// ---------------------------------------------------------------- fin de bail et unité (D14)

/** La tâche quotidienne termine le bail à la date de sortie (préavis enregistré). */
export function leaseEndDue(lease: { status: string; exitOn: string | null }, today: string): boolean {
	return lease.status === 'notice' && lease.exitOn !== null && lease.exitOn <= today;
}

export const LEASE_END_REASONS = ['tenant_exit', 'lessor_notice', 'management_transfer'] as const;
export type LeaseEndReason = (typeof LEASE_END_REASONS)[number];

/**
 * État technique après la fin d'un bail (D14) : une unité prête passe « à remettre en état », jamais directement
 * disponible ; un autre état technique (travaux, indisponible) est gardé, il n'est pas disponible non plus. Un transfert
 * de gestion ne libère pas le logement : l'état technique ne change pas.
 */
export function technicalStatusAfterLeaseEnd(current: TechnicalStatus, reason: LeaseEndReason): TechnicalStatus {
	if (reason === 'management_transfer') return current;
	return current === 'ready' ? 'to_refurbish' : current;
}

// ---------------------------------------------------------------- états des lieux

export const INSPECTION_TYPES = ['entry', 'exit'] as const;
export type InspectionType = (typeof INSPECTION_TYPES)[number];

export const INSPECTION_STATUSES = ['draft', 'signed_both', 'disputed'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

/**
 * - `draft` → `signed_both` : signé des deux parties (scan déposé, ou case cochée par chacune, horodatée).
 * - `draft` → `disputed` : une partie refuse ; observations et pièces des deux côtés.
 * - `disputed` → `signed_both` : issue amiable, signée.
 * Un état des lieux signé ne change plus.
 */
export const INSPECTION_TRANSITIONS: Record<InspectionStatus, readonly InspectionStatus[]> = {
	draft: ['signed_both', 'disputed'],
	disputed: ['signed_both'],
	signed_both: []
};

export function canTransitionInspection(from: InspectionStatus, to: InspectionStatus): boolean {
	return INSPECTION_TRANSITIONS[from].includes(to);
}

export interface InspectionSignatures {
	organizationSignedAt: string | null;
	tenantSignedAt: string | null;
	/** Scan de l'état des lieux signé (« signature manuscrite, scan déposé », D21). */
	scanDocumentId: string | null;
}

/** Signé des deux parties : le scan déposé, ou la case cochée par chacune. */
export function inspectionSignedByBoth(s: InspectionSignatures): boolean {
	return s.scanDocumentId !== null || (s.organizationSignedAt !== null && s.tenantSignedAt !== null);
}

/**
 * Formules vagues refusées seules (article 9 : pas de « bon état » sans description). Comparées sans accents, sans
 * ponctuation et sans casse ; une description faite uniquement de leurs mots (« Bon état général, RAS ») est refusée
 * aussi. Une description qui les précise (« bon état, peinture blanche sans trace ») est admise.
 */
export const VAGUE_DESCRIPTIONS = [
	'bon etat',
	'en bon etat',
	'tres bon etat',
	'bon etat general',
	'etat correct',
	'correct',
	'bien',
	'ok',
	'ras',
	'rien a signaler',
	'neuf',
	'comme neuf',
	'bon',
	'be',
	'tbe',
	'normal',
	'etat normal',
	'mauvais etat',
	'usage'
] as const;

/** Mots des formules vagues (comparés à `inspection_vague_words()` de la base par un test). */
export const VAGUE_WORDS = new Set(VAGUE_DESCRIPTIONS.flatMap((d) => d.split(' ')).concat(['et', 'general', 'globalement']));

/** Longueur minimale d'une description, en caractères. */
export const INSPECTION_DESCRIPTION_MIN = 12;

export function normalizeDescription(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export type InspectionItemBlocker =
	'INSPECTION_DESCRIPTION_VAGUE' | 'INSPECTION_DESCRIPTION_TOO_SHORT' | 'INSPECTION_FINDING_REQUIRED' | 'INSPECTION_FINDING_ON_ENTRY';

/** Description d'un élément : texte obligatoire, jamais une formule vague seule (article 9). */
export function inspectionDescriptionBlocker(text: string): Extract<InspectionItemBlocker, `INSPECTION_DESCRIPTION_${string}`> | null {
	const words = normalizeDescription(text).split(' ').filter(Boolean);
	if (words.every((w) => VAGUE_WORDS.has(w))) return 'INSPECTION_DESCRIPTION_VAGUE';
	if (text.trim().length < INSPECTION_DESCRIPTION_MIN) return 'INSPECTION_DESCRIPTION_TOO_SHORT';
	return null;
}

/** Ligne d'état des lieux : description admise ; à la sortie, un constat ; à l'entrée, aucun. */
export function inspectionItemBlocker(
	type: InspectionType,
	item: { description: string; finding: InspectionFinding | null }
): InspectionItemBlocker | null {
	const d = inspectionDescriptionBlocker(item.description);
	if (d) return d;
	if (type === 'exit' && !item.finding) return 'INSPECTION_FINDING_REQUIRED';
	if (type === 'entry' && item.finding) return 'INSPECTION_FINDING_ON_ENTRY';
	return null;
}

/** Élément d'un état des lieux (pièce + élément), pour la comparaison entrée et sortie. */
export interface InspectionItemForComparison {
	id: string;
	room: string;
	element: string;
	description: string;
	finding: InspectionFinding | null;
}

export interface InspectionComparisonRow {
	room: string;
	element: string;
	entry: InspectionItemForComparison | null;
	exit: InspectionItemForComparison | null;
}

const comparisonKey = (i: Pick<InspectionItemForComparison, 'room' | 'element'>) =>
	`${normalizeDescription(i.room)}|${normalizeDescription(i.element)}`;

/**
 * Comparaison entrée et sortie, pièce par pièce, élément par élément (même pièce et même élément, sans accents ni
 * casse), dans l'ordre de l'état des lieux de sortie, puis les éléments présents seulement à l'entrée.
 */
export function compareInspections(
	entry: readonly InspectionItemForComparison[],
	exit: readonly InspectionItemForComparison[]
): InspectionComparisonRow[] {
	const entries = new Map<string, InspectionItemForComparison>();
	for (const e of entry) if (!entries.has(comparisonKey(e))) entries.set(comparisonKey(e), e);
	const used = new Set<string>();
	const rows: InspectionComparisonRow[] = exit.map((x) => {
		const k = comparisonKey(x);
		const match = used.has(k) ? null : (entries.get(k) ?? null);
		if (match) used.add(k);
		return { room: x.room, element: x.element, entry: match, exit: x };
	});
	for (const [k, e] of entries) if (!used.has(k)) rows.push({ room: e.room, element: e.element, entry: e, exit: null });
	return rows;
}

// ---------------------------------------------------------------- catalogue et liste des réparations du locataire

/** Pièces proposées par défaut (modifiables par organisation). */
export const DEFAULT_INSPECTION_ROOMS = ['Salon', 'Chambre', 'Cuisine', 'Douche et WC', 'Couloir', 'Cour', 'Extérieur'] as const;

/**
 * Catalogue des éléments d'un état des lieux (modifiable par chaque organisation ; pour un meublé, l'inventaire des
 * meubles s'y ajoute). Distinct de la liste des réparations du locataire : il dit quoi regarder, pas qui paie.
 */
export const DEFAULT_INSPECTION_ELEMENTS = [
	{ key: 'door', label: 'Porte' },
	{ key: 'keys_locks', label: 'Clés et serrures' },
	{ key: 'windows', label: 'Fenêtres et vitres' },
	{ key: 'walls_paint', label: 'Murs et peinture' },
	{ key: 'ceiling', label: 'Plafond' },
	{ key: 'floor', label: 'Sol' },
	{ key: 'switches_outlets', label: 'Interrupteurs et prises' },
	{ key: 'lights', label: 'Éclairage et ampoules' },
	{ key: 'taps', label: 'Robinetterie et joints' },
	{ key: 'shower', label: 'Douche' },
	{ key: 'toilet', label: 'WC' },
	{ key: 'sink', label: 'Évier et lavabo' },
	{ key: 'drains', label: 'Évacuations' },
	{ key: 'cupboards', label: 'Placards' },
	{ key: 'mosquito_nets', label: 'Moustiquaires' },
	{ key: 'fan_ac', label: 'Ventilateur ou climatiseur' }
] as const;
export type InspectionElementKey = (typeof DEFAULT_INSPECTION_ELEMENTS)[number]['key'];

/**
 * Réparations à la charge du locataire : liste par défaut du porteur (20/11/2026), modifiable par chaque organisation,
 * À VALIDER PAR LE JURISTE (le décret prévu à l'article 25 n'est pas disponible). Elle guide le classement
 * `tenant_damage` ; chaque ligne reste le constat de l'agent, jamais un classement automatique.
 */
export const DEFAULT_TENANT_REPAIRS = [
	{ key: 'keys_locks', label: 'Clés et serrures perdues ou cassées', elements: ['keys_locks', 'door'] },
	{ key: 'broken_glass', label: 'Vitres cassées', elements: ['windows'] },
	{ key: 'taps_seals', label: 'Robinetterie et joints', elements: ['taps', 'shower', 'sink', 'toilet'] },
	{ key: 'switches_outlets_bulbs', label: 'Interrupteurs, prises et ampoules', elements: ['switches_outlets', 'lights'] },
	{ key: 'drain_unblocking', label: 'Débouchage des évacuations', elements: ['drains', 'sink', 'shower', 'toilet'] },
	{ key: 'paint_beyond_wear', label: 'Peinture abîmée au-delà de l’usure normale', elements: ['walls_paint', 'ceiling'] },
	{ key: 'doors_cupboards', label: 'Portes et placards dégradés', elements: ['door', 'cupboards'] }
] as const satisfies readonly { key: string; label: string; elements: readonly InspectionElementKey[] }[];

/** Réparations de la liste qui concernent un élément : une aide au constat, jamais une décision. */
export function tenantRepairHints(
	element: string,
	list: readonly { key: string; label: string; elements: readonly string[] }[] = DEFAULT_TENANT_REPAIRS
): { key: string; label: string }[] {
	return list.filter((r) => r.elements.includes(element)).map(({ key, label }) => ({ key, label }));
}

// ---------------------------------------------------------------- réparations

/**
 * - `planned` → `done` : faite ; par l'organisation, avec le montant réel et la facture (elle crée alors la dépense,
 *   supportée par le locataire, récupérée sur la caution) ; par le locataire, déclarée faite.
 * - `done` → `verified` : contre-visite. Une réparation faite par le locataire ne sort du décompte qu'à ce moment.
 */
export const REPAIR_TRANSITIONS: Record<RepairStatus, readonly RepairStatus[]> = {
	planned: ['done'],
	done: ['verified'],
	verified: []
};

export type RepairBlocker =
	'REPAIR_TRANSITION_FORBIDDEN' | 'REPAIR_NOT_TENANT_DAMAGE' | 'REPAIR_INVOICE_REQUIRED' | 'REPAIR_SELF_REPAIR_NOT_AGREED';

export interface RepairForTransition {
	status: RepairStatus;
	performedBy: RepairPerformer;
	finding: InspectionFinding | null;
	actualAmount: Fcfa | null;
	invoiceDocumentId: string | null;
	selfRepairAgreed: boolean;
}

/** Une réparation n'existe que sur une ligne imputable au locataire ; chaque étape a sa preuve. */
export function repairTransitionBlocker(r: RepairForTransition, to: RepairStatus): RepairBlocker | null {
	if (r.finding !== 'tenant_damage') return 'REPAIR_NOT_TENANT_DAMAGE';
	if (!REPAIR_TRANSITIONS[r.status].includes(to)) return 'REPAIR_TRANSITION_FORBIDDEN';
	if (to === 'done' && r.performedBy === 'organization' && (r.actualAmount === null || r.actualAmount <= 0 || !r.invoiceDocumentId)) {
		return 'REPAIR_INVOICE_REQUIRED';
	}
	if (r.performedBy === 'tenant' && !r.selfRepairAgreed) return 'REPAIR_SELF_REPAIR_NOT_AGREED';
	return null;
}

/**
 * Dépense créée par une réparation faite par l'organisation (règle 16 : un seul enregistrement, la retenue y renvoie) :
 * avancée par l'organisation, supportée par le locataire, récupérée sur la caution.
 */
export function repairExpenseRoles(): { paidBy: 'organization'; borneBy: 'tenant'; recovery: 'deposit' } {
	return { paidBy: 'organization', borneBy: 'tenant', recovery: 'deposit' };
}

// ---------------------------------------------------------------- accords (circuit d'accord, docs/UX.md §10)

export const AGREEMENT_TYPES = ['deposit_applied_to_rent', 'tenant_self_repair', 'settlement_dispute'] as const;
export type AgreementType = (typeof AGREEMENT_TYPES)[number];

export const AGREEMENT_STATUSES = ['proposed', 'accepted', 'refused'] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

export const AGREEMENT_PARTIES = ['organization', 'tenant', 'owner'] as const;
export type AgreementParty = (typeof AGREEMENT_PARTIES)[number];

export type AgreementBlocker =
	| 'AGREEMENT_ALREADY_DECIDED'
	| 'AGREEMENT_SAME_PARTY'
	| 'AGREEMENT_REASON_REQUIRED'
	| 'AGREEMENT_DOCUMENT_REQUIRED'
	| 'AGREEMENT_MONTHS_REQUIRED'
	| 'AGREEMENT_MONTH_STARTED';

/** Proposition : un accord d'imputation sur loyer nomme ses mois, tous à venir (accepté **avant** ces mois). */
export function agreementProposalBlocker(
	a: { type: AgreementType; months: readonly string[] },
	today: string
): Extract<AgreementBlocker, 'AGREEMENT_MONTHS_REQUIRED' | 'AGREEMENT_MONTH_STARTED'> | null {
	if (a.type !== 'deposit_applied_to_rent') return null;
	if (!a.months.length) return 'AGREEMENT_MONTHS_REQUIRED';
	if (a.months.some((m) => m <= today)) return 'AGREEMENT_MONTH_STARTED';
	return null;
}

/**
 * Décision : seulement sur une proposition, par l'autre partie (l'organisation enregistre celle du locataire tant qu'il
 * n'a pas d'espace, lot 10 ter) ; un refus est motivé ; l'imputation sur loyer est un accord **écrit** (document) ;
 * l'issue d'une contestation aussi.
 */
export function agreementDecisionBlocker(a: {
	type: AgreementType;
	status: AgreementStatus;
	proposedBy: AgreementParty;
	decidedBy: AgreementParty;
	decision: 'accepted' | 'refused';
	reason: string | null;
	documentId: string | null;
	months?: readonly string[];
	decidedOn?: string;
}): AgreementBlocker | null {
	if (a.status !== 'proposed') return 'AGREEMENT_ALREADY_DECIDED';
	if (a.proposedBy === a.decidedBy) return 'AGREEMENT_SAME_PARTY';
	if (a.decision === 'refused') return (a.reason?.trim().length ?? 0) >= 5 ? null : 'AGREEMENT_REASON_REQUIRED';
	if ((a.type === 'deposit_applied_to_rent' || a.type === 'settlement_dispute') && !a.documentId) return 'AGREEMENT_DOCUMENT_REQUIRED';
	if (a.type === 'deposit_applied_to_rent' && a.decidedOn && (a.months ?? []).some((m) => m <= a.decidedOn!)) {
		return 'AGREEMENT_MONTH_STARTED';
	}
	return null;
}

// ---------------------------------------------------------------- transfert de gestion (D16, règle 12)

/** Après un transfert, la caution est détenue par le nouveau gestionnaire, nommé en texte (aucun lien vers lui). */
export const TRANSFER_DEPOSIT_HOLDER = 'third_party';

export interface TransferMandate {
	id: string;
	status: string;
	/** Portées de gestion du mandat (bien entier : `unitId` nul). */
	scopes: readonly { id: string; propertyId: string; unitId: string | null }[];
}

export interface ManagementTransferInput {
	target: { propertyId: string; unitId: string | null };
	mandate: TransferMandate | null;
	transferOn: string;
	today: string;
	/** Nouveau gestionnaire, en texte seulement (règle 15 : aucun lien vers une autre organisation). */
	newManagerName: string;
	/** Remise du dossier : date et pièces remises (texte). */
	handedOverOn: string;
	handedOverItems: readonly string[];
	leasesInForce: readonly { id: string; unitId: string }[];
	depositAccounts: readonly { id: string; leaseId: string; holder: string; held: Fcfa; status: string }[];
}

export type ManagementTransferBlocker =
	| 'TRANSFER_NOT_MANAGED'
	| 'TRANSFER_DATE_IN_FUTURE'
	| 'TRANSFER_DATE_INVALID'
	| 'TRANSFER_NEW_MANAGER_REQUIRED'
	| 'TRANSFER_HANDOVER_REQUIRED';

export function managementTransferBlocker(input: ManagementTransferInput): ManagementTransferBlocker | null {
	if (!input.mandate || input.mandate.status !== 'active' || !coveringScopes(input).length) return 'TRANSFER_NOT_MANAGED';
	if (!isIsoDate(input.transferOn) || !isIsoDate(input.handedOverOn)) return 'TRANSFER_DATE_INVALID';
	if (input.transferOn > input.today || input.handedOverOn > input.today) return 'TRANSFER_DATE_IN_FUTURE';
	if (input.newManagerName.trim().length < 2) return 'TRANSFER_NEW_MANAGER_REQUIRED';
	if (!input.handedOverItems.some((i) => i.trim().length > 0)) return 'TRANSFER_HANDOVER_REQUIRED';
	return null;
}

function coveringScopes(input: ManagementTransferInput) {
	const { propertyId, unitId } = input.target;
	return (input.mandate?.scopes ?? []).filter(
		(s) => s.propertyId === propertyId && (unitId === null || s.unitId === null || s.unitId === unitId)
	);
}

export interface ManagementTransferPlan {
	/** Le mandat ne couvre que la cible : il est terminé ; sinon seules ses portées sur la cible prennent fin. */
	mandateAction: 'end_mandate' | 'end_scopes';
	scopeIds: string[];
	/** Baux de A sur la cible : terminés au transfert (A garde leur historique, le nouveau gestionnaire ne les voit pas). */
	leaseIds: string[];
	/** Changement de détenteur vers le nouveau gestionnaire, nommé en texte, pour chaque caution que A détient. */
	holderChanges: { accountId: string; previousHolder: string; newHolder: typeof TRANSFER_DEPOSIT_HOLDER; newHolderName: string }[];
}

/**
 * Plan du transfert, écrit dans l'organisation A seulement. Rien n'est copié ailleurs : la nouvelle organisation saisit
 * ou importe le dossier remis (règle 15). Une caution détenue par le propriétaire ne change pas de détenteur.
 */
export function managementTransferPlan(input: ManagementTransferInput): ManagementTransferPlan {
	const { propertyId, unitId } = input.target;
	const all = input.mandate?.scopes ?? [];
	// Bien entier : toutes ses portées. Une unité : seulement les siennes (celle d'un mandat posé sur le bien entier
	// existe aussi, `via_property`) ; la portée du bien reste pour les autres unités.
	const scopes = all.filter((s) => s.propertyId === propertyId && (unitId === null || s.unitId === unitId));
	const onlyTarget = all.every((s) => scopes.includes(s));
	const leases = input.leasesInForce.filter((l) => unitId === null || l.unitId === unitId);
	const leaseIds = new Set(leases.map((l) => l.id));
	return {
		mandateAction: onlyTarget ? 'end_mandate' : 'end_scopes',
		scopeIds: scopes.map((s) => s.id),
		leaseIds: [...leaseIds],
		holderChanges: input.depositAccounts
			.filter((a) => leaseIds.has(a.leaseId) && a.holder === 'organization' && a.status !== 'closed')
			.map((a) => ({
				accountId: a.id,
				previousHolder: a.holder,
				newHolder: TRANSFER_DEPOSIT_HOLDER,
				newHolderName: input.newManagerName.trim()
			}))
	};
}
