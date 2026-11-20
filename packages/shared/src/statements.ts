/**
 * Relevés propriétaires (lot 10), en fonctions pures : le même calcul pour le brouillon, l'émission, l'écran, le PDF et
 * la page partagée `/s/<jeton>`. Aucune lecture : l'API passe ses entrées à `computeStatement`.
 *
 * **Éléments d'un relevé** (réponses du porteur au plan) : les **imputations sur échéance** d'un propriétaire.
 * - Imputation directe (à la confirmation d'un encaissement) : datée par la **date de paiement**.
 * - Imputation d'un **crédit** (trop-perçu) sur une échéance émise plus tard : datée par la **date d'imputation**. Tant
 *   qu'il n'est pas imputé, un crédit est l'argent du locataire, détenu pour lui : il figure dans la section
 *   d'information « Trop-perçus détenus pour vos locataires », hors du net, sans commission.
 * - Contre-écriture d'un encaissement annulé : datée par la **date d'annulation**. Un relevé émis est figé : une
 *   annulation postérieure à son émission apparaît en ligne négative sur le relevé du mois de l'annulation, jamais en
 *   modifiant l'ancien. Un encaissement annulé avant d'avoir été repris dans un relevé émis n'apparaît pas du tout.
 * - Un élément n'entre qu'une fois dans un relevé émis : chaque relevé renvoie les clés qu'il consomme (`consumed`),
 *   que la base garde dans un index unique ; un élément daté d'un mois déjà émis (encaissement confirmé après
 *   l'émission) entre dans le relevé suivant, avec une mention.
 *
 * **Part du loyer et des charges** (point 1 du porteur) : `splitDueLedger`, règle du cumul.
 *
 * **Commission** (sur le loyer encaissé seul, hors charges ; réponses 2 à 4) : par mandat et par version ; arrondie
 * vers zéro sur le total du mois ; mensuelle au prorata des jours en vigueur le premier et le dernier mois ; par
 * opération, un bail validé dans le mois.
 *
 * **Net** = encaissé par l'organisation (loyer et charges) − commission − dépenses avancées pour le propriétaire
 * + solde négatif du relevé précédent. Les cautions, les trop-perçus et les loyers perçus directement par le
 * propriétaire n'y entrent jamais.
 */
import { z } from 'zod';
import type { AllocationDirection } from './allocation.js';
import { daysInMonth, formatDate, isIsoDate } from './dates.js';
import { EXPENSE_CATEGORY_LABELS, expenseEffect, type ExpenseCategory, type ExpenseRoles } from './expenses.js';
import { FRENCH_MONTHS } from './french-words.js';
import { idSchema } from './ids.js';
import { fcfaSchema, formatFcfa, NBSP, type Fcfa } from './money.js';
import { MAX_RATE_BP, type Commission } from './owners.js';
import { base64Url } from './payments.js';
import type { ReceiptOrganizationSnapshot } from './receipts.js';

// ---------------------------------------------------------------- mois

/** Mois d'un relevé : « aaaa-mm ». */
export type StatementMonth = string;
export const STATEMENT_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const statementMonthSchema = z.string().regex(STATEMENT_MONTH_PATTERN, { error: 'Mois invalide (aaaa-mm).' });

