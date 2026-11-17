/**
 * Imputation des encaissements (lot 09), en fonctions pures : la même pour le serveur, qui impute à la confirmation et
 * écrit le résultat, et pour l'appareil, qui affiche une imputation prévisionnelle.
 *
 * - Un encaissement de loyer s'impute sur les échéances **les plus anciennes non soldées** du bail (par date
 *   d'échéance, puis début de période), à venir comprises : un trop-perçu va ainsi sur l'échéance suivante.
 * - Ce qui reste quand aucune échéance n'est ouverte devient un **crédit du bail**, rattaché à son encaissement ; il
 *   est imputé dès qu'une échéance est émise (`applyLeaseCredit`), le plus ancien crédit d'abord.
 * - Un versement de caution s'impute sur son compte de caution, sans dépasser le montant convenu.
 * - Les lignes sont en ajout seul, montants positifs (règle 2) : une annulation ajoute des lignes inverses
 *   (`reverse`). L'imputation d'un crédit sur une échéance s'écrit sur l'encaissement d'origine (crédit `reverse`,
 *   échéance `allocate`) : la contre-écriture d'un encaissement annulé défait donc aussi l'imputation de son crédit
 *   (réponse du porteur, point 10), et aucun crédit ne devient négatif.
 *
 * Invariants (test de propriété) : pour chaque encaissement, la somme nette de ses lignes est égale à son montant, ou
 * nulle s'il est annulé ; aucune échéance ne reçoit plus que son montant ; aucun crédit n'est négatif.
 */
import type { Fcfa } from './money.js';

export const ALLOCATION_TARGETS = ['rent_due', 'deposit_account', 'credit', 'expense'] as const;
export type AllocationTarget = (typeof ALLOCATION_TARGETS)[number];

export const ALLOCATION_DIRECTIONS = ['allocate', 'reverse'] as const;
export type AllocationDirection = (typeof ALLOCATION_DIRECTIONS)[number];

export interface AllocationLine {
	paymentId: string;
	target: AllocationTarget;
	/** Échéance, compte de caution ou dépense ; `null` pour le crédit du bail. */
	targetId: string | null;
	direction: AllocationDirection;
	/** Toujours strictement positif. */
	amount: Fcfa;
}

/** Échéance vue par l'imputation. */
export interface DueForAllocation {
	id: string;
	dueOn: string;
	periodStart: string;
	amountDue: Fcfa;
	amountPaid: Fcfa;
	waived?: boolean;
}

export class AllocationError extends Error {
	constructor(
		readonly code: 'ALLOCATION_INVALID_AMOUNT' | 'ALLOCATION_NEGATIVE_CREDIT' | 'ALLOCATION_ALREADY_REVERSED',
		message: string
	) {
		super(message);
		this.name = 'AllocationError';
	}
}

function assertPositive(amount: Fcfa): void {
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		throw new AllocationError('ALLOCATION_INVALID_AMOUNT', `Montant à imputer invalide : ${amount}.`);
	}
}

/** Échéances ouvertes, dans l'ordre d'imputation : date d'échéance, début de période, identifiant. */
export function openDuesInOrder<T extends DueForAllocation>(dues: readonly T[]): T[] {
	return dues
		.filter((d) => !d.waived && d.amountPaid < d.amountDue)
		.sort((a, b) =>
			a.dueOn !== b.dueOn
				? a.dueOn < b.dueOn
					? -1
					: 1
				: a.periodStart !== b.periodStart
					? a.periodStart < b.periodStart
						? -1
						: 1
					: a.id < b.id
						? -1
						: 1
		);
}

/**
 * Imputation d'un encaissement de loyer : les échéances ouvertes les plus anciennes d'abord, puis le reste en crédit.
 * Les échéances ne sont pas modifiées : appliquer les lignes avec `applyLinesToDues`.
 */
export function allocateRentPayment(paymentId: string, amount: Fcfa, dues: readonly DueForAllocation[]): AllocationLine[] {
	assertPositive(amount);
	const lines: AllocationLine[] = [];
	let left = amount;
	for (const due of openDuesInOrder(dues)) {
		if (left === 0) break;
		const part = Math.min(left, due.amountDue - due.amountPaid);
		lines.push({ paymentId, target: 'rent_due', targetId: due.id, direction: 'allocate', amount: part });
		left -= part;
	}
	if (left > 0) lines.push({ paymentId, target: 'credit', targetId: null, direction: 'allocate', amount: left });
	return lines;
}

/**
 * Remboursement d'une dépense réclamée au locataire (lot 10, option A du porteur) : une seule ligne, imputée exactement
 * sur la dépense, jamais en crédit. Le plafond (reste dû sur la dépense) est contrôlé à part, et par la base.
 */
export function allocateExpensePayment(paymentId: string, amount: Fcfa, expenseId: string): AllocationLine[] {
	assertPositive(amount);
	return [{ paymentId, target: 'expense', targetId: expenseId, direction: 'allocate', amount }];
}

/** Versement sur un compte de caution : une seule ligne ; le plafond (montant convenu) est contrôlé à part. */
export function allocateDepositPayment(paymentId: string, amount: Fcfa, depositAccountId: string): AllocationLine[] {
	assertPositive(amount);
	return [{ paymentId, target: 'deposit_account', targetId: depositAccountId, direction: 'allocate', amount }];
}

function signed(line: AllocationLine): number {
	return line.direction === 'allocate' ? line.amount : -line.amount;
}

