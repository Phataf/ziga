/**
 * Sortie du locataire (lot 10 bis, étape 4) lue dans la base locale : lignes SQLite transformées en vues des écrans.
 * Les règles restent celles de `packages/shared` (tenant-exit.ts, deposit-settlement.ts, exit-schemas.ts) ; ce module
 * ne fait que lire et présenter. Fonctions pures, testées.
 */
import type { InspectionFinding, SettlementLineKind, SettlementStatus } from '@ziga/shared/deposit-settlement';
import { inspectionCheckboxLabel, inspectionScanLabel } from '@ziga/shared/exit-schemas';
import {
	DEFAULT_INSPECTION_ELEMENTS,
	inspectionItemBlocker,
	type InspectionItemBlocker,
	type InspectionType
} from '@ziga/shared/tenant-exit';

type Row = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const int = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const bool = (v: unknown) => v === 1 || v === true || v === '1';

/** Un tableau de dates répliqué par PowerSync : JSON (`["2026-11-01"]`) ou littéral PostgreSQL (`{2026-11-01}`). */
export function parseDateArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String);
	const s = str(v);
	if (!s) return [];
	if (s.startsWith('[')) {
		try {
			const parsed = JSON.parse(s) as unknown;
			return Array.isArray(parsed) ? parsed.map(String) : [];
		} catch {
			return [];
		}
	}
	return s
		.replace(/^\{|\}$/g, '')
		.split(',')
		.map((x) => x.trim().replace(/^"|"$/g, ''))
		.filter(Boolean);
}

export interface LocalNotice {
	id: string;
	leaseId: string;
	origin: 'tenant' | 'lessor';
	status: 'requested' | 'recorded' | 'declined';
	deliveryMode: string | null;
	proofDocumentId: string | null;
	notifiedOn: string;
	plannedExitOn: string;
	reducedNotice: boolean;
	noticeMonths: number | null;
	noticeEndsOn: string | null;
	rentEndsOn: string | null;
	/** Absente pour l'agent de terrain (jamais synchronisée vers lui). */
	indemnity: number | null;
	reason: string | null;
}

export function toNotice(r: Row): LocalNotice {
	return {
		id: String(r.id),
		leaseId: String(r.lease_id),
		origin: r.origin === 'lessor' ? 'lessor' : 'tenant',
		status: (str(r.status) ?? 'recorded') as LocalNotice['status'],
		deliveryMode: str(r.delivery_mode),
		proofDocumentId: str(r.proof_document_id),
		notifiedOn: String(r.notified_on ?? ''),
		plannedExitOn: String(r.planned_exit_on ?? ''),
		reducedNotice: bool(r.reduced_notice),
		noticeMonths: int(r.notice_months),
		noticeEndsOn: str(r.notice_ends_on),
		rentEndsOn: str(r.rent_ends_on),
		indemnity: int(r.early_termination_indemnity),
		reason: str(r.reason)
	};
}

export interface LocalInspection {
	id: string;
	leaseId: string;
	type: InspectionType;
	/** `draft` tant que le serveur n'a pas reçu les deux cases (ou le scan). */
	status: 'draft' | 'signed_both' | 'disputed';
	inspectedOn: string;
	organizationSignedAt: string | null;
	organizationSignedBy: string | null;
	tenantSignedAt: string | null;
	tenantSignedRecordedBy: string | null;
	scanDocumentId: string | null;
	organizationObservations: string | null;
	tenantObservations: string | null;
	disputedAt: string | null;
	disputeOutcome: string | null;
	createdBy: string | null;
}

export function toInspection(r: Row): LocalInspection {
	return {
		id: String(r.id),
		leaseId: String(r.lease_id),
		type: r.type === 'entry' ? 'entry' : 'exit',
		status: (str(r.status) ?? 'draft') as LocalInspection['status'],
		inspectedOn: String(r.inspected_on ?? ''),
		organizationSignedAt: str(r.organization_signed_at),
		organizationSignedBy: str(r.organization_signed_by),
		tenantSignedAt: str(r.tenant_signed_at),
		tenantSignedRecordedBy: str(r.tenant_signed_recorded_by),
		scanDocumentId: str(r.scan_document_id),
		organizationObservations: str(r.organization_observations),
		tenantObservations: str(r.tenant_observations),
		disputedAt: str(r.disputed_at),
		disputeOutcome: str(r.dispute_outcome),
		createdBy: str(r.created_by)
	};
}

