/**
 * Interrupteurs, formules, back-office (lot 04) : tests du §8 de docs/FEATURE-FLAGS.md et du prompt du lot.
 */
import { Controller, Get, Module } from '@nestjs/common';
import { newId } from '@ziga/shared/ids';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequiresFeature } from '../src/modules/features/feature.guards.js';
import { OrganizationScoped } from '../src/modules/organizations/organization-context.js';
import { Client, newPhone, signedUp, startApp, type TestApp } from './http.js';
import { addMember, apiSql, createOrg, inContext, setPlan, sqlError, type Org } from './orgs.js';

/** Route de test protégée par une fonctionnalité optionnelle (aucune route du lot 04 n'en a encore). */
@Controller('test-feature')
@OrganizationScoped()
class FeatureProbeController {
	@Get()
	@RequiresFeature('listings.publication')
	probe() {
		return { ok: true };
	}
}

@Module({ controllers: [FeatureProbeController] })
class FeatureProbeModule {}

let t: TestApp;
const owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
let sql: pg.Client;

type Staff = { client: Client; userId: string };
const staff = {} as Record<'super_admin' | 'support' | 'sales' | 'finance' | 'none', Staff>;

async function platformUser(role: keyof typeof staff): Promise<Staff> {
	const { client } = await signedUp(t);
	const userId = ((await client.call('GET', '/me')).body as { id: string }).id;
	if (role !== 'none') await owner.query(`update users set platform_role = $2 where id = $1`, [userId, role]);
	return { client, userId };
}

/** Remet le catalogue dans son état de lancement (les tests modifient des modes globaux). */
async function resetCatalog() {
	await owner.query(
		`update features set global_mode = 'enabled' where key in ('listings.publication', 'payments.registry', 'field_agents', 'exports.csv')`
	);
	await owner.query(`update feature_overrides set revoked_at = now() where revoked_at is null and feature_key = 'listings.publication'`);
	await staff.super_admin.client.call('PUT', '/admin/features/payments.registry/mode', {
		mode: 'disabled',
		reason: 'réinitialisation des tests'
	});
	await staff.super_admin.client.call('PUT', '/admin/features/payments.registry/mode', {
		mode: 'enabled',
		reason: 'réinitialisation des tests'
	});
}

const features = async (client: Client, organizationId?: string) =>
	(
		await client.call<{ features: Record<string, { enabled: boolean; step: string; reason: string }> }>(
			'GET',
			'/me/features',
			undefined,
			organizationId ? { 'x-organization-id': organizationId } : {}
		)
	).body.features;

beforeAll(async () => {
	t = await startApp({}, [FeatureProbeModule]);
	await owner.connect();
	sql = await apiSql();
	for (const role of ['super_admin', 'support', 'sales', 'finance', 'none'] as const) staff[role] = await platformUser(role);
});
afterAll(async () => {
	await resetCatalog();
	await sql.end();
	await owner.end();
	await t.close();
});

