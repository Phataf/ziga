/**
 * Lot 05, étape 3 : POST /sync/upload, l'envoi des modifications faites sur l'appareil.
 * - Rejeu avec les mêmes validation, permission, interrupteur, règle de création et audit (origine `sync`) que la
 *   route HTTP ; toujours 200, avec le résultat de chaque opération.
 * - Idempotence : une opération reçue deux fois (ou en même temps) n'est appliquée qu'une fois.
 * - sync_operations : table d'organisation, cloisonnée (accès croisé), en ajout seul.
 */
import { Module, type OnModuleInit, Injectable } from '@nestjs/common';
import { newId } from '@ziga/shared/ids';
import type { SyncOperationResult } from '@ziga/shared/sync';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FeaturesService } from '../src/modules/features/features.service.js';
import { SyncModule } from '../src/modules/sync/sync.module.js';
import { SyncRegistry } from '../src/modules/sync/sync-registry.js';
import { Client, startApp, type TestApp } from './http.js';
import { addMember, apiSql, createOrg, inContext, setPlan, sqlError, type Member, type Org } from './orgs.js';

/** Tables de test : l'une gardée par une fonctionnalité, l'autre comptée comme une création ; rien n'est écrit. */
@Injectable()
class ProbeHandlers implements OnModuleInit {
	constructor(private readonly registry: SyncRegistry) {}
	onModuleInit(): void {
		const organizationOf = (op: { data?: Record<string, unknown> | null }) => String(op.data?.organization_id ?? '');
		this.registry.register({
			table: 'probe_feature',
			operations: ['PUT'],
			permission: 'organization.update',
			feature: 'listings.publication',
			organizationOf,
			apply: async () => undefined
		});
		this.registry.register({
			table: 'probe_creation',
			operations: ['PUT'],
			permission: 'organization.update',
			creation: true,
			organizationOf,
			apply: async () => undefined
		});
	}
}
@Module({ imports: [SyncModule], providers: [ProbeHandlers] })
class ProbeModule {}

let t: TestApp;
let a: Org;
let b: Org;
let manager: Member;
let owner: pg.Client;
let counter = 0;

const key = () => `test-${newId()}:${++counter}`;
const patchOrganization = (org: Org, data: Record<string, unknown>, k = key()) => ({
	key: k,
	op: 'PATCH',
	table: 'organizations',
	id: org.id,
	data
});

async function upload(member: Member | Client, operations: unknown[]): Promise<{ status: number; results: SyncOperationResult[] }> {
	const client = 'client' in member ? member.client : member;
	const r = await client.call<{ results: SyncOperationResult[] }>('POST', '/sync/upload', { operations });
	return { status: r.status, results: r.body.results };
}

async function organizationRow(org: Org) {
	const r = await owner.query(`select trade_name, legal_name, commune, rep_name, rep_title from organizations where id = $1`, [org.id]);
	return r.rows[0] as { trade_name: string | null; legal_name: string; commune: string; rep_name: string | null; rep_title: string | null };
}

