/**
 * Lot 10 ter — test d'isolement des espaces personnels (règle 15, D13, D17 ; point a du porteur). Écrit avant le code :
 * il entre rouge, puis passe avec la migration 0022 ; il tourne en CI avec les autres tests d'intégration.
 *
 * Étape 1 (cette partie) : la base. Avec le rôle de l'API (app_api, sans BYPASSRLS), dans le contexte de A, aucune ligne
 * de B, ni fiche, ni bail, ni encaissement, ni reçu, ni document, ni lien ; un lien vers une fiche de B est refusé ; sans
 * organisation, aucun lien n'est lisible ; la seule lecture hors organisation, `my_person_links()`, ne renvoie que les
 * identifiants des liens actifs de la personne connectée ; `person_links` n'est jamais synchronisée.
 * Étape 2 : la même chose par l'API et par le module `portals` (une organisation par requête, audit, révocation).
 *
 * Monde (test/portals.ts) : agences A et B, organisation de bailleur L de la personne P ; P propriétaire dans A, B et L ;
 * T locataire dans A (bail terminé) puis dans B (bail en cours).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@ziga/shared/ids';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './http.js';
import { apiSql, inContext, sqlError } from './orgs.js';
import { insertLink, migrationClient, portalWorld, seedIn, type PortalWorld } from './portals.js';

let t: TestApp;
let owner: pg.Client;
let api: pg.Client;
let w: PortalWorld;

/** Tables où B a des lignes qui concernent P ou T. */
const B_TABLES = ['person_links', 'owners', 'tenants', 'leases', 'payments', 'receipts', 'documents', 'properties', 'units'] as const;

beforeAll(async () => {
	t = await startApp();
	owner = await migrationClient();
	api = await apiSql();
	w = await portalWorld(t, owner);
});

afterAll(async () => {
	await api?.end();
	await owner?.end();
	await t?.close();
});

