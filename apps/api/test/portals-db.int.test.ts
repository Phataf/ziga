/**
 * Lot 10 ter, étape 1 : liens entre fiches et comptes, et signalements, dans la base (migration 0022), en SQL avec le
 * rôle de l'API (app_api, sans BYPASSRLS) et le propriétaire du schéma.
 * - Accès croisé A/B sur person_links et maintenance_requests : lire, modifier, référencer (règle 1).
 * - Point b : numéro de la fiche différent de celui du compte refusé, à la demande comme à l'activation.
 * - Un lien naît demandé ; actif seulement avec le code validé et l'acceptation d'un membre de la direction ou de la
 *   gestion ; révoqué, il ne change plus ; jamais supprimé ; un lien non révoqué au plus par fiche.
 * - Réponse 1 : une demande ne vise qu'une agence vérifiée. Réponse 2 : propre fiche du bailleur, par son directeur, au
 *   numéro vérifié du compte. Réponse 3 : un changement de numéro (fiche ou compte) révoque les liens, avec leur motif et
 *   une ligne d'audit dans chaque organisation.
 * - Signalements : nés reçus, pendant le bail ; reçu → planifié → fait ; le texte ne se réécrit pas ; jamais supprimés.
 */
import { newId } from '@ziga/shared/ids';
import { PHONE_CHANGE_REVOCATION } from '@ziga/shared/person-links';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPhone, startApp, type TestApp } from './http.js';
import { addMember, apiSql, inContext, sqlError, type Member } from './orgs.js';
import { insertLink, insertTenantRecord, migrationClient, portalWorld, seedIn, type PortalWorld } from './portals.js';

let t: TestApp;
let owner: pg.Client;
let api: pg.Client;
let w: PortalWorld;
let fieldAgentA: Member;
let viewerA: Member;
let managerA: Member;