describe('application des interrupteurs', () => {
	let org: Org;
	beforeAll(async () => {
		org = await createOrg(t, 'agency', 'Agence interrupteurs');
	});
	beforeEach(resetCatalog);

	it('endpoint protégé appelé avec la fonctionnalité coupée → 403 FEATURE_DISABLED, avec le motif', async () => {
		expect((await org.director.call('GET', '/test-feature')).body).toEqual({ ok: true });
		await staff.super_admin.client.call('PUT', '/admin/features/listings.publication/mode', {
			mode: 'disabled',
			reason: 'arrêt d’urgence de test'
		});
		const r = await org.director.call('GET', '/test-feature');
		expect(r).toMatchObject({
			status: 403,
			body: { code: 'FEATURE_DISABLED', details: { key: 'listings.publication', step: 'global_disabled' } }
		});
	});

	it('GET /me/features reflète un changement aussitôt (publication Redis)', async () => {
		expect((await features(org.director.client, org.id))['listings.publication']).toMatchObject({ enabled: true });
		const started = Date.now();
		await staff.super_admin.client.call('PUT', '/admin/features/listings.publication/mode', {
			mode: 'restricted',
			reason: 'passage en bêta'
		});
		expect((await features(org.director.client, org.id))['listings.publication']).toMatchObject({ enabled: false, step: 'restricted' });
		expect(Date.now() - started).toBeLessThan(30_000);
	});

	it('sans publication (changement direct en base), la copie locale expire et le changement arrive en moins de 30 s', async () => {
		const other = await startApp({ FEATURES_CACHE_TTL_SECONDS: '1' });
		try {
			// Instance distincte (sa propre clé de signature en test) : une organisation à elle.
			const local = await createOrg(other, 'agency', 'Agence de la seconde instance');
			const call = async () =>
				(
					await local.director.client.call<{ features: Record<string, { enabled: boolean }> }>('GET', '/me/features', undefined, {
						'x-organization-id': local.id
					})
				).body.features;
			expect((await call())['exports.csv']!.enabled).toBe(true);
			// Changement sans passer par le back-office : ni invalidation ni publication.
			await owner.query(`update features set global_mode = 'disabled' where key = 'exports.csv'`);
			const started = Date.now();
			let enabled = true;
			while (enabled && Date.now() - started < 30_000) {
				await new Promise((r) => setTimeout(r, 250));
				// La copie Redis expire aussi (même durée) : la base est relue.
				enabled = (await call())['exports.csv']!.enabled;
			}
			expect(enabled).toBe(false);
			expect(Date.now() - started).toBeLessThan(30_000);
		} finally {
			await owner.query(`update features set global_mode = 'enabled' where key = 'exports.csv'`);
			await other.close();
		}
	});

	it('parcours d’acceptation : couper pour tous, ouvrir pour une agence, fermer pour une personne de cette agence', async () => {
		const colleague = await addMember(t, org, 'manager');
		const outsider = await createOrg(t, 'agency', 'Autre agence');
		const sa = staff.super_admin.client;
		await sa.call('PUT', '/admin/features/listings.publication/mode', { mode: 'disabled', reason: 'coupée pour tous' });
		expect((await features(org.director.client, org.id))['listings.publication']).toMatchObject({
			enabled: false,
			step: 'global_disabled'
		});

		// « Ouvrir pour une seule agence » : ouverte sur liste, avec une exception pour cette agence.
		await sa.call('PUT', '/admin/features/listings.publication/mode', { mode: 'restricted', reason: 'ouverture sur liste' });
		expect(
			(
				await sa.call('POST', '/admin/overrides', {
					featureKey: 'listings.publication',
					scope: 'organization',
					targetId: org.id,
					value: true,
					reason: 'agence pilote'
				})
			).status
		).toBe(201);
		expect((await features(org.director.client, org.id))['listings.publication']).toMatchObject({
			enabled: true,
			step: 'organization_override'
		});
		expect((await features(outsider.director.client, outsider.id))['listings.publication']).toMatchObject({
			enabled: false,
			step: 'restricted'
		});

		// Fermée pour une seule personne de cette agence.
		await sa.call('POST', '/admin/overrides', {
			featureKey: 'listings.publication',
			scope: 'user',
			targetId: colleague.userId,
			value: false,
			reason: 'demande de la directrice'
		});
		expect((await features(colleague.client, org.id))['listings.publication']).toMatchObject({ enabled: false, step: 'user_override' });
		expect((await features(org.director.client, org.id))['listings.publication']).toMatchObject({ enabled: true });

		// Le simulateur dit la même chose, avec l'étape.
		const sim = await sa.call<{ features: Record<string, { enabled: boolean; stepNumber: number; reason: string }> }>(
			'GET',
			`/admin/simulator?organizationId=${org.id}&userId=${colleague.userId}`
		);
		expect(sim.body.features['listings.publication']).toMatchObject({
			enabled: false,
			stepNumber: 2,
			reason: 'Non — exception pour cette personne'
		});
		const simDirector = await sa.call<{ features: Record<string, { stepNumber: number }> }>(
			'GET',
			`/admin/simulator?organizationId=${org.id}&userId=${org.director.userId}`
		);
		expect(simDirector.body.features['listings.publication']!.stepNumber).toBe(3);
	});

	it('dépendance : payments.direct ouverte mais payments.registry coupée → non', async () => {
		const sa = staff.super_admin.client;
		await setPlan(org.id, 'pro', false);
		await sa.call('PUT', '/admin/features/payments.direct/mode', { mode: 'enabled', reason: 'ouverture de test' });
		try {
			expect((await features(org.director.client, org.id))['payments.direct']).toMatchObject({ enabled: true });
			await sa.call('PUT', '/admin/features/payments.registry/mode', { mode: 'disabled', reason: 'test de dépendance' });
			expect((await features(org.director.client, org.id))['payments.direct']).toMatchObject({ enabled: false, step: 'dependency' });
		} finally {
			await sa.call('PUT', '/admin/features/payments.direct/mode', { mode: 'disabled', reason: 'fin du test' });
		}
	});

	it('un directeur désactive une fonctionnalité ouverte ; il ne peut pas activer une clé fermée par la plateforme', async () => {
		const set = (key: string, disabled: boolean) => org.director.call('PUT', `/organization/features/${key}`, { disabled });
		expect((await set('listings.publication', true)).status).toBe(200);
		expect((await features(org.director.client, org.id))['listings.publication']).toMatchObject({
			enabled: false,
			step: 'organization_setting'
		});
		expect((await set('listings.publication', false)).status).toBe(200);
		expect((await features(org.director.client, org.id))['listings.publication']!.enabled).toBe(true);
		// Clé fermée par la plateforme : rien à activer, et la désactiver n'a pas de sens.
		expect((await set('payments.direct', false)).status).toBe(200);
		expect((await features(org.director.client, org.id))['payments.direct']!.enabled).toBe(false);
		expect((await set('payments.direct', true)).body).toMatchObject({ code: 'FEATURE_NOT_OPEN' });
		// Seul le directeur règle les fonctionnalités de son organisation.
		const manager = await addMember(t, org, 'manager');
		expect((await manager.call('PUT', '/organization/features/listings.publication', { disabled: true })).body).toMatchObject({
			code: 'FORBIDDEN_ACTION'
		});
	});

	it('modification d’un interrupteur → ligne d’audit avec avant et après', async () => {
		await staff.super_admin.client.call('PUT', '/admin/features/exports.csv/mode', { mode: 'restricted', reason: 'audit de test' });
		const journal = await staff.super_admin.client.call<{
			entries: { action: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
		}>('GET', '/admin/audit?action=feature.set_mode');
		expect(journal.body.entries[0]).toMatchObject({
			action: 'feature.set_mode',
			before: { key: 'exports.csv', mode: 'enabled' },
			after: { key: 'exports.csv', mode: 'restricted', reason: 'audit de test' }
		});
	});

	it('une exception pour une organisation apparaît dans le journal de cette organisation', async () => {
		await staff.super_admin.client.call('POST', '/admin/overrides', {
			featureKey: 'listings.featured',
			scope: 'organization',
			targetId: org.id,
			value: true,
			reason: 'geste commercial'
		});
		const audit = await org.director.call<{ entries: { action: string; after: Record<string, unknown> }[] }>('GET', '/organization/audit');
		expect(audit.body.entries.find((e) => e.action === 'feature.override_set')).toMatchObject({
			after: { key: 'listings.featured', value: true }
		});
	});
});

describe('rôles de la plateforme', () => {
	let org: Org;
	beforeAll(async () => {
		org = await createOrg(t, 'agency', 'Agence des rôles', 'essential');
	});

	it('support ne modifie pas un interrupteur ; super_admin si', async () => {
		expect(
			(await staff.support.client.call('PUT', '/admin/features/imports.excel/mode', { mode: 'restricted', reason: 'essai assistance' }))
				.body
		).toMatchObject({
			code: 'FORBIDDEN_ACTION'
		});
		expect(
			(
				await staff.super_admin.client.call('PUT', '/admin/features/imports.excel/mode', {
					mode: 'restricted',
					reason: 'essai super admin'
				})
			).status
		).toBe(204);
		await staff.super_admin.client.call('PUT', '/admin/features/imports.excel/mode', { mode: 'enabled', reason: 'retour' });
	});

	it('sales : formules et abonnements, pas les paiements ni les interrupteurs ; finance : paiements seulement', async () => {
		const sales = staff.sales.client;
		const finance = staff.finance.client;
		expect(
			(
				await sales.call('PATCH', '/admin/plans/essential', {
					monthlyPrice: 17_500,
					yearlyPrice: 175_000,
					maxUnits: 60,
					maxUsers: 3,
					reason: 'hypothèse révisée'
				})
			).status
		).toBe(204);
		const sub = await sales.call<{ id: string }>('POST', '/admin/subscriptions', {
			organizationId: org.id,
			planId: 'essential',
			startsOn: '2027-01-01',
			endsOn: '2027-01-31',
			amount: 17_500,
			paymentStatus: 'pending'
		});
		expect(sub.status).toBe(201);
		expect(
			(await sales.call('POST', `/admin/subscriptions/${sub.body.id}/payment`, { paymentReference: 'OM-12345', paidOn: '2027-01-02' }))
				.status
		).toBe(403);
		expect((await sales.call('PUT', '/admin/features/imports.excel/mode', { mode: 'disabled', reason: 'essai commercial' })).status).toBe(
			403
		);
		expect(
			(await finance.call('POST', `/admin/subscriptions/${sub.body.id}/payment`, { paymentReference: 'OM-12345', paidOn: '2027-01-02' }))
				.status
		).toBe(204);
		expect(
			(
				await finance.call('PATCH', '/admin/plans/essential', {
					monthlyPrice: 1,
					yearlyPrice: 1,
					maxUnits: 60,
					maxUsers: 3,
					reason: 'essai finances'
				})
			).status
		).toBe(403);
		expect(
			(
				await finance.call('POST', '/admin/subscriptions', {
					organizationId: org.id,
					planId: 'essential',
					startsOn: '2027-02-01',
					endsOn: '2027-02-28',
					amount: 1,
					paymentStatus: 'pending'
				})
			).status
		).toBe(403);
		// Le paiement d'abonnement est journalisé chez l'organisation (encaissé par la plateforme, ce n'est pas un loyer).
		const audit = await org.director.call<{ entries: { action: string; after: Record<string, unknown> }[] }>('GET', '/organization/audit');
		expect(audit.body.entries.find((e) => e.action === 'subscription.payment_record')).toMatchObject({
			after: { paymentReference: 'OM-12345' }
		});
		await sales.call('PATCH', '/admin/plans/essential', {
			monthlyPrice: 15_000,
			yearlyPrice: 150_000,
			maxUnits: 60,
			maxUsers: 3,
			reason: 'retour au cadrage'
		});
		// Les prix sont des hypothèses : leur changement est journalisé avec avant et après.
		const journal = await sales.call<{ entries: { action: string; before: Record<string, unknown> }[] }>(
			'GET',
			'/admin/audit?action=plan.update'
		);
		expect(journal.body.entries[0]).toMatchObject({ action: 'plan.update', before: { plan: 'essential', monthlyPrice: 17_500 } });
	});

	it('une personne sans rôle plateforme n’accède à aucun endpoint /admin', async () => {
		const routes = t.app.getHttpAdapter().getInstance().router.stack as { route?: { path: string; methods: Record<string, boolean> } }[];
		const admin = routes.flatMap((l) =>
			l.route && l.route.path.startsWith('/admin') ? Object.keys(l.route.methods).map((m) => [m.toUpperCase(), l.route!.path] as const) : []
		);
		expect(admin.length).toBeGreaterThan(20);
		for (const [method, path] of admin) {
			const r = await staff.none.client.call(method, path.replace(/:\w+/g, newId()), method === 'GET' ? undefined : {});
			expect(r.status, `${method} ${path}`).toBe(403);
			expect((r.body as { code: string }).code, `${method} ${path}`).toBe('PLATFORM_ONLY');
		}
	});

	it('un rôle retiré prend effet tout de suite, même avec un jeton d’accès encore valable', async () => {
		const temp = await platformUser('support');
		expect((await temp.client.call('GET', '/admin/organizations')).status).toBe(200);
		await owner.query(`update users set platform_role = null where id = $1`, [temp.userId]);
		expect((await temp.client.call('GET', '/admin/organizations')).body).toMatchObject({ code: 'PLATFORM_ONLY' });
	});

	it('validation : une agence sans RCCM ni IFU ne passe pas ; avec, elle est vérifiée et l’organisation le voit', async () => {
		const agency = await createOrg(t, 'agency', 'Agence à valider');
		expect((await staff.support.client.call('POST', `/admin/organizations/${agency.id}/verify`, {})).body).toMatchObject({
			code: 'VERIFICATION_INCOMPLETE'
		});
		await agency.director.call('PATCH', '/organization', { rccm: 'BF OUA 2024 B 1', ifu: '00011111A' });
		expect((await staff.support.client.call('POST', `/admin/organizations/${agency.id}/verify`, {})).status).toBe(204);
		expect(
			(await agency.director.client.call<{ verificationStatus: string }[]>('GET', '/me/organizations')).body[0]!.verificationStatus
		).toBe('verified');
		const audit = await agency.director.call<{ entries: { action: string; origin: string }[] }>('GET', '/organization/audit');
		expect(audit.body.entries[0]).toMatchObject({ action: 'organization.verify', origin: 'admin' });
	});

	it('suspension (motif, super_admin seulement) : consultation possible, aucune modification ; réintégration', async () => {
		const agency = await createOrg(t, 'agency', 'Agence suspendue');
		expect(
			(await staff.support.client.call('POST', `/admin/organizations/${agency.id}/suspend`, { reason: 'impayés répétés' })).status
		).toBe(403);
		expect((await staff.super_admin.client.call('POST', `/admin/organizations/${agency.id}/suspend`, { reason: '' })).status).toBe(400);
		expect(
			(await staff.super_admin.client.call('POST', `/admin/organizations/${agency.id}/suspend`, { reason: 'impayés répétés' })).status
		).toBe(204);
		expect((await agency.director.call('GET', '/organization')).status).toBe(200);
		expect((await agency.director.call('GET', '/organization/audit')).status).toBe(200);
		expect((await agency.director.call('PATCH', '/organization', { commune: 'Saaba' })).body).toMatchObject({
			code: 'ORGANIZATION_SUSPENDED'
		});
		expect((await agency.director.call('POST', '/organization/invitations', { phone: newPhone(), role: 'manager' })).body).toMatchObject({
			code: 'ORGANIZATION_SUSPENDED'
		});
		expect(
			(await staff.super_admin.client.call('POST', `/admin/organizations/${agency.id}/reinstate`, { reason: 'régularisation' })).status
		).toBe(204);
		expect((await agency.director.call('PATCH', '/organization', { commune: 'Saaba' })).status).toBe(200);
	});

	it('changement de formule : journalisé chez l’organisation, abonnement « à payer » créé pour une formule payante', async () => {
		const agency = await createOrg(t, 'agency', 'Agence qui monte', 'discovery');
		expect(
			(await staff.sales.client.call('PUT', `/admin/organizations/${agency.id}/plan`, { planId: 'essential', reason: 'contrat signé' }))
				.status
		).toBe(204);
		const sub = await agency.director.call<{ planId: string; stage: string; periods: { paymentStatus: string }[] }>(
			'GET',
			'/organization/subscription'
		);
		expect(sub.body).toMatchObject({ planId: 'essential', stage: 'grace', periods: [{ paymentStatus: 'pending' }] });
		const audit = await agency.director.call<{ entries: { action: string }[] }>('GET', '/organization/audit');
		expect(audit.body.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['organization.change_plan', 'subscription.create']));
	});

	it('le journal du back-office montre les événements de plateforme et ses actions, pas les autres événements des organisations', async () => {
		const journal = await staff.support.client.call<{ entries: { action: string; origin: string; organizationId: string | null }[] }>(
			'GET',
			'/admin/audit'
		);
		expect(journal.body.entries.some((e) => e.action === 'auth.login' || e.action === 'auth.account_created')).toBe(true);
		for (const e of journal.body.entries) expect(e.organizationId === null || e.origin === 'admin', e.action).toBe(true);
	});
});

