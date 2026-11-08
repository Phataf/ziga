/**
 * Organisations (lot 03) : création, cloisonnement (règle 1, par l'API et en SQL avec app_api), matrice de
 * permissions, retrait d'un membre, organisation active, bailleur à un seul membre, invitations.
 */
import { newId } from '@ziga/shared/ids';
import { ACTIONS, can, ORGANIZATION_ROLES, type Action, type OrganizationRole } from '@ziga/shared/permissions';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPhone, signedUp, startApp, type TestApp } from './http.js';
import { addMember, apiSql, createOrg, inContext, sqlError, type Member, type Org } from './orgs.js';

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

describe('création d’une organisation', () => {
	it('une personne connectée crée une agence et en devient directrice, statut « en attente »', async () => {
		const org = await createOrg(t, 'agency', 'Immo Faso');
		const mine = await org.director.client.call<{ organizationId: string; role: string; type: string; verificationStatus: string }[]>(
			'GET',
			'/me/organizations'
		);
		expect(mine.body).toEqual([
			{ organizationId: org.id, type: 'agency', name: 'Immo Faso', role: 'director', verificationStatus: 'pending' }
		]);
		const view = await org.director.call('GET', '/organization');
		expect(view.body).toMatchObject({
			id: org.id,
			type: 'agency',
			legalName: 'Immo Faso',
			commune: 'Ouagadougou',
			verificationStatus: 'pending',
			logo: null
		});
	});

	it('« Je gère mes propres logements » crée une organisation de bailleur', async () => {
		const org = await createOrg(t, 'landlord', 'Logements de Fatou');
		expect((await org.director.call('GET', '/organization')).body).toMatchObject({ type: 'landlord' });
	});

	it('refuse un identifiant déjà pris et des champs invalides', async () => {
		const org = await createOrg(t);
		const other = await signedUp(t);
		const dup = await other.client.call('POST', '/organizations', {
			id: org.id,
			type: 'agency',
			legalName: 'Copie',
			phone: '+22625300000',
			commune: 'Ouagadougou'
		});
		expect(dup.status).toBe(409);
		const bad = await other.client.call('POST', '/organizations', { id: 'x', type: 'banque', legalName: '', phone: '12', commune: '' });
		expect(bad).toMatchObject({ status: 400, body: { code: 'VALIDATION_ERROR' } });
		// Le premier directeur reste seul membre de son organisation.
		expect((await org.director.call<unknown[]>('GET', '/organization/members')).body).toHaveLength(1);
	});
});

describe('cloisonnement par l’API', () => {
	let a: Org;
	let b: Org;
	let bManager: Member;

	beforeAll(async () => {
		a = await createOrg(t, 'agency', 'Agence A');
		b = await createOrg(t, 'agency', 'Agence B');
		bManager = await addMember(t, b, 'manager');
	});

	it('un membre de A ne lit ni ne modifie B, quelle que soit la route', async () => {
		const routes: [string, string, unknown?][] = [
			['GET', '/organization'],
			['PATCH', '/organization', { commune: 'Saaba' }],
			['GET', '/organization/members'],
			['PATCH', `/organization/members/${bManager.memberId}`, { role: 'viewer' }],
			['DELETE', `/organization/members/${bManager.memberId}`],
			['GET', '/organization/invitations'],
			['POST', '/organization/invitations', { phone: newPhone(), role: 'manager' }],
			['GET', '/organization/audit']
		];
		for (const [method, path, body] of routes) {
			const r = await a.director.call(method, path, body, b.id);
			expect(r, `${method} ${path}`).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
		}
		// B est intact.
		expect((await b.director.call('GET', '/organization')).body).toMatchObject({ legalName: 'Agence B', commune: 'Ouagadougou' });
		expect((await b.director.call<unknown[]>('GET', '/organization/members')).body).toHaveLength(2);
	});

	it('dans son propre contexte, A ne peut pas atteindre un membre de B par son identifiant', async () => {
		expect((await a.director.call('PATCH', `/organization/members/${bManager.memberId}`, { role: 'viewer' })).status).toBe(404);
		expect((await a.director.call('DELETE', `/organization/members/${bManager.memberId}`)).status).toBe(404);
		expect((await bManager.call('GET', '/organization')).status).toBe(200);
	});

	it('sans en-tête, ou avec un identifiant invalide, aucune organisation n’est ouverte', async () => {
		expect((await a.director.client.call('GET', '/organization')).body).toMatchObject({ code: 'ORGANIZATION_REQUIRED' });
		expect((await a.director.call('GET', '/organization', undefined, 'pas-un-uuid')).body).toMatchObject({ code: 'ORGANIZATION_REQUIRED' });
		expect((await a.director.call('GET', '/organization', undefined, newId())).body).toMatchObject({ code: 'NOT_A_MEMBER' });
	});

	it('le journal de A ne contient aucun événement de B', async () => {
		const page = await a.director.call<{ entries: { action: string; objectId: string }[] }>('GET', '/organization/audit');
		expect(page.body.entries.length).toBeGreaterThan(0);
		expect(page.body.entries.some((e) => e.objectId === b.id || e.objectId === bManager.memberId)).toBe(false);
	});
});