function assertMonth(month: string): [number, number] {
	if (!STATEMENT_MONTH_PATTERN.test(month)) throw new RangeError(`Mois invalide : ${month}`);
	return [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
}

export function monthOfDate(iso: string): StatementMonth {
	if (!isIsoDate(iso.slice(0, 10))) throw new RangeError(`Date invalide : ${iso}`);
	return iso.slice(0, 7);
}

export function monthStart(month: StatementMonth): string {
	assertMonth(month);
	return `${month}-01`;
}

export function monthEnd(month: StatementMonth): string {
	const [y, m] = assertMonth(month);
	return `${month}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
}

export function addMonthsToMonth(month: StatementMonth, months: number): StatementMonth {
	const [y, m] = assertMonth(month);
	const index = y * 12 + (m - 1) + months;
	const ny = Math.floor(index / 12);
	return `${String(ny).padStart(4, '0')}-${String(index - ny * 12 + 1).padStart(2, '0')}`;
}

/** « 2027-03 » → « mars 2027 ». */
export function monthLabel(month: StatementMonth): string {
	const [y, m] = assertMonth(month);
	return `${FRENCH_MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------- erreurs

export type StatementErrorCode = 'STATEMENT_LEDGER_INVALID' | 'STATEMENT_INPUT_INVALID';

export class StatementError extends Error {
	constructor(
		readonly code: StatementErrorCode,
		message: string
	) {
		super(message);
		this.name = 'StatementError';
	}
}

function assertInteger(value: number, what: string): void {
	if (!Number.isSafeInteger(value)) throw new StatementError('STATEMENT_INPUT_INVALID', `${what} : entier attendu (${value}).`);
}

// ---------------------------------------------------------------- part du loyer et des charges (point 1)

/** Composition d'une échéance : `amountDue = rent + charges` (contrainte de la base). */
export interface DueComposition {
	rent: Fcfa;
	charges: Fcfa;
}

/** Part signée d'une imputation : négative pour une ligne inverse. */
export interface Split {
	rent: number;
	charges: number;
}

/**
 * Charges couvertes par un montant net payé `paid` sur une échéance : ⌊paid × charges / montant dû⌋, en entiers
 * exacts (BigInt : le produit peut dépasser 2^53).
 */
export function chargesCovered(paid: Fcfa, due: DueComposition): Fcfa {
	const total = due.rent + due.charges;
	if (!Number.isSafeInteger(paid) || paid < 0 || paid > total) {
		throw new StatementError('STATEMENT_LEDGER_INVALID', `Montant payé ${paid} hors de l’échéance (0 à ${total}).`);
	}
	if (total === 0) return 0;
	return Number((BigInt(paid) * BigInt(due.charges)) / BigInt(total));
}

export interface LedgerEntry {
	allocationId: string;
	direction: AllocationDirection;
	amount: Fcfa;
}

/**
 * Répartition entre loyer et charges de chaque imputation d'une échéance (point 1 du porteur).
 *
 * Les imputations sont reprises dans l'ordre du registre (`created_at`, puis identifiant), dans les deux sens ; `P₀`
 * et `P₁` sont le total net payé avant et après chaque ligne :
 *
 *     charges de la ligne = ⌊P₁·charges/dû⌋ − ⌊P₀·charges/dû⌋      (négatif pour une ligne inverse)
 *     loyer de la ligne   = montant signé − charges de la ligne
 *
 * On arrondit à l'inférieur le **cumul**, pas chaque ligne : les arrondis se compensent, et à tout moment le total
 * des charges vaut ⌊P·charges/dû⌋, donc exactement les charges (et exactement le loyer) quand l'échéance est soldée.
 * Chaque part reste entre 0 et le montant de la ligne (charges ≤ dû). Le registre étant en ajout seul, la part d'une
 * ligne ne change jamais.
 */
export function splitDueLedger(due: DueComposition, entries: readonly LedgerEntry[]): Map<string, Split> {
	assertInteger(due.rent, 'Loyer');
	assertInteger(due.charges, 'Charges');
	const out = new Map<string, Split>();
	let paid = 0;
	let covered = 0;
	for (const e of entries) {
		assertInteger(e.amount, 'Imputation');
		if (e.amount <= 0) throw new StatementError('STATEMENT_LEDGER_INVALID', `Imputation non positive : ${e.allocationId}.`);
		const signed = e.direction === 'allocate' ? e.amount : -e.amount;
		const next = paid + signed;
		const nextCovered = chargesCovered(next, due);
		out.set(e.allocationId, { rent: signed - (nextCovered - covered), charges: nextCovered - covered });
		paid = next;
		covered = nextCovered;
	}
	return out;
}

// ---------------------------------------------------------------- entrées du calcul

/** Mandat (et sa version) qui couvre l'unité à la date d'un élément. */
export interface StatementMandate {
	mandateId: string;
	version: number;
	commission: Commission | null;
	canCollectFunds: boolean;
}

/** Origine d'une imputation sur échéance. */
export const STATEMENT_ALLOCATION_ORIGINS = ['payment', 'credit', 'cancellation'] as const;
export type StatementAllocationOrigin = (typeof STATEMENT_ALLOCATION_ORIGINS)[number];

/** Une imputation du registre d'une échéance. */
export interface StatementAllocation extends LedgerEntry {
	paymentId: string;
	/** `payment` (imputation directe), `credit` (crédit imputé plus tard), `cancellation` (contre-écriture). */
	origin: StatementAllocationOrigin;
	/** Date de rattachement : date du paiement, date d'imputation du crédit ou date d'annulation. */
	date: string;
	/** Date du paiement d'origine (affichage). */
	paidOn: string;
	receiptNumber: string | null;
	/**
	 * Mandat de ce propriétaire qui couvre l'élément (pour une contre-écriture : celui de l'imputation annulée), ou
	 * `null` si l'imputation relève d'un autre propriétaire : elle compte alors pour le cumul de l'échéance seulement.
	 */
	mandate: StatementMandate | null;
	/**
	 * Lot 10 bis (D32) : imputation sur caution (encaissement interne). Elle est perçue par le détenteur de la caution :
	 * détenue par le propriétaire, le loyer figure en information (« perçus directement par vous »), hors du net.
	 */
	depositHolder?: 'organization' | 'owner' | null;
}

/** Une échéance et son registre **complet**, dans l'ordre (`created_at`, identifiant). */
export interface StatementDue extends DueComposition {
	id: string;
	leaseId: string;
	unitId: string;
	/** Nom du locataire, seule donnée personnelle du locataire sur un relevé (demande du porteur). */
	tenantName: string;
	periodStart: string;
	periodEnd: string;
	ledger: readonly StatementAllocation[];
}

/** Mois candidat d'une commission mensuelle fixe, avec la période de vigueur du mandat (bornes incluses). */
export interface MonthlyFeeCandidate {
	month: StatementMonth;
	mandate: StatementMandate;
	inForceFrom: string;
	/** Dernier jour en vigueur (fin, révocation ou expiration), ou `null` sans fin. */
	inForceUntil: string | null;
}

/** Bail validé sur une unité du mandat : une opération pour une commission `fixed_per_operation`. */
export interface OperationCandidate {
	leaseId: string;
	unitId: string;
	tenantName: string;
	validatedOn: string;
	mandate: StatementMandate;
}

export interface StatementExpense extends ExpenseRoles {
	id: string;
	spentOn: string;
	/** Date de l'annulation, ou `null`. */
	cancelledOn: string | null;
	amount: Fcfa;
	category: ExpenseCategory;
	description: string;
	unitId: string | null;
	propertyId: string;
	/**
	 * Lot 10 bis (D32) : réparation avancée par l'organisation (supportée par le locataire, récupérée sur la caution) et
	 * retenue par le propriétaire sur la caution qu'il détient, à cette date et pour ce montant : déduite de son relevé.
	 */
	ownerDepositRetention?: { on: string; amount: Fcfa } | null;
}

export interface StatementUnit {
	id: string;
	label: string;
}

export interface DepositHeldInfo {
	leaseId: string;
	unitId: string;
	tenantName: string;
	type: 'security_deposit' | 'utilities_guarantee';
	balance: Fcfa;
}

export interface CreditHeldInfo {
	leaseId: string;
	unitId: string;
	tenantName: string;
	amount: Fcfa;
}

/** Dernier relevé émis du propriétaire (relevé du mois ou rectificatif). */
export interface PreviousStatement {
	statementId: string;
	month: StatementMonth;
	version: number;
	net: number;
}

export interface StatementInput {
	month: StatementMonth;
	units: readonly StatementUnit[];
	dues: readonly StatementDue[];
	monthlyFees: readonly MonthlyFeeCandidate[];
	operations: readonly OperationCandidate[];
	expenses: readonly StatementExpense[];
	previous: PreviousStatement | null;
	/** Clés déjà consommées par un relevé émis de l'organisation. */
	consumed: ReadonlySet<string>;
	/** Mois déjà émis pour ce propriétaire (mention d'un élément arrivé après l'émission). */
	issuedMonths: readonly StatementMonth[];
	/** Cautions détenues par l'organisation pour ce propriétaire (information, jamais dans le net). */
	depositsHeld: readonly DepositHeldInfo[];
	/** Trop-perçus non imputés, détenus pour les locataires (information, jamais dans le net). */
	creditsHeld: readonly CreditHeldInfo[];
}

// ---------------------------------------------------------------- clés des éléments

export const STATEMENT_ITEM_KINDS = [
	'allocation',
	'monthly_fee',
	'operation_fee',
	'expense',
	'expense_cancellation',
	'carried_balance'
] as const;
export type StatementItemKind = (typeof STATEMENT_ITEM_KINDS)[number];

export const statementItemKey = {
	allocation: (allocationId: string) => `allocation:${allocationId}`,
	monthlyFee: (mandateId: string, month: StatementMonth) => `monthly_fee:${mandateId}:${month}`,
	operationFee: (leaseId: string) => `operation_fee:${leaseId}`,
	expense: (expenseId: string) => `expense:${expenseId}`,
	expenseCancellation: (expenseId: string) => `expense_cancellation:${expenseId}`,
	carriedBalance: (statementId: string) => `carried_balance:${statementId}`
};

export function statementItemKind(key: string): StatementItemKind {
	const kind = key.slice(0, key.indexOf(':')) as StatementItemKind;
	if (!STATEMENT_ITEM_KINDS.includes(kind)) throw new StatementError('STATEMENT_INPUT_INVALID', `Clé inconnue : ${key}.`);
	return kind;
}

/**
 * Élément consommé par un relevé : `line` s'il y figure, `neutralized` s'il s'annule avec sa contre-écriture avant
 * d'avoir été repris (encaissement ou dépense annulé avant l'émission) : il n'apparaît jamais.
 */
export interface ConsumedItem {
	key: string;
	role: 'line' | 'neutralized';
}

// ---------------------------------------------------------------- résultat

export interface StatementRentLine {
	key: string;
	allocationId: string;
	paymentId: string;
	rentDueId: string;
	unitId: string;
	tenantName: string;
	periodStart: string;
	periodEnd: string;
	origin: StatementAllocationOrigin;
	date: string;
	paidOn: string;
	receiptNumber: string | null;
	/** Parts signées : négatives pour une contre-écriture. */
	rent: number;
	charges: number;
	/** Qui a perçu les fonds : l'organisation (mandat `canCollectFunds`) ou le propriétaire lui-même. */
	collectedBy: 'organization' | 'owner';
	mandateId: string;
	mandateVersion: number;
	/** Daté d'un mois antérieur au relevé. */
	late: boolean;
	lateMonthIssued: boolean;
}

export interface StatementCommissionLine {
	/** Clé consommée (commission fixe), `null` pour un pourcentage (calculé sur les lignes du relevé). */
	key: string | null;
	mandateId: string;
	mandateVersion: number;
	basis: Commission['basis'];
	rateBp: number | null;
	/** Pourcentage : loyer encaissé (signé) qui sert de base. */
	base: number | null;
	/** Mensuel : mois, jours en vigueur, jours du mois. */
	month: StatementMonth | null;
	days: number | null;
	daysInMonth: number | null;
	/** Opération : bail validé. */
	leaseId: string | null;
	tenantName: string | null;
	fixedAmount: number | null;
	/** Montant signé dû par le propriétaire (négatif : commission rendue après une annulation). */
	amount: number;
}

export interface StatementExpenseLine {
	key: string;
	expenseId: string;
	kind: 'expense' | 'expense_cancellation';
	date: string;
	category: ExpenseCategory;
	description: string;
	unitId: string | null;
	/** Signé : négatif pour une dépense déduite, positif pour une dépense annulée rendue. */
	amount: number;
	late: boolean;
	/** Lot 10 bis : réparation retenue par le propriétaire sur la caution qu'il détient. */
	viaOwnerDeposit?: boolean;
}

export interface StatementUnitTotal {
	unitId: string;
	label: string;
	rent: number;
	charges: number;
	total: number;
	lines: number;
}

export interface StatementTotals {
	/** Encaissé par l'organisation : loyer, charges, total (signés). */
	rentCollected: number;
	chargesCollected: number;
	collected: number;
	/** Perçu directement par le propriétaire (information). */
	rentCollectedByOwner: number;
	chargesCollectedByOwner: number;
	/** Commission due par le propriétaire. */
	commission: number;
	/** Dépenses déduites (négatif) et rendues (positif). */
	expenses: number;
	/** Solde négatif du relevé précédent (≤ 0). */
	carriedBalance: number;
	net: number;
}

export interface StatementResult {
	month: StatementMonth;
	rentLines: StatementRentLine[];
	unitTotals: StatementUnitTotal[];
	ownerUnitTotals: StatementUnitTotal[];
	commissions: StatementCommissionLine[];
	expenseLines: StatementExpenseLine[];
	carried: { key: string; statementId: string; month: StatementMonth; version: number; amount: number } | null;
	info: {
		depositsHeld: DepositHeldInfo[];
		creditsHeld: CreditHeldInfo[];
		ownerPaidExpenses: {
			expenseId: string;
			date: string;
			category: ExpenseCategory;
			description: string;
			unitId: string | null;
			amount: Fcfa;
		}[];
	};
	totals: StatementTotals;
	consumed: ConsumedItem[];
	/** Empreinte du calcul : l'émission est refusée si le brouillon affiché a changé entre-temps. */
	revision: string;
}

// ---------------------------------------------------------------- commission

/** a × taux / 10 000, arrondi vers zéro (réponse 3 du porteur), en entiers exacts. */
export function percentCommission(base: number, rateBp: number): number {
	assertInteger(base, 'Base de commission');
	if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > MAX_RATE_BP) {
		throw new StatementError('STATEMENT_INPUT_INVALID', `Taux invalide : ${rateBp}.`);
	}
	const q = (BigInt(Math.abs(base)) * BigInt(rateBp)) / 10_000n;
	return base < 0 ? -Number(q) : Number(q);
}

/** Jours de vigueur d'un mandat dans un mois (bornes incluses). */
export function daysInForce(month: StatementMonth, from: string, until: string | null): number {
	const start = monthStart(month);
	const end = monthEnd(month);
	const a = from > start ? from : start;
	const b = until !== null && until < end ? until : end;
	if (a > b) return 0;
	return Number(b.slice(8, 10)) - Number(a.slice(8, 10)) + 1;
}

/**
 * Commission mensuelle fixe (réponse 4 du porteur) : montant entier pour un mois complet ; au prorata des jours en
 * vigueur le premier et le dernier mois, arrondi à l'inférieur.
 */
export function monthlyFee(
	amount: Fcfa,
	month: StatementMonth,
	from: string,
	until: string | null
): { amount: Fcfa; days: number; daysInMonth: number } {
	assertInteger(amount, 'Commission mensuelle');
	const [y, m] = assertMonth(month);
	const dim = daysInMonth(y, m);
	const days = daysInForce(month, from, until);
	const due = days === dim ? amount : Number((BigInt(amount) * BigInt(days)) / BigInt(dim));
	return { amount: due, days, daysInMonth: dim };
}

// ---------------------------------------------------------------- calcul

function sum(values: readonly number[]): number {
	return values.reduce((a, b) => a + b, 0);
}

/** Empreinte FNV-1a (32 bits) d'un texte, pour reconnaître un brouillon changé. */
function fnv1a(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/**
 * Calcul d'un relevé (brouillon, émission ou rectificatif) : voir l'en-tête du fichier. Un rectificatif est le même
 * calcul : il ne reprend que les éléments non encore consommés jusqu'à la fin du mois rectifié, son net est donc la
 * différence.
 */
export function computeStatement(input: StatementInput): StatementResult {
	const { month, consumed } = input;
	const start = monthStart(month);
	const end = monthEnd(month);
	const issued = new Set(input.issuedMonths);
	const out: ConsumedItem[] = [];
	const rentLines: StatementRentLine[] = [];
	const take = (key: string, role: ConsumedItem['role']) => out.push({ key, role });

	// ---- imputations sur échéance
	for (const due of input.dues) {
		const splits = splitDueLedger(due, due.ledger);
		const byPayment = new Map<string, StatementAllocation[]>();
		for (const e of due.ledger) {
			if (!e.mandate) continue;
			const list = byPayment.get(e.paymentId) ?? [];
			list.push(e);
			byPayment.set(e.paymentId, list);
		}
		const line = (e: StatementAllocation, split: Split, amountOrigin: StatementAllocationOrigin): StatementRentLine => ({
			key: statementItemKey.allocation(e.allocationId),
			allocationId: e.allocationId,
			paymentId: e.paymentId,
			rentDueId: due.id,
			unitId: due.unitId,
			tenantName: due.tenantName,
			periodStart: due.periodStart,
			periodEnd: due.periodEnd,
			origin: amountOrigin,
			date: e.date,
			paidOn: e.paidOn,
			receiptNumber: e.receiptNumber,
			rent: split.rent,
			charges: split.charges,
			collectedBy: e.depositHolder ?? (e.mandate!.canCollectFunds ? 'organization' : 'owner'),
			mandateId: e.mandate!.mandateId,
			mandateVersion: e.mandate!.version,
			late: e.date < start,
			lateMonthIssued: e.date < start && issued.has(monthOfDate(e.date))
		});
		for (const entries of byPayment.values()) {
			const reverses = entries.filter((e) => e.direction === 'reverse');
			if (reverses.length > 1) {
				throw new StatementError('STATEMENT_LEDGER_INVALID', `Deux contre-écritures de ${entries[0]!.paymentId} sur ${due.id}.`);
			}
			const reverse = reverses[0];
			const pending = entries.filter((e) => e.direction === 'allocate' && !consumed.has(statementItemKey.allocation(e.allocationId)));
			const alreadyIn = entries.filter((e) => e.direction === 'allocate' && consumed.has(statementItemKey.allocation(e.allocationId)));
			if (reverse && !consumed.has(statementItemKey.allocation(reverse.allocationId))) {
				if (reverse.date <= end) {
					// Les imputations pas encore reprises s'annulent avec leur contre-écriture ; seul le reste (ce qui
					// figure déjà sur un relevé émis) apparaît, en ligne négative.
					for (const p of pending) take(statementItemKey.allocation(p.allocationId), 'neutralized');
					const remaining = reverse.amount - sum(pending.map((p) => p.amount));
					if (remaining > 0) {
						const r = splits.get(reverse.allocationId)!;
						const split = pending.reduce((acc, p) => {
							const s = splits.get(p.allocationId)!;
							return { rent: acc.rent + s.rent, charges: acc.charges + s.charges };
						}, r);
						rentLines.push(line(reverse, split, 'cancellation'));
						take(statementItemKey.allocation(reverse.allocationId), 'line');
					} else {
						take(statementItemKey.allocation(reverse.allocationId), 'neutralized');
					}
					continue;
				}
				if (alreadyIn.length === 0) {
					// Annulé (après la fin du mois) avant d'avoir été repris : n'apparaît jamais.
					for (const p of pending) take(statementItemKey.allocation(p.allocationId), 'neutralized');
					take(statementItemKey.allocation(reverse.allocationId), 'neutralized');
					continue;
				}
			}
			for (const p of pending) {
				if (p.date > end) continue;
				rentLines.push(line(p, splits.get(p.allocationId)!, p.origin));
				take(statementItemKey.allocation(p.allocationId), 'line');
			}
		}
	}
	rentLines.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.allocationId < b.allocationId ? -1 : 1));

	// ---- totaux par unité
	const unitLabel = new Map(input.units.map((u) => [u.id, u.label]));
	const totalsFor = (collector: 'organization' | 'owner', withAllUnits: boolean): StatementUnitTotal[] => {
		const byUnit = new Map<string, StatementUnitTotal>();
		if (withAllUnits) {
			for (const u of input.units) byUnit.set(u.id, { unitId: u.id, label: u.label, rent: 0, charges: 0, total: 0, lines: 0 });
		}
		for (const l of rentLines) {
			if (l.collectedBy !== collector) continue;
			const t = byUnit.get(l.unitId) ?? { unitId: l.unitId, label: unitLabel.get(l.unitId) ?? '', rent: 0, charges: 0, total: 0, lines: 0 };
			t.rent += l.rent;
			t.charges += l.charges;
			t.total += l.rent + l.charges;
			t.lines += 1;
			byUnit.set(l.unitId, t);
		}
		return [...byUnit.values()];
	};
	const hasOwnerCollected = rentLines.some((l) => l.collectedBy === 'owner');
	const unitTotals = totalsFor('organization', !hasOwnerCollected || rentLines.some((l) => l.collectedBy === 'organization'));
	const ownerUnitTotals = hasOwnerCollected ? totalsFor('owner', false) : [];

	// ---- commissions
	const commissions: StatementCommissionLine[] = [];
	const percentGroups = new Map<string, { mandate: StatementMandate; base: number }>();
	for (const l of rentLines) {
		const e = input.dues.find((d) => d.id === l.rentDueId)!.ledger.find((x) => x.allocationId === l.allocationId)!;
		const m = e.mandate!;
		if (m.commission?.basis !== 'percent_of_collected') continue;
		const key = `${m.mandateId}:${m.version}`;
		const g = percentGroups.get(key) ?? { mandate: m, base: 0 };
		g.base += l.rent;
		percentGroups.set(key, g);
	}
	for (const { mandate, base } of percentGroups.values()) {
		const c = mandate.commission as Extract<Commission, { basis: 'percent_of_collected' }>;
		commissions.push({
			key: null,
			mandateId: mandate.mandateId,
			mandateVersion: mandate.version,
			basis: c.basis,
			rateBp: c.rateBp,
			base,
			month: null,
			days: null,
			daysInMonth: null,
			leaseId: null,
			tenantName: null,
			fixedAmount: null,
			amount: percentCommission(base, c.rateBp)
		});
	}
	for (const f of input.monthlyFees) {
		const c = f.mandate.commission;
		if (c?.basis !== 'fixed_per_month' || f.month > month) continue;
		const key = statementItemKey.monthlyFee(f.mandate.mandateId, f.month);
		if (consumed.has(key)) continue;
		const fee = monthlyFee(c.amount, f.month, f.inForceFrom, f.inForceUntil);
		if (fee.days === 0) continue;
		commissions.push({
			key,
			mandateId: f.mandate.mandateId,
			mandateVersion: f.mandate.version,
			basis: c.basis,
			rateBp: null,
			base: null,
			month: f.month,
			days: fee.days,
			daysInMonth: fee.daysInMonth,
			leaseId: null,
			tenantName: null,
			fixedAmount: c.amount,
			amount: fee.amount
		});
		take(key, 'line');
	}
	for (const o of input.operations) {
		const c = o.mandate.commission;
		if (c?.basis !== 'fixed_per_operation' || o.validatedOn > end) continue;
		const key = statementItemKey.operationFee(o.leaseId);
		if (consumed.has(key)) continue;
		commissions.push({
			key,
			mandateId: o.mandate.mandateId,
			mandateVersion: o.mandate.version,
			basis: c.basis,
			rateBp: null,
			base: null,
			month: null,
			days: null,
			daysInMonth: null,
			leaseId: o.leaseId,
			tenantName: o.tenantName,
			fixedAmount: c.amount,
			amount: c.amount
		});
		take(key, 'line');
	}

	// ---- dépenses
	const expenseLines: StatementExpenseLine[] = [];
	const ownerPaidExpenses: StatementResult['info']['ownerPaidExpenses'] = [];
	for (const e of input.expenses) {
		assertInteger(e.amount, 'Dépense');
		const effect = expenseEffect(e);
		if (effect === 'owner_paid') {
			if (!e.cancelledOn && e.spentOn >= start && e.spentOn <= end) {
				ownerPaidExpenses.push({
					expenseId: e.id,
					date: e.spentOn,
					category: e.category,
					description: e.description,
					unitId: e.unitId,
					amount: e.amount
				});
			}
			continue;
		}
		if (effect === 'deposit_retention') {
			// Retenue par le propriétaire sur la caution qu'il détient (D32) : il a l'argent, l'avance de l'organisation
			// lui est déduite, une fois, au mois de la retenue.
			const r = e.ownerDepositRetention;
			const key = statementItemKey.expense(e.id);
			if (r && r.amount > 0 && !consumed.has(key) && r.on <= end) {
				assertInteger(r.amount, 'Retenue');
				expenseLines.push({
					expenseId: e.id,
					category: e.category,
					description: e.description,
					unitId: e.unitId,
					key,
					kind: 'expense',
					date: r.on,
					amount: -r.amount,
					late: r.on < start,
					viaOwnerDeposit: true
				});
				take(key, 'line');
			}
			continue;
		}
		if (effect !== 'statement_deduction') continue;
		const kE = statementItemKey.expense(e.id);
		const kC = statementItemKey.expenseCancellation(e.id);
		const base = { expenseId: e.id, category: e.category, description: e.description, unitId: e.unitId };
		if (e.cancelledOn && !consumed.has(kC)) {
			if (!consumed.has(kE)) {
				// Annulée avant d'avoir été déduite : n'apparaît jamais.
				take(kE, 'neutralized');
				take(kC, 'neutralized');
			} else if (e.cancelledOn <= end) {
				expenseLines.push({
					...base,
					key: kC,
					kind: 'expense_cancellation',
					date: e.cancelledOn,
					amount: e.amount,
					late: e.cancelledOn < start
				});
				take(kC, 'line');
			}
			continue;
		}
		if (!consumed.has(kE) && e.spentOn <= end) {
			expenseLines.push({ ...base, key: kE, kind: 'expense', date: e.spentOn, amount: -e.amount, late: e.spentOn < start });
			take(kE, 'line');
		}
	}
	expenseLines.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.key < b.key ? -1 : 1));

	// ---- solde négatif du relevé précédent (réponse 6) : reporté jusqu'à ce qu'il soit absorbé
	let carried: StatementResult['carried'] = null;
	if (input.previous && input.previous.net < 0) {
		const key = statementItemKey.carriedBalance(input.previous.statementId);
		if (!consumed.has(key)) {
			carried = {
				key,
				statementId: input.previous.statementId,
				month: input.previous.month,
				version: input.previous.version,
				amount: input.previous.net
			};
			take(key, 'line');
		}
	}

	// ---- totaux
	const org = rentLines.filter((l) => l.collectedBy === 'organization');
	const own = rentLines.filter((l) => l.collectedBy === 'owner');
	const rentCollected = sum(org.map((l) => l.rent));
	const chargesCollected = sum(org.map((l) => l.charges));
	const commission = sum(commissions.map((c) => c.amount));
	const expenses = sum(expenseLines.map((l) => l.amount));
	const carriedBalance = carried?.amount ?? 0;
	const totals: StatementTotals = {
		rentCollected,
		chargesCollected,
		collected: rentCollected + chargesCollected,
		rentCollectedByOwner: sum(own.map((l) => l.rent)),
		chargesCollectedByOwner: sum(own.map((l) => l.charges)),
		commission,
		expenses,
		carriedBalance,
		net: rentCollected + chargesCollected - commission + expenses + carriedBalance
	};
	for (const v of Object.values(totals)) assertInteger(v, 'Total');

	const consumedSorted = [...out].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return {
		month,
		rentLines,
		unitTotals,
		ownerUnitTotals,
		commissions,
		expenseLines,
		carried,
		info: { depositsHeld: [...input.depositsHeld], creditsHeld: [...input.creditsHeld], ownerPaidExpenses },
		totals,
		consumed: consumedSorted,
		revision: fnv1a(JSON.stringify([month, consumedSorted, totals]))
	};
}

