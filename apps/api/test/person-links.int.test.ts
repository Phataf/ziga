/**
 * Lot 10 ter, étape 2 : liaison d'une fiche au compte d'une personne, par l'API (diagramme de liaison validé ; tests
 * attendus du prompt : numéro différent refusé, code expiré refusé, lien non accepté sans effet, lien révoqué).
 * - (a) Invitation depuis la fiche, aperçu public, réclamée au numéro de la fiche seulement, code SMS, lien actif.
 * - (b) Demande de la personne auprès d'une agence vérifiée (réponse 1), même réponse que la fiche existe ou non,
 *   limites, code, puis acceptation par l'organisation.
 * - Propre fiche du bailleur liée à son numéro vérifié, par son directeur (réponse 2), journalisée.
 * - Révocation par l'organisation et par la personne ; accès croisé ; permissions ; interrupteur de l'espace.
 */
import { randomUUID } from 'node:crypto';
import { newId } from '@ziga/shared/ids';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, newPhone, signedUp, startApp, type TestApp } from './http.js';
import { addMember, apiSql, createOrg, inContext, type Member, type Org } from './orgs.js';
import { insertTenantRecord, migrationClient, seedIn, userIdOf, type Person } from './portals.js';
import { FeaturesService } from '../src/modules/features/features.service.js';
import { sha256 } from './payments.js';
import { resetSharedRedisState, testRedis } from './test-redis.js';

let t: TestApp;
let owner: pg.Client;
let api: pg.Client;
let a: Org;
let b: Org;
let managerA: Member;
let agentA: Member;
let viewerA: Member;

interface Link {
	id: string;
	status: string;
	origin: string;
	phoneVerified: boolean;
	accepted: boolean;
	claimed: boolean;
	recordId: string;
	revokedByParty: string | null;
}

/** Aucun SMS parti à ce numéro depuis l'indice donné (le code de l'inscription ne compte pas). */
function noSmsSince(phone: string, since: number): boolean {
	return t.sms.messages.slice(since).every((m) => m.to !== phone);
}

async function person(phone = newPhone()): Promise<Person> {
	const s = await signedUp(t, phone);
	return { client: s.client, phone: s.phone, userId: await userIdOf(s.client) };
}

async function tenantIn(org: Org, phone: string | null, name = 'Salif Traoré'): Promise<string> {
	return seedIn(owner, org.id, (c) => insertTenantRecord(c, org.id, name, phone));
}

async function invite(org: Org, by: Member, tenantId: string, sendSms = false) {
	return by.call<{ link: Link; token: string; url: string }>('POST', '/person-links', {
		id: newId(),
		recordType: 'tenant',
		recordId: tenantId,
		sendSms
	});
}

async function verifyOrg(org: Org) {
	await seedIn(owner, org.id, (c) =>
		c.query(`update organizations set rccm = 'BF-OUA-2026-B-0101', ifu = '00012345Y', verification_status = 'verified' where id = $1`, [
			org.id
		])
	);
}

beforeAll(async () => {
	t = await startApp();
	owner = await migrationClient();
	api = await apiSql();
	a = await createOrg(t, 'agency', 'Agence Wend-Panga');
	b = await createOrg(t, 'agency', 'Agence Nong-Taaba');
	managerA = await addMember(t, a, 'manager');
	agentA = await addMember(t, a, 'field_agent');
	viewerA = await addMember(t, a, 'viewer');
});

afterAll(async () => {
	await api?.end();
	await owner?.end();
	await t?.close();
});

beforeEach(async () => {
	// Les limites de débit (SMS, demandes) ne débordent pas d'un test à l'autre.
	const redis = testRedis();
	await redis.connect();
	await resetSharedRedisState(redis);
	await redis.quit();
});

