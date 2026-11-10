/**
 * Propriétaires et mandats (lot 06) : service public du module owners, utilisé par ses routes HTTP, par l'envoi des
 * modifications de l'appareil (même validation, mêmes règles, même audit) et par le crochet de création d'un
 * bailleur. Toute écriture passe par la transaction de l'organisation active (RequestContext.tx()) et écrit sa ligne
 * d'audit, avec la valeur avant et après (règle 4).
 *
 * - Créer une fiche propriétaire n'envoie aucune invitation et ne publie rien.
 * - Un mandat naît actif ; le modifier crée la version suivante (la base l'exige et en garde la copie) ; il ne fait que
 *   se fermer : révocation motivée, ou expiration à la date de fin. Un mandat fermé n'autorise plus rien.
 * - Bailleur particulier : sa fiche et son mandat self_managed naissent avec l'organisation ; il n'en crée pas d'autres.
 */
import { Injectable } from '@nestjs/common';
import { toIsoDate } from '@ziga/shared/dates';
import {
	commissionColumns,
	commissionFromColumns,
	isManagementMandate,
	mandateTermsSchema,
	ownerSchema,
	type CommissionColumns,
	type CreateMandateData,
	type MandateTerms,
	type MandateVersionView,
	type MandateView,
	type OwnerData,
	type OwnerDetailView,
	type OwnerView,
	type UpdateMandateInput,
	type UpdateOwnerInput
} from '@ziga/shared/owners';
import { newId } from '@ziga/shared/ids';
import { and, asc, eq } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import { mandates, mandateVersions, owners } from '../../db/schema/owners.js';
import { AuditService, diff, type AuditActor } from '../audit/audit.service.js';
import type { OrganizationCreated } from '../organizations/organization-hooks.js';
import { expireDueMandates } from './mandate-expiry.js';

type OwnerRow = typeof owners.$inferSelect;
type MandateRow = typeof mandates.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function ownerView(o: OwnerRow): OwnerView {
	return {
		id: o.id,
		type: o.type,
		name: o.name,
		phone: o.phone,
		email: o.email,
		address: o.address,
		country: o.country,
		representative: o.representativeName && o.representativePhone ? { name: o.representativeName, phone: o.representativePhone } : null,
		notes: o.notes,
		status: o.status,
		archivedAt: iso(o.archivedAt),
		createdAt: o.createdAt.toISOString(),
		updatedAt: o.updatedAt.toISOString()
	};
}

/** Colonnes des conditions, communes à un mandat et à une version. */
type TermRow = Pick<
	MandateRow,
	| 'startsOn'
	| 'endsOn'
	| 'commissionBasis'
	| 'commissionRateBp'
	| 'commissionAmount'
	| 'canPublish'
	| 'canTakePhotos'
	| 'canCollectFunds'
	| 'canSignLeases'
	| 'exclusive'
>;

function termsOf(m: TermRow): MandateTerms {
	return {
		startsOn: m.startsOn,
		endsOn: m.endsOn,
		commission: commissionFromColumns({
			commission_basis: m.commissionBasis,
			commission_rate_bp: m.commissionRateBp,
			commission_amount: m.commissionAmount
		}),
		canPublish: m.canPublish,
		canTakePhotos: m.canTakePhotos,
		canCollectFunds: m.canCollectFunds,
		canSignLeases: m.canSignLeases,
		exclusive: m.exclusive
	};
}

export function mandateView(m: MandateRow): MandateView {
	return {
		id: m.id,
		ownerId: m.ownerId,
		type: m.type,
		...termsOf(m),
		status: m.status,
		revokedAt: iso(m.revokedAt),
		revocationReason: m.revocationReason,
		expiredAt: iso(m.expiredAt),
		version: m.version,
		createdAt: m.createdAt.toISOString(),
		updatedAt: m.updatedAt.toISOString()
	};
}

/** Colonnes d'un mandat à partir de ses conditions validées. */
function termValues(t: MandateTerms) {
	const c = commissionColumns(t.commission);
	return {
		startsOn: t.startsOn,
		endsOn: t.endsOn,
		commissionBasis: c.commission_basis,
		commissionRateBp: c.commission_rate_bp,
		commissionAmount: c.commission_amount,
		canPublish: t.canPublish,
		canTakePhotos: t.canTakePhotos,
		canCollectFunds: t.canCollectFunds,
		canSignLeases: t.canSignLeases,
		exclusive: t.exclusive
	};
}

