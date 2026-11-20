/**
 * Décompte de sortie (lot 10 bis, D15, D32, règle 14) : un seul calcul, fait de lignes justifiées. Les trois scénarios
 * du porteur (restitution après réparations, caution imputée sur les derniers loyers par accord, réparations faites par
 * le locataire) en sont des variantes.
 *
 *   montant à restituer = caution reçue
 *                         − mois imputés par accord (`applied_to_rent`, avant le départ)
 *                         − retenues pour réparations (`retained`)
 *                         − sommes dues et justifiées (`applied_to_debt` : loyers et charges impayés, dépenses réclamées)
 *                         + trop-perçu du bail (argent du locataire, jamais une partie de la caution)
 *   s'il est négatif, sa valeur absolue est le complément à réclamer (`additional_claimed`).
 *
 * Règles de chaque ligne (`settlementLineBlocker`) :
 * - une retenue (`repair`) pointe vers une ligne d'état des lieux `tenant_damage`, avec un montant et un justificatif
 *   (devis ou facture) ; une réparation faite par le locataire, sur accord accepté, n'est retirée du décompte qu'après
 *   contre-visite (`verified`) ; sinon la retenue est maintenue ;
 * - une somme due (`unpaid_rent`, `expense_claim`, `utility_bill`) pointe vers l'échéance ou la dépense elle-même,
 *   jamais une copie (règle 16), pour son reste dû seulement ; une dépense exige son justificatif ;
 * - une imputation sur loyer (`rent_by_agreement`) exige un accord `deposit_applied_to_rent` accepté avant le début du
 *   mois concerné, et ce mois précède le départ.
 *
 * La caution couvre les lignes dans cet ordre (plan validé par le porteur) : mois imputés par accord (déjà faits avant
 * le départ), réparations, dépenses, puis loyers et charges. Ce qu'elle ne couvre pas reste dû (impayés). Le total des
 * sorties ne dépasse jamais la caution reçue.
 *
 * La garantie des factures (`utilities_guarantee`) a son propre décompte : factures d'eau et d'électricité impayées et
 * justifiées, puis solde.
 *
 * Montants (règle 2) : entiers FCFA, jamais de flottant.
 */
import { addDays, daysBetween } from './dates.js';
import { assertFcfa, type Fcfa } from './money.js';

// ---------------------------------------------------------------- vocabulaire

/** Constat d'un élément à la sortie (article 20 : ni l'usure normale ni la vétusté ne sont à la charge du locataire). */
export const INSPECTION_FINDINGS = ['normal_wear', 'tenant_damage', 'landlord_defect'] as const;
export type InspectionFinding = (typeof INSPECTION_FINDINGS)[number];

export const REPAIR_PERFORMERS = ['organization', 'tenant'] as const;
export type RepairPerformer = (typeof REPAIR_PERFORMERS)[number];

export const REPAIR_STATUSES = ['planned', 'done', 'verified'] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];

export const SETTLEMENT_ACCOUNT_TYPES = ['security_deposit', 'utilities_guarantee'] as const;
export type SettlementAccountType = (typeof SETTLEMENT_ACCOUNT_TYPES)[number];

export const SETTLEMENT_LINE_KINDS = ['rent_by_agreement', 'repair', 'expense_claim', 'utility_bill', 'unpaid_rent'] as const;
export type SettlementLineKind = (typeof SETTLEMENT_LINE_KINDS)[number];

/** Ordre de couverture par la caution (plan validé). */
const COVERAGE_ORDER: Record<SettlementLineKind, number> = {
	rent_by_agreement: 0,
	repair: 1,
	expense_claim: 2,
	utility_bill: 2,
	unpaid_rent: 3
};

/** Lignes admises par type de compte : la garantie des factures ne couvre que les factures (D24, lot 08). */
export const SETTLEMENT_LINES_BY_ACCOUNT: Record<SettlementAccountType, readonly SettlementLineKind[]> = {
	security_deposit: ['rent_by_agreement', 'repair', 'expense_claim', 'unpaid_rent'],
	utilities_guarantee: ['utility_bill']
};

