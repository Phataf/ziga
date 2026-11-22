/**
 * Lot 10 ter, étape 2b — test d'isolement des espaces personnels par l'API (règle 15, D13, D17 ; points a, c et d du
 * porteur). Écrit avant le module portals : il entre rouge, puis passe avec lui ; il tourne en CI.
 *
 * Monde (test/portals.ts) : agences A et B, organisation de bailleur L de la personne P ; P propriétaire dans A, B et L ;
 * T locataire dans A (bail terminé) puis dans B (bail en cours) ; fiches liées (liens actifs).
 *
 * Une organisation par requête : pendant une lecture d'espace, chaque requête de la base est relevée (client pg, réglage
 * app.organization_id de sa transaction, lignes rendues). Toute requête de données tourne dans la transaction d'une
 * seule organisation et ne rend que des lignes de celle-ci ; la seule requête hors organisation est my_person_links().
 */
import { newId } from '@ziga/shared/ids';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FeaturesService } from '../src/modules/features/features.service.js';
import { startApp, type TestApp } from './http.js';
import { insertLink, migrationClient, portalWorld, seedIn, type PortalWorld } from './portals.js';
import { resetSharedRedisState, testRedis } from './test-redis.js';

let t: TestApp;
let owner: pg.Client;
let w: PortalWorld;

// ---------------------------------------------------------------- relevé des requêtes

interface Seen {
	text: string;
	organizationId: string;
	userId: string;
	rows: Record<string, unknown>[];
}

const contexts = new WeakMap<object, { organizationId: string; userId: string }>();
let recording: Seen[] | null = null;
const original = pg.Client.prototype.query;

