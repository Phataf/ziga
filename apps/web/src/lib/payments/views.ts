/**
 * Encaissements et reçus lus dans la base locale (lot 09) : lignes SQLite transformées en vues des écrans, et ce que
 * l'appareil calcule lui-même, hors ligne, avec les fonctions pures de packages/shared :
 * - le montant proposé (reste exigible moins ce qui attend déjà d'être validé ou envoyé) ;
 * - l'imputation prévisionnelle et le contenu d'un reçu provisoire (le serveur refait le calcul et fait foi) ;
 * - les adresses du reçu (QR code de vérification, lien partagé) à partir des jetons créés sur l'appareil.
 * Fonctions pures, testées.
 */
import { forecastRentAllocation } from '@ziga/shared/allocation';
import { outstandingBalance, rentDueBalance } from '@ziga/shared/leases';
import type { MobileMoneyOperator, PaymentKind, PaymentMeans, PaymentPurpose, PaymentStatus } from '@ziga/shared/payments';
import {
	receiptDocument,
	type ReceiptDocument,
	type ReceiptOrganizationSnapshot,
	type ReceiptSnapshot,
	type ReceiptStatus
} from '@ziga/shared/receipts';
import { normalize } from '../owners/views';

type Row = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const int = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Table locale de l'appareil (PowerSync `localOnly`) : le reçu créé avec un encaissement, et ses deux jetons. */
export const RECEIPT_DRAFTS_TABLE = 'receipt_drafts';
export const RECEIPT_DRAFT_COLUMNS = {
	organization_id: 'text',
	payment_id: 'text',
	provisional_number: 'text',
	verification_token: 'text',
	share_token: 'text',
	created_at: 'text'
} as const;

/** Statut affiché : celui du serveur, ou « en attente d'envoi » tant que l'encaissement n'est pas synchronisé. */
export type LocalPaymentStatus = PaymentStatus | 'pending_upload';

export interface LocalPayment {
	id: string;
	kind: PaymentKind;
	leaseId: string;
	tenantId: string | null;
	purpose: PaymentPurpose;
	depositAccountId: string | null;
	amount: number;
	method: PaymentMeans;
	operator: MobileMoneyOperator | null;
	transactionReference: string | null;
	paidOn: string;
	status: LocalPaymentStatus;
	recordedBy: string | null;
	cancellationReason: string | null;
	createdAt: string | null;
}

export function toPayment(r: Row): LocalPayment {
	return {
		id: String(r.id),
		kind: (str(r.kind) ?? 'payment') as PaymentKind,
		leaseId: String(r.lease_id ?? ''),
		tenantId: str(r.tenant_id),
		purpose: (str(r.purpose) ?? 'rent') as PaymentPurpose,
		depositAccountId: str(r.deposit_account_id),
		amount: int(r.amount) ?? 0,
		method: (str(r.method) ?? 'cash') as PaymentMeans,
		operator: str(r.operator) as MobileMoneyOperator | null,
		transactionReference: str(r.transaction_reference),
		paidOn: String(r.paid_on ?? ''),
		// Saisi sur l'appareil : le serveur n'a pas encore décidé du statut (règle 6).
		status: (str(r.status) ?? 'pending_upload') as LocalPaymentStatus,
		recordedBy: str(r.recorded_by),
		cancellationReason: str(r.cancellation_reason),
		createdAt: str(r.created_at)
	};
}

export interface LocalReceipt {
	id: string;
	paymentId: string;
	status: ReceiptStatus;
	number: string | null;
	provisionalNumber: string;
	issuedOn: string | null;
	snapshot: ReceiptSnapshot | null;
}

export function toReceipt(r: Row): LocalReceipt {
	let snapshot: ReceiptSnapshot | null = null;
	if (typeof r.snapshot === 'string' && r.snapshot) {
		try {
			snapshot = JSON.parse(r.snapshot) as ReceiptSnapshot;
		} catch {
			snapshot = null;
		}
	}
	return {
		id: String(r.id),
		paymentId: String(r.payment_id ?? ''),
		status: (str(r.status) ?? 'provisional') as ReceiptStatus,
		number: str(r.number),
		provisionalNumber: String(r.provisional_number ?? ''),
		issuedOn: str(r.issued_on),
		snapshot
	};
}

