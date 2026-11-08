/**
 * Logo de l'organisation (lot 03) : PNG, JPEG ou WebP de 2 Mo au plus (SVG refusé), traité par sharp dans le
 * worker (WebP pour le web, PNG pour les PDF), servi publiquement ; chaque version est gardée (D29).
 */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { newId } from '@ziga/shared/ids';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { WorkerModule } from '../src/worker.module.js';
import { ORIGIN, startApp, type TestApp } from './http.js';
import { addMember, createOrg, type Org } from './orgs.js';

let t: TestApp;
let worker: INestApplicationContext;

beforeAll(async () => {
	t = await startApp();
	worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(parseConfig(process.env)), { logger: false });
	await worker.init();
});
afterAll(async () => {
	await worker.close();
	await t.close();
});

const image = (format: 'png' | 'jpeg' | 'webp', size = 1200) =>
	sharp({ create: { width: size, height: size / 2, channels: 3, background: '#1f6f4a' } })
		.toFormat(format)
		.toBuffer();

async function upload(org: Org, body: Buffer, type: string) {
	const res = await fetch(`${t.url}/organization/logo`, {
		method: 'PUT',
		headers: {
			authorization: `Bearer ${org.director.client.accessToken}`,
			'x-organization-id': org.id,
			'content-type': type,
			origin: ORIGIN
		},
		body
	});
	return {
		status: res.status,
		body: (await res.json()) as { code?: string; logo?: { id: string; status: string; webUrl: string | null; pdfUrl: string | null } }
	};
}

async function waitReady(org: Org, logoId: string) {
	for (let i = 0; i < 100; i += 1) {
		const view = (
			await org.director.call<{ logo: { id: string; status: string; webUrl: string; pdfUrl: string } | null }>('GET', '/organization')
		).body;
		if (view.logo?.id === logoId && view.logo.status !== 'processing') {
			// Adresses publiques construites sur API_PUBLIC_URL : ramenées vers l'API de test (port libre).
			const local = (u: string | null) => (u ? new URL(new URL(u).pathname, t.url).toString() : u);
			return { ...view.logo, webUrl: local(view.logo.webUrl)!, pdfUrl: local(view.logo.pdfUrl)! };
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('logo non traité');
}

describe('logo', () => {
	it('PNG envoyé, traité par le worker : WebP (512 px au plus) et PNG pour les PDF, servis publiquement', async () => {
		const org = await createOrg(t);
		const r = await upload(org, await image('png'), 'image/png');
		expect(r.status).toBe(200);
		expect(r.body.logo).toMatchObject({ status: 'processing', webUrl: null });
		const logo = await waitReady(org, r.body.logo!.id);
		expect(logo.status).toBe('ready');
		const web = await fetch(logo.webUrl);
		expect(web.headers.get('content-type')).toBe('image/webp');
		expect(web.headers.get('cache-control')).toContain('immutable');
		const meta = await sharp(Buffer.from(await web.arrayBuffer())).metadata();
		expect(meta).toMatchObject({ format: 'webp', width: 512, height: 256 });
		const print = await fetch(logo.pdfUrl);
		expect((await sharp(Buffer.from(await print.arrayBuffer())).metadata()).format).toBe('png');
		// L'original n'est jamais servi.
		expect((await fetch(logo.webUrl.replace('web.webp', 'original'))).status).toBe(404);
		const audit = (await org.director.call<{ entries: { action: string; origin: string }[] }>('GET', '/organization/audit')).body.entries;
		expect(audit.find((e) => e.action === 'organization.logo.upload')?.origin).toBe('app');
		expect(audit.find((e) => e.action === 'organization.logo.activate')?.origin).toBe('job');
	});

	it('remplacer le logo garde l’ancien fichier (documents déjà émis, D29)', async () => {
		const org = await createOrg(t);
		const first = await waitReady(org, (await upload(org, await image('jpeg'), 'image/jpeg')).body.logo!.id);
		const second = await waitReady(org, (await upload(org, await image('webp', 600), 'image/webp')).body.logo!.id);
		expect(second.id).not.toBe(first.id);
		expect((await fetch(first.webUrl)).status).toBe(200);
		expect((await org.director.call<{ logo: { id: string } }>('GET', '/organization')).body.logo.id).toBe(second.id);
	});

	it('refuse le SVG, un type annoncé faux, un fichier vide ou de plus de 2 Mo', async () => {
		const org = await createOrg(t);
		const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
		expect((await upload(org, svg, 'image/svg+xml')).body.code).toBe('LOGO_TYPE');
		expect((await upload(org, svg, 'image/png')).body.code).toBe('LOGO_TYPE');
		expect((await upload(org, await image('jpeg'), 'image/png')).body.code).toBe('LOGO_TYPE');
		expect((await upload(org, Buffer.alloc(0), 'image/png')).body.code).toBe('LOGO_EMPTY');
		const big = Buffer.concat([await image('png'), Buffer.alloc(2 * 1024 * 1024)]);
		expect(await upload(org, big, 'image/png')).toMatchObject({ status: 413, body: { code: 'LOGO_TOO_LARGE' } });
	});

	it('une image illisible est marquée en échec, sans remplacer le logo actuel', async () => {
		const org = await createOrg(t);
		const good = await waitReady(org, (await upload(org, await image('png'), 'image/png')).body.logo!.id);
		const broken = Buffer.concat([(await image('png')).subarray(0, 40)]);
		const failed = await waitReady(org, (await upload(org, broken, 'image/png')).body.logo!.id);
		expect(failed.status).toBe('failed');
		// Le logo actif reste le bon : un fichier illisible ne remplace rien.
		await new Promise((r) => setTimeout(r, 50));
		const view = (await org.director.call<{ logo: { id: string; status: string } }>('GET', '/organization')).body;
		expect(view.logo).toMatchObject({ id: failed.id, status: 'failed' });
		expect((await fetch(good.webUrl)).status).toBe(200);
	});

	it('seul le directeur change le logo ; un logo inconnu répond 404', async () => {
		const org = await createOrg(t);
		const manager = await addMember(t, org, 'manager');
		const res = await fetch(`${t.url}/organization/logo`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${manager.client.accessToken}`, 'x-organization-id': org.id, 'content-type': 'image/png' },
			body: await image('png')
		});
		expect(res.status).toBe(403);
		expect((await fetch(`${t.url}/logos/${org.id}/${newId()}/web.webp`)).status).toBe(404);
		expect((await fetch(`${t.url}/logos/${org.id}/${newId()}/..%2Foriginal`)).status).toBe(404);
	});
});