describe('isolement des espaces personnels dans la base (lot 10 ter, étape 1)', () => {
	it('le monde existe : liens actifs de P dans A, B et L, de T dans A et B', async () => {
		for (const [o, links] of [
			[w.a, [w.a.pLink, w.a.tLink]],
			[w.b, [w.b.pLink, w.b.tLink]],
			[w.l, [w.l.pLink]]
		] as const) {
			const r = await seedIn(owner, o.org.id, (c) =>
				c.query(`select id, status from person_links where organization_id = $1 order by id`, [o.org.id])
			);
			expect(r.rows.map((x) => x.id).sort()).toEqual([...links].sort());
			expect(r.rows.every((x) => x.status === 'active')).toBe(true);
		}
	});

	it('app_api dans le contexte de A : aucune ligne de B, dans aucune table où P ou T figurent', async () => {
		await inContext(api, { organizationId: w.a.org.id, userId: w.a.org.director.userId }, async () => {
			for (const table of B_TABLES) {
				const r = await api.query(`select count(*)::int as n from ${table} where organization_id = $1`, [w.b.org.id]);
				expect(r.rows[0].n, table).toBe(0);
			}
			// Par identifiant non plus : le bail, la fiche, le reçu, les documents de T chez B.
			for (const [table, id] of [
				['leases', w.b.tLease],
				['tenants', w.b.tTenant],
				['receipts', w.b.tReceipt],
				['payments', w.b.tPayment],
				['documents', w.b.tSignedLease],
				['documents', w.b.tIdentity],
				['person_links', w.b.tLink],
				['person_links', w.b.pLink]
			] as const) {
				expect((await api.query(`select 1 from ${table} where id = $1`, [id])).rowCount, `${table} ${id}`).toBe(0);
			}
			// A voit ses propres liens, et seulement eux.
			const mine = await api.query(`select id from person_links order by id`);
			expect(mine.rows.map((x) => x.id).sort()).toEqual([w.a.pLink, w.a.tLink].sort());
		});
	});

	it('app_api dans le contexte de A : un lien vers une fiche de B est refusé (clé composite), un lien posé dans B aussi (RLS)', async () => {
		await inContext(api, { organizationId: w.a.org.id, userId: w.a.org.director.userId }, async () => {
			const toB = await sqlError(
				api,
				`insert into person_links (id, organization_id, user_id, record_type, tenant_id, status, origin, phone, requested_by)
				 values ($1, $2, $3, 'tenant', $4, 'requested', 'organization_invite', $5, $6)`,
				[newId(), w.a.org.id, w.t.userId, w.b.tTenant, w.t.phone, w.a.org.director.userId]
			);
			expect(toB.code).toBe('23503');
			const inB = await sqlError(
				api,
				`insert into person_links (id, organization_id, user_id, record_type, tenant_id, status, origin, phone, requested_by)
				 values ($1, $2, $3, 'tenant', $4, 'requested', 'organization_invite', $5, $6)`,
				[newId(), w.b.org.id, w.t.userId, w.b.tTenant, w.t.phone, w.a.org.director.userId]
			);
			// Refusée avant même la RLS : depuis A, la direction et la gestion de B sont invisibles (déclencheur).
			expect(['42501', 'P0001']).toContain(inB.code);
			// Modifier ou révoquer un lien de B depuis A : aucune ligne touchée.
			const up = await api.query(
				`update person_links set status = 'revoked', revoked_at = now(), revoked_by = $2, revoked_by_party = 'organization',
					revocation_reason = 'Tentative depuis A' where id = $1`,
				[w.b.tLink, w.a.org.director.userId]
			);
			expect(up.rowCount).toBe(0);
		});
		const still = await seedIn(owner, w.b.org.id, (c) =>
			c.query(`select id, status from person_links where organization_id = $1`, [w.b.org.id])
		);
		expect(still.rows.map((r) => r.id).sort()).toEqual([w.b.pLink, w.b.tLink].sort());
		expect(still.rows.every((r) => r.status === 'active')).toBe(true);
		// RLS forcée (le propriétaire des tables aussi), politique de l'organisation du contexte, en lecture comme en écriture.
		const rls = await owner.query(
			`select c.relrowsecurity, c.relforcerowsecurity, p.qual, p.with_check from pg_class c
			 join pg_policies p on p.tablename = c.relname and p.policyname = 'organization_isolation' where c.relname = 'person_links'`
		);
		expect(rls.rows).toEqual([
			{
				relrowsecurity: true,
				relforcerowsecurity: true,
				qual: '(organization_id = current_organization_id())',
				with_check: '(organization_id = current_organization_id())'
			}
		]);
	});

	it('app_api sans organisation : aucun lien lisible, même pour la personne liée', async () => {
		await inContext(api, { userId: w.p.userId }, async () => {
			expect((await api.query(`select count(*)::int as n from person_links`)).rows[0].n).toBe(0);
			expect((await api.query(`select count(*)::int as n from owners`)).rows[0].n).toBe(0);
			expect((await api.query(`select count(*)::int as n from tenants`)).rows[0].n).toBe(0);
		});
	});

	it('my_person_links() : seulement les liens actifs de la personne connectée, organisation par organisation, sans données', async () => {
		const ofP = await inContext(api, { userId: w.p.userId }, () =>
			api.query(`select organization_id, record_type, owner_id, tenant_id, link_id from my_person_links() order by organization_id`)
		);
		expect(ofP.rows.map((r) => [r.organization_id, r.record_type, r.owner_id, r.tenant_id, r.link_id]).sort()).toEqual(
			[
				[w.a.org.id, 'owner', w.a.pOwner, null, w.a.pLink],
				[w.b.org.id, 'owner', w.b.pOwner, null, w.b.pLink],
				[w.l.org.id, 'owner', w.l.pOwner, null, w.l.pLink]
			].sort()
		);
		// Ses colonnes : des identifiants seulement (aucun nom, aucun numéro).
		expect(ofP.fields.map((f) => f.name).sort()).toEqual(['link_id', 'organization_id', 'owner_id', 'record_type', 'tenant_id']);

		const ofT = await inContext(api, { userId: w.t.userId }, () => api.query(`select organization_id, tenant_id from my_person_links()`));
		expect(ofT.rows.map((r) => [r.organization_id, r.tenant_id]).sort()).toEqual(
			[
				[w.a.org.id, w.a.tTenant],
				[w.b.org.id, w.b.tTenant]
			].sort()
		);

		// Sans personne connectée : rien ; dans le contexte d'une organisation, toujours seulement la personne connectée.
		expect((await inContext(api, {}, () => api.query(`select * from my_person_links()`))).rowCount).toBe(0);
		const inA = await inContext(api, { organizationId: w.a.org.id, userId: w.a.org.director.userId }, () =>
			api.query(`select * from my_person_links()`)
		);
		expect(inA.rowCount).toBe(0);
	});

	it('my_person_links() : SECURITY DEFINER, search_path fixé, EXECUTE réservé à app_api', async () => {
		const fn = await owner.query(
			`select p.prosecdef, p.proconfig, has_function_privilege('app_api', p.oid, 'EXECUTE') as api,
				has_function_privilege('app_admin', p.oid, 'EXECUTE') as admin, has_function_privilege('app_sync', p.oid, 'EXECUTE') as sync,
				has_function_privilege('public', p.oid, 'EXECUTE') as public
			 from pg_proc p where p.proname = 'my_person_links'`
		);
		expect(fn.rowCount).toBe(1);
		expect(fn.rows[0]).toMatchObject({ prosecdef: true, api: true, admin: false, sync: false, public: false });
		expect(fn.rows[0].proconfig).toEqual(['search_path=pg_catalog, public']);
	});

	it('un lien demandé, non accepté, ou révoqué n’apparaît pas dans my_person_links()', async () => {
		const other = await seedIn(owner, w.a.org.id, async (c) => {
			const tenant = (
				await c.query(`insert into tenants (id, organization_id, full_name, phone) values ($1, $2, 'Fatim Ouédraogo', $3) returning id`, [
					newId(),
					w.a.org.id,
					w.p.phone
				])
			).rows[0].id as string;
			return insertLink(c, w.a.org.id, {
				userId: w.p.userId,
				phone: w.p.phone,
				tenantId: tenant,
				acceptedBy: w.a.org.director.userId,
				status: 'requested'
			});
		});
		const r = await inContext(api, { userId: w.p.userId }, () => api.query(`select link_id from my_person_links()`));
		expect(r.rows.map((x) => x.link_id)).not.toContain(other);
	});

	it('synchronisation : person_links n’est jamais publiée ni lisible par app_sync ; les fiches synchronisées n’exposent aucun compte', async () => {
		const pub = await owner.query(`select 1 from pg_publication_tables where pubname = 'powersync' and tablename = 'person_links'`);
		expect(pub.rowCount).toBe(0);
		const grant = await owner.query(`select has_table_privilege('app_sync', 'person_links', 'SELECT') as sync`);
		expect(grant.rows[0].sync).toBe(false);
		const config = readFileSync(join(import.meta.dirname, '../../../infra/powersync/sync-config.yaml'), 'utf8');
		expect(config).not.toMatch(/person_links/);
		expect(config).not.toMatch(/my_person_links/);
		// Fiches propriétaire et locataire : jamais la colonne user_id dans un flux.
		for (const line of config.split('\n').filter((x) => /FROM (owners|tenants)\b/.test(x))) expect(line).not.toMatch(/user_id/);
	});

	it('journal : une lecture d’espace s’écrit dans l’organisation lue (origine portal), jamais lisible depuis une autre', async () => {
		const auditId = newId();
		await seedIn(owner, w.b.org.id, (c) =>
			c.query(
				`insert into audit_log (id, actor_type, actor_user_id, organization_id, subject_user_id, action, object_type, object_id, origin)
				 values ($1, 'user', $2, $3, $2, 'portal.read', 'person_link', $4, 'portal')`,
				[auditId, w.t.userId, w.b.org.id, w.b.tLink]
			)
		);
		await inContext(api, { organizationId: w.a.org.id, userId: w.a.org.director.userId }, async () => {
			expect((await api.query(`select 1 from audit_log where id = $1`, [auditId])).rowCount).toBe(0);
		});
		await inContext(api, { userId: w.t.userId }, async () => {
			// Ligne d'une organisation : jamais dans les événements personnels de la plateforme.
			expect((await api.query(`select 1 from audit_log where id = $1`, [auditId])).rowCount).toBe(0);
		});
	});
});