/** Mouvement du compte de caution écrit à la clôture pour chaque sorte de ligne (D32). */
export const SETTLEMENT_LINE_MOVEMENT = {
	rent_by_agreement: 'applied_to_rent',
	repair: 'retained',
	expense_claim: 'applied_to_debt',
	utility_bill: 'applied_to_debt',
	unpaid_rent: 'applied_to_debt'
} as const satisfies Record<SettlementLineKind, string>;

export const UTILITY_BILL_CATEGORIES = ['water_bill', 'electricity_bill'] as const;

// ---------------------------------------------------------------- lignes

interface LineBase {
	/** Identifiant de la ligne du décompte. */
	id: string;
}

/** Réparation d'un élément constaté à l'état des lieux de sortie. */
export interface RepairLine extends LineBase {
	kind: 'repair';
	inspectionItemId: string | null;
	finding: InspectionFinding | null;
	repairId: string;
	performedBy: RepairPerformer;
	status: RepairStatus;
	/** Devis : montant estimé et son justificatif. */
	estimatedAmount: Fcfa | null;
	quoteDocumentId: string | null;
	/** Facture : montant réel et son justificatif (réparation faite). */
	actualAmount: Fcfa | null;
	invoiceDocumentId: string | null;
	/** Réparation par le locataire : accord `tenant_self_repair` accepté. */
	selfRepairAgreed: boolean;
	/** Dépense créée pour une réparation faite par l'organisation (règle 16 : la retenue renvoie à la dépense). */
	expenseId: string | null;
}

/** Échéance de loyer et charges impayée à la sortie. */
export interface UnpaidRentLine extends LineBase {
	kind: 'unpaid_rent';
	rentDueId: string;
	periodStart: string;
	/** Reste dû : montant dû − payé − encaissements en attente de validation (jamais relancés, jamais retenus). */
	outstanding: Fcfa;
}

/** Dépense réclamée au locataire encore impayée (lot 10, option A), ou facture d'eau ou d'électricité. */
export interface ExpenseDebtLine extends LineBase {
	kind: 'expense_claim' | 'utility_bill';
	expenseId: string;
	category: string;
	recovery: string;
	status: 'recorded' | 'cancelled';
	documentId: string | null;
	/** Reste dû : montant − remboursé − encaissements en attente. */
	outstanding: Fcfa;
}

/** Mois couvert par la caution, sur accord écrit accepté avant ce mois (scénario B). */
export interface RentByAgreementLine extends LineBase {
	kind: 'rent_by_agreement';
	rentDueId: string;
	periodStart: string;
	amount: Fcfa;
	agreementId: string | null;
	agreementType: string | null;
	agreementStatus: string | null;
	/** Date d'acceptation de l'accord. */
	agreementAcceptedOn: string | null;
	/** Mois couverts par l'accord (débuts de période). */
	agreementMonths: readonly string[];
	/** Déjà imputé avant le départ (mouvement écrit) : compté, jamais réécrit à la clôture. */
	executed: boolean;
}

export type SettlementLine = RepairLine | UnpaidRentLine | ExpenseDebtLine | RentByAgreementLine;

export type SettlementLineBlocker =
	| 'LINE_NOT_FOR_ACCOUNT'
	| 'RETENTION_NOT_TENANT_DAMAGE'
	| 'RETENTION_AMOUNT_MISSING'
	| 'RETENTION_PROOF_MISSING'
	| 'DEBT_NOTHING_DUE'
	| 'DEBT_PROOF_MISSING'
	| 'DEBT_NOT_CLAIMED'
	| 'DEBT_NOT_UTILITY_BILL'
	| 'AGREEMENT_MISSING'
	| 'AGREEMENT_NOT_ACCEPTED'
	| 'AGREEMENT_AFTER_PERIOD'
	| 'AGREEMENT_MONTH_NOT_COVERED'
	| 'AGREEMENT_PERIOD_AFTER_EXIT'
	| 'AMOUNT_INVALID';

/**
 * Montant d'une réparation : la facture si elle est faite, sinon le devis, avec le justificatif qui va avec. Une
 * réparation faite par le locataire et vérifiée (contre-visite), sur accord accepté, vaut 0 : elle sort du décompte.
 */