describe('(a) invitation depuis la fiche (lot 10 ter, étape 2)', () => {
	it('direction et gestion invitent ; agent de terrain et profil lecture non ; une fiche sans numéro ne s’invite pas ; une fiche liée ou en cours, pas deux fois', async () => {
		const p = await person();
		const tenant = await tenantIn(a, p.phone);
		for (const m of [agentA, viewerA]) expect((await invite(a, m, tenant)).status).toBe(403);
		const r = await invite(a, managerA, tenant);
		expect(r.status).toBe(201);
		expect(r.body.link).toMatchObject({
			status: 'requested',
			origin: 'organization_invite',
			accepted: true,
			phoneVerified: false,
			claimed: false
		});
		expect(r.body.token.startsWith(`${a.id}.`)).toBe(true);
		expect(r.body.url).toMatch(new RegExp(`/lier/${r.body.token.replace('.', '\\.')}$`));
		expect((await invite(a, a.director, tenant)).body).toMatchObject({ code: 'PERSON_LINK_EXISTS' });
		const none = await tenantIn(a, null);
		expect((await invite(a, managerA, none)).body).toMatchObject({ code: 'LINK_RECORD_NO_PHONE' });
		// Journal : l'invitation, sans le jeton ni le numéro en entier.
		const audit = await seedIn(owner, a.id, (c) =>
			c.query(`select after from audit_log where action = 'person_link.invite' and object_id = $1`, [r.body.link.id])
		);
		expect(audit.rows).toHaveLength(1);
		expect(JSON.stringify(audit.rows[0].after)).not.toContain(r.body.token);
		expect(JSON.stringify(audit.rows[0].after)).not.toContain(p.phone);
	});

	it('par SMS si demandé : le lien part au numéro de la fiche', async () => {
		const p = await person();
		const tenant = await tenantIn(a, p.phone);
		const r = await invite(a, managerA, tenant, true);
		expect(r.status).toBe(201);
		const sms = t.sms.messages.filter((m) => m.to === p.phone).at(-1);
		expect(sms?.text).toContain(`/lier/${r.body.token}`);
		expect(sms?.text).toContain('Agence Wend-Panga');
	});

	it('aperçu public : organisation, type de fiche, numéro masqué ; un jeton inconnu ou altéré ne dit rien', async () => {
		const p = await person();
		const r = await invite(a, managerA, await tenantIn(a, p.phone));
		const anonymous = new Client(t.url);
		const preview = await anonymous.call<{ organizationName: string; recordType: string; phone: string; usable: boolean }>(
			'GET',
			`/person-link-invitations/${r.body.token}`
		);
		expect(preview.status).toBe(200);
		expect(preview.body).toMatchObject({ organizationName: 'Agence Wend-Panga', recordType: 'tenant', usable: true });
		expect(preview.body.phone).toContain('••');
		expect(JSON.stringify(preview.body)).not.toContain(p.phone);
		for (const bad of [`${a.id}.${'x'.repeat(43)}`, `${newId()}.${'x'.repeat(43)}`, 'nimporte-quoi']) {
			expect((await anonymous.call('GET', `/person-link-invitations/${bad}`)).status).toBe(404);
		}
	});

	it('point b : réclamée avec un compte à un autre numéro → refusée, l’invitation reste intacte ; au numéro de la fiche → code SMS', async () => {
		const p = await person();
		const tenant = await tenantIn(a, p.phone);
		const r = await invite(a, managerA, tenant);
		const intruder = await person();
		const sent = t.sms.messages.length;
		const refused = await intruder.client.call('POST', `/person-link-invitations/${r.body.token}/claim`);
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({ code: 'LINK_PHONE_MISMATCH' });
		expect(noSmsSince(intruder.phone, sent)).toBe(true);
		const state = await seedIn(owner, a.id, (c) => c.query(`select user_id, claimed_at from person_links where id = $1`, [r.body.link.id]));
		expect(state.rows[0]).toEqual({ user_id: null, claimed_at: null });

		const claimed = await p.client.call<{ organizationId: string; linkId: string }>(
			'POST',
			`/person-link-invitations/${r.body.token}/claim`
		);
		expect(claimed.status).toBe(200);
		expect(claimed.body).toEqual({ organizationId: a.id, linkId: r.body.link.id });
		expect(t.sms.lastCode(p.phone)).toMatch(/^\d{6}$/);
		// Une autre personne ne la réclame plus, même au bon numéro (le lien est à elle).
		expect((await intruder.client.call('POST', `/person-link-invitations/${r.body.token}/claim`)).status).toBe(404);
	});

	it('code faux, puis expiré : refusés ; nouveau code : le lien devient actif (accepté d’avance par l’organisation)', async () => {
		const p = await person();
		const tenant = await tenantIn(a, p.phone);
		const r = await invite(a, managerA, tenant);
		await p.client.call('POST', `/person-link-invitations/${r.body.token}/claim`);
		const linkId = r.body.link.id;
		const code = t.sms.lastCode(p.phone)!;
		const wrong = code === '000000' ? '111111' : '000000';
		expect((await p.client.call('POST', `/me/person-links/${linkId}/verify`, { organizationId: a.id, code: wrong })).body).toMatchObject({
			code: 'INVALID_CODE'
		});
		// Expiré : le bon code ne sert plus.
		await owner.query(`update otp_codes set expires_at = now() - interval '1 minute' where person_link_id = $1 and consumed_at is null`, [
			linkId
		]);
		expect((await p.client.call('POST', `/me/person-links/${linkId}/verify`, { organizationId: a.id, code })).body).toMatchObject({
			code: 'INVALID_CODE'
		});
		const still = await seedIn(owner, a.id, (c) => c.query(`select status, phone_verified_at from person_links where id = $1`, [linkId]));
		expect(still.rows[0]).toEqual({ status: 'requested', phone_verified_at: null });

		expect((await p.client.call('POST', `/me/person-links/${linkId}/code`, { organizationId: a.id })).status).toBe(202);
		const fresh = t.sms.lastCode(p.phone)!;
		const ok = await p.client.call<{ status: string; organizationName: string }>('POST', `/me/person-links/${linkId}/verify`, {
			organizationId: a.id,
			code: fresh
		});
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({
			id: linkId,
			status: 'active',
			organizationName: 'Agence Wend-Panga',
			phoneVerified: true,
			accepted: true
		});
		// La fiche dans l'organisation : lien actif ; journal : réclamation et vérification, origine portal.
		const list = await managerA.call<Link[]>('GET', `/person-links?recordType=tenant&recordId=${tenant}`);
		expect(list.body.map((l) => l.status)).toEqual(['active']);
		const audit = await seedIn(owner, a.id, (c) =>
			c.query(`select action, origin, subject_user_id from audit_log where object_id = $1 order by id`, [linkId])
		);
		expect(audit.rows.map((x) => [x.action, x.origin])).toEqual([
			['person_link.invite', 'app'],
			['person_link.claim', 'portal'],
			['person_link.verify', 'portal']
		]);
		expect(audit.rows.slice(1).every((x) => x.subject_user_id === p.userId)).toBe(true);
	});

	it('invitation expirée : ni réclamée, ni montrée comme valable ; 7 jours de validité à l’envoi', async () => {
		const p = await person();
		const fresh = await invite(a, managerA, await tenantIn(a, p.phone));
		const preview = await new Client(t.url).call<{ usable: boolean; expiresAt: string }>(
			'GET',
			`/person-link-invitations/${fresh.body.token}`
		);
		expect(new Date(preview.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);

		const q = await person();
		const tenant = await tenantIn(a, q.phone);
		const token = `${a.id}.${'e'.repeat(43)}`;
		await seedIn(owner, a.id, (c) =>
			c.query(
				`insert into person_links (id, organization_id, record_type, tenant_id, status, origin, phone, requested_by, accepted_by, accepted_at,
					invite_token_hash, invite_expires_at) values ($1, $2, 'tenant', $3, 'requested', 'organization_invite', $4, $5, $5, now(), $6, now() - interval '1 minute')`,
				[newId(), a.id, tenant, q.phone, managerA.userId, sha256(token)]
			)
		);
		const sent = t.sms.messages.length;
		const expired = await new Client(t.url).call<{ usable: boolean }>('GET', `/person-link-invitations/${token}`);
		expect(expired.body.usable).toBe(false);
		expect((await q.client.call('POST', `/person-link-invitations/${token}/claim`)).status).toBe(404);
		expect(noSmsSince(q.phone, sent)).toBe(true);
	});
});

describe('(b) demande de la personne (lot 10 ter, étape 2)', () => {
	it('réponse 1 : seules les agences vérifiées sont proposées, noms seulement ; une demande vers une autre organisation est refusée', async () => {
		const landlord = await createOrg(t, 'landlord', 'Bailleur Kaboré');
		await verifyOrg(b);
		const p = await person();
		const list = await p.client.call<{ id: string; name: string }[]>('GET', '/me/person-links/organizations');
		expect(list.status).toBe(200);
		const ids = list.body.map((o) => o.id);
		expect(ids).toContain(b.id);
		expect(ids).not.toContain(landlord.id);
		for (const o of list.body) expect(Object.keys(o).sort()).toEqual(['id', 'name']);
		for (const target of [landlord.id, a.id]) {
			if (target === a.id && ids.includes(a.id)) continue;
			const r = await p.client.call('POST', '/me/person-links/requests', { id: newId(), organizationId: target, recordType: 'tenant' });
			expect(r.status).toBe(409);
			expect(r.body).toMatchObject({ code: 'PERSON_LINK_REQUEST_ORGANIZATION' });
		}
	});

	it('même réponse que la fiche existe ou non ; si elle existe : code au numéro, lien demandé, sans effet avant l’acceptation', async () => {
		await verifyOrg(b);
		const withRecord = await person();
		const without = await person();
		const tenant = await tenantIn(b, withRecord.phone);
		const sent = t.sms.messages.length;
		const r1 = await withRecord.client.call('POST', '/me/person-links/requests', {
			id: newId(),
			organizationId: b.id,
			recordType: 'tenant'
		});
		const r2 = await without.client.call('POST', '/me/person-links/requests', { id: newId(), organizationId: b.id, recordType: 'tenant' });
		expect([r1.status, r2.status]).toEqual([202, 202]);
		expect(r1.body).toEqual(r2.body);
		expect(noSmsSince(without.phone, sent)).toBe(true);
		const code = t.sms.lastCode(withRecord.phone)!;
		const mine = await withRecord.client.call<{ id: string; status: string; accepted: boolean }[]>('GET', '/me/person-links');
		const link = mine.body.find((l) => l.status === 'requested')!;
		expect(link).toMatchObject({ organizationId: b.id, organizationName: 'Agence Nong-Taaba', recordType: 'tenant', accepted: false });
		const verified = await withRecord.client.call('POST', `/me/person-links/${link.id}/verify`, { organizationId: b.id, code });
		expect(verified.body).toMatchObject({ status: 'requested', phoneVerified: true, accepted: false });
		// Lien non accepté par l'organisation : sans effet (aucun lien actif pour l'espace).
		const active = await inContext(api, { userId: withRecord.userId }, () => api.query(`select link_id from my_person_links()`));
		expect(active.rows.map((x) => x.link_id)).not.toContain(link.id);
		// L'organisation la voit sur la fiche et l'accepte : le lien devient actif.
		const onRecord = await b.director.call<Link[]>('GET', `/person-links?recordType=tenant&recordId=${tenant}`);
		expect(onRecord.body).toEqual([
			expect.objectContaining({ id: link.id, origin: 'person_request', phoneVerified: true, accepted: false })
		]);
		const accepted = await b.director.call<Link>('POST', `/person-links/${link.id}/accept`);
		expect(accepted.body).toMatchObject({ status: 'active', accepted: true });
		const after = await inContext(api, { userId: withRecord.userId }, () => api.query(`select link_id from my_person_links()`));
		expect(after.rows.map((x) => x.link_id)).toContain(link.id);
	});

	it('limites : par compte et par numéro, sur 24 heures', async () => {
		await verifyOrg(b);
		const p = await person();
		const statuses: number[] = [];
		for (let i = 0; i < 6; i += 1) {
			statuses.push(
				(await p.client.call('POST', '/me/person-links/requests', { id: newId(), organizationId: b.id, recordType: 'owner' })).status
			);
		}
		expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
	});
});

describe('révocation, accès croisé, propre fiche du bailleur, interrupteur', () => {
	async function activeLink(org: Org, by: Member) {
		const p = await person();
		const tenant = await tenantIn(org, p.phone);
		const r = await invite(org, by, tenant);
		await p.client.call('POST', `/person-link-invitations/${r.body.token}/claim`);
		await p.client.call('POST', `/me/person-links/${r.body.link.id}/verify`, { organizationId: org.id, code: t.sms.lastCode(p.phone)! });
		return { p, tenant, linkId: r.body.link.id };
	}

	it('l’organisation révoque, motivé : le lien disparaît des liens actifs, rien n’est supprimé ; révoqué, il ne change plus', async () => {
		const { p, linkId } = await activeLink(a, managerA);
		expect((await agentA.call('POST', `/person-links/${linkId}/revoke`, { reason: 'Fiche en double' })).status).toBe(403);
		expect((await managerA.call('POST', `/person-links/${linkId}/revoke`, { reason: 'ok' })).status).toBe(400);
		const r = await managerA.call<Link>('POST', `/person-links/${linkId}/revoke`, { reason: 'Le locataire a quitté le logement' });
		expect(r.body).toMatchObject({ status: 'revoked', revokedByParty: 'organization' });
		expect((await p.client.call<unknown[]>('GET', '/me/person-links')).body).toEqual([]);
		expect((await managerA.call('POST', `/person-links/${linkId}/revoke`, { reason: 'Deuxième fois' })).body).toMatchObject({
			code: 'PERSON_LINK_REVOKED'
		});
		const kept = await seedIn(owner, a.id, (c) => c.query(`select status from person_links where id = $1`, [linkId]));
		expect(kept.rows).toEqual([{ status: 'revoked' }]);
	});

	it('la personne révoque l’un de ses liens, motivé ; jamais celui d’une autre personne', async () => {
		const mine = await activeLink(a, managerA);
		const other = await activeLink(a, managerA);
		expect(
			(await mine.p.client.call('POST', `/me/person-links/${other.linkId}/revoke`, { organizationId: a.id, reason: 'Pas le mien' })).status
		).toBe(404);
		expect(
			(await mine.p.client.call('POST', `/me/person-links/${mine.linkId}/revoke`, { organizationId: a.id, reason: 'Je ne loue plus ici' }))
				.status
		).toBe(204);
		const rows = await seedIn(owner, a.id, (c) =>
			c.query(`select id, status, revoked_by_party from person_links where id = any($1) order by id`, [[mine.linkId, other.linkId]])
		);
		expect(Object.fromEntries(rows.rows.map((x) => [x.id, [x.status, x.revoked_by_party]]))).toEqual({
			[mine.linkId]: ['revoked', 'person'],
			[other.linkId]: ['active', null]
		});
	});

	it('accès croisé : un membre de B ne voit, n’accepte ni ne révoque un lien de A', async () => {
		const { tenant, linkId } = await activeLink(a, managerA);
		expect((await b.director.call<Link[]>('GET', `/person-links?recordType=tenant&recordId=${tenant}`)).body).toEqual([]);
		expect((await b.director.call('POST', `/person-links/${linkId}/accept`)).status).toBe(404);
		expect((await b.director.call('POST', `/person-links/${linkId}/revoke`, { reason: 'Depuis une autre agence' })).status).toBe(404);
		// Ni en passant l'organisation A en en-tête : il n'en est pas membre.
		expect((await b.director.call('POST', `/person-links/${linkId}/revoke`, { reason: 'Depuis une autre agence' }, a.id)).status).toBe(403);
		// Une invitation de B vers une fiche de A : introuvable.
		expect((await invite(b, b.director, tenant)).status).toBe(404);
	});

	it('réponse 2 : la propre fiche du bailleur se lie à son numéro vérifié, une fois, journalisée ; jamais à un autre numéro', async () => {
		const landlord = await createOrg(t, 'landlord', 'Rasmané Compaoré');
		const director = landlord.director;
		// Fiche créée au numéro de l'organisation : pas le sien, rien n'est lié.
		expect((await director.client.call<unknown[]>('GET', '/me/person-links')).body).toEqual([]);
		await seedIn(owner, landlord.id, (c) =>
			c.query(
				`update owners set phone = $2 where organization_id = $1 and id = (select owner_id from mandates where organization_id = $1 and type = 'self_managed')`,
				[landlord.id, director.phone]
			)
		);
		const first = await director.client.call<{ id: string; status: string; organizationId: string }[]>('GET', '/me/person-links');
		expect(first.body).toEqual([expect.objectContaining({ organizationId: landlord.id, recordType: 'owner', status: 'active' })]);
		const again = await director.client.call<{ id: string }[]>('GET', '/me/person-links');
		expect(again.body.map((l) => l.id)).toEqual(first.body.map((l) => l.id));
		const audit = await seedIn(owner, landlord.id, (c) => c.query(`select origin from audit_log where action = 'person_link.auto_link'`));
		expect(audit.rows).toEqual([{ origin: 'portal' }]);
		// Révoqué par lui : jamais relié sans lui.
		await director.client.call('POST', `/me/person-links/${first.body[0]!.id}/revoke`, {
			organizationId: landlord.id,
			reason: 'Je gère sans espace'
		});
		expect((await director.client.call<unknown[]>('GET', '/me/person-links')).body).toEqual([]);
	});

	it('interrupteur de l’espace coupé pour l’organisation : invitation refusée', async () => {
		const p = await person();
		const tenant = await tenantIn(a, p.phone);
		const override = newId();
		await owner.query(
			`insert into feature_overrides (id, feature_key, scope, organization_id, value, reason, created_by) values ($1, 'portals.tenant_space', 'organization', $2, false, 'Test de l’espace locataire coupé', $3)`,
			[override, a.id, a.director.userId]
		);
		// Comme le back-office : la copie des interrupteurs en cache est vidée.
		await t.app.get(FeaturesService).invalidate();
		try {
			const r = await invite(a, managerA, tenant);
			expect(r.status).toBe(403);
			expect(r.body).toMatchObject({ code: 'FEATURE_DISABLED' });
		} finally {
			await owner.query(`update feature_overrides set revoked_at = now(), revoked_by = created_by where id = $1`, [override]);
			await t.app.get(FeaturesService).invalidate();
		}
	});
});

describe('invitation expirée : la fiche n’est jamais bloquée (correctif avant l’étape 2b)', () => {
	/** Invitation de l'organisation, jamais réclamée, expirée depuis une minute (la base fige l'expiration : posée à l'insertion). */
	async function expiredInvite(org: Org, by: Member, record: { ownerId?: string; tenantId?: string }, phone: string): Promise<string> {
		const id = newId();
		await seedIn(owner, org.id, (c) =>
			c.query(
				`insert into person_links (id, organization_id, record_type, owner_id, tenant_id, status, origin, phone, requested_by, accepted_by,
					accepted_at, invite_token_hash, invite_expires_at)
				 values ($1, $2, $3, $4, $5, 'requested', 'organization_invite', $6, $7, $7, now(), $8, now() - interval '1 minute')`,
				[
					id,
					org.id,
					record.ownerId ? 'owner' : 'tenant',
					record.ownerId ?? null,
					record.tenantId ?? null,
					phone,
					by.userId,
					sha256(`${org.id}.${randomUUID()}${randomUUID()}`)
				]
			)
		);
		return id;
	}

	async function expectExpiredRevoked(org: Org, linkId: string) {
		const r = await seedIn(owner, org.id, async (c) => ({
			link: (await c.query(`select status, revoked_by_party, revoked_by, revocation_reason from person_links where id = $1`, [linkId]))
				.rows[0],
			audit: (
				await c.query(
					`select actor_type, organization_id, action, after from audit_log where object_id = $1 and action = 'person_link.revoke'`,
					[linkId]
				)
			).rows
		}));
		expect(r.link).toEqual({ status: 'revoked', revoked_by_party: 'system', revoked_by: null, revocation_reason: 'Invitation expirée' });
		expect(r.audit).toEqual([
			expect.objectContaining({
				actor_type: 'system',
				organization_id: org.id,
				after: expect.objectContaining({ status: 'revoked', revokedByParty: 'system', cause: 'invitation_expired' })
			})
		]);
	}

	it('réinviter après expiration : l’ancienne invitation est révoquée (« Invitation expirée », audit), la nouvelle part', async () => {
		const p = await person();
		const tenant = await tenantIn(a, p.phone);
		const old = await expiredInvite(a, managerA, { tenantId: tenant }, p.phone);
		const r = await invite(a, managerA, tenant);
		expect(r.status).toBe(201);
		await expectExpiredRevoked(a, old);
		const list = await managerA.call<Link[]>('GET', `/person-links?recordType=tenant&recordId=${tenant}`);
		expect(list.body.map((l) => [l.id, l.status])).toEqual([
			[r.body.link.id, 'requested'],
			[old, 'revoked']
		]);
	});

	it('demande de la personne après expiration : le code part et la demande est enregistrée', async () => {
		await verifyOrg(b);
		const p = await person();
		const tenant = await tenantIn(b, p.phone);
		const old = await expiredInvite(b, b.director, { tenantId: tenant }, p.phone);
		const sent = t.sms.messages.length;
		const r = await p.client.call('POST', '/me/person-links/requests', { id: newId(), organizationId: b.id, recordType: 'tenant' });
		expect(r.status).toBe(202);
		expect(noSmsSince(p.phone, sent)).toBe(false);
		await expectExpiredRevoked(b, old);
		const mine = await p.client.call<{ status: string; organizationId: string }[]>('GET', '/me/person-links');
		expect(mine.body).toEqual([expect.objectContaining({ organizationId: b.id, status: 'requested' })]);
	});

	it('liaison automatique du bailleur après expiration d’une invitation sur sa propre fiche', async () => {
		const landlord = await createOrg(t, 'landlord', 'Mariam Zongo');
		const selfOwner = await seedIn(owner, landlord.id, async (c) => {
			const r = await c.query(`select owner_id from mandates where organization_id = $1 and type = 'self_managed'`, [landlord.id]);
			await c.query(`update owners set phone = $2 where id = $1`, [r.rows[0].owner_id, landlord.director.phone]);
			return r.rows[0].owner_id as string;
		});
		const old = await expiredInvite(landlord, landlord.director, { ownerId: selfOwner }, landlord.director.phone);
		const mine = await landlord.director.client.call<{ status: string; recordType: string }[]>('GET', '/me/person-links');
		expect(mine.body).toEqual([expect.objectContaining({ organizationId: landlord.id, recordType: 'owner', status: 'active' })]);
		await expectExpiredRevoked(landlord, old);
	});

	it('une invitation réclamée par une personne mais au code non validé reste en l’état, même expirée : elle lui appartient', async () => {
		const p = await person();
		const tenant = await tenantIn(a, p.phone);
		// Invitation déjà à elle (sa personne posée), expirée, code jamais validé.
		const mineId = newId();
		await seedIn(owner, a.id, (c) =>
			c.query(
				`insert into person_links (id, organization_id, user_id, record_type, tenant_id, status, origin, phone, requested_by, accepted_by,
					accepted_at, invite_token_hash, invite_expires_at)
				 values ($1, $2, $3, 'tenant', $4, 'requested', 'organization_invite', $5, $6, $6, now(), $7, now() - interval '1 minute')`,
				[mineId, a.id, p.userId, tenant, p.phone, managerA.userId, sha256(`${a.id}.${randomUUID()}${randomUUID()}`)]
			)
		);
		expect((await invite(a, managerA, tenant)).body).toMatchObject({ code: 'PERSON_LINK_EXISTS' });
		const still = await seedIn(owner, a.id, (c) => c.query(`select status, user_id from person_links where id = $1`, [mineId]));
		expect(still.rows[0]).toEqual({ status: 'requested', user_id: p.userId });
	});

	it('deux fiches au même numéro (doublon d’import) : la plus récemment modifiée est retenue, l’autre nommée au journal', async () => {
		await verifyOrg(b);
		const p = await person();
		const older = await tenantIn(b, p.phone, 'Salif Traoré (import)');
		const newer = await tenantIn(b, p.phone, 'Salif Traoré');
		await seedIn(owner, b.id, (c) => c.query(`update tenants set updated_at = now() + interval '1 second' where id = $1`, [newer]));
		await p.client.call('POST', '/me/person-links/requests', { id: newId(), organizationId: b.id, recordType: 'tenant' });
		const rows = await seedIn(owner, b.id, async (c) => ({
			links: (await c.query(`select tenant_id from person_links where user_id = $1`, [p.userId])).rows,
			audit: (await c.query(`select after from audit_log where action = 'person_link.request' and subject_user_id = $1`, [p.userId])).rows
		}));
		expect(rows.links).toEqual([{ tenant_id: newer }]);
		expect(rows.audit[0].after.otherRecordsWithSamePhone).toEqual([older]);
	});
});

describe('« Renvoyer l’invitation » (lot 10 ter, étape 3)', () => {
	it('en une action : l’ancienne invitation est révoquée (« Invitation renvoyée »), une nouvelle part avec un nouveau jeton', async () => {
		const p = await person();
		const tenant = await tenantIn(a, p.phone);
		const first = await invite(a, managerA, tenant);
		const r = await managerA.call<{ link: Link; token: string; url: string }>('POST', `/person-links/${first.body.link.id}/resend`, {
			sendSms: true
		});
		expect(r.status).toBe(201);
		expect(r.body.link.id).not.toBe(first.body.link.id);
		expect(r.body.token).not.toBe(first.body.token);
		expect(r.body.link).toMatchObject({ status: 'requested', origin: 'organization_invite', recordId: tenant });
		const old = await seedIn(owner, a.id, (c) =>
			c.query(`select status, revocation_reason, revoked_by_party from person_links where id = $1`, [first.body.link.id])
		);
		expect(old.rows[0]).toEqual({ status: 'revoked', revocation_reason: 'Invitation renvoyée', revoked_by_party: 'organization' });
		// L'ancien lien ne sert plus ; le nouveau, oui ; le SMS porte le nouveau lien.
		expect((await new Client(t.url).call<{ usable: boolean }>('GET', `/person-link-invitations/${first.body.token}`)).body.usable).toBe(
			false
		);
		expect((await new Client(t.url).call<{ usable: boolean }>('GET', `/person-link-invitations/${r.body.token}`)).body.usable).toBe(true);
		expect(t.sms.messages.filter((m) => m.to === p.phone).at(-1)?.text).toContain(r.body.token);
	});

	it('jamais pour une invitation déjà ouverte par la personne, ni pour un lien actif ; jamais par un agent de terrain', async () => {
		const p = await person();
		const tenant = await tenantIn(a, p.phone);
		const r = await invite(a, managerA, tenant);
		expect((await agentA.call('POST', `/person-links/${r.body.link.id}/resend`, {})).status).toBe(403);
		await p.client.call('POST', `/person-link-invitations/${r.body.token}/claim`);
		expect((await managerA.call('POST', `/person-links/${r.body.link.id}/resend`, {})).body).toMatchObject({ code: 'PERSON_LINK_CLAIMED' });
		await p.client.call('POST', `/me/person-links/${r.body.link.id}/verify`, { organizationId: a.id, code: t.sms.lastCode(p.phone)! });
		expect((await managerA.call('POST', `/person-links/${r.body.link.id}/resend`, {})).body).toMatchObject({ code: 'PERSON_LINK_STATUS' });
	});
});