describe('accès d’assistance', () => {
	let org: Org;
	beforeAll(async () => {
		org = await createOrg(t, 'agency', 'Agence assistée');
	});

	it('motif obligatoire (15 caractères), 24 heures au plus', async () => {
		const open = (body: object) => staff.support.client.call('POST', '/admin/support-accesses', { organizationId: org.id, ...body });
		expect((await open({ reason: 'trop court', durationMinutes: 30 })).status).toBe(400);
		expect((await open({ reason: 'Relevé d’octobre introuvable, demande du 08/11', durationMinutes: 24 * 60 + 1 })).status).toBe(400);
		expect(
			(
				await staff.sales.client.call('POST', '/admin/support-accesses', {
					organizationId: org.id,
					reason: 'Relevé d’octobre introuvable, demande du 08/11',
					durationMinutes: 30
				})
			).status
		).toBe(403);
	});

	it('chaque lecture est journalisée et visible par l’organisation ; aucun accès « en tant que » un utilisateur', async () => {
		const opened = await staff.support.client.call<{ id: string }>('POST', '/admin/support-accesses', {
			organizationId: org.id,
			reason: 'Import Excel bloqué à la ligne 42, demande du 08/11',
			durationMinutes: 60
		});
		expect(opened.status).toBe(201);
		const read = await staff.support.client.call<{ organization: { id: string; representative: unknown } }>(
			'GET',
			`/admin/support-accesses/${opened.body.id}/organization`
		);
		expect(read.body.organization.id).toBe(org.id);
		expect((await staff.support.client.call('GET', `/admin/support-accesses/${opened.body.id}/journal`)).status).toBe(200);
		const audit = await org.director.call<{ entries: { action: string; after: Record<string, unknown>; actorName: string | null }[] }>(
			'GET',
			'/organization/audit'
		);
		const actions = audit.body.entries.map((e) => e.action);
		expect(actions).toEqual(expect.arrayContaining(['support.access_open', 'support.read']));
		expect(
			audit.body.entries
				.filter((e) => e.action === 'support.read')
				.map((e) => e.after.page)
				.sort()
		).toEqual(['journal', 'organisation']);
		// Un autre agent ne peut pas se servir de cet accès.
		const other = await platformUser('support');
		expect((await other.client.call('GET', `/admin/support-accesses/${opened.body.id}/organization`)).status).toBe(403);
		// Clos : plus aucune lecture.
		expect((await staff.support.client.call('POST', `/admin/support-accesses/${opened.body.id}/close`)).status).toBe(204);
		expect((await staff.support.client.call('GET', `/admin/support-accesses/${opened.body.id}/organization`)).body).toMatchObject({
			code: 'SUPPORT_ACCESS_EXPIRED'
		});
	});

	it('accès expiré : refusé', async () => {
		const opened = await staff.support.client.call<{ id: string }>('POST', '/admin/support-accesses', {
			organizationId: org.id,
			reason: 'Vérification d’un relevé à la demande de l’agence',
			durationMinutes: 30
		});
		await owner.query(
			`update support_accesses set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = $1`,
			[opened.body.id]
		);
		expect((await staff.support.client.call('GET', `/admin/support-accesses/${opened.body.id}/organization`)).body).toMatchObject({
			code: 'SUPPORT_ACCESS_EXPIRED'
		});
	});
});