describe('cloisonnement en SQL (app_api, sans BYPASSRLS)', () => {
	let a: Org;
	let b: Org;
	let bManager: Member;
	let bInvitation: string;
	let bLogo: string;

	beforeAll(async () => {
		a = await createOrg(t, 'agency', 'SQL A');
		b = await createOrg(t, 'agency', 'SQL B');
		bManager = await addMember(t, b, 'manager');
		bInvitation = (
			await b.director.call<{ invitation: { id: string } }>('POST', '/organization/invitations', { phone: newPhone(), role: 'viewer' })
		).body.invitation.id;
		// Un logo de B, inséré dans le contexte de B (le fichier n'est pas nécessaire ici).
		bLogo = newId();
		await inContextCommit(owner, b.id, async () => {
			await owner.query(
				`insert into organization_logos (id, organization_id, original_key, original_mime, original_bytes, created_by) values ($1, $2, $3, 'image/png', 10, $4)`,
				[bLogo, b.id, `logos/${b.id}/${bLogo}/original`, b.director.userId]
			);
		});
	});

	const tables = ['organizations', 'organization_members', 'organization_invitations', 'organization_logos', 'audit_log'];

	it('sans app.organization_id, aucune table cloisonnée ne renvoie de ligne', async () => {
		await inContext(sql, {}, async () => {
			for (const table of tables) expect((await sql.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
		});
	});

	it('dans le contexte de A, aucune ligne de B n’est visible', async () => {
		await inContext(sql, { organizationId: a.id }, async () => {
			expect((await sql.query('select id from organizations')).rows).toEqual([{ id: a.id }]);
			expect((await sql.query('select count(*)::int as n from organization_members where organization_id = $1', [b.id])).rows[0].n).toBe(0);
			expect((await sql.query('select count(*)::int as n from organization_invitations where id = $1', [bInvitation])).rows[0].n).toBe(0);
			expect((await sql.query('select count(*)::int as n from organization_logos where id = $1', [bLogo])).rows[0].n).toBe(0);
			expect((await sql.query('select count(*)::int as n from audit_log where organization_id = $1', [b.id])).rows[0].n).toBe(0);
			for (const table of tables) {
				const column = table === 'organizations' ? 'id' : 'organization_id';
				expect((await sql.query(`select count(*)::int as n from ${table} where ${column} <> $1`, [a.id])).rows[0].n, table).toBe(0);
			}
		});
	});

	it('dans le contexte de A, aucune ligne de B ne se modifie', async () => {
		await inContext(sql, { organizationId: a.id }, async () => {
			expect((await sql.query(`update organizations set commune = 'Piratée' where id = $1`, [b.id])).rowCount).toBe(0);
			expect((await sql.query(`update organization_members set role = 'director' where id = $1`, [bManager.memberId])).rowCount).toBe(0);
			expect((await sql.query(`update organization_invitations set revoked_at = now() where id = $1`, [bInvitation])).rowCount).toBe(0);
			expect((await sql.query(`update organization_logos set status = 'failed' where id = $1`, [bLogo])).rowCount).toBe(0);
		});
		expect((await b.director.call('GET', '/organization')).body).toMatchObject({ commune: 'Ouagadougou' });
	});

	it('dans le contexte de A, aucune ligne ne s’écrit pour B ni ne référence B', async () => {
		await inContext(sql, { organizationId: a.id }, async () => {
			const rls = '42501';
			expect(
				(
					await sqlError(sql, `insert into organization_members (id, organization_id, user_id, role) values ($1, $2, $3, 'director')`, [
						newId(),
						b.id,
						a.director.userId
					])
				).code
			).toBe(rls);
			expect(
				(
					await sqlError(
						sql,
						`insert into organization_invitations (id, organization_id, phone, role, token_hash, invited_by, expires_at) values ($1, $2, '+22670000000', 'manager', '\\x01', $3, now())`,
						[newId(), b.id, a.director.userId]
					)
				).code
			).toBe(rls);
			expect(
				(
					await sqlError(
						sql,
						`insert into organization_logos (id, organization_id, original_key, original_mime, original_bytes, created_by) values ($1, $2, 'k', 'image/png', 1, $3)`,
						[newId(), b.id, a.director.userId]
					)
				).code
			).toBe(rls);
			expect(
				(
					await sqlError(
						sql,
						`insert into audit_log (id, actor_type, organization_id, action, object_type, origin) values ($1, 'system', $2, 'x.y', 'x', 'api')`,
						[newId(), b.id]
					)
				).code
			).toBe(rls);
			expect(
				(
					await sqlError(
						sql,
						`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, 'agency', 'Intruse', '+22670000000', 'Ouaga', $2)`,
						[newId(), a.director.userId]
					)
				).code
			).toBe(rls);
			// Clé composite : A ne peut pas prendre le logo de B.
			expect((await sqlError(sql, `update organizations set logo_id = $1 where id = $2`, [bLogo, a.id])).code).toBe('23503');
		});
	});

	it('app_api ne supprime rien : organisations, membres, invitations, logos, journal', async () => {
		await inContext(sql, { organizationId: a.id }, async () => {
			for (const table of tables) expect((await sqlError(sql, `delete from ${table}`)).code, table).toBe('42501');
		});
	});

	it('contexte personnel : ses propres appartenances et organisations, rien d’autre', async () => {
		await inContext(sql, { userId: bManager.userId }, async () => {
			expect((await sql.query('select organization_id from organization_members')).rows).toEqual([{ organization_id: b.id }]);
			expect((await sql.query('select id from organizations')).rows).toEqual([{ id: b.id }]);
			expect((await sql.query('select count(*)::int as n from organization_invitations')).rows[0].n).toBe(0);
			// Les événements d'organisation ne sont jamais visibles en contexte personnel.
			expect((await sql.query('select count(*)::int as n from audit_log where organization_id is not null')).rows[0].n).toBe(0);
		});
	});

	it('les deux contextes à la fois n’ouvrent rien de plus que l’organisation', async () => {
		await inContext(sql, { organizationId: a.id, userId: bManager.userId }, async () => {
			expect((await sql.query('select id from organizations')).rows).toEqual([{ id: a.id }]);
			expect((await sql.query('select count(*)::int as n from organization_members where organization_id = $1', [b.id])).rows[0].n).toBe(0);
		});
	});
});

/** Écrit dans le contexte d'une organisation avec le propriétaire du schéma (RLS forcée : il y est soumis aussi). */
async function inContextCommit(c: pg.Client, organizationId: string, fn: () => Promise<void>): Promise<void> {
	await c.query('BEGIN');
	try {
		await c.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
		await fn();
		await c.query('COMMIT');
	} catch (error) {
		await c.query('ROLLBACK');
		throw error;
	}
}

describe('matrice de permissions, par l’API', () => {
	let org: Org;
	const members = {} as Record<OrganizationRole, Member>;

	beforeAll(async () => {
		org = await createOrg(t, 'agency', 'Agence matrice');
		members.director = org.director;
		for (const role of ['manager', 'field_agent', 'viewer'] as const) members[role] = await addMember(t, org, role);
	});

	/** Requête qui exerce l'action ; les identifiants inexistants n'ont aucun effet (404 si la permission passe). */
	const requests: Partial<Record<Action, [string, string, unknown?]>> = {
		'organization.read': ['GET', '/organization'],
		'organization.update': ['PATCH', '/organization', { poBox: '01 BP 1234 Ouagadougou 01' }],
		'member.read': ['GET', '/organization/members'],
		'member.invite': ['GET', '/organization/invitations'],
		'member.change_role': ['PATCH', `/organization/members/${newId()}`, { role: 'viewer' }],
		'member.remove': ['DELETE', `/organization/members/${newId()}`],
		'invitation.revoke': ['DELETE', `/organization/invitations/${newId()}`],
		'audit.read': ['GET', '/organization/audit']
	};

	for (const action of ACTIONS.filter((a) => requests[a])) {
		for (const role of ORGANIZATION_ROLES) {
			const allowed = can(role, action);
			it(`${action} : ${allowed ? 'autorisé' : 'refusé'} pour ${role}`, async () => {
				const [method, path, body] = requests[action]!;
				const r = await members[role].call(method, path, body);
				// Autorisé : la permission passe (404 pour un identifiant inexistant, sans effet).
				if (allowed) expect([200, 201, 204, 404], JSON.stringify(r.body)).toContain(r.status);
				else expect(r).toMatchObject({ status: 403, body: { code: 'FORBIDDEN_ACTION', details: { action } } });
			});
		}
	}

	it('chaque action du lot avec un endpoint est couverte', () => {
		expect(Object.keys(requests).sort()).toEqual(
			[
				'organization.read',
				'organization.update',
				'member.read',
				'member.invite',
				'member.change_role',
				'member.remove',
				'invitation.revoke',
				'audit.read'
			].sort()
		);
	});

	it('l’invitation (POST) suit la même permission que la liste des invitations', async () => {
		for (const role of ['manager', 'field_agent', 'viewer'] as const) {
			expect((await members[role].call('POST', '/organization/invitations', { phone: newPhone(), role: 'viewer' })).body).toMatchObject({
				code: 'FORBIDDEN_ACTION'
			});
		}
	});
});

describe('équipe', () => {
	it('un membre retiré perd l’accès immédiatement, avec le même jeton d’accès', async () => {
		const org = await createOrg(t);
		const manager = await addMember(t, org, 'manager');
		expect((await manager.call('GET', '/organization')).status).toBe(200);
		expect((await org.director.call('DELETE', `/organization/members/${manager.memberId}`)).status).toBe(204);
		expect((await manager.call('GET', '/organization')).body).toMatchObject({ code: 'NOT_A_MEMBER' });
		expect((await manager.client.call<unknown[]>('GET', '/me/organizations')).body).toEqual([]);
		expect((await org.director.call<unknown[]>('GET', '/organization/members')).body).toHaveLength(1);
	});

	it('changement de rôle : la permission suit le nouveau rôle à la requête suivante', async () => {
		const org = await createOrg(t);
		const viewer = await addMember(t, org, 'viewer');
		expect((await viewer.call('GET', '/organization/members')).status).toBe(403);
		const changed = await org.director.call<{ id: string; role: string }[]>('PATCH', `/organization/members/${viewer.memberId}`, {
			role: 'manager'
		});
		expect(changed.body.find((m) => m.id === viewer.memberId)?.role).toBe('manager');
		expect((await viewer.call('GET', '/organization/members')).status).toBe(200);
	});

	it('le dernier directeur ne peut ni partir ni se rétrograder ; avec un second directeur, si', async () => {
		const org = await createOrg(t);
		expect((await org.director.call('DELETE', `/organization/members/${org.director.memberId}`)).body).toMatchObject({
			code: 'LAST_DIRECTOR'
		});
		expect((await org.director.call('PATCH', `/organization/members/${org.director.memberId}`, { role: 'manager' })).body).toMatchObject({
			code: 'LAST_DIRECTOR'
		});
		const second = await addMember(t, org, 'director');
		expect((await org.director.call('PATCH', `/organization/members/${org.director.memberId}`, { role: 'manager' })).status).toBe(200);
		expect((await second.call('DELETE', `/organization/members/${second.memberId}`)).body).toMatchObject({ code: 'LAST_DIRECTOR' });
	});

	it('le dernier directeur est aussi protégé par la base (trigger)', async () => {
		const org = await createOrg(t);
		await inContext(sql, { organizationId: org.id }, async () => {
			const e = await sqlError(sql, `update organization_members set status = 'removed', removed_at = now() where id = $1`, [
				org.director.memberId
			]);
			expect(e.message).toContain('LAST_DIRECTOR');
		});
	});
});

describe('une personne dans deux organisations', () => {
	it('ne voit que l’organisation active, jamais les deux à la fois', async () => {
		const agency = await createOrg(t, 'agency', 'Agence double');
		const person = await signedUp(t);
		const asManager = await addMember(t, agency, 'manager', person);
		const id = newId();
		expect(
			(
				await person.client.call('POST', '/organizations', {
					id,
					type: 'landlord',
					legalName: 'Mes logements',
					phone: person.phone,
					commune: 'Saaba'
				})
			).status
		).toBe(201);
		const mine = await person.client.call<{ organizationId: string; role: string }[]>('GET', '/me/organizations');
		expect(mine.body.map((m) => m.organizationId).sort()).toEqual([agency.id, id].sort());

		const inAgency = await asManager.call<{ id: string }>('GET', '/organization');
		const inLandlord = await asManager.call<{ id: string }>('GET', '/organization', undefined, id);
		expect(inAgency.body.id).toBe(agency.id);
		expect(inLandlord.body.id).toBe(id);
		const landlordMembers = await asManager.call<{ userId: string }[]>('GET', '/organization/members', undefined, id);
		expect(landlordMembers.body.map((m) => m.userId)).toEqual([asManager.userId]);
		// Le journal du bailleur ne montre rien de l'agence.
		const audit = await asManager.call<{ entries: { objectId: string }[] }>('GET', '/organization/audit', undefined, id);
		expect(audit.body.entries.some((e) => e.objectId === agency.id)).toBe(false);
	});
});

describe('bailleur particulier', () => {
	it('refuse l’invitation d’un second membre', async () => {
		const org = await createOrg(t, 'landlord');
		expect((await org.director.call('POST', '/organization/invitations', { phone: newPhone(), role: 'manager' })).body).toMatchObject({
			code: 'LANDLORD_SINGLE_MEMBER'
		});
	});

	it('la base refuse aussi une invitation ou un second membre', async () => {
		const org = await createOrg(t, 'landlord');
		const other = await signedUp(t);
		const otherId = ((await other.client.call('GET', '/me')).body as { id: string }).id;
		await inContext(sql, { organizationId: org.id }, async () => {
			expect(
				(
					await sqlError(
						sql,
						`insert into organization_invitations (id, organization_id, phone, role, token_hash, invited_by, expires_at) values ($1, $2, '+22670000000', 'manager', '\\x02', $3, now())`,
						[newId(), org.id, org.director.userId]
					)
				).message
			).toContain('LANDLORD_SINGLE_MEMBER');
			expect(
				(
					await sqlError(sql, `insert into organization_members (id, organization_id, user_id, role) values ($1, $2, $3, 'director')`, [
						newId(),
						org.id,
						otherId
					])
				).message
			).toContain('LANDLORD_SINGLE_MEMBER');
		});
	});

	it('le bailleur reste directeur', async () => {
		const org = await createOrg(t, 'landlord');
		expect((await org.director.call('PATCH', `/organization/members/${org.director.memberId}`, { role: 'manager' })).body).toMatchObject({
			code: 'LANDLORD_SINGLE_MEMBER'
		});
	});
});

describe('invitations', () => {
	let org: Org;
	beforeAll(async () => {
		org = await createOrg(t, 'agency', 'Agence invitante');
	});

	async function invite(phone = newPhone(), role: OrganizationRole = 'manager') {
		const r = await org.director.call<{ token: string; invitation: { id: string } }>('POST', '/organization/invitations', { phone, role });
		expect(r.status).toBe(201);
		return { phone, token: r.body.token, id: r.body.invitation.id };
	}

	it('l’aperçu montre l’organisation, le rôle et un numéro masqué, sans connexion', async () => {
		const inv = await invite('+22670123456');
		const r = await fetch(`${t.url}/invitations/${inv.token}`);
		expect(r.status).toBe(200);
		expect(await r.json()).toMatchObject({
			organizationName: 'Agence invitante',
			organizationType: 'agency',
			role: 'manager',
			phone: '+226 70 •• •• 56'
		});
	});

	it('ne garde que l’empreinte du lien', async () => {
		const inv = await invite();
		await inContext(sql, { organizationId: org.id }, async () => {
			const row = (await sql.query('select token_hash from organization_invitations where id = $1', [inv.id])).rows[0];
			expect(row.token_hash).toHaveLength(32);
			expect(row.token_hash.toString('utf8')).not.toContain(inv.token.split('.')[1]);
		});
	});

	it('acceptée une fois ; le second usage est refusé', async () => {
		const person = await signedUp(t);
		const inv = await invite(person.phone);
		expect((await person.client.call('POST', `/invitations/${inv.token}/accept`)).status).toBe(200);
		expect((await person.client.call('POST', `/invitations/${inv.token}/accept`)).body).toMatchObject({ code: 'INVITATION_INVALID' });
		expect((await fetch(`${t.url}/invitations/${inv.token}`)).status).toBe(410);
	});

	it('expirée : refusée', async () => {
		const person = await signedUp(t);
		const inv = await invite(person.phone);
		await inContextCommit(owner, org.id, async () => {
			await owner.query(`update organization_invitations set expires_at = now() - interval '1 minute' where id = $1`, [inv.id]);
		});
		expect((await person.client.call('POST', `/invitations/${inv.token}/accept`)).body).toMatchObject({ code: 'INVITATION_INVALID' });
	});

	it('révoquée : refusée ; une nouvelle invitation remplace la précédente', async () => {
		const person = await signedUp(t);
		const first = await invite(person.phone);
		const second = await invite(person.phone);
		expect((await person.client.call('POST', `/invitations/${first.token}/accept`)).body).toMatchObject({ code: 'INVITATION_INVALID' });
		expect((await org.director.call('DELETE', `/organization/invitations/${second.id}`)).status).toBe(204);
		expect((await person.client.call('POST', `/invitations/${second.token}/accept`)).body).toMatchObject({ code: 'INVITATION_INVALID' });
	});

	it('un lien transféré à un autre numéro ne sert à rien', async () => {
		const inv = await invite();
		const stranger = await signedUp(t);
		expect((await stranger.client.call('POST', `/invitations/${inv.token}/accept`)).body).toMatchObject({ code: 'INVITATION_OTHER_PHONE' });
	});

	it('un lien altéré ou d’une autre organisation est refusé', async () => {
		const inv = await invite();
		const [orgId, secret] = inv.token.split('.');
		expect((await fetch(`${t.url}/invitations/${orgId}.${secret!.slice(0, -2)}xx`)).status).toBe(410);
		expect((await fetch(`${t.url}/invitations/${newId()}.${secret}`)).status).toBe(410);
		expect((await fetch(`${t.url}/invitations/n-importe-quoi`)).status).toBe(410);
	});

	it('un membre déjà actif n’est pas réinvité ; un membre retiré peut revenir', async () => {
		const manager = await addMember(t, org, 'manager');
		expect((await org.director.call('POST', '/organization/invitations', { phone: manager.phone, role: 'viewer' })).body).toMatchObject({
			code: 'ALREADY_MEMBER'
		});
		await org.director.call('DELETE', `/organization/members/${manager.memberId}`);
		const back = await addMember(t, org, 'viewer', { client: manager.client, phone: manager.phone });
		expect(back.memberId).toBe(manager.memberId);
		expect((await back.call<{ role: string }>('GET', '/organization')).status).toBe(200);
	});
});

describe('paramètres de l’organisation', () => {
	it('le directeur modifie la fiche, les identifiants et le représentant légal ; le journal garde avant et après', async () => {
		const org = await createOrg(t, 'agency', 'Agence paramètres');
		const r = await org.director.call('PATCH', '/organization', {
			tradeName: 'Paramètres Immo',
			poBox: '01 BP 1234 Ouagadougou 01',
			rccm: 'bf oua 2020 b 4321',
			ifu: '00012345a',
			representative: {
				name: 'Awa Ouédraogo',
				title: 'Gérante',
				idType: 'other',
				idTypeOther: 'Carte d’électeur',
				idNumber: 'B123',
				idIssuedOn: '2022-05-10'
			}
		});
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			tradeName: 'Paramètres Immo',
			rccm: 'BF OUA 2020 B 4321',
			ifu: '00012345A',
			representative: {
				name: 'Awa Ouédraogo',
				title: 'Gérante',
				idType: 'other',
				idTypeOther: 'Carte d’électeur',
				idIssuedOn: '2022-05-10',
				profession: null
			}
		});
		const audit = await org.director.call<{
			entries: { action: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
		}>('GET', '/organization/audit');
		const update = audit.body.entries.find((e) => e.action === 'organization.update')!;
		expect(update.before).toMatchObject({ tradeName: null, rccm: null });
		expect(update.after).toMatchObject({ tradeName: 'Paramètres Immo', rccm: 'BF OUA 2020 B 4321' });
		expect(Object.keys(update.after).sort()).toEqual(['ifu', 'poBox', 'rccm', 'representative', 'tradeName']);
	});

	it('une modification sans changement n’écrit rien', async () => {
		const org = await createOrg(t);
		const before = (await org.director.call<{ entries: unknown[] }>('GET', '/organization/audit')).body.entries.length;
		await org.director.call('PATCH', '/organization', { commune: 'Ouagadougou' });
		expect((await org.director.call<{ entries: unknown[] }>('GET', '/organization/audit')).body.entries).toHaveLength(before);
	});

	it('« Autre » pièce d’identité sans précision est refusé', async () => {
		const org = await createOrg(t);
		expect((await org.director.call('PATCH', '/organization', { representative: { idType: 'other' } })).status).toBe(400);
	});
});