export function repairRetention(r: RepairLine): {
	amount: Fcfa | null;
	documentId: string | null;
	basis: 'invoice' | 'quote' | 'self_repair';
} {
	if (r.performedBy === 'tenant' && r.selfRepairAgreed && r.status === 'verified') {
		return { amount: 0, documentId: null, basis: 'self_repair' };
	}
	if (r.actualAmount !== null && r.invoiceDocumentId) return { amount: r.actualAmount, documentId: r.invoiceDocumentId, basis: 'invoice' };
	return { amount: r.estimatedAmount, documentId: r.quoteDocumentId, basis: 'quote' };
}

/** Montant que la ligne demande à la caution (avant couverture). */
export function lineAmount(line: SettlementLine): Fcfa {
	switch (line.kind) {
		case 'repair':
			return repairRetention(line).amount ?? 0;
		case 'unpaid_rent':
		case 'expense_claim':
		case 'utility_bill':
			return line.outstanding;
		case 'rent_by_agreement':
			return line.amount;
	}
}

/**
 * Refus d'une ligne (règle 14, D32), le même pour l'API, la synchronisation et l'écran. `exitOn` : date de sortie.
 */
export function settlementLineBlocker(
	line: SettlementLine,
	ctx: { accountType: SettlementAccountType; exitOn: string }
): SettlementLineBlocker | null {
	if (!SETTLEMENT_LINES_BY_ACCOUNT[ctx.accountType].includes(line.kind)) return 'LINE_NOT_FOR_ACCOUNT';
	const amount = lineAmount(line);
	if (!Number.isSafeInteger(amount) || amount < 0) return 'AMOUNT_INVALID';
	switch (line.kind) {
		case 'repair': {
			if (!line.inspectionItemId || line.finding !== 'tenant_damage') return 'RETENTION_NOT_TENANT_DAMAGE';
			const r = repairRetention(line);
			if (r.basis === 'self_repair') return null;
			if (r.amount === null || r.amount <= 0) return 'RETENTION_AMOUNT_MISSING';
			if (!r.documentId) return 'RETENTION_PROOF_MISSING';
			return null;
		}
		case 'unpaid_rent':
			return line.outstanding > 0 ? null : 'DEBT_NOTHING_DUE';
		case 'expense_claim':
		case 'utility_bill':
			if (line.status !== 'recorded' || line.recovery !== 'claimed_from_tenant') return 'DEBT_NOT_CLAIMED';
			if (line.kind === 'utility_bill' && !(UTILITY_BILL_CATEGORIES as readonly string[]).includes(line.category)) {
				return 'DEBT_NOT_UTILITY_BILL';
			}
			if (!line.documentId) return 'DEBT_PROOF_MISSING';
			return line.outstanding > 0 ? null : 'DEBT_NOTHING_DUE';
		case 'rent_by_agreement':
			return rentApplicationBlocker(
				{
					id: line.agreementId,
					type: line.agreementType,
					status: line.agreementStatus,
					acceptedOn: line.agreementAcceptedOn,
					months: line.agreementMonths
				},
				{ periodStart: line.periodStart, amount: line.amount },
				ctx.exitOn
			);
	}
}

/**
 * Imputation de la caution sur un loyer, par accord (scénario B) : accord `deposit_applied_to_rent` accepté **avant**
 * le début du mois, mois couvert par l'accord et antérieur au départ. Sans accord, ou accord daté après : refus.
 */
export function rentApplicationBlocker(
	agreement: {
		id: string | null;
		type: string | null;
		status: string | null;
		acceptedOn: string | null;
		months: readonly string[];
	},
	month: { periodStart: string; amount: Fcfa },
	exitOn: string | null
): Extract<SettlementLineBlocker, `AGREEMENT_${string}` | 'AMOUNT_INVALID'> | null {
	if (!agreement.id || agreement.type !== 'deposit_applied_to_rent') return 'AGREEMENT_MISSING';
	if (agreement.status !== 'accepted' || !agreement.acceptedOn) return 'AGREEMENT_NOT_ACCEPTED';
	if (agreement.acceptedOn >= month.periodStart) return 'AGREEMENT_AFTER_PERIOD';
	if (!agreement.months.includes(month.periodStart)) return 'AGREEMENT_MONTH_NOT_COVERED';
	if (exitOn !== null && month.periodStart > exitOn) return 'AGREEMENT_PERIOD_AFTER_EXIT';
	if (!Number.isSafeInteger(month.amount) || month.amount <= 0) return 'AMOUNT_INVALID';
	return null;
}

