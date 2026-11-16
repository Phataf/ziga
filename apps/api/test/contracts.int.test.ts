/**
 * Lot 08 bis, étape 3 : contrats par l'API et par le worker (génération en tâche de fond, Gotenberg en CI, imitation
 * locale par LibreOffice ailleurs), tests attendus par le prompt du lot :
 * - accès croisé A/B sur les contrats et leurs fichiers ; lien signé expiré refusé ;
 * - génération : modèle avec balise inconnue refusé à l'activation ; bail sans mandat refusé ; caution au-delà de deux
 *   mois : avertissement et audit ;
 * - figement : modifier un contrat prêt à signer crée la version suivante ; empreinte recalculée identique au
 *   téléchargement ; contrat à régénérer si le bail change ;
 * - dépôt du scan : statut « signé », libellé « Signature manuscrite, scan déposé », bail passé à `signed` ;
 * - avenant de loyer : nouvelles échéances à la date d'effet, anciennes inchangées ; reconduction selon le bail ;
 * - alerte « sans contrat signé » présente pour un bail en vigueur sans contrat, absente après le dépôt (lot 08) ;
 * - matrice : l'agent de terrain ne voit ni contrat ni projet ; le profil lecture non plus.
 */
import { createHash } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ContractDetailView, TemplatesOverview, ContractTemplateView } from '@ziga/shared/contracts';
import { addDays, addMonths, monthDay, toIsoDate } from '@ziga/shared/dates';
import type { DocumentView } from '@ziga/shared/documents';
import { PLATFORM_TEMPLATES } from '@ziga/shared/contracts';
import { newId } from '@ziga/shared/ids';
import type { LeaseDetailView, TenantView } from '@ziga/shared/leases';
import type { MandateView, OwnerView } from '@ziga/shared/owners';
import type { PropertyView, UnitView } from '@ziga/shared/properties';
import { Queue, QueueEvents } from 'bullmq';
import { PDFDocument } from 'pdf-lib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { LEASES_DAILY_JOB, LEASES_QUEUE } from '../src/jobs/queues.js';
import { buildDocx, p } from '../src/modules/leases/contracts/docx-builder.js';
import { bullConnection } from '../src/redis/redis.module.js';
import { STORAGE, type PresignedUpload, type StorageAdapter } from '../src/storage/storage.js';
import { WorkerModule } from '../src/worker.module.js';
import { pilotLikeTemplate } from './fixtures/pilot-like-template.js';
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
let tampouy: string;
let counter = 0;

const today = toIsoDate();
const [ty, tm] = today.split('-').map(Number) as [number, number];
const nextMonth = monthDay(ty, tm, 1, 1);

const local = (u: string) => new URL(new URL(u).pathname + new URL(u).search, t.url).toString();

async function call<T>(m: Member, method: string, path: string, body?: unknown, status = 200): Promise<T> {
	const r = await m.call<T>(method, path, body);
	expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(status);
	return r.body;
}

async function put(upload: PresignedUpload, body: Buffer): Promise<void> {
	const r = await fetch(local(upload.url), { method: 'PUT', body, headers: { 'content-type': upload.headers['content-type'] } });
	expect(r.status).toBe(200);
}

async function audit(organizationId: string, objectId: string) {
	const r = await owner.query(`select action, origin, after from audit_log where organization_id = $1 and object_id = $2 order by id`, [
		organizationId,
		objectId
	]);
	return r.rows as { action: string; origin: string; after: Record<string, unknown> | null }[];
}

