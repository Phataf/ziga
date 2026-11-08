/**
 * Authentification (lot 02), sur la vraie base et le vrai Redis.
 * Inscription, vérification, connexion, rafraîchissement avec rotation, déconnexion, mot de passe oublié,
 * limites de débit, délais progressifs, réponses qui ne révèlent rien, journaux sans secret.
 */
import { createLocalJWKSet, jwtVerify } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, newPhone, signedUp, startApp, type TestApp } from './http.js';

const INVALID = { code: 'INVALID_CREDENTIALS', message: 'Numéro ou mot de passe incorrect.' };
let t: TestApp;
let admin: pg.Client;

beforeAll(async () => {
	t = await startApp();
	admin = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await admin.connect();
});
afterAll(async () => {
	await t.close();
	await admin.end();
});

describe('inscription, vérification et connexion', () => {
	it('inscrit, vérifie le numéro, ouvre une session, puis rafraîchit et déconnecte', async () => {
		const phone = newPhone();
		const client = new Client(t.url);
		const reg = await client.call('POST', '/auth/register', {
			phone: phone.replace('+226', ''),
			name: '  Issouf Sawadogo ',
			password: 'motdepasse1'
		});
		expect(reg).toMatchObject({ status: 202, body: { message: 'Si ce numéro peut recevoir un code, un SMS vient d’être envoyé.' } });
		const code = t.sms.lastCode(phone);
		expect(code).toMatch(/^\d{6}$/);

		const verified = await client.call<{ accessToken: string; expiresIn: number; user: { name: string; phone: string } }>(
			'POST',
			'/auth/verify-phone',
			{ phone, code }
		);
		expect(verified.status).toBe(200);
		expect(verified.body).toMatchObject({ expiresIn: 900, user: { name: 'Issouf Sawadogo', phone, platformRole: null } });
		expect(verified.headers.get('set-cookie')).toMatch(/^__Host-ziga_rt=.+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);

		// Une personne sans organisation se connecte sans erreur (son espace personnel est vide).
		expect((await client.call('GET', '/me')).status).toBe(200);

		const before = client.cookie;
		const refreshed = await client.call('POST', '/auth/refresh');
		expect(refreshed.status).toBe(200);
		expect(client.cookie).not.toBe(before);
		expect((await client.call('GET', '/me')).status).toBe(200);

		expect((await client.call('POST', '/auth/logout')).status).toBe(204);
		expect(client.cookie).toBeUndefined();
		const stale = new Client(t.url);
		stale.cookie = refreshed.headers.get('set-cookie')!.split(';')[0];
		expect((await stale.call('POST', '/auth/refresh')).status).toBe(401);
	});

	it('se connecte par téléphone et mot de passe, depuis un numéro saisi en national', async () => {
		const { phone, password } = await signedUp(t);
		const client = new Client(t.url);
		const r = await client.call('POST', '/auth/login', { phone: phone.replace('+226', '').replace(/(\d{2})(?=\d)/g, '$1 '), password });
		expect(r.status).toBe(200);
		expect((await client.call('GET', '/me')).body).toMatchObject({ phone });
	});

	it('accepte un numéro de la diaspora (E.164 de tout pays)', async () => {
		const phone = '+33612' + String(Date.now()).slice(-6);
		const { client } = await signedUp(t, phone);
		expect((await client.call('GET', '/me')).body).toMatchObject({ phone });
	});

	it('refuse la connexion d’un compte dont le numéro n’est pas vérifié, et renvoie un code', async () => {
		const phone = newPhone();
		const client = new Client(t.url);
		await client.call('POST', '/auth/register', { phone, name: 'Awa', password: 'motdepasse1' });
		t.sms.clear();
		const r = await client.call('POST', '/auth/login', { phone, password: 'motdepasse1' });
		expect(r).toMatchObject({ status: 403, body: { code: 'PHONE_NOT_VERIFIED' } });
		expect(t.sms.lastCode(phone)).toMatch(/^\d{6}$/);
	});

	it('donne le même message pour un numéro inconnu et un mauvais mot de passe', async () => {
		const { phone } = await signedUp(t);
		const unknown = await new Client(t.url, '198.51.100.1').call('POST', '/auth/login', { phone: newPhone(), password: 'quelconque' });
		const wrong = await new Client(t.url, '198.51.100.2').call('POST', '/auth/login', { phone, password: 'pas-le-bon' });
		expect(unknown.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect(unknown.body).toEqual(INVALID);
		expect(wrong.body).toEqual(INVALID);
	});

	it('inscription avec un numéro déjà vérifié : même réponse, et un SMS qui renvoie vers « Mot de passe oublié »', async () => {
		const { phone } = await signedUp(t);
		t.sms.clear();
		const r = await new Client(t.url).call('POST', '/auth/register', { phone, name: 'Autre', password: 'autre-mot-de-passe' });
		expect(r).toMatchObject({ status: 202, body: { message: 'Si ce numéro peut recevoir un code, un SMS vient d’être envoyé.' } });
		expect(t.sms.messages).toEqual([{ to: phone, text: 'Un compte Ziga existe déjà pour ce numéro. Utilisez « Mot de passe oublié ».' }]);
		// Le mot de passe du compte existant n'a pas changé.
		expect((await new Client(t.url).call('POST', '/auth/login', { phone, password: 'motdepasse-solide' })).status).toBe(200);
	});
});

describe('codes à usage unique', () => {
	it('refuse un code expiré', async () => {
		const phone = newPhone();
		const client = new Client(t.url);
		await client.call('POST', '/auth/register', { phone, name: 'Awa', password: 'motdepasse1' });
		await admin.query(`update otp_codes set expires_at = now() - interval '1 second' where phone = $1`, [phone]);
		const r = await client.call('POST', '/auth/verify-phone', { phone, code: t.sms.lastCode(phone) });
		expect(r).toMatchObject({ status: 400, body: { code: 'INVALID_CODE', message: 'Code incorrect ou expiré.' } });
	});

	it('refuse un code déjà utilisé', async () => {
		const { phone } = await signedUp(t);
		const r = await new Client(t.url).call('POST', '/auth/verify-phone', { phone, code: t.sms.lastCode(phone) });
		expect(r.status).toBe(400);
	});

	it('refuse le 6e essai, même avec le bon code', async () => {
		const phone = newPhone();
		const client = new Client(t.url);
		await client.call('POST', '/auth/register', { phone, name: 'Awa', password: 'motdepasse1' });
		const code = t.sms.lastCode(phone)!;
		const wrong = code === '000000' ? '111111' : '000000';
		for (let i = 0; i < 5; i++) expect((await client.call('POST', '/auth/verify-phone', { phone, code: wrong })).status).toBe(400);
		expect((await client.call('POST', '/auth/verify-phone', { phone, code })).status).toBe(400);
	});

	it('ne garde en base que l’empreinte du code', async () => {
		const phone = newPhone();
		await new Client(t.url).call('POST', '/auth/register', { phone, name: 'Awa', password: 'motdepasse1' });
		const code = t.sms.lastCode(phone)!;
		const { rows } = await admin.query(`select encode(code_hash, 'hex') as h from otp_codes where phone = $1`, [phone]);
		expect(rows[0].h).toHaveLength(64);
		expect(rows[0].h).not.toContain(code);
	});
});

describe('rotation du jeton de rafraîchissement', () => {
	it('un ancien jeton réutilisé hors du délai de grâce révoque toutes les sessions de la personne', async () => {
		const strict = await startApp({ AUTH_REFRESH_REUSE_GRACE_SECONDS: '0' });
		try {
			const { client, phone, password } = await signedUp(strict);
			const other = new Client(strict.url, '203.0.113.99');
			expect((await other.call('POST', '/auth/login', { phone, password })).status).toBe(200);

			const stolen = client.cookie;
			expect((await client.call('POST', '/auth/refresh')).status).toBe(200);
			const thief = new Client(strict.url);
			thief.cookie = stolen;
			await new Promise((r) => setTimeout(r, 20));
			expect((await thief.call('POST', '/auth/refresh')).status).toBe(401);
			// Toutes les sessions sont révoquées, y compris celle de l'autre appareil.
			expect((await client.call('POST', '/auth/refresh')).status).toBe(401);
			expect((await other.call('POST', '/auth/refresh')).status).toBe(401);
			const { rows } = await admin.query(
				`select distinct revoked_reason from sessions s join users u on u.id = s.user_id where u.phone = $1`,
				[phone]
			);
			expect(rows).toEqual([{ revoked_reason: 'reuse_detected' }]);
		} finally {
			await strict.close();
		}
	});

	it('dans le délai de grâce (10 s), une réutilisation est simplement refusée, sans révocation', async () => {
		const { client } = await signedUp(t);
		const old = client.cookie;
		expect((await client.call('POST', '/auth/refresh')).status).toBe(200);
		const slowTab = new Client(t.url);
		slowTab.cookie = old;
		const r = await slowTab.call('POST', '/auth/refresh');
		expect(r).toMatchObject({ status: 409, body: { code: 'REFRESH_CONFLICT' } });
		expect((await client.call('POST', '/auth/refresh')).status).toBe(200);
	});

	it('ne stocke que l’empreinte des jetons de rafraîchissement', async () => {
		const { client, phone } = await signedUp(t);
		const token = decodeURIComponent(client.cookie!.split('=')[1]!);
		const { rows } = await admin.query(
			`select encode(token_hash, 'hex') as h from refresh_tokens r join users u on u.id = r.user_id where u.phone = $1`,
			[phone]
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) expect(r.h).not.toContain(token.split('.')[1]);
	});

	it('refuse le rafraîchissement depuis une origine non autorisée, ou sans JSON', async () => {
		const { client } = await signedUp(t);
		expect((await client.call('POST', '/auth/refresh', undefined, { origin: 'https://ziga-staging.com' })).status).toBe(403);
		expect((await client.call('POST', '/auth/refresh', undefined, { 'content-type': 'text/plain' })).status).toBe(403);
		expect((await client.call('POST', '/auth/refresh')).status).toBe(200);
	});
});

describe('mot de passe oublié', () => {
	it('change le mot de passe par code SMS et révoque toutes les autres sessions', async () => {
		const { client, phone } = await signedUp(t);
		const helper = new Client(t.url);
		expect((await helper.call('POST', '/auth/password/forgot', { phone })).status).toBe(202);
		const r = await helper.call('POST', '/auth/password/reset', { phone, code: t.sms.lastCode(phone), password: 'nouveau-mot-de-passe' });
		expect(r.status).toBe(200);
		expect((await client.call('POST', '/auth/refresh')).status).toBe(401);
		expect((await new Client(t.url).call('POST', '/auth/login', { phone, password: 'nouveau-mot-de-passe' })).status).toBe(200);
		expect((await new Client(t.url, '198.51.100.7').call('POST', '/auth/login', { phone, password: 'motdepasse-solide' })).status).toBe(
			401
		);
	});

	it('répond pareil pour un numéro inconnu, sans envoyer de SMS', async () => {
		t.sms.clear();
		const phone = newPhone();
		const r = await new Client(t.url).call('POST', '/auth/password/forgot', { phone });
		expect(r).toMatchObject({ status: 202, body: { message: 'Si ce numéro peut recevoir un code, un SMS vient d’être envoyé.' } });
		expect(t.sms.messages).toEqual([]);
	});
});

describe('limites de débit et délais progressifs', () => {
	it('limite les connexions par numéro (5 par minute)', async () => {
		const throttled = await startApp({ AUTH_FAILURE_BASE_DELAY_MS: '10', AUTH_FAILURE_MAX_DELAY_MS: '10' });
		try {
			const phone = newPhone();
			const codes: number[] = [];
			for (let i = 0; i < 6; i++) {
				codes.push((await new Client(throttled.url, `198.51.100.${30 + i}`).call('POST', '/auth/login', { phone, password: 'x' })).status);
				await new Promise((r) => setTimeout(r, 15));
			}
			expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
		} finally {
			await throttled.close();
		}
	});

	it('limite les envois de SMS par numéro, quelle que soit l’adresse', async () => {
		const limited = await startApp({ OTP_SEND_INTERVAL_SECONDS: '60' });
		try {
			const phone = newPhone();
			expect((await new Client(limited.url, '198.51.100.50').call('POST', '/auth/password/forgot', { phone })).status).toBe(202);
			const second = await new Client(limited.url, '198.51.100.51').call('POST', '/auth/password/forgot', { phone });
			expect(second.status).toBe(429);
			expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
		} finally {
			await limited.close();
		}
	});

	it('plafonne les demandes par adresse IP (réglable)', async () => {
		const capped = await startApp({ RATE_LIMIT_PER_IP_PER_MINUTE: '3' });
		try {
			const client = new Client(capped.url, '198.51.100.60');
			const codes = [];
			for (let i = 0; i < 4; i++) codes.push((await client.call('POST', '/auth/password/forgot', { phone: newPhone() })).status);
			expect(codes).toEqual([202, 202, 202, 429]);
		} finally {
			await capped.close();
		}
	});

	it('allonge le délai à chaque échec (1, 2, 4… unités), puis le lève après une connexion réussie', async () => {
		const slow = await startApp({
			AUTH_FAILURE_BASE_DELAY_MS: '200',
			AUTH_FAILURE_MAX_DELAY_MS: '800',
			RATE_LIMIT_LOGIN_PER_PHONE_PER_MINUTE: '100'
		});
		try {
			const { phone, password } = await signedUp(slow);
			const client = new Client(slow.url, '198.51.100.70');
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
			expect((await client.call('POST', '/auth/login', { phone, password: 'faux' })).status).toBe(401);
			// Pendant le délai, même le bon mot de passe attend.
			const early = await client.call('POST', '/auth/login', { phone, password });
			expect(early).toMatchObject({ status: 429, body: { code: 'RETRY_LATER' } });
			await sleep(220);
			expect((await client.call('POST', '/auth/login', { phone, password: 'faux' })).status).toBe(401);
			await sleep(220);
			expect((await client.call('POST', '/auth/login', { phone, password })).status).toBe(429); // 2e délai : 400 ms
			await sleep(200);
			expect((await client.call('POST', '/auth/login', { phone, password })).status).toBe(200);
			expect((await client.call('POST', '/auth/login', { phone, password })).status).toBe(200);
		} finally {
			await slow.close();
		}
	});

	it('applique aussi le délai aux numéros inconnus (rien n’est révélé)', async () => {
		const client = new Client(t.url, '198.51.100.80');
		const phone = newPhone();
		expect((await client.call('POST', '/auth/login', { phone, password: 'x' })).status).toBe(401);
		expect((await client.call('POST', '/auth/login', { phone, password: 'x' })).status).toBe(429);
	});

	it('laisse une marge d’échecs à une adresse IP partagée avant son propre délai', async () => {
		const shared = await startApp({ AUTH_IP_FAILURE_ALLOWANCE: '3', AUTH_FAILURE_BASE_DELAY_MS: '5000' });
		try {
			const codes = [];
			for (let i = 0; i < 5; i++)
				codes.push(
					(await new Client(shared.url, '198.51.100.90').call('POST', '/auth/login', { phone: newPhone(), password: 'x' })).status
				);
			expect(codes).toEqual([401, 401, 401, 401, 429]);
		} finally {
			await shared.close();
		}
	});
});

describe('appareils connectés', () => {
	it('liste ses appareils et en déconnecte un', async () => {
		const { client, phone, password } = await signedUp(t);
		const laptop = new Client(t.url, '203.0.113.20', 'Mozilla/5.0 (Windows NT 10.0) Firefox/131.0');
		await laptop.call('POST', '/auth/login', { phone, password });
		const list = await client.call<{ id: string; deviceLabel: string; current: boolean }[]>('GET', '/sessions');
		expect(list.body.map((s) => [s.deviceLabel, s.current]).sort()).toEqual([
			['Chrome sur Android', true],
			['Firefox sur Windows', false]
		]);
		const target = list.body.find((s) => !s.current)!;
		expect((await client.call('DELETE', `/sessions/${target.id}`)).status).toBe(204);
		expect((await laptop.call('POST', '/auth/refresh')).status).toBe(401);
	});

	it('ne peut ni voir ni déconnecter l’appareil d’une autre personne', async () => {
		const a = await signedUp(t);
		const b = await signedUp(t);
		const bSessions = await b.client.call<{ id: string }[]>('GET', '/sessions');
		const aSessions = await a.client.call<{ id: string }[]>('GET', '/sessions');
		expect(aSessions.body.map((s) => s.id)).not.toContain(bSessions.body[0]!.id);
		expect((await a.client.call('DELETE', `/sessions/${bSessions.body[0]!.id}`)).status).toBe(404);
		expect((await b.client.call('POST', '/auth/refresh')).status).toBe(200);
	});
});

describe('jetons d’accès et clés publiques', () => {
	it('publie les clés publiques (JWKS) avec leur identifiant ; le jeton d’accès s’y vérifie', async () => {
		const { client } = await signedUp(t);
		const jwks = (await (await fetch(`${t.url}/.well-known/jwks.json`)).json()) as {
			keys: { kid: string; alg: string; kty: string; d?: string }[];
		};
		expect(jwks.keys[0]).toMatchObject({ kid: expect.any(String), alg: 'EdDSA', kty: 'OKP' });
		expect(jwks.keys[0]!.d).toBeUndefined(); // jamais la clé privée
		const { payload, protectedHeader } = await jwtVerify(client.accessToken!, createLocalJWKSet(jwks as never), { audience: 'ziga' });
		expect(protectedHeader.kid).toBe(jwks.keys[0]!.kid);
		expect(payload).toMatchObject({ sub: expect.any(String), sid: expect.any(String), prole: null });
	});

	it('refuse un jeton altéré ou absent', async () => {
		const { client } = await signedUp(t);
		const forged = `${client.accessToken!.slice(0, -4)}AAAA`;
		const r = await fetch(`${t.url}/me`, { headers: { authorization: `Bearer ${forged}` } });
		expect(r.status).toBe(401);
		expect((await fetch(`${t.url}/me`)).status).toBe(401);
	});
});

describe('garde global', () => {
	it('toutes les routes exigent un jeton, sauf les exceptions explicites', async () => {
		const router = t.app.getHttpAdapter().getInstance().router as {
			stack: { route?: { path: string; methods: Record<string, boolean> } }[];
		};
		// Les routes de l'application (les gestionnaires génériques d'Express, « {/*splat} », n'en sont pas).
		const routes = router.stack
			.flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route!.path })) : []))
			.filter((r) => !r.path.includes('splat') && r.method !== '_ALL');
		const publicRoutes = new Set([
			'GET /health/live',
			'GET /health/ready',
			'GET /.well-known/jwks.json',
			'POST /auth/register',
			'POST /auth/verify-phone',
			'POST /auth/login',
			'POST /auth/refresh',
			'POST /auth/logout',
			'POST /auth/password/forgot',
			'POST /auth/password/reset'
		]);
		const protectedRoutes = routes.filter((r) => !publicRoutes.has(`${r.method} ${r.path}`));
		expect(protectedRoutes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['DELETE /sessions/:id', 'GET /me', 'GET /sessions']);
		for (const r of protectedRoutes) {
			const res = await fetch(`${t.url}${r.path.replace(':id', '01a1bc57-187b-7030-be02-8c1b98a5f924')}`, { method: r.method });
			expect(res.status, `${r.method} ${r.path}`).toBe(401);
		}
	});
});

