/**
 * Sortie du locataire (lot 10 bis, étape 3 ; D14, D15, D16, D32 ; règles 12 à 16) : préavis, états des lieux, réparations,
 * accords, décompte de caution, transfert de gestion. Service public du module leases : mêmes règles pour les routes et
 * pour la synchronisation ; les calculs sont ceux de packages/shared (`deposit-settlement.ts`, `tenant-exit.ts`), la base
 * (migrations 0019 et 0020) les applique en dernier rempart. Les autres modules sont joints par `ExitHooks`, jamais par
 * leurs tables (CLAUDE.md §4).
 */
import { Injectable } from '@nestjs/common';
import { toIsoDate } from '@ziga/shared/dates';
import {
	agreementPlan,
	computeSettlement,
	refundAlert,
	refundDeadline,
	repairRetention,
	settlementLineBlocker,
	UTILITY_BILL_CATEGORIES,
	type SettlementInput,
	type SettlementLine
} from '@ziga/shared/deposit-settlement';
import type {
	CloseSettlementData,
	CreateAgreementData,
	CreateInspectionData,
	CreateRepairData,
	DecideAgreementData,
	DisputeData,
	DisputeOutcomeData,
	InspectionDocumentData,
	InspectionItemData,
	ManagementTransferData,
	RecordNoticeData,
	RefundData,
	RepairDoneData,
	SettlementLineInputData,
	SignInspectionData,
	UpdateInspectionItemData
} from '@ziga/shared/exit-schemas';
import { inspectionCheckboxLabel } from '@ziga/shared/exit-schemas';
import { newId } from '@ziga/shared/ids';
import { can, type OrganizationRole } from '@ziga/shared/permissions';
import {
	agreementDecisionBlocker,
	agreementProposalBlocker,
	managementTransferBlocker,
	managementTransferPlan,
	noticeBlocker,
	noticeTerms,
	TRANSFER_DEPOSIT_HOLDER
} from '@ziga/shared/tenant-exit';
import { and, asc, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext, type AuditOrigin } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import {
	agreements,
	depositAccounts,
	depositMovements,
	depositSettlementLines,
	depositSettlements,
	inspectionItems,
	inspections,
	leaseNotices,
	leases,
	rentDues,
	repairs
} from '../../db/schema/leases.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { OwnersService } from '../owners/owners.service.js';
import { PropertiesService } from '../properties/properties.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { ExitHooks } from './exit-hooks.js';
import { endLeaseAtExit, exitDuesPlan } from './leases-daily.js';

type LeaseRow = typeof leases.$inferSelect;
type SettlementRow = typeof depositSettlements.$inferSelect;
type Row = Record<string, unknown>;

interface Ctx {
	tx: Tx;
	organizationId: string;
	role: OrganizationRole;
	userId: string;
	actor: AuditActor;
	origin: AuditOrigin | undefined;
}

const NOT_FOUND = (what: string, code: string) => new AppError(code, `${what} introuvable.`, 404);

/**
 * Photo prise sur place avant la signature, arrivée après elle (hors ligne, les cases cochées et les photos repartent
 * ensemble) : acceptée si l'heure de prise de vue de l'appareil précède la dernière case cochée, dans les 30 jours qui
 * suivent (même tolérance que l'heure d'une case cochée). Jamais un scan, jamais un état des lieux contesté.
 */
function takenBeforeSignature(
	insp: { status: string; organizationSignedAt: Date | null; tenantSignedAt: Date | null },
	input: { type: string; takenAt: string | null }
): boolean {
	if (insp.status !== 'signed_both' || input.type !== 'inspection_photo' || !input.takenAt) return false;
	const signed = Math.max(insp.organizationSignedAt?.getTime() ?? 0, insp.tenantSignedAt?.getTime() ?? 0);
	const taken = Date.parse(input.takenAt);
	return signed > 0 && taken <= signed && Date.now() - signed < 30 * 86_400_000;
}
const LEASE_NOT_FOUND = () => NOT_FOUND('Bail', 'LEASE_NOT_FOUND');
const INSPECTION_NOT_FOUND = () => NOT_FOUND('État des lieux', 'INSPECTION_NOT_FOUND');
const SETTLEMENT_NOT_FOUND = () => NOT_FOUND('Décompte', 'SETTLEMENT_NOT_FOUND');

/** Instants en ISO, le reste tel quel : la vue renvoyée à l'écran. */
function plain<T extends object>(row: T): Row {
	const out: Row = {};
	for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
	return out;
}

const SETTLEMENT_LINE_MESSAGES: Record<string, string> = {
	RETENTION_NOT_TENANT_DAMAGE: 'Une retenue vise une ligne d’état des lieux imputable au locataire.',
	RETENTION_AMOUNT_MISSING: 'Une retenue a un montant (devis ou facture).',
	RETENTION_PROOF_MISSING: 'Une retenue a son justificatif (devis ou facture).',
	AGREEMENT_MISSING: 'Sans accord d’imputation sur loyer, la caution ne paie pas de loyer.',
	AGREEMENT_NOT_ACCEPTED: 'L’accord d’imputation sur loyer n’est pas accepté.',
	AGREEMENT_AFTER_PERIOD: 'L’accord est accepté après le début du mois concerné.',
	AGREEMENT_MONTH_NOT_COVERED: 'L’accord ne couvre pas ce mois.',
	AGREEMENT_PERIOD_AFTER_EXIT: 'Ce mois est après le départ.',
	LINE_NOT_FOR_ACCOUNT: 'Cette ligne ne relève pas de ce compte.',
	AMOUNT_INVALID: 'Montant invalide.',
	DEBT_NOTHING_DUE: 'Rien n’est dû.',
	DEBT_PROOF_MISSING: 'La dépense n’a pas de justificatif.',
	DEBT_NOT_CLAIMED: 'La dépense n’est pas réclamée au locataire.',
	DEBT_NOT_UTILITY_BILL: 'La garantie des factures ne couvre que l’eau et l’électricité.'
};

@Injectable()
export class ExitService {
	constructor(
		private readonly audit: AuditService,
		private readonly properties: PropertiesService,
		private readonly owners: OwnersService,
		private readonly organizations: OrganizationsService,
		private readonly hooks: ExitHooks,
		private readonly documents: DocumentsService
	) {}

	private context(origin?: AuditOrigin): Ctx {
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		return {
			tx: RequestContext.tx(),
			organizationId: scope.organizationId,
			role: scope.role,
			userId,
			actor: { type: 'user', userId, role: scope.role },
			origin
		};
	}