/** Une unité prête, couverte (ou non) par un mandat de gestion ; un locataire avec son état civil ; un bail. */
async function setup(
	m: Member,
	opts: { mandate?: boolean; identity?: boolean; lease?: Record<string, unknown>; deposit?: number | null } = {}
): Promise<{ unit: UnitView; tenant: TenantView; lease: LeaseDetailView }> {
	const o = await call<OwnerView>(
		m,
		'POST',
		'/owners',
		{ id: newId(), type: 'person', name: 'Mariam Zongo', phone: newPhone(), country: 'BF' },
		201
	);
	const prop = await call<PropertyView>(
		m,
		'POST',
		'/properties',
		{
			id: newId(),
			ownerId: o.id,
			type: 'apartment_building',
			name: 'Résidence du Parc',
			communeId: 'ouagadougou',
			neighborhoodId: tampouy
		},
		201
	);
	const u = await call<UnitView>(
		m,
		'POST',
		'/units',
		{
			id: newId(),
			propertyId: prop.id,
			type: 'apartment',
			label: `B${++counter}`,
			rent: 75_000,
			surfaceM2: 80,
			rooms: { bedrooms: 2, livingRooms: 1, kitchens: 1, bathrooms: 1, terraces: 0, laundries: 0 }
		},
		201
	);
	await call(m, 'POST', `/properties/${prop.id}/status`, { status: 'active' });
	await call(m, 'POST', `/units/${u.id}/status`, { status: 'active' });
	if (opts.mandate !== false) {
		const mandate = await call<MandateView>(
			m,
			'POST',
			'/mandates',
			{
				id: newId(),
				ownerId: o.id,
				type: 'rental_management',
				startsOn: '2024-01-01',
				commission: { basis: 'percent_of_collected', rateBp: 1000 },
				canCollectFunds: true
			},
			201
		);
		await call(m, 'POST', `/mandates/${mandate.id}/scopes`, { id: newId(), propertyId: prop.id }, 201);
	}
	const tenant = await call<TenantView>(
		m,
		'POST',
		'/tenants',
		{
			id: newId(),
			civility: 'mr',
			fullName: 'Issa Kaboré',
			phone: newPhone(),
			nationality: 'burkinabè',
			identity:
				opts.identity === false
					? null
					: {
							birthDate: '1990-04-12',
							birthPlace: 'Koudougou',
							idType: 'cnib',
							idNumber: 'B12345678',
							idIssuedOn: '2022-01-10',
							idIssuedBy: 'ONI'
						}
		},
		201
	);
	const lease = await call<LeaseDetailView>(
		m,
		'POST',
		'/leases',
		{
			id: newId(),
			unitId: u.id,
			tenantId: tenant.id,
			startsOn: nextMonth,
			durationMonths: 12,
			rent: 75_000,
			charges: 0,
			lessorType: 'owner',
			validate: false,
			...opts.lease
		},
		201
	);
	if (opts.deposit !== null) {
		await call(
			m,
			'POST',
			'/deposit-accounts',
			{
				id: newId(),
				leaseId: lease.id,
				type: 'security_deposit',
				agreedAmount: opts.deposit ?? 150_000,
				agreedMonths: 2,
				holder: 'organization'
			},
			201
		);
	}
	return { unit: u, tenant, lease };
}

const signing = () => ({ id: newId(), signingPlace: 'Ouagadougou', signingDate: today, copies: 3 });

async function waitContract(m: Member, id: string, version: number): Promise<ContractDetailView> {
	for (let i = 0; i < 600; i += 1) {
		const view = await call<ContractDetailView>(m, 'GET', `/contracts/${id}`);
		if (view.generationStatus === 'failed') throw new Error(`génération en échec : ${view.generationError}`);
		if (view.generationStatus === 'idle' && view.currentVersion >= version) return view;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error('contrat non généré');
}

async function generated(m: Member, leaseId: string): Promise<ContractDetailView> {
	const created = await call<ContractDetailView>(m, 'POST', `/leases/${leaseId}/contract`, signing(), 202);
	expect(created.generationStatus).toBe('pending');
	return waitContract(m, created.id, 1);
}

async function frozen(m: Member, leaseId: string): Promise<ContractDetailView> {
	const c = await generated(m, leaseId);
	await call(m, 'POST', `/contracts/${c.id}/submit`, { expectedVersion: c.currentVersion });
	return call<ContractDetailView>(m, 'POST', `/contracts/${c.id}/freeze`, { expectedVersion: c.currentVersion });
}

async function scanPdf(): Promise<Buffer> {
	const pdf = await PDFDocument.create();
	pdf.addPage();
	pdf.addPage();
	return Buffer.from(await pdf.save());
}

/** Dépôt du scan signé : fiche, envoi du fichier ; renvoie l'identifiant du document. */
async function depositScan(m: Member, contractId: string, kind: 'signed_scan' | 'legalization' = 'signed_scan'): Promise<string> {
	const file = await scanPdf();
	const id = newId();
	const r = await call<{ document: DocumentView; upload: PresignedUpload }>(
		m,
		'POST',
		`/contracts/${contractId}/uploads`,
		{ id, kind, fileName: 'contrat-signe.pdf', mimeType: 'application/pdf', byteSize: file.length },
		201
	);
	await put(r.upload, file);
	return id;
}

async function signed(m: Member, c: ContractDetailView): Promise<ContractDetailView> {
	const documentId = await depositScan(m, c.id);
	const dates = Object.fromEntries((c.expectedSigners ?? []).map((party) => [party, today]));
	return call<ContractDetailView>(m, 'POST', `/contracts/${c.id}/signature`, {
		documentId,
		expectedVersion: c.frozenVersion,
		signedOn: dates
	});
}

beforeAll(async () => {
	t = await startApp();
	worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(parseConfig(process.env)), { logger: false });
	await worker.init();
	a = await createOrg(t, 'agency', 'Agence A contrats API');
	b = await createOrg(t, 'agency', 'Agence B contrats API');
	manager = await addMember(t, a, 'manager');
	agent = await addMember(t, a, 'field_agent');
	viewer = await addMember(t, a, 'viewer');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	tampouy = (await owner.query(`select id from neighborhoods where commune_id = 'ouagadougou' and name = 'Tampouy'`)).rows[0].id;
	for (const org of [a, b]) {
		await call(org.director, 'PATCH', '/organization', {
			address: 'Avenue Kwame Nkrumah',
			representative: { name: 'Salif Ouédraogo', title: 'gérant', idType: 'cnib', idNumber: 'B00000001', idIssuedOn: '2020-01-01' }
		});
	}
}, 120_000);

