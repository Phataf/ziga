/**
 * Lot 07, étape 3 : photos et documents, avec le stockage local (même contrat que S3 : PUT signé qui fixe le type et la
 * taille, lecture signée) et le worker qui traite les photos.
 * - Photo de 4 Mo avec position GPS : variantes WebP sans aucune métadonnée, la moyenne sous 200 Ko ; original effacé,
 *   jamais servi ; variantes servies sous leur clé aléatoire.
 * - Seconde barrière : taille et type réels ; la 16e photo d'une unité est refusée ; l'agent de terrain, ses unités.
 * - Documents : dépôt signé, empreinte SHA-256, versions ; lecture par URL signée de 5 minutes, journalisée ; matrice
 *   et restriction ; jamais sans signature ; accès croisé A/B.
 */
import { createHash } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DocumentDownload, DocumentView } from '@ziga/shared/documents';
import { newId } from '@ziga/shared/ids';
import type { OwnerView } from '@ziga/shared/owners';
import type { MediaView, PropertyView, UnitView } from '@ziga/shared/properties';
import type { SyncOperationResult } from '@ziga/shared/sync';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import type { PresignedUpload } from '../src/storage/storage.js';
import { WorkerModule } from '../src/worker.module.js';
import { newPhone, startApp, type TestApp } from './http.js';
import { addMember, createOrg, type Member, type Org } from './orgs.js';

let t: TestApp;
let worker: INestApplicationContext;
let a: Org;
let b: Org;
let manager: Member;
let agent: Member;
let viewer: Member;
let owner: pg.Client;
let property: PropertyView;
let unit: UnitView;
let otherUnit: UnitView;
let photo4mb: Buffer;

/** Adresses construites sur API_PUBLIC_URL : ramenées vers l'API de test (port libre). */
const local = (u: string) => new URL(new URL(u).pathname + new URL(u).search, t.url).toString();

async function put(upload: PresignedUpload, body: Buffer, type = upload.headers['content-type']): Promise<number> {
	const r = await fetch(local(upload.url), { method: 'PUT', body, headers: { 'content-type': type } });
	return r.status;
}

/** Photo synthétique proche d'une vraie (dégradés et grain), 4 Mo environ, avec une position GPS dans ses EXIF. */
async function makePhoto(width = 3200, height = 2400, quality = 94): Promise<Buffer> {
	const raw = Buffer.alloc(width * height * 3);
	let seed = 7;
	const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const i = (y * width + x) * 3;
			const n = rnd() * 60;
			raw[i] = (x / width) * 180 + n;
			raw[i + 1] = (y / height) * 160 + n;
			raw[i + 2] = 90 + Math.sin(x / 37) * 40 + n;
		}
	}
	return sharp(raw, { raw: { width, height, channels: 3 } })
		.jpeg({ quality })
		.withExif({
			IFD0: { Make: 'Ziga', Model: 'Test' },
			IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '12/1 22/1 3000/100', GPSLongitudeRef: 'W', GPSLongitude: '1/1 31/1 1200/100' }
		})
		.toBuffer();
}

/** Bloc GPS des EXIF : son pointeur (balise 0x8825), dans un ordre d'octets ou l'autre. */
function hasGpsBlock(exif: Buffer | undefined): boolean {
	return !!exif && (exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88])));
}

