/**
 * Lot 10 ter, étape 2b-2 — espace du propriétaire : revenus, relevés, reversements et documents (prompt §3, D22, point c).
 * Écrit avant le code : il entre rouge, puis passe avec le module portals.
 *
 * - Revenus par mois (encaissé, commission, dépenses, net, reversé) et par bien sur 12 mois ; rendement simple = net ÷
 *   encaissé (réponse du porteur). La commission du relevé, calculée par mandat, est répartie entre les biens au prorata
 *   de l'encaissé ; une dépense rattachée à une unité reste sur son bien.
 * - Relevés émis de chaque organisation (jamais un brouillon) et leur PDF (URL signée, journalisée dans l'organisation).
 * - Documents permis par la matrice (docs/UX.md §10) : titre et mandat de ses biens, contrat signé et avenants de ses baux
 *   (D22, précision du porteur sur le point c) ; jamais la pièce d'identité d'un locataire, un projet de contrat, un document
 *   restreint ou celui d'un autre propriétaire. Téléchargement par URL signée, journalisé dans l'organisation.
 * - Une organisation par requête (requêtes relevées, comme portals-api.int.test.ts).
 */
import { newId } from '@ziga/shared/ids';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { insertExpense, insertPayout, insertStatement, issueStatement } from './collections.js';
import { insertProperty } from './properties.js';
import { insertDocument } from './exit.js';
import { startApp, type TestApp } from './http.js';
import { migrationClient, portalWorld, seedIn, type PortalWorld } from './portals.js';
import { resetSharedRedisState, testRedis } from './test-redis.js';

let t: TestApp;
let owner: pg.Client;
let w: PortalWorld;
const docs: Record<string, string> = {};
let statementA: string;
let draftA: string;

