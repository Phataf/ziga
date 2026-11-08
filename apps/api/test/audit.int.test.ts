/**
 * Journal d'audit (lot 03, règle 4) : ajout seul, écrit dans la même transaction que l'action, deux portées
 * (organisation ; plateforme, visible seulement par la personne concernée), événements d'authentification.
 */
import { newId } from '@ziga/shared/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OrganizationsService } from '../src/modules/organizations/organizations.service.js';
import { Client, signedUp, startApp, type TestApp } from './http.js';
import { addMember, apiSql, createOrg, inContext, sqlError } from './orgs.js';

let t: TestApp;
let sql: pg.Client;
const owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });

beforeAll(async () => {
	t = await startApp();
	sql = await apiSql();
	await owner.connect();
});
afterAll(async () => {
	await sql.end();
	await owner.end();
	await t.close();
});

type Entry = {
	action: string;
	actorRole: string | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	origin: string;
};

describe('ajout seul', () => {
	it('UPDATE, DELETE et TRUNCATE sont refusés, même au propriétaire de la table', async () => {
		const org = await createOrg(t);
		await owner.query('BEGIN');
		try {
			await owner.query(`select set_config('app.organization_id', $1, true)`, [org.id]);
			for (const query of [
				'update audit_log set action = $1::text',
				'delete from audit_log where action <> $1::text',
				'truncate audit_log'
			]) {
				await owner.query('SAVEPOINT s');
				const error = await owner.query(query, query.startsWith('truncate') ? [] : ['falsifie.x']).then(
					() => null,
					(e: Error) => e
				);
				await owner.query('ROLLBACK TO SAVEPOINT s');
				expect(error?.message, query).toContain('AUDIT_APPEND_ONLY');
			}
		} finally {
			await owner.query('ROLLBACK');
		}
	});

	it('app_api n’a même pas le droit de modifier ou de supprimer', async () => {
		const org = await createOrg(t);
		await inContext(sql, { organizationId: org.id }, async () => {
			expect((await sqlError(sql, `update audit_log set action = 'x.y'`)).code).toBe('42501');
			expect((await sqlError(sql, 'delete from audit_log')).code).toBe('42501');
		});
	});
});

describe('chaque action du lot écrit sa ligne, avec avant et après', () => {
	it('création, invitation, acceptation, changement de rôle, retrait, révocation', async () => {
		const org = await createOrg(t, 'agency', 'Agence journal');
		const manager = await addMember(t, org, 'manager');
		await org.director.call('PATCH', `/organization/members/${manager.memberId}`, { role: 'viewer' });
		const inv = await org.director.call<{ invitation: { id: string } }>('POST', '/organization/invitations', {
			phone: '+22670999999',
			role: 'field_agent'
		});
		await org.director.call('DELETE', `/organization/invitations/${inv.body.invitation.id}`);
		await org.director.call('DELETE', `/organization/members/${manager.memberId}`);

		const { entries } = (await org.director.call<{ entries: Entry[] }>('GET', '/organization/audit')).body;
		const byAction = (a: string) => entries.filter((e) => e.action === a);
		expect(byAction('organization.create')[0]).toMatchObject({
			actorRole: 'director',
			after: { type: 'agency', legalName: 'Agence journal' }
		});
		expect(byAction('member.create').length).toBe(2);
		expect(byAction('invitation.create').length).toBe(2);
		expect(byAction('invitation.accept')[0]).toMatchObject({ before: { status: 'pending' }, after: { status: 'accepted' } });
		expect(byAction('member.change_role')[0]).toMatchObject({ before: { role: 'manager' }, after: { role: 'viewer' } });
		expect(byAction('invitation.revoke')[0]).toMatchObject({ after: { status: 'revoked' } });
		expect(byAction('member.remove')[0]).toMatchObject({ before: { status: 'active' }, after: { status: 'removed' } });
		// Origine « app » : les appels portent l'origine du web.
		expect(entries.every((e) => e.origin === 'app')).toBe(true);
		// Jamais le lien d'invitation (secret) dans le journal.
		expect(JSON.stringify(entries)).not.toMatch(/[A-Za-z0-9_-]{40,}/);
	});

	it('pagination par curseur, du plus récent au plus ancien', async () => {
		const org = await createOrg(t);
		for (let i = 0; i < 4; i += 1) await org.director.call('PATCH', '/organization', { commune: `Commune ${i}` });
		const all = (await org.director.call<{ entries: { id: string }[] }>('GET', '/organization/audit')).body.entries;
		const first = await org.director.call<{ entries: { id: string }[]; next: string | null }>('GET', '/organization/audit');
		expect(first.body.next).toBeNull();
		const ids = all.map((e) => e.id);
		expect([...ids].sort().reverse()).toEqual(ids);
		const page = await org.director.call<{ entries: { id: string }[] }>('GET', `/organization/audit?avant=${ids[1]}`);
		expect(page.body.entries.map((e) => e.id)).toEqual(ids.slice(2));
	});
});

