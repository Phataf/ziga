/**
 * Encaissements, imputations et reçus (lot 09). Règles de CLAUDE.md : montants en entiers FCFA (2) ; ajout seul et
 * contre-écriture (3) ; journal (4) ; confirmé seulement sur preuve (6) ; numérotation par le serveur (9) ; désactiver
 * la fonctionnalité ne supprime rien (10). Les règles pures sont dans packages/shared (payments.ts, allocation.ts,
 * receipts.ts) ; la base les applique en dernier rempart (migration 0015).
 *
 * - Saisie : en ligne (route) ou depuis l'appareil (synchronisation), même chemin. Le statut vient du prestataire
 *   (`manual` : initialPaymentStatus), jamais de l'appareil. Le reçu naît avec l'encaissement, provisoire.
 * - Confirmation (à la saisie par la direction ou la gestion pour des espèces, ou par validation) : imputation par le
 *   serveur (les échéances les plus anciennes d'abord, le reste en crédit du bail), numéro attribué par la base, copie
 *   figée des données (D29), PDF en tâche de fond.
 * - Annulation (directeur) : contre-écriture, imputations inverses (le crédit déjà imputé sur une échéance suivante
 *   compris), reçu « ANNULÉ », PDF régénéré.
 * - Crédit du bail : imputé sur chaque nouvelle échéance (événement du module leases).
 */
