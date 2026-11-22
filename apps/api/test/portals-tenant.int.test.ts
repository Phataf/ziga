/**
 * Lot 10 ter, étape 2b-3 — espace du locataire (prompt §4) : logement actuel, contrats, caution et décompte, documents,
 * signalements, demande de préavis et observation sur un décompte. Écrit avant le code : il entre rouge.
 *
 * - Logement actuel : solde, prochaine échéance, contact de l'organisation ; « Payer par Mobile Money » désactivé tant
 *   que `payments.direct` est coupée pour l'organisation.
 * - Contrats : en vigueur et terminés, avec l'organisation, le bailleur désigné, les dates, le loyer, la caution.
 * - Caution et décompte : montant convenu, détenteur, décompte et ses lignes ; observation en cas de désaccord (le
 *   décompte passe « contesté »), enregistrée dans l'organisation comme demande à traiter.
 * - Écritures, toutes dans l'organisation du bail, journalisées (origine portal) : signalement (bail en vigueur ou en
 *   préavis), demande de préavis (« demandée », jamais un congé enregistré).
 * - Documents permis par la matrice : son contrat signé et sa pièce d'identité ; jamais un document du propriétaire.
 */
import { newId } from '@ziga/shared/ids';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { insertDocument, insertSettlement, setSettlementStatus } from './exit.js';
import { startApp, type TestApp } from './http.js';
import { migrationClient, portalWorld, seedIn, type PortalWorld } from './portals.js';
import { resetSharedRedisState, testRedis } from './test-redis.js';

let t: TestApp;
let owner: pg.Client;
let w: PortalWorld;
let settlementA: string;
let ownerTitleB: string;

beforeAll(async () => {
	t = await startApp();
	owner = await migrationClient();
	w = await portalWorld(t, owner);
	// Chez A (bail terminé) : caution de 100 000 reçue pendant le bail (monde commun), décompte proposé (restitution entière).
	await seedIn(owner, w.a.org.id, async (c) => {
		const account = w.a.tDepositAccount!;
		settlementA = await insertSettlement(c, w.a.org.id, account, {
			received: 100_000,
			deductions: 0,
			coveredByDeposit: 0,
			refund: 100_000,
			refundFromDeposit: 100_000,
			outcome: 'refund'
		});
		await setSettlementStatus(c, settlementA, 'proposed');
	});
	// Chez B : titre du bien du propriétaire (jamais au locataire).
	ownerTitleB = await seedIn(owner, w.b.org.id, (c) =>
		insertDocument(c, w.b.org.id, w.b.org.director.userId, { type: 'title_deed', propertyId: w.b.pProperty })
	);
});

afterAll(async () => {
	await owner?.end();
	await t?.close();
});

afterEach(async () => {
	const redis = testRedis();
	await redis.connect();
	await resetSharedRedisState(redis);
	await redis.quit();
});