beforeAll(async () => {
	t = await startApp();
	owner = await migrationClient();
	w = await portalWorld(t, owner);
	// Relevé émis d'octobre chez A : 80 000 encaissés sur l'unité de P, 8 000 de commission, 5 000 de dépense sur l'unité.
	await seedIn(owner, w.a.org.id, async (c) => {
		statementA = await insertStatement(c, w.a.org.id, w.a.pOwner, '2026-10', {
			rent: 75_000,
			charges: 5_000,
			commission: 8_000,
			expenses: -5_000
		});
		await c.query(`update owner_statements set snapshot = $2 where id = $1`, [
			statementA,
			JSON.stringify({
				units: [{ id: w.a.pUnit, label: 'Appartement A1' }],
				result: {
					unitTotals: [{ unitId: w.a.pUnit, label: 'Appartement A1', rent: 75_000, charges: 5_000, total: 80_000, lines: 1 }],
					expenseLines: [
						{
							key: 'x',
							expenseId: newId(),
							kind: 'expense',
							date: '2026-10-12',
							category: 'plumbing',
							description: 'Robinet',
							unitId: w.a.pUnit,
							amount: -5_000,
							late: false
						}
					]
				}
			})
		]);
		await issueStatement(c, w.a.org.id, statementA, w.a.org.director.userId);
		await insertPayout(c, w.a.org.id, statementA, w.a.pOwner, 62_000, { paidOn: '2026-11-05' });
		draftA = await insertStatement(c, w.a.org.id, w.a.pOwner, '2026-11');
		// Documents de A : titre du bien de P, mandat, et ceux qu'il ne doit jamais voir.
		docs.title = await insertDocument(c, w.a.org.id, w.a.org.director.userId, { type: 'title_deed', propertyId: w.a.pProperty });
		docs.otherTitle = await insertDocument(c, w.a.org.id, w.a.org.director.userId, { type: 'title_deed', propertyId: w.a.otherProperty! });
		docs.restricted = await insertDocument(c, w.a.org.id, w.a.org.director.userId, { type: 'title_deed', propertyId: w.a.pProperty });
		await c.query(`update documents set restriction = 'director_only' where id = $1`, [docs.restricted]);
	});
	docs.signedB = w.b.tSignedLease!;
	docs.identityB = w.b.tIdentity!;
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

interface Income {
	months: {
		organizationId: string;
		month: string;
		collected: number;
		commission: number;
		expenses: number;
		net: number;
		paidOut: number;
	}[];
	properties: { organizationId: string; propertyId: string; collected: number; net: number; yieldPercent: number | null }[];
}

describe('espace du propriétaire : revenus, relevés, reversements, documents (lot 10 ter, étape 2b-2)', () => {
	it('revenus par mois et par bien ; rendement simple = net ÷ encaissé ; jamais un brouillon', async () => {
		const r = await w.p.client.call<Income>('GET', '/me/portal/owner/income');
		expect(r.status).toBe(200);
		const october = r.body.months.filter((m) => m.organizationId === w.a.org.id);
		expect(october).toEqual([
			{ organizationId: w.a.org.id, month: '2026-10', collected: 80_000, commission: 8_000, expenses: -5_000, net: 67_000, paidOut: 62_000 }
		]);
		const property = r.body.properties.find((p) => p.propertyId === w.a.pProperty)!;
		// 80 000 encaissés, 8 000 de commission (seul bien de ce relevé), 5 000 de dépense sur l'unité : 67 000 net, 83,75 %.
		expect(property).toMatchObject({ organizationId: w.a.org.id, collected: 80_000, net: 67_000, yieldPercent: 83.75 });
	});

	it('relevés émis de chaque organisation, avec reversé et reste ; PDF par URL signée, journalisé dans A', async () => {
		const r = await w.p.client.call<
			{ id: string; organizationId: string; month: string; net: number; paidOut: number; remaining: number }[]
		>('GET', '/me/portal/owner/statements');
		expect(r.status).toBe(200);
		expect(r.body.map((s) => s.id)).toEqual([statementA]);
		expect(r.body[0]).toMatchObject({ organizationId: w.a.org.id, month: '2026-10', net: 67_000, paidOut: 62_000, remaining: 5_000 });
		expect(r.body.map((s) => s.id)).not.toContain(draftA);
		await seedIn(owner, w.a.org.id, (c) =>
			c.query(`update owner_statements set pdf_key = $2, pdf_generated_at = now() where id = $1`, [
				statementA,
				`statements/${w.a.org.id}/x.pdf`
			])
		);
		const pdf = await w.p.client.call<{ url: string }>('POST', `/me/portal/owner/statements/${w.a.org.id}/${statementA}/pdf`);
		expect(pdf.status).toBe(200);
		expect(pdf.body.url).toBeTruthy();
		const audit = await seedIn(owner, w.a.org.id, (c) =>
			c.query(`select origin, subject_user_id from audit_log where action = 'statement.download' and object_id = $1`, [statementA])
		);
		expect(audit.rows).toEqual([{ origin: 'portal', subject_user_id: w.p.userId }]);
		// Le brouillon, ou un relevé de A demandé au nom de B : introuvable.
		expect((await w.p.client.call('POST', `/me/portal/owner/statements/${w.a.org.id}/${draftA}/pdf`)).status).toBe(404);
		expect((await w.p.client.call('POST', `/me/portal/owner/statements/${w.b.org.id}/${statementA}/pdf`)).status).toBe(404);
		// T, sans lien de propriétaire : introuvable, comme un relevé qui n'existe pas (rien n'est révélé).
		expect((await w.t.client.call('POST', `/me/portal/owner/statements/${w.a.org.id}/${statementA}/pdf`)).status).toBe(404);
	});

	it('documents : ceux de la matrice seulement ; contrat signé de son bail (D22) ; jamais la pièce du locataire ni un document restreint', async () => {
		const r = await w.p.client.call<{ id: string; organizationId: string; type: string }[]>('GET', '/me/portal/owner/documents');
		expect(r.status).toBe(200);
		const ids = r.body.map((d) => d.id);
		expect(ids).toContain(docs.title);
		expect(ids).toContain(docs.signedB);
		for (const never of [docs.otherTitle, docs.restricted, docs.identityB]) expect(ids).not.toContain(never);
		expect(JSON.stringify(r.body)).not.toMatch(/storage_?[Kk]ey/);
	});

	it('téléchargement d’un document permis : URL signée, journalisé dans l’organisation ; refusé hors matrice', async () => {
		const ok = await w.p.client.call<{ url: string }>('POST', `/me/portal/documents/${w.b.org.id}/${docs.signedB}/download`, {
			space: 'owner'
		});
		expect(ok.status).toBe(200);
		expect(ok.body.url).toBeTruthy();
		const audit = await seedIn(owner, w.b.org.id, (c) =>
			c.query(`select origin, subject_user_id from audit_log where action = 'document.download' and object_id = $1`, [docs.signedB])
		);
		expect(audit.rows).toEqual([{ origin: 'portal', subject_user_id: w.p.userId }]);
		for (const [org, id] of [
			[w.b.org.id, docs.identityB],
			[w.a.org.id, docs.otherTitle],
			[w.a.org.id, docs.restricted],
			[w.b.org.id, docs.title]
		] as const) {
			expect((await w.p.client.call('POST', `/me/portal/documents/${org}/${id}/download`, { space: 'owner' })).status, id).toBe(404);
		}
	});

	it('point c : aucune réponse de l’espace propriétaire ne contient le téléphone, la date de naissance ni le numéro de pièce de T', async () => {
		for (const path of ['/me/portal/owner/income', '/me/portal/owner/statements', '/me/portal/owner/documents']) {
			const json = JSON.stringify((await w.p.client.call('GET', path)).body);
			for (const secret of [w.t.phone, 'B1234567', '1990-04-12']) expect(json, path).not.toContain(secret);
		}
	});

	it('dépense d’un bien sans unité : elle reste sur ce bien (bien de la dépense), seule la commission est au prorata', async () => {
		const fresh = await portalWorld(t, owner);
		const { other, expense, statement } = await seedIn(owner, fresh.a.org.id, async (c) => {
			// Second bien de P chez A, sans unité louée dans ce relevé ; une dépense de 6 000 sur ce bien, sans unité.
			const other = await insertProperty(c, fresh.a.org.id, fresh.a.pOwner, { name: 'Terrain Kossodo' });
			const expense = await insertExpense(c, fresh.a.org.id, {
				propertyId: other,
				borneBy: 'owner',
				recovery: 'owner_statement',
				amount: 6_000
			});
			const statement = await insertStatement(c, fresh.a.org.id, fresh.a.pOwner, '2026-10', {
				rent: 75_000,
				charges: 5_000,
				commission: 8_000,
				expenses: -6_000
			});
			await c.query(`update owner_statements set snapshot = $2 where id = $1`, [
				statement,
				JSON.stringify({
					units: [{ id: fresh.a.pUnit, label: 'Appartement A1' }],
					result: {
						unitTotals: [{ unitId: fresh.a.pUnit, label: 'Appartement A1', rent: 75_000, charges: 5_000, total: 80_000, lines: 1 }],
						expenseLines: [
							{
								key: 'x',
								expenseId: expense,
								kind: 'expense',
								date: '2026-10-12',
								category: 'other',
								description: 'Clôture',
								unitId: null,
								amount: -6_000,
								late: false
							}
						]
					}
				})
			]);
			await issueStatement(c, fresh.a.org.id, statement, fresh.a.org.director.userId);
			return { other, expense, statement };
		});
		expect(expense && statement).toBeTruthy();
		const r = await fresh.p.client.call<Income>('GET', '/me/portal/owner/income');
		const byProperty = Object.fromEntries(r.body.properties.map((p) => [p.propertyId, p]));
		// Bien loué : 80 000 − 8 000 de commission (tout l'encaissé est le sien) = 72 000 ; le terrain : −6 000.
		expect(byProperty[fresh.a.pProperty]).toMatchObject({ collected: 80_000, net: 72_000 });
		expect(byProperty[other]).toMatchObject({ collected: 0, net: -6_000, yieldPercent: null });
	});

	it('chaque téléchargement écrit sa ligne d’audit, même deux fois en moins de 30 secondes (relevé, document)', async () => {
		await seedIn(owner, w.a.org.id, (c) =>
			c.query(
				`update owner_statements set pdf_key = coalesce(pdf_key, $2), pdf_generated_at = coalesce(pdf_generated_at, now()) where id = $1`,
				[statementA, `statements/${w.a.org.id}/x.pdf`]
			)
		);
		const count = (action: string, id: string, org: string) =>
			seedIn(owner, org, (c) => c.query(`select count(*)::int as n from audit_log where action = $1 and object_id = $2`, [action, id]));
		const beforeStatement = (await count('statement.download', statementA, w.a.org.id)).rows[0].n as number;
		const beforeDocument = (await count('document.download', docs.title!, w.a.org.id)).rows[0].n as number;
		for (let i = 0; i < 2; i += 1) {
			expect((await w.p.client.call('POST', `/me/portal/owner/statements/${w.a.org.id}/${statementA}/pdf`)).status).toBe(200);
			expect((await w.p.client.call('POST', `/me/portal/documents/${w.a.org.id}/${docs.title}/download`, { space: 'owner' })).status).toBe(
				200
			);
		}
		expect((await count('statement.download', statementA, w.a.org.id)).rows[0].n).toBe(beforeStatement + 2);
		expect((await count('document.download', docs.title!, w.a.org.id)).rows[0].n).toBe(beforeDocument + 2);
	});
});