function install() {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(pg.Client.prototype as any).query = function (this: object, config: unknown, values?: unknown, cb?: unknown) {
		const text = typeof config === 'string' ? config : ((config as { text?: string })?.text ?? '');
		const params = (Array.isArray(values) ? values : ((config as { values?: unknown[] })?.values ?? [])) as unknown[];
		const ctx = contexts.get(this) ?? { organizationId: '', userId: '' };
		if (/set_config\('app\.organization_id', \$1/.test(text)) contexts.set(this, { organizationId: String(params[0] ?? ''), userId: '' });
		else if (/set_config\('app\.user_id', \$1/.test(text)) contexts.set(this, { organizationId: '', userId: String(params[0] ?? '') });
		else if (/^\s*(commit|rollback)\b/i.test(text)) contexts.set(this, { organizationId: '', userId: '' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = (original as any).call(this, config, values, cb);
		const seenCtx = contexts.get(this) ?? ctx;
		if (recording && result && typeof result.then === 'function') {
			const list = recording;
			result.then(
				(r: { rows?: Record<string, unknown>[] }) =>
					list.push({ text, organizationId: seenCtx.organizationId, userId: seenCtx.userId, rows: Array.isArray(r?.rows) ? r.rows : [] }),
				() => undefined
			);
		}
		return result;
	};
}

const technical = (text: string) => /^\s*(begin|commit|rollback|savepoint|release)\b/i.test(text) || /^\s*select set_config\(/i.test(text);

/** Lecture d'espace relevée : renvoie la réponse et les requêtes de données. */
async function recorded<T>(fn: () => Promise<T>): Promise<{ result: T; queries: Seen[] }> {
	recording = [];
	try {
		const result = await fn();
		await new Promise((r) => setTimeout(r, 20));
		return { result, queries: recording.filter((q) => !technical(q.text)) };
	} finally {
		recording = null;
	}
}

function assertOneOrganizationPerQuery(queries: Seen[], allowed: readonly string[]) {
	for (const q of queries) {
		if (/my_person_links\(\)/.test(q.text)) {
			expect(q.organizationId, q.text).toBe('');
			continue;
		}
		expect(q.organizationId, `requête hors organisation : ${q.text}`).not.toBe('');
		expect(allowed, q.text).toContain(q.organizationId);
		for (const row of q.rows) {
			if ('organization_id' in row) expect(row.organization_id, q.text).toBe(q.organizationId);
		}
	}
}

// ---------------------------------------------------------------- monde

beforeAll(async () => {
	t = await startApp();
	owner = await migrationClient();
	w = await portalWorld(t, owner);
	install();
});

afterAll(async () => {
	pg.Client.prototype.query = original;
	await owner?.end();
	await t?.close();
});

afterEach(async () => {
	const redis = testRedis();
	await redis.connect();
	await resetSharedRedisState(redis);
	await redis.quit();
});

interface Assets {
	organizations: {
		organizationId: string;
		organizationName: string;
		managedBy: 'agency' | 'self';
		properties: {
			id: string;
			name: string;
			units: { id: string; label: string; available: boolean; rent: number | null; lease: { tenant: { fullName: string } } | null }[];
		}[];
	}[];
}

interface History {
	items: { organizationId: string; organizationName: string; kind: string; id: string; leaseId?: string }[];
	nextCursor: string | null;
}

describe('isolement des espaces personnels par l’API (lot 10 ter, étape 2b)', () => {
	it('P voit ses biens de A, de B et de L, chacun avec son gestionnaire ; aucun bien d’un autre propriétaire', async () => {
		const { result: r, queries } = await recorded(() => w.p.client.call<Assets>('GET', '/me/portal/owner/assets'));
		expect(r.status).toBe(200);
		const byOrg = Object.fromEntries(r.body.organizations.map((o) => [o.organizationId, o]));
		expect(Object.keys(byOrg).sort()).toEqual([w.a.org.id, w.b.org.id, w.l.org.id].sort());
		expect(byOrg[w.a.org.id]!.managedBy).toBe('agency');
		expect(byOrg[w.b.org.id]!.managedBy).toBe('agency');
		expect(byOrg[w.l.org.id]!.managedBy).toBe('self');
		const propertyIds = r.body.organizations.flatMap((o) => o.properties.map((p) => p.id)).sort();
		expect(propertyIds).toEqual([w.a.pProperty, w.b.pProperty, w.l.pProperty].sort());
		expect(propertyIds).not.toContain(w.a.otherProperty);
		expect(propertyIds).not.toContain(w.b.otherProperty);
		// Bail en cours chez B : le nom du locataire (réponse 5), jamais ses coordonnées (point c).
		const unitB = byOrg[w.b.org.id]!.properties[0]!.units[0]!;
		expect(unitB.lease?.tenant.fullName).toBe('Salif Traoré');
		// Une organisation par requête ; la seule requête hors organisation : my_person_links().
		assertOneOrganizationPerQuery(queries, [w.a.org.id, w.b.org.id, w.l.org.id]);
		expect(new Set(queries.filter((q) => q.organizationId).map((q) => q.organizationId))).toEqual(
			new Set([w.a.org.id, w.b.org.id, w.l.org.id])
		);
	});

	it('point c : aucune réponse de l’espace propriétaire ne contient le téléphone, la date de naissance ni le numéro de pièce de T', async () => {
		const r = await w.p.client.call('GET', '/me/portal/owner/assets');
		const json = JSON.stringify(r.body);
		for (const secret of [w.t.phone, 'B1234567', '1990-04-12']) expect(json).not.toContain(secret);
		expect(json).not.toMatch(/"(phone|secondaryPhone|idNumber|birthDate|idType)"/);
	});

	it('T voit ses deux baux (A terminé, B en cours) et ses reçus des deux, chaque élément avec son organisation', async () => {
		const { result: r, queries } = await recorded(() => w.t.client.call<History>('GET', '/me/portal/tenant/history'));
		expect(r.status).toBe(200);
		const leases = r.body.items.filter((i) => i.kind === 'lease');
		expect(leases.map((l) => [l.organizationId, l.id]).sort()).toEqual(
			[
				[w.a.org.id, w.a.tLease],
				[w.b.org.id, w.b.tLease]
			].sort()
		);
		const receipts = r.body.items.filter((i) => i.kind === 'receipt');
		expect(receipts.map((x) => x.id).sort()).toEqual([w.a.tReceipt, w.b.tReceipt].sort());
		for (const i of r.body.items) expect([w.a.org.id, w.b.org.id]).toContain(i.organizationId);
		expect(r.body.items.find((i) => i.organizationId === w.a.org.id)?.organizationName).toBe('Agence Wend-Panga');
		assertOneOrganizationPerQuery(queries, [w.a.org.id, w.b.org.id]);
	});

	it('critère d’acceptation : T télécharge le reçu d’un loyer payé à son ancienne agence (URL signée, journalisé dans A)', async () => {
		await seedIn(owner, w.a.org.id, (c) =>
			c.query(`update receipts set pdf_a6_key = $2 where id = $1`, [w.a.tReceipt, `receipts/${w.a.org.id}/recu.pdf`])
		);
		const r = await w.t.client.call<{ url: string }>('POST', `/me/portal/tenant/receipts/${w.a.org.id}/${w.a.tReceipt}/pdf`);
		expect(r.status).toBe(200);
		expect(r.body.url).toBeTruthy();
		const audit = await seedIn(owner, w.a.org.id, (c) =>
			c.query(`select origin, subject_user_id from audit_log where action = 'receipt.download' and object_id = $1`, [w.a.tReceipt])
		);
		expect(audit.rows).toEqual([{ origin: 'portal', subject_user_id: w.t.userId }]);
		// Le reçu d'un autre locataire, ou un reçu de A demandé au nom de B : introuvable.
		expect((await w.t.client.call('POST', `/me/portal/tenant/receipts/${w.b.org.id}/${w.a.tReceipt}/pdf`)).status).toBe(404);
		expect((await w.p.client.call('POST', `/me/portal/tenant/receipts/${w.a.org.id}/${w.a.tReceipt}/pdf`)).status).toBe(404);
	});

	it('chaque téléchargement écrit sa ligne d’audit, même deux fois en moins de 30 secondes (reçu)', async () => {
		await seedIn(owner, w.a.org.id, (c) =>
			c.query(`update receipts set pdf_a6_key = coalesce(pdf_a6_key, $2) where id = $1`, [w.a.tReceipt, `receipts/${w.a.org.id}/recu.pdf`])
		);
		const count = async () =>
			(
				await seedIn(owner, w.a.org.id, (c) =>
					c.query(`select count(*)::int as n from audit_log where action = 'receipt.download' and object_id = $1`, [w.a.tReceipt])
				)
			).rows[0].n as number;
		const before = await count();
		for (let i = 0; i < 2; i += 1)
			expect((await w.t.client.call('POST', `/me/portal/tenant/receipts/${w.a.org.id}/${w.a.tReceipt}/pdf`)).status).toBe(200);
		expect(await count()).toBe(before + 2);
	});

	it('point a : un membre de A ne voit rien de B par l’API (bail, fiche, reçu de T chez B → 404)', async () => {
		const director = w.a.org.director;
		for (const path of [`/leases/${w.b.tLease}`, `/tenants/${w.b.tTenant}`, `/receipts/${w.b.tReceipt}`]) {
			expect((await director.call('GET', path)).status, path).toBe(404);
		}
	});

	it('chaque lecture écrit une ligne d’audit portal.read dans l’organisation lue (origine portal), aucune ailleurs', async () => {
		const before = await auditCounts();
		await w.t.client.call('GET', '/me/portal/tenant/history');
		const after = await auditCounts();
		expect(after[w.a.org.id]! - before[w.a.org.id]!).toBe(1);
		expect(after[w.b.org.id]! - before[w.b.org.id]!).toBe(1);
		expect(after[w.l.org.id]! - before[w.l.org.id]!).toBe(0);
		const row = await seedIn(owner, w.b.org.id, (c) =>
			c.query(`select origin, subject_user_id, actor_user_id from audit_log where action = 'portal.read' order by id desc limit 1`)
		);
		expect(row.rows[0]).toEqual({ origin: 'portal', subject_user_id: w.t.userId, actor_user_id: w.t.userId });
	});

	it('point d : lien révoqué par l’organisation → les données disparaissent aussitôt, cache compris ; rien n’est supprimé chez A', async () => {
		const first = await w.p.client.call<Assets>('GET', '/me/portal/owner/assets');
		expect(first.body.organizations.map((o) => o.organizationId)).toContain(w.a.org.id);
		const revoke = await w.a.org.director.call('POST', `/person-links/${w.a.pLink}/revoke`, {
			reason: 'Mandat terminé avec ce propriétaire'
		});
		expect(revoke.status).toBe(200);
		const next = await w.p.client.call<Assets>('GET', '/me/portal/owner/assets');
		expect(next.body.organizations.map((o) => o.organizationId).sort()).toEqual([w.b.org.id, w.l.org.id].sort());
		const kept = await seedIn(owner, w.a.org.id, (c) =>
			c.query(`select count(*)::int as n from properties where id = $1`, [w.a.pProperty])
		);
		expect(kept.rows[0].n).toBe(1);
	});

	it('lien demandé mais non accepté par l’organisation : sans effet', async () => {
		const outsider = await portalWorld(t, owner, { links: false });
		await seedIn(owner, outsider.a.org.id, (c) =>
			insertLink(c, outsider.a.org.id, {
				userId: outsider.p.userId,
				phone: outsider.p.phone,
				ownerId: outsider.a.pOwner,
				acceptedBy: outsider.a.org.director.userId,
				status: 'requested'
			})
		);
		const r = await outsider.p.client.call<Assets>('GET', '/me/portal/owner/assets');
		expect(r.status).toBe(200);
		expect(r.body.organizations).toEqual([]);
	});

	it('organisation suspendue : ses propriétaires et ses locataires gardent la lecture (réponse du porteur au lot 03)', async () => {
		await seedIn(owner, w.b.org.id, (c) =>
			c.query(
				`update organizations set verification_status = 'suspended', suspended_at = now(), suspended_reason = 'Test de suspension' where id = $1`,
				[w.b.org.id]
			)
		);
		try {
			const r = await w.t.client.call<History>('GET', '/me/portal/tenant/history');
			expect(r.body.items.some((i) => i.organizationId === w.b.org.id)).toBe(true);
		} finally {
			await seedIn(owner, w.b.org.id, (c) =>
				c.query(`update organizations set verification_status = 'pending', suspended_at = null, suspended_reason = null where id = $1`, [
					w.b.org.id
				])
			);
		}
	});

	it('interrupteur portals.owner_space coupé pour la personne : espace propriétaire inaccessible ; l’espace locataire reste', async () => {
		const override = newId();
		await owner.query(
			`insert into feature_overrides (id, feature_key, scope, user_id, value, reason, created_by) values ($1, 'portals.owner_space', 'user', $2, false, 'Test de l’espace coupé', $2)`,
			[override, w.p.userId]
		);
		await t.app.get(FeaturesService).invalidate();
		try {
			const r = await w.p.client.call('GET', '/me/portal/owner/assets');
			expect(r.status).toBe(403);
			expect(r.body).toMatchObject({ code: 'FEATURE_DISABLED' });
		} finally {
			await owner.query(`update feature_overrides set revoked_at = now(), revoked_by = created_by where id = $1`, [override]);
			await t.app.get(FeaturesService).invalidate();
		}
	});
});

async function auditCounts(): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const o of [w.a, w.b, w.l]) {
		const r = await seedIn(owner, o.org.id, (c) =>
			c.query(`select count(*)::int as n from audit_log where action = 'portal.read' and organization_id = $1`, [o.org.id])
		);
		out[o.org.id] = r.rows[0].n;
	}
	return out;
}