export interface ReceiptDraft {
	id: string;
	paymentId: string;
	provisionalNumber: string;
	verificationToken: string;
	shareToken: string;
}

export function toDraft(r: Row): ReceiptDraft {
	return {
		id: String(r.id),
		paymentId: String(r.payment_id ?? ''),
		provisionalNumber: String(r.provisional_number ?? ''),
		verificationToken: String(r.verification_token ?? ''),
		shareToken: String(r.share_token ?? '')
	};
}

// ---------------------------------------------------------------- recherche du locataire

/** Un bail que l'on peut encaisser, avec ce qu'il faut pour le retrouver (nom, téléphone, unité). */
export interface PaymentTarget {
	leaseId: string;
	tenantId: string;
	tenantName: string;
	tenantPhone: string | null;
	unitLabel: string;
	propertyName: string;
	leaseStatus: string;
}

export function toTarget(r: Row): PaymentTarget {
	return {
		leaseId: String(r.id),
		tenantId: String(r.tenant_id ?? ''),
		tenantName: String(r.tenant_name ?? ''),
		tenantPhone: str(r.tenant_phone),
		unitLabel: String(r.unit_label ?? ''),
		propertyName: String(r.property_name ?? ''),
		leaseStatus: String(r.status ?? '')
	};
}

/** Recherche par nom (sans accents), par chiffres du téléphone, ou par unité et bien. */
export function searchTargets<T extends PaymentTarget>(targets: T[], query: string): T[] {
	// Ponctuation et tirets comptent comme des espaces : « wend panga » trouve « Wend-Panga ».
	const words = (text: string) =>
		normalize(text)
			.replace(/[^\p{L}\p{N}]+/gu, ' ')
			.trim();
	const q = words(query);
	if (!q) return targets;
	const digits = q.replace(/\D/g, '');
	return targets.filter(
		(t) =>
			words(t.tenantName).includes(q) ||
			words(`${t.propertyName} ${t.unitLabel}`).includes(q) ||
			(digits.length >= 2 && (t.tenantPhone ?? '').replace(/\D/g, '').includes(digits))
	);
}

// ---------------------------------------------------------------- montant proposé

export interface DueForScreen {
	id: string;
	dueOn: string;
	periodStart: string;
	periodEnd: string;
	amountDue: number;
	amountPaid: number;
	waived: boolean;
	isAdvance: boolean;
	overdueFrom?: string | null;
}

/** Encaissements de loyer pas encore imputés (en attente d'envoi, de validation ou de rapprochement). */
export function pendingRentAmount(payments: readonly LocalPayment[], leaseId: string): number {
	return payments
		.filter(
			(p) =>
				p.kind === 'payment' &&
				p.leaseId === leaseId &&
				p.purpose === 'rent' &&
				(p.status === 'pending_upload' || p.status === 'to_validate' || p.status === 'to_reconcile')
		)
		.reduce((s, p) => s + p.amount, 0);
}

/**
 * Montant pré-rempli : le reste exigible du bail, moins ce qui attend déjà d'être validé ou envoyé ; rien d'exigible,
 * la prochaine échéance ouverte (le locataire paie souvent d'avance).
 */
export function suggestedRentAmount(dues: readonly DueForScreen[], pending: number, today: string): number {
	const exigible = outstandingBalance(dues, today);
	if (exigible - pending > 0) return exigible - pending;
	const next = [...dues]
		.filter((d) => !d.waived && d.amountPaid < d.amountDue && d.dueOn > today)
		.sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1))[0];
	return next ? rentDueBalance(next) : 0;
}

// ---------------------------------------------------------------- reçu affiché par l'appareil