afterAll(async () => {
	await owner.end();
	await worker.close();
	await t.close();
});

describe('génération (tâche de fond) avec le modèle par défaut', () => {
	it('version 1 : Word et PDF du registre, empreintes, modèle de la plateforme signalé, aucun blanc, audit app puis job', async () => {
		const { lease } = await setup(manager);
		const c = await generated(manager, lease.id);
		expect(c).toMatchObject({
			status: 'draft',
			currentVersion: 1,
			templateSource: 'platform',
			// Version 3 du bail depuis le lot 09 (article 4 : « reçu de paiement »).
			templateVersion: PLATFORM_TEMPLATES.lease.version,
			defaultTemplateNotice: true
		});
		const [v] = c.versions;
		expect(v).toMatchObject({ number: 1, blankFields: [], warnings: [], templateSource: 'platform' });
		expect(v!.pageCount).toBeGreaterThanOrEqual(2);
		// Empreinte recalculée identique au téléchargement, pour le PDF comme pour le Word.
		for (const format of ['pdf', 'docx'] as const) {
			const link = await call<{ url: string; sha256: string }>(manager, 'GET', `/contracts/${c.id}/versions/1/download?format=${format}`);
			const body = Buffer.from(await (await fetch(local(link.url))).arrayBuffer());
			expect(createHash('sha256').update(body).digest('hex'), format).toBe(format === 'pdf' ? v!.pdfSha256 : v!.docxSha256);
		}
		const fields = await call<{ fields: Record<string, unknown> }>(manager, 'GET', `/contracts/${c.id}/versions/1/fields`);
		expect(fields.fields['loyer.montant_lettres']).toBe('soixante-quinze mille francs CFA');
		expect(fields.fields['representant.nom']).toBe('Salif Ouédraogo');
		const trail = await audit(a.id, c.id);
		expect(trail.map((e) => [e.action, e.origin])).toEqual([
			['contract.create', 'app'],
			['contract.generate', 'job']
		]);
	}, 120_000);

	it('bail sans mandat de gestion en vigueur : refusé', async () => {
		const { lease } = await setup(manager, { mandate: false });
		const r = await manager.call('POST', `/leases/${lease.id}/contract`, signing());
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject({ code: 'NO_MANAGEMENT_MANDATE' });
	});

	it('caution au-delà de deux mois de loyer : avertissement dans la version, ligne d’audit, jamais un refus', async () => {
		const { lease } = await setup(manager, { deposit: 200_000 });
		const c = await generated(manager, lease.id);
		expect(c.versions[0]!.warnings).toEqual(['DEPOSIT_ABOVE_LEGAL_CAP']);
		expect((await audit(a.id, c.id)).map((e) => e.action)).toContain('contract.deposit_above_legal_cap');
	}, 120_000);

	it('un seul contrat par bail', async () => {
		const { lease } = await setup(manager);
		await generated(manager, lease.id);
		expect((await manager.call('POST', `/leases/${lease.id}/contract`, signing())).body).toMatchObject({ code: 'CONTRACT_EXISTS' });
	}, 120_000);
});

