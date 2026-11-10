/**
 * Lot 06, étape 2 : propriétaires et mandats par l'API et par la synchronisation (POST /sync/upload).
 * - Permissions (directeur et gestionnaire ; l'agent de terrain et le profil lecture lisent seulement).
 * - Accès croisé A/B : lecture, modification, référence, par les routes et par la synchronisation.
 * - Aucune invitation ni aucun SMS à la création d'une fiche.
 * - Versions d'un mandat actif modifié, avec audit avant et après ; révocation motivée, autorisations à faux.
 * - Bailleur : fiche et mandat self_managed créés avec l'organisation, une seule fois ; rien d'autre.
 * - Expiration par la tâche de nuit (worker) ; expirations dues appliquées avant un nouveau mandat de gestion.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import type { MandateVersionView, MandateView, OwnerDetailView, OwnerView } from '@ziga/shared/owners';
import type { SyncOperationResult } from '@ziga/shared/sync';
import { Queue, QueueEvents } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import {
	MANDATES_EXPIRY_JOB,
	MANDATES_EXPIRY_PATTERN,
	MANDATES_EXPIRY_SCHEDULER,
	MANDATES_QUEUE,
	type MandatesExpiryJobResult
} from '../src/jobs/queues.js';
import { bullConnection } from '../src/redis/redis.module.js';
import { WorkerModule } from '../src/worker.module.js';
import { newPhone, startApp, type TestApp } from './http.js';
import { addMember, createOrg, type Member, type Org } from './orgs.js';

let t: TestApp;
let a: Org;
let b: Org;
let manager: Member;
let agent: Member;
let viewer: Member;
let owner: pg.Client;
let counter = 0;

const today = toIsoDate();
const key = () => `owners-${newId()}:${++counter}`;

type OwnerBody = { id: string; type: string; name: string; phone: string; country: string } & Record<string, unknown>;
const person = (name = 'Issa Ouédraogo'): OwnerBody => ({ id: newId(), type: 'person', name, phone: newPhone(), country: 'BF' });
const rentalMandate = (ownerId: string, extra: Record<string, unknown> = {}) => ({
	id: newId(),
	ownerId,
	type: 'rental_management',
	startsOn: today,
	commission: { basis: 'percent_of_collected', rateBp: 1000 },
	canPublish: true,
	canTakePhotos: true,
	canCollectFunds: true,
	...extra
});

async function createOwner(m: Member, body = person()): Promise<OwnerView> {
	const r = await m.call<OwnerView>('POST', '/owners', body);
	if (r.status !== 201) throw new Error(`propriétaire : ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
}

async function createMandate(m: Member, body: Record<string, unknown>): Promise<MandateView> {
	const r = await m.call<MandateView>('POST', '/mandates', body);
	if (r.status !== 201) throw new Error(`mandat : ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
}

async function upload(m: Member, operations: unknown[]): Promise<SyncOperationResult[]> {
	const r = await m.client.call<{ results: SyncOperationResult[] }>('POST', '/sync/upload', { operations });
	expect(r.status).toBe(200);
	return r.body.results;
}

async function audit(organizationId: string, objectId: string) {
	const r = await owner.query(
		`select action, origin, before, after from audit_log where organization_id = $1 and object_id = $2 order by id`,
		[organizationId, objectId]
	);
	return r.rows as { action: string; origin: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[];
}

/** Lecture du propriétaire du schéma, dans le contexte d'une organisation (RLS forcée). */
async function asOwner<T>(organizationId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
	await owner.query('BEGIN');
	try {
		await owner.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
		const r = await fn(owner);
		await owner.query('COMMIT');
		return r;
	} catch (error) {
		await owner.query('ROLLBACK');
		throw error;
	}
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A mandats');
	b = await createOrg(t, 'agency', 'Agence B mandats');
	manager = await addMember(t, a, 'manager');
	agent = await addMember(t, a, 'field_agent');
	viewer = await addMember(t, a, 'viewer');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
});
afterAll(async () => {
	await owner.end();
	await t.close();
});