async function waitMedia(m: Member, id: string): Promise<MediaView> {
	for (let i = 0; i < 200; i += 1) {
		const view = (await m.call<MediaView>('GET', `/media/${id}`)).body;
		if (view.status !== 'processing') return view;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('photo non traitée');
}

async function announce(m: Member, body: Record<string, unknown>) {
	return m.call<MediaView>('POST', '/media', {
		id: newId(),
		propertyId: property.id,
		unitId: unit.id,
		mimeType: 'image/jpeg',
		byteSize: 1000,
		...body
	});
}

/** Annonce, URL d'envoi, envoi, signal : la photo part au traitement. */
async function sendPhoto(m: Member, file: Buffer, extra: Record<string, unknown> = {}, type = 'image/jpeg'): Promise<MediaView> {
	const created = await announce(m, { mimeType: type, byteSize: file.length, ...extra });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const upload = (await m.call<PresignedUpload>('POST', `/media/${created.body.id}/upload-url`)).body;
	expect(await put(upload, file)).toBe(200);
	expect((await m.call('POST', `/media/${created.body.id}/uploaded`)).status).toBe(200);
	return waitMedia(m, created.body.id);
}

async function audit(organizationId: string, objectId: string) {
	const r = await owner.query(`select action, origin, after from audit_log where organization_id = $1 and object_id = $2 order by id`, [
		organizationId,
		objectId
	]);
	return r.rows as { action: string; origin: string; after: Record<string, unknown> | null }[];
}

beforeAll(async () => {
	t = await startApp();
	worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(parseConfig(process.env)), { logger: false });
	await worker.init();
	a = await createOrg(t, 'agency', 'Agence A photos');
	b = await createOrg(t, 'agency', 'Agence B photos');
	manager = await addMember(t, a, 'manager');
	agent = await addMember(t, a, 'field_agent');
	viewer = await addMember(t, a, 'viewer');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	const o = (await manager.call<OwnerView>('POST', '/owners', { id: newId(), type: 'person', name: 'Rasmata Kaboré', phone: newPhone() }))
		.body;
	property = (
		await manager.call<PropertyView>('POST', '/properties', {
			id: newId(),
			ownerId: o.id,
			type: 'apartment_building',
			name: 'Immeuble photos'
		})
	).body;
	unit = (await manager.call<UnitView>('POST', '/units', { id: newId(), propertyId: property.id, type: 'apartment', label: 'P1' })).body;
	otherUnit = (await manager.call<UnitView>('POST', '/units', { id: newId(), propertyId: property.id, type: 'apartment', label: 'P2' }))
		.body;
	await manager.call('POST', `/units/${unit.id}/assign`, { agentId: agent.userId });
	photo4mb = await makePhoto();
}, 60_000);

afterAll(async () => {
	await owner.end();
	await worker.close();
	await t.close();
});