export interface LocalItem {
	id: string;
	inspectionId: string;
	room: string;
	element: string;
	position: number;
	description: string;
	finding: InspectionFinding | null;
	entryItemId: string | null;
}

export function toItem(r: Row): LocalItem {
	return {
		id: String(r.id),
		inspectionId: String(r.inspection_id),
		room: String(r.room ?? ''),
		element: String(r.element ?? ''),
		position: int(r.position) ?? 0,
		description: String(r.description ?? ''),
		finding: (str(r.finding) as InspectionFinding | null) ?? null,
		entryItemId: str(r.entry_item_id)
	};
}

/** Libellé d'un élément du catalogue (clé enregistrée) ; un élément libre s'affiche tel quel. */
const ELEMENT_LABELS = new Map<string, string>(DEFAULT_INSPECTION_ELEMENTS.map((e) => [e.key, e.label]));
export function elementLabel(element: string): string {
	return ELEMENT_LABELS.get(element) ?? element;
}

/** Pièces dans l'ordre de leur première ligne. */
export function roomsOf(items: readonly LocalItem[]): string[] {
	const rooms: string[] = [];
	for (const i of [...items].sort((a, b) => a.position - b.position)) if (!rooms.includes(i.room)) rooms.push(i.room);
	return rooms;
}

/** Ce qui manque à chaque ligne pour signer (texte vague, constat absent à la sortie) : la même règle que le serveur. */
export function itemBlockers(type: InspectionType, items: readonly LocalItem[]): Map<string, InspectionItemBlocker> {
	const out = new Map<string, InspectionItemBlocker>();
	for (const i of items) {
		const b = inspectionItemBlocker(type, i);
		if (b) out.set(i.id, b);
	}
	return out;
}

export interface SignatureView {
	organization: string | null;
	tenant: string | null;
	scan: string | null;
	/** Les deux cases cochées (ou le scan) : l'état des lieux est figé dès que le serveur l'a reçu. */
	complete: boolean;
}

/**
 * Point 5 du porteur : « Case cochée par … le … sur l'appareil de … », jamais une signature électronique. Une case
 * cochée sur cet appareil et pas encore reçue par le serveur porte la personne connectée.
 */
export function signatureView(
	i: LocalInspection,
	ctx: {
		names: ReadonlyMap<string, string>;
		tenantName: string;
		me: { id: string; name: string };
		scanUploader?: { name: string; at: string };
	}
): SignatureView {
	const name = (id: string | null) => (id ? (ctx.names.get(id) ?? (id === ctx.me.id ? ctx.me.name : '—')) : ctx.me.name);
	const organization = i.organizationSignedAt
		? inspectionCheckboxLabel({
				signerName: name(i.organizationSignedBy),
				signedAt: i.organizationSignedAt,
				deviceOwnerName: name(i.organizationSignedBy)
			})
		: null;
	const tenant = i.tenantSignedAt
		? inspectionCheckboxLabel({ signerName: ctx.tenantName, signedAt: i.tenantSignedAt, deviceOwnerName: name(i.tenantSignedRecordedBy) })
		: null;
	const scan =
		i.scanDocumentId && ctx.scanUploader
			? inspectionScanLabel({ uploaderName: ctx.scanUploader.name, uploadedAt: ctx.scanUploader.at })
			: null;
	return { organization, tenant, scan, complete: !!i.scanDocumentId || (!!organization && !!tenant) };
}

export interface LocalRepair {
	id: string;
	inspectionItemId: string;
	leaseId: string;
	description: string;
	performedBy: 'organization' | 'tenant' | 'owner';
	status: 'planned' | 'done' | 'verified';
	estimatedAmount: number | null;
	quoteDocumentId: string | null;
	actualAmount: number | null;
	invoiceDocumentId: string | null;
	agreementId: string | null;
	expenseId: string | null;
	doneOn: string | null;
	verifiedOn: string | null;
}

