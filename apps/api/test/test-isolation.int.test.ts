/**
 * Isolation des fichiers de tests d'intégration (correctif de la CI sur 3ffa720).
 * Les fichiers tournent l'un après l'autre sur la même base PostgreSQL et la même base Redis :
 * - Redis : chaque fichier part de compteurs de débit vides (test/file-setup.ts), sans que la limite change ;
 * - numéros : chaque fichier a son bloc, réservé pour tout le lancement ; aucun autre fichier n'y écrit.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, newPhone, PHONE_BLOCK_SIZE, phoneBlock, phoneInBlock, signedUp, startApp, type TestApp } from './http.js';
import { PHONE_BLOCK_KEY, resetSharedRedisState, reservePhoneBlock, testRedis } from './test-redis.js';

const redis = testRedis();
let admin: pg.Client;

async function keys(pattern: string): Promise<string[]> {
	const found: string[] = [];
	let cursor = '0';
	do {
		const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
		cursor = next;
		found.push(...batch);
	} while (cursor !== '0');
	return found;
}

async function usersInBlock(block: number): Promise<number> {
	const r = await admin.query<{ n: number }>('select count(*)::int as n from users where phone between $1 and $2', [
		phoneInBlock(block, 0),
		phoneInBlock(block, PHONE_BLOCK_SIZE - 1)
	]);
	return r.rows[0]!.n;
}

/** Quatre demandes depuis la même adresse, avec un plafond de 3 par minute. */
async function forgotFourTimes(app: TestApp, ip: string): Promise<number[]> {
	const client = new Client(app.url, ip);
	const codes: number[] = [];
	for (let i = 0; i < 4; i++) codes.push((await client.call('POST', '/auth/password/forgot', { phone: newPhone() })).status);
	return codes;
}

beforeAll(async () => {
	await redis.connect();
	admin = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await admin.connect();
});
afterAll(async () => {
	redis.disconnect();
	await admin.end();
});

describe('Redis : chaque fichier part de compteurs vides', () => {
	it('au départ du fichier, aucun compteur de débit ni délai laissé par les fichiers précédents', async () => {
		// Premier test du fichier : aucune application n'a encore servi de requête.
		expect(await keys('ziga:auth:*')).toEqual([]);
		expect(Number(await redis.get(PHONE_BLOCK_KEY))).toBeGreaterThanOrEqual(phoneBlock);
	});

	it('un plafond atteint par un fichier ne pèse pas sur le suivant, et la limite reste entière', async () => {
		const ip = '198.51.100.200';
		// Le « fichier précédent » épuise le plafond de cette adresse.
		const before = await startApp({ RATE_LIMIT_PER_IP_PER_MINUTE: '3' });
		try {
			expect(await forgotFourTimes(before, ip)).toEqual([202, 202, 202, 429]);
		} finally {
			await before.close();
		}
		expect((await keys('ziga:auth:ip:*')).length).toBeGreaterThan(0);

		// Ce que fait test/file-setup.ts avant chaque fichier.
		expect(await resetSharedRedisState(redis)).toBeGreaterThan(0);
		expect(await keys('ziga:auth:*')).toEqual([]);
		expect(Number(await redis.get(PHONE_BLOCK_KEY))).toBeGreaterThanOrEqual(phoneBlock);

		// Le « fichier suivant » repart de zéro, avec la même limite : la 4e demande est toujours refusée.
		const after = await startApp({ RATE_LIMIT_PER_IP_PER_MINUTE: '3' });
		try {
			expect(await forgotFourTimes(after, ip)).toEqual([202, 202, 202, 429]);
		} finally {
			await after.close();
		}
	});

	it('refuse de remettre à zéro une autre base Redis que celle des tests', () => {
		const other = new URL(process.env.REDIS_URL!);
		other.pathname = '/0';
		expect(() => testRedis(other.toString())).toThrow(/doit être la n° 1/);
	});
});

describe('numéros de téléphone : un bloc par fichier', () => {
	let t: TestApp;
	beforeAll(async () => {
		t = await startApp();
	});
	afterAll(async () => {
		await t.close();
	});

	it('deux fichiers ne reçoivent jamais le même bloc, et deux blocs ne se recoupent pas', async () => {
		const other = await reservePhoneBlock(redis); // ce que fait le fichier suivant
		expect(other).toBeGreaterThan(phoneBlock);
		const mine = new Set(Array.from({ length: PHONE_BLOCK_SIZE }, (_, i) => phoneInBlock(phoneBlock, i)));
		const theirs = Array.from({ length: PHONE_BLOCK_SIZE }, (_, i) => phoneInBlock(other, i));
		expect(mine.size).toBe(PHONE_BLOCK_SIZE);
		expect(theirs.filter((p) => mine.has(p))).toEqual([]);
		expect(() => phoneInBlock(phoneBlock, PHONE_BLOCK_SIZE)).toThrow(/hors bloc/);
		for (const p of [...mine].slice(0, 3)) expect(p).toMatch(/^\+2266\d{7}$/);
	});

	it('aucun fichier précédent n’a inscrit de compte dans le bloc de ce fichier', async () => {
		const before = await usersInBlock(phoneBlock);
		await signedUp(t);
		await signedUp(t);
		expect(await usersInBlock(phoneBlock)).toBe(before + 2);
		expect(before).toBe(0);
	});

	it('la collision de la CI, rejouée : un numéro déjà inscrit est signalé comme tel, pas par un 400 opaque', async () => {
		const { phone } = await signedUp(t);
		await expect(signedUp(t, phone)).rejects.toThrow(`inscription : aucun code pour ${phone} (numéro déjà inscrit)`);
	});
});
