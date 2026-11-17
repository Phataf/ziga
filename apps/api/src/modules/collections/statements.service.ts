/**
 * Relevés propriétaires et reversements (lot 10). Le calcul est la fonction pure `computeStatement` (packages/shared) ;
 * ce service n'assemble que ses entrées, à partir des services publics des modules owners, properties, leases, payments
 * et des dépenses (jamais leurs tables, CLAUDE.md §4) :
 * - éléments : imputations sur échéance, datées par la date de paiement (imputation directe), la date d'imputation
 *   (crédit, reconnu à sa ligne `credit` inverse écrite dans la même transaction) ou la date d'annulation ;
 * - mandat de chaque élément : celui de ce propriétaire qui couvre l'unité à la date de l'élément (pour une
 *   contre-écriture, à la date de l'imputation annulée), dans la version enregistrée à cette date ;
 * - commissions fixes : mois et baux validés depuis le dernier relevé émis (le mois du relevé seulement au premier) ;
 * - éléments déjà consommés, dernier relevé émis (solde négatif reporté), mois émis.
 * Brouillon recalculé à la demande ou par la tâche du 1er du mois ; émission (directeur, gestionnaire) qui recalcule,
 * refuse un brouillon changé, applique le quota Découverte, puis écrit les éléments consommés dans la même transaction ;
 * la base fait foi (ordre des mois, figement, unicité). PDF en tâche de fond. Lien /s/<jeton> : empreinte seulement.
 */
import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { toIsoDate } from '@ziga/shared/dates';
import type { Page } from '@ziga/shared/leases';
import { newId } from '@ziga/shared/ids';
import {
	addMonthsToMonth,
	computeStatement,
	monthEnd,
	monthOfDate,
	monthStart,
	newStatementToken,
	payoutBlockers,
	payoutsTotal,
	statementDocument,
	statementHasContent,
	statementIssueBlockers,
	statementItemKind,
	statementQuotaUsed,
	statementTokenExpiry,
	type PayoutData,
	type PayoutView,
	type SharedStatementView,
	type StatementAllocation,
	type StatementDetailView,
	type StatementDue,
	type StatementExpense,
	type MonthlyFeeCandidate,
	type OperationCandidate,
	type StatementIssueBlocker,
	type StatementMandate,
	type StatementResult,
	type StatementShareLinkView,
	type StatementSnapshot,
	type StatementSummaryView
} from '@ziga/shared/statements';
import type { Queue } from 'bullmq';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext, type AuditOrigin } from '../../common/request-context.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { ownerPayouts, ownerStatementLines, ownerStatements, ownerStatementTokens } from '../../db/schema/collections.js';
import { STATEMENT_PDF_JOB, STATEMENTS_QUEUE, type StatementPdfJobData } from '../../jobs/queues.js';
import { STORAGE, type StorageAdapter } from '../../storage/storage.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { FeaturesService } from '../features/features.service.js';
import { QuotasService } from '../features/quotas.service.js';
import { LeasesService } from '../leases/leases.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { OwnersService, type StatementMandateRow } from '../owners/owners.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PropertiesService } from '../properties/properties.service.js';
import { collectionsContext, iso, type CollectionsContext } from './collections-context.js';
import { ExpensesService } from './expenses.service.js';
import { renderStatementPdf } from './statement-pdf.js';

type StatementRow = typeof ownerStatements.$inferSelect;
type PayoutRow = typeof ownerPayouts.$inferSelect;

const STATEMENT_NOT_FOUND = () => new AppError('STATEMENT_NOT_FOUND', 'Relevé introuvable.', 404);
const PAYOUT_NOT_FOUND = () => new AppError('PAYOUT_NOT_FOUND', 'Reversement introuvable.', 404);

const ISSUE_MESSAGES: Record<StatementIssueBlocker, string> = {
	STATEMENT_PERIOD_NOT_ENDED: 'Le mois n’est pas terminé : le relevé s’émet à partir du 1er du mois suivant.',
	STATEMENT_ALREADY_ISSUED: 'Le relevé de ce mois est déjà émis : faites un rectificatif.',
	STATEMENT_OUT_OF_ORDER: 'Un relevé plus récent est déjà émis pour ce propriétaire.',
	STATEMENT_RECTIFICATION_NOT_LATEST: 'Un rectificatif ne vise que le dernier relevé émis.',
	STATEMENT_RECTIFICATION_EMPTY: 'Rien à rectifier : aucun élément nouveau pour ce mois.',
	STATEMENT_DRAFT_STALE: 'Le relevé a changé depuis son affichage : recalculez-le avant de l’émettre.'
};