/** Le relevé a-t-il un contenu propre (hors report du solde précédent) ? Un rectificatif vide est refusé. */
export function statementHasContent(result: Pick<StatementResult, 'rentLines' | 'commissions' | 'expenseLines'>): boolean {
	return result.rentLines.length > 0 || result.commissions.some((c) => c.amount !== 0) || result.expenseLines.length > 0;
}

// ---------------------------------------------------------------- émission, rectificatif et quota

export const STATEMENT_STATUSES = ['draft', 'issued'] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export type StatementIssueBlocker =
	| 'STATEMENT_PERIOD_NOT_ENDED'
	| 'STATEMENT_ALREADY_ISSUED'
	| 'STATEMENT_OUT_OF_ORDER'
	| 'STATEMENT_RECTIFICATION_NOT_LATEST'
	| 'STATEMENT_RECTIFICATION_EMPTY'
	| 'STATEMENT_DRAFT_STALE';

/**
 * Émission d'un relevé : le mois doit être terminé ; les relevés d'un propriétaire s'émettent dans l'ordre des mois
 * (un mois sauté est absorbé par le suivant, ses éléments portent la mention « mois précédent »). Un rectificatif
 * (version suivante) ne vise que le dernier mois émis et doit corriger quelque chose. L'émission recalcule le relevé :
 * si l'empreinte diffère du brouillon affiché, elle est refusée (`STATEMENT_DRAFT_STALE`).
 */