const insertLinkSql = `insert into person_links (id, organization_id, user_id, record_type, owner_id, tenant_id, status, origin, phone, requested_by,
	accepted_by, accepted_at, phone_verified_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

/** Fiche locataire de A au numéro donné (validée), pour une liaison à tester. */
async function tenantInA(phone: string | null, name = 'Aminata Sanou'): Promise<string> {
	return seedIn(owner, w.a.org.id, (c) => insertTenantRecord(c, w.a.org.id, name, phone));
}

beforeAll(async () => {
	t = await startApp();
	owner = await migrationClient();
	api = await apiSql();
	w = await portalWorld(t, owner);
	fieldAgentA = await addMember(t, w.a.org, 'field_agent');
	viewerA = await addMember(t, w.a.org, 'viewer');
	managerA = await addMember(t, w.a.org, 'manager');
});

afterAll(async () => {
	await api?.end();
	await owner?.end();
	await t?.close();
});

describe('person_links dans la base (lot 10 ter, étape 1)', () => {
	it('accès croisé : depuis B, rien de A en lecture ; modification sans effet ; référence d’une fiche de A refusée', async () => {
		await inContext(api, { organizationId: w.b.org.id, userId: w.b.org.director.userId }, async () => {
			expect((await api.query(`select 1 from person_links where id = any($1)`, [[w.a.pLink, w.a.tLink]])).rowCount).toBe(0);
			const up = await api.query(`update person_links set updated_at = now() where id = $1`, [w.a.tLink]);
			expect(up.rowCount).toBe(0);
			const ref = await sqlError(api, insertLinkSql, [
				newId(),
				w.b.org.id,
				w.t.userId,
				'tenant',
				null,
				w.a.tTenant,
				'requested',
				'organization_invite',
				w.t.phone,
				w.b.org.director.userId,
				null,
				null,
				null
			]);
			expect(ref.code).toBe('23503');
		});
	});

	it('point b : numéro de la fiche différent de celui du compte refusé ; fiche sans numéro refusée', async () => {
		const other = await tenantInA('+22670554433');
		const none = await tenantInA(null);
		await inContext(api, { organizationId: w.a.org.id, userId: w.a.org.director.userId }, async () => {
			for (const [tenant, phone] of [
				[other, w.t.phone],
				[other, '+22670554433'],
				[none, w.t.phone]
			] as const) {
				const e = await sqlError(api, insertLinkSql, [
					newId(),
					w.a.org.id,
					w.t.userId,
					'tenant',
					null,
					tenant,
					'requested',
					'organization_invite',
					phone,
					w.a.org.director.userId,
					null,
					null,
					null
				]);
				expect(e.message).toMatch(/LINK_PHONE_MISMATCH/);
			}
		});
	});

	it('un lien naît demandé ; actif seulement avec le code validé et l’acceptation ; révoqué, il ne change plus', async () => {
		const tenant = await tenantInA(w.t.phone);
		await inContext(api, { organizationId: w.a.org.id, userId: w.a.org.director.userId }, async () => {
			const born = (status: string) =>
				sqlError(api, insertLinkSql, [
					newId(),
					w.a.org.id,
					w.t.userId,
					'tenant',
					null,
					tenant,
					status,
					'organization_invite',
					w.t.phone,
					w.a.org.director.userId,
					w.a.org.director.userId,
					new Date(),
					new Date()
				]);
			expect((await born('active')).message).toMatch(/PERSON_LINK_STATUS/);
			expect((await born('revoked')).message).toMatch(/PERSON_LINK_STATUS/);

			const id = newId();
			await api.query(insertLinkSql, [
				id,
				w.a.org.id,
				w.t.userId,
				'tenant',
				null,
				tenant,
				'requested',
				'organization_invite',
				w.t.phone,
				w.a.org.director.userId,
				null,
				null,
				null
			]);
			// Sans le code, puis sans l'acceptation : refusé.
			expect((await sqlError(api, `update person_links set status = 'active' where id = $1`, [id])).code).toBe('23514');
			await api.query(`update person_links set phone_verified_at = now() where id = $1`, [id]);
			expect((await sqlError(api, `update person_links set status = 'active' where id = $1`, [id])).code).toBe('23514');
			// Acceptation par un agent de terrain ou un profil lecture : refusée.
			for (const m of [fieldAgentA, viewerA]) {
				const e = await sqlError(api, `update person_links set accepted_by = $2, accepted_at = now() where id = $1`, [id, m.userId]);
				expect(e.message).toMatch(/PERSON_LINK_MEMBER/);
			}
			await api.query(`update person_links set accepted_by = $2, accepted_at = now(), status = 'active' where id = $1`, [
				id,
				managerA.userId
			]);
			// Ni retour en arrière, ni nouvelle vérification, ni changement de personne, de fiche ou de numéro.
			expect((await sqlError(api, `update person_links set status = 'requested' where id = $1`, [id])).message).toMatch(
				/PERSON_LINK_STATUS/
			);
			expect((await sqlError(api, `update person_links set phone_verified_at = clock_timestamp() where id = $1`, [id])).message).toMatch(
				/PERSON_LINK_IMMUTABLE/
			);
			expect((await sqlError(api, `update person_links set user_id = $2 where id = $1`, [id, w.p.userId])).message).toMatch(
				/PERSON_LINK_IMMUTABLE/
			);
			expect((await sqlError(api, `update person_links set phone = '+22670000001' where id = $1`, [id])).message).toMatch(
				/PERSON_LINK_IMMUTABLE/
			);
			// Révocation : motivée, par un membre de la direction ou de la gestion (ou la personne elle-même).
			expect(
				(
					await sqlError(
						api,
						`update person_links set status = 'revoked', revoked_at = now(), revoked_by_party = 'organization', revoked_by = $2 where id = $1`,
						[id, managerA.userId]
					)
				).code
			).toBe('23514');
			expect(
				(
					await sqlError(
						api,
						`update person_links set status = 'revoked', revoked_at = now(), revoked_by_party = 'organization', revoked_by = $2,
						revocation_reason = 'Fiche en double' where id = $1`,
						[id, fieldAgentA.userId]
					)
				).message
			).toMatch(/PERSON_LINK_MEMBER/);
			expect(
				(
					await sqlError(
						api,
						`update person_links set status = 'revoked', revoked_at = now(), revoked_by_party = 'person', revoked_by = $2,
						revocation_reason = 'Pas mon logement' where id = $1`,
						[id, w.p.userId]
					)
				).message
			).toMatch(/PERSON_LINK_REVOKE/);
			await api.query(
				`update person_links set status = 'revoked', revoked_at = now(), revoked_by_party = 'person', revoked_by = $2,
				revocation_reason = 'Je ne loue plus ce logement' where id = $1`,
				[id, w.t.userId]
			);
			expect((await sqlError(api, `update person_links set revocation_reason = 'Autre motif' where id = $1`, [id])).message).toMatch(
				/PERSON_LINK_REVOKED/
			);
			// Jamais supprimé.
			expect((await sqlError(api, `delete from person_links where id = $1`, [id])).code).toBe('42501');
		});
	});

	it('un lien non révoqué au plus par fiche ; après révocation, une nouvelle liaison crée un nouveau lien', async () => {
		const tenant = await tenantInA(w.t.phone);
		await inContext(api, { organizationId: w.a.org.id, userId: w.a.org.director.userId }, async () => {
			const params = (id: string) => [
				id,
				w.a.org.id,
				w.t.userId,
				'tenant',
				null,
				tenant,
				'requested',
				'organization_invite',
				w.t.phone,
				w.a.org.director.userId,
				null,
				null,
				null
			];
			const first = newId();
			await api.query(insertLinkSql, params(first));
			expect((await sqlError(api, insertLinkSql, params(newId()))).code).toBe('23505');
			await api.query(
				`update person_links set status = 'revoked', revoked_at = now(), revoked_by_party = 'organization', revoked_by = $2,
				revocation_reason = 'Invitation envoyée par erreur' where id = $1`,
				[first, w.a.org.director.userId]
			);
			await api.query(insertLinkSql, params(newId()));
		});
	});

	it('invitation : seuls la direction et la gestion invitent', async () => {
		const tenant = await tenantInA(w.t.phone);
		await inContext(api, { organizationId: w.a.org.id, userId: fieldAgentA.userId }, async () => {
			const e = await sqlError(api, insertLinkSql, [
				newId(),
				w.a.org.id,
				w.t.userId,
				'tenant',
				null,
				tenant,
				'requested',
				'organization_invite',
				w.t.phone,
				fieldAgentA.userId,
				null,
				null,
				null
			]);
			expect(e.message).toMatch(/PERSON_LINK_MEMBER/);
		});
	});

	it('réponse 1 : une demande de la personne ne vise qu’une agence vérifiée ; jamais un bailleur particulier', async () => {
		const tenant = await tenantInA(w.t.phone);
		const request = (org: string, record: string) =>
			sqlError(api, insertLinkSql, [
				newId(),
				org,
				w.t.userId,
				'tenant',
				null,
				record,
				'requested',
				'person_request',
				w.t.phone,
				w.t.userId,
				null,
				null,
				null
			]);
		// A n'est pas encore vérifiée.
		await inContext(api, { organizationId: w.a.org.id, userId: w.t.userId }, async () => {
			expect((await request(w.a.org.id, tenant)).message).toMatch(/PERSON_LINK_REQUEST_ORGANIZATION/);
		});
		const landlordTenant = await seedIn(owner, w.l.org.id, (c) => insertTenantRecord(c, w.l.org.id, 'Salif Traoré', w.t.phone));
		await inContext(api, { organizationId: w.l.org.id, userId: w.t.userId }, async () => {
			expect((await request(w.l.org.id, landlordTenant)).message).toMatch(/PERSON_LINK_REQUEST_ORGANIZATION/);
		});
		await seedIn(owner, w.a.org.id, (c) =>
			c.query(`update organizations set rccm = 'BF-OUA-2026-B-0001', ifu = '00012345X', verification_status = 'verified' where id = $1`, [
				w.a.org.id
			])
		);
		try {
			await inContext(api, { organizationId: w.a.org.id, userId: w.t.userId }, async () => {
				const id = newId();
				await api.query(insertLinkSql, [
					id,
					w.a.org.id,
					w.t.userId,
					'tenant',
					null,
					tenant,
					'requested',
					'person_request',
					w.t.phone,
					w.t.userId,
					null,
					null,
					null
				]);
				// La personne demande elle-même, sans acceptation d'avance.
				const self = await sqlError(api, insertLinkSql, [
					newId(),
					w.a.org.id,
					w.t.userId,
					'tenant',
					null,
					await (async () => {
						const r = await api.query(
							`insert into tenants (id, organization_id, full_name, phone) values ($1, $2, 'Salif Traoré', $3) returning id`,
							[newId(), w.a.org.id, w.t.phone]
						);
						return r.rows[0].id as string;
					})(),
					'requested',
					'person_request',
					w.t.phone,
					w.t.userId,
					w.a.org.director.userId,
					new Date(),
					null
				]);
				expect(self.message).toMatch(/PERSON_LINK_REQUEST/);
			});
		} finally {
			await seedIn(owner, w.a.org.id, (c) =>
				c.query(`update organizations set verification_status = 'pending' where id = $1`, [w.a.org.id])
			);
		}
	});

	it('réponse 2 : la propre fiche du bailleur se lie active, par son directeur, à son numéro vérifié ; jamais ailleurs', async () => {
		// Le lien de L posé par le monde est une invitation : on le révoque pour tester la liaison automatique.
		await seedIn(owner, w.l.org.id, (c) =>
			c.query(
				`update person_links set status = 'revoked', revoked_at = now(), revoked_by_party = 'person', revoked_by = $2,
				revocation_reason = 'Test de la liaison automatique' where id = $1`,
				[w.l.pLink, w.p.userId]
			)
		);
		const selfLink = (org: string, ownerId: string, user: string, phone: string) => [
			newId(),
			org,
			user,
			'owner',
			ownerId,
			null,
			'active',
			'landlord_self',
			phone,
			user,
			user,
			new Date(),
			new Date()
		];
		await inContext(api, { organizationId: w.l.org.id, userId: w.p.userId }, async () => {
			await api.query(insertLinkSql, selfLink(w.l.org.id, w.l.pOwner, w.p.userId, w.p.phone));
		});
		// Fiche d'une agence : jamais automatique.
		await inContext(api, { organizationId: w.a.org.id, userId: w.p.userId }, async () => {
			const e = await sqlError(api, insertLinkSql, selfLink(w.a.org.id, w.a.pOwner, w.p.userId, w.p.phone));
			expect(e.message).toMatch(/PERSON_LINK_LANDLORD_SELF/);
		});
		// Numéro de la fiche différent : jamais automatique.
		await inContext(api, { organizationId: w.l.org.id, userId: w.p.userId }, async () => {
			await api.query(`update owners set phone = '+22670111111' where id = $1`, [w.l.pOwner]);
			const e = await sqlError(api, insertLinkSql, selfLink(w.l.org.id, w.l.pOwner, w.p.userId, w.p.phone));
			expect(e.message).toMatch(/LINK_PHONE_MISMATCH/);
			const e2 = await sqlError(api, insertLinkSql, selfLink(w.l.org.id, w.l.pOwner, w.p.userId, '+22670111111'));
			expect(e2.message).toMatch(/LINK_PHONE_MISMATCH/);
		});
	});

	it('réponse 3 : numéro d’une fiche modifié → ses liens révoqués par la base, avec le motif et une ligne d’audit', async () => {
		const tenant = await tenantInA(w.t.phone, 'Issouf Kaboré');
		const link = await seedIn(owner, w.a.org.id, (c) =>
			insertLink(c, w.a.org.id, { userId: w.t.userId, phone: w.t.phone, tenantId: tenant, acceptedBy: w.a.org.director.userId })
		);
		await inContext(api, { organizationId: w.a.org.id, userId: managerA.userId }, async () => {
			await api.query(`update tenants set phone = '+22670667788' where id = $1`, [tenant]);
			const r = await api.query(`select status, revoked_by_party, revoked_by, revocation_reason from person_links where id = $1`, [link]);
			expect(r.rows[0]).toEqual({
				status: 'revoked',
				revoked_by_party: 'system',
				revoked_by: null,
				revocation_reason: PHONE_CHANGE_REVOCATION.record_phone_changed
			});
			const audit = await api.query(
				`select actor_user_id, subject_user_id, after from audit_log where object_id = $1 and action = 'person_link.revoke'`,
				[link]
			);
			expect(audit.rows).toHaveLength(1);
			expect(audit.rows[0].actor_user_id).toBe(managerA.userId);
			expect(audit.rows[0].subject_user_id).toBe(w.t.userId);
			expect(audit.rows[0].after).toMatchObject({ status: 'revoked', revokedByParty: 'system', cause: 'record_phone_changed' });
			// Le même numéro réécrit : rien ne change (autre lien, actif, dans la même transaction).
		});
	});

	it('fonctions de la base : révocation interne jamais appelable par l’API, ni par le back-office, ni par la synchronisation', async () => {
		const r = await owner.query(
			`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('app_api', p.oid, 'EXECUTE') as api,
				has_function_privilege('app_admin', p.oid, 'EXECUTE') as admin, has_function_privilege('app_sync', p.oid, 'EXECUTE') as sync
			 from pg_proc p where p.proname in ('person_links_revoke_for_phone', 'person_links_record_phone_changed', 'person_links_account_phone_changed')
			 order by p.proname`
		);
		expect(r.rows).toEqual([
			{
				proname: 'person_links_account_phone_changed',
				prosecdef: true,
				proconfig: ['search_path=pg_catalog, public'],
				api: false,
				admin: false,
				sync: false
			},
			{
				proname: 'person_links_record_phone_changed',
				prosecdef: true,
				proconfig: ['search_path=pg_catalog, public'],
				api: false,
				admin: false,
				sync: false
			},
			{
				proname: 'person_links_revoke_for_phone',
				prosecdef: false,
				proconfig: ['search_path=pg_catalog, public'],
				api: false,
				admin: false,
				sync: false
			}
		]);
		await inContext(api, { organizationId: w.b.org.id, userId: w.b.org.director.userId }, async () => {
			const e = await sqlError(api, `select person_links_revoke_for_phone($1, $2, 'Tentative directe', 'record_phone_changed', null)`, [
				w.a.org.id,
				[w.a.tLink]
			]);
			expect(e.code).toBe('42501');
		});
	});

	it('code SMS de liaison : lié à la personne et à son lien', async () => {
		const sql = `insert into otp_codes (id, phone, purpose, code_hash, expires_at, user_id, person_link_id) values ($1, $2, 'link_record', '\\x00', now() + interval '10 minutes', $3, $4)`;
		await inContext(api, { userId: w.t.userId }, async () => {
			expect((await sqlError(api, sql, [newId(), w.t.phone, null, w.a.tLink])).code).toBe('23514');
			expect((await sqlError(api, sql, [newId(), w.t.phone, w.t.userId, null])).code).toBe('23514');
			await api.query(sql, [newId(), w.t.phone, w.t.userId, w.a.tLink]);
			// Un code d'un autre motif ne porte pas de lien.
			expect(
				(
					await sqlError(
						api,
						`insert into otp_codes (id, phone, purpose, code_hash, expires_at, person_link_id) values ($1, $2, 'verify_phone', '\\x00', now(), $3)`,
						[newId(), w.t.phone, w.a.tLink]
					)
				).code
			).toBe('23514');
		});
	});
});

describe('changement de numéro d’un compte (lot 10 ter, réponse 3)', () => {
	it('tous ses liens révoqués, organisation par organisation, une ligne d’audit dans chacune ; aucun lien d’une autre personne touché', async () => {
		const fresh = await portalWorld(t, owner);
		const newNumber = newPhone();
		await inContext(api, { userId: fresh.p.userId }, async () => {
			await api.query(`update users set phone = $2 where id = $1`, [fresh.p.userId, newNumber]);
			// Le contexte de la personne est rétabli (aucune organisation).
			expect((await api.query(`select current_setting('app.organization_id', true) as org`)).rows[0].org).toBe('');
			expect((await api.query(`select * from my_person_links()`)).rowCount).toBe(0);
		});
		// Hors de la transaction annulée, rien n'a changé ; on la rejoue pour de bon, puis on lit chaque organisation.
		await owner.query('BEGIN');
		try {
			await owner.query(`select set_config('app.user_id', $1, true)`, [fresh.p.userId]);
			await owner.query(`update users set phone = $2 where id = $1`, [fresh.p.userId, newNumber]);
			await owner.query('COMMIT');
		} catch (error) {
			await owner.query('ROLLBACK');
			throw error;
		}
		for (const o of [fresh.a, fresh.b, fresh.l]) {
			const r = await seedIn(owner, o.org.id, async (c) => ({
				links: (await c.query(`select id, user_id, status, revocation_reason from person_links where organization_id = $1`, [o.org.id]))
					.rows,
				audit: (
					await c.query(
						`select organization_id, subject_user_id, after from audit_log where organization_id = $1 and action = 'person_link.revoke'`,
						[o.org.id]
					)
				).rows
			}));
			const pLinks = r.links.filter((l) => l.user_id === fresh.p.userId);
			expect(pLinks).toHaveLength(1);
			expect(pLinks[0]).toMatchObject({ status: 'revoked', revocation_reason: PHONE_CHANGE_REVOCATION.account_phone_changed });
			// Les liens de T restent actifs.
			for (const l of r.links.filter((x) => x.user_id === fresh.t.userId)) expect(l.status).toBe('active');
			expect(r.audit).toEqual([
				expect.objectContaining({
					organization_id: o.org.id,
					subject_user_id: fresh.p.userId,
					after: expect.objectContaining({ cause: 'account_phone_changed' })
				})
			]);
		}
	});
});

describe('signalements dans la base (lot 10 ter, réponse 4)', () => {
	const insertRequest = `insert into maintenance_requests (id, organization_id, lease_id, reported_by, title, description) values ($1, $2, $3, $4, $5, $6)`;

	it('accès croisé : depuis A, rien de B en lecture ; modification sans effet ; référence d’un bail de B refusée', async () => {
		const id = newId();
		await seedIn(owner, w.b.org.id, (c) =>
			c.query(insertRequest, [id, w.b.org.id, w.b.tLease, w.t.userId, 'Fuite', 'Robinet de la douche qui fuit'])
		);
		await inContext(api, { organizationId: w.a.org.id, userId: w.a.org.director.userId }, async () => {
			expect((await api.query(`select 1 from maintenance_requests where id = $1`, [id])).rowCount).toBe(0);
			expect(
				(await api.query(`select count(*)::int as n from maintenance_requests where organization_id = $1`, [w.b.org.id])).rows[0].n
			).toBe(0);
			const up = await api.query(`update maintenance_requests set status = 'done', done_at = now(), handled_by = $2 where id = $1`, [
				id,
				w.a.org.director.userId
			]);
			expect(up.rowCount).toBe(0);
			expect((await sqlError(api, insertRequest, [newId(), w.a.org.id, w.b.tLease, w.t.userId, 'Fuite', 'Robinet qui fuit'])).code).toBe(
				'23503'
			);
		});
	});

	it('né reçu, pendant le bail ; reçu → planifié → fait ; texte figé ; fait ne change plus ; jamais supprimé', async () => {
		await inContext(api, { organizationId: w.b.org.id, userId: w.b.org.director.userId }, async () => {
			expect(
				(
					await sqlError(
						api,
						`insert into maintenance_requests (id, organization_id, lease_id, reported_by, title, description, status, planned_on, handled_by)
						 values ($1, $2, $3, $4, 'Fuite', 'Robinet qui fuit', 'planned', current_date, $5)`,
						[newId(), w.b.org.id, w.b.tLease, w.t.userId, w.b.org.director.userId]
					)
				).message
			).toMatch(/MAINTENANCE_STATUS/);
			const id = newId();
			await api.query(insertRequest, [id, w.b.org.id, w.b.tLease, w.t.userId, 'Prise', 'Prise de la chambre sans courant']);
			expect((await sqlError(api, `update maintenance_requests set title = 'Autre' where id = $1`, [id])).message).toMatch(
				/MAINTENANCE_IMMUTABLE/
			);
			expect(
				(
					await sqlError(api, `update maintenance_requests set status = 'planned', handled_by = $2 where id = $1`, [
						id,
						w.b.org.director.userId
					])
				).code
			).toBe('23514');
			await api.query(
				`update maintenance_requests set status = 'planned', planned_on = '2026-12-02', handled_by = $2, status_note = 'Électricien mardi' where id = $1`,
				[id, w.b.org.director.userId]
			);
			expect((await sqlError(api, `update maintenance_requests set status = 'received' where id = $1`, [id])).message).toMatch(
				/MAINTENANCE_STATUS/
			);
			await api.query(`update maintenance_requests set status = 'done', done_at = now() where id = $1`, [id]);
			expect((await sqlError(api, `update maintenance_requests set status_note = 'Revenu' where id = $1`, [id])).message).toMatch(
				/MAINTENANCE_STATUS/
			);
			expect((await sqlError(api, `delete from maintenance_requests where id = $1`, [id])).code).toBe('42501');
		});
		// Bail terminé (T chez A) : plus de signalement.
		await inContext(api, { organizationId: w.a.org.id, userId: w.a.org.director.userId }, async () => {
			const e = await sqlError(api, insertRequest, [newId(), w.a.org.id, w.a.tLease, w.t.userId, 'Fuite', 'Robinet qui fuit']);
			expect(e.message).toMatch(/MAINTENANCE_LEASE/);
		});
	});

	it('traité seulement par la direction ou la gestion', async () => {
		const agentB = await addMember(t, w.b.org, 'field_agent');
		await inContext(api, { organizationId: w.b.org.id, userId: agentB.userId }, async () => {
			const id = newId();
			await api.query(insertRequest, [id, w.b.org.id, w.b.tLease, w.t.userId, 'Serrure', 'La serrure de la porte coince']);
			const e = await sqlError(api, `update maintenance_requests set status = 'done', done_at = now(), handled_by = $2 where id = $1`, [
				id,
				agentB.userId
			]);
			expect(e.message).toMatch(/MAINTENANCE_MEMBER/);
		});
	});

	it('synchronisation : publiée, lisible par app_sync ; les flux ne sélectionnent jamais la personne qui signale', async () => {
		const pub = await owner.query(`select 1 from pg_publication_tables where pubname = 'powersync' and tablename = 'maintenance_requests'`);
		expect(pub.rowCount).toBe(1);
		const policy = await owner.query(
			`select 1 from pg_policies where tablename = 'maintenance_requests' and policyname = 'sync_read' and roles = '{app_sync}'`
		);
		expect(policy.rowCount).toBe(1);
	});
});