describe('abonnement échu, quotas, moyens de paiement', () => {
	it('abonnement échu au-delà du délai de grâce : création refusée avec un message clair ; consultation possible', async () => {
		const org = await createOrg(t, 'agency', 'Agence échue', 'essential');
		await owner.query(`update subscriptions set starts_on = current_date - 60, ends_on = current_date - 30 where organization_id = $1`, [
			org.id
		]);
		const r = await org.director.call<{ code: string; message: string }>('POST', '/organization/invitations', {
			phone: newPhone(),
			role: 'manager'
		});
		expect(r.status).toBe(403);
		expect(r.body.code).toBe('SUBSCRIPTION_EXPIRED');
		expect(r.body.message).toContain('les nouvelles créations sont suspendues');
		expect(r.body.message).toContain('l’export restent possibles');
		for (const path of ['/organization', '/organization/members', '/organization/audit', '/organization/subscription']) {
			expect((await org.director.call('GET', path)).status, path).toBe(200);
		}
		expect((await org.director.call<{ stage: string }>('GET', '/organization/subscription')).body.stage).toBe('blocked');
		// Dans le délai de grâce, les créations restent possibles.
		await owner.query(`update subscriptions set ends_on = current_date - 3 where organization_id = $1`, [org.id]);
		expect((await org.director.call('POST', '/organization/invitations', { phone: newPhone(), role: 'manager' })).status).toBe(201);
	});

	it('quota d’utilisateurs : 2e membre refusé en Découverte, accepté avec une exception de quota', async () => {
		const org = await createOrg(t, 'agency', 'Petite agence', 'discovery');
		const r = await org.director.call<{ code: string; message: string }>('POST', '/organization/invitations', {
			phone: newPhone(),
			role: 'manager'
		});
		expect(r.body).toMatchObject({
			code: 'QUOTA_EXCEEDED',
			message: 'Votre formule Découverte permet 1 utilisateur. Passez à une formule supérieure ou contactez Ziga.'
		});
		expect(
			(
				await staff.super_admin.client.call('POST', '/admin/quota-overrides', {
					organizationId: org.id,
					quota: 'users',
					value: 2,
					reason: 'geste commercial pilote'
				})
			).status
		).toBe(201);
		expect((await org.director.call('POST', '/organization/invitations', { phone: newPhone(), role: 'manager' })).status).toBe(201);
		// La 3e invitation dépasse la nouvelle limite.
		expect((await org.director.call('POST', '/organization/invitations', { phone: newPhone(), role: 'viewer' })).body).toMatchObject({
			code: 'QUOTA_EXCEEDED'
		});
	});

	it('agent de terrain : fonctionnalité des formules Essentiel et Pro', async () => {
		const org = await createOrg(t, 'agency', 'Agence sans agents', 'discovery');
		await staff.super_admin.client.call('POST', '/admin/quota-overrides', {
			organizationId: org.id,
			quota: 'users',
			value: 5,
			reason: 'test des agents'
		});
		expect((await org.director.call('POST', '/organization/invitations', { phone: newPhone(), role: 'field_agent' })).body).toMatchObject({
			code: 'FEATURE_DISABLED',
			details: { key: 'field_agents', step: 'plan' }
		});
	});

	it('moyens de paiement : au moins un actif, réglage du directeur, journalisé', async () => {
		const org = await createOrg(t);
		expect((await org.director.call('GET', '/organization')).body).toMatchObject({
			acceptedPaymentMethods: ['cash', 'mobile_money_manual', 'bank_transfer']
		});
		expect((await org.director.call('PUT', '/organization/payment-methods', { methods: [] })).status).toBe(400);
		expect((await org.director.call('PUT', '/organization/payment-methods', { methods: ['mobile_money_manual'] })).body).toMatchObject({
			acceptedPaymentMethods: ['mobile_money_manual']
		});
		await inContext(sql, { organizationId: org.id }, async () => {
			expect((await sqlError(sql, `update organizations set accepted_payment_methods = '{}'`)).code).toBe('23514');
			expect((await sqlError(sql, `update organizations set accepted_payment_methods = '{cheque}'`)).code).toBe('23514');
		});
		const audit = await org.director.call<{ entries: { action: string; before: Record<string, unknown> }[] }>('GET', '/organization/audit');
		expect(audit.body.entries[0]).toMatchObject({
			action: 'organization.payment_methods',
			before: { acceptedPaymentMethods: ['cash', 'mobile_money_manual', 'bank_transfer'] }
		});
		const manager = await addMember(t, org, 'manager');
		expect((await manager.call('PUT', '/organization/payment-methods', { methods: ['cash'] })).body).toMatchObject({
			code: 'FORBIDDEN_ACTION'
		});
	});
});