export function statementIssueBlockers(ctx: {
	kind: 'regular' | 'rectification';
	month: StatementMonth;
	today: string;
	lastIssuedMonth: StatementMonth | null;
	hasContent: boolean;
	expectedRevision?: string;
	revision?: string;
}): StatementIssueBlocker[] {
	const out: StatementIssueBlocker[] = [];
	if (ctx.kind === 'regular') {
		if (ctx.today <= monthEnd(ctx.month)) out.push('STATEMENT_PERIOD_NOT_ENDED');
		if (ctx.lastIssuedMonth !== null && ctx.month === ctx.lastIssuedMonth) out.push('STATEMENT_ALREADY_ISSUED');
		if (ctx.lastIssuedMonth !== null && ctx.month < ctx.lastIssuedMonth) out.push('STATEMENT_OUT_OF_ORDER');
	} else {
		if (ctx.lastIssuedMonth !== ctx.month) out.push('STATEMENT_RECTIFICATION_NOT_LATEST');
		else if (!ctx.hasContent) out.push('STATEMENT_RECTIFICATION_EMPTY');
	}
	if (ctx.expectedRevision !== undefined && ctx.revision !== undefined && ctx.expectedRevision !== ctx.revision) {
		out.push('STATEMENT_DRAFT_STALE');
	}
	return out;
}