/** Somme nette par cible (`target:targetId`). */
export function netByTarget(
	lines: readonly AllocationLine[]
): Map<string, { target: AllocationTarget; targetId: string | null; amount: Fcfa }> {
	const out = new Map<string, { target: AllocationTarget; targetId: string | null; amount: Fcfa }>();
	for (const l of lines) {
		const key = `${l.target}:${l.targetId ?? ''}`;
		const cur = out.get(key) ?? { target: l.target, targetId: l.targetId, amount: 0 };
		cur.amount += signed(l);
		out.set(key, cur);
	}
	return out;
}

/** Somme nette imputée par un encaissement : son montant tant qu'il tient, zéro une fois annulé. */
export function netAllocated(lines: readonly AllocationLine[], paymentId?: string): Fcfa {
	return lines.filter((l) => paymentId === undefined || l.paymentId === paymentId).reduce((sum, l) => sum + signed(l), 0);
}

/** Crédit disponible par encaissement (lignes `credit`, nettes), dans l'ordre des encaissements fourni. */
export function creditByPayment(lines: readonly AllocationLine[]): Map<string, Fcfa> {
	const out = new Map<string, Fcfa>();
	for (const l of lines) {
		if (l.target !== 'credit') continue;
		out.set(l.paymentId, (out.get(l.paymentId) ?? 0) + signed(l));
	}
	for (const [k, v] of out) {
		if (v < 0) throw new AllocationError('ALLOCATION_NEGATIVE_CREDIT', `Crédit négatif sur l'encaissement ${k}.`);
		if (v === 0) out.delete(k);
	}
	return out;
}

/** Crédit total d'un bail. */
export function leaseCredit(lines: readonly AllocationLine[]): Fcfa {
	let total = 0;
	for (const v of creditByPayment(lines).values()) total += v;
	return total;
}

export interface CreditSource {
	paymentId: string;
	/** Crédit disponible de cet encaissement. */
	amount: Fcfa;
}

/**
 * Imputation du crédit du bail sur ses échéances ouvertes (après l'émission d'une échéance, ou à la confirmation d'un
 * encaissement) : le crédit le plus ancien d'abord (ordre des sources), les échéances les plus anciennes d'abord. Chaque
 * imputation s'écrit sur l'encaissement d'origine : crédit `reverse` et échéance `allocate`, du même montant.
 */
export function applyLeaseCredit(credits: readonly CreditSource[], dues: readonly DueForAllocation[]): AllocationLine[] {
	const open = openDuesInOrder(dues).map((d) => ({ id: d.id, left: d.amountDue - d.amountPaid }));
	const lines: AllocationLine[] = [];
	let i = 0;
	for (const source of credits) {
		let left = source.amount;
		while (left > 0 && i < open.length) {
			const due = open[i]!;
			const part = Math.min(left, due.left);
			lines.push({ paymentId: source.paymentId, target: 'credit', targetId: null, direction: 'reverse', amount: part });
			lines.push({ paymentId: source.paymentId, target: 'rent_due', targetId: due.id, direction: 'allocate', amount: part });
			left -= part;
			due.left -= part;
			if (due.left === 0) i += 1;
		}
		if (i >= open.length) break;
	}
	return lines;
}

/**
 * Contre-écriture des imputations d'un encaissement annulé : une ligne inverse par cible dont la somme nette n'est pas
 * nulle. Le crédit déjà imputé sur une échéance suivante est contrepassé avec elle (l'échéance redevient due ou en
 * retard) ; le crédit restant est retiré ; aucun crédit ne devient négatif. Les autres encaissements ne sont pas
 * réimputés (réponse du porteur, point 10).
 */
export function reverseAllocations(paymentId: string, lines: readonly AllocationLine[]): AllocationLine[] {
	const own = lines.filter((l) => l.paymentId === paymentId);
	if (own.length && netAllocated(own) === 0) {
		throw new AllocationError('ALLOCATION_ALREADY_REVERSED', `Les imputations de ${paymentId} sont déjà contrepassées.`);
	}
	const out: AllocationLine[] = [];
	for (const net of netByTarget(own).values()) {
		if (net.amount < 0) throw new AllocationError('ALLOCATION_NEGATIVE_CREDIT', `Solde négatif sur ${net.target}.`);
		if (net.amount > 0) out.push({ paymentId, target: net.target, targetId: net.targetId, direction: 'reverse', amount: net.amount });
	}
	return out;
}

/** Montant payé de chaque échéance après les lignes données (lignes `rent_due` seulement). */
export function applyLinesToDues<T extends DueForAllocation>(dues: readonly T[], lines: readonly AllocationLine[]): T[] {
	const delta = new Map<string, number>();
	for (const l of lines) if (l.target === 'rent_due' && l.targetId) delta.set(l.targetId, (delta.get(l.targetId) ?? 0) + signed(l));
	return dues.map((d) => (delta.has(d.id) ? { ...d, amountPaid: d.amountPaid + delta.get(d.id)! } : d));
}

/**
 * Imputation prévisionnelle affichée sur l'appareil avant la confirmation : le crédit existant d'abord, puis le
 * montant saisi. Le serveur refait le calcul à la confirmation et fait foi.
 */
export function forecastRentAllocation(
	amount: Fcfa,
	dues: readonly DueForAllocation[],
	credits: readonly CreditSource[] = []
): { lines: AllocationLine[]; credit: Fcfa } {
	const creditLines = applyLeaseCredit(credits, dues);
	const lines = allocateRentPayment('forecast', amount, applyLinesToDues(dues, creditLines));
	const credit = lines.filter((l) => l.target === 'credit').reduce((s, l) => s + l.amount, 0);
	return { lines, credit };
}