describe('propriétaires : création sans invitation, permissions', () => {
	it('le gestionnaire crée une fiche : aucun SMS, aucune invitation, une ligne d’audit', async () => {
		const sent = t.sms.messages.length;
		const invitations = (await owner.query(`select count(*)::int as n from organization_invitations`)).rows[0].n;
		const body = person('Awa Traoré');
		const created = await createOwner(manager, { ...body, phone: '+33612345678', country: 'fr', email: 'Awa@Exemple.fr' });
		expect(created).toMatchObject({
			id: body.id,
			name: 'Awa Traoré',
			phone: '+33612345678',
			country: 'FR',
			email: 'awa@exemple.fr',
			status: 'active'
		});
		expect(t.sms.messages.length).toBe(sent);
		expect((await owner.query(`select count(*)::int as n from organization_invitations`)).rows[0].n).toBe(invitations);
		expect(await audit(a.id, body.id)).toEqual([
			expect.objectContaining({
				action: 'owner.create',
				origin: 'app',
				after: expect.objectContaining({ name: 'Awa Traoré', country: 'FR' })
			})
		]);
	});

	it('groupe d’indivisaires : représentant exigé', async () => {
		const group = { ...person('Héritiers Kaboré'), type: 'group' };
		expect((await manager.call('POST', '/owners', group)).status).toBe(400);
		const ok = await createOwner(manager, { ...group, id: newId(), representative: { name: 'Paul Kaboré', phone: '76000001' } });
		expect(ok.representative).toEqual({ name: 'Paul Kaboré', phone: '+22676000001' });
	});

	it('agent de terrain et profil lecture : lecture seulement', async () => {
		const o = await createOwner(a.director);
		for (const m of [agent, viewer]) {
			expect((await m.call('GET', '/owners')).status).toBe(200);
			expect((await m.call('GET', `/owners/${o.id}`)).status).toBe(200);
			expect((await m.call('POST', '/owners', person())).body).toMatchObject({ code: 'FORBIDDEN_ACTION' });
			expect((await m.call('PATCH', `/owners/${o.id}`, { name: 'Changé' })).status).toBe(403);
		}
	});

	it('l’agent de terrain ne peut pas créer de mandat, ni par l’API ni par la synchronisation', async () => {
		const o = await createOwner(a.director);
		const body = rentalMandate(o.id);
		expect((await agent.call('POST', '/mandates', body)).body).toMatchObject({ code: 'FORBIDDEN_ACTION' });
		const [result] = await upload(agent, [
			{
				key: key(),
				op: 'PUT',
				table: 'mandates',
				id: body.id,
				data: {
					organization_id: a.id,
					owner_id: o.id,
					type: 'rental_management',
					starts_on: today,
					commission_basis: 'percent_of_collected',
					commission_rate_bp: 1000
				}
			}
		]);
		expect(result).toMatchObject({ status: 'rejected', code: 'FORBIDDEN_ACTION' });
		expect((await owner.query(`select count(*)::int as n from mandates where id = $1`, [body.id])).rows[0].n).toBe(0);
	});
});

