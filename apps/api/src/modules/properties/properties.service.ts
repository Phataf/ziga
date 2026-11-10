/**
 * Biens et unités (lot 07) : service public du module properties, utilisé par ses routes HTTP et par l'envoi des
 * modifications de l'appareil (même validation, mêmes règles, même audit). Toute écriture passe par la transaction de
 * l'organisation active (RequestContext.tx()) et écrit sa ligne d'audit, avec la valeur avant et après (règle 4).
 *
 * - Enregistrer n'est jamais publier (règle 7) : rien ici ne touche la vitrine.
 * - Statut d'unité (D14, règle 13) : seuls la fiche et l'état technique se modifient ; l'occupation se calcule
 *   (occupancyOf), elle n'est ni stockée ni écrite.
 * - Agent de terrain : il ne voit que ses unités affectées (et leur bien), n'y change que l'état technique ; une unité
 *   qui ne lui est pas affectée est pour lui introuvable (404), comme dans ses Sync Streams.
 * - Bailleur particulier : ses biens sont à sa propre fiche et couverts par son mandat self_managed dès la création.
 * - Quota d'unités de la formule vérifié à la création (unités non archivées), sous un verrou de l'organisation.
 */
import { Injectable } from '@nestjs/common';
import {
	canChangeRecordStatus,
	isAvailable,
	occupancyOf,
	propertySchema,
	unitSchema,
	type CreatePropertyData,
	type CreateUnitData,
	type PropertyData,
	type PropertyDetailView,
	type PropertyView,
	type RecordStatus,
	type TechnicalStatusData,
	type UnitData,
	type UnitView,
	type UpdatePropertyInput,
	type UpdateUnitInput
} from '@ziga/shared/properties';
import type { OrganizationRole } from '@ziga/shared/permissions';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import { neighborhoods } from '../../db/schema/geography.js';
import { properties, units } from '../../db/schema/properties.js';
import { AuditService, diff, type AuditActor } from '../audit/audit.service.js';
import { QuotasService } from '../features/quotas.service.js';
import { assertCan } from '../organizations/organization-context.js';
import { OwnersService } from '../owners/owners.service.js';

type PropertyRow = typeof properties.$inferSelect;
type UnitRow = typeof units.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function propertyView(p: PropertyRow): PropertyView {
	return {
		id: p.id,
		ownerId: p.ownerId,
		type: p.type,
		operation: p.operation,
		name: p.name,
		communeId: p.communeId,
		neighborhoodId: p.neighborhoodId,
		addressHint: p.addressHint,
		gps: p.gpsLat !== null && p.gpsLng !== null ? { lat: p.gpsLat, lng: p.gpsLng, accuracyM: p.gpsAccuracyM } : null,
		declaredLandDocuments: p.declaredLandDocuments,
		notes: p.notes,
		recordStatus: p.recordStatus,
		archivedAt: iso(p.archivedAt),
		createdAt: p.createdAt.toISOString(),
		updatedAt: p.updatedAt.toISOString()
	};
}

export function unitView(u: UnitRow): UnitView {
	// Au lot 07, aucun bail : l'occupation calculée est « libre » (lot 08 : signaux des baux de l'unité).
	const occupancy = occupancyOf([]);
	return {
		id: u.id,
		propertyId: u.propertyId,
		type: u.type,
		label: u.label,
		rooms: {
			bedrooms: u.bedrooms,
			livingRooms: u.livingRooms,
			kitchens: u.kitchens,
			bathrooms: u.bathrooms,
			terraces: u.terraces,
			laundries: u.laundries
		},
		surfaceM2: u.surfaceM2,
		landAreaM2: u.landAreaM2,
		usage: u.usage,
		furnished: u.furnished,
		amenities: u.amenities,
		rent: u.rent,
		charges: u.charges,
		depositAmount: u.depositAmount,
		advanceMonths: u.advanceMonths,
		assignedAgentId: u.assignedAgentId,
		recordStatus: u.recordStatus,
		archivedAt: iso(u.archivedAt),
		technicalStatus: u.technicalStatus,
		technicalReason: u.technicalReason,
		technicalExpectedOn: u.technicalExpectedOn,
		occupancy,
		available: isAvailable({ recordStatus: u.recordStatus, occupancy, technicalStatus: u.technicalStatus }),
		createdAt: u.createdAt.toISOString(),
		updatedAt: u.updatedAt.toISOString()
	};
}