import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
	allocateDepositPayment,
	allocateRentPayment,
	applyLeaseCredit,
	applyLinesToDues,
	creditByPayment,
	reverseAllocations,
	type AllocationLine
} from '@ziga/shared/allocation';
import { toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import {
	assertPaymentTransition,
	AWAITING_PAYMENT_STATUSES,
	newReceiptToken,
	normalizeTransactionReference,
	paymentEntryBlockers,
	PaymentTransitionError,
	type PaymentEntryBlocker,
	type PaymentEntryData,
	type PaymentView
} from '@ziga/shared/payments';
import {
	receiptDocument,
	receiptSettingsBlockers,
	type PaymentDetailView,
	type PaymentValidationResult,
	type ReceiptFormat,
	type ReceiptPeriod,
	type ReceiptSettingsData,
	type ReceiptSettingsView,
	type ReceiptSnapshot,
	type ReceiptTokensView,
	type ReceiptVerificationView,
	type ReceiptView,
	type SharedReceiptView
} from '@ziga/shared/receipts';
import type { Page } from '@ziga/shared/leases';
import type { Queue } from 'bullmq';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { fromDatabaseError } from '../../common/db-errors.js';
import { RequestContext, type AuditOrigin } from '../../common/request-context.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { paymentAllocations, payments, receiptCounters, receipts, receiptTokens } from '../../db/schema/payments.js';
import { RECEIPT_PDF_JOB, RECEIPTS_QUEUE, type ReceiptPdfJobData } from '../../jobs/queues.js';
import { STORAGE, type StorageAdapter } from '../../storage/storage.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { LeasesService, type DueForPayment, type PaymentTarget } from '../leases/leases.service.js';
import { RentDueEvents, type DuesIssuedEvent } from '../leases/rent-due-events.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { GeographyService } from '../properties/geography.service.js';
import { PropertiesService } from '../properties/properties.service.js';
import { PaymentProviders } from './payment-provider.js';
import { renderReceiptPdf } from './receipt-pdf.js';

type PaymentRow = typeof payments.$inferSelect;
type ReceiptRow = typeof receipts.$inferSelect;
type AllocationRow = typeof paymentAllocations.$inferSelect;

interface Context {
	tx: Tx;
	organizationId: string;
	role: ReturnType<typeof RequestContext.organization>['role'];
	userId: string;
	actor: AuditActor;
}

const PAYMENT_NOT_FOUND = () => new AppError('PAYMENT_NOT_FOUND', 'Encaissement introuvable.', 404);
const RECEIPT_NOT_FOUND = () => new AppError('RECEIPT_NOT_FOUND', 'Reçu introuvable.', 404);

const ENTRY_MESSAGES: Record<PaymentEntryBlocker, { status: number; message: string }> = {
	PAYMENT_METHOD_NOT_ACCEPTED: {
		status: 409,
		message: 'Votre organisation n’accepte pas ce moyen de paiement (paramètres de l’organisation).'
	},
	PAYMENT_METHOD_UNAVAILABLE: { status: 409, message: 'Le paiement Mobile Money depuis la plateforme arrive plus tard.' },
	FORBIDDEN_ACTION: { status: 403, message: 'Votre rôle ne permet pas d’encaisser ce moyen de paiement.' },
	PAYMENT_DATE_IN_FUTURE: { status: 400, message: 'La date du paiement ne peut pas être dans le futur.' }
};

/** Empreinte SHA-256 d'un jeton de reçu : la base ne garde jamais le jeton (réponse du porteur, point 5). */
export function tokenHash(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Transition de la machine d'états (packages/shared), refus nommé PAYMENT_TRANSITION_FORBIDDEN. */
function transition(from: PaymentRow['status'], to: PaymentRow['status']): void {
	try {
		assertPaymentTransition(from, to);
	} catch (error) {
		if (error instanceof PaymentTransitionError) {
			throw new AppError(error.code, 'Ce changement de statut n’est pas permis pour cet encaissement.', 409, { from, to });
		}
		throw error;
	}
}

export function paymentView(p: PaymentRow): PaymentView {
	return {
		id: p.id,
		kind: p.kind,
		reversesPaymentId: p.reversesPaymentId,
		leaseId: p.leaseId,
		tenantId: p.tenantId,
		purpose: p.purpose,
		depositAccountId: p.depositAccountId,
		amount: p.amount,
		method: p.method,
		operator: p.operator,
		transactionReference: p.transactionReference,
		paidOn: p.paidOn,
		status: p.status,
		provider: p.provider,
		note: p.note,
		recordedBy: p.recordedBy,
		confirmedAt: iso(p.confirmedAt),
		confirmedBy: p.confirmedBy,
		cancellationReason: p.cancellationReason,
		cancelledAt: iso(p.cancelledAt),
		cancelledBy: p.cancelledBy,
		createdAt: p.createdAt.toISOString()
	};
}

export function receiptView(r: ReceiptRow): ReceiptView {
	return {
		id: r.id,
		paymentId: r.paymentId,
		status: r.status,
		number: r.number,
		provisionalNumber: r.provisionalNumber,
		issuedOn: r.issuedOn,
		snapshot: r.snapshot,
		cancelledAt: iso(r.cancelledAt)
	};
}

@Injectable()
export class PaymentsService implements OnModuleInit {
	constructor(
		private readonly database: DatabaseService,
		private readonly audit: AuditService,
		private readonly leases: LeasesService,
		private readonly organizations: OrganizationsService,
		private readonly properties: PropertiesService,
		private readonly geography: GeographyService,
		private readonly providers: PaymentProviders,
		private readonly events: RentDueEvents,
		@InjectQueue(RECEIPTS_QUEUE) private readonly queue: Queue<ReceiptPdfJobData>,
		@Inject(STORAGE) private readonly storage: StorageAdapter,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {}

	onModuleInit(): void {
		// Crédit du bail imputé sur chaque nouvelle échéance (validation, changement de loyer, tâche de nuit).
		this.events.onIssued((event) => this.applyCreditOnIssued(event));
	}

	private context(): Context {
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		return {
			tx: RequestContext.tx(),
			organizationId: scope.organizationId,
			role: scope.role,
			userId,
			actor: { type: 'user', userId, role: scope.role }
		};
	}

	// ---------------------------------------------------------------- lecture

	private async paymentRow(c: Context, id: string, lock = false): Promise<PaymentRow> {
		const q = c.tx.select().from(payments).where(eq(payments.id, id)).limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row || row.kind !== 'payment') throw PAYMENT_NOT_FOUND();
		// L'agent de terrain n'atteint que les loyers des baux de ses unités (comme ses Sync Streams).
		if (c.role === 'field_agent') {
			if (row.purpose !== 'rent') throw PAYMENT_NOT_FOUND();
			await this.leases.paymentTarget(row.leaseId).catch(() => {
				throw PAYMENT_NOT_FOUND();
			});
		}
		return row;
	}

	private async receiptOf(tx: Tx, paymentId: string): Promise<ReceiptRow | null> {
		const [r] = await tx.select().from(receipts).where(eq(receipts.paymentId, paymentId)).limit(1);
		return r ?? null;
	}

	private async detail(c: Context, payment: PaymentRow): Promise<PaymentDetailView> {
		const lines = await c.tx
			.select()
			.from(paymentAllocations)
			.where(eq(paymentAllocations.paymentId, payment.id))
			.orderBy(asc(paymentAllocations.createdAt), asc(paymentAllocations.id));
		const receipt = await this.receiptOf(c.tx, payment.id);
		return {
			payment: paymentView(payment),
			allocations: lines
				.filter((l) => c.role !== 'field_agent' || l.target !== 'deposit_account')
				.map((l) => ({ target: l.target, targetId: l.rentDueId ?? l.depositAccountId, direction: l.direction, amount: l.amount })),
			receipt: receipt ? receiptView(receipt) : null
		};
	}

	async get(id: string): Promise<PaymentDetailView> {
		const c = this.context();
		return this.detail(c, await this.paymentRow(c, id));
	}

	/**
	 * Encaissements de l'organisation, du plus récent au plus ancien, par curseur (UUIDv7). Filtres : statut, bail.
	 * Agent de terrain : les loyers des baux de ses unités seulement.
	 */
	async list(filter: { status?: string; leaseId?: string; cursor?: string | null; limit: number }): Promise<Page<PaymentView>> {
		const c = this.context();
		let leaseIds: string[] | null = null;
		if (c.role === 'field_agent') {
			leaseIds = (await this.leases.listLeases({})).map((l) => l.id);
			if (!leaseIds.length) return { items: [], nextCursor: null };
		}
		const rows = await c.tx
			.select()
			.from(payments)
			.where(
				and(
					eq(payments.kind, 'payment'),
					filter.status ? eq(payments.status, filter.status as PaymentRow['status']) : undefined,
					filter.leaseId ? eq(payments.leaseId, filter.leaseId) : undefined,
					leaseIds ? inArray(payments.leaseId, leaseIds) : undefined,
					leaseIds ? eq(payments.purpose, 'rent') : undefined,
					filter.cursor ? lt(payments.id, filter.cursor) : undefined
				)
			)
			.orderBy(desc(payments.id))
			.limit(filter.limit + 1);
		const items = rows.slice(0, filter.limit).map(paymentView);
		return { items, nextCursor: rows.length > filter.limit ? items.at(-1)!.id : null };
	}

	// ---------------------------------------------------------------- saisie

	/** Une ou deux saisies (« Caution et avance ») dans une même transaction : tout ou rien. */
	async record(entries: PaymentEntryData[], origin?: AuditOrigin): Promise<PaymentDetailView[]> {
		const c = this.context();
		const out: PaymentDetailView[] = [];
		for (const entry of entries) out.push(await this.recordOne(c, entry, origin));
		return out;
	}

	private async recordOne(c: Context, entry: PaymentEntryData, origin?: AuditOrigin): Promise<PaymentDetailView> {
		// Rejeu (route rejouée, double envoi) : le premier enregistrement est renvoyé, rien n'est créé.
		const [existing] = await c.tx.select().from(payments).where(eq(payments.id, entry.id)).limit(1);
		if (existing) {
			if (existing.leaseId !== entry.leaseId || existing.amount !== entry.amount || existing.method !== entry.method) {
				throw new AppError('PAYMENT_ID_CONFLICT', 'Cet identifiant désigne déjà un autre encaissement.', 409);
			}
			return this.detail(c, existing);
		}
		const today = toIsoDate();
		const settings = await this.organizations.view(c.tx);
		const [blocker] = paymentEntryBlockers({
			method: entry.method,
			role: c.role,
			acceptedMethods: settings.acceptedPaymentMethods,
			paidOn: entry.paidOn,
			today
		});
		if (blocker) throw new AppError(blocker, ENTRY_MESSAGES[blocker].message, ENTRY_MESSAGES[blocker].status);
		const target = await this.leases.paymentTarget(entry.leaseId);
		if (!['signed', 'active', 'notice', 'ended'].includes(target.status)) {
			throw new AppError('PAYMENT_LEASE_NOT_VALIDATED', 'On n’encaisse que sur un bail signé, en vigueur ou terminé.', 409);
		}
		if (entry.purpose === 'deposit') await this.checkDepositEntry(c, target, entry.depositAccountId!, entry.amount);
		if (entry.method === 'mobile_money_manual') await this.checkMobileMoneyDuplicate(c, entry);

		const provider = this.providers.get('manual');
		const start = await provider.initiate({
			organizationId: c.organizationId,
			paymentId: entry.id,
			amount: entry.amount,
			method: entry.method,
			operator: entry.operator,
			role: c.role
		});
		const confirmed = start.status === 'confirmed';
		const now = new Date();
		const [payment] = await c.tx
			.insert(payments)
			.values({
				id: entry.id,
				organizationId: c.organizationId,
				kind: 'payment',
				leaseId: entry.leaseId,
				tenantId: target.tenantId,
				purpose: entry.purpose,
				depositAccountId: entry.depositAccountId,
				amount: entry.amount,
				method: entry.method,
				operator: entry.operator,
				transactionReference: entry.transactionReference,
				paidOn: entry.paidOn,
				status: start.status,
				provider: provider.key,
				providerReference: start.providerReference,
				idempotencyKey: `payment:${entry.id}`,
				note: entry.note,
				recordedBy: c.userId,
				confirmedAt: confirmed ? now : null,
				confirmedBy: confirmed ? c.userId : null
			})
			.returning();
		await c.tx.insert(receipts).values({
			id: entry.receiptId,
			organizationId: c.organizationId,
			paymentId: entry.id,
			leaseId: entry.leaseId,
			purpose: entry.purpose,
			provisionalNumber: entry.provisionalNumber,
			status: 'provisional'
		});
		await c.tx.insert(receiptTokens).values([
			{
				id: newId(),
				organizationId: c.organizationId,
				receiptId: entry.receiptId,
				kind: 'verification',
				tokenHash: tokenHash(entry.verificationToken),
				createdBy: c.userId
			},
			{
				id: newId(),
				organizationId: c.organizationId,
				receiptId: entry.receiptId,
				kind: 'share',
				tokenHash: tokenHash(entry.shareToken),
				createdBy: c.userId
			}
		]);
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'payment.record',
			objectType: 'payment',
			objectId: entry.id,
			after: {
				leaseId: entry.leaseId,
				purpose: entry.purpose,
				depositAccountId: entry.depositAccountId,
				amount: entry.amount,
				method: entry.method,
				operator: entry.operator,
				transactionReference: entry.transactionReference,
				paidOn: entry.paidOn,
				status: start.status,
				receiptId: entry.receiptId
			},
			...(origin ? { origin } : {})
		});
		if (confirmed) await this.confirm(c, payment!, today, origin);
		return this.detail(c, (await c.tx.select().from(payments).where(eq(payments.id, entry.id)))[0]!);
	}

	/** Versement de caution : compte du même bail, jamais au-delà du convenu (versements en attente compris). */
	private async checkDepositEntry(c: Context, target: PaymentTarget, accountId: string, amount: number): Promise<void> {
		if (c.role === 'field_agent') throw new AppError('FORBIDDEN_ACTION', 'L’agent de terrain n’encaisse pas les cautions.', 403);
		const account = target.deposits.find((d) => d.id === accountId);
		if (!account) throw new AppError('DEPOSIT_ACCOUNT_NOT_FOUND', 'Compte de caution introuvable pour ce bail.', 404);
		if (account.status === 'closed') throw new AppError('DEPOSIT_ACCOUNT_CLOSED', 'Ce compte de caution est soldé.', 409);
		const [pending] = await c.tx
			.select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)::bigint` })
			.from(payments)
			.where(
				and(
					eq(payments.depositAccountId, accountId),
					eq(payments.kind, 'payment'),
					inArray(payments.status, [...AWAITING_PAYMENT_STATUSES])
				)
			);
		if (amount + Number(pending?.total ?? 0) > account.remainingDue) {
			throw new AppError(
				'DEPOSIT_OVERPAID',
				'Ce versement dépasse le montant convenu de la caution (versements en attente compris).',
				409,
				{
					remainingDue: account.remainingDue,
					pending: Number(pending?.total ?? 0)
				}
			);
		}
	}

	/** Point b : même opérateur, même référence normalisée, hors paiements annulés : refus nommé. */
	private async checkMobileMoneyDuplicate(c: Context, entry: PaymentEntryData): Promise<void> {
		const [dup] = await c.tx
			.select({ id: payments.id })
			.from(payments)
			.where(
				and(
					eq(payments.kind, 'payment'),
					eq(payments.method, 'mobile_money_manual'),
					eq(payments.operator, entry.operator!),
					eq(payments.referenceKey, normalizeTransactionReference(entry.transactionReference!)),
					ne(payments.status, 'cancelled')
				)
			)
			.limit(1);
		if (dup) {
			throw new AppError(
				'MOBILE_MONEY_REFERENCE_DUPLICATE',
				'Cette référence Mobile Money est déjà enregistrée chez cet opérateur. Vérifiez la transaction.',
				409,
				{ paymentId: dup.id }
			);
		}
	}

	// ---------------------------------------------------------------- confirmation

	/** Crédit disponible du bail, par encaissement, le plus ancien d'abord (UUIDv7). */
	private async creditsOf(tx: Tx, leaseId: string): Promise<{ paymentId: string; amount: number }[]> {
		const rows = await tx
			.select()
			.from(paymentAllocations)
			.where(and(eq(paymentAllocations.leaseId, leaseId), eq(paymentAllocations.target, 'credit')));
		return [...creditByPayment(rows.map(toLine))]
			.map(([paymentId, amount]) => ({ paymentId, amount }))
			.sort((a, b) => (a.paymentId < b.paymentId ? -1 : 1));
	}

	private async insertLines(
		tx: Tx,
		organizationId: string,
		leaseId: string,
		lines: AllocationLine[],
		createdBy: string | null
	): Promise<void> {
		if (!lines.length) return;
		await tx.insert(paymentAllocations).values(
			lines.map((l) => ({
				id: newId(),
				organizationId,
				paymentId: l.paymentId,
				leaseId,
				target: l.target,
				rentDueId: l.target === 'rent_due' ? l.targetId : null,
				depositAccountId: l.target === 'deposit_account' ? l.targetId : null,
				direction: l.direction,
				amount: l.amount,
				createdBy
			}))
		);
	}

	/**
	 * Confirmation : imputation par le serveur, puis reçu numéroté par la base, copie figée (D29) et PDF en tâche de
	 * fond. Le statut `confirmed` est déjà posé par l'appelant (saisie ou validation).
	 */
	private async confirm(c: Context, payment: PaymentRow, today: string, origin?: AuditOrigin): Promise<string | null> {
		const target = await this.leases.paymentTarget(payment.leaseId);
		let periods: ReceiptPeriod[] = [];
		let credit = 0;
		let balanceDue: number;
		let deposit: ReceiptSnapshot['deposit'] = null;
		if (payment.purpose === 'rent') {
			const dues = await this.leases.duesForAllocation(payment.leaseId, c.tx);
			// Crédit déjà présent (rare : sans échéance ouverte, il n'y en a pas) imputé d'abord, puis l'encaissement.
			const creditLines = applyLeaseCredit(await this.creditsOf(c.tx, payment.leaseId), dues);
			const lines = allocateRentPayment(payment.id, payment.amount, applyLinesToDues(dues, creditLines));
			await this.insertLines(c.tx, c.organizationId, payment.leaseId, [...creditLines, ...lines], c.userId);
			const touched = [...new Set([...creditLines, ...lines].filter((l) => l.target === 'rent_due').map((l) => l.targetId!))];
			await this.leases.refreshDueStatusesAfterPayment(touched, today, c.actor, c.tx, origin);
			const byId = new Map<string, DueForPayment>(dues.map((d) => [d.id, d]));
			periods = lines
				.filter((l) => l.target === 'rent_due')
				.map((l) => {
					const d = byId.get(l.targetId!)!;
					return { start: d.periodStart, end: d.periodEnd, amount: l.amount, isAdvance: d.isAdvance };
				});
			credit = lines.filter((l) => l.target === 'credit').reduce((s, l) => s + l.amount, 0);
			balanceDue = await this.leases.outstandingOf(payment.leaseId, today, c.tx);
		} else {
			const account = target.deposits.find((d) => d.id === payment.depositAccountId)!;
			await this.insertLines(
				c.tx,
				c.organizationId,
				payment.leaseId,
				allocateDepositPayment(payment.id, payment.amount, account.id),
				c.userId
			);
			deposit = { type: account.type, holder: account.holder };
			balanceDue = Math.max(0, account.remainingDue - payment.amount);
		}
		const receipt = await this.receiptOf(c.tx, payment.id);
		if (!receipt) return null;
		await this.organizations.ensureReceiptPrefix(c.actor, c.tx, origin);
		const snapshot: ReceiptSnapshot = {
			organization: await this.organizations.receiptSnapshot(c.tx),
			tenant: { fullName: target.tenantName },
			unit: await this.unitOf(c.tx, target.unitId),
			purpose: payment.purpose,
			periods,
			credit,
			deposit,
			amount: payment.amount,
			method: payment.method,
			operator: payment.operator,
			transactionReference: payment.transactionReference,
			paidOn: payment.paidOn,
			balanceDue,
			collectedBy: (payment.recordedBy && (await this.organizations.memberName(payment.recordedBy, c.tx))) || 'Organisation'
		};
		const [issued] = await c.tx
			.update(receipts)
			.set({ status: 'valid', issuedOn: today, snapshot, logoId: snapshot.organization.logoId })
			.where(eq(receipts.id, receipt.id))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'receipt.issue',
			objectType: 'receipt',
			objectId: receipt.id,
			after: { paymentId: payment.id, number: issued!.number, amount: payment.amount, periods, credit, balanceDue },
			...(origin ? { origin } : {})
		});
		this.enqueuePdf(c.organizationId, receipt.id);
		return issued!.number;
	}

	private async unitOf(tx: Tx, unitId: string): Promise<ReceiptSnapshot['unit']> {
		const unit = await this.properties.getUnit(unitId);
		const property = await this.properties.get(unit.propertyId);
		const communes = await this.geography.communes(tx);
		const neighborhoods = await this.geography.neighborhoods(tx);
		const address = [
			property.addressHint,
			neighborhoods.find((n) => n.id === property.neighborhoodId)?.name,
			communes.find((x) => x.id === property.communeId)?.name
		].filter((v): v is string => !!v);
		return { label: `${property.name} — ${unit.label}`, address: address.length ? address.join(', ') : null };
	}

	private enqueuePdf(organizationId: string, receiptId: string): void {
		RequestContext.afterCommit(async () => {
			await this.queue.add(RECEIPT_PDF_JOB, { organizationId, receiptId }, { jobId: `receipt-${receiptId}-${Date.now()}` });
		});
	}

	// ---------------------------------------------------------------- validation et rapprochement

	/**
	 * Validation unitaire ou groupée (espèces « à valider », Mobile Money ou virement « à rapprocher »), en ligne. Chaque
	 * encaissement est validé dans son propre point de reprise : un refus n'annule pas les autres.
	 */
	async validate(ids: string[]): Promise<PaymentValidationResult[]> {
		const c = this.context();
		const today = toIsoDate();
		const out: PaymentValidationResult[] = [];
		for (const id of ids) {
			try {
				const number = await c.tx.transaction(async () => {
					const payment = await this.paymentRow(c, id, true);
					// Seuls les encaissements en attente se valident ici ; le paiement direct (lot 14) suit son prestataire.
					transition((AWAITING_PAYMENT_STATUSES as readonly string[]).includes(payment.status) ? payment.status : 'cancelled', 'confirmed');
					const [confirmed] = await c.tx
						.update(payments)
						.set({ status: 'confirmed', confirmedAt: new Date(), confirmedBy: c.userId })
						.where(eq(payments.id, id))
						.returning();
					await this.audit.record(c.tx, {
						actor: c.actor,
						organizationId: c.organizationId,
						action: payment.status === 'to_validate' ? 'payment.validate' : 'payment.reconcile',
						objectType: 'payment',
						objectId: id,
						before: { status: payment.status },
						after: { status: 'confirmed' }
					});
					const n = await this.confirm(c, confirmed!, today);
					// L'invariant des imputations (trigger différé) est vérifié ici, pour que le refus reste à cet encaissement.
					await c.tx.execute(sql`set constraints payments_allocation_balance, payment_allocations_balance immediate`);
					await c.tx.execute(sql`set constraints payments_allocation_balance, payment_allocations_balance deferred`);
					return n;
				});
				out.push({ paymentId: id, status: 'confirmed', receiptNumber: number });
			} catch (error) {
				const e = toAppError(error);
				out.push({ paymentId: id, status: 'rejected', code: e.code, message: e.message });
			}
		}
		return out;
	}

	// ---------------------------------------------------------------- annulation

	/**
	 * Annulation par contre-écriture (directeur, motif obligatoire, en ligne) : statut annulé, imputations inverses (le
	 * crédit déjà imputé sur une échéance suivante compris), paiement de contre-écriture lié, échéances recalculées, reçu
	 * « ANNULÉ » et PDF régénéré. Un encaissement en attente n'a rien d'imputé : il est seulement annulé.
	 */
	async cancel(id: string, reason: string): Promise<PaymentDetailView> {
		const c = this.context();
		const today = toIsoDate();
		const payment = await this.paymentRow(c, id, true);
		transition(payment.status, 'cancelled');
		const now = new Date();
		await c.tx
			.update(payments)
			.set({ status: 'cancelled', cancelledAt: now, cancelledBy: c.userId, cancellationReason: reason })
			.where(eq(payments.id, id));
		let reversalId: string | null = null;
		if (payment.status === 'confirmed') {
			const lines = await c.tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, id));
			const reverse = reverseAllocations(id, lines.map(toLine));
			await this.insertLines(c.tx, c.organizationId, payment.leaseId, reverse, c.userId);
			reversalId = newId();
			await c.tx.insert(payments).values({
				id: reversalId,
				organizationId: c.organizationId,
				kind: 'reversal',
				reversesPaymentId: id,
				leaseId: payment.leaseId,
				tenantId: payment.tenantId,
				purpose: payment.purpose,
				depositAccountId: payment.depositAccountId,
				amount: payment.amount,
				method: payment.method,
				operator: payment.operator,
				transactionReference: payment.transactionReference,
				paidOn: today,
				status: 'confirmed',
				provider: payment.provider,
				idempotencyKey: `reversal:${id}`,
				note: reason,
				recordedBy: c.userId,
				confirmedAt: now,
				confirmedBy: c.userId
			});
			const touched = [...new Set(reverse.filter((l) => l.target === 'rent_due').map((l) => l.targetId!))];
			await this.leases.refreshDueStatusesAfterPayment(touched, today, c.actor, c.tx);
		}
		const receipt = await this.receiptOf(c.tx, id);
		if (receipt && receipt.status !== 'cancelled') {
			await c.tx.update(receipts).set({ status: 'cancelled', cancelledAt: now }).where(eq(receipts.id, receipt.id));
			if (receipt.number) this.enqueuePdf(c.organizationId, receipt.id);
		}
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'payment.cancel',
			objectType: 'payment',
			objectId: id,
			before: { status: payment.status, amount: payment.amount },
			after: { status: 'cancelled', reason, reversalPaymentId: reversalId, receiptNumber: receipt?.number ?? null }
		});
		return this.detail(c, (await c.tx.select().from(payments).where(eq(payments.id, id)))[0]!);
	}

	// ---------------------------------------------------------------- crédit du bail

	/** Événement du module leases : de nouvelles échéances ; le crédit du bail s'y impute, le plus ancien d'abord. */
	private async applyCreditOnIssued(event: DuesIssuedEvent): Promise<void> {
		const credits = await this.creditsOf(event.tx, event.leaseId);
		if (!credits.length) return;
		const dues = await this.leases.duesForAllocation(event.leaseId, event.tx);
		const lines = applyLeaseCredit(credits, dues);
		if (!lines.length) return;
		await this.insertLines(event.tx, event.organizationId, event.leaseId, lines, event.actor.type === 'user' ? event.actor.userId : null);
		const touched = [...new Set(lines.filter((l) => l.target === 'rent_due').map((l) => l.targetId!))];
		await this.leases.refreshDueStatusesAfterPayment(touched, event.today, event.actor, event.tx, event.origin);
		await this.audit.record(event.tx, {
			actor: event.actor,
			organizationId: event.organizationId,
			action: 'payment.credit_applied',
			objectType: 'lease',
			objectId: event.leaseId,
			after: {
				lines: lines
					.filter((l) => l.target === 'rent_due')
					.map((l) => ({ paymentId: l.paymentId, rentDueId: l.targetId, amount: l.amount }))
			},
			...(event.origin ? { origin: event.origin } : {})
		});
	}

	// ---------------------------------------------------------------- reçus : PDF, partage

	/** URL signée (5 minutes) du PDF d'un reçu émis ; chaque téléchargement est journalisé. */
	async receiptPdfUrl(receiptId: string, format: ReceiptFormat): Promise<{ url: string; expiresInSeconds: number }> {
		const c = this.context();
		const [receipt] = await c.tx.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1);
		if (!receipt) throw RECEIPT_NOT_FOUND();
		await this.paymentRow(c, receipt.paymentId);
		const key = format === 'ticket' ? receipt.pdfTicketKey : receipt.pdfA6Key;
		if (!key) throw new AppError('RECEIPT_PDF_PENDING', 'Le PDF du reçu est en préparation : réessayez dans quelques secondes.', 409);
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'receipt.download',
			objectType: 'receipt',
			objectId: receipt.id,
			after: { format, number: receipt.number }
		});
		const url = await this.storage.presignGet(key, {
			expiresInSeconds: 300,
			fileName: `recu-${receipt.number ?? receipt.provisionalNumber}-${format}.pdf`,
			contentType: 'application/pdf'
		});
		return { url, expiresInSeconds: 300 };
	}

	/**
	 * Nouveaux jetons d'un reçu (en ligne), pour quiconque lit ce reçu : un jeton de vérification de plus, sans retirer
	 * les précédents (un QR code imprimé reste valable), et un jeton de partage, révocable. Les jetons ne sont renvoyés
	 * qu'ici ; la base n'en garde que l'empreinte. Chaque création est journalisée.
	 */
	async newReceiptTokens(receiptId: string): Promise<ReceiptTokensView> {
		const c = this.context();
		const [receipt] = await c.tx.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1);
		if (!receipt) throw RECEIPT_NOT_FOUND();
		await this.paymentRow(c, receipt.paymentId);
		const verificationToken = newReceiptToken();
		const shareToken = newReceiptToken();
		for (const [kind, token, action] of [
			['verification', verificationToken, 'receipt.verification_token'],
			['share', shareToken, 'receipt.share_link']
		] as const) {
			const id = newId();
			await c.tx.insert(receiptTokens).values({
				id,
				organizationId: c.organizationId,
				receiptId,
				kind,
				tokenHash: tokenHash(token),
				createdBy: c.userId
			});
			await this.audit.record(c.tx, {
				actor: c.actor,
				organizationId: c.organizationId,
				action,
				objectType: 'receipt',
				objectId: receiptId,
				after: { tokenId: id, kind }
			});
		}
		return { receiptId, paymentId: receipt.paymentId, provisionalNumber: receipt.provisionalNumber, verificationToken, shareToken };
	}

	/** Nouveau lien de partage (en ligne) : le jeton n'est renvoyé qu'ici, la base n'en garde que l'empreinte. */
	async newShareToken(receiptId: string): Promise<{ token: string }> {
		const c = this.context();
		const [receipt] = await c.tx.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1);
		if (!receipt) throw RECEIPT_NOT_FOUND();
		await this.paymentRow(c, receipt.paymentId);
		const token = newReceiptToken();
		await c.tx.insert(receiptTokens).values({
			id: newId(),
			organizationId: c.organizationId,
			receiptId,
			kind: 'share',
			tokenHash: tokenHash(token),
			createdBy: c.userId
		});
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'receipt.share_link',
			objectType: 'receipt',
			objectId: receiptId
		});
		return { token };
	}

	/** Révoque tous les liens de partage d'un reçu ; le QR code imprimé reste valable. */
	async revokeShareTokens(receiptId: string): Promise<{ revoked: number }> {
		const c = this.context();
		const [receipt] = await c.tx.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1);
		if (!receipt) throw RECEIPT_NOT_FOUND();
		await this.paymentRow(c, receipt.paymentId);
		const rows = await c.tx
			.update(receiptTokens)
			.set({ revokedAt: new Date(), revokedBy: c.userId })
			.where(and(eq(receiptTokens.receiptId, receiptId), eq(receiptTokens.kind, 'share'), isNull(receiptTokens.revokedAt)))
			.returning({ id: receiptTokens.id });
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'receipt.share_revoke',
			objectType: 'receipt',
			objectId: receiptId,
			after: { revoked: rows.length }
		});
		return { revoked: rows.length };
	}

	// ---------------------------------------------------------------- réglages de la numérotation

	async settings(): Promise<ReceiptSettingsView & { firstNumberSet: boolean }> {
		const c = this.context();
		const view = await this.organizations.receiptSettings(c.tx);
		const [first] = await c.tx
			.select({ year: receiptCounters.year })
			.from(receiptCounters)
			.where(isNotNull(receiptCounters.firstNumberSetAt))
			.limit(1);
		return { ...view, firstNumberSet: !!first };
	}

	/** Préfixe, premier numéro (une seule fois, avant le premier reçu) et largeur du ticket ; chaque réglage journalisé. */
	async updateSettings(input: ReceiptSettingsData): Promise<ReceiptSettingsView & { firstNumberSet: boolean }> {
		const c = this.context();
		const current = await this.settings();
		const [blocker] = receiptSettingsBlockers(
			{ issuedCount: current.numberingStartedAt ? 1 : 0, firstNumberSet: current.firstNumberSet },
			input
		);
		if (blocker) {
			const messages = {
				RECEIPT_PREFIX_LOCKED: 'Le préfixe des reçus est figé depuis le premier reçu ; seul le support de la plateforme peut le changer.',
				RECEIPT_FIRST_NUMBER_LOCKED: 'Un reçu a déjà été émis : le premier numéro ne se fixe plus.',
				RECEIPT_FIRST_NUMBER_ALREADY_SET: 'Le premier numéro a déjà été fixé ; il ne se fixe qu’une fois.'
			} as const;
			throw new AppError(blocker, messages[blocker], 409);
		}
		if (input.prefix !== undefined) await this.organizations.setReceiptPrefix(input.prefix, c.tx);
		if (input.ticketWidth !== undefined) await this.organizations.setReceiptTicketWidth(input.ticketWidth, c.tx);
		if (input.firstNumber !== undefined) {
			const year = Number(toIsoDate().slice(0, 4));
			await c.tx.execute(sql`select set_receipt_first_number(${year}, ${input.firstNumber}, ${c.userId}::uuid)`);
			await this.audit.record(c.tx, {
				actor: c.actor,
				organizationId: c.organizationId,
				action: 'receipt.first_number',
				objectType: 'organization',
				objectId: c.organizationId,
				after: { year, firstNumber: input.firstNumber }
			});
		}
		return this.settings();
	}

	// ---------------------------------------------------------------- pages publiques (sans compte)

	/** Vérification par QR code : seulement l'organisation, le numéro, la date, le montant et le statut. */
	async verify(token: string): Promise<ReceiptVerificationView | null> {
		const r = await this.database.db.execute<{
			organization_name: string;
			number: string | null;
			issued_on: string | null;
			amount: string;
			status: ReceiptView['status'];
		}>(sql`select organization_name, number, issued_on::text as issued_on, amount, status from receipt_verification(${tokenHash(token)})`);
		const row = r.rows[0];
		return row
			? {
					organizationName: row.organization_name,
					number: row.number,
					issuedOn: row.issued_on,
					amount: Number(row.amount),
					status: row.status
				}
			: null;
	}

	/** Lien partagé : le reçu en lecture seule, dans le contexte de son organisation (sous la RLS). */
	async shared(token: string): Promise<SharedReceiptView> {
		const target = await this.shareTarget(token);
		if (!target) return { state: 'pending' };
		return this.database.withOrganization(target.organizationId, async (tx) => {
			const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, target.receiptId)).limit(1);
			const [payment] = await tx.select().from(payments).where(eq(payments.id, receipt!.paymentId)).limit(1);
			const org = await this.organizations.receiptSnapshot(tx);
			return {
				state: 'available' as const,
				organizationName: receipt!.snapshot?.organization.name ?? org.name,
				status: receipt!.status,
				number: receipt!.number,
				provisionalNumber: receipt!.provisionalNumber,
				paidOn: payment!.paidOn,
				amount: payment!.amount,
				document: receipt!.snapshot
					? receiptDocument({
							snapshot: receipt!.snapshot,
							status: receipt!.status,
							number: receipt!.number,
							provisionalNumber: receipt!.provisionalNumber,
							issuedOn: receipt!.issuedOn,
							verificationUrl: null
						})
					: null,
				hasPdf: !!receipt!.pdfA6Key
			};
		});
	}

	/** URL signée du PDF par le lien partagé (5 minutes). */
	async sharedPdfUrl(token: string, format: ReceiptFormat): Promise<string | null> {
		const target = await this.shareTarget(token);
		if (!target) return null;
		const receipt = await this.database.withOrganization(
			target.organizationId,
			async (tx) => (await tx.select().from(receipts).where(eq(receipts.id, target.receiptId)).limit(1))[0]
		);
		const key = format === 'ticket' ? receipt?.pdfTicketKey : receipt?.pdfA6Key;
		if (!receipt || !key) return null;
		return this.storage.presignGet(key, {
			expiresInSeconds: 300,
			fileName: `recu-${receipt.number ?? receipt.provisionalNumber}.pdf`,
			contentType: 'application/pdf'
		});
	}

	private async shareTarget(token: string): Promise<{ organizationId: string; receiptId: string } | null> {
		const r = await this.database.db.execute<{ organization_id: string; receipt_id: string }>(
			sql`select organization_id, receipt_id from receipt_share_target(${tokenHash(token)})`
		);
		const row = r.rows[0];
		return row ? { organizationId: row.organization_id, receiptId: row.receipt_id } : null;
	}

	// ---------------------------------------------------------------- PDF (worker)

	/** Adresse du web pour le QR code. */
	private webOrigin(): string {
		return (this.config.WEB_PUBLIC_URL ?? this.config.CORS_ORIGINS[0]!).replace(/\/$/, '');
	}

	/**
	 * PDF A6 et ticket d'un reçu émis (tâche de fond). Le jeton du QR code est créé ici : la base n'en garde que
	 * l'empreinte, le jeton n'existe que dans le PDF. Les fichiers ne sont jamais écrasés (une clé par génération).
	 */
	async renderPdf(organizationId: string, receiptId: string): Promise<{ a6: string; ticket: string } | null> {
		return this.database.withOrganization(organizationId, async (tx) => {
			const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, receiptId)).limit(1).for('update');
			if (!receipt?.snapshot || !receipt.number) return null;
			const settings = await this.organizations.receiptSettings(tx);
			const logoKey = receipt.logoId ? await this.organizations.logoPrintKey(receipt.logoId, tx) : null;
			const logoPng = logoKey ? await this.storage.get(logoKey).catch(() => null) : null;
			const token = newReceiptToken();
			await tx.insert(receiptTokens).values({ id: newId(), organizationId, receiptId, kind: 'verification', tokenHash: tokenHash(token) });
			const document = receiptDocument({
				snapshot: receipt.snapshot,
				status: receipt.status,
				number: receipt.number,
				provisionalNumber: receipt.provisionalNumber,
				issuedOn: receipt.issuedOn,
				verificationUrl: `${this.webOrigin()}/r/${token}`
			});
			const stamp = Date.now();
			const keys = {
				a6: `receipts/${organizationId}/${receiptId}/${stamp}-a6.pdf`,
				ticket: `receipts/${organizationId}/${receiptId}/${stamp}-ticket.pdf`
			};
			for (const format of ['a6', 'ticket'] as const) {
				const bytes = await renderReceiptPdf({
					document,
					format,
					ticketWidth: settings.ticketWidth,
					logoPng: logoPng ? new Uint8Array(logoPng) : null
				});
				await this.storage.put(keys[format], Buffer.from(bytes), 'application/pdf');
			}
			await tx
				.update(receipts)
				.set({ pdfA6Key: keys.a6, pdfTicketKey: keys.ticket, pdfGeneratedAt: new Date() })
				.where(eq(receipts.id, receiptId));
			return keys;
		});
	}
}

function toLine(r: AllocationRow): AllocationLine {
	return {
		paymentId: r.paymentId,
		target: r.target,
		targetId: r.rentDueId ?? r.depositAccountId,
		direction: r.direction,
		amount: r.amount
	};
}

/** Refus d'une validation groupée : erreur métier, de la base, ou transition interdite. */
function toAppError(error: unknown): AppError {
	if (error instanceof AppError) return error;
	if (error instanceof PaymentTransitionError) return new AppError(error.code, 'Cet encaissement n’est plus à valider.', 409);
	const known = fromDatabaseError(error);
	if (known) return known;
	throw error;
}
