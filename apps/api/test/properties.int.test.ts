/**
 * Lot 07, étape 2 : biens et unités par l'API et par la synchronisation (POST /sync/upload), portées des mandats,
 * quartiers du back-office.
 * - Création en brouillon, activation, archivage ; audit avant et après ; rien n'est publié.
 * - L'occupation ne s'écrit ni par l'API ni par la synchronisation.
 * - Agent de terrain : il ne voit et ne modifie que ses unités affectées (état technique seulement).
 * - Quota d'unités de la formule ; bailleur couvert par son mandat self_managed ; règle 12 par l'API et l'appareil.
 * - Accès croisé A/B par l'API et par l'appareil.
 * - Back-office : ajout et correction d'un quartier, audités ; réservé au super administrateur et à l'assistance.
 */
import { newId } from '@ziga/shared/ids';
import type { NeighborhoodView } from '@ziga/shared/geography';
import type { MandateScopeView, MandateView, OwnerView } from '@ziga/shared/owners';
import type { PropertyDetailView, PropertyView, UnitView } from '@ziga/shared/properties';
import type { SyncOperationResult } from '@ziga/shared/sync';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPhone, signedUp, startApp, type Client, type TestApp } from './http.js';
import { addMember, createOrg, type Member, type Org } from './orgs.js';

let t: TestApp;
let a: Org;
let b: Org;
let manager: Member;
let agent: Member;
let viewer: Member;
let owner: pg.Client;
let tampouy: string;
let saabaVillage: string;
let counter = 0;

const key = () => `properties-${newId()}:${++counter}`;

