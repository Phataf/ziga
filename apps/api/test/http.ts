/** Outils des tests d'intégration : application démarrée sur un port libre, client HTTP avec cookies. */
import { Writable } from 'node:stream';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AUTH_MESSAGES } from '@ziga/shared/auth';
import { createApp } from '../src/app.factory.js';
import { parseConfig } from '../src/config/env.js';
import { SMS_SENDER, type MemorySmsSender } from '../src/modules/notifications/sms-sender.js';
import { reservePhoneBlock, testRedis } from './test-redis.js';

export const ORIGIN = 'http://localhost:5173';

export interface TestApp {
	app: NestExpressApplication;
	url: string;
	sms: MemorySmsSender;
	/** Toutes les lignes journalisées par l'application. */
	logs: string[];
	close(): Promise<void>;
}

export async function startApp(overrides: Record<string, string> = {}, extraModules: Type[] = []): Promise<TestApp> {
	const logs: string[] = [];
	const logStream = new Writable({
		write(chunk, _enc, cb) {
			logs.push(String(chunk));
			cb();
		}
	});
	const app = await createApp(parseConfig({ ...process.env, LOG_LEVEL: 'trace', ...overrides }), { logStream, extraModules });
	await app.listen(0, '127.0.0.1');
	return { app, url: await app.getUrl(), sms: app.get<MemorySmsSender>(SMS_SENDER), logs, close: () => app.close() };
}

export interface Reply<T = Record<string, unknown>> {
	status: number;
	body: T;
	headers: Headers;
}

/** Un navigateur simplifié : garde le cookie de rafraîchissement entre les appels, envoie l'origine du web. */
export class Client {
	cookie: string | undefined;
	accessToken: string | undefined;

	constructor(
		private readonly base: string,
		private readonly ip = '203.0.113.10',
		private readonly userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36'
	) {}

	async call<T = Record<string, unknown>>(
		method: string,
		path: string,
		body?: unknown,
		extra: Record<string, string> = {}
	): Promise<Reply<T>> {
		const headers: Record<string, string> = {
			origin: ORIGIN,
			'content-type': 'application/json',
			'user-agent': this.userAgent,
			'x-forwarded-for': this.ip,
			...extra
		};
		if (this.cookie) headers.cookie = this.cookie;
		if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
		const res = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		const set = res.headers.get('set-cookie');
		if (set) {
			const value = set.split(';')[0]!;
			this.cookie = value.endsWith('=') ? undefined : value;
		}
		const text = await res.text();
		const parsed = text ? (JSON.parse(text) as T) : ({} as T);
		const token = (parsed as { accessToken?: string }).accessToken;
		if (token) this.accessToken = token;
		return { status: res.status, body: parsed, headers: res.headers };
	}
}

/**
 * Numéros de téléphone des tests : chaque fichier réserve dans Redis un bloc de numéros pour tout le lancement
 * (compteur `ziga:test:phone-block`, remis à zéro avec la base au début du lancement). Deux fichiers ne tirent
 * jamais le même numéro, qu'ils tournent l'un après l'autre ou en même temps.
 * Avant : un départ aléatoire par fichier, puis des numéros qui se suivent. Si la suite d'un fichier entrait dans
 * celle d'un fichier précédent, chaque inscription suivante tombait sur un compte existant (« compte existant »,
 * sans code) : c'est l'échec de la CI sur 3ffa720.
 * Le préfixe 6 évite les numéros fixes des tests (70…, 25…).
 */
export const PHONE_BLOCK_SIZE = 10_000;

/** Le `index`-ième numéro du bloc `block` (pur, testé). */
export function phoneInBlock(block: number, index: number): string {
	if (!Number.isInteger(block) || block < 1 || !Number.isInteger(index) || index < 0 || index >= PHONE_BLOCK_SIZE)
		throw new Error(`Numéro de test hors bloc : bloc ${block}, rang ${index}`);
	const n = block * PHONE_BLOCK_SIZE + index;
	if (n >= 10_000_000) throw new Error('Plus de blocs de numéros de test disponibles.');
	return `+2266${String(n).padStart(7, '0')}`;
}

/** Bloc de ce fichier. */
export const phoneBlock = await (async () => {
	const redis = testRedis();
	try {
		await redis.connect();
		return await reservePhoneBlock(redis);
	} finally {
		redis.disconnect();
	}
})();
let used = 0;
export function newPhone(): string {
	return phoneInBlock(phoneBlock, used++);
}

/** Inscrit et vérifie une personne ; renvoie le client connecté. */
export async function signedUp(
	t: TestApp,
	phone = newPhone(),
	password = 'motdepasse-solide',
	ip?: string
): Promise<{ client: Client; phone: string; password: string }> {
	const client = new Client(t.url, ip);
	const sent = t.sms.messages.length;
	const r = await client.call('POST', '/auth/register', { phone, name: 'Awa Ouédraogo', password });
	if (r.status !== 202) throw new Error(`inscription : ${r.status} ${JSON.stringify(r.body)}`);
	// Seul le SMS de cette inscription compte : un code plus ancien au même numéro ne doit pas masquer un « compte existant ».
	const reply = t.sms.messages
		.slice(sent)
		.filter((m) => m.to === phone)
		.at(-1);
	const code = reply?.text.match(/\b(\d{6})\b/)?.[1];
	if (!code)
		throw new Error(
			`inscription : aucun code pour ${phone}${reply?.text === AUTH_MESSAGES.accountExistsSms ? ' (numéro déjà inscrit)' : ''}`
		);
	const v = await client.call('POST', '/auth/verify-phone', { phone, code });
	if (v.status !== 200) throw new Error(`vérification : ${v.status} ${JSON.stringify(v.body)}`);
	return { client, phone, password };
}