describe('accès croisé A/B par l’API et par la synchronisation (règle 1)', () => {
	let ownerA: OwnerView;
	let mandateA: MandateView;
	beforeAll(async () => {
		ownerA = await createOwner(a.director, person('Propriétaire de A'));
		mandateA = await createMandate(a.director, rentalMandate(ownerA.id));
	});

	it('B ne lit ni ne modifie la fiche ou le mandat de A (404), et ne les voit pas dans sa liste', async () => {
		expect((await b.director.call('GET', `/owners/${ownerA.id}`)).body).toMatchObject({ code: 'OWNER_NOT_FOUND' });
		expect((await b.director.call('PATCH', `/owners/${ownerA.id}`, { name: 'Piraté' })).status).toBe(404);
		expect((await b.director.call('POST', `/owners/${ownerA.id}/archive`)).status).toBe(404);
		expect((await b.director.call('PATCH', `/mandates/${mandateA.id}`, { exclusive: true })).body).toMatchObject({
			code: 'MANDATE_NOT_FOUND'
		});
		expect((await b.director.call('POST', `/mandates/${mandateA.id}/revoke`, { reason: 'Tentative' })).status).toBe(404);
		expect((await b.director.call('GET', `/mandates/${mandateA.id}/versions`)).status).toBe(404);
		const list = await b.director.call<OwnerView[]>('GET', '/owners');
		expect(list.body.map((o) => o.id)).not.toContain(ownerA.id);
	});

	it('B ne peut pas créer un mandat sur le propriétaire de A (référence), ni par l’API ni par la synchronisation', async () => {
		expect((await b.director.call('POST', '/mandates', rentalMandate(ownerA.id))).body).toMatchObject({ code: 'OWNER_NOT_FOUND' });
		const [r] = await upload(b.director, [
			{
				key: key(),
				op: 'PUT',
				table: 'mandates',
				id: newId(),
				data: { organization_id: b.id, owner_id: ownerA.id, type: 'other', starts_on: today }
			}
		]);
		expect(r).toMatchObject({ status: 'rejected', code: 'OWNER_NOT_FOUND', organizationId: b.id });
	});

	it('synchronisation : écrire chez A en se disant de A (non membre), ou en forgeant son organisation : refusé, rien ne change', async () => {
		const results = await upload(b.director, [
			{ key: key(), op: 'PATCH', table: 'owners', id: ownerA.id, organizationId: a.id, data: { name: 'Piraté' } },
			{ key: key(), op: 'PATCH', table: 'owners', id: ownerA.id, organizationId: b.id, data: { name: 'Piraté' } },
			{ key: key(), op: 'PATCH', table: 'mandates', id: mandateA.id, organizationId: b.id, data: { exclusive: 1 } },
			{
				key: key(),
				op: 'PUT',
				table: 'owners',
				id: newId(),
				data: { organization_id: a.id, type: 'person', name: 'Intrus', phone: '+22670112233' }
			},
			{ key: key(), op: 'PATCH', table: 'owners', id: ownerA.id, data: { name: 'Sans organisation' } }
		]);
		expect(results.map((r) => r.code)).toEqual([
			'NOT_A_MEMBER',
			'OWNER_NOT_FOUND',
			'MANDATE_NOT_FOUND',
			'NOT_A_MEMBER',
			'ORGANIZATION_REQUIRED'
		]);
		const row = await asOwner(a.id, (c) => c.query(`select name from owners where id = $1`, [ownerA.id]));
		expect(row.rows[0].name).toBe('Propriétaire de A');
	});
});

