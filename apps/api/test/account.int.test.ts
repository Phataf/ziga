/** « Mon compte » (lot 03, complément c) : nom, mot de passe, numéro ; chaque changement est journalisé. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, newPhone, signedUp, startApp, type TestApp } from './http.js';

let t: TestApp;
beforeAll(async () => {
	// Délai progressif réduit : un mauvais mot de passe suivi du bon ne doit pas attendre 1 s dans les tests.
	t = await startApp({ AUTH_FAILURE_BASE_DELAY_MS: '10', AUTH_FAILURE_MAX_DELAY_MS: '20' });
});
afterAll(async () => {
	await t.close();
});

const actions = async (c: Client) =>
	(await c.call<{ entries: { action: string; before: unknown; after: unknown }[] }>('GET', '/me/activity')).body.entries;

describe('Mon compte', () => {
	it('modifie le nom, journalisé avec avant et après', async () => {
		const { client } = await signedUp(t);
		expect((await client.call('PATCH', '/me', { name: 'Awa Kaboré' })).body).toMatchObject({ name: 'Awa Kaboré' });
		expect((await actions(client)).find((e) => e.action === 'auth.profile_update')).toMatchObject({
			before: { name: 'Awa Ouédraogo' },
			after: { name: 'Awa Kaboré' }
		});
		expect((await client.call('PATCH', '/me', { name: 'x' })).status).toBe(400);
	});

	it('change le mot de passe : l’ancien est exigé, les autres appareils sont déconnectés, celui-ci reste connecté', async () => {
		const { client, phone, password } = await signedUp(t);
		const other = new Client(t.url, '203.0.113.30');
		await other.call('POST', '/auth/login', { phone, password });
		expect(
			(await client.call('POST', '/me/password', { currentPassword: 'mauvais', newPassword: 'nouveau-mot-de-passe' })).body
		).toMatchObject({ code: 'WRONG_PASSWORD' });
		await new Promise((r) => setTimeout(r, 30));
		expect((await client.call('POST', '/me/password', { currentPassword: password, newPassword: 'nouveau-mot-de-passe' })).status).toBe(
			204
		);
		expect((await other.call('POST', '/auth/refresh', {})).status).toBe(401);
		expect((await client.call('POST', '/auth/refresh', {})).status).toBe(200);
		expect((await new Client(t.url).call('POST', '/auth/login', { phone, password: 'nouveau-mot-de-passe' })).status).toBe(200);
		expect((await actions(client)).find((e) => e.action === 'auth.password_change')).toMatchObject({ after: { otherSessionsRevoked: 1 } });
	});

	it('change le numéro : code au nouveau numéro, ancien numéro prévenu par SMS, connexion avec le nouveau', async () => {
		const { client, phone, password } = await signedUp(t);
		const next = newPhone();
		expect((await client.call('POST', '/me/phone', { phone: next, password: 'mauvais' })).body).toMatchObject({ code: 'WRONG_PASSWORD' });
		await new Promise((r) => setTimeout(r, 30));
		expect((await client.call('POST', '/me/phone', { phone: next, password })).status).toBe(202);
		const code = t.sms.lastCode(next);
		expect(
			(await client.call('POST', '/me/phone/confirm', { phone: next, code: code === '000000' ? '111111' : '000000' })).body
		).toMatchObject({ code: 'INVALID_CODE' });
		expect((await client.call('POST', '/me/phone/confirm', { phone: next, code })).body).toMatchObject({ phone: next });
		expect(t.sms.messages.filter((m) => m.to === phone).at(-1)?.text).toContain('a été remplacé par');
		expect((await new Client(t.url).call('POST', '/auth/login', { phone: next, password })).status).toBe(200);
		expect((await new Client(t.url).call('POST', '/auth/login', { phone, password })).status).toBe(401);
		expect((await actions(client)).find((e) => e.action === 'auth.phone_change')).toMatchObject({
			before: { phone },
			after: { phone: next }
		});
	});

	it('un numéro déjà pris : même réponse, aucun code ; un code ne sert qu’à la personne qui l’a demandé', async () => {
		const a = await signedUp(t);
		const b = await signedUp(t);
		t.sms.clear();
		expect((await a.client.call('POST', '/me/phone', { phone: b.phone, password: a.password })).status).toBe(202);
		expect(t.sms.messages.filter((m) => m.to === b.phone).map((m) => m.text)).toEqual([expect.stringContaining('existe déjà')]);
		// B demande un nouveau numéro ; A ne peut pas utiliser le code de B.
		const next = newPhone();
		await b.client.call('POST', '/me/phone', { phone: next, password: b.password });
		expect((await a.client.call('POST', '/me/phone/confirm', { phone: next, code: t.sms.lastCode(next) })).body).toMatchObject({
			code: 'INVALID_CODE'
		});
	});
});