export interface LocalSnapshotInput {
	organization: ReceiptOrganizationSnapshot;
	tenantName: string;
	unit: { label: string; address: string | null };
	payment: Pick<LocalPayment, 'id' | 'purpose' | 'amount' | 'method' | 'operator' | 'transactionReference' | 'paidOn'>;
	/** Échéances du bail avant cet encaissement (imputation prévisionnelle). */
	dues: readonly DueForScreen[];
	deposit: {
		type: 'security_deposit' | 'utilities_guarantee';
		holder: 'organization' | 'owner' | 'third_party';
		remainingDue: number;
	} | null;
	collectedBy: string;
	today: string;
}

/**
 * Contenu d'un reçu provisoire, calculé sur l'appareil (le serveur imputera et numérotera à la confirmation) : mêmes
 * mentions que le reçu émis, imputation prévisionnelle par la même fonction que le serveur.
 */
export function localSnapshot(input: LocalSnapshotInput): ReceiptSnapshot {
	const base = {
		organization: input.organization,
		tenant: { fullName: input.tenantName },
		unit: input.unit,
		purpose: input.payment.purpose,
		amount: input.payment.amount,
		method: input.payment.method,
		operator: input.payment.operator,
		transactionReference: input.payment.transactionReference,
		paidOn: input.payment.paidOn,
		collectedBy: input.collectedBy
	};
	if (input.payment.purpose === 'deposit' && input.deposit) {
		return {
			...base,
			periods: [],
			credit: 0,
			deposit: { type: input.deposit.type, holder: input.deposit.holder === 'owner' ? 'owner' : 'organization' },
			balanceDue: Math.max(0, input.deposit.remainingDue - input.payment.amount)
		};
	}
	const { lines, credit } = forecastRentAllocation(input.payment.amount, input.dues);
	const byId = new Map(input.dues.map((d) => [d.id, d]));
	const after = input.dues.map((d) => {
		const paid = lines.filter((l) => l.targetId === d.id).reduce((s, l) => s + l.amount, 0);
		return { ...d, amountPaid: d.amountPaid + paid };
	});
	return {
		...base,
		periods: lines
			.filter((l) => l.target === 'rent_due')
			.map((l) => {
				const d = byId.get(l.targetId!)!;
				return { start: d.periodStart, end: d.periodEnd, amount: l.amount, isAdvance: d.isAdvance };
			}),
		credit,
		deposit: null,
		balanceDue: outstandingBalance(after, input.today)
	};
}

/** Adresse de la page de vérification (QR code). */
export function verificationUrl(origin: string, token: string): string {
	return `${origin.replace(/\/$/, '')}/r/${token}`;
}

/** Adresse du reçu partagé (WhatsApp, SMS). */
export function shareUrl(origin: string, token: string): string {
	return `${origin.replace(/\/$/, '')}/recu/${token}`;
}

/** Document du reçu affiché : le reçu émis (copie figée) s'il existe, sinon le reçu provisoire de l'appareil. */
export function receiptToShow(
	receipt: LocalReceipt | null,
	draft: ReceiptDraft | null,
	local: ReceiptSnapshot | null,
	origin: string
): ReceiptDocument | null {
	const snapshot = receipt?.snapshot ?? local;
	if (!snapshot) return null;
	return receiptDocument({
		snapshot,
		status: receipt?.status ?? 'provisional',
		number: receipt?.number ?? null,
		provisionalNumber: receipt?.provisionalNumber ?? draft?.provisionalNumber ?? '',
		issuedOn: receipt?.issuedOn ?? null,
		verificationUrl: draft ? verificationUrl(origin, draft.verificationToken) : null
	});
}

/** Texte du partage (WhatsApp ou SMS) : le lien du reçu et l'invitation à retrouver son historique. */
export function shareText(doc: Pick<ReceiptDocument, 'title' | 'number'>, organizationName: string, url: string): string {
	return `${doc.title} ${doc.number} — ${organizationName}\n${url}`;
}

/** Lien WhatsApp pré-rempli vers le numéro du locataire (E.164 sans « + »), ou sans destinataire. */
export function whatsappLink(phoneE164: string | null, text: string): string {
	const to = phoneE164 ? phoneE164.replace(/\D/g, '') : '';
	return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