describe('mandats : versions, révocation, commission', () => {
	let o: OwnerView;
	beforeAll(async () => {
		o = await createOwner(a.director, person('Propriétaire mandats'));
	});

	it('modification d’un mandat actif : version 2, la version 1 reste, audit avant et après', async () => {
		const m = await createMandate(manager, rentalMandate(o.id, { canSignLeases: false }));
		expect(m).toMatchObject({
			status: 'active',
			version: 1,
			canSignLeases: false,
			commission: { basis: 'percent_of_collected', rateBp: 1000 }
		});
		const updated = await manager.call<MandateView>('PATCH', `/mandates/${m.id}`, {
			commission: { basis: 'percent_of_collected', rateBp: 800 },
			canPublish: false
		});
		expect(updated.body).toMatchObject({ version: 2, canPublish: false, commission: { rateBp: 800 } });
		const versions = await manager.call<MandateVersionView[]>('GET', `/mandates/${m.id}/versions`);
		expect(versions.body.map((v) => [v.version, v.canPublish, v.commission])).toEqual([
			[1, true, { basis: 'percent_of_collected', rateBp: 1000 }],
			[2, false, { basis: 'percent_of_collected', rateBp: 800 }]
		]);
		const lines = await audit(a.id, m.id);
		expect(lines.map((l) => l.action)).toEqual(['mandate.create', 'mandate.update']);
		expect(lines[1]).toMatchObject({
			before: { canPublish: true, commission: { rateBp: 1000 }, version: 1 },
			after: { canPublish: false, commission: { rateBp: 800 }, version: 2 }
		});
		// Une modification qui ne change rien ne crée pas de version.
		expect((await manager.call<MandateView>('PATCH', `/mandates/${m.id}`, { canPublish: false })).body.version).toBe(2);
	});

	it('commission : taux de 0 à 10 000 points de base, ou montant entier, jamais les deux', async () => {
		const bad = [
			{ basis: 'percent_of_collected', rateBp: 10_001 },
			{ basis: 'percent_of_collected', rateBp: 12.5 },
			{ basis: 'percent_of_collected', rateBp: 1000, amount: 5000 },
			{ basis: 'fixed_per_month', amount: 2500.5 }
		];
		for (const commission of bad) {
			expect((await manager.call('POST', '/mandates', rentalMandate(o.id, { commission }))).status, JSON.stringify(commission)).toBe(400);
		}
		const fixed = await createMandate(manager, {
			...rentalMandate(o.id),
			type: 'letting',
			commission: { basis: 'fixed_per_operation', amount: 150_000 }
		});
		expect(fixed.commission).toEqual({ basis: 'fixed_per_operation', amount: 150_000 });
	});

	it('révocation : motif obligatoire ; autorisations à faux ; ensuite plus rien ne change', async () => {
		const m = await createMandate(manager, rentalMandate(o.id, { canSignLeases: true }));
		expect((await manager.call('POST', `/mandates/${m.id}/revoke`, { reason: '' })).status).toBe(400);
		expect((await manager.call('POST', `/mandates/${m.id}/revoke`, {})).status).toBe(400);
		const revoked = await manager.call<MandateView>('POST', `/mandates/${m.id}/revoke`, { reason: 'Fin de collaboration' });
		expect(revoked.body).toMatchObject({
			status: 'revoked',
			revocationReason: 'Fin de collaboration',
			canPublish: false,
			canTakePhotos: false,
			canCollectFunds: false,
			canSignLeases: false,
			version: 2
		});
		expect(revoked.body.revokedAt).toBeTruthy();
		expect((await manager.call('PATCH', `/mandates/${m.id}`, { exclusive: true })).body).toMatchObject({ code: 'MANDATE_CLOSED' });
		expect((await manager.call('POST', `/mandates/${m.id}/revoke`, { reason: 'Encore' })).body).toMatchObject({ code: 'MANDATE_CLOSED' });
		expect((await audit(a.id, m.id)).at(-1)).toMatchObject({
			action: 'mandate.revoke',
			before: { status: 'active', canSignLeases: true },
			after: { status: 'revoked', reason: 'Fin de collaboration', canSignLeases: false }
		});
	});

	it('archivage : refusé tant qu’un mandat est actif ; après révocation, permis ; plus de mandat sur une fiche archivée', async () => {
		const solo = await createOwner(manager, person('Propriétaire à archiver'));
		const m = await createMandate(manager, rentalMandate(solo.id));
		expect((await manager.call('POST', `/owners/${solo.id}/archive`)).body).toMatchObject({ code: 'OWNER_HAS_ACTIVE_MANDATE' });
		await manager.call('POST', `/mandates/${m.id}/revoke`, { reason: 'Vente du bien' });
		expect((await manager.call<OwnerView>('POST', `/owners/${solo.id}/archive`)).body).toMatchObject({ status: 'archived' });
		expect((await manager.call('POST', '/mandates', rentalMandate(solo.id))).body).toMatchObject({ code: 'OWNER_ARCHIVED' });
	});
});