/**
 * Quota de la formule Découverte (réponse 6) : relevés émis dans le mois civil de l'émission, rectificatifs non
 * comptés (version 1 seulement).
 */
export function statementQuotaUsed(issued: readonly { issuedOn: string; version: number }[], today: string): number {
	const current = monthOfDate(today);
	return issued.filter((s) => s.version === 1 && monthOfDate(s.issuedOn) === current).length;
}

// ---------------------------------------------------------------- reversements

/** Moyens d'un reversement au propriétaire, enregistré (jamais exécuté par la plateforme). */
export const PAYOUT_METHODS = ['cash', 'mobile_money', 'bank_transfer', 'cheque'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
	cash: 'Espèces',
	mobile_money: 'Mobile Money',
	bank_transfer: 'Virement bancaire',
	cheque: 'Chèque'
};

export type PayoutBlocker = 'STATEMENT_NOT_ISSUED' | 'PAYOUT_NOTHING_DUE' | 'PAYOUT_EXCEEDS_NET' | 'PAYOUT_DATE_IN_FUTURE';

/** Un reversement suit un relevé émis dont le net est positif ; le total reversé ne dépasse jamais ce net. */
export function payoutBlockers(ctx: {
	statementStatus: StatementStatus;
	net: number;
	alreadyPaid: Fcfa;
	amount: Fcfa;
	paidOn: string;
	today: string;
}): PayoutBlocker[] {
	const out: PayoutBlocker[] = [];
	if (ctx.statementStatus !== 'issued') out.push('STATEMENT_NOT_ISSUED');
	if (ctx.net <= 0) out.push('PAYOUT_NOTHING_DUE');
	else if (ctx.alreadyPaid + ctx.amount > ctx.net) out.push('PAYOUT_EXCEEDS_NET');
	if (ctx.paidOn > ctx.today) out.push('PAYOUT_DATE_IN_FUTURE');
	return out;
}