describe('espace du locataire (lot 10 ter, étape 2b-3)', () => {
	it('logement actuel : bail en cours chez B, contact de l’organisation, paiement direct désactivé avec son explication', async () => {
		const r = await w.t.client.call<{
			homes: {
				organizationId: string;
				organizationName: string;
				organizationPhone: string;
				leaseId: string;
				balance: number;
				nextDue: unknown;
				directPayment: { enabled: boolean; reason: string | null };
			}[];
		}>('GET', '/me/portal/tenant/home');
		expect(r.status).toBe(200);
		expect(r.body.homes).toHaveLength(1);
		expect(r.body.homes[0]).toMatchObject({
			organizationId: w.b.org.id,
			organizationName: 'Agence Nong-Taaba',
			leaseId: w.b.tLease,
			balance: 0
		});
		expect(r.body.homes[0]!.organizationPhone).toMatch(/^\+226/);
		expect(r.body.homes[0]!.directPayment.enabled).toBe(false);
		expect(r.body.homes[0]!.directPayment.reason).toBeTruthy();
	});

	it('contrats : en vigueur chez B, terminé chez A ; organisation, bailleur désigné, dates, loyer', async () => {
		const r = await w.t.client.call<
			{ organizationId: string; leaseId: string; group: string; lessorName: string; rent: number; startsOn: string }[]
		>('GET', '/me/portal/tenant/contracts');
		expect(r.status).toBe(200);
		const byLease = Object.fromEntries(r.body.map((x) => [x.leaseId, x]));
		expect(byLease[w.b.tLease!]).toMatchObject({ organizationId: w.b.org.id, group: 'in_force', rent: 75_000 });
		expect(byLease[w.a.tLease!]).toMatchObject({ organizationId: w.a.org.id, group: 'ended' });
		// Bail au nom du propriétaire (bailleur désigné) : son nom.
		expect(byLease[w.b.tLease!]!.lessorName).toBe('Rasmané Compaoré');
	});

	it('caution et décompte : montant, détenteur, décompte de A ; observation en cas de désaccord → contesté, journalisé dans A', async () => {
		const r = await w.t.client.call<
			{
				organizationId: string;
				leaseId: string;
				agreedAmount: number;
				holder: string;
				settlement: { id: string; status: string; refund: number } | null;
			}[]
		>('GET', '/me/portal/tenant/deposits');
		expect(r.status).toBe(200);
		const a = r.body.find((d) => d.leaseId === w.a.tLease)!;
		expect(a).toMatchObject({ organizationId: w.a.org.id, agreedAmount: 100_000, holder: 'organization' });
		expect(a.settlement).toMatchObject({ id: settlementA, status: 'proposed', refund: 100_000 });

		expect(
			(await w.t.client.call('POST', `/me/portal/tenant/settlements/${w.a.org.id}/${settlementA}/observation`, { observations: 'ok' }))
				.status
		).toBe(400);
		const obs = await w.t.client.call('POST', `/me/portal/tenant/settlements/${w.a.org.id}/${settlementA}/observation`, {
			observations: 'La peinture était déjà abîmée à l’entrée, voir l’état des lieux.'
		});
		expect(obs.status).toBe(200);
		const row = await seedIn(owner, w.a.org.id, async (c) => ({
			s: (await c.query(`select status, tenant_observations from deposit_settlements where id = $1`, [settlementA])).rows[0],
			audit: (
				await c.query(`select origin, subject_user_id from audit_log where action = 'deposit.settlement_dispute' and object_id = $1`, [
					settlementA
				])
			).rows
		}));
		expect(row.s).toEqual({ status: 'disputed', tenant_observations: 'La peinture était déjà abîmée à l’entrée, voir l’état des lieux.' });
		expect(row.audit).toEqual([{ origin: 'portal', subject_user_id: w.t.userId }]);
		// Le décompte de A demandé au nom de B, ou par P : introuvable.
		expect(
			(
				await w.t.client.call('POST', `/me/portal/tenant/settlements/${w.b.org.id}/${settlementA}/observation`, {
					observations: 'Tentative croisée'
				})
			).status
		).toBe(404);
		expect(
			(
				await w.p.client.call('POST', `/me/portal/tenant/settlements/${w.a.org.id}/${settlementA}/observation`, {
					observations: 'Tentative'
				})
			).status
		).toBe(404);
	});

	it('signalement : enregistré dans B (reçu), visible avec son suivi ; refusé sur le bail terminé de A ou le bail d’un autre', async () => {
		const id = newId();
		const r = await w.t.client.call('POST', '/me/portal/tenant/requests', {
			organizationId: w.b.org.id,
			id,
			leaseId: w.b.tLease,
			title: 'Fuite',
			description: 'Le robinet de la cuisine fuit depuis hier.'
		});
		expect(r.status).toBe(201);
		const list = await w.t.client.call<{ id: string; organizationId: string; status: string }[]>('GET', '/me/portal/tenant/requests');
		expect(list.body).toEqual([expect.objectContaining({ id, organizationId: w.b.org.id, status: 'received' })]);
		const stored = await seedIn(owner, w.b.org.id, async (c) => ({
			row: (await c.query(`select reported_by, status from maintenance_requests where id = $1`, [id])).rows[0],
			audit: (await c.query(`select origin from audit_log where action = 'maintenance_request.create' and object_id = $1`, [id])).rows
		}));
		expect(stored).toEqual({ row: { reported_by: w.t.userId, status: 'received' }, audit: [{ origin: 'portal' }] });
		const ended = await w.t.client.call('POST', '/me/portal/tenant/requests', {
			organizationId: w.a.org.id,
			id: newId(),
			leaseId: w.a.tLease,
			title: 'Fuite',
			description: 'Le robinet de la cuisine fuit.'
		});
		expect(ended.body).toMatchObject({ code: 'MAINTENANCE_LEASE' });
		const foreign = await w.p.client.call('POST', '/me/portal/tenant/requests', {
			organizationId: w.b.org.id,
			id: newId(),
			leaseId: w.b.tLease,
			title: 'Fuite',
			description: 'Tentative depuis un autre compte.'
		});
		expect(foreign.status).toBe(404);
	});

	it('demande de préavis : « demandée » dans B, jamais un congé enregistré ; le bail ne change pas', async () => {
		const r = await w.t.client.call('POST', '/me/portal/tenant/notice-requests', {
			organizationId: w.b.org.id,
			leaseId: w.b.tLease,
			plannedExitOn: '2027-03-31',
			reason: 'Mutation professionnelle à Bobo-Dioulasso.'
		});
		expect(r.status).toBe(201);
		const rows = await seedIn(owner, w.b.org.id, async (c) => ({
			notices: (await c.query(`select origin, status, planned_exit_on::text from lease_notices where lease_id = $1`, [w.b.tLease])).rows,
			lease: (await c.query(`select status from leases where id = $1`, [w.b.tLease])).rows[0],
			audit: (await c.query(`select origin from audit_log where action = 'lease.notice_request' and organization_id = $1`, [w.b.org.id]))
				.rows
		}));
		expect(rows.notices).toEqual([{ origin: 'tenant', status: 'requested', planned_exit_on: '2027-03-31' }]);
		expect(rows.lease).toEqual({ status: 'active' });
		expect(rows.audit).toEqual([{ origin: 'portal' }]);
	});

	it('documents : son contrat signé et sa pièce d’identité ; jamais le titre du propriétaire ; téléchargement journalisé', async () => {
		const r = await w.t.client.call<{ id: string; organizationId: string }[]>('GET', '/me/portal/tenant/documents');
		expect(r.status).toBe(200);
		const ids = r.body.map((d) => d.id);
		expect(ids).toEqual(expect.arrayContaining([w.b.tSignedLease, w.b.tIdentity]));
		expect(ids).not.toContain(ownerTitleB);
		const dl = await w.t.client.call<{ url: string }>('POST', `/me/portal/documents/${w.b.org.id}/${w.b.tIdentity}/download`, {
			space: 'tenant'
		});
		expect(dl.status).toBe(200);
		expect((await w.t.client.call('POST', `/me/portal/documents/${w.b.org.id}/${ownerTitleB}/download`, { space: 'tenant' })).status).toBe(
			404
		);
		// Et le propriétaire ne télécharge jamais la pièce du locataire (point c).
		expect((await w.p.client.call('POST', `/me/portal/documents/${w.b.org.id}/${w.b.tIdentity}/download`, { space: 'owner' })).status).toBe(
			404
		);
	});
});