describe('vérification, figement, versions', () => {
	it('champs vides : génération possible, figement refusé et nommé ; complétés, la version suivante se fige', async () => {
		const { lease, tenant } = await setup(manager, { identity: false });
		const c = await generated(manager, lease.id);
		expect(c.versions[0]!.blankFields).toEqual(expect.arrayContaining(['locataire.date_naissance', 'locataire.piece']));
		await call(manager, 'POST', `/contracts/${c.id}/submit`, { expectedVersion: 1 });
		const refused = await manager.call('POST', `/contracts/${c.id}/freeze`, { expectedVersion: 1 });
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({ code: 'MISSING_FIELDS' });
		await call(manager, 'PUT', `/tenants/${tenant.id}/identity`, {
			birthDate: '1990-04-12',
			birthPlace: 'Koudougou',
			idType: 'cnib',
			idNumber: 'B1',
			idIssuedOn: '2022-01-10'
		});
		await call(manager, 'POST', `/contracts/${c.id}/versions`, { expectedVersion: 1 }, 202);
		const v2 = await waitContract(manager, c.id, 2);
		expect(v2.versions[1]!.blankFields).toEqual([]);
		const f = await call<ContractDetailView>(manager, 'POST', `/contracts/${c.id}/freeze`, { expectedVersion: 2 });
		expect(f).toMatchObject({ status: 'ready_to_sign', frozenVersion: 2 });
		// Le propriétaire est le bailleur et son mandat ne permet pas à l'agence de signer pour lui : il signe aussi.
		expect(f.expectedSigners).toEqual(['organization', 'owner', 'tenant']);
	}, 180_000);

	it('modifier un contrat prêt à signer crée la version suivante ; la précédente reste, avec la même empreinte', async () => {
		const { lease } = await setup(manager);
		const f = await frozen(manager, lease.id);
		const before = f.versions[0]!;
		const r = await call<ContractDetailView>(manager, 'POST', `/contracts/${f.id}/versions`, { expectedVersion: 1, copies: 4 }, 202);
		expect(r).toMatchObject({ status: 'in_review', frozenVersion: null });
		const after = await waitContract(manager, f.id, 2);
		expect(after.versions.map((v) => v.number)).toEqual([1, 2]);
		expect(after.versions[0]).toEqual(before);
		expect(after.versions[1]!.pdfSha256).not.toBe(before.pdfSha256);
		expect((await audit(a.id, f.id)).map((e) => e.action)).toEqual([
			'contract.create',
			'contract.generate',
			'contract.submit',
			'contract.freeze',
			'contract.unfreeze',
			'contract.generate'
		]);
	}, 180_000);

	it('bail modifié après le figement : contrat « à régénérer », signature refusée', async () => {
		const { lease } = await setup(manager);
		const f = await frozen(manager, lease.id);
		expect(f.outdated).toBe(false);
		await call(manager, 'PATCH', `/leases/${lease.id}`, { rent: 80_000 });
		const view = await call<ContractDetailView>(manager, 'GET', `/contracts/${f.id}`);
		expect(view.outdated).toBe(true);
		expect(view.alerts).toContain('contract_outdated');
		const documentId = await depositScan(manager, f.id);
		const r = await manager.call('POST', `/contracts/${f.id}/signature`, {
			documentId,
			expectedVersion: 1,
			signedOn: { organization: today, owner: today, tenant: today }
		});
		expect(r.body).toMatchObject({ code: 'CONTRACT_OUTDATED' });
	}, 180_000);
});