/** Reste à reverser sur un relevé. */
export function payoutRemaining(net: number, alreadyPaid: Fcfa): Fcfa {
	return Math.max(0, net - alreadyPaid);
}

const isoDate = z.string().refine(isIsoDate, { error: 'Date invalide.' });

export const generateStatementSchema = z.object({ ownerId: idSchema, month: statementMonthSchema });
export type GenerateStatementData = z.output<typeof generateStatementSchema>;

export const issueStatementSchema = z.object({ revision: z.string().regex(/^[0-9a-f]{8}$/, { error: 'Empreinte invalide.' }) });
export type IssueStatementData = z.output<typeof issueStatementSchema>;

export const payoutSchema = z.object({
	id: idSchema,
	statementId: idSchema,
	amount: fcfaSchema.refine((v) => v > 0, { error: 'Le montant doit être supérieur à zéro.' }),
	paidOn: isoDate,
	method: z.enum(PAYOUT_METHODS, { error: 'Choisissez le moyen.' }),
	reference: z
		.string()
		.trim()
		.max(60, { error: 'Référence trop longue.' })
		.nullish()
		.transform((v) => (v ? v : null)),
	note: z
		.string()
		.trim()
		.max(500, { error: 'Note trop longue.' })
		.nullish()
		.transform((v) => (v ? v : null))
});
export type PayoutData = z.output<typeof payoutSchema>;

export const cancelPayoutSchema = z.object({
	reason: z.string().trim().min(5, { error: 'Indiquez le motif (5 caractères au moins).' }).max(500, { error: 'Motif trop long.' })
});

// ---------------------------------------------------------------- lien partagé