describe('synchronisation : création hors ligne, versions et refus', () => {
	it('propriétaire et mandat créés sur l’appareil : appliqués, audit d’origine sync', async () => {
		const ownerId = newId();
		const mandateId = newId();
		const results = await upload(manager, [
			{
				key: key(),
				op: 'PUT',
				table: 'owners',
				id: ownerId,
				data: {
					organization_id: a.id,
					type: 'person',
					name: 'Créé hors ligne',
					phone: '+22670445566',
					country: 'BF',
					status: 'active',
					email: ''
				}
			},
			{
				key: key(),
				op: 'PUT',
				table: 'mandates',
				id: mandateId,
				data: {
					organization_id: a.id,
					owner_id: ownerId,
					type: 'rental_management',
					starts_on: today,
					ends_on: null,
					commission_basis: 'percent_of_collected',
					commission_rate_bp: 1000,
					commission_amount: null,
					can_publish: 1,
					can_take_photos: 1,
					can_collect_funds: 1,
					can_sign_leases: 0,
					exclusive: 0,
					status: 'active',
					version: 1
				}
			}
		]);
		expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
		const detail = await manager.call<OwnerDetailView>('GET', `/owners/${ownerId}`);
		expect(detail.body).toMatchObject({
			name: 'Créé hors ligne',
			email: null,
			mandates: [{ id: mandateId, version: 1, canPublish: true, canSignLeases: false }]
		});
		expect((await audit(a.id, ownerId))[0]).toMatchObject({ action: 'owner.create', origin: 'sync' });
		expect((await audit(a.id, mandateId))[0]).toMatchObject({ action: 'mandate.create', origin: 'sync' });
	});

	it('PATCH d’un mandat (organisation jointe par le connecteur) : nouvelle version ; commission complétée par celle du serveur', async () => {
		const o = await createOwner(manager);
		const m = await createMandate(manager, rentalMandate(o.id));
		const [r] = await upload(manager, [
			{ key: key(), op: 'PATCH', table: 'mandates', id: m.id, organizationId: a.id, data: { commission_rate_bp: 1200, can_take_photos: 0 } }
		]);
		expect(r).toMatchObject({ status: 'applied', organizationId: a.id });
		const versions = await manager.call<MandateVersionView[]>('GET', `/mandates/${m.id}/versions`);
		expect(versions.body.at(-1)).toMatchObject({
			version: 2,
			canTakePhotos: false,
			commission: { basis: 'percent_of_collected', rateBp: 1200 }
		});
		expect((await audit(a.id, m.id)).at(-1)).toMatchObject({ action: 'mandate.update', origin: 'sync' });
	});

	it('statut, version et dates décidés par le serveur : refus clairs ; révocation par la synchronisation avec motif', async () => {
		const o = await createOwner(manager);
		const m = await createMandate(manager, rentalMandate(o.id));
		const patch = (data: Record<string, unknown>) => ({ key: key(), op: 'PATCH', table: 'mandates', id: m.id, organizationId: a.id, data });
		const results = await upload(manager, [
			patch({ status: 'expired' }),
			patch({ version: 7 }),
			patch({ revoked_at: new Date().toISOString() }),
			patch({ status: 'revoked' }),
			patch({ status: 'revoked', revocation_reason: 'Révoqué sur le terrain', exclusive: 1 }),
			patch({ status: 'revoked', revocation_reason: 'Révoqué sur le terrain', can_publish: 0, can_take_photos: 0 })
		]);
		expect(results.map((x) => x.code ?? x.status)).toEqual([
			'MANDATE_TRANSITION_NOT_ALLOWED',
			'FIELD_NOT_WRITABLE',
			'FIELD_NOT_WRITABLE',
			'VALIDATION_ERROR',
			'FIELD_NOT_WRITABLE',
			'applied'
		]);
		const detail = await manager.call<OwnerDetailView>('GET', `/owners/${o.id}`);
		expect(detail.body.mandates[0]).toMatchObject({
			status: 'revoked',
			revocationReason: 'Révoqué sur le terrain',
			canCollectFunds: false,
			version: 2
		});
	});

	it('archivage d’une fiche par la synchronisation ; les autres statuts sont refusés', async () => {
		const o = await createOwner(manager);
		const results = await upload(manager, [
			{ key: key(), op: 'PATCH', table: 'owners', id: o.id, organizationId: a.id, data: { status: 'active', name: 'Nom' } },
			{ key: key(), op: 'PATCH', table: 'owners', id: o.id, organizationId: a.id, data: { status: 'archived' } },
			{
				key: key(),
				op: 'PUT',
				table: 'owners',
				id: newId(),
				data: { organization_id: a.id, ...{ type: 'person', name: 'X Y', phone: '+22670112233' }, user_id: newId() }
			}
		]);
		expect(results.map((x) => x.code ?? x.status)).toEqual(['STATUS_NOT_ALLOWED', 'applied', 'FIELD_NOT_WRITABLE']);
		expect((await manager.call<OwnerView>('GET', `/owners/${o.id}`)).body.status).toBe('archived');
	});
});

