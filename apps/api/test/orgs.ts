/** Outils des tests du lot 03 : organisations créées par l'API, membres invités et acceptés, accès SQL par rôle. */
import { newId } from '@ziga/shared/ids';
import type { OrganizationRole, OrganizationType } from '@ziga/shared/permissions';
import pg from 'pg';
import { Client, newPhone, signedUp, type Reply, type TestApp } from './http.js';

export interface Member {
	client: Client;
	phone: string;
	userId: string;
	memberId: string;
	/** Appel dans le contexte d'une organisation (en-tête X-Organization-Id). */
	call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, organizationId?: string): Promise<Reply<T>>;
}

export interface Org {
	id: string;
	type: OrganizationType;
	director: Member;
}

function member(client: Client, phone: string, userId: string, memberId: string, defaultOrg: string): Member {
	return {
		client,
		phone,
		userId,
		memberId,
		call: (method, path, body, organizationId = defaultOrg) => client.call(method, path, body, { 'x-organization-id': organizationId })
	};
}

async function userId(client: Client): Promise<string> {
	return ((await client.call('GET', '/me')).body as { id: string }).id;
}

/**
 * Formule de test posée directement en base (propriétaire du schéma) : avec un abonnement payé en cours, pour que
 * les tests invitent sans buter sur le quota de la formule Découverte (1 utilisateur).
 */
export async function setPlan(
	organizationId: string,
	planId: 'discovery' | 'essential' | 'pro' | 'custom',
	withPaidSubscription = true
): Promise<void> {
	const owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	try {
		await owner.query('BEGIN');
		await owner.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
		await owner.query(`update organizations set plan_id = $2 where id = $1`, [organizationId, planId]);
		if (withPaidSubscription && planId !== 'discovery') {
			await owner.query(
				`insert into subscriptions (id, organization_id, plan_id, starts_on, ends_on, amount, payment_status, payment_reference, paid_on, recorded_by)
				 select $1, $2, $3, current_date - 1, current_date + 60, 35000, 'paid', 'TEST-0001', current_date, created_by from organizations where id = $2`,
				[newId(), organizationId, planId]
			);
		}
		await owner.query('COMMIT');
	} catch (error) {
		await owner.query('ROLLBACK');
		throw error;
	} finally {
		await owner.end();
	}
}

/** Une personne inscrite crée une organisation (elle en devient directrice). Agence : formule Pro, sauf demande. */
export async function createOrg(
	t: TestApp,
	type: OrganizationType = 'agency',
	name = 'Agence de test',
	plan: 'discovery' | 'essential' | 'pro' | 'custom' = type === 'agency' ? 'pro' : 'discovery'
): Promise<Org> {
	const { client, phone } = await signedUp(t);
	const id = newId();
	const r = await client.call('POST', '/organizations', { id, type, legalName: name, phone: '+22625300000', commune: 'Ouagadougou' });
	if (r.status !== 201) throw new Error(`création : ${r.status} ${JSON.stringify(r.body)}`);
	if (plan !== 'discovery') await setPlan(id, plan);
	const uid = await userId(client);
	const members = await client.call<{ id: string; userId: string }[]>('GET', '/organization/members', undefined, {
		'x-organization-id': id
	});
	const memberId = members.body.find((m) => m.userId === uid)!.id;
	return { id, type, director: member(client, phone, uid, memberId, id) };
}

/** Le directeur invite un numéro ; la personne (inscrite si besoin) accepte. */
export async function addMember(
	t: TestApp,
	org: Org,
	role: OrganizationRole,
	existing?: { client: Client; phone: string }
): Promise<Member> {
	const person = existing ?? (await signedUp(t, newPhone()));
	const inv = await org.director.call<{ token: string }>('POST', '/organization/invitations', { phone: person.phone, role });
	if (inv.status !== 201) throw new Error(`invitation : ${inv.status} ${JSON.stringify(inv.body)}`);
	const acc = await person.client.call('POST', `/invitations/${inv.body.token}/accept`);
	if (acc.status !== 200) throw new Error(`acceptation : ${acc.status} ${JSON.stringify(acc.body)}`);
	const uid = await userId(person.client);
	const members = await org.director.call<{ id: string; userId: string }[]>('GET', '/organization/members');
	return member(person.client, person.phone, uid, members.body.find((m) => m.userId === uid)!.id, org.id);
}

/** Connexion SQL directe avec le rôle de l'API (app_api, sans BYPASSRLS). */
export async function apiSql(): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await c.connect();
	return c;
}

/** Exécute `fn` dans une transaction de contexte d'organisation (ou personnel), puis annule tout. */
export async function inContext<T>(c: pg.Client, context: { organizationId?: string; userId?: string }, fn: () => Promise<T>): Promise<T> {
	await c.query('BEGIN');
	try {
		await c.query(`select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)`, [
			context.organizationId ?? '',
			context.userId ?? ''
		]);
		return await fn();
	} finally {
		await c.query('ROLLBACK');
	}
}

/** Erreur PostgreSQL attendue (code SQLSTATE) ; renvoie le message. */
export async function sqlError(c: pg.Client, query: string, params: unknown[] = []): Promise<{ code: string; message: string }> {
	await c.query('SAVEPOINT attendu');
	try {
		await c.query(query, params);
	} catch (error) {
		await c.query('ROLLBACK TO SAVEPOINT attendu');
		const e = error as { code: string; message: string };
		return { code: e.code, message: e.message };
	}
	throw new Error(`Requête acceptée alors qu'elle devait échouer : ${query}`);
}