describe('l’écriture métier et l’audit réussissent ou échouent ensemble', () => {
	it('si l’audit échoue, la modification est annulée', async () => {
		const org = await createOrg(t);
		const audit = t.app.get(AuditService);
		const spy = vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit indisponible'));
		const r = await org.director.call('PATCH', '/organization', { commune: 'Koudougou' });
		spy.mockRestore();
		expect(r.status).toBe(500);
		expect((await org.director.call('GET', '/organization')).body).toMatchObject({ commune: 'Ouagadougou' });
	});

	it('si l’action échoue après l’audit, la ligne d’audit est annulée', async () => {
		const org = await createOrg(t);
		const before = (await org.director.call<{ entries: unknown[] }>('GET', '/organization/audit')).body.entries.length;
		const svc = t.app.get(OrganizationsService);
		const spy = vi.spyOn(svc, 'view').mockRejectedValueOnce(new Error('échec après audit'));
		const r = await org.director.call('PATCH', '/organization', { commune: 'Koudougou' });
		spy.mockRestore();
		expect(r.status).toBe(500);
		expect((await org.director.call('GET', '/organization')).body).toMatchObject({ commune: 'Ouagadougou' });
		expect((await org.director.call<{ entries: unknown[] }>('GET', '/organization/audit')).body.entries).toHaveLength(before);
	});

	it('en SQL : une ligne d’audit invalide annule toute la transaction', async () => {
		const org = await createOrg(t);
		await inContext(sql, { organizationId: org.id }, async () => {
			await sql.query(`update organizations set commune = 'Bobo-Dioulasso'`);
			expect(
				(
					await sqlError(
						sql,
						`insert into audit_log (id, actor_type, organization_id, action, object_type, origin) values ($1, 'system', $2, 'PAS VALIDE', 'x', 'api')`,
						[newId(), org.id]
					)
				).code
			).toBe('23514');
		});
		expect((await org.director.call('GET', '/organization')).body).toMatchObject({ commune: 'Ouagadougou' });
	});
});