describe('bailleur particulier : sa fiche et son mandat self_managed, créés avec l’organisation', () => {
	let landlord: Org;
	beforeAll(async () => {
		landlord = await createOrg(t, 'landlord', 'Clarisse Yaméogo');
	});

	it('une fiche (raison sociale et téléphone de l’organisation) et un mandat permanent, toutes autorisations, une seule fois', async () => {
		const list = await landlord.director.call<OwnerView[]>('GET', '/owners');
		expect(list.body).toHaveLength(1);
		expect(list.body[0]).toMatchObject({ type: 'person', name: 'Clarisse Yaméogo', phone: '+22625300000', country: 'BF' });
		const detail = await landlord.director.call<OwnerDetailView>('GET', `/owners/${list.body[0]!.id}`);
		expect(detail.body.mandates).toEqual([
			expect.objectContaining({
				type: 'self_managed',
				status: 'active',
				endsOn: null,
				commission: null,
				canPublish: true,
				canTakePhotos: true,
				canCollectFunds: true,
				canSignLeases: true,
				version: 1
			})
		]);
		const lines = await owner.query(
			`select action, origin from audit_log where organization_id = $1 and action in ('owner.create', 'mandate.create') order by id`,
			[landlord.id]
		);
		expect(lines.rows).toEqual([
			{ action: 'owner.create', origin: 'app' },
			{ action: 'mandate.create', origin: 'app' }
		]);
		// Le backfill de la migration ne le touche pas : il a déjà son mandat.
		await owner.query(`select backfill_landlord_self_managed()`);
		const count = await asOwner(landlord.id, (c) =>
			c.query(`select count(*)::int as n from mandates where organization_id = $1`, [landlord.id])
		);
		expect(count.rows[0].n).toBe(1);
	});

	it('LANDLORD_SELF_MANAGED : ni autre propriétaire, ni autre mandat ; son mandat ne se modifie ni ne se révoque', async () => {
		expect((await landlord.director.call('POST', '/owners', person())).body).toMatchObject({ code: 'LANDLORD_SELF_MANAGED' });
		const [mine] = (await landlord.director.call<OwnerView[]>('GET', '/owners')).body;
		expect((await landlord.director.call('POST', '/mandates', rentalMandate(mine!.id))).body).toMatchObject({
			code: 'LANDLORD_SELF_MANAGED'
		});
		const mandate = (await landlord.director.call<OwnerDetailView>('GET', `/owners/${mine!.id}`)).body.mandates[0]!;
		expect((await landlord.director.call('PATCH', `/mandates/${mandate.id}`, { canPublish: false })).body).toMatchObject({
			code: 'MANDATE_PERMANENT'
		});
		expect((await landlord.director.call('POST', `/mandates/${mandate.id}/revoke`, { reason: 'Essai' })).body).toMatchObject({
			code: 'MANDATE_PERMANENT'
		});
		expect((await landlord.director.call('POST', `/owners/${mine!.id}/archive`)).body).toMatchObject({ code: 'OWNER_HAS_ACTIVE_MANDATE' });
		const [r] = await upload(landlord.director, [
			{
				key: key(),
				op: 'PUT',
				table: 'owners',
				id: newId(),
				data: { organization_id: landlord.id, type: 'person', name: 'Autre', phone: '+22670112233' }
			}
		]);
		expect(r).toMatchObject({ status: 'rejected', code: 'LANDLORD_SELF_MANAGED' });
	});
});

