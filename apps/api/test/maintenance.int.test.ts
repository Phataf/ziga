/**
 * Lot 10 ter, étape 3 : suivi d'un signalement par l'organisation (fiche du bail) : reçu → planifié (date de passage) →
 * fait, mot visible du locataire ; direction et gestion seulement ; accès croisé ; journalisé.
 */
import { newId } from '@ziga/shared/ids';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './http.js';
import { addMember } from './orgs.js';
import { migrationClient, portalWorld, seedIn, type PortalWorld } from './portals.js';

let t: TestApp;
let owner: pg.Client;
let w: PortalWorld;
let requestId: string;

beforeAll(async () => {
	t = await startApp();
	owner = await migrationClient();
	w = await portalWorld(t, owner);
	requestId = newId();
	const r = await w.t.client.call('POST', '/me/portal/tenant/requests', {
		organizationId: w.b.org.id,
		id: requestId,
		leaseId: w.b.tLease,
		title: 'Fuite',
		description: 'Le robinet de la cuisine fuit depuis hier.'
	});
	if (r.status !== 201) throw new Error(`signalement : ${r.status} ${JSON.stringify(r.body)}`);
});

afterAll(async () => {
	await owner?.end();
	await t?.close();
});

describe('suivi d’un signalement par l’organisation (lot 10 ter, étape 3)', () => {
	it('planifié avec sa date et un mot, puis fait ; visible du locataire ; journalisé', async () => {
		const planned = await w.b.org.director.call('PATCH', `/maintenance-requests/${requestId}`, {
			status: 'planned',
			plannedOn: '2026-12-02',
			statusNote: 'Plombier mardi matin.'
		});
		expect(planned.status).toBe(200);
		expect(planned.body).toMatchObject({ id: requestId, status: 'planned', plannedOn: '2026-12-02', statusNote: 'Plombier mardi matin.' });
		const done = await w.b.org.director.call('PATCH', `/maintenance-requests/${requestId}`, {
			status: 'done',
			statusNote: 'Joint changé.'
		});
		expect(done.body).toMatchObject({ status: 'done', statusNote: 'Joint changé.' });
		const seen = await w.t.client.call<{ id: string; status: string; statusNote: string }[]>('GET', '/me/portal/tenant/requests');
		expect(seen.body.find((x) => x.id === requestId)).toMatchObject({ status: 'done', statusNote: 'Joint changé.' });
		const audit = await seedIn(owner, w.b.org.id, (c) =>
			c.query(`select count(*)::int as n from audit_log where action = 'maintenance_request.update' and object_id = $1`, [requestId])
		);
		expect(audit.rows[0].n).toBe(2);
		// Fait : ne change plus.
		expect(
			(await w.b.org.director.call('PATCH', `/maintenance-requests/${requestId}`, { status: 'planned', plannedOn: '2026-12-09' })).body
		).toMatchObject({
			code: 'MAINTENANCE_STATUS'
		});
	});

	it('agent de terrain et profil lecture : refusé ; membre d’une autre organisation : introuvable', async () => {
		const id = newId();
		await w.t.client.call('POST', '/me/portal/tenant/requests', {
			organizationId: w.b.org.id,
			id,
			leaseId: w.b.tLease,
			title: 'Prise',
			description: 'Prise sans courant.'
		});
		for (const role of ['field_agent', 'viewer'] as const) {
			const m = await addMember(t, w.b.org, role);
			expect((await m.call('PATCH', `/maintenance-requests/${id}`, { status: 'done' })).status).toBe(403);
		}
		expect((await w.a.org.director.call('PATCH', `/maintenance-requests/${id}`, { status: 'done' })).status).toBe(404);
	});
});