async function auditOf(org: Org) {
	const r = await owner.query(
		`select action, origin, before, after from audit_log where organization_id = $1 and action = 'organization.update' order by id`,
		[org.id]
	);
	return r.rows as { action: string; origin: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
}

beforeAll(async () => {
	t = await startApp({}, [ProbeModule]);
	a = await createOrg(t, 'agency', 'Agence A synchro');
	b = await createOrg(t, 'agency', 'Agence B synchro');
	manager = await addMember(t, a, 'manager');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
});
afterAll(async () => {
	await owner.end();
	await t.close();
});

describe('POST /sync/upload : modèle de référence (paramètres de l’organisation)', () => {
	it('une modification faite sur l’appareil arrive en base, avec sa ligne d’audit d’origine sync', async () => {
		const r = await upload(a.director, [patchOrganization(a, { trade_name: 'Agence A, nom changé hors ligne' })]);
		expect(r.status).toBe(200);
		expect(r.results).toEqual([expect.objectContaining({ status: 'applied', replayed: false })]);
		expect((await organizationRow(a)).trade_name).toBe('Agence A, nom changé hors ligne');
		const audit = (await auditOf(a)).at(-1)!;
		expect(audit).toMatchObject({ origin: 'sync', before: { tradeName: null }, after: { tradeName: 'Agence A, nom changé hors ligne' } });
	});

	it('la même opération envoyée deux fois n’est appliquée qu’une fois ; la seconde reçoit le premier résultat', async () => {
		const op = patchOrganization(a, { trade_name: 'Nom envoyé deux fois' });
		const auditBefore = (await auditOf(a)).length;
		const first = await upload(a.director, [op]);
		const second = await upload(a.director, [op]);
		expect(first.results[0]).toMatchObject({ status: 'applied', replayed: false });
		expect(second.results[0]).toMatchObject({ status: 'applied', replayed: true });
		expect((await auditOf(a)).length).toBe(auditBefore + 1);
		const rows = await owner.query(`select count(*)::int as n from sync_operations where idempotency_key = $1`, [op.key]);
		expect(rows.rows[0].n).toBe(1);
	});

	it('envoyée en même temps par deux requêtes : appliquée une seule fois', async () => {
		const op = patchOrganization(a, { trade_name: `Envoi simultané ${newId().slice(-4)}` });
		const auditBefore = (await auditOf(a)).length;
		const [x, y] = await Promise.all([upload(a.director, [op]), upload(a.director, [op])]);
		expect([x.results[0]!.replayed, y.results[0]!.replayed].sort()).toEqual([false, true]);
		expect([x.results[0]!.status, y.results[0]!.status]).toEqual(['applied', 'applied']);
		expect((await auditOf(a)).length).toBe(auditBefore + 1);
	});

	it('PATCH ne porte que les champs modifiés : les autres restent (dernière écriture par champ)', async () => {
		await upload(a.director, [patchOrganization(a, { commune: 'Saaba' })]);
		await upload(a.director, [patchOrganization(a, { trade_name: 'Nom après la commune' })]);
		expect(await organizationRow(a)).toMatchObject({
			commune: 'Saaba',
			trade_name: 'Nom après la commune',
			legal_name: 'Agence A synchro'
		});
	});

	it('représentant légal : les champs reçus complètent ceux du serveur, validés en entier', async () => {
		const r = await upload(a.director, [
			{ key: key(), op: 'PATCH', table: 'organization_representatives', id: a.id, data: { rep_name: 'Awa Kaboré' } },
			{ key: key(), op: 'PATCH', table: 'organization_representatives', id: a.id, data: { rep_title: 'Gérante' } }
		]);
		expect(r.results.map((x) => x.status)).toEqual(['applied', 'applied']);
		expect(await organizationRow(a)).toMatchObject({ rep_name: 'Awa Kaboré', rep_title: 'Gérante' });
	});

	it('un enregistrement qui touche la fiche et le représentant : deux lignes d’audit, le même request_id, celui de l’envoi', async () => {
		const sent = await a.director.client.call<{ results: SyncOperationResult[] }>('POST', '/sync/upload', {
			operations: [
				patchOrganization(a, { trade_name: 'Fiche et représentant' }),
				{ key: key(), op: 'PATCH', table: 'organization_representatives', id: a.id, data: { rep_title: 'Directrice générale' } }
			]
		});
		expect(sent.body.results.map((x) => x.status)).toEqual(['applied', 'applied']);
		const requestId = sent.headers.get('x-request-id');
		expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
		const rows = await owner.query(`select origin, after from audit_log where organization_id = $1 and request_id = $2 order by id`, [
			a.id,
			requestId
		]);
		expect(rows.rows).toEqual([
			{ origin: 'sync', after: expect.objectContaining({ tradeName: 'Fiche et représentant' }) },
			{ origin: 'sync', after: expect.objectContaining({ representative: expect.objectContaining({ title: 'Directrice générale' }) }) }
		]);
		// Le journal de l'organisation le montre aussi ; un autre envoi a un autre identifiant.
		const journal = await a.director.call<{ entries: { requestId: string | null }[] }>('GET', '/organization/audit');
		expect(journal.body.entries.filter((e) => e.requestId === requestId)).toHaveLength(2);
		const next = await a.director.client.call('POST', '/sync/upload', { operations: [patchOrganization(a, { commune: 'Koudougou' })] });
		expect(next.headers.get('x-request-id')).not.toBe(requestId);
	});

	it('un lot garde l’ordre de la file et rend un résultat par opération', async () => {
		const r = await upload(a.director, [
			patchOrganization(a, { trade_name: 'Premier' }),
			patchOrganization(a, { legal_name: '' }),
			patchOrganization(a, { trade_name: 'Troisième' })
		]);
		expect(r.results.map((x) => x.status)).toEqual(['applied', 'rejected', 'applied']);
		expect((await organizationRow(a)).trade_name).toBe('Troisième');
	});
});

describe('POST /sync/upload : refus, avec code et motif, sans bloquer la file', () => {
	it('gestionnaire qui modifie le nom de l’agence : FORBIDDEN_ACTION, rien ne change', async () => {
		const before = await organizationRow(a);
		const r = await upload(manager, [patchOrganization(a, { trade_name: 'Nom du gestionnaire' })]);
		expect(r.status).toBe(200);
		// L'organisation visée accompagne le refus : l'appareil le range dans la liste de cette organisation.
		expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'FORBIDDEN_ACTION', organizationId: a.id });
		expect(r.results[0]!.message).toBe('Votre rôle ne permet pas cette action.');
		expect((await organizationRow(a)).trade_name).toBe(before.trade_name);
	});

	it('validation : même schéma que la route HTTP (VALIDATION_ERROR, avec le motif)', async () => {
		const r = await upload(a.director, [patchOrganization(a, { legal_name: '' })]);
		expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'VALIDATION_ERROR' });
		expect(r.results[0]!.message).toMatch(/^Données invalides : /);
	});

	it('champ non modifiable depuis l’appareil (formule, statut, logo) : FIELD_NOT_WRITABLE', async () => {
		const r = await upload(a.director, [patchOrganization(a, { plan_id: 'custom' })]);
		expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'FIELD_NOT_WRITABLE' });
		expect((await owner.query(`select plan_id from organizations where id = $1`, [a.id])).rows[0].plan_id).toBe('pro');
	});

	it('table non déclarée, ou opération non permise : refus', async () => {
		const r = await upload(a.director, [
			{ key: key(), op: 'PATCH', table: 'organization_members', id: newId(), data: { role: 'director' } },
			{ key: key(), op: 'DELETE', table: 'organizations', id: a.id }
		]);
		expect(r.results.map((x) => x.code)).toEqual(['TABLE_NOT_WRITABLE', 'OPERATION_NOT_ALLOWED']);
		// Table inconnue : pas d'organisation déterminée ; table connue : celle de la ligne.
		expect(r.results.map((x) => x.organizationId)).toEqual([undefined, a.id]);
	});

	it('organisation d’autrui : NOT_A_MEMBER, et rien n’est écrit chez elle', async () => {
		const op = patchOrganization(b, { trade_name: 'Piratage' });
		const r = await upload(a.director, [op]);
		expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'NOT_A_MEMBER' });
		expect((await organizationRow(b)).trade_name).toBeNull();
		expect((await owner.query(`select count(*)::int as n from sync_operations where idempotency_key = $1`, [op.key])).rows[0].n).toBe(0);
	});

	it('fonctionnalité coupée pendant que l’appareil était hors ligne : FEATURE_DISABLED à la reconnexion', async () => {
		const features = t.app.get(FeaturesService);
		const op = { key: key(), op: 'PUT', table: 'probe_feature', id: newId(), data: { organization_id: a.id } };
		await owner.query(`update features set global_mode = 'enabled' where key = 'listings.publication'`);
		await features.invalidate();
		expect((await upload(a.director, [{ ...op, key: key() }])).results[0]!.status).toBe('applied');
		try {
			await owner.query(`update features set global_mode = 'disabled' where key = 'listings.publication'`);
			await features.invalidate();
			const r = await upload(a.director, [op]);
			expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'FEATURE_DISABLED' });
			// Renvoyée plus tard (fonctionnalité rouverte) : le premier résultat reste, rien n'est rejoué.
			await owner.query(`update features set global_mode = 'enabled' where key = 'listings.publication'`);
			await features.invalidate();
			expect((await upload(a.director, [op])).results[0]).toMatchObject({ status: 'rejected', code: 'FEATURE_DISABLED', replayed: true });
		} finally {
			await owner.query(`update features set global_mode = 'enabled' where key = 'listings.publication'`);
			await features.invalidate();
		}
	});

	it('création avec un abonnement échu : SUBSCRIPTION_EXPIRED', async () => {
		const c = await createOrg(t, 'agency', 'Agence échue synchro');
		await setPlan(c.id, 'essential');
		await owner.query(`update subscriptions set starts_on = current_date - 90, ends_on = current_date - 60 where organization_id = $1`, [
			c.id
		]);
		const r = await upload(c.director, [{ key: key(), op: 'PUT', table: 'probe_creation', id: newId(), data: { organization_id: c.id } }]);
		expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'SUBSCRIPTION_EXPIRED' });
	});

	it('organisation suspendue : ORGANIZATION_SUSPENDED', async () => {
		const c = await createOrg(t, 'agency', 'Agence suspendue synchro');
		await owner.query(
			`update organizations set verification_status = 'suspended', suspended_at = now(), suspended_reason = 'test' where id = $1`,
			[c.id]
		);
		const r = await upload(c.director, [patchOrganization(c, { trade_name: 'Nom' })]);
		expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'ORGANIZATION_SUSPENDED' });
	});

	it('une clé déjà utilisée par une autre personne n’est jamais un rejeu', async () => {
		const op = patchOrganization(a, { trade_name: 'Nom de la directrice' });
		await upload(a.director, [op]);
		const other = await addMember(t, a, 'director');
		const r = await upload(other, [{ ...op, data: { trade_name: 'Autre nom' } }]);
		expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'IDEMPOTENCY_CONFLICT' });
		expect((await organizationRow(a)).trade_name).toBe('Nom de la directrice');
	});

	it('sans jeton : 401 ; corps invalide : 400', async () => {
		expect((await new Client(t.url).call('POST', '/sync/upload', { operations: [] })).status).toBe(401);
		expect((await a.director.call('POST', '/sync/upload', { operations: [] })).status).toBe(400);
		expect((await a.director.call('POST', '/sync/upload', { operations: [{ op: 'PATCH' }] })).status).toBe(400);
	});
});