	private async record(c: Ctx, action: string, objectType: string, objectId: string, after: Row, before?: Row): Promise<void> {
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action,
			objectType,
			objectId,
			after,
			...(before ? { before } : {}),
			...(c.origin ? { origin: c.origin } : {})
		});
	}

	/** Bail de l'organisation ; l'agent de terrain n'atteint que ceux de ses unités affectées. */
	private async lease(c: Ctx, id: string, lock = false): Promise<LeaseRow> {
		const q = c.tx
			.select()
			.from(leases)
			.where(and(eq(leases.organizationId, c.organizationId), eq(leases.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw LEASE_NOT_FOUND();
		const units = await this.properties.assignedUnitIds();
		if (units && !units.includes(row.unitId)) throw LEASE_NOT_FOUND();
		return row;
	}

	// ---------------------------------------------------------------- préavis

	/** Congé enregistré (lease.notice) : délais et indemnité du bail (D24, D32) ; le bail passe en préavis. */
	async recordNotice(leaseId: string, input: RecordNoticeData, origin?: AuditOrigin): Promise<Row> {
		const c = this.context(origin);
		const [existing] = await c.tx.select().from(leaseNotices).where(eq(leaseNotices.id, input.id)).limit(1);
		if (existing) return plain(existing);
		const lease = await this.lease(c, leaseId, true);
		const terms = {
			status: lease.status,
			endsOn: lease.endsOn,
			rent: lease.rent,
			noticeTenantFixedTermMonths: lease.noticeTenantFixedTermMonths,
			noticeTenantOpenEndedMonths: lease.noticeTenantOpenEndedMonths,
			noticeLessorFixedTermMonths: lease.noticeLessorFixedTermMonths,
			noticeLessorOpenEndedMonths: lease.noticeLessorOpenEndedMonths,
			reducedNoticeMonths: lease.reducedNoticeMonths,
			earlyTerminationIndemnityMonths: lease.earlyTerminationIndemnityMonths
		};
		const notice = { ...input, today: toIsoDate() };
		const blocker = noticeBlocker(terms, notice);
		if (blocker) throw new AppError(blocker, NOTICE_MESSAGES[blocker]!, 409);
		const t = noticeTerms(terms, notice);
		const now = new Date();
		const [row] = await c.tx
			.insert(leaseNotices)
			.values({
				id: input.id,
				organizationId: c.organizationId,
				leaseId,
				origin: input.origin,
				status: 'recorded',
				deliveryMode: input.deliveryMode,
				proofDocumentId: input.proofDocumentId,
				notifiedOn: input.notifiedOn,
				plannedExitOn: input.plannedExitOn,
				reducedNotice: input.reducedNotice,
				reason: input.reason,
				noticeMonths: t.months,
				noticeEndsOn: t.noticeEndsOn,
				rentEndsOn: t.rentEndsOn,
				earlyTerminationIndemnity: t.earlyTerminationIndemnity,
				recordedAt: now,
				recordedBy: c.userId,
				createdBy: c.userId
			})
			.returning();
		await c.tx
			.update(leases)
			.set({ status: 'notice', noticeGivenOn: input.notifiedOn, exitOn: input.plannedExitOn, updatedBy: c.userId, updatedAt: now })
			.where(and(eq(leases.organizationId, c.organizationId), eq(leases.id, leaseId)));
		await this.record(
			c,
			'lease.notice',
			'lease',
			leaseId,
			{ noticeId: input.id, origin: input.origin, ...t, plannedExitOn: input.plannedExitOn },
			{
				status: lease.status
			}
		);
		return plain(row!);
	}

	// ---------------------------------------------------------------- vue de la sortie

	/**
	 * La sortie d'un bail : congés, états des lieux et lignes (avec le libellé de chaque signature), et, pour qui lit la
	 * caution (`deposit.read`), réparations, accords et décomptes avec leurs lignes. L'agent de terrain ne reçoit que les
	 * congés enregistrés (sans indemnité ni preuve) et les états des lieux de ses unités.
	 */
	async exitOf(leaseId: string): Promise<Row> {
		const c = this.context();
		const lease = await this.lease(c, leaseId);
		const money = can(c.role, 'deposit.read');
		const notices = (await c.tx.select().from(leaseNotices).where(eq(leaseNotices.leaseId, lease.id)).orderBy(asc(leaseNotices.createdAt)))
			.filter((n) => money || n.status === 'recorded')
			.map((n) => {
				const v = plain(n);
				if (!money) for (const k of ['earlyTerminationIndemnity', 'proofDocumentId', 'reason', 'declinedReason']) delete v[k];
				return v;
			});
		const insp = await c.tx.select().from(inspections).where(eq(inspections.leaseId, lease.id)).orderBy(asc(inspections.createdAt));
		const items = insp.length
			? await c.tx
					.select()
					.from(inspectionItems)
					.where(
						inArray(
							inspectionItems.inspectionId,
							insp.map((i) => i.id)
						)
					)
					.orderBy(asc(inspectionItems.position), asc(inspectionItems.id))
			: [];
		const views = [];
		for (const i of insp)
			views.push({ ...plain(i), signatures: await this.signatures(c, i), items: items.filter((x) => x.inspectionId === i.id).map(plain) });
		const out: Row = { leaseId: lease.id, status: lease.status, exitOn: lease.exitOn, endKind: lease.endKind, notices, inspections: views };
		if (!money) return out;
		out.repairs = (await c.tx.select().from(repairs).where(eq(repairs.leaseId, lease.id)).orderBy(asc(repairs.createdAt))).map(plain);
		out.agreements = (await c.tx.select().from(agreements).where(eq(agreements.leaseId, lease.id)).orderBy(asc(agreements.createdAt))).map(
			plain
		);
		const settlements = await c.tx.select().from(depositSettlements).where(eq(depositSettlements.leaseId, lease.id));
		const today = toIsoDate();
		out.settlements = [];
		for (const s of settlements) (out.settlements as Row[]).push(await this.settlementView(c, s, today));
		return out;
	}

	private async settlementView(c: Ctx, s: SettlementRow, today: string): Promise<Row> {
		const lines = await c.tx
			.select()
			.from(depositSettlementLines)
			.where(and(eq(depositSettlementLines.settlementId, s.id), eq(depositSettlementLines.revision, s.revision)))
			.orderBy(asc(depositSettlementLines.position));
		const movements = await c.tx
			.select()
			.from(depositMovements)
			.where(eq(depositMovements.settlementId, s.id))
			.orderBy(asc(depositMovements.createdAt));
		const refunded = movements.filter((m) => m.type === 'refunded').reduce((sum, m) => sum + m.amount, 0);
		return {
			...plain(s),
			lines: lines.map(plain),
			movements: movements.map(plain),
			alreadyRefunded: refunded,
			refundRemaining: Math.max(0, s.refundFromDeposit - refunded),
			alert: refundAlert(today, s.refundDeadline, s.status === 'closed')
		};
	}

	/** « Case cochée par … le … sur l'appareil de … », ou scan déposé : jamais une signature électronique (D21). */
	private async signatures(c: Ctx, i: typeof inspections.$inferSelect): Promise<Row> {
		const name = async (id: string | null) => (id ? ((await this.organizations.memberName(id, c.tx)) ?? 'un membre') : null);
		const organizationName = await name(i.organizationSignedBy);
		const recorderName = await name(i.tenantSignedRecordedBy);
		return {
			organization:
				i.organizationSignedAt && organizationName
					? inspectionCheckboxLabel({
							signerName: organizationName,
							signedAt: i.organizationSignedAt.toISOString(),
							deviceOwnerName: organizationName
						})
					: null,
			tenant:
				i.tenantSignedAt && recorderName
					? inspectionCheckboxLabel({ signerName: 'le locataire', signedAt: i.tenantSignedAt.toISOString(), deviceOwnerName: recorderName })
					: null,
			scanDocumentId: i.scanDocumentId
		};
	}

	// ---------------------------------------------------------------- états des lieux

	async createInspection(input: CreateInspectionData, origin?: AuditOrigin): Promise<Row> {
		const c = this.context(origin);
		const [existing] = await c.tx.select().from(inspections).where(eq(inspections.id, input.id)).limit(1);
		if (existing) return plain(existing);
		await this.lease(c, input.leaseId);
		const [row] = await c.tx
			.insert(inspections)
			.values({ ...input, organizationId: c.organizationId, status: 'draft', performedBy: c.userId, createdBy: c.userId })
			.returning();
		await this.record(c, 'inspection.create', 'inspection', input.id, {
			leaseId: input.leaseId,
			type: input.type,
			inspectedOn: input.inspectedOn
		});
		return plain(row!);
	}

	private async inspection(c: Ctx, id: string, lock = false) {
		const q = c.tx.select().from(inspections).where(eq(inspections.id, id)).limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw INSPECTION_NOT_FOUND();
		await this.lease(c, row.leaseId).catch(() => {
			throw INSPECTION_NOT_FOUND();
		});
		return row;
	}

	private async item(c: Ctx, id: string) {
		const [row] = await c.tx.select().from(inspectionItems).where(eq(inspectionItems.id, id)).limit(1);
		if (!row) throw NOT_FOUND('Ligne d’état des lieux', 'INSPECTION_ITEM_NOT_FOUND');
		await this.inspection(c, row.inspectionId);
		return row;
	}

	/**
	 * Étape 4 : photo d'une ligne, ou scan signé, d'un état des lieux encore en brouillon. L'agent de terrain les dépose
	 * sur ses unités (`inspection.create`), sans le droit général de déposer des documents ; le module documents garde
	 * la fiche, l'envoi signé et le contrôle du fichier.
	 */
	async inspectionDocument(inspectionId: string, input: InspectionDocumentData) {
		const c = this.context();
		const insp = await this.inspection(c, inspectionId);
		if (insp.status !== 'draft' && !takenBeforeSignature(insp, input)) {
			throw new AppError('INSPECTION_LOCKED', 'Un état des lieux signé ou contesté ne change plus.', 409);
		}
		if (input.inspectionItemId) {
			const item = await this.item(c, input.inspectionItemId);
			if (item.inspectionId !== inspectionId) throw NOT_FOUND('Ligne d’état des lieux', 'INSPECTION_ITEM_NOT_FOUND');
		}
		const lease = await this.lease(c, insp.leaseId);
		const unit = await this.properties.getUnit(lease.unitId);
		const { takenAt: _takenAt, ...file } = input;
		return this.documents.createForInspection({
			...file,
			propertyId: unit.propertyId,
			unitId: lease.unitId,
			leaseId: lease.id,
			inspectionId
		});
	}

	/** Envoi du fichier (URL signée) puis réception contrôlée, pour un document de cet état des lieux seulement. */
	async inspectionDocumentStep(inspectionId: string, documentId: string, step: 'upload-url' | 'uploaded') {
		const c = this.context();
		await this.inspection(c, inspectionId);
		await this.documents.inspectionDocument(documentId, inspectionId);
		return step === 'upload-url'
			? this.documents.uploadUrl(documentId, { assignedUnit: true })
			: this.documents.uploaded(documentId, { assignedUnit: true });
	}

	async addItem(inspectionId: string, input: InspectionItemData, origin?: AuditOrigin): Promise<Row> {
		const c = this.context(origin);
		const [existing] = await c.tx.select().from(inspectionItems).where(eq(inspectionItems.id, input.id)).limit(1);
		if (existing) return plain(existing);
		await this.inspection(c, inspectionId, true);
		const [row] = await c.tx
			.insert(inspectionItems)
			.values({ ...input, organizationId: c.organizationId, inspectionId, createdBy: c.userId })
			.returning();
		await this.record(c, 'inspection.item_add', 'inspection', inspectionId, {
			itemId: input.id,
			room: input.room,
			element: input.element,
			finding: input.finding
		});
		return plain(row!);
	}

	async updateItem(itemId: string, input: UpdateInspectionItemData, origin?: AuditOrigin): Promise<Row> {
		const c = this.context(origin);
		const before = await this.item(c, itemId);
		const [row] = await c.tx.update(inspectionItems).set(input).where(eq(inspectionItems.id, itemId)).returning();
		await this.record(
			c,
			'inspection.item_update',
			'inspection',
			before.inspectionId,
			{ itemId, ...input },
			{ description: before.description, finding: before.finding }
		);
		return plain(row!);
	}

	async deleteItem(itemId: string, origin?: AuditOrigin): Promise<void> {
		const c = this.context(origin);
		const before = await this.item(c, itemId);
		await c.tx.delete(inspectionItems).where(eq(inspectionItems.id, itemId));
		await this.record(
			c,
			'inspection.item_remove',
			'inspection',
			before.inspectionId,
			{ itemId },
			{ room: before.room, element: before.element }
		);
	}

	/**
	 * Signature (point 5 du porteur) : la case cochée par une partie, sur l'appareil de la personne connectée, horodatée
	 * (heure de l'appareil si elle est plausible, sinon celle du serveur), ou le scan déposé. Signé des deux parties : figé.
	 */
	async sign(inspectionId: string, input: SignInspectionData, origin?: AuditOrigin, at?: Date): Promise<Row> {
		const c = this.context(origin);
		const before = await this.inspection(c, inspectionId, true);
		const now = new Date();
		const signedAt = at && at.getTime() <= now.getTime() + 5 * 60_000 && at.getTime() > now.getTime() - 30 * 86_400_000 ? at : now;
		const set: Partial<typeof inspections.$inferInsert> = { updatedAt: now };
		if ('scanDocumentId' in input) {
			set.scanDocumentId = input.scanDocumentId;
			set.status = 'signed_both';
		} else if (input.party === 'organization') {
			if (before.organizationSignedAt) return plain(before);
			set.organizationSignedAt = signedAt;
			set.organizationSignedBy = c.userId;
		} else {
			if (before.tenantSignedAt) return plain(before);
			set.tenantSignedAt = signedAt;
			set.tenantSignedRecordedBy = c.userId;
		}
		const both =
			set.status === 'signed_both' ||
			((set.organizationSignedAt ?? before.organizationSignedAt) && (set.tenantSignedAt ?? before.tenantSignedAt));
		if (both && before.status === 'draft') set.status = 'signed_both';
		const [row] = await c.tx.update(inspections).set(set).where(eq(inspections.id, inspectionId)).returning();
		await this.record(c, 'inspection.sign', 'inspection', inspectionId, {
			mode: 'scanDocumentId' in input ? 'scan' : 'checkbox',
			party: 'scanDocumentId' in input ? null : input.party,
			signedAt: signedAt.toISOString(),
			recordedBy: c.userId,
			status: row!.status
		});
		return plain(row!);
	}

	async disputeInspection(inspectionId: string, input: DisputeData): Promise<Row> {
		const c = this.context();
		await this.inspection(c, inspectionId, true);
		const column = input.party === 'tenant' ? { tenantObservations: input.observations } : { organizationObservations: input.observations };
		const [row] = await c.tx
			.update(inspections)
			.set({ ...column, status: 'disputed', disputedAt: new Date(), updatedAt: new Date() })
			.where(eq(inspections.id, inspectionId))
			.returning();
		await this.record(c, 'inspection.dispute', 'inspection', inspectionId, { party: input.party });
		return plain(row!);
	}

	async resolveInspection(inspectionId: string, input: DisputeOutcomeData): Promise<Row> {
		const c = this.context();
		await this.inspection(c, inspectionId, true);
		const [row] = await c.tx
			.update(inspections)
			.set({ status: 'signed_both', disputeOutcome: input.outcome, disputeOutcomeDocumentId: input.documentId, updatedAt: new Date() })
			.where(eq(inspections.id, inspectionId))
			.returning();
		await this.record(c, 'inspection.resolve', 'inspection', inspectionId, { outcome: input.outcome, documentId: input.documentId });
		return plain(row!);
	}

	// ---------------------------------------------------------------- réparations

	async createRepair(input: CreateRepairData): Promise<Row> {
		const c = this.context();
		const [existing] = await c.tx.select().from(repairs).where(eq(repairs.id, input.id)).limit(1);
		if (existing) return plain(existing);
		const item = await this.item(c, input.inspectionItemId);
		const insp = await this.inspection(c, item.inspectionId);
		const [row] = await c.tx
			.insert(repairs)
			.values({ ...input, organizationId: c.organizationId, leaseId: insp.leaseId, status: 'planned', createdBy: c.userId })
			.returning();
		await this.record(c, 'repair.create', 'repair', input.id, {
			inspectionItemId: input.inspectionItemId,
			performedBy: input.performedBy,
			estimatedAmount: input.estimatedAmount
		});
		return plain(row!);
	}

	private async repair(c: Ctx, id: string) {
		const [row] = await c.tx.select().from(repairs).where(eq(repairs.id, id)).limit(1).for('update');
		if (!row) throw NOT_FOUND('Réparation', 'REPAIR_NOT_FOUND');
		return row;
	}

	/** Faite : par l'organisation, avec sa facture, elle crée la dépense (supportée par le locataire, récupérée sur la caution). */
	async repairDone(id: string, input: RepairDoneData): Promise<Row> {
		const c = this.context();
		const r = await this.repair(c, id);
		let expenseId: string | null = null;
		if (r.performedBy === 'organization') {
			if (!input.actualAmount || !input.invoiceDocumentId) {
				throw new AppError('REPAIR_INVOICE_REQUIRED', 'Une réparation faite par l’organisation a son montant réel et sa facture.', 400);
			}
			const lease = await this.lease(c, r.leaseId);
			const unit = await this.properties.getUnit(lease.unitId);
			expenseId = input.expenseId ?? newId();
			await this.hooks.expenses.repairExpense({
				id: expenseId,
				propertyId: unit.propertyId,
				unitId: lease.unitId,
				leaseId: lease.id,
				spentOn: input.doneOn,
				amount: input.actualAmount,
				description: r.description,
				documentId: input.invoiceDocumentId
			});
		}
		const [row] = await c.tx
			.update(repairs)
			.set({
				status: 'done',
				doneOn: input.doneOn,
				actualAmount: input.actualAmount,
				invoiceDocumentId: input.invoiceDocumentId,
				expenseId,
				updatedAt: new Date()
			})
			.where(eq(repairs.id, id))
			.returning();
		await this.record(c, 'repair.done', 'repair', id, {
			actualAmount: input.actualAmount,
			invoiceDocumentId: input.invoiceDocumentId,
			expenseId
		});
		return plain(row!);
	}

	/** Contre-visite : une réparation faite par le locataire ne sort du décompte qu'à ce moment. */
	async repairVerify(id: string, verifiedOn: string): Promise<Row> {
		const c = this.context();
		await this.repair(c, id);
		const [row] = await c.tx
			.update(repairs)
			.set({ status: 'verified', verifiedOn, verifiedBy: c.userId, updatedAt: new Date() })
			.where(eq(repairs.id, id))
			.returning();
		await this.record(c, 'repair.verify', 'repair', id, { verifiedOn });
		return plain(row!);
	}

	// ---------------------------------------------------------------- accords

	async createAgreement(input: CreateAgreementData): Promise<Row> {
		const c = this.context();
		const [existing] = await c.tx.select().from(agreements).where(eq(agreements.id, input.id)).limit(1);
		if (existing) return plain(existing);
		await this.lease(c, input.leaseId);
		const blocker = agreementProposalBlocker(input, input.proposedOn);
		if (blocker) throw new AppError(blocker, 'Les mois imputés sont nommés et à venir.', 400);
		const [row] = await c.tx
			.insert(agreements)
			.values({ ...input, organizationId: c.organizationId, status: 'proposed', createdBy: c.userId })
			.returning();
		await this.record(c, 'agreement.propose', 'agreement', input.id, {
			type: input.type,
			proposedBy: input.proposedBy,
			months: input.months,
			keptAmount: input.keptAmount
		});
		return plain(row!);
	}

	async decideAgreement(id: string, input: DecideAgreementData): Promise<Row> {
		const c = this.context();
		const [a] = await c.tx.select().from(agreements).where(eq(agreements.id, id)).limit(1).for('update');
		if (!a) throw NOT_FOUND('Accord', 'AGREEMENT_NOT_FOUND');
		await this.lease(c, a.leaseId);
		const blocker = agreementDecisionBlocker({
			type: a.type,
			status: a.status,
			proposedBy: a.proposedBy,
			decidedBy: input.decidedByParty,
			decision: input.decision,
			reason: input.reason,
			documentId: input.documentId,
			months: a.months,
			decidedOn: input.decidedOn
		});
		if (blocker) throw new AppError(blocker, AGREEMENT_MESSAGES[blocker]!, 409);
		const [row] = await c.tx
			.update(agreements)
			.set({
				status: input.decision,
				decidedByParty: input.decidedByParty,
				decidedOn: input.decidedOn,
				decidedAt: new Date(),
				decidedBy: c.userId,
				refusalReason: input.decision === 'refused' ? input.reason : null,
				documentId: input.documentId,
				updatedAt: new Date()
			})
			.where(eq(agreements.id, id))
			.returning();
		await this.record(c, 'agreement.decide', 'agreement', id, {
			decision: input.decision,
			decidedByParty: input.decidedByParty,
			decidedOn: input.decidedOn
		});
		return plain(row!);
	}

	// ---------------------------------------------------------------- décompte de sortie

	/** Données du décompte, lues dans la base (et, par ExitHooks, chez payments et collections). */
	private async settlementInput(
		c: Ctx,
		accountId: string
	): Promise<{ input: SettlementInput; lease: LeaseRow; account: typeof depositAccounts.$inferSelect; alreadyRefunded: number }> {
		const [account] = await c.tx.select().from(depositAccounts).where(eq(depositAccounts.id, accountId)).limit(1);
		if (!account) throw NOT_FOUND('Compte de caution', 'DEPOSIT_ACCOUNT_NOT_FOUND');
		const lease = await this.lease(c, account.leaseId);
		const movements = await c.tx.select().from(depositMovements).where(eq(depositMovements.accountId, account.id));
		const sum = (type: string) => movements.filter((m) => m.type === type).reduce((s, m) => s + m.amount, 0);
		const received = sum('received') - sum('received_cancelled');
		const alreadyRefunded = sum('refunded');
		const exitOn = lease.exitOn ?? toIsoDate();
		const lines: SettlementLine[] = [];
		let exitExcess = 0;
		if (account.type === 'security_deposit') {
			// Réparations des lignes de sortie (règle 14) ; une réparation par le locataire, sur accord accepté.
			const rows = await c.tx
				.select({ r: repairs, finding: inspectionItems.finding })
				.from(repairs)
				.innerJoin(
					inspectionItems,
					and(eq(inspectionItems.organizationId, repairs.organizationId), eq(inspectionItems.id, repairs.inspectionItemId))
				)
				.where(eq(repairs.leaseId, lease.id))
				.orderBy(asc(repairs.createdAt));
			const agreed = new Set(
				(
					await c.tx
						.select()
						.from(agreements)
						.where(and(eq(agreements.leaseId, lease.id), eq(agreements.status, 'accepted')))
				).map((a) => a.id)
			);
			for (const { r, finding } of rows) {
				lines.push({
					id: r.id,
					kind: 'repair',
					inspectionItemId: r.inspectionItemId,
					finding,
					repairId: r.id,
					performedBy: r.performedBy,
					status: r.status,
					estimatedAmount: r.estimatedAmount,
					quoteDocumentId: r.quoteDocumentId,
					actualAmount: r.actualAmount,
					invoiceDocumentId: r.invoiceDocumentId,
					selfRepairAgreed: !!r.agreementId && agreed.has(r.agreementId),
					expenseId: r.expenseId
				});
			}
			// Loyers et charges impayés (les encaissements en attente d'abord) ; les mois couverts par un accord accepté.
			// Toujours jusqu'à la date de sortie : un bail encore en préavis compte ses dernières échéances comme la tâche
			// du jour les écrira (dernier mois au prorata, suivants exclus, surplus au crédit), sans rien écrire.
			const exitPlan = lease.status === 'notice' && lease.exitOn ? await exitDuesPlan(c.tx, lease) : null;
			const adjusted = new Map((exitPlan?.adjustments ?? []).map((a) => [a.id, a]));
			exitExcess = (exitPlan?.adjustments ?? []).reduce((s, a) => s + a.excessPaid, 0);
			const dues = (
				await c.tx
					.select()
					.from(rentDues)
					.where(and(eq(rentDues.leaseId, lease.id), ne(rentDues.status, 'waived')))
					.orderBy(asc(rentDues.dueOn), asc(rentDues.periodStart))
			)
				.filter((d) => adjusted.get(d.id)?.action !== 'waive')
				.map((d) => {
					const a = adjusted.get(d.id);
					return a ? { ...d, amountDue: a.amountDue, amountPaid: Math.min(d.amountPaid, a.amountDue) } : d;
				});
			let pending = await this.hooks.payments.pendingRent(c.tx, lease.id);
			const outstanding = new Map<string, number>();
			for (const d of dues) {
				let left = d.amountDue - d.amountPaid;
				const take = Math.min(left, pending);
				left -= take;
				pending -= take;
				if (left > 0) outstanding.set(d.id, left);
			}
			const rentAgreements = await c.tx
				.select()
				.from(agreements)
				.where(and(eq(agreements.leaseId, lease.id), eq(agreements.type, 'deposit_applied_to_rent'), ne(agreements.status, 'refused')));
			for (const a of rentAgreements) {
				const months = dues.filter((d) => a.months.includes(d.periodStart) && outstanding.has(d.id));
				const plan = agreementPlan({
					held: received - alreadyRefunded,
					keep: a.keptAmount,
					months: months.map((d) => ({ periodStart: d.periodStart, outstanding: outstanding.get(d.id)! }))
				});
				for (const [i, d] of months.entries()) {
					const applied = plan.months[i]!.applied;
					if (applied <= 0 && a.status === 'accepted') continue;
					lines.push({
						id: `${a.id}:${d.id}`,
						kind: 'rent_by_agreement',
						rentDueId: d.id,
						periodStart: d.periodStart,
						amount: a.status === 'accepted' ? applied : outstanding.get(d.id)!,
						agreementId: a.id,
						agreementType: a.type,
						agreementStatus: a.status,
						agreementAcceptedOn: a.decidedOn,
						agreementMonths: a.months,
						executed: false
					});
					outstanding.set(d.id, outstanding.get(d.id)! - (a.status === 'accepted' ? applied : 0));
				}
			}
			for (const d of dues) {
				const left = outstanding.get(d.id) ?? 0;
				if (left > 0) lines.push({ id: d.id, kind: 'unpaid_rent', rentDueId: d.id, periodStart: d.periodStart, outstanding: left });
			}
		}
		const [utilities] = await c.tx
			.select({ id: depositAccounts.id })
			.from(depositAccounts)
			.where(and(eq(depositAccounts.leaseId, lease.id), eq(depositAccounts.type, 'utilities_guarantee')))
			.limit(1);
		for (const claim of await this.hooks.expenses.claimsOf(c.tx, lease.id)) {
			if (claim.status !== 'recorded' || claim.outstanding <= 0) continue;
			const bill = (UTILITY_BILL_CATEGORIES as readonly string[]).includes(claim.category);
			// Une facture d'eau ou d'électricité va à la garantie des factures si le bail en a une ; le reste, à la caution.
			const kind = account.type === 'utilities_guarantee' ? 'utility_bill' : 'expense_claim';
			if (account.type === 'utilities_guarantee' && !bill) continue;
			if (account.type === 'security_deposit' && bill && utilities) continue;
			lines.push({
				id: claim.expenseId,
				kind,
				expenseId: claim.expenseId,
				category: claim.category,
				recovery: claim.recovery,
				status: claim.status,
				documentId: claim.documentId,
				outstanding: claim.outstanding
			});
		}
		const credit = account.type === 'security_deposit' ? (await this.hooks.payments.credit(c.tx, lease.id)) + exitExcess : 0;
		return { input: { accountType: account.type, received, alreadyRefunded, credit, exitOn, lines }, lease, account, alreadyRefunded };
	}

	private async settlementRow(c: Ctx, id: string, lock = true): Promise<SettlementRow> {
		const q = c.tx.select().from(depositSettlements).where(eq(depositSettlements.id, id)).limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw SETTLEMENT_NOT_FOUND();
		await this.lease(c, row.leaseId).catch(() => {
			throw SETTLEMENT_NOT_FOUND();
		});
		return row;
	}

	/**
	 * Prépare le décompte (deposit.settle) : calculé par computeSettlement, écrit en brouillon ; recalculé, il ajoute une
	 * révision et ses lignes (les précédentes restent, ajout seul). Un décompte proposé revient au brouillon.
	 */
	async prepareSettlement(accountId: string, origin?: AuditOrigin): Promise<Row> {
		const c = this.context(origin);
		// Date de sortie atteinte, tâche du jour pas encore passée : le bail est terminé ici, par la même fonction (idempotente).
		const [owning] = await c.tx.select({ leaseId: depositAccounts.leaseId }).from(depositAccounts).where(eq(depositAccounts.id, accountId)).limit(1);
		if (owning) {
			const lease = await this.lease(c, owning.leaseId, true);
			await endLeaseAtExit(c.tx, this.audit, c.organizationId, lease, toIsoDate(), this.hooks, c.actor, c.origin ?? 'api');
		}
		const { input, lease, account } = await this.settlementInput(c, accountId);
		const result = computeSettlement(input);
		const totals = {
			received: result.received,
			credit: input.credit,
			deductions: result.deductions,
			coveredByDeposit: result.coveredByDeposit,
			creditUsed: result.creditUsed,
			refund: result.refund,
			refundFromDeposit: result.refundFromDeposit,
			refundFromCredit: result.refundFromCredit,
			claim: result.claim,
			outcome: result.outcome,
			exitOn: input.exitOn,
			refundDeadline: refundDeadline(input.exitOn, lease.depositRefundDays)
		};
		const [existing] = await c.tx
			.select()
			.from(depositSettlements)
			.where(eq(depositSettlements.depositAccountId, account.id))
			.limit(1)
			.for('update');
		let settlement: SettlementRow;
		if (!existing) {
			[settlement] = (await c.tx
				.insert(depositSettlements)
				.values({
					id: newId(),
					organizationId: c.organizationId,
					depositAccountId: account.id,
					leaseId: lease.id,
					status: 'draft',
					revision: 1,
					createdBy: c.userId,
					...totals
				})
				.returning()) as [SettlementRow];
		} else {
			if (existing.status !== 'draft' && existing.status !== 'proposed') {
				throw new AppError('SETTLEMENT_LOCKED', 'Le décompte est accepté, contesté ou clos : il ne se recalcule plus.', 409);
			}
			[settlement] = (await c.tx
				.update(depositSettlements)
				.set({ status: 'draft', revision: existing.revision + 1, proposedAt: null, updatedAt: new Date(), ...totals })
				.where(eq(depositSettlements.id, existing.id))
				.returning()) as [SettlementRow];
		}
		const byId = new Map(input.lines.map((l) => [l.id, l]));
		for (const [position, r] of result.lines.entries()) {
			const line = byId.get(r.id)!;
			await c.tx.insert(depositSettlementLines).values({
				id: newId(),
				organizationId: c.organizationId,
				settlementId: settlement.id,
				revision: settlement.revision,
				position,
				kind: line.kind,
				amount: r.amount,
				covered: r.covered,
				uncovered: r.uncovered,
				blocker: r.blocker,
				inspectionItemId: line.kind === 'repair' ? line.inspectionItemId : null,
				repairId: line.kind === 'repair' ? line.repairId : null,
				rentDueId: line.kind === 'unpaid_rent' || line.kind === 'rent_by_agreement' ? line.rentDueId : null,
				expenseId: line.kind === 'expense_claim' || line.kind === 'utility_bill' ? line.expenseId : null,
				agreementId: line.kind === 'rent_by_agreement' ? line.agreementId : null,
				documentId:
					line.kind === 'repair'
						? r.blocker
							? null
							: repairRetention(line).documentId
						: line.kind === 'expense_claim' || line.kind === 'utility_bill'
							? line.documentId
							: null,
				createdBy: c.userId
			});
		}
		await this.record(c, 'deposit.settlement_prepare', 'deposit_settlement', settlement.id, {
			revision: settlement.revision,
			...totals,
			lines: result.lines.length
		});
		return this.settlementView(c, settlement, toIsoDate());
	}

	/**
	 * Ligne proposée depuis l'appareil (synchronisation) : refusée avec son motif si elle n'est pas justifiée (règle 14,
	 * D32) ; sinon le décompte est recalculé (elle y figure, comme toute réparation ou tout mois couvert par un accord).
	 */
	async proposeLine(input: SettlementLineInputData, origin?: AuditOrigin): Promise<void> {
		const c = this.context(origin);
		const s = await this.settlementRow(c, input.settlementId);
		const { input: data } = await this.settlementInput(c, s.depositAccountId);
		const candidate =
			input.kind === 'repair'
				? data.lines.find((l) => l.kind === 'repair' && l.repairId === input.repairId)
				: data.lines.find((l) => l.kind === 'rent_by_agreement' && l.agreementId === input.agreementId && l.rentDueId === input.rentDueId);
		if (!candidate) {
			const code = input.kind === 'repair' ? 'RETENTION_NOT_TENANT_DAMAGE' : 'AGREEMENT_MISSING';
			throw new AppError(code, SETTLEMENT_LINE_MESSAGES[code]!, 409);
		}
		const blocker = settlementLineBlocker(candidate, { accountType: data.accountType, exitOn: data.exitOn });
		if (blocker) throw new AppError(blocker, SETTLEMENT_LINE_MESSAGES[blocker] ?? 'Ligne refusée.', 409);
		await this.prepareSettlement(s.depositAccountId, origin);
	}

	private async transition(id: string, to: 'proposed' | 'accepted', extra: Partial<SettlementRow> = {}): Promise<Row> {
		const c = this.context();
		await this.settlementRow(c, id);
		const now = new Date();
		const [row] = await c.tx
			.update(depositSettlements)
			.set({ status: to, ...(to === 'proposed' ? { proposedAt: now } : { acceptedAt: now }), updatedAt: now, ...extra })
			.where(eq(depositSettlements.id, id))
			.returning();
		await this.record(c, `deposit.settlement_${to === 'proposed' ? 'propose' : 'accept'}`, 'deposit_settlement', id, { status: to });
		return this.settlementView(c, row!, toIsoDate());
	}

	proposeSettlement(id: string): Promise<Row> {
		return this.transition(id, 'proposed');
	}

	acceptSettlement(id: string): Promise<Row> {
		return this.transition(id, 'accepted');
	}

	/** Contestation simple : observations libres ; la part non contestée peut être restituée sans attendre. */
	async disputeSettlement(id: string, input: DisputeData): Promise<Row> {
		const c = this.context();
		await this.settlementRow(c, id);
		const column =
			input.party === 'tenant'
				? { tenantObservations: input.observations }
				: input.party === 'owner'
					? { ownerObservations: input.observations }
					: { organizationObservations: input.observations };
		const [row] = await c.tx
			.update(depositSettlements)
			.set({ ...column, status: 'disputed', disputedAt: new Date(), updatedAt: new Date() })
			.where(eq(depositSettlements.id, id))
			.returning();
		await this.record(c, 'deposit.settlement_dispute', 'deposit_settlement', id, { party: input.party });
		return this.settlementView(c, row!, toIsoDate());
	}

	/**
	 * Restitution enregistrée (jamais exécutée, règle 5) : par l'organisation ou par le propriétaire qui détient la
	 * caution ; avant la clôture, seulement la part non contestée ; jamais au-delà de ce qui reste de la caution.
	 */
	async refund(id: string, input: RefundData): Promise<Row> {
		const c = this.context();
		const s = await this.settlementRow(c, id);
		const [existing] = await c.tx.select().from(depositMovements).where(eq(depositMovements.id, input.id)).limit(1);
		if (existing) return this.settlementView(c, s, toIsoDate());
		if (!['proposed', 'accepted', 'disputed'].includes(s.status)) {
			throw new AppError('SETTLEMENT_LOCKED', 'On restitue un décompte proposé, accepté ou contesté.', 409);
		}
		const view = await this.settlementView(c, s, toIsoDate());
		if (input.amount > (view.refundRemaining as number)) {
			throw new AppError('SETTLEMENT_REFUND_EXCEEDS', 'Ce montant dépasse ce qui reste à restituer sur la caution.', 409, {
				remaining: view.refundRemaining
			});
		}
		await this.insertRefund(c, s, input.id, input.amount, input);
		return this.settlementView(c, s, toIsoDate());
	}

	private async insertRefund(c: Ctx, s: SettlementRow, id: string, amount: number, r: Omit<RefundData, 'id' | 'amount'>): Promise<void> {
		const [account] = await c.tx.select().from(depositAccounts).where(eq(depositAccounts.id, s.depositAccountId)).limit(1);
		if (r.refundedBy === 'owner' && account!.holder !== 'owner') {
			throw new AppError('DEPOSIT_HOLDER_MISMATCH', 'La caution est détenue par l’organisation : c’est elle qui restitue.', 409);
		}
		await c.tx.insert(depositMovements).values({
			id,
			organizationId: c.organizationId,
			accountId: s.depositAccountId,
			type: 'refunded',
			amount,
			occurredOn: r.refundedOn,
			settlementId: s.id,
			refundedBy: r.refundedBy,
			refundMethod: r.method,
			refundReference: r.reference,
			reason: r.refundedBy === 'owner' ? 'Restituée par le propriétaire' : 'Restituée par l’organisation',
			createdBy: c.userId
		});
		await this.record(c, 'deposit.refund', 'deposit_settlement', s.id, {
			movementId: id,
			amount,
			refundedBy: r.refundedBy,
			method: r.method,
			reference: r.reference,
			refundedOn: r.refundedOn
		});
	}

	/**
	 * Clôture : chaque ligne couverte devient son mouvement en ajout seul (retenue, imputation sur loyer, somme due), avec
	 * l'imputation sur caution qui solde l'échéance ou la dépense (D32) ; puis le reste de la restitution et le complément
	 * réclamé. Contestée, l'issue est enregistrée avec son document ; la plateforme n'arbitre pas.
	 */
	async closeSettlement(id: string, input: CloseSettlementData): Promise<Row> {
		const c = this.context();
		const s = await this.settlementRow(c, id);
		if (s.status !== 'accepted' && s.status !== 'disputed') {
			throw new AppError('SETTLEMENT_TRANSITION_FORBIDDEN', 'Seul un décompte accepté ou contesté se clôt.', 409);
		}
		if (s.status === 'disputed' && (!input.disputeOutcome || !input.documentId)) {
			throw new AppError('SETTLEMENT_DISPUTE_OUTCOME', 'Un décompte contesté se clôt avec son issue et son document.', 400);
		}
		const lines = await c.tx
			.select()
			.from(depositSettlementLines)
			.where(and(eq(depositSettlementLines.settlementId, s.id), eq(depositSettlementLines.revision, s.revision)))
			.orderBy(asc(depositSettlementLines.position));
		const today = toIsoDate();
		for (const l of lines) {
			if (l.blocker || l.covered <= 0) continue;
			if (l.kind === 'repair') {
				const [r] = await c.tx.select({ expenseId: repairs.expenseId }).from(repairs).where(eq(repairs.id, l.repairId!)).limit(1);
				await c.tx.insert(depositMovements).values({
					id: newId(),
					organizationId: c.organizationId,
					accountId: s.depositAccountId,
					type: 'retained',
					amount: l.covered,
					occurredOn: today,
					settlementId: s.id,
					settlementLineId: l.id,
					inspectionItemId: l.inspectionItemId,
					repairId: l.repairId,
					expenseId: r?.expenseId ?? null,
					documentId: l.documentId,
					createdBy: c.userId
				});
				continue;
			}
			const expense = l.kind === 'expense_claim' || l.kind === 'utility_bill';
			const offset = await this.hooks.payments.depositOffset({
				tx: c.tx,
				organizationId: c.organizationId,
				userId: c.userId,
				actor: c.actor,
				leaseId: s.leaseId,
				purpose: expense ? 'expense' : 'rent',
				rentDueId: expense ? null : l.rentDueId,
				expenseId: expense ? l.expenseId : null,
				amount: l.covered,
				paidOn: today,
				idempotencyKey: `settlement-line:${l.id}`
			});
			await c.tx.insert(depositMovements).values({
				id: newId(),
				organizationId: c.organizationId,
				accountId: s.depositAccountId,
				type: l.kind === 'rent_by_agreement' ? 'applied_to_rent' : 'applied_to_debt',
				amount: l.covered,
				occurredOn: today,
				settlementId: s.id,
				settlementLineId: l.id,
				rentDueId: expense ? null : l.rentDueId,
				expenseId: expense ? l.expenseId : null,
				agreementId: l.agreementId,
				documentId: l.documentId,
				paymentId: offset.paymentId,
				createdBy: c.userId
			});
		}
		const refunded = (
			await c.tx
				.select()
				.from(depositMovements)
				.where(and(eq(depositMovements.settlementId, s.id), eq(depositMovements.type, 'refunded')))
		).reduce((sum, m) => sum + m.amount, 0);
		const remaining = s.refundFromDeposit - refunded;
		if (remaining > 0) {
			if (!input.refund)
				throw new AppError('SETTLEMENT_REFUND_DETAILS_REQUIRED', 'Indiquez comment le reste de la caution a été restitué.', 400, {
					remaining
				});
			await this.insertRefund(c, s, input.refund.id, remaining, input.refund);
		}
		if (s.claim > 0) {
			await c.tx.insert(depositMovements).values({
				id: newId(),
				organizationId: c.organizationId,
				accountId: s.depositAccountId,
				type: 'additional_claimed',
				amount: s.claim,
				occurredOn: today,
				settlementId: s.id,
				createdBy: c.userId
			});
		}
		const now = new Date();
		const [row] = await c.tx
			.update(depositSettlements)
			.set({
				status: 'closed',
				closedAt: now,
				closedBy: c.userId,
				disputeOutcome: input.disputeOutcome ?? s.disputeOutcome,
				disputeDocumentId: input.documentId ?? s.disputeDocumentId,
				updatedAt: now
			})
			.where(eq(depositSettlements.id, s.id))
			.returning();
		await this.record(c, 'deposit.settlement_close', 'deposit_settlement', s.id, {
			refund: s.refund,
			refundFromDeposit: s.refundFromDeposit,
			claim: s.claim,
			outcome: s.outcome,
			disputeOutcome: input.disputeOutcome
		});
		return this.settlementView(c, row!, today);
	}

	// ---------------------------------------------------------------- transfert de gestion (D16, règles 12 et 15)

	/**
	 * Écrit dans l'organisation seule : fin du mandat ou de ses portées, baux terminés (le locataire reste, chez le nouveau
	 * gestionnaire), échéances à venir abandonnées, caution détenue par l'organisation passée au nouveau gestionnaire,
	 * nommé en texte. Rien n'est copié vers une autre organisation : elle saisit ou importe le dossier remis.
	 */
	async transfer(mandateId: string, input: ManagementTransferData): Promise<Row> {
		const c = this.context();
		const mandate = await this.owners.transferMandate(mandateId);
		const unitIds = input.unitId ? [input.unitId] : (await this.properties.get(input.propertyId)).units.map((u) => u.id);
		const inForce = unitIds.length
			? await c.tx
					.select()
					.from(leases)
					.where(and(inArray(leases.unitId, unitIds), inArray(leases.status, ['active', 'notice'])))
					.for('update')
			: [];
		const accounts = inForce.length
			? await c.tx
					.select()
					.from(depositAccounts)
					.where(
						inArray(
							depositAccounts.leaseId,
							inForce.map((l) => l.id)
						)
					)
			: [];
		const balances = new Map<string, number>();
		for (const a of accounts) {
			const ms = await c.tx.select().from(depositMovements).where(eq(depositMovements.accountId, a.id));
			const v = (t: string) => ms.filter((m) => m.type === t).reduce((s, m) => s + m.amount, 0);
			balances.set(
				a.id,
				v('received') - v('received_cancelled') - v('retained') - v('applied_to_rent') - v('applied_to_debt') - v('refunded')
			);
		}
		const transferInput = {
			target: { propertyId: input.propertyId, unitId: input.unitId },
			mandate: mandate && mandate.status !== 'not_management' ? mandate : null,
			transferOn: input.transferOn,
			today: toIsoDate(),
			newManagerName: input.newManagerName,
			handedOverOn: input.handedOverOn,
			handedOverItems: input.handedOverItems,
			leasesInForce: inForce.map((l) => ({ id: l.id, unitId: l.unitId })),
			depositAccounts: accounts.map((a) => ({
				id: a.id,
				leaseId: a.leaseId,
				holder: a.holder,
				held: balances.get(a.id) ?? 0,
				status: a.status
			}))
		};
		const blocker = managementTransferBlocker(transferInput);
		if (blocker) throw new AppError(blocker, TRANSFER_MESSAGES[blocker]!, blocker === 'TRANSFER_NOT_MANAGED' ? 409 : 400);
		const plan = managementTransferPlan(transferInput);
		await this.owners.recordTransfer({
			id: input.id,
			mandateId,
			propertyId: input.propertyId,
			unitId: input.unitId,
			transferOn: input.transferOn,
			newManagerName: input.newManagerName.trim(),
			handedOverOn: input.handedOverOn,
			handedOverItems: input.handedOverItems,
			note: input.note,
			mandateAction: plan.mandateAction,
			scopeIds: plan.scopeIds
		});
		const now = new Date();
		for (const l of inForce.filter((x) => plan.leaseIds.includes(x.id))) {
			await c.tx
				.update(rentDues)
				.set({ status: 'waived', updatedAt: now })
				.where(
					and(
						eq(rentDues.leaseId, l.id),
						eq(rentDues.status, 'upcoming'),
						eq(rentDues.amountPaid, 0),
						gt(rentDues.periodStart, input.transferOn)
					)
				);
			await c.tx
				.update(leases)
				.set({
					status: 'ended',
					endedAt: now,
					endKind: 'management_transfer',
					endReason: `Transfert de gestion à ${input.newManagerName.trim()}`.slice(0, 500),
					exitOn: l.exitOn ?? input.transferOn,
					updatedBy: c.userId,
					updatedAt: now
				})
				.where(eq(leases.id, l.id));
		}
		for (const h of plan.holderChanges) {
			await c.tx.insert(depositMovements).values({
				id: newId(),
				organizationId: c.organizationId,
				accountId: h.accountId,
				type: 'holder_changed',
				amount: 0,
				previousHolder: 'organization',
				newHolder: TRANSFER_DEPOSIT_HOLDER,
				newHolderName: h.newHolderName,
				managementTransferId: input.id,
				reason: 'Transfert de gestion',
				occurredOn: input.transferOn,
				createdBy: c.userId
			});
		}
		await this.record(c, 'management.transfer_apply', 'management_transfer', input.id, {
			leaseIds: plan.leaseIds,
			holderChanges: plan.holderChanges.map((h) => h.accountId),
			mandateAction: plan.mandateAction
		});
		return { id: input.id, ...plan };
	}

	/** Lot 10 bis : provenance des imputations sur caution (relevé, D32) — détenteur de la caution de chaque encaissement. */
	async depositOffsetHolders(tx: Tx, paymentIds: readonly string[]): Promise<Map<string, 'organization' | 'owner'>> {
		if (!paymentIds.length) return new Map();
		const rows = await tx
			.select({ paymentId: depositMovements.paymentId, holder: depositAccounts.holder })
			.from(depositMovements)
			.innerJoin(
				depositAccounts,
				and(eq(depositAccounts.organizationId, depositMovements.organizationId), eq(depositAccounts.id, depositMovements.accountId))
			)
			.where(
				and(inArray(depositMovements.paymentId, [...paymentIds]), inArray(depositMovements.type, ['applied_to_rent', 'applied_to_debt']))
			);
		return new Map(rows.map((r) => [r.paymentId!, r.holder === 'owner' ? 'owner' : 'organization']));
	}

	/** Lot 10 bis : réparations retenues par le propriétaire sur la caution qu'il détient (relevé, D32), par dépense. */
	async ownerRetentions(tx: Tx, expenseIds: readonly string[]): Promise<Map<string, { on: string; amount: number }>> {
		if (!expenseIds.length) return new Map();
		const rows = await tx
			.select({ expenseId: depositMovements.expenseId, on: depositMovements.occurredOn, amount: depositMovements.amount })
			.from(depositMovements)
			.innerJoin(
				depositAccounts,
				and(eq(depositAccounts.organizationId, depositMovements.organizationId), eq(depositAccounts.id, depositMovements.accountId))
			)
			.where(
				and(
					inArray(depositMovements.expenseId, [...expenseIds]),
					eq(depositMovements.type, 'retained'),
					eq(depositAccounts.holder, 'owner')
				)
			)
			.orderBy(desc(depositMovements.occurredOn));
		const out = new Map<string, { on: string; amount: number }>();
		for (const r of rows) {
			const prev = out.get(r.expenseId!);
			out.set(r.expenseId!, { on: prev?.on ?? r.on, amount: (prev?.amount ?? 0) + r.amount });
		}
		return out;
	}
}

const NOTICE_MESSAGES: Record<string, string> = {
	NOTICE_LEASE_NOT_IN_FORCE: 'Un congé s’enregistre sur un bail en vigueur.',
	NOTICE_DATE_INVALID: 'Date invalide.',
	NOTICE_DATE_IN_FUTURE: 'La date de notification est dans le futur.',
	NOTICE_EXIT_BEFORE_NOTIFICATION: 'La sortie précède la notification.',
	NOTICE_REDUCED_NOT_IN_LEASE: 'Le bail ne prévoit pas de préavis réduit.',
	NOTICE_REDUCED_LESSOR: 'Le préavis réduit ne vaut que pour le locataire.',
	NOTICE_LESSOR_TOO_SHORT: 'Le congé du bailleur respecte son délai de préavis.'
};

const AGREEMENT_MESSAGES: Record<string, string> = {
	AGREEMENT_ALREADY_DECIDED: 'Cet accord est déjà décidé.',
	AGREEMENT_SAME_PARTY: 'L’accord se décide par l’autre partie.',
	AGREEMENT_REASON_REQUIRED: 'Un refus est motivé (5 caractères au moins).',
	AGREEMENT_DOCUMENT_REQUIRED: 'Cet accord est écrit : joignez son document.',
	AGREEMENT_MONTHS_REQUIRED: 'Nommez les mois imputés.',
	AGREEMENT_MONTH_STARTED: 'L’accord se décide avant les mois imputés.'
};

const TRANSFER_MESSAGES: Record<string, string> = {
	TRANSFER_NOT_MANAGED: 'Ce bien ou cette unité n’est pas sous un mandat de gestion actif de l’organisation.',
	TRANSFER_DATE_IN_FUTURE: 'La date du transfert est dans le futur.',
	TRANSFER_DATE_INVALID: 'Date invalide.',
	TRANSFER_NEW_MANAGER_REQUIRED: 'Nommez le nouveau gestionnaire.',
	TRANSFER_HANDOVER_REQUIRED: 'Indiquez les pièces remises.'
};