describe('droits SQL du rôle app_admin', () => {
	let admin: pg.Client;
	let org: Org;
	beforeAll(async () => {
		admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
		await admin.connect();
		org = await createOrg(t, 'agency', 'Agence SQL admin');
	});
	afterAll(async () => {
		await admin.end();
	});

	it('n’a pas BYPASSRLS et ne lit ni les mots de passe, ni les codes, ni les jetons', async () => {
		expect((await admin.query(`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`)).rows[0]).toEqual({
			rolbypassrls: false,
			rolsuper: false
		});
		await inContext(admin, {}, async () => {
			expect((await sqlError(admin, 'select password_hash from users limit 1')).code).toBe('42501');
			expect((await sqlError(admin, 'select * from otp_codes limit 1')).code).toBe('42501');
			expect((await sqlError(admin, 'select * from refresh_tokens limit 1')).code).toBe('42501');
			expect((await admin.query('select count(*)::int as n from users')).rows[0].n).toBeGreaterThan(0);
		});
	});

	it('hors contexte, ne voit aucune organisation ni aucun membre, seulement l’annuaire (sans représentant légal)', async () => {
		await inContext(admin, {}, async () => {
			expect((await admin.query('select count(*)::int as n from organizations')).rows[0].n).toBe(0);
			expect((await admin.query('select count(*)::int as n from organization_members')).rows[0].n).toBe(0);
			const dir = await admin.query('select * from platform_organization_directory() where id = $1', [org.id]);
			expect(dir.rows).toHaveLength(1);
			expect(Object.keys(dir.rows[0]).some((k) => k.startsWith('rep_'))).toBe(false);
		});
	});

	it('ne crée ni ne modifie de membre, et ne touche qu’aux colonnes de statut et de formule d’une organisation', async () => {
		await inContext(admin, { organizationId: org.id }, async () => {
			expect(
				(
					await sqlError(admin, `insert into organization_members (id, organization_id, user_id, role) values ($1, $2, $3, 'director')`, [
						newId(),
						org.id,
						org.director.userId
					])
				).code
			).toBe('42501');
			expect((await sqlError(admin, `update organizations set rep_name = 'Pirate'`)).code).toBe('42501');
			expect((await sqlError(admin, `update organizations set legal_name = 'Pirate'`)).code).toBe('42501');
			expect((await admin.query(`update organizations set plan_id = 'pro'`)).rowCount).toBe(1);
		});
	});

	it('app_api lit les interrupteurs mais ne les modifie pas', async () => {
		await inContext(sql, {}, async () => {
			expect((await sql.query('select count(*)::int as n from features')).rows[0].n).toBe(17);
			expect((await sqlError(sql, `update features set global_mode = 'disabled'`)).code).toBe('42501');
			expect(
				(
					await sqlError(
						sql,
						`insert into feature_overrides (id, feature_key, scope, user_id, value, reason, created_by) values ($1, 'exports.csv', 'user', $2, true, 'triche', $2)`,
						[newId(), org.director.userId]
					)
				).code
			).toBe('42501');
			expect(
				(
					await sqlError(
						sql,
						`insert into subscriptions (id, organization_id, plan_id, starts_on, ends_on, amount, payment_status, recorded_by) values ($1, $2, 'pro', current_date, current_date, 0, 'waived', $3)`,
						[newId(), org.id, org.director.userId]
					)
				).code
			).toBe('42501');
		});
	});

	it('une organisation ne voit que ses propres abonnements et accès d’assistance', async () => {
		const other = await createOrg(t, 'agency', 'Autre agence SQL');
		await inContext(sql, { organizationId: org.id }, async () => {
			expect((await sql.query('select count(*)::int as n from subscriptions where organization_id = $1', [other.id])).rows[0].n).toBe(0);
			expect((await sql.query('select count(*)::int as n from subscriptions')).rows[0].n).toBeGreaterThan(0);
			expect((await sql.query('select count(*)::int as n from support_accesses where organization_id <> $1', [org.id])).rows[0].n).toBe(0);
		});
	});
});
