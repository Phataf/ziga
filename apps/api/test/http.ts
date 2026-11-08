/** Outils des tests d'intégration : application démarrée sur un port libre, client HTTP avec cookies. */
import { Writable } from 'node:stream';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../src/app.factory.js';
import { parseConfig } from '../src/config/env.js';
import { SMS_SENDER, type MemorySmsSender } from '../src/modules/notifications/sms-sender.js';

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
 * Numéro du Burkina unique pour chaque test (la base est partagée par les fichiers de test, qui tournent en
 * parallèle). Le chiffre du processus de Vitest sépare les fichiers simultanés ; le départ aléatoire sépare les
 * fichiers qui se suivent dans un même processus ; le préfixe 6 évite les numéros fixes des tests (70…).
 * Avant, trois chiffres de l'horloge et un compteur par fichier pouvaient donner le même numéro à deux fichiers :
 * la seconde inscription recevait « compte existant », sans code.
 */
const worker = Number(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 0) % 10;
let next = Math.floor(Math.random() * 1_000_000);
export function newPhone(): string {
	next = (next + 1) % 1_000_000;
	return `+2266${worker}${String(next).padStart(6, '0')}`;
}

/** Inscrit et vérifie une personne ; renvoie le client connecté. */
export async function signedUp(
	t: TestApp,
	phone = newPhone(),
	password = 'motdepasse-solide',
	ip?: string
): Promise<{ client: Client; phone: string; password: string }> {
	const client = new Client(t.url, ip);
	const r = await client.call('POST', '/auth/register', { phone, name: 'Awa Ouédraogo', password });
	if (r.status !== 202) throw new Error(`inscription : ${r.status} ${JSON.stringify(r.body)}`);
	const code = t.sms.lastCode(phone);
	const v = await client.call('POST', '/auth/verify-phone', { phone, code });
	if (v.status !== 200) throw new Error(`vérification : ${v.status} ${JSON.stringify(v.body)}`);
	return { client, phone, password };
}
