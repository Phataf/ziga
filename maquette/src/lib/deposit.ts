/**
 * Caution et sortie du locataire (D15, CLAUDE.md règle 14) : fonctions pures.
 *
 * - Un compte de caution par bail, en ajout seul.
 * - Un seul décompte de sortie ; les trois scénarios en sont des variantes :
 *   A. restitution après réparations ; B. caution imputée sur les derniers loyers (accord écrit et daté
 *   avant les mois concernés) ; C. réparations faites par le locataire (accord, puis contre-visite).
 * - Aucune retenue sans ligne d'état des lieux « imputable au locataire », montant et justificatif.
 * - Le total des sorties ne dépasse jamais la caution reçue ; le reste devient un complément à réclamer.
 */
import { formatFCFA, formatMonth } from './format';
import type { DepositMovement } from './types';

/** Constat par élément de l'état des lieux de sortie, comparé à l'état d'entrée (articles 8, 9 et 20). */
export type Finding = 'as_entry' | 'normal_wear' | 'tenant' | 'owner';

export const findingLabel: Record<Finding, string> = {
	as_entry: 'Conforme à l’entrée',
	normal_wear: 'Usure normale',
	tenant: 'Imputable au locataire',
	owner: 'À la charge du propriétaire'
};

export interface InspectionItem {
	id: string;
	room: string;
	element: string;
	/** État constaté à l'entrée, précis (jamais « bon état »). */
	entry: string;
	finding: Finding;
	note?: string;
	/** Montant de la réparation (devis puis facture), en FCFA entiers. */
	amount?: number;
	/** Justificatif joint : devis, facture, photo datée. */
	proof?: string;
	/** Qui fait la réparation : le propriétaire (via l'agence) ou le locataire lui-même. */
	repairedBy?: 'owner' | 'tenant';
}

/** Circuit d'accord : proposition, acceptation ou refus motivé, horodatage (docs/UX.md §10). */
export interface Agreement {
	kind: 'rent_offset' | 'tenant_repair';
	proposedBy: 'tenant' | 'agency';
	proposedOn: string;
	text: string;
	status: 'proposed' | 'accepted' | 'refused';
	decidedOn?: string;
	decidedBy?: string;
	reason?: string;
}

export type Variant = 'refund' | 'rent_offset' | 'tenant_repair';

export const variantLabel: Record<Variant, string> = {
	refund: 'Restitution après réparations',
	rent_offset: 'Caution imputée sur les derniers loyers',
	tenant_repair: 'Réparations faites par le locataire'
};

export interface RentOffset {
	period: string;
	amount: number;
}

export interface SettlementInput {
	deposit: number;
	items: InspectionItem[];
	/** Loyers et charges échus et impayés au départ. */
	unpaid: RentOffset[];
	/** Mois couverts par la caution, sur accord écrit (variante B). */
	offsets?: RentOffset[];
	offsetAgreement?: Agreement;
	/** Réparations faites par le locataire (variante C). */
	repairAgreement?: Agreement;
	recheckDone?: boolean;
}

export type LineKind = 'retention' | 'unpaid_rent' | 'rent_offset' | 'tenant_repaired';

export interface SettlementLine {
	kind: LineKind;
	label: string;
	amount: number;
	itemId?: string;
	proof?: string;
	period?: string;
}

export interface Settlement {
	deposit: number;
	lines: SettlementLine[];
	/** Somme de toutes les lignes (peut dépasser la caution). */
	total: number;
	/** Ce qui sort réellement du compte de caution : jamais plus que la caution. */
	out: number;
	refund: number;
	claim: number;
	/** Retenues ou imputations refusées, avec la raison. */
	errors: string[];
}

function isAmount(n: number | undefined): n is number {
	return n !== undefined && Number.isSafeInteger(n) && n > 0;
}

/** Raisons pour lesquelles une ligne d'état des lieux ne peut pas fonder une retenue. */
export function retentionErrors(item: InspectionItem): string[] {
	const where = `${item.room} — ${item.element}`;
	const errors: string[] = [];
	if (item.finding !== 'tenant') {
		errors.push(`${where} : pas de retenue possible, le constat est « ${findingLabel[item.finding].toLowerCase()} ».`);
		return errors;
	}
	if (!isAmount(item.amount)) errors.push(`${where} : montant de la réparation manquant.`);
	if (!item.proof?.trim()) errors.push(`${where} : justificatif manquant (devis, facture ou photo).`);
	return errors;
}

/** Une imputation sur loyer n'est valable que sur accord accepté, daté avant le mois concerné. */
export function offsetErrors(offset: RentOffset, agreement: Agreement | undefined): string[] {
	const label = `Loyer de ${formatMonth(offset.period)}`;
	if (!agreement || agreement.kind !== 'rent_offset') return [`${label} : imputation impossible sans accord écrit.`];
	if (agreement.status !== 'accepted') return [`${label} : l’accord n’est pas encore accepté.`];
	if (agreement.proposedOn >= `${offset.period}-01`) return [`${label} : l’accord doit être daté avant le mois concerné.`];
	return [];
}