/** Lien `/s/<jeton>` : 32 octets aléatoires, empreinte seulement côté serveur, 90 jours, révocable. */
export const STATEMENT_TOKEN_BYTES = 32;
export const STATEMENT_LINK_TTL_DAYS = 90;
export const STATEMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const statementTokenSchema = z.string().regex(STATEMENT_TOKEN_PATTERN, { error: 'Lien de relevé invalide.' });

const webCrypto = (globalThis as unknown as { crypto: { getRandomValues<T extends Uint8Array>(array: T): T } }).crypto;

export function newStatementToken(): string {
	return base64Url(webCrypto.getRandomValues(new Uint8Array(STATEMENT_TOKEN_BYTES)));
}

export function statementTokenExpiry(createdAt: Date): Date {
	return new Date(createdAt.getTime() + STATEMENT_LINK_TTL_DAYS * 86_400_000);
}

export function statementTokenState(token: { expiresAt: Date; revokedAt: Date | null }, now: Date): 'valid' | 'expired' | 'revoked' {
	if (token.revokedAt) return 'revoked';
	return now.getTime() >= token.expiresAt.getTime() ? 'expired' : 'valid';
}

// ---------------------------------------------------------------- affichage

/** Cadre de synthèse (point 2 du porteur) : jamais un grand montant négatif, toujours un libellé. */
export interface NetHeadline {
	tone: 'payout' | 'zero' | 'owed';
	label: string;
	/** Montant affiché, toujours positif ou nul. */
	amount: Fcfa;
	explanation: string | null;
}

export function netHeadline(
	totals: Pick<StatementTotals, 'net' | 'rentCollectedByOwner' | 'chargesCollectedByOwner'>,
	organizationName: string
): NetHeadline {
	if (totals.net > 0) return { tone: 'payout', label: 'Net à vous reverser', amount: totals.net, explanation: null };
	if (totals.net === 0) return { tone: 'zero', label: 'Rien à reverser ce mois-ci', amount: 0, explanation: null };
	const direct = totals.rentCollectedByOwner + totals.chargesCollectedByOwner !== 0;
	return {
		tone: 'owed',
		label: `Solde en faveur de ${organizationName}`,
		amount: -totals.net,
		explanation: [
			direct
				? `Les loyers de ce relevé ont été perçus directement par vous ; la commission et les dépenses avancées par ${organizationName} restent dues.`
				: null,
			'Ce solde est reporté sur votre prochain relevé, jusqu’à ce qu’il soit couvert.'
		]
			.filter(Boolean)
			.join(' ')
	};
}

const ORIGIN_LABEL: Record<StatementAllocationOrigin, (l: StatementRentLine) => string> = {
	payment: (l) => `Payé le ${formatDate(l.paidOn)}`,
	credit: (l) => `Trop-perçu du ${formatDate(l.paidOn)}, imputé le ${formatDate(l.date)}`,
	cancellation: (l) => `Annulation le ${formatDate(l.date)} du paiement du ${formatDate(l.paidOn)}`
};

/** Mention d'un élément daté d'un mois antérieur (réponse 5). */
export function lateMention(date: string, monthIssued: boolean): string {
	return monthIssued
		? `enregistré après l’émission du relevé de ${monthLabel(monthOfDate(date))}`
		: `reporté de ${monthLabel(monthOfDate(date))}`;
}

/** Libellé d'une ligne d'encaissement : locataire **par son nom seulement** (demande du porteur), période, reçu. */
export function rentLineLabel(l: StatementRentLine): { title: string; detail: string } {
	const parts = [
		ORIGIN_LABEL[l.origin](l),
		l.receiptNumber ? `reçu ${l.receiptNumber}` : null,
		l.late ? lateMention(l.date, l.lateMonthIssued) : null
	];
	return {
		title: `${l.tenantName} · loyer du ${formatDate(l.periodStart)} au ${formatDate(l.periodEnd)}`,
		detail: parts.filter(Boolean).join(' · ')
	};
}

const PERCENT = (bp: number) => `${(bp / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}${NBSP}%`;

export function commissionLineLabel(c: StatementCommissionLine): string {
	switch (c.basis) {
		case 'percent_of_collected':
			return `Commission de gestion, ${PERCENT(c.rateBp!)} du loyer encaissé (${formatFcfaSignedPlain(c.base!)})`;
		case 'fixed_per_month':
			return c.days === c.daysInMonth
				? `Commission de gestion, ${monthLabel(c.month!)}`
				: `Commission de gestion, ${monthLabel(c.month!)} (${c.days} jours sur ${c.daysInMonth})`;
		case 'fixed_per_operation':
			return `Commission de mise en location, bail de ${c.tenantName}`;
	}
}

function formatFcfaSignedPlain(n: number): string {
	return n < 0 ? `−${formatFcfa(-n)}` : formatFcfa(n);
}

export function expenseLineLabel(
	l: Pick<StatementExpenseLine, 'kind' | 'category' | 'description' | 'date' | 'late' | 'viaOwnerDeposit'>
): {
	title: string;
	detail: string;
} {
	const what = `${EXPENSE_CATEGORY_LABELS[l.category]} · ${l.description}`;
	if (l.viaOwnerDeposit) {
		return { title: what, detail: `Réparation avancée par l’agence, retenue par vous sur la caution le ${formatDate(l.date)}` };
	}
	return l.kind === 'expense'
		? { title: what, detail: `Dépense du ${formatDate(l.date)}${l.late ? `, ${lateMention(l.date, false)}` : ''}` }
		: { title: what, detail: `Dépense annulée le ${formatDate(l.date)}, rendue` };
}

/** Données figées à l'émission (D29) et contenu du relevé. */
export interface StatementSnapshot {
	organization: ReceiptOrganizationSnapshot;
	owner: { displayName: string };
	month: StatementMonth;
	version: number;
	issuedOn: string | null;
	units: StatementUnit[];
	result: Omit<StatementResult, 'consumed' | 'revision'>;
}

export interface StatementRow {
	title: string;
	detail?: string;
	/** Montant signé. */
	amount: number;
}

export interface StatementSection {
	title: string;
	rows: StatementRow[];
	total?: { label: string; amount: number };
	note?: string;
}

export interface StatementDocument {
	title: string;
	draft: boolean;
	organization: string[];
	owner: string;
	period: string;
	headline: NetHeadline;
	sections: StatementSection[];
	info: StatementSection[];
}

