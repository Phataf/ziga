/**
 * Biens et unités de test (lot 07), écrits en SQL dans le contexte d'une organisation (client déjà dans sa
 * transaction de contexte). Les portées de mandat (lot 06) visent désormais de vrais biens et de vraies unités.
 */
import { newId } from '@ziga/shared/ids';
import type pg from 'pg';

/** Un quartier du référentiel (migration 0009), pour les biens actifs. */
export async function aNeighborhood(c: pg.Client, commune = 'ouagadougou'): Promise<string> {
	const r = await c.query(`select id from neighborhoods where commune_id = $1 order by name limit 1`, [commune]);
	return r.rows[0].id as string;
}

export async function insertProperty(
	c: pg.Client,
	organizationId: string,
	ownerId: string,
	extra: { name?: string; recordStatus?: 'draft' | 'active'; neighborhoodId?: string; gps?: [number, number] } = {}
): Promise<string> {
	const id = newId();
	const located = extra.recordStatus === 'active' || extra.neighborhoodId;
	const neighborhood = located ? (extra.neighborhoodId ?? (await aNeighborhood(c))) : null;
	await c.query(
		`insert into properties (id, organization_id, owner_id, type, name, commune_id, neighborhood_id, record_status, gps_lat, gps_lng)
		 values ($1, $2, $3, 'apartment_building', $4, $5, $6, $7, $8, $9)`,
		[
			id,
			organizationId,
			ownerId,
			extra.name ?? 'Immeuble de test',
			neighborhood ? 'ouagadougou' : null,
			neighborhood,
			extra.recordStatus ?? 'draft',
			extra.gps?.[0] ?? null,
			extra.gps?.[1] ?? null
		]
	);
	return id;
}

export async function insertUnit(
	c: pg.Client,
	organizationId: string,
	propertyId: string,
	extra: { label?: string; agentId?: string | null } = {}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into units (id, organization_id, property_id, type, label, assigned_agent_id) values ($1, $2, $3, 'apartment', $4, $5)`,
		[id, organizationId, propertyId, extra.label ?? `Appartement ${id.slice(-6)}`, extra.agentId ?? null]
	);
	return id;
}

/** Un bien du propriétaire avec une unité. */
export async function propertyWithUnit(c: pg.Client, organizationId: string, ownerId: string): Promise<{ property: string; unit: string }> {
	const property = await insertProperty(c, organizationId, ownerId);
	const unit = await insertUnit(c, organizationId, property);
	return { property, unit };
}