function propertyData(p: PropertyRow): PropertyData {
	const v = propertyView(p);
	return {
		ownerId: v.ownerId,
		type: v.type,
		operation: v.operation,
		name: v.name,
		communeId: v.communeId,
		neighborhoodId: v.neighborhoodId,
		addressHint: v.addressHint,
		gps: v.gps,
		declaredLandDocuments: v.declaredLandDocuments,
		notes: v.notes
	};
}

function propertyValues(d: PropertyData) {
	return {
		ownerId: d.ownerId,
		type: d.type,
		operation: d.operation,
		name: d.name,
		communeId: d.communeId,
		neighborhoodId: d.neighborhoodId,
		addressHint: d.addressHint,
		gpsLat: d.gps?.lat ?? null,
		gpsLng: d.gps?.lng ?? null,
		gpsAccuracyM: d.gps?.accuracyM ?? null,
		declaredLandDocuments: d.declaredLandDocuments,
		notes: d.notes
	};
}

function unitData(u: UnitRow): UnitData {
	const v = unitView(u);
	return {
		type: v.type,
		label: v.label,
		rooms: v.rooms,
		surfaceM2: v.surfaceM2,
		landAreaM2: v.landAreaM2,
		usage: v.usage,
		furnished: v.furnished,
		amenities: v.amenities,
		rent: v.rent,
		charges: v.charges,
		depositAmount: v.depositAmount,
		advanceMonths: v.advanceMonths
	};
}

function unitValues(d: UnitData) {
	return {
		type: d.type,
		label: d.label,
		bedrooms: d.rooms.bedrooms,
		livingRooms: d.rooms.livingRooms,
		kitchens: d.rooms.kitchens,
		bathrooms: d.rooms.bathrooms,
		terraces: d.rooms.terraces,
		laundries: d.rooms.laundries,
		surfaceM2: d.surfaceM2,
		landAreaM2: d.landAreaM2,
		usage: d.usage,
		furnished: d.furnished,
		amenities: d.amenities,
		rent: d.rent,
		charges: d.charges,
		depositAmount: d.depositAmount,
		advanceMonths: d.advanceMonths
	};
}

const PROPERTY_NOT_FOUND = () => new AppError('PROPERTY_NOT_FOUND', 'Bien introuvable.', 404);
const UNIT_NOT_FOUND = () => new AppError('UNIT_NOT_FOUND', 'Unité introuvable.', 404);

interface Context {
	tx: Tx;
	organizationId: string;
	landlord: boolean;
	role: OrganizationRole;
	planId: string;
	userId: string;
	actor: AuditActor;
}

@Injectable()
export class PropertiesService {
	constructor(
		private readonly audit: AuditService,
		private readonly owners: OwnersService,
		private readonly quotas: QuotasService
	) {}

	private context(): Context {
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		return {
			tx: RequestContext.tx(),
			organizationId: scope.organizationId,
			landlord: scope.organizationType === 'landlord',
			role: scope.role,
			planId: scope.planId,
			userId,
			actor: { type: 'user', userId, role: scope.role }
		};
	}

	/** Agent de terrain : seulement ses unités affectées. Les autres rôles voient toute l'organisation. */
	private agentOnly(c: Context): string | null {
		return c.role === 'field_agent' ? c.userId : null;
	}

	// ---------------------------------------------------------------- lecture

	async list(): Promise<PropertyDetailView[]> {
		const c = this.context();
		const agent = this.agentOnly(c);
		const unitRows = await c.tx
			.select()
			.from(units)
			.where(and(eq(units.organizationId, c.organizationId), agent ? eq(units.assignedAgentId, agent) : undefined))
			.orderBy(asc(units.label), asc(units.id));
		const propertyIds = agent ? [...new Set(unitRows.map((u) => u.propertyId))] : null;
		if (propertyIds && !propertyIds.length) return [];
		const rows = await c.tx
			.select()
			.from(properties)
			.where(and(eq(properties.organizationId, c.organizationId), propertyIds ? inArray(properties.id, propertyIds) : undefined))
			.orderBy(asc(properties.name), asc(properties.id));
		return rows.map((p) => ({ ...propertyView(p), units: unitRows.filter((u) => u.propertyId === p.id).map(unitView) }));
	}

