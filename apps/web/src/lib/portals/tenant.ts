/**
 * Espace du locataire (lot 10 ter, étape 3c) : vues des réponses de `/me/portal/tenant/*`, lues en ligne, toutes
 * organisations confondues. Fonctions pures, testées ; les écrans ne font qu'afficher.
 */

interface Org {
	organizationId: string;
	organizationName: string;
	organizationType: 'agency' | 'landlord';
	organizationPhone: string;
}

export interface TenantHome extends Org {
	leaseId: string;
	status: 'active' | 'notice';
	unitLabel: string | null;
	propertyName: string | null;
	rent: number;
	charges: number;
	balance: number;
	nextDue: { id: string; dueOn: string; remaining: number } | null;
	directPayment: { enabled: boolean; reason: string | null };
}

export type ContractGroup = 'in_force' | 'to_sign' | 'ended';

export interface TenantContract extends Org {
	leaseId: string;
	group: ContractGroup;
	leaseStatus: string;
	contractStatus: string | null;
	signed: boolean;
	amendments: { id: string; status: string }[];
	unitLabel: string | null;
	propertyName: string | null;
	lessorType: string;
	lessorName: string;
	startsOn: string;
	endsOn: string | null;
	exitOn: string | null;
	rent: number;
	charges: number;
	deposit: { agreedAmount: number; holder: string; holderName: string | null } | null;
	nextDueOn: string | null;
}

export interface TenantDocument extends Org {
	id: string;
	type: string;
	fileName: string;
	leaseId: string | null;
	activatedAt: string | null;
}

export interface SettlementLine {
	id: string;
	kind: string;
	amount: number;
	covered: number;
	uncovered: number;
	documentId: string | null;
}

export type TenantSettlement =
	| { id: string; status: 'in_correction' }
	| {
			id: string;
			status: 'proposed' | 'accepted' | 'disputed' | 'closed';
			exitOn: string;
			refundDeadline: string | null;
			received: number;
			deductions: number;
			refund: number;
			claim: number;
			outcome: string | null;
			tenantObservations: string | null;
			organizationObservations: string | null;
			lines: SettlementLine[];
	  };

export interface TenantDeposit extends Org {
	leaseId: string;
	id: string;
	agreedAmount: number;
	holder: string;
	holderName: string | null;
	status: string;
	settlement: TenantSettlement | null;
}

export interface TenantRequest extends Org {
	id: string;
	leaseId: string;
	title: string;
	description: string;
	status: 'received' | 'planned' | 'done';
	plannedOn: string | null;
	statusNote: string | null;
	createdAt: string;
	doneAt: string | null;
}

export type HistoryItem = Org & { kind: 'lease' | 'rent_due' | 'receipt' | 'deposit'; id: string; date: string } & Record<string, unknown>;

export interface HistoryReceipt extends Org {
	kind: 'receipt';
	id: string;
	date: string;
	leaseId: string;
	purpose: string;
	number: string | null;
	status: 'provisional' | 'valid' | 'cancelled';
	paidOn: string;
	amount: number;
	hasPdf: boolean;
}

const GROUP_ORDER: ContractGroup[] = ['to_sign', 'in_force', 'ended'];

/** Contrats par groupe : à signer d'abord, puis en vigueur, puis terminés (le plus récent d'abord dans chaque groupe). */
export function contractGroups(contracts: readonly TenantContract[]): { group: ContractGroup; contracts: TenantContract[] }[] {
	return GROUP_ORDER.map((group) => ({
		group,
		contracts: contracts.filter((c) => c.group === group).sort((a, b) => (a.startsOn < b.startsOn ? 1 : -1))
	})).filter((g) => g.contracts.length > 0);
}

/** Reçus d'une page d'historique (chronologie de toutes les organisations). */
export function receiptsOf(items: readonly HistoryItem[]): HistoryReceipt[] {
	return items.filter((i): i is HistoryItem & HistoryReceipt => i.kind === 'receipt');
}

/** Une page d'historique ajoutée aux précédentes, sans doublon (même organisation, même élément). */
export function appendPage(previous: readonly HistoryItem[], page: readonly HistoryItem[]): HistoryItem[] {
	const seen = new Set(previous.map((i) => `${i.organizationId}|${i.kind}|${i.id}`));
	return [...previous, ...page.filter((i) => !seen.has(`${i.organizationId}|${i.kind}|${i.id}`))];
}

/** Baux pour lesquels une demande de préavis est possible : en vigueur (la base refuse les autres). */
export function noticeCandidates(homes: readonly TenantHome[]): TenantHome[] {
	return homes.filter((h) => h.status === 'active');
}

/** Le locataire peut formuler une observation (désaccord) tant que le décompte est proposé. */
export function canObserve(s: TenantSettlement | null): boolean {
	return s?.status === 'proposed';
}

/** Libellé d'un logement : « Unité · Bien » ; ce qui manque est omis. */
export function placeLabel(p: { unitLabel: string | null; propertyName: string | null }): string {
	return [p.unitLabel, p.propertyName].filter(Boolean).join(' · ');
}

/** Signalements, les ouverts d'abord (reçu, planifié), puis les faits ; le plus récent d'abord. */
export function sortRequests(requests: readonly TenantRequest[]): TenantRequest[] {
	const rank = { received: 0, planned: 0, done: 1 } as const;
	return [...requests].sort((a, b) => rank[a.status] - rank[b.status] || (a.createdAt < b.createdAt ? 1 : -1));
}
