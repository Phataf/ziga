/** Premier super administrateur : créé par la ligne de commande, jamais par l'interface (lot 02). */
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool } from '../src/db/database.js';
import { createSuperAdmin } from '../src/modules/identity/super-admin.js';
import { Client, newPhone, signedUp, startApp, type TestApp } from './http.js';

let t: TestApp;
const pool = createPool({ url: process.env.DATABASE_URL!, max: 1, connectionTimeoutMs: 5_000, applicationName: 'ziga-test' });
const db = createDatabase(pool);

beforeAll(async () => {
	t = await startApp();
});
afterAll(async () => {
	await t.close();
	await pool.end();
});

describe('super administrateur', () => {
	it('crée un compte actif et vérifié avec le rôle super_admin, porté par le jeton d’accès', async () => {
		const phone = newPhone();
		expect(await createSuperAdmin(db, { phone, name: 'Admin Ziga', password: 'mot-de-passe-admin' })).toBe('created');
		const client = new Client(t.url);
		expect((await client.call('POST', '/auth/login', { phone, password: 'mot-de-passe-admin' })).status).toBe(200);
		expect(decodeJwt(client.accessToken!).prole).toBe('super_admin');
		expect((await client.call('GET', '/me')).body).toMatchObject({ platformRole: 'super_admin' });
	});

	it('promeut une personne déjà inscrite', async () => {
		const { phone } = await signedUp(t);
		expect(await createSuperAdmin(db, { phone, name: 'Ignoré', password: 'nouveau-mot-de-passe' })).toBe('promoted');
		const client = new Client(t.url);
		await client.call('POST', '/auth/login', { phone, password: 'nouveau-mot-de-passe' });
		expect(decodeJwt(client.accessToken!).prole).toBe('super_admin');
	});

	it('aucune route de l’API ne permet de se donner un rôle plateforme', async () => {
		const { client } = await signedUp(t);
		expect((await client.call('GET', '/me')).body).toMatchObject({ platformRole: null });
		for (const [method, path] of [
			['POST', '/admin/users'],
			['PUT', '/me/role']
		] as const) {
			expect((await client.call(method, path, { platformRole: 'super_admin' })).status).toBe(404);
		}
		// « Mon compte » ne change que le nom : le rôle envoyé est ignoré.
		const patched = await client.call('PATCH', '/me', { name: 'Nouveau Nom', platformRole: 'super_admin' });
		expect(patched).toMatchObject({ status: 200, body: { name: 'Nouveau Nom', platformRole: null } });
	});
});