describe('événements d’authentification (plateforme, sans organisation)', () => {
	async function activity(client: Client) {
		return (await client.call<{ entries: Entry[] }>('GET', '/me/activity')).body.entries.map((e) => e.action);
	}

	it('création du compte, connexion, déconnexion, appareil révoqué, réinitialisation, réutilisation de jeton', async () => {
		const { client, phone, password } = await signedUp(t);
		const second = new Client(t.url, '203.0.113.20');
		await second.call('POST', '/auth/login', { phone, password });
		const sessions = (await client.call<{ id: string; current: boolean }[]>('GET', '/sessions')).body;
		await client.call('DELETE', `/sessions/${sessions.find((s) => !s.current)!.id}`);
		const third = new Client(t.url);
		await third.call('POST', '/auth/login', { phone, password });
		await third.call('POST', '/auth/logout', {});

		// Réutilisation d'un ancien jeton de rafraîchissement, hors du délai de grâce.
		const stolen = new Client(t.url);
		await stolen.call('POST', '/auth/login', { phone, password });
		const old = stolen.cookie;
		await stolen.call('POST', '/auth/refresh', {});
		// Rotation vieille d'une minute : hors du délai de grâce, la réutilisation est un vol (D28).
		await owner.query(
			`update refresh_tokens set issued_at = now() - interval '1 minute', used_at = coalesce(used_at - interval '1 minute', null) where user_id = (select id from users where phone = $1)`,
			[phone]
		);
		stolen.cookie = old;
		expect((await stolen.call('POST', '/auth/refresh', {})).status).toBe(401);

		const fresh = new Client(t.url);
		await fresh.call('POST', '/auth/password/forgot', { phone });
		await fresh.call('POST', '/auth/password/reset', { phone, code: t.sms.lastCode(phone), password: 'nouveau-mot-de-passe' });
		const actions = await activity(fresh);
		for (const a of [
			'auth.account_created',
			'auth.login',
			'auth.session_revoked',
			'auth.logout',
			'auth.refresh_reuse_detected',
			'auth.password_reset'
		]) {
			expect(actions, a).toContain(a);
		}
		const reuse = (await fresh.call<{ entries: (Entry & { actorName: string | null })[] }>('GET', '/me/activity')).body.entries.find(
			(e) => e.action === 'auth.refresh_reuse_detected'
		)!;
		expect(reuse.actorName).toBeNull();
		// Jamais de jeton, de code ni de mot de passe.
		expect(JSON.stringify(await fresh.call('GET', '/me/activity'))).not.toMatch(/nouveau-mot-de-passe|eyJ|\b\d{6}\b/);
	});

	it('invisibles pour une autre personne, pour une organisation et pour son directeur', async () => {
		const me = await signedUp(t);
		const other = await signedUp(t);
		const org = await createOrg(t);
		await addMember(t, org, 'manager', me);
		const myId = ((await me.client.call('GET', '/me')).body as { id: string }).id;
		expect((await other.client.call<{ entries: unknown[] }>('GET', '/me/activity')).body.entries.length).toBeGreaterThan(0);
		const others = JSON.stringify((await other.client.call('GET', '/me/activity')).body);
		expect(others).not.toContain(myId);
		const orgJournal = (await org.director.call<{ entries: Entry[] }>('GET', '/organization/audit')).body.entries;
		expect(orgJournal.some((e) => e.action.startsWith('auth.'))).toBe(false);
		await inContext(sql, { organizationId: org.id }, async () => {
			expect((await sql.query('select count(*)::int as n from audit_log where organization_id is null')).rows[0].n).toBe(0);
		});
		await inContext(sql, { userId: myId }, async () => {
			const rows = (await sql.query('select subject_user_id, organization_id from audit_log')).rows;
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.subject_user_id === myId && r.organization_id === null)).toBe(true);
		});
	});

	it('une personne ne peut pas écrire un événement au nom d’une autre', async () => {
		const me = await signedUp(t);
		const other = await signedUp(t);
		const [myId, otherId] = await Promise.all(
			[me, other].map(async (p) => ((await p.client.call('GET', '/me')).body as { id: string }).id)
		);
		await inContext(sql, { userId: myId }, async () => {
			expect(
				(
					await sqlError(
						sql,
						`insert into audit_log (id, actor_type, subject_user_id, action, object_type, origin) values ($1, 'system', $2, 'auth.login', 'user', 'api')`,
						[newId(), otherId]
					)
				).code
			).toBe('42501');
		});
	});

	it('le back-office (app_admin) lit les événements de plateforme, pas ceux d’une organisation', async () => {
		const org = await createOrg(t);
		const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
		await admin.connect();
		try {
			await inContext(admin, {}, async () => {
				expect((await admin.query('select count(*)::int as n from audit_log where organization_id is null')).rows[0].n).toBeGreaterThan(0);
				expect((await admin.query('select count(*)::int as n from audit_log where organization_id = $1', [org.id])).rows[0].n).toBe(0);
			});
		} finally {
			await admin.end();
		}
	});
});
