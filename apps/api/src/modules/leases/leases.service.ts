/**
 * Locataires, baux, échéances et comptes de caution (lot 08) : service public du module leases, utilisé par ses
 * routes HTTP et par l'envoi des modifications de l'appareil (même validation, mêmes règles, même audit). Toute
 * écriture passe par la transaction de l'organisation active (RequestContext.tx()) et écrit sa ligne d'audit (règle 4).
 *
 * - Locataire : aucun champ obligatoire hormis le nom ; l'état civil et la pièce d'identité ne sont lus et modifiés
 *   que par le directeur et le gestionnaire.
 * - Bail : brouillon, puis validé ; le serveur décide `signed` (début futur) ou `active`, vérifie les garde-fous
 *   (mandat de gestion en vigueur ; unité disponible pour un bail qui commence aujourd'hui ou plus tard ; un seul bail
 *   en vigueur et un seul à venir par unité) et génère les échéances dans la même transaction. La base tranche la
 *   règle 8 en dernier ressort (UNIT_ALREADY_LEASED).
 * - Loyer : un changement crée la version suivante, à une date d'effet, contrôlé par la version attendue ; les
 *   échéances émises ne changent jamais, les suivantes sont recalculées.
 * - Caution : détenteur obligatoire, proposé selon le mandat ; versements en plusieurs fois ; au-delà de deux mois de
 *   loyer (hors charges, caution seulement), avertissement et audit, sans blocage. L'avance n'est pas une caution.
 * - Vente du bien : le bail ne copie pas le propriétaire, il suit l'unité ; un changement de propriétaire ne touche ni
 *   le bail, ni ses échéances, ni sa caution.
 */