/**
 * Contenu du relevé, le même pour l'écran, le PDF et la page partagée. Un locataire n'y apparaît que par son nom :
 * les types d'entrée n'ont ni téléphone, ni pièce d'identité, ni autre donnée personnelle (demande du porteur).
 */
export function statementDocument(s: StatementSnapshot): StatementDocument {
	const r = s.result;
	const unitLabel = new Map(s.units.map((u) => [u.id, u.label]));
	const label = (unitId: string | null) => (unitId ? (unitLabel.get(unitId) ?? '') : 'Bien entier');
	const org = s.organization;
	const rentRows = (collector: 'organization' | 'owner'): StatementRow[] =>
		r.rentLines
			.filter((l) => l.collectedBy === collector)
			.map((l) => {
				const { title, detail } = rentLineLabel(l);
				return {
					title: `${label(l.unitId)} · ${title}`,
					detail: `${detail} · loyer ${formatFcfaSignedPlain(l.rent)}, charges ${formatFcfaSignedPlain(l.charges)}`,
					amount: l.rent + l.charges
				};
			});
	const sections: StatementSection[] = [
		{
			title: 'Loyers et charges encaissés pour vous',
			rows: rentRows('organization'),
			total: { label: 'Total encaissé', amount: r.totals.collected },
			note: r.unitTotals.length ? r.unitTotals.map((u) => `${u.label} : ${formatFcfaSignedPlain(u.total)}`).join(' · ') : undefined
		},
		{
			title: 'Commission de gestion',
			rows: r.commissions.map((c) => ({ title: commissionLineLabel(c), amount: -c.amount })),
			total: { label: 'Total de la commission', amount: -r.totals.commission }
		},
		{
			title: 'Dépenses avancées pour vous',
			rows: r.expenseLines.map((l) => {
				const { title, detail } = expenseLineLabel(l);
				return { title: `${label(l.unitId)} · ${title}`, detail, amount: l.amount };
			}),
			total: { label: 'Total des dépenses', amount: r.totals.expenses }
		}
	];
	if (r.carried) {
		sections.push({
			title: 'Solde du relevé précédent',
			rows: [
				{
					title: `Relevé de ${monthLabel(r.carried.month)}${r.carried.version > 1 ? ` (rectificatif ${r.carried.version})` : ''}`,
					amount: r.carried.amount
				}
			]
		});
	}
	const info: StatementSection[] = [];
	if (r.ownerUnitTotals.length) {
		info.push({
			title: 'Loyers perçus directement par vous (pour information)',
			rows: rentRows('owner'),
			total: { label: 'Total perçu par vous', amount: r.totals.rentCollectedByOwner + r.totals.chargesCollectedByOwner }
		});
	}
	if (r.info.depositsHeld.length) {
		info.push({
			title: 'Cautions détenues pour vous',
			rows: r.info.depositsHeld.map((d) => ({
				title: `${label(d.unitId)} · ${d.tenantName}`,
				detail: d.type === 'utilities_guarantee' ? 'Garantie des factures' : 'Dépôt de garantie',
				amount: d.balance
			})),
			note: 'Une caution reste l’argent du locataire jusqu’à sa sortie : elle n’entre pas dans le net à reverser.'
		});
	}
	if (r.info.creditsHeld.length) {
		info.push({
			title: 'Trop-perçus détenus pour vos locataires',
			rows: r.info.creditsHeld.map((c) => ({ title: `${label(c.unitId)} · ${c.tenantName}`, amount: c.amount })),
			note: 'Un trop-perçu entre dans votre relevé le mois où il est imputé sur un loyer.'
		});
	}
	if (r.info.ownerPaidExpenses.length) {
		info.push({
			title: 'Dépenses réglées directement par vous',
			rows: r.info.ownerPaidExpenses.map((e) => ({
				title: `${label(e.unitId)} · ${EXPENSE_CATEGORY_LABELS[e.category]} · ${e.description}`,
				detail: `Dépense du ${formatDate(e.date)}`,
				amount: e.amount
			}))
		});
	}
	return {
		title: `${s.version > 1 ? `Relevé rectificatif n° ${s.version}` : 'Relevé de gestion'} · ${monthLabel(s.month)}`,
		draft: s.issuedOn === null,
		organization: [
			org.name,
			[org.address, org.commune].filter(Boolean).join(', '),
			org.poBox ?? '',
			org.phone ? `Tél. ${org.phone}` : '',
			[org.rccm ? `RCCM ${org.rccm}` : '', org.ifu ? `IFU ${org.ifu}` : ''].filter(Boolean).join(' · ')
		].filter((l) => l.length > 0),
		owner: s.owner.displayName,
		period: `Du ${formatDate(monthStart(s.month))} au ${formatDate(monthEnd(s.month))}`,
		headline: netHeadline(r.totals, org.name),
		sections,
		info
	};
}

// ---------------------------------------------------------------- vues (API et appareil)

export interface PayoutView {
	id: string;
	kind: 'payout' | 'reversal';
	reversesPayoutId: string | null;
	ownerId: string;
	statementId: string;
	amount: Fcfa;
	paidOn: string;
	method: PayoutMethod;
	reference: string | null;
	note: string | null;
	reason: string | null;
	recordedBy: string | null;
	createdAt: string;
}

export interface StatementSummaryView {
	id: string;
	ownerId: string;
	ownerName: string;
	month: StatementMonth;
	version: number;
	correctsStatementId: string | null;
	status: StatementStatus;
	revision: string;
	totals: StatementTotals;
	issuedOn: string | null;
	issuedAt: string | null;
	pdfAvailable: boolean;
}

export interface StatementDetailView extends StatementSummaryView {
	document: StatementDocument;
	payouts: PayoutView[];
	/** Total reversé (contre-écritures déduites). */
	paidOut: Fcfa;
	/** Reste à reverser sur ce relevé. */
	remaining: Fcfa;
}

/** Page partagée `/s/<jeton>` : le relevé émis, en lecture seule ; aucune donnée personnelle de locataire. */
export interface SharedStatementView {
	document: StatementDocument;
	issuedOn: string | null;
	pdfAvailable: boolean;
}

export interface StatementShareLinkView {
	token: string;
	url: string;
	expiresAt: string;
}

/** Total reversé sur un relevé : reversements moins contre-écritures. */
export function payoutsTotal(payouts: readonly Pick<PayoutView, 'kind' | 'amount'>[]): Fcfa {
	return payouts.reduce((s, p) => s + (p.kind === 'payout' ? p.amount : -p.amount), 0);
}