describe('signature manuscrite, scan déposé (D21)', () => {
	it('le contrat passe « signé », libellé exact, et le bail en brouillon est validé (signé, à venir)', async () => {
		const { lease } = await setup(manager);
		const f = await frozen(manager, lease.id);
		const missing = await manager.call('POST', `/contracts/${f.id}/signature`, {
			documentId: await depositScan(manager, f.id),
			expectedVersion: 1,
			signedOn: { organization: today, owner: null, tenant: today }
		});
		expect(missing.body).toMatchObject({ code: 'SIGNATURE_DATES', details: { parties: ['owner'] } });
		const s = await signed(manager, f);
		expect(s.status).toBe('signed');
		expect(s.signatureMode).toBe('handwritten_scan');
		expect(s.signatureLabel).toMatch(/^Signature manuscrite, scan déposé par .+ le \d{2}\/\d{2}\/\d{4}$/);
		expect(JSON.stringify(s)).not.toMatch(/électroni/i);
		const l = await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`);
		expect(l.status).toBe('signed');
		expect(l.alerts).toEqual([]);
		expect((await audit(a.id, s.id)).map((e) => e.action)).toContain('contract.sign');
		// Légalisation et enregistrement : suivis, jamais bloquants.
		const proof = await depositScan(manager, s.id, 'legalization');
		const legalized = await call<ContractDetailView>(manager, 'PUT', `/contracts/${s.id}/legalization`, {
			legalizedOn: today,
			commune: 'Ouagadougou',
			reference: 'LEG-1',
			documentId: proof
		});
		expect(legalized).toMatchObject({ legalizedOn: today, legalizationCommune: 'Ouagadougou', legalizationDocumentId: proof });
	}, 180_000);

	it('alerte « Contrat non signé » : présente pour un bail en vigueur sans contrat, absente après le dépôt du bail scanné (lot 08)', async () => {
		const { lease } = await setup(manager, { lease: { startsOn: '2026-01-01', validate: true } });
		const before = await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`);
		expect(before.status).toBe('active');
		expect(before.alerts).toEqual(['contract_unsigned']);
		// Même chemin que l'assistant du lot 08 : la route des documents, avec le bail.
		const file = await scanPdf();
		const created = await call<{ document: DocumentView; upload: PresignedUpload }>(
			manager,
			'POST',
			'/documents',
			{
				id: newId(),
				type: 'signed_lease_scan',
				leaseId: lease.id,
				fileName: 'bail.pdf',
				mimeType: 'application/pdf',
				byteSize: file.length
			},
			201
		);
		await put(created.upload, file);
		await call(manager, 'POST', `/documents/${created.document.id}/uploaded`);
		const after = await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`);
		expect(after.alerts).toEqual([]);
		const [contract] = await call<ContractDetailView[]>(manager, 'GET', `/contracts?leaseId=${lease.id}`);
		expect(contract).toMatchObject({ origin: 'uploaded_scan', status: 'signed', signatureMode: 'handwritten_scan', currentVersion: 0 });
		expect(contract!.signatureLabel).toMatch(/^Signature manuscrite, scan déposé par /);
	}, 120_000);
});

describe('avenants et reconduction', () => {
	it('avenant de loyer signé : nouvelles échéances à la date d’effet, anciennes inchangées, même mécanisme que la route du lot 08', async () => {
		const { lease } = await setup(manager, { lease: { validate: true } });
		const before = await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`);
		const effective = addMonths(nextMonth, 4);
		const created = await call<ContractDetailView>(
			manager,
			'POST',
			`/leases/${lease.id}/amendments`,
			{
				amendment: {
					id: newId(),
					type: 'rent_change',
					effectiveFrom: effective,
					rent: 90_000,
					charges: 0,
					expectedLeaseVersion: before.version
				},
				contract: signing()
			},
			202
		);
		const c = await waitContract(manager, created.id, 1);
		expect(c.amendment).toMatchObject({ type: 'rent_change', number: 1, status: 'draft' });
		expect(c.alerts).toContain('amendment_pending');
		await call(manager, 'POST', `/contracts/${c.id}/submit`, { expectedVersion: 1 });
		const f = await call<ContractDetailView>(manager, 'POST', `/contracts/${c.id}/freeze`, { expectedVersion: 1 });
		const s = await signed(manager, f);
		expect(s.amendment).toMatchObject({ status: 'applied', appliedLeaseVersion: before.version + 1 });
		const after = await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`);
		expect(after).toMatchObject({ rent: 90_000, version: before.version + 1, rentEffectiveFrom: effective });
		for (const d of after.rentDues) {
			const old = before.rentDues.find((x) => x.periodStart === d.periodStart);
			if (d.periodStart < effective) expect(d.amountDue, d.periodStart).toBe(old!.amountDue);
			else expect(d.amountDue, d.periodStart).toBe(90_000);
		}
		const change = (await audit(a.id, lease.id)).find((e) => e.action === 'lease.rent_change');
		expect(change?.after).toMatchObject({ amendmentId: c.amendmentId, withoutAmendment: false });
	}, 180_000);

	it('route directe du lot 08 : son audit l’indique « sans avenant »', async () => {
		const { lease } = await setup(manager, { lease: { validate: true } });
		await call(manager, 'POST', `/leases/${lease.id}/rent-changes`, {
			rent: 80_000,
			charges: 0,
			effectiveFrom: addMonths(nextMonth, 2),
			expectedVersion: 1
		});
		const change = (await audit(a.id, lease.id)).find((e) => e.action === 'lease.rent_change');
		expect(change?.after).toMatchObject({ amendmentId: null, withoutAmendment: true });
	});

	it('reconduction au terme sans congé : selon le paramètre du bail, journalisée, par la version suivante', async () => {
		// Terme au 31/12/2024 : la tâche rattrape deux périodes de douze mois, une version chacune.
		const same = await setup(manager, { lease: { startsOn: '2024-01-01', validate: true, renewalMode: 'same_duration' } });
		const open = await setup(manager, { lease: { startsOn: '2025-01-01', validate: true, renewalMode: 'open_ended' } });
		const connection = bullConnection(process.env.REDIS_URL!);
		const queue = new Queue(LEASES_QUEUE, { connection, prefix: 'ziga' });
		const events = new QueueEvents(LEASES_QUEUE, { connection, prefix: 'ziga' });
		await events.waitUntilReady();
		const job = await queue.add(LEASES_DAILY_JOB, { today });
		const result = (await job.waitUntilFinished(events, 60_000)) as { renewed: number };
		expect(result.renewed).toBeGreaterThanOrEqual(2);
		await events.close();
		await queue.close();
		const s = await call<LeaseDetailView>(manager, 'GET', `/leases/${same.lease.id}`);
		expect(s.endsOn).toBe(addDays(addMonths('2026-01-01', 12), -1));
		expect(s.status).toBe('active');
		const o = await call<LeaseDetailView>(manager, 'GET', `/leases/${open.lease.id}`);
		expect(o.endsOn).toBeNull();
		expect((await audit(a.id, open.lease.id)).filter((e) => e.action === 'lease.renew_automatic')).toHaveLength(1);
		expect((await audit(a.id, same.lease.id)).filter((e) => e.action === 'lease.renew_automatic')).toHaveLength(2);
	}, 120_000);
});

describe('modèles de l’organisation', () => {
	async function deposit(m: Member, file: Buffer, kind: 'lease' | 'amendment' = 'lease'): Promise<ContractTemplateView> {
		const id = newId();
		const r = await call<{ template: ContractTemplateView; upload: PresignedUpload }>(
			m,
			'POST',
			'/contract-templates',
			{ id, documentId: newId(), kind, name: 'Modèle de l’agence', fileName: 'modele.docx', byteSize: file.length },
			201
		);
		await put(r.upload, file);
		return call<ContractTemplateView>(m, 'POST', `/contract-templates/${id}/inspect`);
	}

	it('direction seulement ; macros refusées ; balise inconnue : activation refusée ; modèle valide : activé et utilisé', async () => {
		const org = await createOrg(t, 'agency', 'Agence modèles');
		await call(org.director, 'PATCH', '/organization', {
			address: 'Rue de l’Exemple',
			poBox: '01 BP 1 Ouagadougou 01',
			rccm: 'BF-OUA-01-2020-B12-00001',
			ifu: '00012345A',
			representative: {
				name: 'Awa Traoré',
				title: 'directrice',
				nationality: 'burkinabè',
				idType: 'cnib',
				idNumber: 'B00000002',
				idIssuedOn: '2021-01-01',
				idIssuedBy: 'ONI'
			}
		});
		const orgManager = await addMember(t, org, 'manager');
		expect((await orgManager.call('POST', '/contract-templates', {})).status).toBe(403);
		const overview = await call<TemplatesOverview>(orgManager, 'GET', '/contract-templates');
		expect(overview.inUse.lease).toMatchObject({ source: 'platform', legalReviewPending: true });

		const macro = await deposit(
			org.director,
			buildDocx({ blocks: [p('{locataire.nom}')], extraFiles: { 'word/vbaProject.bin': new Uint8Array([1]) } })
		);
		expect(macro.inspectionError).toMatch(/^TEMPLATE_MACROS/);
		expect((await org.director.call('POST', `/contract-templates/${macro.id}/activate`)).body).toMatchObject({
			code: 'TEMPLATE_NOT_INSPECTED'
		});

		const unknown = await deposit(org.director, buildDocx({ blocks: [p('Client : {client.nom}')] }));
		expect(unknown.unknownFields).toEqual(['client.nom']);
		expect((await org.director.call('POST', `/contract-templates/${unknown.id}/activate`)).body).toMatchObject({
			code: 'TEMPLATE_HAS_UNKNOWN_FIELDS'
		});

		const pilot = await deposit(org.director, pilotLikeTemplate());
		expect(pilot).toMatchObject({ unknownFields: [], unmatchedFonts: [], pageCount: 5, inspectionError: null });
		await call(org.director, 'POST', `/contract-templates/${pilot.id}/preview`, undefined, 202);
		const activated = await call<ContractTemplateView>(org.director, 'POST', `/contract-templates/${pilot.id}/activate`);
		expect(activated.status).toBe('active');
		const inUse = await call<TemplatesOverview>(org.director, 'GET', '/contract-templates');
		expect(inUse.inUse.lease).toMatchObject({ source: 'organization', templateId: pilot.id, legalReviewPending: false });

		const { lease, tenant } = await setup(orgManager, {
			lease: {
				advanceMonths: 1,
				penaltyRateBp: 75,
				penaltyGraceDays: 10,
				penaltyBeneficiary: 'organization',
				reducedNoticeMonths: 1,
				reducedNoticeCases: 'mutation',
				earlyTerminationIndemnityMonths: 1
			}
		});
		await call(orgManager, 'PATCH', `/tenants/${tenant.id}`, { profession: 'enseignant', previousAddress: 'Saaba' });
		await call(
			orgManager,
			'POST',
			'/deposit-accounts',
			{ id: newId(), leaseId: lease.id, type: 'utilities_guarantee', agreedAmount: 25_000, holder: 'organization' },
			201
		);
		const c = await generated(orgManager, lease.id);
		expect(c).toMatchObject({ templateSource: 'organization', templateId: pilot.id, defaultTemplateNotice: false });
		expect(c.versions[0]!.pageCount).toBe(5);
		// Critère d'acceptation : un contrat prêt à imprimer, sans aucun blanc.
		expect(c.versions[0]!.blankFields).toEqual([]);
		for (let i = 0; i < 100; i += 1) {
			const v = (await call<TemplatesOverview>(org.director, 'GET', '/contract-templates')).templates.find((x) => x.id === pilot.id);
			if (v?.previewDocumentId) return;
			await new Promise((r) => setTimeout(r, 200));
		}
		throw new Error('aperçu du modèle non généré');
	}, 240_000);
});

describe('cloisonnement et matrice des documents', () => {
	it('B ne lit ni le contrat de A, ni ses versions, ni ses fichiers ; l’agent de terrain et le profil lecture n’ont aucun accès', async () => {
		const { lease } = await setup(manager);
		const c = await generated(manager, lease.id);
		for (const path of [
			`/contracts/${c.id}`,
			`/contracts/${c.id}/versions/1/fields`,
			`/contracts/${c.id}/versions/1/download?format=pdf`
		]) {
			expect((await b.director.call('GET', path)).status, path).toBe(404);
			expect((await agent.call('GET', path)).status, path).toBe(403);
			expect((await viewer.call('GET', path)).status, path).toBe(403);
		}
		expect((await b.director.call('GET', `/contracts?leaseId=${lease.id}`)).body).toEqual([]);
		for (const id of [c.versions[0]!.pdfDocumentId, c.versions[0]!.docxDocumentId]) {
			expect((await b.director.call('POST', `/documents/${id}/download`)).status).toBe(404);
			expect((await agent.call('POST', `/documents/${id}/download`)).status).toBe(403);
			expect((await viewer.call('POST', `/documents/${id}/download`)).status).toBe(403);
		}
		expect((await agent.call('POST', `/leases/${lease.id}/contract`, signing())).status).toBe(403);
		expect((await b.director.call('POST', `/leases/${lease.id}/contract`, signing())).status).toBe(404);
	}, 120_000);

	it('un lien signé expiré est refusé', async () => {
		const { lease } = await setup(manager);
		const c = await generated(manager, lease.id);
		const key = (await owner.query(`select storage_key from documents where id = $1`, [c.versions[0]!.pdfDocumentId])).rows[0]
			.storage_key as string;
		const storage = t.app.get<StorageAdapter>(STORAGE);
		const url = await storage.presignGet(key, { expiresInSeconds: 1 });
		expect((await fetch(local(url))).status).toBe(200);
		await new Promise((r) => setTimeout(r, 2_100));
		expect((await fetch(local(url))).status).toBe(403);
	}, 120_000);
});