describe('expiration : tâche de nuit et expirations dues avant un nouveau mandat de gestion', () => {
	let worker: INestApplicationContext;
	let queue: Queue;
	let events: QueueEvents;
	const config = parseConfig(process.env);

	beforeAll(async () => {
		worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
		await worker.init();
		queue = new Queue(MANDATES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
		events = new QueueEvents(MANDATES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
		await events.waitUntilReady();
	});
	afterAll(async () => {
		await queue.obliterate({ force: true });
		await Promise.all([queue.close(), events.close()]);
		await worker.close();
	});

	it('le worker pose un planificateur quotidien (00:10 UTC), une seule fois', async () => {
		const schedulers = await queue.getJobSchedulers();
		expect(schedulers.filter((s) => s.key === MANDATES_EXPIRY_SCHEDULER)).toEqual([
			expect.objectContaining({ key: MANDATES_EXPIRY_SCHEDULER, pattern: MANDATES_EXPIRY_PATTERN, tz: 'UTC' })
		]);
	});

	it('la tâche expire les mandats dont la fin est passée : statut, autorisations à faux, version, audit d’origine job ; rejouée, rien de plus', async () => {
		const o = await createOwner(a.director);
		const ended = await createMandate(a.director, rentalMandate(o.id, { startsOn: addDays(today, -60), endsOn: addDays(today, -1) }));
		const lastDay = await createMandate(a.director, {
			...rentalMandate(o.id),
			type: 'letting',
			commission: { basis: 'fixed_per_operation', amount: 1 },
			endsOn: today
		});
		const job = await queue.add(MANDATES_EXPIRY_JOB, { today });
		const result = (await job.waitUntilFinished(events, 15_000)) as MandatesExpiryJobResult;
		expect(result.mandates).toBeGreaterThanOrEqual(1);
		const detail = (await a.director.call<OwnerDetailView>('GET', `/owners/${o.id}`)).body;
		expect(detail.mandates.find((m) => m.id === ended.id)).toMatchObject({
			status: 'expired',
			canPublish: false,
			canCollectFunds: false,
			version: 2
		});
		expect(detail.mandates.find((m) => m.id === ended.id)!.expiredAt).toBeTruthy();
		// Le dernier jour couvert, le mandat reste en vigueur.
		expect(detail.mandates.find((m) => m.id === lastDay.id)).toMatchObject({ status: 'active', version: 1 });
		expect((await audit(a.id, ended.id)).at(-1)).toMatchObject({
			action: 'mandate.expire',
			origin: 'job',
			after: { status: 'expired', version: 2 }
		});
		const again = (await (await queue.add(MANDATES_EXPIRY_JOB, { today })).waitUntilFinished(events, 15_000)) as MandatesExpiryJobResult;
		expect(again.mandates).toBe(0);
		// B n'a pas été ouverte : aucun de ses mandats n'est échu.
		expect((await owner.query(`select due_mandate_organizations($1::date) as id`, [today])).rows).toEqual([]);
	});

	it('avant un mandat de gestion, les expirations dues de l’organisation sont appliquées dans la même transaction (règle 12)', async () => {
		const o = await createOwner(a.director);
		const ended = await createMandate(a.director, rentalMandate(o.id, { startsOn: addDays(today, -30), endsOn: addDays(today, -1) }));
		// L'unité est encore occupée par le mandat échu (la tâche de nuit n'est pas passée).
		const property = newId();
		const unit = newId();
		await asOwner(a.id, (c) =>
			c.query(`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id) values ($1, $2, $3, $4, $5)`, [
				newId(),
				a.id,
				ended.id,
				property,
				unit
			])
		);
		// Une mise en location n'expire rien.
		await createMandate(a.director, {
			...rentalMandate(o.id),
			type: 'letting',
			commission: { basis: 'fixed_per_operation', amount: 50_000 }
		});
		expect((await asOwner(a.id, (c) => c.query(`select status from mandates where id = $1`, [ended.id]))).rows[0].status).toBe('active');
		// Le nouveau mandat de gestion : l'ancien expire d'abord, l'unité est libre.
		const next = await createMandate(a.director, rentalMandate(o.id));
		const rows = await asOwner(a.id, async (c) => {
			await c.query(`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id) values ($1, $2, $3, $4, $5)`, [
				newId(),
				a.id,
				next.id,
				property,
				unit
			]);
			return c.query(
				`select m.id, m.status, s.management_active from mandate_scopes s join mandates m on m.id = s.mandate_id where s.unit_id = $1 order by m.id`,
				[unit]
			);
		});
		expect(rows.rows).toEqual([
			{ id: ended.id, status: 'expired', management_active: false },
			{ id: next.id, status: 'active', management_active: true }
		]);
		expect((await audit(a.id, ended.id)).at(-1)).toMatchObject({ action: 'mandate.expire', after: { status: 'expired' } });
	});
});