// ---------------------------------------------------------------- calcul

export interface SettlementInput {
	accountType: SettlementAccountType;
	/** Caution reçue (versements moins contre-écritures). */
	received: Fcfa;
	/** Déjà restitué sur la caution (mouvements `refunded` : partie non contestée restituée sans attendre). */
	alreadyRefunded: Fcfa;
	/** Trop-perçu du bail non imputé (crédit, lot 09) : argent du locataire. Compté sur le seul décompte de la caution. */
	credit: Fcfa;
	exitOn: string;
	lines: readonly SettlementLine[];
}

export interface SettlementLineResult {
	id: string;
	kind: SettlementLineKind;
	/** Montant demandé par la ligne (0 pour une ligne refusée). */
	amount: Fcfa;
	/** Part couverte par la caution. */
	covered: Fcfa;
	/** Part qui reste due par le locataire. */
	uncovered: Fcfa;
	blocker: SettlementLineBlocker | null;
}

export const SETTLEMENT_OUTCOMES = ['refund', 'claim', 'zero'] as const;
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];

export interface SettlementResult {
	lines: SettlementLineResult[];
	received: Fcfa;
	/** Total des lignes admises. */
	deductions: Fcfa;
	/** Part de la caution qui couvre les lignes (sorties autres que la restitution). */
	coveredByDeposit: Fcfa;
	/** Part du trop-perçu qui couvre ce que la caution ne couvre pas. */
	creditUsed: Fcfa;
	/** Restitution totale : reste de la caution + reste du trop-perçu. */
	refund: Fcfa;
	refundFromDeposit: Fcfa;
	refundFromCredit: Fcfa;
	/** Ce qui reste à restituer (caution et trop-perçu), déduction faite de ce qui l'a déjà été sur la caution. */
	refundRemaining: Fcfa;
	/** Complément à réclamer au locataire. */
	claim: Fcfa;
	outcome: SettlementOutcome;
}

export class SettlementError extends RangeError {
	constructor(
		readonly code: 'SETTLEMENT_INPUT_INVALID' | 'SETTLEMENT_ALREADY_REFUNDED_EXCEEDS',
		message: string
	) {
		super(message);
		this.name = 'SettlementError';
	}
}

/**
 * Le décompte. Les lignes refusées ne comptent pas (elles restent affichées avec leur motif). L'écran, l'API et la
 * synchronisation appellent la même fonction ; le serveur refait le calcul et fait foi.
 */
export function computeSettlement(input: SettlementInput): SettlementResult {
	for (const [label, v] of [
		['Caution reçue', input.received],
		['Déjà restitué', input.alreadyRefunded],
		['Trop-perçu', input.credit]
	] as const) {
		assertFcfa(v);
		if (v < 0) throw new SettlementError('SETTLEMENT_INPUT_INVALID', `${label} négatif.`);
	}
	const credit = input.accountType === 'security_deposit' ? input.credit : 0;
	const ordered = input.lines
		.map((line, index) => ({ line, index }))
		.sort((a, b) => COVERAGE_ORDER[a.line.kind] - COVERAGE_ORDER[b.line.kind] || a.index - b.index);
	let available = input.received;
	let deductions = 0;
	const byId = new Map<string, SettlementLineResult>();
	for (const { line } of ordered) {
		const blocker = settlementLineBlocker(line, { accountType: input.accountType, exitOn: input.exitOn });
		const amount = blocker ? 0 : lineAmount(line);
		const covered = Math.min(amount, available);
		available -= covered;
		deductions += amount;
		byId.set(line.id, { id: line.id, kind: line.kind, amount, covered, uncovered: amount - covered, blocker });
	}
	const lines = input.lines.map((l) => byId.get(l.id)!);
	const coveredByDeposit = input.received - available;
	const uncovered = deductions - coveredByDeposit;
	const creditUsed = Math.min(credit, uncovered);
	const refundFromDeposit = available;
	const refundFromCredit = credit - creditUsed;
	const refund = refundFromDeposit + refundFromCredit;
	const claim = uncovered - creditUsed;
	if (input.alreadyRefunded > refundFromDeposit) {
		throw new SettlementError('SETTLEMENT_ALREADY_REFUNDED_EXCEEDS', 'Déjà restitué au-delà du montant à restituer.');
	}
	return {
		lines,
		received: input.received,
		deductions,
		coveredByDeposit,
		creditUsed,
		refund,
		refundFromDeposit,
		refundFromCredit,
		refundRemaining: refund - input.alreadyRefunded,
		claim,
		outcome: claim > 0 ? 'claim' : refund > 0 ? 'refund' : 'zero'
	};
}