async function createOwner(m: Member): Promise<OwnerView> {
	const r = await m.call<OwnerView>('POST', '/owners', {
		id: newId(),
		type: 'person',
		name: 'Mariam Zongo',
		phone: newPhone(),
		country: 'BF'
	});
	if (r.status !== 201) throw new Error(`propriétaire : ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
}

async function createMandate(m: Member, ownerId: string): Promise<MandateView> {
	const r = await m.call<MandateView>('POST', '/mandates', {
		id: newId(),
		ownerId,
		type: 'rental_management',
		startsOn: '2026-01-01',
		commission: { basis: 'percent_of_collected', rateBp: 1000 },
		canPublish: true,
		canTakePhotos: true
	});
	if (r.status !== 201) throw new Error(`mandat : ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
}

async function createProperty(m: Member, ownerId: string, extra: Record<string, unknown> = {}): Promise<PropertyView> {
	const r = await m.call<PropertyView>('POST', '/properties', {
		id: newId(),
		ownerId,
		type: 'apartment_building',
		name: 'Immeuble Tampouy',
		communeId: 'ouagadougou',
		neighborhoodId: tampouy,
		addressHint: 'Derrière la pharmacie du marché',
		gps: { lat: 12.389, lng: -1.577, accuracyM: 8 },
		...extra
	});
	if (r.status !== 201) throw new Error(`bien : ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
}

async function createUnit(m: Member, propertyId: string, label: string, extra: Record<string, unknown> = {}): Promise<UnitView> {
	const r = await m.call<UnitView>('POST', '/units', {
		id: newId(),
		propertyId,
		type: 'apartment',
		label,
		rooms: { bedrooms: 2, livingRooms: 1, kitchens: 1, bathrooms: 1 },
		amenities: ['fence', 'separate_electricity_meter'],
		rent: 75_000,
		...extra
	});
	if (r.status !== 201) throw new Error(`unité : ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
}

async function upload(c: Member | Client, operations: unknown[]): Promise<SyncOperationResult[]> {
	const client = 'client' in c ? c.client : c;
	const r = await client.call<{ results: SyncOperationResult[] }>('POST', '/sync/upload', { operations });
	expect(r.status).toBe(200);
	return r.body.results;
}

async function audit(organizationId: string | null, objectId: string) {
	const r = await owner.query(
		`select action, origin, before, after from audit_log where organization_id is not distinct from $1 and object_id = $2 order by id`,
		[organizationId, objectId]
	);
	return r.rows as { action: string; origin: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[];
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A biens API');
	b = await createOrg(t, 'agency', 'Agence B biens API');
	manager = await addMember(t, a, 'manager');
	agent = await addMember(t, a, 'field_agent');
	viewer = await addMember(t, a, 'viewer');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	tampouy = (await owner.query(`select id from neighborhoods where commune_id = 'ouagadougou' and name = 'Tampouy'`)).rows[0].id;
	saabaVillage = (await owner.query(`select id from neighborhoods where commune_id = 'saaba' order by name limit 1`)).rows[0].id;
});
afterAll(async () => {
	await owner.end();
	await t.close();
});

describe('biens et unités par l’API', () => {
	it('création en brouillon, audit avant et après ; activation, unités, statut calculé', async () => {
		const o = await createOwner(a.director);
		const p = await createProperty(manager, o.id);
		expect(p).toMatchObject({ recordStatus: 'draft', neighborhoodId: tampouy, gps: { lat: 12.389, lng: -1.577, accuracyM: 8 } });
		const u = await createUnit(manager, p.id, 'Appartement A1');
		expect(u).toMatchObject({ recordStatus: 'draft', technicalStatus: 'ready', occupancy: 'free', available: false, rent: 75_000 });
		// L'unité ne s'active qu'avec son bien.
		expect((await manager.call('POST', `/units/${u.id}/status`, { status: 'active' })).body).toMatchObject({ code: 'PROPERTY_NOT_ACTIVE' });
		expect((await manager.call('POST', `/properties/${p.id}/status`, { status: 'active' })).body).toMatchObject({ recordStatus: 'active' });
		expect((await manager.call('POST', `/units/${u.id}/status`, { status: 'active' })).body).toMatchObject({
			recordStatus: 'active',
			occupancy: 'free',
			available: true
		});
		// En travaux : plus disponible ; motif obligatoire.
		expect((await manager.call('POST', `/units/${u.id}/technical-status`, { technicalStatus: 'under_works' })).status).toBe(400);
		const works = await manager.call<UnitView>('POST', `/units/${u.id}/technical-status`, {
			technicalStatus: 'under_works',
			reason: 'Réfection de la toiture',
			expectedOn: '2026-12-15'
		});
		expect(works.body).toMatchObject({ technicalStatus: 'under_works', technicalReason: 'Réfection de la toiture', available: false });
		expect((await audit(a.id, p.id)).map((l) => l.action)).toEqual(['property.create', 'property.activate']);
		expect((await audit(a.id, u.id)).map((l) => [l.action, l.origin])).toEqual([
			['unit.create', 'app'],
			['unit.activate', 'app'],
			['unit.technical_status', 'app']
		]);
		const technical = (await audit(a.id, u.id)).at(-1)!;
		expect(technical.before).toEqual({ technicalStatus: 'ready', reason: null, expectedOn: null });
		expect(technical.after).toEqual({ technicalStatus: 'under_works', reason: 'Réfection de la toiture', expectedOn: '2026-12-15' });
		// Lecture : le bien et ses unités.
		const detail = await manager.call<PropertyDetailView>('GET', `/properties/${p.id}`);
		expect(detail.body.units.map((x) => x.label)).toEqual(['Appartement A1']);
	});

	it('règles de statut : un bien s’active avec sa localisation, s’archive après ses unités, ne revient jamais au brouillon', async () => {
		const o = await createOwner(a.director);
		const bare = await createProperty(manager, o.id, { communeId: null, neighborhoodId: null, gps: null });
		expect((await manager.call('POST', `/properties/${bare.id}/status`, { status: 'active' })).body).toMatchObject({
			code: 'PROPERTY_LOCATION_REQUIRED'
		});
		// Le quartier doit appartenir à la commune choisie.
		expect(
			(await manager.call('PATCH', `/properties/${bare.id}`, { communeId: 'ouagadougou', neighborhoodId: saabaVillage })).body
		).toMatchObject({
			code: 'NEIGHBORHOOD_NOT_IN_COMMUNE'
		});
		const p = await createProperty(manager, o.id);
		const u = await createUnit(manager, p.id, 'Studio 1', { type: 'studio' });
		expect((await manager.call('POST', `/properties/${p.id}/status`, { status: 'archived' })).body).toMatchObject({
			code: 'PROPERTY_HAS_UNITS'
		});
		await manager.call('POST', `/units/${u.id}/status`, { status: 'archived' });
		expect((await manager.call('POST', `/properties/${p.id}/status`, { status: 'archived' })).body).toMatchObject({
			recordStatus: 'archived'
		});
		expect((await manager.call('POST', `/properties/${p.id}/status`, { status: 'draft' })).status).toBe(400);
		// Un libellé par bien.
		const p2 = await createProperty(manager, o.id);
		await createUnit(manager, p2.id, 'Appartement B2');
		const dup = await manager.call('POST', '/units', { id: newId(), propertyId: p2.id, type: 'apartment', label: 'appartement b2' });
		expect(dup.body).toMatchObject({ code: 'UNIT_LABEL_TAKEN' });
	});

	it('l’occupation ne s’écrit pas : champ refusé par la route et par la synchronisation', async () => {
		const o = await createOwner(a.director);
		const p = await createProperty(manager, o.id);
		const u = await createUnit(manager, p.id, 'Appartement C1');
		expect((await manager.call('PATCH', `/units/${u.id}`, { occupancy: 'occupied' })).status).toBe(400);
		expect(
			(await manager.call('POST', '/units', { id: newId(), propertyId: p.id, type: 'studio', label: 'S', occupancy: 'occupied' })).body
		).not.toHaveProperty('occupancy', 'occupied');
		const [r] = await upload(manager, [
			{ key: key(), op: 'PATCH', table: 'units', id: u.id, organizationId: a.id, data: { occupancy: 'occupied' } }
		]);
		expect(r).toMatchObject({ status: 'rejected', code: 'FIELD_NOT_WRITABLE' });
		const [put] = await upload(manager, [
			{
				key: key(),
				op: 'PUT',
				table: 'units',
				id: newId(),
				data: { organization_id: a.id, property_id: p.id, type: 'studio', label: 'S2', occupancy: 'free' }
			}
		]);
		expect(put).toMatchObject({ status: 'rejected', code: 'FIELD_NOT_WRITABLE' });
	});
});

describe('agent de terrain : ses unités affectées seulement', () => {
	let p: PropertyView;
	let mine: UnitView;
	let other: UnitView;
	let elsewhere: PropertyView;

	beforeAll(async () => {
		const o = await createOwner(a.director);
		p = await createProperty(manager, o.id, { name: 'Cour commune Pissy' });
		mine = await createUnit(manager, p.id, 'Chambre-salon 1', { type: 'room_lounge' });
		other = await createUnit(manager, p.id, 'Chambre-salon 2', { type: 'room_lounge' });
		elsewhere = await createProperty(manager, o.id, { name: 'Villa non affectée' });
		await createUnit(manager, elsewhere.id, 'Villa', { type: 'villa' });
		const assigned = await manager.call<UnitView>('POST', `/units/${mine.id}/assign`, { agentId: agent.userId });
		expect(assigned.body.assignedAgentId).toBe(agent.userId);
	});

	it('l’affectation vise un agent de terrain actif ; jamais un autre rôle ; jamais par l’agent lui-même', async () => {
		expect((await manager.call('POST', `/units/${other.id}/assign`, { agentId: viewer.userId })).body).toMatchObject({
			code: 'UNIT_AGENT_NOT_FIELD_AGENT'
		});
		expect((await manager.call('POST', `/units/${other.id}/assign`, { agentId: b.director.userId })).body).toMatchObject({
			code: 'UNIT_AGENT_NOT_FIELD_AGENT'
		});
		expect((await agent.call('POST', `/units/${mine.id}/assign`, { agentId: null })).status).toBe(403);
		expect((await audit(a.id, mine.id)).map((l) => l.action)).toContain('unit.assign');
	});

	it('lecture : seulement son unité et son bien ; une unité non affectée est introuvable', async () => {
		const list = await agent.call<PropertyDetailView[]>('GET', '/properties');
		expect(list.body.map((x) => [x.id, x.units.map((u) => u.id)])).toEqual([[p.id, [mine.id]]]);
		expect((await agent.call('GET', `/properties/${elsewhere.id}`)).status).toBe(404);
		expect((await agent.call('GET', `/units/${other.id}`)).status).toBe(404);
		expect((await agent.call<UnitView>('GET', `/units/${mine.id}`)).body.id).toBe(mine.id);
	});

	it('écriture : l’état technique de son unité, rien d’autre', async () => {
		const ok = await agent.call<UnitView>('POST', `/units/${mine.id}/technical-status`, {
			technicalStatus: 'to_refurbish',
			reason: 'Peinture à refaire'
		});
		expect(ok.body).toMatchObject({ technicalStatus: 'to_refurbish' });
		expect(
			(await agent.call('POST', `/units/${other.id}/technical-status`, { technicalStatus: 'to_refurbish', reason: 'Peinture' })).status
		).toBe(404);
		expect((await agent.call('PATCH', `/units/${mine.id}`, { rent: 1 })).status).toBe(403);
		expect((await agent.call('POST', '/properties', { id: newId(), ownerId: p.ownerId, type: 'house', name: 'Maison' })).status).toBe(403);
		const results = await upload(agent, [
			{
				key: key(),
				op: 'PATCH',
				table: 'units',
				id: mine.id,
				organizationId: a.id,
				data: { technical_status: 'ready', technical_reason: null }
			},
			{
				key: key(),
				op: 'PATCH',
				table: 'units',
				id: other.id,
				organizationId: a.id,
				data: { technical_status: 'unavailable', technical_reason: 'Fuite' }
			},
			{ key: key(), op: 'PATCH', table: 'units', id: mine.id, organizationId: a.id, data: { rent: 1 } },
			{ key: key(), op: 'PATCH', table: 'units', id: mine.id, organizationId: a.id, data: { assigned_agent_id: null } },
			{ key: key(), op: 'PATCH', table: 'properties', id: p.id, organizationId: a.id, data: { name: 'Renommé' } }
		]);
		expect(results.map((r) => [r.status, r.code])).toEqual([
			['applied', undefined],
			['rejected', 'UNIT_NOT_FOUND'],
			['rejected', 'FORBIDDEN_ACTION'],
			['rejected', 'FORBIDDEN_ACTION'],
			['rejected', 'FORBIDDEN_ACTION']
		]);
		const sync = (await audit(a.id, mine.id)).at(-1)!;
		expect(sync).toMatchObject({ action: 'unit.technical_status', origin: 'sync', after: { technicalStatus: 'ready' } });
	});

	it('le profil lecture lit tout, sans rien modifier', async () => {
		const list = await viewer.call<PropertyDetailView[]>('GET', '/properties');
		expect(list.body.map((x) => x.id)).toEqual(expect.arrayContaining([p.id, elsewhere.id]));
		expect((await viewer.call('POST', `/units/${mine.id}/technical-status`, { technicalStatus: 'ready' })).status).toBe(403);
		expect((await viewer.call('PATCH', `/properties/${p.id}`, { name: 'Lecture' })).status).toBe(403);
	});
});

describe('quota d’unités et bailleur particulier', () => {
	it('bailleur (formule Découverte, 10 unités) : biens couverts par son mandat self_managed ; la 11e unité est refusée', async () => {
		const landlord = await createOrg(t, 'landlord', 'Bailleur Ouédraogo');
		const sheet = (await landlord.director.call<OwnerView[]>('GET', '/owners')).body[0]!;
		const p = await createProperty(landlord.director, sheet.id, { name: 'Cour familiale' });
		await landlord.director.call('POST', `/properties/${p.id}/status`, { status: 'active' });
		const scopes = await owner.query(
			`select m.type, s.unit_id, s.management_active from mandate_scopes s join mandates m on m.id = s.mandate_id where s.property_id = $1`,
			[p.id]
		);
		expect(scopes.rows).toEqual([{ type: 'self_managed', unit_id: null, management_active: true }]);
		// Un bailleur n'enregistre que ses propres biens.
		const intrus = await landlord.director.call('POST', '/properties', { id: newId(), ownerId: newId(), type: 'house', name: 'Autre' });
		expect(intrus.body).toMatchObject({ code: 'LANDLORD_SELF_MANAGED' });
		for (let i = 1; i <= 10; i += 1) await createUnit(landlord.director, p.id, `Chambre ${i}`, { type: 'single_room' });
		const eleventh = await landlord.director.call('POST', '/units', {
			id: newId(),
			propertyId: p.id,
			type: 'single_room',
			label: 'Chambre 11'
		});
		expect(eleventh.status).toBe(403);
		expect(eleventh.body).toMatchObject({ code: 'QUOTA_EXCEEDED' });
		// Chaque unité suit le bien : couverte par le mandat du bailleur.
		const covered = await owner.query(
			`select count(*)::int as n from mandate_scopes where property_id = $1 and unit_id is not null and management_active`,
			[p.id]
		);
		expect(covered.rows[0].n).toBe(10);
		// Archiver une unité libère une place ; la réactiver la reprend.
		const first = (await landlord.director.call<PropertyDetailView>('GET', `/properties/${p.id}`)).body.units[0]!;
		await landlord.director.call('POST', `/units/${first.id}/status`, { status: 'archived' });
		await createUnit(landlord.director, p.id, 'Chambre 11', { type: 'single_room' });
		expect((await landlord.director.call('POST', `/units/${first.id}/status`, { status: 'active' })).body).toMatchObject({
			code: 'QUOTA_EXCEEDED'
		});
	});
});

describe('portées des mandats (règle 12) par l’API et par l’appareil', () => {
	it('un mandat couvre un bien entier ; un second mandat de gestion sur une unité est refusé, en ligne comme hors ligne', async () => {
		const o = await createOwner(a.director);
		const p = await createProperty(manager, o.id);
		const u1 = await createUnit(manager, p.id, 'D1');
		const first = await createMandate(manager, o.id);
		const scopes = await manager.call<MandateScopeView[]>('POST', `/mandates/${first.id}/scopes`, { id: newId(), propertyId: p.id });
		expect(scopes.status).toBe(201);
		expect(scopes.body.map((s) => [s.unitId, s.viaProperty, s.managementActive])).toEqual([
			[null, false, true],
			[u1.id, true, true]
		]);
		// Une unité créée ensuite est couverte d'office.
		const u2 = await createUnit(manager, p.id, 'D2');
		expect((await manager.call<MandateScopeView[]>('GET', `/mandates/${first.id}/scopes`)).body.map((s) => s.unitId)).toContain(u2.id);
		const second = await createMandate(manager, o.id);
		const refused = await manager.call('POST', `/mandates/${second.id}/scopes`, { id: newId(), propertyId: p.id, unitId: u1.id });
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({ code: 'UNIT_ALREADY_MANAGED' });
		const [offline] = await upload(manager, [
			{
				key: key(),
				op: 'PUT',
				table: 'mandate_scopes',
				id: newId(),
				data: { organization_id: a.id, mandate_id: second.id, property_id: p.id, unit_id: u2.id }
			}
		]);
		expect(offline).toMatchObject({ status: 'rejected', code: 'UNIT_ALREADY_MANAGED' });
		// Le propriétaire du bien est verrouillé tant que le mandat de gestion est actif.
		const other = await createOwner(a.director);
		expect((await manager.call('PATCH', `/properties/${p.id}`, { ownerId: other.id })).body).toMatchObject({
			code: 'PROPERTY_OWNER_LOCKED'
		});
		expect((await audit(a.id, first.id)).map((l) => l.action)).toContain('mandate.scope_add');
	});

	it('par l’appareil : bien, unité, portée et activation, dans l’ordre de la file', async () => {
		const o = await createOwner(a.director);
		const mandate = await createMandate(manager, o.id);
		const propertyId = newId();
		const unitId = newId();
		const results = await upload(manager, [
			{
				key: key(),
				op: 'PUT',
				table: 'properties',
				id: propertyId,
				data: {
					organization_id: a.id,
					owner_id: o.id,
					type: 'house',
					operation: 'rent',
					name: 'Villa hors ligne',
					commune_id: 'ouagadougou',
					neighborhood_id: tampouy,
					gps_lat: 12.39,
					gps_lng: -1.58,
					declared_land_documents: '["puh"]',
					record_status: 'draft'
				}
			},
			{
				key: key(),
				op: 'PUT',
				table: 'units',
				id: unitId,
				data: {
					organization_id: a.id,
					property_id: propertyId,
					type: 'villa',
					label: 'Villa',
					bedrooms: 3,
					furnished: 1,
					amenities: '["fence","garage"]',
					rent: 150000
				}
			},
			{
				key: key(),
				op: 'PUT',
				table: 'mandate_scopes',
				id: newId(),
				data: { organization_id: a.id, mandate_id: mandate.id, property_id: propertyId }
			},
			{ key: key(), op: 'PATCH', table: 'properties', id: propertyId, organizationId: a.id, data: { record_status: 'active' } },
			{ key: key(), op: 'PATCH', table: 'units', id: unitId, organizationId: a.id, data: { record_status: 'active', rent: 160000 } }
		]);
		expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
		const p = await manager.call<PropertyDetailView>('GET', `/properties/${propertyId}`);
		expect(p.body).toMatchObject({
			recordStatus: 'active',
			declaredLandDocuments: ['puh'],
			gps: { lat: 12.39, lng: -1.58, accuracyM: null }
		});
		expect(p.body.units[0]).toMatchObject({
			recordStatus: 'active',
			furnished: true,
			amenities: ['fence', 'garage'],
			rent: 160000,
			rooms: { bedrooms: 3 },
			available: true
		});
		expect((await audit(a.id, propertyId)).map((l) => [l.action, l.origin])).toEqual([
			['property.create', 'sync'],
			['property.activate', 'sync']
		]);
		// Un bien ne naît pas actif depuis l'appareil.
		const [born] = await upload(manager, [
			{
				key: key(),
				op: 'PUT',
				table: 'properties',
				id: newId(),
				data: { organization_id: a.id, owner_id: o.id, type: 'land', name: 'Terrain', record_status: 'active' }
			}
		]);
		expect(born).toMatchObject({ status: 'rejected', code: 'STATUS_NOT_ALLOWED' });
	});
});

describe('accès croisé A/B par l’API et par l’appareil (règle 1)', () => {
	it('B ne lit, ne modifie ni ne référence rien de A', async () => {
		const o = await createOwner(a.director);
		const p = await createProperty(manager, o.id);
		const u = await createUnit(manager, p.id, 'E1');
		expect((await b.director.call('GET', `/properties/${p.id}`)).status).toBe(404);
		expect((await b.director.call('GET', `/units/${u.id}`)).status).toBe(404);
		expect((await b.director.call<PropertyDetailView[]>('GET', '/properties')).body.map((x) => x.id)).not.toContain(p.id);
		expect((await b.director.call('PATCH', `/properties/${p.id}`, { name: 'Piraté' })).status).toBe(404);
		expect(
			(await b.director.call('POST', `/units/${u.id}/technical-status`, { technicalStatus: 'unavailable', reason: 'Piraté' })).status
		).toBe(404);
		expect((await b.director.call('POST', '/units', { id: newId(), propertyId: p.id, type: 'studio', label: 'Intrus' })).status).toBe(404);
		expect((await b.director.call('POST', '/properties', { id: newId(), ownerId: o.id, type: 'house', name: 'Intrus' })).status).toBe(404);
		const results = await upload(b.director, [
			{ key: key(), op: 'PATCH', table: 'properties', id: p.id, organizationId: b.id, data: { name: 'Piraté' } },
			{ key: key(), op: 'PATCH', table: 'units', id: u.id, organizationId: a.id, data: { label: 'Piraté' } },
			{
				key: key(),
				op: 'PUT',
				table: 'units',
				id: newId(),
				data: { organization_id: b.id, property_id: p.id, type: 'studio', label: 'Intrus' }
			}
		]);
		expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
		expect((await owner.query(`select name from properties where id = $1`, [p.id])).rows[0].name).toBe('Immeuble Tampouy');
		expect((await owner.query(`select label from units where id = $1`, [u.id])).rows[0].label).toBe('E1');
	});
});

describe('back-office : quartiers (lot 07)', () => {
	let support: Client;
	let sales: Client;

	async function staff(role: string): Promise<Client> {
		const { client } = await signedUp(t);
		const userId = ((await client.call('GET', '/me')).body as { id: string }).id;
		await owner.query(`update users set platform_role = $2 where id = $1`, [userId, role]);
		return client;
	}

	beforeAll(async () => {
		support = await staff('support');
		sales = await staff('sales');
	});

	it('liste avec la vérification ; ajout et correction audités ; doublon, vérification sans point : refusés', async () => {
		const list = await sales.call<{ neighborhoods: NeighborhoodView[] }>('GET', '/admin/geography');
		expect(list.status).toBe(200);
		expect(list.body.neighborhoods.find((n) => n.name === 'Bendogo')).toMatchObject({ lat: null, verified: false });
		const id = newId();
		const name = `Quartier ${id.slice(-6)}`;
		expect((await sales.call('POST', '/admin/neighborhoods', { id, communeId: 'saaba', name })).status).toBe(403);
		const created = await support.call<NeighborhoodView>('POST', '/admin/neighborhoods', { id, communeId: 'saaba', name });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		expect(created.body).toMatchObject({ communeId: 'saaba', name, lat: null, verified: false });
		const dup = await support.call('POST', '/admin/neighborhoods', { id: newId(), communeId: 'saaba', name: name.toUpperCase() });
		expect(dup.body).toMatchObject({ code: 'NEIGHBORHOOD_EXISTS' });
		expect((await support.call('PATCH', `/admin/neighborhoods/${id}`, { verified: true })).body).toMatchObject({
			code: 'NEIGHBORHOOD_POINT_REQUIRED'
		});
		const fixed = await support.call<NeighborhoodView>('PATCH', `/admin/neighborhoods/${id}`, {
			point: { lat: 12.38, lng: -1.41 },
			verified: true
		});
		expect(fixed.body).toMatchObject({ lat: 12.38, lng: -1.41, verified: true });
		// Un point déplacé n'est plus vérifié.
		const moved = await support.call<NeighborhoodView>('PATCH', `/admin/neighborhoods/${id}`, { point: { lat: 12.381, lng: -1.411 } });
		expect(moved.body.verified).toBe(false);
		expect((await audit(null, id)).map((l) => [l.action, l.origin])).toEqual([
			['neighborhood.create', 'admin'],
			['neighborhood.update', 'admin'],
			['neighborhood.update', 'admin']
		]);
		// Les organisations n'y touchent pas.
		expect((await a.director.call('POST', '/admin/neighborhoods', { id: newId(), communeId: 'saaba', name: 'Intrus' })).status).toBe(403);
	});
});