/** Mandats qui donnent lieu à un relevé : jamais un bailleur particulier (self_managed) ni une vente. */
const STATEMENT_MANDATE_TYPES: readonly StatementMandateRow['type'][] = ['rental_management', 'letting', 'other'];
/** Mandats sous lesquels un loyer est encaissé (gestion locative). */
const RENT_MANDATE_TYPES: readonly StatementMandateRow['type'][] = ['rental_management', 'other'];

export function tokenHash(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}

function totalsOf(r: StatementRow): StatementSummaryView['totals'] {
	return {
		rentCollected: r.rentCollected,
		chargesCollected: r.chargesCollected,
		collected: r.collected,
		rentCollectedByOwner: r.rentCollectedByOwner,
		chargesCollectedByOwner: r.chargesCollectedByOwner,
		commission: r.commission,
		expenses: r.expenses,
		carriedBalance: r.carriedBalance,
		net: r.net
	};
}

export function statementSummary(r: StatementRow): StatementSummaryView {
	const snapshot = r.snapshot as StatementSnapshot;
	return {
		id: r.id,
		ownerId: r.ownerId,
		ownerName: snapshot.owner.displayName,
		month: r.month,
		version: r.version,
		correctsStatementId: r.correctsStatementId,
		status: r.status,
		revision: r.revision,
		totals: totalsOf(r),
		issuedOn: r.issuedOn,
		issuedAt: iso(r.issuedAt),
		pdfAvailable: !!r.pdfKey
	};
}

export function payoutView(p: PayoutRow): PayoutView {
	return {
		id: p.id,
		kind: p.kind,
		reversesPayoutId: p.reversesPayoutId,
		ownerId: p.ownerId,
		statementId: p.statementId,
		amount: p.amount,
		paidOn: p.paidOn,
		method: p.method,
		reference: p.reference,
		note: p.note,
		reason: p.reason,
		recordedBy: p.recordedBy,
		createdAt: p.createdAt.toISOString()
	};
}

/** Un mandat de ce propriétaire qui couvre l'unité à cette date, dans la version enregistrée à cette date. */
function mandateAt(
	mandates: readonly StatementMandateRow[],
	unitId: string,
	date: string,
	types: readonly StatementMandateRow['type'][]
): StatementMandate | null {
	const m = mandates
		.filter(
			(x) =>
				types.includes(x.type) && x.unitIds.includes(unitId) && x.startsOn <= date && (x.inForceUntil === null || date <= x.inForceUntil)
		)
		.sort((a, b) => (a.startsOn < b.startsOn ? 1 : -1))[0];
	if (!m) return null;
	return versionOf(m, date);
}

function versionOf(m: StatementMandateRow, date: string): StatementMandate {
	const v = [...m.versions].reverse().find((x) => x.from <= date) ?? m.versions[0]!;
	return { mandateId: m.id, version: v.version, commission: v.commission, canCollectFunds: v.canCollectFunds };
}