	async get(id: string): Promise<PropertyDetailView> {
		const c = this.context();
		const agent = this.agentOnly(c);
		const row = await this.propertyRow(c, id);
		const unitRows = await c.tx
			.select()
			.from(units)
			.where(
				and(eq(units.organizationId, c.organizationId), eq(units.propertyId, id), agent ? eq(units.assignedAgentId, agent) : undefined)
			)
			.orderBy(asc(units.label), asc(units.id));
		// Un bien sans unité affectée n'existe pas pour l'agent de terrain.
		if (agent && !unitRows.length) throw PROPERTY_NOT_FOUND();
		return { ...propertyView(row), units: unitRows.map(unitView) };
	}

	async getUnit(id: string): Promise<UnitView> {
		const c = this.context();
		return unitView(await this.unitRow(c, id));
	}

	private async propertyRow(c: Context, id: string, lock = false): Promise<PropertyRow> {
		const q = c.tx
			.select()
			.from(properties)
			.where(and(eq(properties.organizationId, c.organizationId), eq(properties.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		// Sous la RLS, le bien d'une autre organisation est introuvable.
		if (!row) throw PROPERTY_NOT_FOUND();
		return row;
	}

	/** Unité de l'organisation ; pour l'agent de terrain, seulement une unité qui lui est affectée. */
	private async unitRow(c: Context, id: string, lock = false): Promise<UnitRow> {
		const q = c.tx
			.select()
			.from(units)
			.where(and(eq(units.organizationId, c.organizationId), eq(units.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw UNIT_NOT_FOUND();
		const agent = this.agentOnly(c);
		if (agent && row.assignedAgentId !== agent) throw UNIT_NOT_FOUND();
		return row;
	}

	// ---------------------------------------------------------------- biens

	/** Le quartier choisi appartient à la commune choisie (la base le vérifie aussi). */
	private async checkLocation(c: Context, d: Pick<PropertyData, 'communeId' | 'neighborhoodId'>): Promise<void> {
		if (!d.neighborhoodId) return;
		const [n] = await c.tx
			.select({ communeId: neighborhoods.communeId })
			.from(neighborhoods)
			.where(eq(neighborhoods.id, d.neighborhoodId))
			.limit(1);
		if (!n || n.communeId !== d.communeId) {
			throw new AppError('NEIGHBORHOOD_NOT_IN_COMMUNE', 'Ce quartier n’appartient pas à la commune choisie.', 400);
		}
	}

	/** Propriétaire actif de l'organisation ; un bailleur n'a que sa propre fiche. */
	private async checkOwner(c: Context, ownerId: string): Promise<void> {
		if (c.landlord && ownerId !== (await this.owners.landlordOwnerId())) {
			throw new AppError('LANDLORD_SELF_MANAGED', 'Un bailleur particulier n’enregistre que ses propres biens.', 403);
		}
		const owner = await this.owners.get(ownerId);
		if (owner.status === 'archived') throw new AppError('OWNER_ARCHIVED', 'Ce propriétaire est archivé.', 409);
	}

	/** Création en brouillon ; rien n'est publié. Bailleur : couvert par son mandat self_managed. */
	async createProperty(input: CreatePropertyData): Promise<PropertyView> {
		const c = this.context();
		await this.checkOwner(c, input.ownerId);
		await this.checkLocation(c, input);
		const exists = await c.tx.select({ id: properties.id }).from(properties).where(eq(properties.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Ce bien existe déjà.', 409);
		const [row] = await c.tx
			.insert(properties)
			.values({ id: input.id, organizationId: c.organizationId, ...propertyValues(input), recordStatus: 'draft', createdBy: c.userId })
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'property.create',
			objectType: 'property',
			objectId: input.id,
			after: { ...propertyData(row!), recordStatus: 'draft' }
		});
		await this.owners.coverWithSelfManaged(input.id);
		return propertyView(row!);
	}

	async updateProperty(id: string, input: UpdatePropertyInput): Promise<PropertyView> {
		const c = this.context();
		const row = await this.propertyRow(c, id, true);
		const before = propertyData(row);
		const next = propertySchema.parse({ ...before, ...input });
		if (next.ownerId !== before.ownerId) await this.checkOwner(c, next.ownerId);
		await this.checkLocation(c, next);
		if (row.recordStatus !== 'draft' && (!next.communeId || !next.neighborhoodId)) {
			throw new AppError('PROPERTY_LOCATION_REQUIRED', 'Un bien actif garde sa commune et son quartier.', 400);
		}
		const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
		if (!changes) return propertyView(row);
		const [updated] = await c.tx
			.update(properties)
			.set({ ...propertyValues(next), updatedAt: new Date() })
			.where(and(eq(properties.organizationId, c.organizationId), eq(properties.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'property.update',
			objectType: 'property',
			objectId: id,
			...changes
		});
		return propertyView(updated!);
	}

	/**
	 * Fiche du bien : brouillon → active (commune et quartier exigés) ; archivée (toutes ses unités archivées d'abord) ;
	 * une fiche archivée peut être réactivée. Jamais de retour au brouillon.
	 */
	async setPropertyStatus(id: string, status: Exclude<RecordStatus, 'draft'>): Promise<PropertyView> {
		const c = this.context();
		const row = await this.propertyRow(c, id, true);
		if (row.recordStatus === status) return propertyView(row);
		if (!canChangeRecordStatus(row.recordStatus, status)) throw statusRefused(row.recordStatus, status);
		if (status === 'active' && (!row.communeId || !row.neighborhoodId)) {
			throw new AppError('PROPERTY_LOCATION_REQUIRED', 'Choisissez la commune et le quartier avant d’activer le bien.', 400);
		}
		if (status === 'archived') {
			const [open] = await c.tx
				.select({ id: units.id })
				.from(units)
				.where(and(eq(units.organizationId, c.organizationId), eq(units.propertyId, id), ne(units.recordStatus, 'archived')))
				.limit(1);
			if (open) throw new AppError('PROPERTY_HAS_UNITS', 'Archivez d’abord les unités de ce bien.', 409);
		}
		const now = new Date();
		const [updated] = await c.tx
			.update(properties)
			.set({ recordStatus: status, archivedAt: status === 'archived' ? now : null, updatedAt: now })
			.where(and(eq(properties.organizationId, c.organizationId), eq(properties.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: status === 'archived' ? 'property.archive' : 'property.activate',
			objectType: 'property',
			objectId: id,
			before: { recordStatus: row.recordStatus },
			after: { recordStatus: status }
		});
		return propertyView(updated!);
	}

	// ---------------------------------------------------------------- unités

	/** Création : bien de l'organisation non archivé ; quota d'unités de la formule (unités non archivées). */
	async createUnit(input: CreateUnitData): Promise<UnitView> {
		const c = this.context();
		const property = await this.propertyRow(c, input.propertyId);
		if (property.recordStatus === 'archived') throw new AppError('PROPERTY_ARCHIVED', 'Ce bien est archivé.', 409);
		const exists = await c.tx.select({ id: units.id }).from(units).where(eq(units.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Cette unité existe déjà.', 409);
		// Deux créations simultanées ne dépassent pas le quota : verrou de l'organisation pour la transaction.
		await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`units:${c.organizationId}`}, 0))`);
		const [counted] = await c.tx
			.select({ n: sql<number>`count(*)::int` })
			.from(units)
			.where(and(eq(units.organizationId, c.organizationId), ne(units.recordStatus, 'archived')));
		await this.quotas.assert(c.organizationId, c.planId, 'units', counted?.n ?? 0);
		const [row] = await c.tx
			.insert(units)
			.values({
				id: input.id,
				organizationId: c.organizationId,
				propertyId: input.propertyId,
				...unitValues(input),
				recordStatus: 'draft',
				technicalStatus: 'ready',
				createdBy: c.userId
			})
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'unit.create',
			objectType: 'unit',
			objectId: input.id,
			after: { propertyId: input.propertyId, ...unitData(row!), recordStatus: 'draft', technicalStatus: 'ready' }
		});
		return unitView(row!);
	}

	async updateUnit(id: string, input: UpdateUnitInput): Promise<UnitView> {
		const c = this.context();
		const row = await this.unitRow(c, id, true);
		const before = unitData(row);
		const next = unitSchema.parse({ ...before, ...input, rooms: { ...before.rooms, ...(input.rooms ?? {}) } });
		const changes = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
		if (!changes) return unitView(row);
		const [updated] = await c.tx
			.update(units)
			.set({ ...unitValues(next), updatedAt: new Date() })
			.where(and(eq(units.organizationId, c.organizationId), eq(units.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'unit.update',
			objectType: 'unit',
			objectId: id,
			...changes
		});
		return unitView(updated!);
	}

	/** État technique (saisi) : le seul changement de statut ouvert à l'agent de terrain, sur ses unités. */
	async setTechnicalStatus(id: string, input: TechnicalStatusData): Promise<UnitView> {
		const c = this.context();
		const row = await this.unitRow(c, id, true);
		const before = { technicalStatus: row.technicalStatus, reason: row.technicalReason, expectedOn: row.technicalExpectedOn };
		const changes = diff(before, input);
		if (!changes) return unitView(row);
		const [updated] = await c.tx
			.update(units)
			.set({
				technicalStatus: input.technicalStatus,
				technicalReason: input.reason,
				technicalExpectedOn: input.expectedOn,
				updatedAt: new Date()
			})
			.where(and(eq(units.organizationId, c.organizationId), eq(units.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'unit.technical_status',
			objectType: 'unit',
			objectId: id,
			...changes
		});
		return unitView(updated!);
	}

	/** Fiche de l'unité : mêmes transitions que le bien ; une unité active exige un bien actif. */
	async setUnitStatus(id: string, status: Exclude<RecordStatus, 'draft'>): Promise<UnitView> {
		const c = this.context();
		const row = await this.unitRow(c, id, true);
		if (row.recordStatus === status) return unitView(row);
		if (!canChangeRecordStatus(row.recordStatus, status)) throw statusRefused(row.recordStatus, status);
		if (status === 'active') {
			const property = await this.propertyRow(c, row.propertyId);
			if (property.recordStatus !== 'active') {
				throw new AppError('PROPERTY_NOT_ACTIVE', 'Activez d’abord le bien de cette unité.', 409);
			}
			// Réactiver une unité archivée la compte de nouveau dans le quota.
			if (row.recordStatus === 'archived') {
				await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`units:${c.organizationId}`}, 0))`);
				const [counted] = await c.tx
					.select({ n: sql<number>`count(*)::int` })
					.from(units)
					.where(and(eq(units.organizationId, c.organizationId), ne(units.recordStatus, 'archived')));
				await this.quotas.assert(c.organizationId, c.planId, 'units', counted?.n ?? 0);
			}
		}
		const now = new Date();
		const [updated] = await c.tx
			.update(units)
			.set({ recordStatus: status, archivedAt: status === 'archived' ? now : null, updatedAt: now })
			.where(and(eq(units.organizationId, c.organizationId), eq(units.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: status === 'archived' ? 'unit.archive' : 'unit.activate',
			objectType: 'unit',
			objectId: id,
			before: { recordStatus: row.recordStatus },
			after: { recordStatus: status }
		});
		return unitView(updated!);
	}

	/** Affectation à un agent de terrain actif de l'organisation (la base vérifie le rôle), ou retrait. */
	async assign(id: string, agentId: string | null): Promise<UnitView> {
		const c = this.context();
		assertCan(c.role, 'unit.assign');
		const row = await this.unitRow(c, id, true);
		if (row.assignedAgentId === agentId) return unitView(row);
		const [updated] = await c.tx
			.update(units)
			.set({ assignedAgentId: agentId, updatedAt: new Date() })
			.where(and(eq(units.organizationId, c.organizationId), eq(units.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'unit.assign',
			objectType: 'unit',
			objectId: id,
			before: { assignedAgentId: row.assignedAgentId },
			after: { assignedAgentId: agentId }
		});
		return unitView(updated!);
	}
}

function statusRefused(from: RecordStatus, to: RecordStatus): AppError {
	return new AppError('RECORD_TRANSITION_NOT_ALLOWED', 'Ce changement de statut n’est pas permis.', 409, { from, to });
}