import { Injectable } from '@nestjs/common';
import { toIsoDate } from '@ziga/shared/dates';
import {
	allowedDepositHolders,
	allowedLessorTypes,
	canTransitionLease,
	depositAboveLegalCap,
	depositBalances,
	depositMovementBlocker,
	isLeaseInForce,
	leaseAlerts,
	leaseCreationBlockers,
	leaseTermsSchema,
	outstandingBalance,
	rentDueBalance,
	tenantIdentitySchema,
	tenantSchema,
	unitOccupancy,
	validatedLeaseStatus,
	type CreateDepositAccountData,
	type CreateLeaseData,
	type CreateTenantData,
	type DepositAccountView,
	type DepositHolderChangeData,
	type DepositMovementView,
	type DepositReceiptData,
	type LeaseCreationBlocker,
	type LeaseDetailView,
	type LeaseTerms,
	type LeaseView,
	type LeaseWarning,
	type Page,
	type RentChangeData,
	type RentDueView,
	type TenantData,
	type TenantDetailView,
	type TenantIdentity,
	type TenantView,
	type UpdateLeaseDraftData,
	type UpdateTenantData,
	type WithWarnings
} from '@ziga/shared/leases';
import { can } from '@ziga/shared/permissions';
import { generateRentSchedule, rentChangeBlocker, rentDueUpdates, scheduleUntil } from '@ziga/shared/rent-schedule';
import { and, asc, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import { depositAccounts, depositMovements, leaseContracts, leases, leaseVersions, rentDues, tenants } from '../../db/schema/leases.js';
import { AuditService, diff, type AuditActor } from '../audit/audit.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { OwnersService } from '../owners/owners.service.js';
import { PropertiesService } from '../properties/properties.service.js';
import {
	generateDues,
	refreshDueStatuses,
	renewLease,
	scheduleInput,
	VALIDATED_STATUSES,
	type LeaseRow,
	type RentDueRow
} from './rent-dues.js';

type TenantRow = typeof tenants.$inferSelect;
type AccountRow = typeof depositAccounts.$inferSelect;
type MovementRow = typeof depositMovements.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const TENANT_NOT_FOUND = () => new AppError('TENANT_NOT_FOUND', 'Locataire introuvable.', 404);
const LEASE_NOT_FOUND = () => new AppError('LEASE_NOT_FOUND', 'Bail introuvable.', 404);
const ACCOUNT_NOT_FOUND = () => new AppError('DEPOSIT_ACCOUNT_NOT_FOUND', 'Compte de caution introuvable.', 404);

const BLOCKER_MESSAGES: Record<LeaseCreationBlocker, string> = {
	NO_MANAGEMENT_MANDATE: 'Aucun mandat de gestion en vigueur ne couvre cette unité.',
	UNIT_NOT_AVAILABLE: 'Cette unité n’est pas disponible (fiche active, libre ou en préavis, prête).',
	UNIT_ALREADY_LEASED: 'Cette unité a déjà un bail en vigueur (règle 8) : un seul bail actif par unité.',
	UNIT_ALREADY_RESERVED: 'Cette unité a déjà un bail signé qui commence plus tard.'
};

export function tenantView(t: TenantRow): TenantView {
	return {
		id: t.id,
		civility: t.civility,
		fullName: t.fullName,
		phone: t.phone,
		secondaryPhone: t.secondaryPhone,
		nationality: t.nationality,
		profession: t.profession,
		previousAddress: t.previousAddress,
		emergencyContactName: t.emergencyContactName,
		emergencyContactPhone: t.emergencyContactPhone,
		notes: t.notes,
		status: t.status,
		archivedAt: iso(t.archivedAt),
		createdAt: t.createdAt.toISOString(),
		updatedAt: t.updatedAt.toISOString()
	};
}

function tenantData(t: TenantRow): TenantData {
	const {
		civility,
		fullName,
		phone,
		secondaryPhone,
		nationality,
		profession,
		previousAddress,
		emergencyContactName,
		emergencyContactPhone,
		notes
	} = tenantView(t);
	return {
		civility,
		fullName,
		phone,
		secondaryPhone,
		nationality,
		profession,
		previousAddress,
		emergencyContactName,
		emergencyContactPhone,
		notes
	};
}

function tenantIdentityOf(t: TenantRow): TenantIdentity {
	return {
		birthDate: t.birthDate,
		birthPlace: t.birthPlace,
		idType: t.idType,
		idTypeOther: t.idTypeOther,
		idNumber: t.idNumber,
		idIssuedOn: t.idIssuedOn,
		idIssuedBy: t.idIssuedBy
	};
}

function termsOf(l: LeaseRow): LeaseTerms {
	return {
		startsOn: l.startsOn,
		endsOn: l.endsOn,
		durationMonths: l.durationMonths,
		duesStartOn: l.duesStartOn,
		rent: l.rent,
		charges: l.charges,
		periodicity: l.periodicity,
		dueDay: l.dueDay,
		billingMode: l.billingMode,
		advanceMonths: l.advanceMonths,
		lessorType: l.lessorType,
		paymentTerms: l.paymentTerms,
		penaltyRateBp: l.penaltyRateBp,
		penaltyGraceDays: l.penaltyGraceDays,
		penaltyBeneficiary: l.penaltyBeneficiary,
		noticeTenantFixedTermMonths: l.noticeTenantFixedTermMonths,
		noticeTenantOpenEndedMonths: l.noticeTenantOpenEndedMonths,
		noticeLessorFixedTermMonths: l.noticeLessorFixedTermMonths,
		noticeLessorOpenEndedMonths: l.noticeLessorOpenEndedMonths,
		reducedNoticeMonths: l.reducedNoticeMonths,
		reducedNoticeCases: l.reducedNoticeCases,
		earlyTerminationIndemnityMonths: l.earlyTerminationIndemnityMonths,
		renewalMode: l.renewalMode,
		depositRefundDays: l.depositRefundDays
	};
}

export function leaseView(l: LeaseRow, hasSignedContract: boolean): LeaseView {
	return {
		id: l.id,
		unitId: l.unitId,
		tenantId: l.tenantId,
		...termsOf(l),
		billingMode: l.billingMode,
		rentEffectiveFrom: l.rentEffectiveFrom,
		status: l.status,
		activatedOn: l.activatedOn,
		cancelledAt: iso(l.cancelledAt),
		cancellationReason: l.cancellationReason,
		noticeGivenOn: l.noticeGivenOn,
		exitOn: l.exitOn,
		version: l.version,
		alerts: leaseAlerts({ status: l.status, hasSignedContract }),
		createdAt: l.createdAt.toISOString(),
		updatedAt: l.updatedAt.toISOString()
	};
}

export function rentDueView(d: RentDueRow): RentDueView {
	return {
		id: d.id,
		leaseId: d.leaseId,
		periodStart: d.periodStart,
		periodEnd: d.periodEnd,
		dueOn: d.dueOn,
		rent: d.rent,
		charges: d.charges,
		amountDue: d.amountDue,
		amountPaid: d.amountPaid,
		balance: rentDueBalance(d),
		status: d.status,
		prorated: d.prorated,
		isAdvance: d.isAdvance,
		leaseVersion: d.leaseVersion
	};
}

function movementView(m: MovementRow): DepositMovementView {
	return {
		id: m.id,
		accountId: m.accountId,
		type: m.type,
		amount: m.amount,
		previousHolder: m.previousHolder,
		newHolder: m.newHolder,
		reason: m.reason,
		occurredOn: m.occurredOn,
		documentId: m.documentId,
		createdBy: m.createdBy,
		createdAt: m.createdAt.toISOString()
	};
}

function accountView(a: AccountRow, movements: MovementRow[], monthlyRent: number): DepositAccountView {
	return {
		id: a.id,
		leaseId: a.leaseId,
		type: a.type,
		agreedAmount: a.agreedAmount,
		agreedMonths: a.agreedMonths,
		holder: a.holder,
		status: a.status,
		balances: depositBalances(a.agreedAmount, movements),
		aboveLegalCap: depositAboveLegalCap(a.type, a.agreedAmount, monthlyRent),
		movements: movements.map(movementView)
	};
}

interface Context {
	tx: Tx;
	organizationId: string;
	landlord: boolean;
	organizationType: 'agency' | 'landlord';
	role: ReturnType<typeof RequestContext.organization>['role'];
	userId: string;
	actor: AuditActor;
}

@Injectable()
export class LeasesService {
	constructor(
		private readonly audit: AuditService,
		private readonly properties: PropertiesService,
		private readonly owners: OwnersService,
		private readonly documents: DocumentsService,
		private readonly organizations: OrganizationsService
	) {}

	private context(): Context {
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		return {
			tx: RequestContext.tx(),
			organizationId: scope.organizationId,
			landlord: scope.organizationType === 'landlord',
			organizationType: scope.organizationType,
			role: scope.role,
			userId,
			actor: { type: 'user', userId, role: scope.role }
		};
	}

	/** Agent de terrain : les baux de ses unités affectées seulement ; null pour les autres rôles. */
	private async agentUnits(): Promise<Set<string> | null> {
		const ids = await this.properties.assignedUnitIds();
		return ids ? new Set(ids) : null;
	}

	// ---------------------------------------------------------------- locataires

	private async tenantRow(c: Context, id: string, lock = false): Promise<TenantRow> {
		const q = c.tx
			.select()
			.from(tenants)
			.where(and(eq(tenants.organizationId, c.organizationId), eq(tenants.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		// Sous la RLS, le locataire d'une autre organisation est introuvable.
		if (!row) throw TENANT_NOT_FOUND();
		return row;
	}

	/** Locataires visibles de l'agent de terrain : ceux des baux de ses unités. */
	private async agentTenantIds(c: Context, units: Set<string>): Promise<string[]> {
		if (!units.size) return [];
		const rows = await c.tx
			.select({ tenantId: leases.tenantId })
			.from(leases)
			.where(and(eq(leases.organizationId, c.organizationId), inArray(leases.unitId, [...units])));
		return [...new Set(rows.map((r) => r.tenantId))];
	}

	/** Liste paginée par curseur (identifiant UUIDv7, ordre de création). */
	async listTenants(cursor: string | null, limit: number): Promise<Page<TenantView>> {
		const c = this.context();
		const units = await this.agentUnits();
		const only = units ? await this.agentTenantIds(c, units) : null;
		if (only && !only.length) return { items: [], nextCursor: null };
		const rows = await c.tx
			.select()
			.from(tenants)
			.where(
				and(
					eq(tenants.organizationId, c.organizationId),
					cursor ? gt(tenants.id, cursor) : undefined,
					only ? inArray(tenants.id, only) : undefined
				)
			)
			.orderBy(asc(tenants.id))
			.limit(limit + 1);
		const items = rows.slice(0, limit).map(tenantView);
		return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
	}

	async getTenant(id: string): Promise<TenantDetailView> {
		const c = this.context();
		const units = await this.agentUnits();
		const row = await this.tenantRow(c, id);
		let leaseRows = await c.tx
			.select()
			.from(leases)
			.where(and(eq(leases.organizationId, c.organizationId), eq(leases.tenantId, id)))
			.orderBy(desc(leases.startsOn), asc(leases.id));
		if (units) {
			leaseRows = leaseRows.filter((l) => units.has(l.unitId));
			if (!leaseRows.length) throw TENANT_NOT_FOUND();
		}
		const views = await this.leaseViews(leaseRows);
		const dues = leaseRows.length
			? await c.tx
					.select()
					.from(rentDues)
					.where(
						and(
							eq(rentDues.organizationId, c.organizationId),
							inArray(
								rentDues.leaseId,
								leaseRows.map((l) => l.id)
							)
						)
					)
			: [];
		return {
			...tenantView(row),
			identity: can(c.role, 'tenant.read_identity') ? tenantIdentityOf(row) : null,
			leases: views,
			outstanding: outstandingBalance(dues, toIsoDate())
		};
	}

	async createTenant(input: CreateTenantData, identity: TenantIdentity | null = null): Promise<TenantView> {
		const c = this.context();
		const exists = await c.tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Ce locataire existe déjà.', 409);
		const { id, ...data } = input;
		const [row] = await c.tx
			.insert(tenants)
			.values({ id, organizationId: c.organizationId, ...data, ...(identity ?? {}), status: 'active', createdBy: c.userId })
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'tenant.create',
			objectType: 'tenant',
			objectId: id,
			after: { ...data, status: 'active', ...(identity ? { identity } : {}) }
		});
		return tenantView(row!);
	}

	async updateTenant(id: string, input: UpdateTenantData): Promise<TenantView> {
		const c = this.context();
		const row = await this.tenantRow(c, id, true);
		const before = tenantData(row);
		const next = tenantSchema.parse({ ...before, ...input });
		const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
		if (!changes) return tenantView(row);
		const [updated] = await c.tx
			.update(tenants)
			.set({ ...next, updatedAt: new Date() })
			.where(and(eq(tenants.organizationId, c.organizationId), eq(tenants.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'tenant.update',
			objectType: 'tenant',
			objectId: id,
			...changes
		});
		return tenantView(updated!);
	}

	/** État civil et pièce d'identité : directeur et gestionnaire seulement (permission vérifiée par la route). */
	async updateTenantIdentity(id: string, input: Partial<TenantIdentity>): Promise<TenantIdentity> {
		const c = this.context();
		const row = await this.tenantRow(c, id, true);
		const before = tenantIdentityOf(row);
		const next = tenantIdentitySchema.parse({ ...before, ...input });
		const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
		if (!changes) return before;
		await c.tx
			.update(tenants)
			.set({ ...next, updatedAt: new Date() })
			.where(and(eq(tenants.organizationId, c.organizationId), eq(tenants.id, id)));
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'tenant.identity_update',
			objectType: 'tenant',
			objectId: id,
			...changes
		});
		return next;
	}

	async identityOf(id: string): Promise<TenantIdentity> {
		const c = this.context();
		return tenantIdentityOf(await this.tenantRow(c, id));
	}

	/** Archivage : refusé tant qu'un bail est signé ou en vigueur. */
	async archiveTenant(id: string): Promise<TenantView> {
		const c = this.context();
		const row = await this.tenantRow(c, id, true);
		if (row.status === 'archived') return tenantView(row);
		const [open] = await c.tx
			.select({ id: leases.id })
			.from(leases)
			.where(and(eq(leases.organizationId, c.organizationId), eq(leases.tenantId, id), inArray(leases.status, [...VALIDATED_STATUSES])))
			.limit(1);
		if (open) throw new AppError('TENANT_HAS_ACTIVE_LEASE', 'Ce locataire a un bail signé ou en vigueur : il ne s’archive pas.', 409);
		const now = new Date();
		const [updated] = await c.tx
			.update(tenants)
			.set({ status: 'archived', archivedAt: now, updatedAt: now })
			.where(and(eq(tenants.organizationId, c.organizationId), eq(tenants.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'tenant.archive',
			objectType: 'tenant',
			objectId: id,
			before: { status: 'active' },
			after: { status: 'archived' }
		});
		return tenantView(updated!);
	}

	// ---------------------------------------------------------------- baux : lecture

	private async leaseRow(c: Context, id: string, lock = false): Promise<LeaseRow> {
		const q = c.tx
			.select()
			.from(leases)
			.where(and(eq(leases.organizationId, c.organizationId), eq(leases.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw LEASE_NOT_FOUND();
		const units = await this.agentUnits();
		if (units && !units.has(row.unitId)) throw LEASE_NOT_FOUND();
		return row;
	}

	/**
	 * « Contrat signé » (D20, lot 08 bis) : le contrat du bail est signé, qu'il ait été généré puis signé à la main, ou
	 * déposé signé (bail scanné du lot 08, repris par la migration 0014). Une seule source : les contrats.
	 */
	private async signedContracts(c: Context, leaseIds: readonly string[]): Promise<Set<string>> {
		if (!leaseIds.length) return new Set();
		const rows = await c.tx
			.select({ leaseId: leaseContracts.leaseId })
			.from(leaseContracts)
			.where(
				and(
					eq(leaseContracts.organizationId, c.organizationId),
					inArray(leaseContracts.leaseId, [...leaseIds]),
					isNull(leaseContracts.amendmentId),
					eq(leaseContracts.status, 'signed')
				)
			);
		return new Set(rows.map((r) => r.leaseId));
	}

	private async leaseViews(rows: LeaseRow[]): Promise<LeaseView[]> {
		const signed = await this.signedContracts(
			this.context(),
			rows.map((r) => r.id)
		);
		return rows.map((r) => leaseView(r, signed.has(r.id)));
	}

	async listLeases(filter: { unitId?: string; tenantId?: string }): Promise<LeaseView[]> {
		const c = this.context();
		const units = await this.agentUnits();
		if (units && !units.size) return [];
		const rows = await c.tx
			.select()
			.from(leases)
			.where(
				and(
					eq(leases.organizationId, c.organizationId),
					filter.unitId ? eq(leases.unitId, filter.unitId) : undefined,
					filter.tenantId ? eq(leases.tenantId, filter.tenantId) : undefined,
					units ? inArray(leases.unitId, [...units]) : undefined
				)
			)
			.orderBy(desc(leases.startsOn), asc(leases.id));
		return this.leaseViews(rows);
	}

	async getLease(id: string): Promise<LeaseDetailView> {
		const c = this.context();
		const row = await this.leaseRow(c, id);
		const [view] = await this.leaseViews([row]);
		const versions = await c.tx
			.select()
			.from(leaseVersions)
			.where(and(eq(leaseVersions.organizationId, c.organizationId), eq(leaseVersions.leaseId, id)))
			.orderBy(asc(leaseVersions.version));
		const dues = await c.tx
			.select()
			.from(rentDues)
			.where(and(eq(rentDues.organizationId, c.organizationId), eq(rentDues.leaseId, id)))
			.orderBy(asc(rentDues.periodStart));
		return {
			...view!,
			versions: versions.map((v) => ({
				version: v.version,
				rent: v.rent,
				charges: v.charges,
				rentEffectiveFrom: v.rentEffectiveFrom,
				status: v.status,
				changedBy: v.changedBy,
				recordedAt: v.recordedAt.toISOString()
			})),
			rentDues: dues.map(rentDueView),
			deposits: can(c.role, 'deposit.read') ? await this.accountViews(c, row) : null,
			outstanding: outstandingBalance(dues, toIsoDate())
		};
	}

	async rentDuesOf(id: string): Promise<RentDueView[]> {
		return (await this.getLease(id)).rentDues;
	}

	// ---------------------------------------------------------------- baux : création et validation

	/** Garde-fous de validation (packages/shared, leaseCreationBlockers), le bail lui-même exclu. */
	private async blockers(
		c: Context,
		lease: { id: string; unitId: string; startsOn: string },
		today: string
	): Promise<LeaseCreationBlocker[]> {
		const unit = await this.properties.getUnit(lease.unitId);
		const others = await c.tx
			.select({ status: leases.status, startsOn: leases.startsOn })
			.from(leases)
			.where(
				and(
					eq(leases.organizationId, c.organizationId),
					eq(leases.unitId, lease.unitId),
					ne(leases.id, lease.id),
					inArray(leases.status, [...VALIDATED_STATUSES])
				)
			);
		const mandate = await this.owners.managementMandateFor(lease.unitId, lease.startsOn);
		return leaseCreationBlockers({
			startsOn: lease.startsOn,
			today,
			hasManagementMandate: mandate !== null,
			unit: { recordStatus: unit.recordStatus, technicalStatus: unit.technicalStatus, occupancy: unitOccupancy(others, today) },
			otherInForce: others.some((o) => isLeaseInForce(o.status)),
			otherReserved: others.some((o) => o.status === 'signed')
		});
	}

	private async checkTenant(c: Context, tenantId: string): Promise<void> {
		const tenant = await this.tenantRow(c, tenantId);
		if (tenant.status === 'archived') throw new AppError('TENANT_ARCHIVED', 'Ce locataire est archivé.', 409);
	}

	private checkLessor(c: Context, lessorType: LeaseRow['lessorType']): void {
		if (!allowedLessorTypes(c.organizationType).includes(lessorType)) {
			throw new AppError('LANDLORD_IS_LESSOR', 'Un bailleur particulier est lui-même le bailleur désigné.', 409);
		}
	}

	/**
	 * Création : brouillon, ou validé tout de suite (`validate`). Le découpage absent est recopié du réglage de
	 * l'organisation, puis figé à la validation.
	 */
	async createLease(input: CreateLeaseData): Promise<LeaseDetailView> {
		const c = this.context();
		const exists = await c.tx.select({ id: leases.id }).from(leases).where(eq(leases.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Ce bail existe déjà.', 409);
		await this.properties.getUnit(input.unitId);
		await this.checkTenant(c, input.tenantId);
		const { id, unitId, tenantId, validate, ...rest } = input;
		const terms = leaseTermsSchema.parse({ ...rest, billingMode: rest.billingMode ?? (await this.organizations.rentBillingMode(c.tx)) });
		this.checkLessor(c, terms.lessorType);
		const [row] = await c.tx
			.insert(leases)
			.values({
				id,
				organizationId: c.organizationId,
				unitId,
				tenantId,
				...terms,
				rentEffectiveFrom: terms.duesStartOn,
				status: 'draft',
				version: 1,
				createdBy: c.userId,
				updatedBy: c.userId
			})
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'lease.create',
			objectType: 'lease',
			objectId: id,
			after: { unitId, tenantId, ...terms, status: 'draft' }
		});
		if (validate) await this.validateRow(c, row!);
		return this.getLease(id);
	}

	/** Modification d'un brouillon : les champs reçus complètent les termes, revalidés en entier. */
	async updateDraft(id: string, input: UpdateLeaseDraftData): Promise<LeaseDetailView> {
		const c = this.context();
		const row = await this.leaseRow(c, id, true);
		if (row.status !== 'draft') {
			throw new AppError(
				'LEASE_TERMS_LOCKED',
				'Les conditions d’un bail validé ne changent pas ; seul le loyer change, par une nouvelle version.',
				409
			);
		}
		const { tenantId, ...patch } = input;
		if (tenantId && tenantId !== row.tenantId) await this.checkTenant(c, tenantId);
		const before = { tenantId: row.tenantId, ...termsOf(row) };
		const terms = leaseTermsSchema.parse({ ...termsOf(row), ...patch });
		this.checkLessor(c, terms.lessorType);
		const next = { tenantId: tenantId ?? row.tenantId, ...terms };
		const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
		if (!changes) return this.getLease(id);
		await c.tx
			.update(leases)
			.set({ ...terms, tenantId: next.tenantId, rentEffectiveFrom: terms.duesStartOn, updatedBy: c.userId, updatedAt: new Date() })
			.where(and(eq(leases.organizationId, c.organizationId), eq(leases.id, id)));
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'lease.update',
			objectType: 'lease',
			objectId: id,
			...changes
		});
		return this.getLease(id);
	}

	async validateLease(id: string): Promise<LeaseDetailView> {
		const c = this.context();
		const row = await this.leaseRow(c, id, true);
		if (row.status !== 'draft') {
			throw new AppError('LEASE_ALREADY_VALIDATED', 'Ce bail est déjà validé.', 409, { status: row.status });
		}
		await this.validateRow(c, row);
		return this.getLease(id);
	}

	/**
	 * Validation : garde-fous, statut décidé par le serveur selon la date de début, date de signature, puis génération
	 * des échéances (fin du bail, ou 12 mois glissants) dans la même transaction.
	 */
	private async validateRow(c: Context, row: LeaseRow): Promise<void> {
		const today = toIsoDate();
		const blocked = await this.blockers(c, row, today);
		if (blocked.length) throw new AppError(blocked[0]!, BLOCKER_MESSAGES[blocked[0]!], 409, { blockers: blocked });
		const status = validatedLeaseStatus(row.startsOn, today);
		const now = new Date();
		const [updated] = await c.tx
			.update(leases)
			.set({ status, activatedOn: today, activatedAt: now, updatedBy: c.userId, updatedAt: now })
			.where(and(eq(leases.organizationId, c.organizationId), eq(leases.id, row.id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'lease.validate',
			objectType: 'lease',
			objectId: row.id,
			before: { status: 'draft' },
			after: { status, activatedOn: today, version: updated!.version }
		});
		await generateDues(c.tx, this.audit, updated!, today, c.actor);
	}

	/**
	 * Annulation d'un brouillon ou d'un bail signé à venir, motif obligatoire. Les échéances sans paiement sont
	 * abandonnées (jamais supprimées) ; un bail en vigueur ne s'annule pas : il se termine (lot 10 bis).
	 */
	async cancelLease(id: string, reason: string): Promise<LeaseDetailView> {
		const c = this.context();
		const row = await this.leaseRow(c, id, true);
		if (!canTransitionLease(row.status, 'cancelled')) {
			throw new AppError(
				'LEASE_NOT_CANCELLABLE',
				'Seul un brouillon ou un bail signé à venir s’annule ; un bail en vigueur se termine.',
				409,
				{
					status: row.status
				}
			);
		}
		const dues = await c.tx
			.select()
			.from(rentDues)
			.where(and(eq(rentDues.organizationId, c.organizationId), eq(rentDues.leaseId, id)))
			.for('update');
		if (dues.some((d) => d.amountPaid > 0)) {
			throw new AppError('LEASE_HAS_PAYMENTS', 'Des paiements sont déjà imputés sur ce bail : il ne s’annule pas.', 409);
		}
		const now = new Date();
		await c.tx
			.update(leases)
			.set({ status: 'cancelled', cancelledAt: now, cancellationReason: reason, updatedBy: c.userId, updatedAt: now })
			.where(and(eq(leases.organizationId, c.organizationId), eq(leases.id, id)));
		if (dues.length) {
			await c.tx
				.update(rentDues)
				.set({ status: 'waived', updatedAt: now })
				.where(and(eq(rentDues.organizationId, c.organizationId), eq(rentDues.leaseId, id), ne(rentDues.status, 'waived')));
		}
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'lease.cancel',
			objectType: 'lease',
			objectId: id,
			before: { status: row.status },
			after: { status: 'cancelled', reason, waivedDues: dues.filter((d) => d.status !== 'waived').length }
		});
		return this.getLease(id);
	}

	/**
	 * Changement de loyer d'un bail validé : version suivante, contrôlée par la version attendue (jamais « dernière
	 * écriture gagnante » sur un montant). La date d'effet est un début de période sans échéance émise ; les échéances
	 * émises ne changent jamais, les suivantes sont recalculées et les manquantes créées.
	 */
	async changeRent(id: string, input: RentChangeData, source: { amendmentId: string } | null = null): Promise<LeaseDetailView> {
		const c = this.context();
		const today = toIsoDate();
		const row = await this.leaseRow(c, id, true);
		if (!(VALIDATED_STATUSES as readonly string[]).includes(row.status)) {
			throw new AppError(
				'LEASE_NOT_VALIDATED',
				'Le loyer d’un brouillon se modifie directement ; celui d’un bail terminé ne change plus.',
				409,
				{
					status: row.status
				}
			);
		}
		if (input.expectedVersion !== row.version) {
			throw new AppError('VERSION_CONFLICT', 'Le bail a changé entre-temps : rechargez-le avant de modifier le loyer.', 409, {
				expected: input.expectedVersion,
				current: row.version
			});
		}
		const existing = await c.tx
			.select()
			.from(rentDues)
			.where(and(eq(rentDues.organizationId, c.organizationId), eq(rentDues.leaseId, id)))
			.for('update');
		const current = await scheduleInput(c.tx, row, scheduleUntil({ endOn: row.endsOn, duesStartOn: row.duesStartOn }, today));
		const blocker = rentChangeBlocker(current, input.effectiveFrom, existing);
		if (blocker) {
			const messages = {
				RENT_CHANGE_NOT_PERIOD_START: 'Le nouveau loyer prend effet au début d’une période du bail.',
				RENT_CHANGE_ON_ISSUED_DUE: 'Une échéance déjà émise ne change jamais : choisissez une date d’effet après elle.',
				RENT_CHANGE_OUT_OF_LEASE: 'La date d’effet tombe hors du bail.'
			} as const;
			throw new AppError(blocker, messages[blocker], 409);
		}
		const nextVersion = row.version + 1;
		const [updated] = await c.tx
			.update(leases)
			.set({
				rent: input.rent,
				charges: input.charges,
				rentEffectiveFrom: input.effectiveFrom,
				version: nextVersion,
				updatedBy: c.userId,
				updatedAt: new Date()
			})
			.where(and(eq(leases.organizationId, c.organizationId), eq(leases.id, id)))
			.returning();
		const regenerated = generateRentSchedule(
			await scheduleInput(c.tx, updated!, scheduleUntil({ endOn: updated!.endsOn, duesStartOn: updated!.duesStartOn }, today))
		);
		const updates = rentDueUpdates(existing, regenerated);
		for (const u of updates) {
			await c.tx
				.update(rentDues)
				.set({ rent: u.rent, charges: u.charges, amountDue: u.amountDue, leaseVersion: u.leaseVersion, updatedAt: new Date() })
				.where(and(eq(rentDues.organizationId, c.organizationId), eq(rentDues.leaseId, id), eq(rentDues.periodStart, u.periodStart)));
		}
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'lease.rent_change',
			objectType: 'lease',
			objectId: id,
			before: { rent: row.rent, charges: row.charges, rentEffectiveFrom: row.rentEffectiveFrom, version: row.version },
			after: {
				rent: input.rent,
				charges: input.charges,
				rentEffectiveFrom: input.effectiveFrom,
				version: nextVersion,
				recalculatedDues: updates.map((u) => u.periodStart),
				// Lot 08 bis : par l'avenant signé, ou directement (corrections et imports), « sans avenant ».
				amendmentId: source?.amendmentId ?? null,
				withoutAmendment: source === null
			}
		});
		await generateDues(c.tx, this.audit, updated!, today, c.actor);
		return this.getLease(id);
	}

	// ---------------------------------------------------------------- lot 08 bis : contrat et avenants

	/**
	 * Dépôt du contrat signé d'un bail en brouillon : il le valide par la même fonction que la route de validation
	 * (mêmes garde-fous, statut décidé par le serveur, échéances) ; un refus annule tout le dépôt. Sans effet pour un
	 * bail déjà validé.
	 */
	async validateDraftForContract(id: string): Promise<LeaseRow['status']> {
		const c = this.context();
		const row = await this.leaseRow(c, id, true);
		if (row.status !== 'draft') return row.status;
		await this.validateRow(c, row);
		return (await this.leaseRow(c, id)).status;
	}

	/** Le changement de loyer serait-il accepté à cette date ? (contrôle à blanc d'un avenant, avant sa signature). */
	async rentChangeBlockerFor(id: string, effectiveFrom: string): Promise<string | null> {
		const c = this.context();
		const today = toIsoDate();
		const row = await this.leaseRow(c, id);
		if (!(VALIDATED_STATUSES as readonly string[]).includes(row.status)) return 'LEASE_NOT_VALIDATED';
		const existing = await c.tx
			.select()
			.from(rentDues)
			.where(and(eq(rentDues.organizationId, c.organizationId), eq(rentDues.leaseId, id)));
		const current = await scheduleInput(c.tx, row, scheduleUntil({ endOn: row.endsOn, duesStartOn: row.duesStartOn }, today));
		return rentChangeBlocker(current, effectiveFrom, existing);
	}

	/** Renouvellement par un avenant signé : même chemin que la reconduction au terme (renewLease), version attendue. */
	async renewByAmendment(
		id: string,
		change: { newEndsOn: string | null; renewedOn: string; expectedVersion: number; amendmentId: string }
	): Promise<number> {
		const c = this.context();
		const row = await this.leaseRow(c, id, true);
		if (change.expectedVersion !== row.version) {
			throw new AppError('VERSION_CONFLICT', 'Le bail a changé entre-temps : régénérez l’avenant.', 409, {
				expected: change.expectedVersion,
				current: row.version
			});
		}
		const updated = await renewLease(
			c.tx,
			this.audit,
			row,
			{ newEndsOn: change.newEndsOn, renewedOn: change.renewedOn, automatic: false, amendmentId: change.amendmentId },
			toIsoDate(),
			c.actor
		);
		return updated.version;
	}

	/** Ce que le contrat cite du bail (module leases) : le bail, son locataire avec l'état civil, ses comptes de caution. */
	async contractInputs(id: string): Promise<{ lease: LeaseRow; tenant: TenantRow; deposits: AccountRow[] }> {
		const c = this.context();
		const lease = await this.leaseRow(c, id);
		const tenant = await this.tenantRow(c, lease.tenantId);
		const deposits = await c.tx
			.select()
			.from(depositAccounts)
			.where(and(eq(depositAccounts.organizationId, c.organizationId), eq(depositAccounts.leaseId, id)));
		return { lease, tenant, deposits };
	}

	/** Version courante d'un bail (synchronisation : version attendue d'un changement de loyer). */
	async leaseState(
		id: string
	): Promise<{ status: LeaseRow['status']; version: number; rent: number; charges: number; rentEffectiveFrom: string }> {
		const c = this.context();
		const row = await this.leaseRow(c, id);
		return { status: row.status, version: row.version, rent: row.rent, charges: row.charges, rentEffectiveFrom: row.rentEffectiveFrom };
	}

	/** Statut des échéances du bail rafraîchi à la date du jour (la tâche de nuit le fait aussi pour tous). */
	async refreshLeaseDues(id: string): Promise<void> {
		const c = this.context();
		await this.leaseRow(c, id);
		await refreshDueStatuses(c.tx, this.audit, c.organizationId, toIsoDate(), c.actor, undefined, [id]);
	}

	// ---------------------------------------------------------------- comptes de caution

	private async accountViews(c: Context, lease: LeaseRow): Promise<DepositAccountView[]> {
		const accounts = await c.tx
			.select()
			.from(depositAccounts)
			.where(and(eq(depositAccounts.organizationId, c.organizationId), eq(depositAccounts.leaseId, lease.id)))
			.orderBy(asc(depositAccounts.type));
		if (!accounts.length) return [];
		const movements = await c.tx
			.select()
			.from(depositMovements)
			.where(
				and(
					eq(depositMovements.organizationId, c.organizationId),
					inArray(
						depositMovements.accountId,
						accounts.map((a) => a.id)
					)
				)
			)
			.orderBy(asc(depositMovements.occurredOn), asc(depositMovements.id));
		return accounts.map((a) =>
			accountView(
				a,
				movements.filter((m) => m.accountId === a.id),
				lease.rent
			)
		);
	}

	private async accountRow(c: Context, id: string, lock = false): Promise<AccountRow> {
		const q = c.tx
			.select()
			.from(depositAccounts)
			.where(and(eq(depositAccounts.organizationId, c.organizationId), eq(depositAccounts.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw ACCOUNT_NOT_FOUND();
		return row;
	}

	private async accountViewOf(c: Context, accountId: string): Promise<DepositAccountView> {
		const account = await this.accountRow(c, accountId);
		const lease = await this.leaseRow(c, account.leaseId);
		return (await this.accountViews(c, lease)).find((a) => a.id === accountId)!;
	}

	/** Au-delà de deux mois de loyer (hors charges, caution seulement) : avertissement et ligne d'audit, sans blocage. */
	private async capWarning(c: Context, account: AccountRow, lease: LeaseRow): Promise<LeaseWarning[]> {
		if (!depositAboveLegalCap(account.type, account.agreedAmount, lease.rent)) return [];
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'deposit.above_legal_cap',
			objectType: 'deposit_account',
			objectId: account.id,
			after: { leaseId: lease.id, agreedAmount: account.agreedAmount, rent: lease.rent, capMonths: 2 }
		});
		return ['DEPOSIT_ABOVE_LEGAL_CAP'];
	}

	/** Proposition de détenteur (l'écran l'affiche ; le détenteur reste obligatoire à la création). */
	async proposedHolder(leaseId: string): Promise<'organization' | 'owner'> {
		const c = this.context();
		const lease = await this.leaseRow(c, leaseId);
		const mandate = await this.owners.managementMandateFor(lease.unitId, lease.startsOn);
		if (c.landlord) return 'organization';
		return mandate?.canCollectFunds ? 'organization' : 'owner';
	}

	async createDepositAccount(input: CreateDepositAccountData): Promise<WithWarnings<DepositAccountView>> {
		const c = this.context();
		const lease = await this.leaseRow(c, input.leaseId);
		if (lease.status === 'ended' || lease.status === 'cancelled') {
			throw new AppError('LEASE_CLOSED', 'Ce bail est terminé ou annulé : il ne change plus.', 409);
		}
		if (!allowedDepositHolders(c.organizationType).includes(input.holder)) {
			throw new AppError('LANDLORD_IS_HOLDER', 'Un bailleur particulier détient lui-même la caution.', 409);
		}
		const exists = await c.tx.select({ id: depositAccounts.id }).from(depositAccounts).where(eq(depositAccounts.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Ce compte de caution existe déjà.', 409);
		const [row] = await c.tx
			.insert(depositAccounts)
			.values({
				id: input.id,
				organizationId: c.organizationId,
				leaseId: input.leaseId,
				type: input.type,
				agreedAmount: input.agreedAmount,
				agreedMonths: input.agreedMonths,
				holder: input.holder,
				status: 'pending',
				createdBy: c.userId
			})
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'deposit.create',
			objectType: 'deposit_account',
			objectId: input.id,
			after: {
				leaseId: input.leaseId,
				type: input.type,
				agreedAmount: input.agreedAmount,
				agreedMonths: input.agreedMonths,
				holder: input.holder
			}
		});
		const warnings = await this.capWarning(c, row!, lease);
		return { data: await this.accountViewOf(c, input.id), warnings };
	}

	/** Montant convenu : modifiable tant que le bail est un brouillon (la base l'exige aussi). */
	async updateDepositAgreed(
		id: string,
		input: { agreedAmount?: number; agreedMonths?: number | null }
	): Promise<WithWarnings<DepositAccountView>> {
		const c = this.context();
		const account = await this.accountRow(c, id, true);
		const lease = await this.leaseRow(c, account.leaseId);
		if (lease.status !== 'draft')
			throw new AppError('DEPOSIT_TERMS_LOCKED', 'Le montant convenu ne change plus après la validation du bail.', 409);
		const next = {
			agreedAmount: input.agreedAmount ?? account.agreedAmount,
			agreedMonths: input.agreedMonths === undefined ? account.agreedMonths : input.agreedMonths
		};
		const changes = diff({ agreedAmount: account.agreedAmount, agreedMonths: account.agreedMonths }, next);
		if (!changes) return { data: await this.accountViewOf(c, id), warnings: [] };
		const [updated] = await c.tx
			.update(depositAccounts)
			.set({ ...next, updatedAt: new Date() })
			.where(and(eq(depositAccounts.organizationId, c.organizationId), eq(depositAccounts.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'deposit.update',
			objectType: 'deposit_account',
			objectId: id,
			...changes
		});
		const warnings = await this.capWarning(c, updated!, lease);
		return { data: await this.accountViewOf(c, id), warnings };
	}

	/** Versement reçu, saisi à la main au lot 08 (relié à un encaissement avec reçu au lot 09) ; en plusieurs fois. */
	async receiveDeposit(input: DepositReceiptData): Promise<DepositAccountView> {
		const c = this.context();
		const account = await this.accountRow(c, input.accountId, true);
		await this.leaseRow(c, account.leaseId);
		const movements = await c.tx
			.select()
			.from(depositMovements)
			.where(and(eq(depositMovements.organizationId, c.organizationId), eq(depositMovements.accountId, account.id)));
		const blocker = depositMovementBlocker(account, depositBalances(account.agreedAmount, movements), {
			type: 'received',
			amount: input.amount
		});
		if (blocker) {
			const messages = {
				DEPOSIT_OVERPAID: 'Ce versement dépasse le montant convenu de la caution.',
				DEPOSIT_OUTFLOW_EXCEEDS_RECEIVED: 'Les sorties ne dépassent jamais la caution reçue.',
				DEPOSIT_ACCOUNT_CLOSED: 'Ce compte de caution est soldé.'
			} as const;
			throw new AppError(blocker, messages[blocker], 409);
		}
		await this.insertMovement(c, {
			id: input.id,
			accountId: account.id,
			type: 'received',
			amount: input.amount,
			occurredOn: input.occurredOn,
			reason: input.reason
		});
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'deposit.receive',
			objectType: 'deposit_account',
			objectId: account.id,
			after: { movementId: input.id, amount: input.amount, occurredOn: input.occurredOn, reason: input.reason }
		});
		return this.accountViewOf(c, account.id);
	}

	/** Changement de détenteur en cours de bail : un mouvement motivé, jamais une modification du compte. */
	async changeDepositHolder(input: DepositHolderChangeData): Promise<DepositAccountView> {
		const c = this.context();
		const account = await this.accountRow(c, input.accountId, true);
		await this.leaseRow(c, account.leaseId);
		if (!allowedDepositHolders(c.organizationType).includes(input.newHolder)) {
			throw new AppError('LANDLORD_IS_HOLDER', 'Un bailleur particulier détient lui-même la caution.', 409);
		}
		if (account.holder === input.newHolder) throw new AppError('DEPOSIT_HOLDER_UNCHANGED', 'Ce détenteur détient déjà la caution.', 409);
		await this.insertMovement(c, {
			id: input.id,
			accountId: account.id,
			type: 'holder_changed',
			amount: 0,
			previousHolder: account.holder,
			newHolder: input.newHolder,
			occurredOn: input.occurredOn,
			reason: input.reason
		});
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'deposit.holder_change',
			objectType: 'deposit_account',
			objectId: account.id,
			before: { holder: account.holder },
			after: { holder: input.newHolder, movementId: input.id, reason: input.reason }
		});
		return this.accountViewOf(c, account.id);
	}

	private async insertMovement(c: Context, m: Omit<typeof depositMovements.$inferInsert, 'organizationId' | 'createdBy'>): Promise<void> {
		const exists = await c.tx.select({ id: depositMovements.id }).from(depositMovements).where(eq(depositMovements.id, m.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Ce mouvement existe déjà.', 409);
		await c.tx.insert(depositMovements).values({ ...m, organizationId: c.organizationId, createdBy: c.userId });
	}
}