describe('base : règles d’accès par personne (RLS)', () => {
	it('app_api ne voit les sessions et les jetons que dans le contexte de leur personne', async () => {
		const a = await signedUp(t);
		const b = await signedUp(t);
		const api = new pg.Client({ connectionString: process.env.DATABASE_URL });
		await api.connect();
		try {
			const id = async (phone: string) => (await admin.query(`select id from users where phone = $1`, [phone])).rows[0].id as string;
			const [aId, bId] = [await id(a.phone), await id(b.phone)];
			// Hors contexte : rien.
			expect((await api.query('select count(*)::int as n from sessions')).rows[0].n).toBe(0);
			expect((await api.query('select count(*)::int as n from refresh_tokens')).rows[0].n).toBe(0);
			await api.query('begin');
			await api.query(`select set_config('app.user_id', $1, true)`, [aId]);
			const seen = await api.query('select distinct user_id from sessions');
			expect(seen.rows).toEqual([{ user_id: aId }]);
			// Ni modification ni insertion pour une autre personne.
			expect((await api.query(`update sessions set revoked_at = now() where user_id = $1`, [bId])).rowCount).toBe(0);
			await expect(
				api.query(`insert into sessions (id, user_id, device_label, expires_at) values (gen_random_uuid(), $1, 'x', now())`, [bId])
			).rejects.toThrow(/row-level security/);
			await api.query('rollback');
			// Les jetons émis ne se suppriment pas.
			await expect(api.query('delete from refresh_tokens')).rejects.toThrow(/permission denied/);
		} finally {
			await api.end();
		}
	});
});