export function toRepair(r: Row): LocalRepair {
	return {
		id: String(r.id),
		inspectionItemId: String(r.inspection_item_id),
		leaseId: String(r.lease_id),
		description: String(r.description ?? ''),
		performedBy: (str(r.performed_by) ?? 'organization') as LocalRepair['performedBy'],
		status: (str(r.status) ?? 'planned') as LocalRepair['status'],
		estimatedAmount: int(r.estimated_amount),
		quoteDocumentId: str(r.quote_document_id),
		actualAmount: int(r.actual_amount),
		invoiceDocumentId: str(r.invoice_document_id),
		agreementId: str(r.agreement_id),
		expenseId: str(r.expense_id),
		doneOn: str(r.done_on),
		verifiedOn: str(r.verified_on)
	};
}

export interface LocalAgreement {
	id: string;
	leaseId: string;
	type: 'deposit_applied_to_rent' | 'tenant_self_repair' | 'settlement_dispute';
	status: 'proposed' | 'accepted' | 'refused';
	proposedBy: string;
	proposedOn: string;
	description: string | null;
	months: string[];
	keptAmount: number;
	decidedByParty: string | null;
	decidedOn: string | null;
	refusalReason: string | null;
	documentId: string | null;
}

export function toAgreement(r: Row): LocalAgreement {
	return {
		id: String(r.id),
		leaseId: String(r.lease_id),
		type: (str(r.type) ?? 'deposit_applied_to_rent') as LocalAgreement['type'],
		status: (str(r.status) ?? 'proposed') as LocalAgreement['status'],
		proposedBy: String(r.proposed_by ?? ''),
		proposedOn: String(r.proposed_on ?? ''),
		description: str(r.description),
		months: parseDateArray(r.months),
		keptAmount: int(r.kept_amount) ?? 0,
		decidedByParty: str(r.decided_by_party),
		decidedOn: str(r.decided_on),
		refusalReason: str(r.refusal_reason),
		documentId: str(r.document_id)
	};
}

export interface LocalSettlement {
	id: string;
	depositAccountId: string;
	leaseId: string;
	status: SettlementStatus;
	revision: number;
	exitOn: string | null;
	refundDeadline: string | null;
	refundAlert: 'soon' | 'overdue' | null;
	received: number;
	credit: number;
	deductions: number;
	refund: number;
	claim: number;
	outcome: 'refund' | 'claim' | 'zero';
	tenantObservations: string | null;
	organizationObservations: string | null;
	disputeOutcome: string | null;
	closedAt: string | null;
}

export function toSettlement(r: Row): LocalSettlement {
	const alert = str(r.refund_alert);
	return {
		id: String(r.id),
		depositAccountId: String(r.deposit_account_id),
		leaseId: String(r.lease_id),
		status: (str(r.status) ?? 'draft') as SettlementStatus,
		revision: int(r.revision) ?? 1,
		exitOn: str(r.exit_on),
		refundDeadline: str(r.refund_deadline),
		refundAlert: alert === 'soon' || alert === 'overdue' ? alert : null,
		received: int(r.received) ?? 0,
		credit: int(r.credit) ?? 0,
		deductions: int(r.deductions) ?? 0,
		refund: int(r.refund) ?? 0,
		claim: int(r.claim) ?? 0,
		outcome: (str(r.outcome) ?? 'refund') as LocalSettlement['outcome'],
		tenantObservations: str(r.tenant_observations),
		organizationObservations: str(r.organization_observations),
		disputeOutcome: str(r.dispute_outcome),
		closedAt: str(r.closed_at)
	};
}

export interface LocalLine {
	id: string;
	settlementId: string;
	revision: number;
	position: number;
	kind: SettlementLineKind;
	amount: number;
	covered: number;
	uncovered: number;
	/** Refus nommé : la ligne n'est pas retenue (règle 14). */
	blocker: string | null;
	inspectionItemId: string | null;
	repairId: string | null;
	rentDueId: string | null;
	expenseId: string | null;
	agreementId: string | null;
	documentId: string | null;
}