/** Décompte de sortie unique : caution reçue, moins les lignes justifiées. */
export function computeSettlement(input: SettlementInput): Settlement {
	const lines: SettlementLine[] = [];
	const errors: string[] = [];
	const repairAccepted = input.repairAgreement?.kind === 'tenant_repair' && input.repairAgreement.status === 'accepted';

	for (const offset of input.offsets ?? []) {
		const e = offsetErrors(offset, input.offsetAgreement);
		if (e.length) errors.push(...e);
		else lines.push({ kind: 'rent_offset', label: `Imputation sur le loyer de ${formatMonth(offset.period)}`, amount: offset.amount, period: offset.period });
	}
	for (const due of input.unpaid) {
		lines.push({ kind: 'unpaid_rent', label: `Loyer impayé de ${formatMonth(due.period)}`, amount: due.amount, period: due.period });
	}
	for (const item of input.items) {
		if (item.finding !== 'tenant') {
			// Usure normale ou défaut du propriétaire : jamais à la charge du locataire.
			if (isAmount(item.amount)) errors.push(...retentionErrors(item));
			continue;
		}
		const where = `${item.room} — ${item.element}`;
		if (item.repairedBy === 'tenant' && repairAccepted && input.recheckDone) {
			lines.push({ kind: 'tenant_repaired', label: `${where} : réparé par le locataire (contre-visite faite)`, amount: 0, itemId: item.id });
			continue;
		}
		const e = retentionErrors(item);
		if (e.length) {
			errors.push(...e);
			continue;
		}
		lines.push({ kind: 'retention', label: `${where} : ${item.note ?? 'réparation'}`, amount: item.amount!, itemId: item.id, proof: item.proof });
	}

	const total = lines.reduce((s, l) => s + l.amount, 0);
	const out = Math.min(total, input.deposit);
	return { deposit: input.deposit, lines, total, out, refund: input.deposit - out, claim: total - out, errors };
}

/** Ce qu'il restera de la caution pour couvrir les dégâts si elle paie les derniers loyers (variante B). */
export function remainingAfterOffsets(deposit: number, offsets: RentOffset[]): number {
	return Math.max(0, deposit - offsets.reduce((s, o) => s + o.amount, 0));
}

/**
 * Mouvements à ajouter au compte de caution quand le décompte est validé.
 * Les sorties s'arrêtent à la caution reçue ; le dépassement devient un complément réclamé.
 */
export function settlementMovements(leaseId: string, settlement: Settlement, date: string): DepositMovement[] {
	const movements: DepositMovement[] = [];
	let left = settlement.deposit;
	settlement.lines.forEach((line, i) => {
		if (line.kind === 'tenant_repaired') return;
		const amount = Math.min(line.amount, left);
		left -= amount;
		if (amount > 0) {
			movements.push({
				id: `${leaseId}-mvt-${i + 1}`,
				leaseId,
				date,
				kind: line.kind === 'retention' ? 'retention' : 'rent_offset',
				amount,
				label: line.label,
				proof: line.proof,
				inspectionItemId: line.itemId
			});
		}
	});
	if (settlement.refund > 0) {
		movements.push({ id: `${leaseId}-mvt-refund`, leaseId, date, kind: 'refund', amount: settlement.refund, label: 'Restitution au locataire' });
	}
	if (settlement.claim > 0) {
		movements.push({ id: `${leaseId}-mvt-claim`, leaseId, date, kind: 'claim', amount: settlement.claim, label: 'Complément réclamé au locataire' });
	}
	return movements;
}

/** Solde du compte de caution : versements moins sorties (les compléments réclamés n'y entrent pas). */
export function depositBalance(movements: DepositMovement[]): number {
	return movements.reduce((s, m) => {
		if (m.kind === 'received') return s + m.amount;
		if (m.kind === 'claim' || m.kind === 'holder_change') return s;
		return s - m.amount;
	}, 0);
}

/** Plafond légal de deux mois de loyer (article 26, lecture à confirmer) : avertissement journalisé, pas de blocage. */
export function depositWarning(deposit: number, rent: number): string | undefined {
	if (rent > 0 && deposit > rent * 2) {
		return `Caution de ${formatFCFA(deposit)} : plus de deux mois de loyer (${formatFCFA(rent * 2)}). Cet avertissement est journalisé.`;
	}
	return undefined;
}

/** Fin du préavis : trois mois pour un bail à durée indéterminée, deux mois pour un bail à durée déterminée quitté avant terme. */
export function noticeEffectiveDate(givenOn: string, term: 'open' | 'fixed' = 'open'): string {
	const months = term === 'open' ? 3 : 2;
	const y = +givenOn.slice(0, 4);
	const m0 = +givenOn.slice(5, 7) - 1 + months;
	const day = +givenOn.slice(8, 10);
	const last = new Date(y, m0 + 1, 0).getDate();
	const d = new Date(y, m0, Math.min(day, last));
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const movementLabel: Record<DepositMovement['kind'], string> = {
	received: 'Versement reçu',
	retention: 'Retenue pour réparation',
	rent_offset: 'Imputation sur loyer',
	refund: 'Restitution',
	claim: 'Complément réclamé',
	holder_change: 'Changement de détenteur'
};
