/**
 * Référentiel géographique (lot 07) : communes et quartiers de la plateforme (migration 0009_geography). Lu par tous ;
 * complété par le back-office seul, qui passe sa transaction (connexion app_admin, la seule à pouvoir y écrire).
 * Chaque ajout ou correction écrit une ligne d'audit de plateforme (origine admin), avec la valeur avant et après.
 * Un quartier ne se supprime jamais : les biens le référencent.
 */
import { Injectable } from '@nestjs/common';
import type { CommuneView, CreateNeighborhoodInput, NeighborhoodView, UpdateNeighborhoodInput } from '@ziga/shared/geography';
import { createNeighborhoodSchema, placeNameKey, updateNeighborhoodSchema } from '@ziga/shared/geography';
import { asc, eq } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import type { Tx } from '../../db/database.js';
import { communes, neighborhoods } from '../../db/schema/geography.js';
import { AuditService, diff, type AuditActor } from '../audit/audit.service.js';

type NeighborhoodRow = typeof neighborhoods.$inferSelect;

function neighborhoodView(n: NeighborhoodRow): NeighborhoodView {
	return {
		id: n.id,
		communeId: n.communeId,
		name: n.name,
		lat: n.lat,
		lng: n.lng,
		osmRef: n.osmRef,
		verified: n.verified,
		createdAt: n.createdAt.toISOString(),
		updatedAt: n.updatedAt.toISOString()
	};
}

/** Ce que l'audit garde d'un quartier. */
function audited(n: Pick<NeighborhoodRow, 'communeId' | 'name' | 'lat' | 'lng' | 'verified'>) {
	return { communeId: n.communeId, name: n.name, lat: n.lat, lng: n.lng, verified: n.verified };
}

@Injectable()
export class GeographyService {
	constructor(private readonly audit: AuditService) {}

	async communes(tx: Tx): Promise<CommuneView[]> {
		const rows = await tx.select().from(communes).orderBy(asc(communes.name));
		return rows.map((c) => ({ id: c.id, name: c.name, lat: c.lat, lng: c.lng, osmRef: c.osmRef, verified: c.verified }));
	}

	async neighborhoods(tx: Tx): Promise<NeighborhoodView[]> {
		const rows = await tx.select().from(neighborhoods).orderBy(asc(neighborhoods.communeId), asc(neighborhoods.name));
		return rows.map(neighborhoodView);
	}

	private async row(tx: Tx, id: string): Promise<NeighborhoodRow> {
		const [row] = await tx.select().from(neighborhoods).where(eq(neighborhoods.id, id)).limit(1);
		if (!row) throw new AppError('NEIGHBORHOOD_NOT_FOUND', 'Quartier introuvable.', 404);
		return row;
	}

	/** Un nom par commune, accents et casse confondus (la base le garantit aussi). */
	private async assertFreeName(tx: Tx, communeId: string, name: string, except?: string): Promise<void> {
		const same = (await tx.select().from(neighborhoods).where(eq(neighborhoods.communeId, communeId))).find(
			(n) => n.id !== except && placeNameKey(n.name) === placeNameKey(name)
		);
		if (same) throw new AppError('NEIGHBORHOOD_EXISTS', `Ce quartier existe déjà dans la commune : ${same.name}.`, 409);
	}

	async create(tx: Tx, actor: AuditActor, input: CreateNeighborhoodInput): Promise<NeighborhoodView> {
		const data = createNeighborhoodSchema.parse(input);
		const [commune] = await tx.select({ id: communes.id }).from(communes).where(eq(communes.id, data.communeId)).limit(1);
		if (!commune) throw new AppError('COMMUNE_NOT_FOUND', 'Commune introuvable.', 404);
		await this.assertFreeName(tx, data.communeId, data.name);
		const actorId = actor.type === 'user' ? actor.userId : null;
		const [row] = await tx
			.insert(neighborhoods)
			.values({
				id: data.id,
				communeId: data.communeId,
				name: data.name,
				lat: data.point?.lat ?? null,
				lng: data.point?.lng ?? null,
				verified: false,
				createdBy: actorId,
				updatedBy: actorId
			})
			.returning();
		await this.audit.record(tx, {
			actor,
			action: 'neighborhood.create',
			objectType: 'neighborhood',
			objectId: data.id,
			after: audited(row!),
			origin: 'admin'
		});
		return neighborhoodView(row!);
	}

	/** Correction : nom, point (null l'efface, et retire la vérification), vérification sur place (un point exigé). */
	async update(tx: Tx, actor: AuditActor, id: string, input: UpdateNeighborhoodInput): Promise<NeighborhoodView> {
		const data = updateNeighborhoodSchema.parse(input);
		const row = await this.row(tx, id);
		if (data.name !== undefined) await this.assertFreeName(tx, row.communeId, data.name, id);
		const point = data.point === undefined ? (row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null) : data.point;
		const pointChanged = data.point !== undefined && ((point?.lat ?? null) !== row.lat || (point?.lng ?? null) !== row.lng);
		// Un point déplacé n'est plus celui qu'on a vérifié, sauf si la même correction le déclare vérifié.
		const verified = data.verified ?? (pointChanged ? false : row.verified);
		if (verified && !point) throw new AppError('NEIGHBORHOOD_POINT_REQUIRED', 'Un quartier vérifié sur place a un point.', 400);
		const next = { communeId: row.communeId, name: data.name ?? row.name, lat: point?.lat ?? null, lng: point?.lng ?? null, verified };
		const changes = diff(audited(row), next);
		if (!changes) return neighborhoodView(row);
		const [updated] = await tx
			.update(neighborhoods)
			.set({
				name: next.name,
				lat: next.lat,
				lng: next.lng,
				verified: next.verified,
				updatedAt: new Date(),
				updatedBy: actor.type === 'user' ? actor.userId : null
			})
			.where(eq(neighborhoods.id, id))
			.returning();
		await this.audit.record(tx, {
			actor,
			action: 'neighborhood.update',
			objectType: 'neighborhood',
			objectId: id,
			...changes,
			origin: 'admin'
		});
		return neighborhoodView(updated!);
	}
}