// ---------------------------------------------------------------- clôture : mouvements en ajout seul

export type SettlementMovementType = 'retained' | 'applied_to_rent' | 'applied_to_debt' | 'refunded' | 'additional_claimed';

export interface SettlementMovement {
	type: SettlementMovementType;
	amount: Fcfa;
	lineId: string | null;
	/** Pour une imputation sur une échéance ou une dépense : l'encaissement interne « imputation sur caution » (D32). */
	target: { rentDueId: string } | { expenseId: string } | null;
	inspectionItemId: string | null;
	agreementId: string | null;
	documentId: string | null;
}

/**
 * Mouvements écrits à la clôture du décompte : une sortie par ligne couverte (sauf les mois déjà imputés avant le
 * départ), la restitution restante (`refunded`, détails saisis à l'enregistrement) et le complément réclamé. Le total
 * des sorties ne dépasse jamais la caution reçue (vérifié ici et par la base).
 */
export function settlementMovements(input: SettlementInput, result: SettlementResult = computeSettlement(input)): SettlementMovement[] {
	const out: SettlementMovement[] = [];
	const byId = new Map(input.lines.map((l) => [l.id, l]));
	for (const r of result.lines) {
		if (r.blocker || r.covered === 0) continue;
		const line = byId.get(r.id)!;
		if (line.kind === 'rent_by_agreement' && line.executed) continue;
		const base = { amount: r.covered, lineId: r.id, inspectionItemId: null, agreementId: null, documentId: null };
		switch (line.kind) {
			case 'repair':
				out.push({
					...base,
					type: 'retained',
					target: line.expenseId ? { expenseId: line.expenseId } : null,
					inspectionItemId: line.inspectionItemId,
					documentId: repairRetention(line).documentId
				});
				break;
			case 'rent_by_agreement':
				out.push({ ...base, type: 'applied_to_rent', target: { rentDueId: line.rentDueId }, agreementId: line.agreementId });
				break;
			case 'unpaid_rent':
				out.push({ ...base, type: 'applied_to_debt', target: { rentDueId: line.rentDueId } });
				break;
			case 'expense_claim':
			case 'utility_bill':
				out.push({ ...base, type: 'applied_to_debt', target: { expenseId: line.expenseId }, documentId: line.documentId });
				break;
		}
	}
	// La part du trop-perçu ne sort pas du compte de caution : elle se restitue par le registre des encaissements.
	const fromDeposit = result.refundFromDeposit - input.alreadyRefunded;
	if (fromDeposit > 0) out.push(movement('refunded', fromDeposit));
	if (result.claim > 0) out.push(movement('additional_claimed', result.claim));
	const outflows = out.filter((m) => m.type !== 'additional_claimed').reduce((s, m) => s + m.amount, 0);
	const executed = input.lines
		.filter((l): l is RentByAgreementLine => l.kind === 'rent_by_agreement' && l.executed)
		.reduce((s, l) => s + (result.lines.find((r) => r.id === l.id)?.covered ?? 0), 0);
	if (outflows + executed + input.alreadyRefunded > input.received) {
		throw new SettlementError('SETTLEMENT_INPUT_INVALID', 'Les sorties dépasseraient la caution reçue.');
	}
	return out;
}