describe('photos : envoi présigné et variantes (lot 07)', () => {
	it('photo de 4 Mo avec position GPS : variantes WebP sans métadonnée, la moyenne sous 200 Ko ; original effacé', async () => {
		expect(photo4mb.length).toBeGreaterThan(3_800_000);
		expect(hasGpsBlock((await sharp(photo4mb).metadata()).exif)).toBe(true);
		const ready = await sendPhoto(manager, photo4mb);
		expect(ready).toMatchObject({ status: 'ready', width: 1600, height: 1200 });
		const key = ready.variants![320].split('/')[3]!;
		// Clé aléatoire de 128 bits, distincte de l'identifiant.
		expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(key).not.toContain(ready.id);
		for (const size of [320, 800, 1600] as const) {
			const r = await fetch(new URL(ready.variants![size], t.url));
			expect(r.status).toBe(200);
			expect(r.headers.get('content-type')).toBe('image/webp');
			expect(r.headers.get('cache-control')).toContain('immutable');
			const body = Buffer.from(await r.arrayBuffer());
			const meta = await sharp(body).metadata();
			expect(meta.exif, `EXIF ${size}`).toBeUndefined();
			expect(meta.xmp, `XMP ${size}`).toBeUndefined();
			expect(Math.max(meta.width!, meta.height!)).toBe(size);
			if (size === 800) expect(body.length).toBeLessThan(200_000);
		}
		// L'original n'existe plus, et aucune route ne le sert.
		const stored = await owner.query(`select storage_key from media where id = $1`, [ready.id]);
		const originalKey = stored.rows[0].storage_key as string;
		expect(originalKey).toBe(`media/${a.id}/${ready.id}/original`);
		expect((await fetch(new URL(`/media/v/${ready.id}/original`, t.url))).status).toBe(404);
		expect((await fetch(new URL(`/media/v/${key}/1200.webp`, t.url))).status).toBe(404);
		expect((await fetch(new URL(`/storage/local/${originalKey}`, t.url))).status).toBe(404);
		expect((await audit(a.id, ready.id)).map((l) => [l.action, l.origin])).toEqual([
			['media.create', 'app'],
			['media.upload', 'app'],
			['media.ready', 'job']
		]);
	});

	it('le stockage refuse une autre taille ou un autre type ; la tâche refuse un contenu qui n’est pas celui annoncé', async () => {
		const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#2a6' } })
			.png()
			.toBuffer();
		const created = await announce(manager, { byteSize: png.length });
		const upload = (await manager.call<PresignedUpload>('POST', `/media/${created.body.id}/upload-url`)).body;
		expect(upload.headers).toEqual({ 'content-type': 'image/jpeg', 'content-length': String(png.length) });
		expect(await put(upload, Buffer.concat([png, Buffer.alloc(1)]))).toBe(403);
		expect(await put(upload, png, 'image/png')).toBe(403);
		// Fichier non arrivé : pas de traitement.
		expect((await manager.call('POST', `/media/${created.body.id}/uploaded`)).body).toMatchObject({ code: 'MEDIA_FILE_MISSING' });
		// Bonne taille, bon en-tête, mais un PNG annoncé JPEG : refusé par la tâche, original effacé.
		expect(await put(upload, png)).toBe(200);
		await manager.call('POST', `/media/${created.body.id}/uploaded`);
		expect(await waitMedia(manager, created.body.id)).toMatchObject({ status: 'rejected', error: 'FILE_TYPE', variants: null });
		// Plus de 10 Mo : refusé avant toute signature.
		expect((await announce(manager, { byteSize: 10 * 1024 * 1024 + 1 })).status).toBe(400);
		expect((await announce(manager, { mimeType: 'image/gif' })).status).toBe(400);
	});

	it('la 16e photo d’une unité est refusée ; une photo retirée libère sa place', async () => {
		const u = (await manager.call<UnitView>('POST', '/units', { id: newId(), propertyId: property.id, type: 'studio', label: 'Quota' }))
			.body;
		const ids: string[] = [];
		for (let i = 0; i < 15; i += 1) ids.push((await announce(manager, { unitId: u.id, position: i })).body.id);
		const sixteenth = await announce(manager, { unitId: u.id });
		expect(sixteenth.status).toBe(409);
		expect(sixteenth.body).toMatchObject({ code: 'MEDIA_QUOTA' });
		expect((await manager.call('POST', `/media/${ids[0]}/remove`)).body).toMatchObject({ status: 'removed' });
		expect((await announce(manager, { unitId: u.id })).status).toBe(201);
		// Légende et ordre.
		expect((await manager.call('PATCH', `/media/${ids[1]}`, { caption: 'Salon', position: 0 })).body).toMatchObject({
			caption: 'Salon',
			position: 0
		});
	});

	it('agent de terrain : photos de ses unités affectées seulement ; profil lecture : aucune', async () => {
		const mine = await sendPhoto(agent, await makePhoto(400, 300, 80));
		expect(mine.status).toBe('ready');
		expect((await announce(agent, { unitId: otherUnit.id })).status).toBe(404);
		expect((await announce(agent, { unitId: null })).status).toBe(403);
		expect(
			(await viewer.call('POST', '/media', { id: newId(), propertyId: property.id, unitId: unit.id, mimeType: 'image/jpeg', byteSize: 10 }))
				.status
		).toBe(403);
		const ofOther = (await announce(manager, { unitId: otherUnit.id })).body;
		expect((await agent.call('GET', `/media/${ofOther.id}`)).status).toBe(404);
		expect((await agent.call('POST', `/media/${ofOther.id}/upload-url`)).status).toBe(404);
	});

	it('photo prise hors ligne : annoncée par la synchronisation, envoyée à la reconnexion', async () => {
		const id = newId();
		const file = await makePhoto(600, 400, 85);
		const [r] = (
			await manager.client.call<{ results: SyncOperationResult[] }>('POST', '/sync/upload', {
				operations: [
					{
						key: `media-${id}`,
						op: 'PUT',
						table: 'media',
						id,
						data: {
							organization_id: a.id,
							property_id: property.id,
							unit_id: unit.id,
							mime_type: 'image/jpeg',
							byte_size: file.length,
							position: 3
						}
					}
				]
			})
		).body.results;
		expect(r).toMatchObject({ status: 'applied' });
		const upload = (await manager.call<PresignedUpload>('POST', `/media/${id}/upload-url`)).body;
		expect(await put(upload, file)).toBe(200);
		await manager.call('POST', `/media/${id}/uploaded`);
		expect(await waitMedia(manager, id)).toMatchObject({ status: 'ready', position: 3 });
	});

	it('accès croisé : B ne lit ni n’envoie rien sur une photo de A, ni n’en annonce sur un bien de A', async () => {
		const ofA = (await announce(manager, {})).body;
		expect((await b.director.call('GET', `/media/${ofA.id}`)).status).toBe(404);
		expect((await b.director.call('POST', `/media/${ofA.id}/upload-url`)).status).toBe(404);
		const intrus = await b.director.call('POST', '/media', {
			id: newId(),
			propertyId: property.id,
			unitId: unit.id,
			mimeType: 'image/jpeg',
			byteSize: 10
		});
		expect(intrus.status).toBe(404);
	});
});