export function toLine(r: Row): LocalLine {
	return {
		id: String(r.id),
		settlementId: String(r.settlement_id),
		revision: int(r.revision) ?? 1,
		position: int(r.position) ?? 0,
		kind: String(r.kind) as SettlementLineKind,
		amount: int(r.amount) ?? 0,
		covered: int(r.covered) ?? 0,
		uncovered: int(r.uncovered) ?? 0,
		blocker: str(r.blocker),
		inspectionItemId: str(r.inspection_item_id),
		repairId: str(r.repair_id),
		rentDueId: str(r.rent_due_id),
		expenseId: str(r.expense_id),
		agreementId: str(r.agreement_id),
		documentId: str(r.document_id)
	};
}

/** Lignes de la révision en cours du décompte, dans leur ordre. */
export function currentLines(s: LocalSettlement, lines: readonly LocalLine[]): LocalLine[] {
	return lines.filter((l) => l.settlementId === s.id && l.revision === s.revision).sort((a, b) => a.position - b.position);
}

/**
 * Justificatif d'une ligne (point 3 du porteur) : le document qui la fonde (facture, sinon devis ; dépense ; accord
 * écrit), ou ce qui manque (le refus nommé du serveur). Une ligne refusée n'est jamais retenue.
 */
export function lineProof(
	line: LocalLine,
	ctx: { repairs: ReadonlyMap<string, LocalRepair>; agreements: ReadonlyMap<string, LocalAgreement> }
): { documentId: string | null; missing: string | null } {
	if (line.blocker) return { documentId: null, missing: line.blocker };
	if (line.kind === 'repair' && line.repairId) {
		const r = ctx.repairs.get(line.repairId);
		return { documentId: r?.invoiceDocumentId ?? r?.quoteDocumentId ?? line.documentId, missing: null };
	}
	if (line.kind === 'rent_by_agreement' && line.agreementId) {
		return { documentId: ctx.agreements.get(line.agreementId)?.documentId ?? line.documentId, missing: null };
	}
	return { documentId: line.documentId, missing: null };
}

/** Étape d'une sortie, pour la liste : préavis, état des lieux, décompte, restitution, close. */
export type ExitStage = 'notice' | 'inspection' | 'settlement' | 'disputed' | 'closed';

export function exitStage(ctx: { exitInspection: LocalInspection | null; settlement: LocalSettlement | null }): ExitStage {
	if (ctx.settlement?.status === 'closed') return 'closed';
	if (ctx.settlement?.status === 'disputed' || ctx.exitInspection?.status === 'disputed') return 'disputed';
	if (ctx.settlement) return 'settlement';
	if (ctx.exitInspection) return 'inspection';
	return 'notice';
}

/**
 * Éléments proposés en ajoutant une pièce (aide à la saisie, comme le catalogue : il dit quoi regarder, jamais qui
 * paie). Une pièce hors liste reçoit les éléments communs ; chaque élément se retire ou s'ajoute à la main.
 */
const COMMON_ELEMENTS = ['door', 'walls_paint', 'floor', 'switches_outlets', 'lights'] as const;
const ROOM_ELEMENTS: Record<string, readonly string[]> = {
	Salon: [...COMMON_ELEMENTS, 'windows', 'fan_ac'],
	Chambre: [...COMMON_ELEMENTS, 'windows', 'cupboards', 'mosquito_nets'],
	Cuisine: [...COMMON_ELEMENTS, 'sink', 'taps', 'cupboards', 'drains'],
	'Douche et WC': ['door', 'walls_paint', 'floor', 'lights', 'shower', 'toilet', 'taps', 'drains'],
	Couloir: ['door', 'walls_paint', 'floor', 'lights'],
	Cour: ['door', 'floor', 'drains'],
	Extérieur: ['door', 'keys_locks', 'walls_paint']
};

export function roomTemplate(room: string): string[] {
	return [...(ROOM_ELEMENTS[room] ?? COMMON_ELEMENTS)];
}