function movement(type: SettlementMovementType, amount: Fcfa): SettlementMovement {
	return { type, amount, lineId: null, target: null, inspectionItemId: null, agreementId: null, documentId: null };
}

// ---------------------------------------------------------------- scénario B : ce qui restera pour les dégâts

export interface AgreementPlanInput {
	/** Caution détenue (reçue moins sorties déjà faites). */
	held: Fcfa;
	/** Part que l'organisation garde pour d'éventuels dégâts. */
	keep: Fcfa;
	/** Derniers mois proposés, dans l'ordre, avec leur reste dû. */
	months: readonly { periodStart: string; outstanding: Fcfa }[];
}

/**
 * Imputation des derniers loyers sur la caution (scénario B) : l'écran affiche, avant l'accord, ce que chaque mois
 * prendra et ce qui restera pour couvrir d'éventuels dégâts ; une partie peut être gardée (`keep`).
 */
export function agreementPlan(input: AgreementPlanInput): {
	months: { periodStart: string; applied: Fcfa; uncovered: Fcfa }[];
	applied: Fcfa;
	remainingForDamage: Fcfa;
	/** Toute la caution part en loyers : plus rien ne couvre les dégradations. */
	nothingLeft: boolean;
} {
	assertFcfa(input.held);
	assertFcfa(input.keep);
	const keep = Math.min(input.keep, input.held);
	let available = input.held - keep;
	const months = input.months.map((m) => {
		const applied = Math.min(m.outstanding, available);
		available -= applied;
		return { periodStart: m.periodStart, applied, uncovered: m.outstanding - applied };
	});
	const applied = months.reduce((s, m) => s + m.applied, 0);
	const remainingForDamage = input.held - applied;
	return { months, applied, remainingForDamage, nothingLeft: remainingForDamage === 0 };
}

// ---------------------------------------------------------------- délai de restitution

/** Échéance de la restitution : date de sortie + délai du bail (paramètre D24, 30 jours par défaut). */
export function refundDeadline(exitOn: string, depositRefundDays: number): string {
	return addDays(exitOn, depositRefundDays);
}

/** Jours avant le terme qui déclenchent l'alerte. */
export const REFUND_ALERT_DAYS = 7;

export type RefundAlert = 'none' | 'soon' | 'overdue';

/** Alerte du délai de restitution, tant que le décompte n'est pas clos. */
export function refundAlert(today: string, deadline: string, closed: boolean): RefundAlert {
	if (closed) return 'none';
	const left = daysBetween(today, deadline);
	if (left < 0) return 'overdue';
	return left <= REFUND_ALERT_DAYS ? 'soon' : 'none';
}

// ---------------------------------------------------------------- statuts du décompte

export const SETTLEMENT_STATUSES = ['draft', 'proposed', 'accepted', 'disputed', 'closed'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * - `draft` → `proposed` : le décompte est présenté au locataire (et au propriétaire s'il détient la caution).
 * - `proposed` → `draft` : correction avant acceptation.
 * - `proposed` → `accepted` | `disputed`.
 * - `accepted` → `closed` : mouvements écrits, restitution enregistrée.
 * - `disputed` → `closed` : l'issue (accord amiable ou décision de justice) est enregistrée avec son document ; la
 *   plateforme n'arbitre pas. La partie non contestée peut être restituée avant.
 */
export const SETTLEMENT_TRANSITIONS: Record<SettlementStatus, readonly SettlementStatus[]> = {
	draft: ['proposed'],
	proposed: ['draft', 'accepted', 'disputed'],
	accepted: ['closed'],
	disputed: ['closed'],
	closed: []
};

export function canTransitionSettlement(from: SettlementStatus, to: SettlementStatus): boolean {
	return SETTLEMENT_TRANSITIONS[from].includes(to);
}

export const DISPUTE_OUTCOMES = ['amicable_agreement', 'court_decision'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

/**
 * Restitution de la partie non contestée, sans attendre (prompt, §3) : ce qui reste à restituer même si chaque ligne
 * contestée était retenue en entier. Les lignes contestées sont déjà comptées au montant demandé.
 */
export function undisputedRefund(result: SettlementResult): Fcfa {
	return result.refundRemaining;
}