describe('documents privés : dépôt signé, empreinte, lecture signée journalisée (D22)', () => {
	const pdf = (text: string) => Buffer.from(`%PDF-1.7\n% ${text}\n%%EOF\n`);

	async function deposit(m: Member, file: Buffer, extra: Record<string, unknown> = {}) {
		const r = await m.call<{ document: DocumentView; upload: PresignedUpload }>('POST', '/documents', {
			id: newId(),
			type: 'title_deed',
			propertyId: property.id,
			fileName: 'Titre foncier.pdf',
			mimeType: 'application/pdf',
			byteSize: file.length,
			...extra
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(await put(r.body.upload, file)).toBe(200);
		return (await m.call<DocumentView>('POST', `/documents/${r.body.document.id}/uploaded`)).body;
	}

	it('dépôt : clé décidée par le serveur, empreinte SHA-256 ; lecture par URL signée de 5 minutes, journalisée', async () => {
		const file = pdf('titre foncier n° 1234');
		const doc = await deposit(manager, file);
		expect(doc).toMatchObject({ status: 'active', version: 1, sha256: createHash('sha256').update(file).digest('hex') });
		const dl = await manager.call<DocumentDownload>('POST', `/documents/${doc.id}/download`);
		expect(dl.status).toBe(200);
		const ttl = (Date.parse(dl.body.expiresAt) - Date.now()) / 1000;
		expect(ttl).toBeGreaterThan(280);
		expect(ttl).toBeLessThanOrEqual(300);
		const r = await fetch(local(dl.body.url));
		expect(r.status).toBe(200);
		expect(Buffer.from(await r.arrayBuffer()).equals(file)).toBe(true);
		expect(r.headers.get('cache-control')).toBe('private, no-store');
		expect(r.headers.get('content-disposition')).toContain('Titre');
		// Le jeton est lié à cette clé : modifié, il ne sert à rien ; sans jeton, rien.
		const token = new URL(dl.body.url).pathname.split('/').pop()!;
		expect((await fetch(new URL(`/storage/local/${token}x`, t.url))).status).toBe(403);
		expect((await fetch(new URL(`/storage/local/documents/${a.id}/${doc.id}`, t.url))).status).toBe(404);
		expect((await audit(a.id, doc.id)).map((l) => l.action)).toEqual(['document.create', 'document.activate', 'document.download']);
	});

	it('matrice : direction et gestion lisent ; ni l’agent de terrain ni le profil lecture ; restreint : le directeur seul', async () => {
		const doc = await deposit(manager, pdf('mandat'), { type: 'mandate', fileName: 'Mandat.pdf' });
		expect((await viewer.call('GET', `/documents/${doc.id}`)).status).toBe(403);
		expect((await agent.call('POST', `/documents/${doc.id}/download`)).status).toBe(403);
		expect((await manager.call('POST', `/documents/${doc.id}/restriction`, { restriction: 'director_only' })).status).toBe(403);
		expect((await a.director.call('POST', `/documents/${doc.id}/restriction`, { restriction: 'director_only' })).body).toMatchObject({
			restriction: 'director_only'
		});
		expect((await manager.call('GET', `/documents/${doc.id}`)).status).toBe(404);
		expect((await manager.call('POST', `/documents/${doc.id}/download`)).status).toBe(404);
		expect((await manager.call<DocumentView[]>('GET', '/documents')).body.map((d) => d.id)).not.toContain(doc.id);
		expect((await a.director.call('POST', `/documents/${doc.id}/download`)).status).toBe(200);
		// Un gestionnaire ne dépose pas un document restreint.
		const restricted = await manager.call('POST', '/documents', {
			id: newId(),
			type: 'other',
			propertyId: property.id,
			fileName: 'x.pdf',
			mimeType: 'application/pdf',
			byteSize: 10,
			restriction: 'director_only'
		});
		expect(restricted.status).toBe(403);
	});

	it('nouvelle version : la précédente devient remplacée, toujours consultable ; une version ne s’écrase jamais', async () => {
		const v1 = await deposit(manager, pdf('PUH version 1'), { type: 'puh', fileName: 'PUH.pdf' });
		const v2 = await deposit(manager, pdf('PUH version 2, corrigée'), { type: 'puh', fileName: 'PUH v2.pdf', replacesId: v1.id });
		expect(v2).toMatchObject({ status: 'active', version: 2, replacesId: v1.id });
		expect((await manager.call<DocumentView>('GET', `/documents/${v1.id}`)).body).toMatchObject({ status: 'replaced' });
		expect((await manager.call('POST', `/documents/${v1.id}/download`)).status).toBe(200);
		const stale = await manager.call('POST', '/documents', {
			id: newId(),
			type: 'puh',
			propertyId: property.id,
			fileName: 'PUH v3.pdf',
			mimeType: 'application/pdf',
			byteSize: 10,
			replacesId: v1.id
		});
		expect(stale.body).toMatchObject({ code: 'DOCUMENT_NOT_ACTIVE' });
		const keys = await owner.query(`select storage_key from documents where id = any($1::uuid[])`, [[v1.id, v2.id]]);
		expect(new Set(keys.rows.map((r) => r.storage_key)).size).toBe(2);
		expect((await manager.call('POST', `/documents/${v2.id}/withdraw`, { reason: 'Document erroné' })).body).toMatchObject({
			status: 'withdrawn'
		});
	});

	it('seconde barrière : un contenu qui n’est pas celui annoncé est refusé et effacé', async () => {
		const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
			.png()
			.toBuffer();
		const r = await manager.call<{ document: DocumentView; upload: PresignedUpload }>('POST', '/documents', {
			id: newId(),
			type: 'owner_identity',
			propertyId: property.id,
			fileName: 'CNIB.pdf',
			mimeType: 'application/pdf',
			byteSize: png.length
		});
		expect(await put(r.body.upload, png)).toBe(200);
		const rejected = (await manager.call<DocumentView>('POST', `/documents/${r.body.document.id}/uploaded`)).body;
		expect(rejected).toMatchObject({ status: 'rejected', error: 'FILE_TYPE', sha256: null });
		expect((await manager.call('POST', `/documents/${rejected.id}/download`)).body).toMatchObject({ code: 'DOCUMENT_NOT_AVAILABLE' });
	});

	it('accès croisé : B ne lit, ne télécharge ni ne rattache rien de A ; aucune table de documents depuis l’appareil', async () => {
		const doc = await deposit(manager, pdf('attestation'), { type: 'allocation_certificate', fileName: 'Attestation.pdf' });
		expect((await b.director.call('GET', `/documents/${doc.id}`)).status).toBe(404);
		expect((await b.director.call('POST', `/documents/${doc.id}/download`)).status).toBe(404);
		expect((await b.director.call<DocumentView[]>('GET', '/documents')).body.map((d) => d.id)).not.toContain(doc.id);
		const intrus = await b.director.call('POST', '/documents', {
			id: newId(),
			type: 'other',
			propertyId: property.id,
			fileName: 'x.pdf',
			mimeType: 'application/pdf',
			byteSize: 10
		});
		expect(intrus.status).toBe(404);
		const [sync] = (
			await manager.client.call<{ results: SyncOperationResult[] }>('POST', '/sync/upload', {
				operations: [
					{ key: `doc-${newId()}`, op: 'PATCH', table: 'documents', id: doc.id, organizationId: a.id, data: { restriction: null } }
				]
			})
		).body.results;
		expect(sync).toMatchObject({ status: 'rejected', code: 'TABLE_NOT_WRITABLE' });
	});
});