function ownerData(o: OwnerRow): OwnerData {
	const v = ownerView(o);
	return {
		type: v.type,
		name: v.name,
		phone: v.phone,
		email: v.email,
		address: v.address,
		country: v.country,
		representative: v.representative,
		notes: v.notes
	};
}

const LANDLORD_ONLY_SELF = () =>
	new AppError('LANDLORD_SELF_MANAGED', 'Un bailleur particulier gère lui-même ses logements : ni autre propriétaire, ni mandat.', 403);

@Injectable()
export class OwnersService {
	constructor(private readonly audit: AuditService) {}

	private context(): { tx: Tx; organizationId: string; landlord: boolean; actor: AuditActor; userId: string } {
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		return {
			tx: RequestContext.tx(),
			organizationId: scope.organizationId,
			landlord: scope.organizationType === 'landlord',
			actor: { type: 'user', userId, role: scope.role },
			userId
		};
	}

	// ---------------------------------------------------------------- propriétaires

	async list(): Promise<OwnerView[]> {
		const { tx, organizationId } = this.context();
		const rows = await tx.select().from(owners).where(eq(owners.organizationId, organizationId)).orderBy(asc(owners.name), asc(owners.id));
		return rows.map(ownerView);
	}

	private async ownerRow(tx: Tx, organizationId: string, id: string, lock = false): Promise<OwnerRow> {
		const q = tx
			.select()
			.from(owners)
			.where(and(eq(owners.organizationId, organizationId), eq(owners.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		// Sous la RLS, le propriétaire d'une autre organisation est introuvable.
		if (!row) throw new AppError('OWNER_NOT_FOUND', 'Propriétaire introuvable.', 404);
		return row;
	}

	async get(id: string): Promise<OwnerDetailView> {
		const { tx, organizationId } = this.context();
		const row = await this.ownerRow(tx, organizationId, id);
		const list = await tx
			.select()
			.from(mandates)
			.where(and(eq(mandates.organizationId, organizationId), eq(mandates.ownerId, id)))
			.orderBy(asc(mandates.id));
		return { ...ownerView(row), mandates: list.map(mandateView) };
	}

	/** Fiche créée par l'organisation : aucune invitation, aucun SMS, rien de publié. */
	async createOwner(input: OwnerData & { id: string }): Promise<OwnerView> {
		const { tx, organizationId, landlord, actor, userId } = this.context();
		if (landlord) throw LANDLORD_ONLY_SELF();
		const exists = await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Ce propriétaire existe déjà.', 409);
		const [row] = await tx
			.insert(owners)
			.values({
				id: input.id,
				organizationId,
				type: input.type,
				name: input.name,
				phone: input.phone,
				email: input.email,
				address: input.address,
				country: input.country,
				representativeName: input.representative?.name ?? null,
				representativePhone: input.representative?.phone ?? null,
				notes: input.notes,
				status: 'active',
				createdBy: userId
			})
			.returning();
		const view = ownerView(row!);
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'owner.create',
			objectType: 'owner',
			objectId: view.id,
			after: { ...ownerData(row!), status: 'active' }
		});
		return view;
	}

	/** Modification : les champs reçus complètent la fiche, revalidée en entier (règle du représentant d'un groupe). */
	async updateOwner(id: string, input: UpdateOwnerInput): Promise<OwnerView> {
		const { tx, organizationId, actor } = this.context();
		const row = await this.ownerRow(tx, organizationId, id, true);
		const before = ownerData(row);
		const next = ownerSchema.parse({ ...before, ...input });
		const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
		if (!changes) return ownerView(row);
		const [updated] = await tx
			.update(owners)
			.set({
				type: next.type,
				name: next.name,
				phone: next.phone,
				email: next.email,
				address: next.address,
				country: next.country,
				representativeName: next.representative?.name ?? null,
				representativePhone: next.representative?.phone ?? null,
				notes: next.notes,
				updatedAt: new Date()
			})
			.where(and(eq(owners.organizationId, organizationId), eq(owners.id, id)))
			.returning();
		await this.audit.record(tx, { actor, organizationId, action: 'owner.update', objectType: 'owner', objectId: id, ...changes });
		return ownerView(updated!);
	}

	/** Archivage : refusé tant qu'un mandat est actif (les mandats échus sont d'abord expirés). */
	async archiveOwner(id: string): Promise<OwnerView> {
		const { tx, organizationId, actor } = this.context();
		const row = await this.ownerRow(tx, organizationId, id, true);
		if (row.status === 'archived') return ownerView(row);
		await expireDueMandates(tx, this.audit, organizationId, toIsoDate());
		const [active] = await tx
			.select({ id: mandates.id })
			.from(mandates)
			.where(and(eq(mandates.organizationId, organizationId), eq(mandates.ownerId, id), eq(mandates.status, 'active')))
			.limit(1);
		if (active) {
			throw new AppError('OWNER_HAS_ACTIVE_MANDATE', 'Ce propriétaire a un mandat actif : révoquez-le avant d’archiver la fiche.', 409);
		}
		const now = new Date();
		const [updated] = await tx
			.update(owners)
			.set({ status: 'archived', archivedAt: now, updatedAt: now })
			.where(and(eq(owners.organizationId, organizationId), eq(owners.id, id)))
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'owner.archive',
			objectType: 'owner',
			objectId: id,
			before: { status: 'active' },
			after: { status: 'archived' }
		});
		return ownerView(updated!);
	}

	// ---------------------------------------------------------------- mandats

	private async mandateRow(tx: Tx, organizationId: string, id: string, lock = false): Promise<MandateRow> {
		const q = tx
			.select()
			.from(mandates)
			.where(and(eq(mandates.organizationId, organizationId), eq(mandates.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw new AppError('MANDATE_NOT_FOUND', 'Mandat introuvable.', 404);
		return row;
	}

	/**
	 * Création : le mandat naît actif, en version 1. Avant un mandat de gestion, les expirations dues de l'organisation
	 * sont appliquées dans la même transaction (règle 12 : une unité n'attend pas la tâche de nuit pour être libérée).
	 */
	async createMandate(input: CreateMandateData): Promise<MandateView> {
		const { tx, organizationId, landlord, actor, userId } = this.context();
		if (landlord) throw LANDLORD_ONLY_SELF();
		const owner = await this.ownerRow(tx, organizationId, input.ownerId);
		if (owner.status === 'archived') throw new AppError('OWNER_ARCHIVED', 'Ce propriétaire est archivé.', 409);
		const exists = await tx.select({ id: mandates.id }).from(mandates).where(eq(mandates.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Ce mandat existe déjà.', 409);
		if (isManagementMandate(input.type)) await expireDueMandates(tx, this.audit, organizationId, toIsoDate());
		const [row] = await tx
			.insert(mandates)
			.values({
				id: input.id,
				organizationId,
				ownerId: input.ownerId,
				type: input.type,
				...termValues(input),
				status: 'active',
				version: 1,
				createdBy: userId,
				updatedBy: userId
			})
			.returning();
		const view = mandateView(row!);
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'mandate.create',
			objectType: 'mandate',
			objectId: view.id,
			after: { ownerId: view.ownerId, type: view.type, ...termsOf(row!), status: 'active', version: 1 }
		});
		return view;
	}

	/** Un mandat actif dont la date de fin est passée est expiré d'abord ; un mandat fermé ne change plus. */
	private async openMandate(tx: Tx, organizationId: string, id: string): Promise<MandateRow> {
		let row = await this.mandateRow(tx, organizationId, id, true);
		if (row.status === 'active' && row.endsOn && row.endsOn < toIsoDate()) {
			await expireDueMandates(tx, this.audit, organizationId, toIsoDate());
			row = await this.mandateRow(tx, organizationId, id);
		}
		if (row.type === 'self_managed') {
			throw new AppError('MANDATE_PERMANENT', 'Le mandat d’un bailleur qui gère lui-même est permanent.', 409);
		}
		if (row.status !== 'active') {
			throw new AppError('MANDATE_CLOSED', 'Ce mandat est révoqué ou expiré : il ne change plus.', 409, { status: row.status });
		}
		return row;
	}

	/** Modification d'un mandat actif : version suivante ; l'ancienne reste dans mandate_versions. */
	async updateMandate(id: string, input: UpdateMandateInput): Promise<MandateView> {
		const { tx, organizationId, actor, userId } = this.context();
		const row = await this.openMandate(tx, organizationId, id);
		const before = termsOf(row);
		const next = mandateTermsSchema(row.type).parse({ ...before, ...input });
		const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
		if (!changes) return mandateView(row);
		const [updated] = await tx
			.update(mandates)
			.set({ ...termValues(next), version: row.version + 1, updatedBy: userId, updatedAt: new Date() })
			.where(and(eq(mandates.organizationId, organizationId), eq(mandates.id, id)))
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'mandate.update',
			objectType: 'mandate',
			objectId: id,
			before: { ...changes.before, version: row.version },
			after: { ...changes.after, version: row.version + 1 }
		});
		return mandateView(updated!);
	}

	/** Révocation : motif obligatoire ; les autorisations tombent à faux immédiatement. */
	async revokeMandate(id: string, reason: string): Promise<MandateView> {
		const { tx, organizationId, actor, userId } = this.context();
		const row = await this.openMandate(tx, organizationId, id);
		const now = new Date();
		const [updated] = await tx
			.update(mandates)
			.set({
				status: 'revoked',
				revokedAt: now,
				revocationReason: reason,
				canPublish: false,
				canTakePhotos: false,
				canCollectFunds: false,
				canSignLeases: false,
				version: row.version + 1,
				updatedBy: userId,
				updatedAt: now
			})
			.where(and(eq(mandates.organizationId, organizationId), eq(mandates.id, id)))
			.returning();
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'mandate.revoke',
			objectType: 'mandate',
			objectId: id,
			before: {
				status: 'active',
				canPublish: row.canPublish,
				canTakePhotos: row.canTakePhotos,
				canCollectFunds: row.canCollectFunds,
				canSignLeases: row.canSignLeases,
				version: row.version
			},
			after: {
				status: 'revoked',
				reason,
				canPublish: false,
				canTakePhotos: false,
				canCollectFunds: false,
				canSignLeases: false,
				version: row.version + 1
			}
		});
		return mandateView(updated!);
	}

	/** Commission actuelle d'un mandat, en colonnes (une modification partielle venue de l'appareil la complète). */
	async commissionColumnsOf(id: string): Promise<CommissionColumns> {
		const { tx, organizationId } = this.context();
		const row = await this.mandateRow(tx, organizationId, id);
		return { commission_basis: row.commissionBasis, commission_rate_bp: row.commissionRateBp, commission_amount: row.commissionAmount };
	}

	/** Historique : toutes les versions, de la première à la dernière. */
	async versions(id: string): Promise<MandateVersionView[]> {
		const { tx, organizationId } = this.context();
		await this.mandateRow(tx, organizationId, id);
		const rows = await tx
			.select()
			.from(mandateVersions)
			.where(and(eq(mandateVersions.organizationId, organizationId), eq(mandateVersions.mandateId, id)))
			.orderBy(asc(mandateVersions.version));
		return rows.map((v) => ({
			mandateId: v.mandateId,
			version: v.version,
			...termsOf(v),
			status: v.status,
			revokedAt: iso(v.revokedAt),
			revocationReason: v.revocationReason,
			expiredAt: iso(v.expiredAt),
			changedBy: v.changedBy,
			recordedAt: v.recordedAt.toISOString()
		}));
	}

	// ---------------------------------------------------------------- bailleur particulier

	/**
	 * Crochet de création d'une organisation : un bailleur reçoit sa fiche propriétaire (raison sociale et téléphone de
	 * l'organisation) et son mandat self_managed permanent, toutes autorisations, dans la même transaction. Une seule
	 * fois : la base n'admet qu'un mandat self_managed par organisation.
	 */
	async createLandlordSelfManaged(tx: Tx, event: OrganizationCreated): Promise<void> {
		if (event.type !== 'landlord') return;
		const actor: AuditActor = { type: 'user', userId: event.userId, role: 'director' };
		const ownerId = newId();
		const mandateId = newId();
		const today = toIsoDate();
		await tx.insert(owners).values({
			id: ownerId,
			organizationId: event.organizationId,
			type: 'person',
			name: event.legalName,
			phone: event.phone,
			country: 'BF',
			status: 'active',
			createdBy: event.userId
		});
		await tx.insert(mandates).values({
			id: mandateId,
			organizationId: event.organizationId,
			ownerId,
			type: 'self_managed',
			startsOn: today,
			canPublish: true,
			canTakePhotos: true,
			canCollectFunds: true,
			canSignLeases: true,
			exclusive: false,
			status: 'active',
			version: 1,
			createdBy: event.userId,
			updatedBy: event.userId
		});
		await this.audit.record(tx, {
			actor,
			organizationId: event.organizationId,
			action: 'owner.create',
			objectType: 'owner',
			objectId: ownerId,
			after: { type: 'person', name: event.legalName, phone: event.phone, country: 'BF', status: 'active' }
		});
		await this.audit.record(tx, {
			actor,
			organizationId: event.organizationId,
			action: 'mandate.create',
			objectType: 'mandate',
			objectId: mandateId,
			after: {
				ownerId,
				type: 'self_managed',
				startsOn: today,
				canPublish: true,
				canTakePhotos: true,
				canCollectFunds: true,
				canSignLeases: true,
				status: 'active',
				version: 1
			}
		});
	}
}