describe('sync_operations : cloisonnement et ajout seul', () => {
	it('A ne lit, n’écrit ni ne modifie les opérations de B (accès croisé)', async () => {
		await upload(b.director, [patchOrganization(b, { trade_name: 'Nom de B' })]);
		const sql = await apiSql();
		try {
			await inContext(sql, { organizationId: a.id }, async () => {
				const visible = await sql.query(`select organization_id from sync_operations`);
				expect(visible.rows.every((r) => r.organization_id === a.id)).toBe(true);
				expect(visible.rows.length).toBeGreaterThan(0);
				const write = await sqlError(
					sql,
					`insert into sync_operations (organization_id, idempotency_key, user_id, operation, table_name, row_id, status)
					 select $1::uuid, 'cle-pirate-123', user_id, 'PATCH', 'organizations', $1::text, 'applied' from sync_operations limit 1`,
					[b.id]
				);
				expect(write.code).toBe('42501');
			});
		} finally {
			await sql.end();
		}
	});

	it('ni modification ni suppression, même dans sa propre organisation', async () => {
		const sql = await apiSql();
		try {
			await inContext(sql, { organizationId: a.id }, async () => {
				expect((await sqlError(sql, `update sync_operations set status = 'rejected', code = 'X'`)).code).toBe('42501');
				expect((await sqlError(sql, `delete from sync_operations`)).code).toBe('42501');
			});
		} finally {
			await sql.end();
		}
	});
});