@Injectable()
export class StatementsService {
	constructor(
		private readonly database: DatabaseService,
		private readonly audit: AuditService,
		private readonly features: FeaturesService,
		private readonly quotas: QuotasService,
		private readonly organizations: OrganizationsService,
		private readonly owners: OwnersService,
		private readonly properties: PropertiesService,
		private readonly leases: LeasesService,
		private readonly payments: PaymentsService,
		private readonly expenses: ExpensesService,
		@InjectQueue(STATEMENTS_QUEUE) private readonly queue: Queue<StatementPdfJobData>,
		@Inject(STORAGE) private readonly storage: StorageAdapter,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {}

	// ---------------------------------------------------------------- assemblage du calcul

	/** Relevés émis d'un propriétaire, du plus ancien au plus récent. */
	private async issuedOf(tx: Tx, ownerId: string): Promise<StatementRow[]> {
		return tx
			.select()
			.from(ownerStatements)
			.where(and(eq(ownerStatements.ownerId, ownerId), eq(ownerStatements.status, 'issued')))
			.orderBy(asc(ownerStatements.month), asc(ownerStatements.version));
	}

	/** Entrées de `computeStatement` pour ce propriétaire et ce mois, puis le calcul et le contenu figé. */
	async compute(
		tx: Tx,
		ownerId: string,
		month: string,
		version: number
	): Promise<{ result: StatementResult; snapshot: StatementSnapshot }> {
		const mandates = (await this.owners.statementMandates(tx, { ownerId })).filter((m) => STATEMENT_MANDATE_TYPES.includes(m.type));
		const ownerName = mandates[0]?.ownerName ?? (await this.owners.ownerName(tx, ownerId));
		if (!ownerName) throw new AppError('OWNER_NOT_FOUND', 'Propriétaire introuvable.', 404);
		const unitIds = [...new Set(mandates.flatMap((m) => m.unitIds))];
		const propertyIds = [...new Set(mandates.flatMap((m) => m.propertyIds))];
		const units = await this.properties.collectionUnits(tx, { unitIds });
		const data = await this.leases.collectionLeases(tx, { unitIds });
		const leaseById = new Map(data.leases.map((l) => [l.id, l]));
		const ledger = await this.payments.collectionLedger(
			tx,
			data.leases.map((l) => l.id)
		);
		const issued = await this.issuedOf(tx, ownerId);
		const last = issued.at(-1) ?? null;
		const consumedRows = issued.length
			? await tx
					.select({ key: ownerStatementLines.itemKey })
					.from(ownerStatementLines)
					.where(
						inArray(
							ownerStatementLines.statementId,
							issued.map((s) => s.id)
						)
					)
			: [];
		const consumed = new Set(consumedRows.map((r) => r.key!));
		// Commissions fixes : depuis le mois qui suit le dernier relevé émis (le mois du relevé seulement au premier).
		const windowStart = last && last.month < month ? addMonthsToMonth(last.month, 1) : month;

		// ---- imputations sur échéance
		const creditReverse = new Set(
			ledger.filter((r) => r.target === 'credit' && r.direction === 'reverse').map((r) => `${r.paymentId}|${r.createdAt.getTime()}`)
		);
		const originDate = (r: (typeof ledger)[number]) =>
			creditReverse.has(`${r.paymentId}|${r.createdAt.getTime()}`) ? toIsoDate(r.createdAt) : r.paidOn;
		const dueRows = new Map<string, (typeof ledger)[number][]>();
		for (const r of ledger) {
			if (r.target !== 'rent_due' || !r.rentDueId) continue;
			dueRows.set(r.rentDueId, [...(dueRows.get(r.rentDueId) ?? []), r]);
		}
		const dues: StatementDue[] = [];
		for (const d of data.dues) {
			const rows = dueRows.get(d.id);
			if (!rows) continue;
			const lease = leaseById.get(d.leaseId)!;
			const entries: StatementAllocation[] = rows.map((r) => {
				let origin: StatementAllocation['origin'];
				let date: string;
				let mandateDate: string;
				if (r.direction === 'reverse') {
					origin = 'cancellation';
					date = toIsoDate(r.cancelledAt ?? r.createdAt);
					const first = rows.find((x) => x.paymentId === r.paymentId && x.direction === 'allocate');
					mandateDate = first ? originDate(first) : r.paidOn;
				} else {
					const credit = creditReverse.has(`${r.paymentId}|${r.createdAt.getTime()}`);
					origin = credit ? 'credit' : 'payment';
					date = credit ? toIsoDate(r.createdAt) : r.paidOn;
					mandateDate = date;
				}
				return {
					allocationId: r.id,
					paymentId: r.paymentId,
					direction: r.direction,
					amount: r.amount,
					origin,
					date,
					paidOn: r.paidOn,
					receiptNumber: r.receiptNumber,
					mandate: mandateAt(mandates, lease.unitId, mandateDate, RENT_MANDATE_TYPES)
				};
			});
			dues.push({
				id: d.id,
				leaseId: d.leaseId,
				unitId: lease.unitId,
				tenantName: lease.tenantName,
				periodStart: d.periodStart,
				periodEnd: d.periodEnd,
				rent: d.rent,
				charges: d.charges,
				ledger: entries
			});
		}

		// ---- trop-perçus détenus (crédit non imputé), par bail
		const creditByLease = new Map<string, number>();
		for (const r of ledger) {
			if (r.target !== 'credit') continue;
			creditByLease.set(r.leaseId, (creditByLease.get(r.leaseId) ?? 0) + (r.direction === 'allocate' ? r.amount : -r.amount));
		}

		// ---- commissions fixes
		const monthlyFees: MonthlyFeeCandidate[] = [];
		for (const m of mandates) {
			for (let mm = windowStart; mm <= month; mm = addMonthsToMonth(mm, 1)) {
				if (m.startsOn > monthEnd(mm) || (m.inForceUntil !== null && m.inForceUntil < monthStart(mm))) continue;
				const lastDay = m.inForceUntil !== null && m.inForceUntil < monthEnd(mm) ? m.inForceUntil : monthEnd(mm);
				const ref = versionOf(m, lastDay);
				if (ref.commission?.basis === 'fixed_per_month')
					monthlyFees.push({ month: mm, mandate: ref, inForceFrom: m.startsOn, inForceUntil: m.inForceUntil });
			}
		}
		const operations: OperationCandidate[] = [];
		for (const l of data.leases) {
			if (!l.validatedOn || l.validatedOn < monthStart(windowStart) || l.validatedOn > monthEnd(month)) continue;
			const ref = mandateAt(mandates, l.unitId, l.validatedOn, STATEMENT_MANDATE_TYPES);
			if (ref?.commission?.basis === 'fixed_per_operation') {
				operations.push({ leaseId: l.id, unitId: l.unitId, tenantName: l.tenantName, validatedOn: l.validatedOn, mandate: ref });
			}
		}

		const expenseRows = await this.expenses.ofProperties(tx, propertyIds);
		const statementExpenses: StatementExpense[] = expenseRows.map((e) => ({
			id: e.id,
			spentOn: e.spentOn,
			cancelledOn: e.cancelledAt ? toIsoDate(e.cancelledAt) : null,
			amount: e.amount,
			category: e.category,
			description: e.description,
			unitId: e.unitId,
			propertyId: e.propertyId,
			paidBy: e.paidBy,
			borneBy: e.borneBy,
			recovery: e.recovery
		}));

		const result = computeStatement({
			month,
			units: units.map((u) => ({ id: u.id, label: u.label })),
			dues,
			monthlyFees,
			operations,
			expenses: statementExpenses,
			previous: last ? { statementId: last.id, month: last.month, version: last.version, net: last.net } : null,
			consumed,
			issuedMonths: [...new Set(issued.map((s) => s.month))],
			depositsHeld: data.deposits
				.filter((d) => d.holder === 'organization' && d.balance > 0)
				.map((d) => {
					const l = leaseById.get(d.leaseId)!;
					return { leaseId: d.leaseId, unitId: l.unitId, tenantName: l.tenantName, type: d.type, balance: d.balance };
				}),
			creditsHeld: [...creditByLease]
				.filter(([, amount]) => amount > 0)
				.map(([leaseId, amount]) => {
					const l = leaseById.get(leaseId)!;
					return { leaseId, unitId: l.unitId, tenantName: l.tenantName, amount };
				})
		});
		const organization = await this.organizations.receiptSnapshot(tx);
		const { consumed: _consumed, revision: _revision, ...content } = result;
		const snapshot: StatementSnapshot = {
			organization,
			owner: { displayName: ownerName },
			month,
			version,
			issuedOn: null,
			units: units.map((u) => ({ id: u.id, label: u.label })),
			result: content
		};
		return { result, snapshot };
	}

	private totalsColumns(result: StatementResult) {
		const t = result.totals;
		return {
			revision: result.revision,
			rentCollected: t.rentCollected,
			chargesCollected: t.chargesCollected,
			collected: t.collected,
			rentCollectedByOwner: t.rentCollectedByOwner,
			chargesCollectedByOwner: t.chargesCollectedByOwner,
			commission: t.commission,
			expenses: t.expenses,
			carriedBalance: t.carriedBalance,
			net: t.net
		};
	}

	/** Brouillon recalculé (ou créé) pour ce propriétaire, ce mois et cette version. */
	async saveDraft(
		tx: Tx,
		organizationId: string,
		ownerId: string,
		month: string,
		version: number,
		correctsStatementId: string | null,
		actor: AuditActor,
		origin?: AuditOrigin
	): Promise<StatementRow> {
		const { result, snapshot } = await this.compute(tx, ownerId, month, version);
		const generatedBy = actor.type === 'user' ? actor.userId : null;
		const [draft] = await tx
			.select()
			.from(ownerStatements)
			.where(and(eq(ownerStatements.ownerId, ownerId), eq(ownerStatements.month, month), eq(ownerStatements.version, version)))
			.limit(1)
			.for('update');
		let row: StatementRow;
		if (draft) {
			if (draft.status === 'issued') throw new AppError('STATEMENT_ALREADY_ISSUED', ISSUE_MESSAGES.STATEMENT_ALREADY_ISSUED, 409);
			[row] = (await tx
				.update(ownerStatements)
				.set({ ...this.totalsColumns(result), snapshot, generatedAt: new Date(), generatedBy })
				.where(eq(ownerStatements.id, draft.id))
				.returning()) as [StatementRow];
		} else {
			[row] = (await tx
				.insert(ownerStatements)
				.values({
					id: newId(),
					organizationId,
					ownerId,
					month,
					version,
					correctsStatementId,
					status: 'draft',
					...this.totalsColumns(result),
					snapshot,
					generatedBy
				})
				.returning()) as [StatementRow];
		}
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'statement.generate',
			objectType: 'owner_statement',
			objectId: row.id,
			after: { ownerId, month, version, net: result.totals.net, revision: result.revision },
			...(origin ? { origin } : {})
		});
		return row;
	}

	// ---------------------------------------------------------------- lecture

	private assertAgency(c: CollectionsContext): void {
		if (c.organizationType === 'landlord') {
			throw new AppError('STATEMENT_LANDLORD', 'Un bailleur particulier n’a pas de relevé propriétaire.', 409);
		}
	}

	private async row(tx: Tx, id: string, lock = false): Promise<StatementRow> {
		const q = tx.select().from(ownerStatements).where(eq(ownerStatements.id, id)).limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw STATEMENT_NOT_FOUND();
		return row;
	}

	private async payoutsOf(tx: Tx, statementId: string): Promise<PayoutRow[]> {
		return tx
			.select()
			.from(ownerPayouts)
			.where(eq(ownerPayouts.statementId, statementId))
			.orderBy(asc(ownerPayouts.createdAt), asc(ownerPayouts.id));
	}

	private async detailOf(tx: Tx, row: StatementRow): Promise<StatementDetailView> {
		const payouts = (await this.payoutsOf(tx, row.id)).map(payoutView);
		const paidOut = payoutsTotal(payouts);
		return {
			...statementSummary(row),
			document: statementDocument({ ...(row.snapshot as StatementSnapshot), issuedOn: row.issuedOn }),
			payouts,
			paidOut,
			remaining: Math.max(0, row.net - paidOut)
		};
	}

	async list(filter: { ownerId?: string; month?: string; cursor?: string | null; limit: number }): Promise<Page<StatementSummaryView>> {
		const c = collectionsContext();
		this.assertAgency(c);
		const rows = await c.tx
			.select()
			.from(ownerStatements)
			.where(
				and(
					filter.ownerId ? eq(ownerStatements.ownerId, filter.ownerId) : undefined,
					filter.month ? eq(ownerStatements.month, filter.month) : undefined,
					filter.cursor ? lt(ownerStatements.id, filter.cursor) : undefined
				)
			)
			.orderBy(desc(ownerStatements.id))
			.limit(filter.limit + 1);
		const items = rows.slice(0, filter.limit).map(statementSummary);
		return { items, nextCursor: rows.length > filter.limit ? items.at(-1)!.id : null };
	}

	async get(id: string): Promise<StatementDetailView> {
		const c = collectionsContext();
		this.assertAgency(c);
		return this.detailOf(c.tx, await this.row(c.tx, id));
	}

	// ---------------------------------------------------------------- brouillon, émission, rectificatif

	/** Brouillon du mois (version 1), recalculé à la demande ; un mois déjà émis se corrige par un rectificatif. */
	async generate(ownerId: string, month: string): Promise<StatementDetailView> {
		const c = collectionsContext();
		this.assertAgency(c);
		const row = await this.saveDraft(c.tx, c.organizationId, ownerId, month, 1, null, c.actor);
		return this.detailOf(c.tx, row);
	}

	/**
	 * Émission : recalcul, règles d'émission (mois terminé, ordre, rectificatif du dernier émis, brouillon à jour), quota
	 * Découverte (relevés du mois civil, rectificatifs non comptés), puis relevé figé et éléments consommés, dans la même
	 * transaction. Le PDF part en tâche de fond.
	 */
	async issue(id: string, expectedRevision: string): Promise<StatementDetailView> {
		const c = collectionsContext();
		this.assertAgency(c);
		const draft = await this.row(c.tx, id, true);
		if (draft.status === 'issued') throw new AppError('STATEMENT_ALREADY_ISSUED', ISSUE_MESSAGES.STATEMENT_ALREADY_ISSUED, 409);
		const today = toIsoDate();
		const { result, snapshot } = await this.compute(c.tx, draft.ownerId, draft.month, draft.version);
		const issued = await this.issuedOf(c.tx, draft.ownerId);
		const [blocker] = statementIssueBlockers({
			kind: draft.version === 1 ? 'regular' : 'rectification',
			month: draft.month,
			today,
			lastIssuedMonth: issued.at(-1)?.month ?? null,
			hasContent: statementHasContent(result),
			expectedRevision,
			revision: result.revision
		});
		if (blocker)
			throw new AppError(blocker, ISSUE_MESSAGES[blocker], 409, blocker === 'STATEMENT_DRAFT_STALE' ? { revision: result.revision } : {});
		if (draft.version === 1) {
			const month = await c.tx
				.select({ issuedOn: ownerStatements.issuedOn, version: ownerStatements.version })
				.from(ownerStatements)
				.where(and(eq(ownerStatements.status, 'issued'), sql`${ownerStatements.issuedOn} >= ${monthStart(monthOfDate(today))}`));
			const used = statementQuotaUsed(
				month.map((m) => ({ issuedOn: m.issuedOn!, version: m.version })),
				today
			);
			await this.quotas.assert(c.organizationId, c.planId, 'owner_statements', used);
		}
		const [row] = await c.tx
			.update(ownerStatements)
			.set({
				...this.totalsColumns(result),
				snapshot: { ...snapshot, issuedOn: today },
				status: 'issued',
				issuedBy: c.userId
			})
			.where(eq(ownerStatements.id, id))
			.returning();
		if (result.consumed.length) {
			await c.tx.insert(ownerStatementLines).values(
				result.consumed.map((item) => {
					const kind = statementItemKind(item.key);
					const rest = item.key.slice(kind.length + 1);
					return {
						id: newId(),
						organizationId: c.organizationId,
						statementId: id,
						kind,
						role: item.role,
						allocationId: kind === 'allocation' ? rest : null,
						expenseId: kind === 'expense' || kind === 'expense_cancellation' ? rest : null,
						mandateId: kind === 'monthly_fee' ? rest.slice(0, rest.lastIndexOf(':')) : null,
						feeMonth: kind === 'monthly_fee' ? rest.slice(rest.lastIndexOf(':') + 1) : null,
						leaseId: kind === 'operation_fee' ? rest : null,
						carriedStatementId: kind === 'carried_balance' ? rest : null
					};
				})
			);
		}
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'statement.issue',
			objectType: 'owner_statement',
			objectId: id,
			before: { status: 'draft' },
			after: {
				status: 'issued',
				ownerId: draft.ownerId,
				month: draft.month,
				version: draft.version,
				totals: result.totals,
				items: result.consumed.length
			}
		});
		const organizationId = c.organizationId;
		RequestContext.afterCommit(async () => {
			await this.queue.add(STATEMENT_PDF_JOB, { organizationId, statementId: id }, { jobId: `statement-pdf-${id}` });
		});
		return this.detailOf(c.tx, row!);
	}

	/** Rectificatif du dernier relevé émis : brouillon de la version suivante, qui ne reprend que les éléments nouveaux. */
	async rectify(id: string): Promise<StatementDetailView> {
		const c = collectionsContext();
		this.assertAgency(c);
		const st = await this.row(c.tx, id);
		if (st.status !== 'issued') throw new AppError('STATEMENT_NOT_ISSUED', 'Seul un relevé émis se rectifie.', 409);
		const last = (await this.issuedOf(c.tx, st.ownerId)).at(-1);
		if (last?.id !== st.id)
			throw new AppError('STATEMENT_RECTIFICATION_NOT_LATEST', ISSUE_MESSAGES.STATEMENT_RECTIFICATION_NOT_LATEST, 409);
		const row = await this.saveDraft(c.tx, c.organizationId, st.ownerId, st.month, st.version + 1, st.id, c.actor);
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'statement.rectify',
			objectType: 'owner_statement',
			objectId: row.id,
			after: { corrects: st.id, month: st.month, version: st.version + 1 }
		});
		return this.detailOf(c.tx, row);
	}

	// ---------------------------------------------------------------- PDF et lien partagé

	async pdfUrl(id: string): Promise<{ url: string; expiresInSeconds: number }> {
		const c = collectionsContext();
		this.assertAgency(c);
		const st = await this.row(c.tx, id);
		if (!st.pdfKey) throw new AppError('STATEMENT_PDF_PENDING', 'Le PDF de ce relevé n’est pas encore prêt.', 404);
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'statement.download',
			objectType: 'owner_statement',
			objectId: id
		});
		return {
			url: await this.storage.presignGet(st.pdfKey, { expiresInSeconds: 300, contentType: 'application/pdf' }),
			expiresInSeconds: 300
		};
	}

	private webOrigin(): string {
		return (this.config.WEB_PUBLIC_URL ?? this.config.CORS_ORIGINS[0]!).replace(/\/$/, '');
	}

	/** Nouveau lien /s/<jeton> (90 jours) ; le jeton n'est renvoyé qu'ici, la base n'en garde que l'empreinte. */
	async shareLink(id: string): Promise<StatementShareLinkView> {
		const c = collectionsContext();
		this.assertAgency(c);
		const st = await this.row(c.tx, id);
		if (st.status !== 'issued') throw new AppError('STATEMENT_NOT_ISSUED', 'Un brouillon ne se partage pas : émettez le relevé.', 409);
		const token = newStatementToken();
		// Création et expiration posées ensemble : la base vérifie « 90 jours au plus après la création ».
		const createdAt = new Date();
		const expiresAt = statementTokenExpiry(createdAt);
		await c.tx.insert(ownerStatementTokens).values({
			id: newId(),
			organizationId: c.organizationId,
			statementId: id,
			tokenHash: tokenHash(token),
			createdBy: c.userId,
			createdAt,
			expiresAt
		});
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'statement.share_link',
			objectType: 'owner_statement',
			objectId: id,
			after: { expiresAt: expiresAt.toISOString() }
		});
		return { token, url: `${this.webOrigin()}/s/${token}`, expiresAt: expiresAt.toISOString() };
	}

	async revokeLinks(id: string): Promise<{ revoked: number }> {
		const c = collectionsContext();
		this.assertAgency(c);
		await this.row(c.tx, id);
		const revoked = await c.tx
			.update(ownerStatementTokens)
			.set({ revokedAt: new Date(), revokedBy: c.userId })
			.where(and(eq(ownerStatementTokens.statementId, id), isNull(ownerStatementTokens.revokedAt)))
			.returning({ id: ownerStatementTokens.id });
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'statement.share_revoke',
			objectType: 'owner_statement',
			objectId: id,
			after: { revoked: revoked.length }
		});
		return { revoked: revoked.length };
	}

	/** Lien partagé : organisation et relevé d'un jeton actif, non expiré (fonction de la base), puis lecture sous la RLS. */
	private async shareTarget(token: string): Promise<{ organizationId: string; statementId: string } | null> {
		return this.database.withTransaction(async (tx) => {
			const r = await tx.execute(sql`select organization_id, statement_id from statement_share_target(${tokenHash(token)})`);
			const row = r.rows[0] as { organization_id: string; statement_id: string } | undefined;
			return row ? { organizationId: row.organization_id, statementId: row.statement_id } : null;
		});
	}

	async shared(token: string): Promise<SharedStatementView | null> {
		const target = await this.shareTarget(token);
		if (!target) return null;
		return this.database.withOrganization(target.organizationId, async (tx) => {
			const [row] = await tx.select().from(ownerStatements).where(eq(ownerStatements.id, target.statementId)).limit(1);
			if (!row || row.status !== 'issued') return null;
			return {
				document: statementDocument({ ...(row.snapshot as StatementSnapshot), issuedOn: row.issuedOn }),
				issuedOn: row.issuedOn,
				pdfAvailable: !!row.pdfKey
			};
		});
	}

	async sharedPdfUrl(token: string): Promise<string | null> {
		const target = await this.shareTarget(token);
		if (!target) return null;
		const key = await this.database.withOrganization(
			target.organizationId,
			async (tx) =>
				(
					await tx.select({ key: ownerStatements.pdfKey }).from(ownerStatements).where(eq(ownerStatements.id, target.statementId)).limit(1)
				)[0]?.key
		);
		return key ? this.storage.presignGet(key, { expiresInSeconds: 300, contentType: 'application/pdf' }) : null;
	}

	/** PDF d'un relevé émis (tâche de fond) ; écrit une fois, jamais écrasé. */
	async renderPdf(organizationId: string, statementId: string): Promise<string | null> {
		return this.database.withOrganization(organizationId, async (tx) => {
			const [row] = await tx.select().from(ownerStatements).where(eq(ownerStatements.id, statementId)).limit(1).for('update');
			if (!row || row.status !== 'issued') return null;
			if (row.pdfKey) return row.pdfKey;
			const pdf = await renderStatementPdf(statementDocument({ ...(row.snapshot as StatementSnapshot), issuedOn: row.issuedOn }));
			const key = `statements/${organizationId}/${statementId}/${newId()}.pdf`;
			await this.storage.put(key, pdf, 'application/pdf');
			await tx.update(ownerStatements).set({ pdfKey: key, pdfGeneratedAt: new Date() }).where(eq(ownerStatements.id, statementId));
			return key;
		});
	}

	// ---------------------------------------------------------------- tâche mensuelle

	/**
	 * Brouillons du mois pour chaque propriétaire qui a un mandat donnant lieu à un relevé, dans chaque organisation
	 * concernée (fonction de la base), sous la RLS ; jamais pour un mois déjà émis ; jamais si l'interrupteur est coupé
	 * pour l'organisation (désactiver ne supprime rien, les nouvelles actions sont bloquées).
	 */
	async monthlyDrafts(month: string): Promise<{ organizations: number; drafts: number }> {
		const orgs = await this.database.withTransaction(async (tx) => {
			const r = await tx.execute(sql`select statement_organizations() as id`);
			return (r.rows as { id: string }[]).map((x) => x.id);
		});
		let drafts = 0;
		for (const organizationId of orgs) {
			drafts += await this.database.withOrganization(organizationId, async (tx) => {
				const org = await this.organizations.view(tx);
				const resolution = await this.features.resolve(
					'collections.owner_statements',
					null,
					await this.features.organizationContext(organizationId, org.planId, tx)
				);
				if (!resolution.enabled) return 0;
				const owners = [
					...new Set(
						(await this.owners.statementMandates(tx)).filter((m) => STATEMENT_MANDATE_TYPES.includes(m.type)).map((m) => m.ownerId)
					)
				];
				let n = 0;
				for (const ownerId of owners) {
					const [issued] = await tx
						.select({ id: ownerStatements.id })
						.from(ownerStatements)
						.where(
							and(eq(ownerStatements.ownerId, ownerId), eq(ownerStatements.status, 'issued'), sql`${ownerStatements.month} >= ${month}`)
						)
						.limit(1);
					if (issued) continue;
					await this.saveDraft(tx, organizationId, ownerId, month, 1, null, { type: 'system' }, 'job');
					n += 1;
				}
				return n;
			});
		}
		return { organizations: orgs.length, drafts };
	}

	// ---------------------------------------------------------------- reversements

	async payouts(statementId: string): Promise<PayoutView[]> {
		const c = collectionsContext();
		this.assertAgency(c);
		return (await this.payoutsOf(c.tx, statementId)).map(payoutView);
	}

	/** Reversement enregistré (jamais exécuté par la plateforme, règle 5), idempotent par identifiant. */
	async recordPayout(input: PayoutData): Promise<PayoutView> {
		const c = collectionsContext();
		this.assertAgency(c);
		const [existing] = await c.tx.select().from(ownerPayouts).where(eq(ownerPayouts.id, input.id)).limit(1);
		if (existing) return payoutView(existing);
		const st = await this.row(c.tx, input.statementId, true);
		const already = payoutsTotal((await this.payoutsOf(c.tx, st.id)).map(payoutView));
		const [blocker] = payoutBlockers({
			statementStatus: st.status,
			net: st.net,
			alreadyPaid: already,
			amount: input.amount,
			paidOn: input.paidOn,
			today: toIsoDate()
		});
		if (blocker) {
			const messages = {
				STATEMENT_NOT_ISSUED: 'On ne reverse que sur un relevé émis.',
				PAYOUT_NOTHING_DUE: 'Rien à reverser sur ce relevé.',
				PAYOUT_EXCEEDS_NET: 'Ce reversement dépasse le reste à reverser sur ce relevé.',
				PAYOUT_DATE_IN_FUTURE: 'La date du reversement est dans le futur.'
			};
			throw new AppError(blocker, messages[blocker], blocker === 'PAYOUT_DATE_IN_FUTURE' ? 400 : 409, {
				remaining: Math.max(0, st.net - already)
			});
		}
		const [row] = await c.tx
			.insert(ownerPayouts)
			.values({
				id: input.id,
				organizationId: c.organizationId,
				kind: 'payout',
				ownerId: st.ownerId,
				statementId: st.id,
				amount: input.amount,
				paidOn: input.paidOn,
				method: input.method,
				reference: input.reference,
				note: input.note,
				recordedBy: c.userId
			})
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'payout.record',
			objectType: 'owner_payout',
			objectId: input.id,
			after: { statementId: st.id, ownerId: st.ownerId, amount: input.amount, paidOn: input.paidOn, method: input.method }
		});
		return payoutView(row!);
	}

	/** Contre-écriture d'un reversement (directeur, motif obligatoire) : le reversement reste, compensé à l'identique. */
	async cancelPayout(id: string, reason: string): Promise<PayoutView> {
		const c = collectionsContext();
		this.assertAgency(c);
		const [p] = await c.tx.select().from(ownerPayouts).where(eq(ownerPayouts.id, id)).limit(1);
		if (!p || p.kind !== 'payout') throw PAYOUT_NOT_FOUND();
		const [reversed] = await c.tx.select({ id: ownerPayouts.id }).from(ownerPayouts).where(eq(ownerPayouts.reversesPayoutId, id)).limit(1);
		if (reversed) throw new AppError('PAYOUT_ALREADY_CANCELLED', 'Ce reversement est déjà annulé.', 409);
		const [row] = await c.tx
			.insert(ownerPayouts)
			.values({
				id: newId(),
				organizationId: c.organizationId,
				kind: 'reversal',
				reversesPayoutId: id,
				ownerId: p.ownerId,
				statementId: p.statementId,
				amount: p.amount,
				paidOn: toIsoDate(),
				method: p.method,
				reason,
				recordedBy: c.userId
			})
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'payout.cancel',
			objectType: 'owner_payout',
			objectId: id,
			before: { amount: p.amount },
			after: { reversalId: row!.id, reason }
		});
		return payoutView(row!);
	}
}
