/**
 * Lot 11, étape 3 : l'import Excel par l'API et ses tâches de fond (worker du test), écrit avant le code (rouge).
 * - Modèle téléchargeable ; envoi par URL signée ; lecture et analyse dans la tâche de fond, jamais dans la requête.
 * - Registre fictif : prévisualisation exacte (erreurs, lignes écartées en cascade, cautions sans montant reçu à
 *   trancher), exécution refusée tant que le choix unique n'est pas fait, puis tout importé par les services des
 *   modules (audit d'origine `import`, identifiant de l'import sur chaque ligne) ; premier reçu le jour même.
 * - Quota d'unités vérifié avant toute exécution ; rejeu par BullMQ sans doublon ; échec imprévu d'un onglet : rien de
 *   lui, ses dépendants non exécutés, les autres importés ; accès croisé ; 1 000 lignes en moins de 60 secondes.
 * - Annulation sous 24 heures ; refusée après un encaissement ; rapport téléchargeable neutralisé.
 * - L'échéancier (changement de loyer, sortie) ignore l'échéance « Solde antérieur ».
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { addDays, addMonths, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import type { ImportJobView } from '@ziga/shared/imports';
import type { LeaseDetailView } from '@ziga/shared/leases';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import { Queue, QueueEvents } from 'bullmq';
import pg from 'pg';
import readXlsxFile from 'read-excel-file/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { IMPORT_PURGE_JOB, IMPORTS_QUEUE, LEASES_DAILY_JOB, LEASES_QUEUE } from '../src/jobs/queues.js';
import { AppError } from '../src/common/app-error.js';
import { FeaturesService } from '../src/modules/features/features.service.js';
import { LeasesService } from '../src/modules/leases/leases.service.js';
import { bullConnection } from '../src/redis/redis.module.js';
import { WorkerModule } from '../src/worker.module.js';
import {
	DEPOSITS,
	LEASES,
	OPENING_BALANCES,
	OWNERS,
	PROPERTIES,
	REGISTRY_SHEETS,
	TENANTS,
	UNITS,
	type FixtureSheet
} from './fixtures/imports/registre-fictif.js';
import { FREE_EXPECTED, FREE_MAPPING, FREE_SHEET } from './fixtures/imports/registre-libre.js';
import { deflatedSpaces, minimalXlsx } from './fixtures/imports/zip.js';
import { startApp, type TestApp } from './http.js';
import { analyze, call, execute, firstOfThisMonth, refusal, settled, uploadImport, workbook } from './imports-api.js';
import { addMember, createOrg, type Member, type Org } from './orgs.js';

let t: TestApp;
let worker: INestApplicationContext;
let owner: pg.Client;
let queue: Queue;
let leasesQueue: Queue;
let events: QueueEvents;
let importEvents: QueueEvents;
let registry: Buffer;
let tampouy: string;

const local = (u: string) => new URL(new URL(u).pathname + new URL(u).search, t.url).toString();
const today = toIsoDate();

/** Lignes créées par un import, table par table (propriétaire du schéma, organisation posée). */
async function createdBy(organizationId: string, jobId: string, table: string, extra = ''): Promise<number> {
	await owner.query('BEGIN');
	try {
		await owner.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
		const r = await owner.query(`select count(*)::int as n from ${table} where organization_id = $2 and import_job_id = $1 ${extra}`, [
			jobId,
			organizationId
		]);
		return r.rows[0].n as number;
	} finally {
		await owner.query('ROLLBACK');
	}
}

/**
 * Lecture SQL dans le contexte d'une organisation. Le rôle des migrations peut être superutilisateur (il passe alors
 * outre la RLS) : chaque requête filtre aussi l'organisation, comme `createdBy`.
 */
async function inOrg<T>(organizationId: string, sql: string, params: unknown[] = []): Promise<T[]> {
	await owner.query('BEGIN');
	try {
		await owner.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
		return (await owner.query(sql, params)).rows as T[];
	} finally {
		await owner.query('ROLLBACK');
	}
}

/** Registre fictif importé jusqu'au bout dans une organisation neuve (choix « versée en entier »). */
async function importedRegistry(org: Org, m: Member = org.director): Promise<ImportJobView> {
	const up = await uploadImport(m, local, registry);
	await analyze(m, up.id, { choices: { depositReceived: 'full' } });
	const done = await execute(m, up.id);
	expect(done.status, JSON.stringify(done.report)).toBe('completed');
	return done;
}

/** Petit registre : un propriétaire, un bien situé, `n` unités et leurs baux. */
function smallRegistry(n: number, names: (i: number) => string = (i) => `Locataire ${i}`): FixtureSheet[] {
	const units = Array.from({ length: n }, (_, i) => i + 1);
	return [
		{ ...OWNERS, rows: [['Personne', 'P1', 'Compaoré Awa', '70 44 55 66', '', '', '']] },
		{
			...PROPERTIES,
			rows: [
				[
					'B-1',
					'Cour Tampouy',
					'P1',
					'Cour commune',
					'Ouagadougou',
					'Tampouy',
					'Gestion locative',
					'10 %',
					'',
					'',
					'01/01/2020',
					'Non',
					'Oui'
				]
			]
		},
		{ ...UNITS, rows: units.map((i) => ['B-1', `U-${i}`, `Chambre ${i}`, 'Chambre-salon', 1, '35 000', '']) },
		{ ...TENANTS, rows: units.map((i) => [names(i), `7${String(1_500_000 + i).padStart(7, '0')}`, 'M.', `L-${i}`, '']) },
		{ ...LEASES, rows: units.map((i) => [`L-${i}`, `U-${i}`, '35 000', '01/03/2021', '', '', '', '', '']) },
		{ ...DEPOSITS, rows: units.map((i) => [`U-${i}`, '70 000', '70 000', '', '', 'Caution']) },
		{ ...OPENING_BALANCES, rows: [['U-1', '35 000']] }
	];
}

beforeAll(async () => {
	t = await startApp();
	worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(parseConfig(process.env)), { logger: false });
	await worker.init();
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	queue = new Queue(IMPORTS_QUEUE, { connection: bullConnection(process.env.REDIS_URL!), prefix: 'ziga' });
	leasesQueue = new Queue(LEASES_QUEUE, { connection: bullConnection(process.env.REDIS_URL!), prefix: 'ziga' });
	events = new QueueEvents(LEASES_QUEUE, { connection: bullConnection(process.env.REDIS_URL!), prefix: 'ziga' });
	importEvents = new QueueEvents(IMPORTS_QUEUE, { connection: bullConnection(process.env.REDIS_URL!), prefix: 'ziga' });
	registry = await workbook(REGISTRY_SHEETS);
	tampouy = (await owner.query(`select id from neighborhoods where commune_id = 'ouagadougou' and name = 'Tampouy'`)).rows[0].id;
}, 120_000);

afterAll(async () => {
	await events?.close();
	await importEvents?.close();
	await leasesQueue?.close();
	await queue?.close();
	await owner?.end();
	await worker?.close();
	await t?.close();
});

describe('modèle et permissions', () => {
	it('modèle téléchargeable : un classeur Excel aux onglets du type d’organisation', async () => {
		const a = await createOrg(t, 'agency', 'Agence modèle');
		const r = await fetch(`${t.url}/imports/template`, {
			headers: { authorization: `Bearer ${a.director.client.accessToken}`, 'x-organization-id': a.id }
		});
		expect(r.status).toBe(200);
		expect(r.headers.get('content-type')).toContain('spreadsheetml');
		expect(r.headers.get('content-disposition')).toContain('modele-import-ziga.xlsx');
		const sheets = await readXlsxFile(Buffer.from(await r.arrayBuffer()));
		expect(sheets.map((s) => s.sheet)).toContain('Soldes d’ouverture');
	});

	it('direction et gestion seulement ; fonctionnalité `imports.excel` vérifiée côté serveur', async () => {
		const a = await createOrg(t, 'agency', 'Agence permissions import');
		const viewer = await addMember(t, a, 'viewer');
		const agent = await addMember(t, a, 'field_agent');
		const body = { id: newId(), fileName: 'r.xlsx', fileFormat: 'xlsx', fileSize: 1000, switchOn: firstOfThisMonth() };
		expect(await refusal(viewer, 'POST', '/imports', body)).toMatchObject({ status: 403, code: 'FORBIDDEN_ACTION' });
		expect(await refusal(agent, 'GET', '/imports')).toMatchObject({ status: 403, code: 'FORBIDDEN_ACTION' });
		const override = newId();
		await owner.query(
			`insert into feature_overrides (id, feature_key, scope, organization_id, value, reason, created_by) values ($1, 'imports.excel', 'organization', $2, false, 'Test de l’import coupé', $3)`,
			[override, a.id, a.director.userId]
		);
		await t.app.get(FeaturesService).invalidate();
		try {
			expect(await refusal(a.director, 'POST', '/imports', body)).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
		} finally {
			await owner.query(`update feature_overrides set revoked_at = now(), revoked_by = created_by where id = $1`, [override]);
			await t.app.get(FeaturesService).invalidate();
		}
	});

	it('date de bascule dans le futur : refusée à l’envoi', async () => {
		const a = await createOrg(t, 'agency', 'Agence bascule future');
		const r = await refusal(a.director, 'POST', '/imports', {
			id: newId(),
			fileName: 'r.xlsx',
			fileFormat: 'xlsx',
			fileSize: 1000,
			switchOn: addDays(today, 3)
		});
		expect(r).toMatchObject({ status: 400 });
		expect(r.message).toContain('futur');
	});
});

describe('registre fictif : prévisualisation, choix unique, exécution, premier reçu le jour même', () => {
	let a: Org;
	let job: ImportJobView;

	beforeAll(async () => {
		a = await createOrg(t, 'agency', 'Agence du registre fictif');
	});

	it('analyse en tâche de fond : erreurs avec la ligne et la colonne, lignes écartées en cascade, cautions à trancher', async () => {
		const up = await uploadImport(a.director, local, registry);
		expect(up.status).toBe('uploaded');
		job = await analyze(a.director, up.id);
		expect(job.status).toBe('analyzed');
		const p = job.preview!;
		expect(p.issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([
			'Ligne 54 de Unités, colonne Type d’unité : à remplir.',
			'Ligne 31 de Locataires, colonne Nom et prénoms : à remplir.',
			'Ligne 50 de Baux, colonne Date d’entrée : à remplir.',
			'Ligne 8 de Soldes d’ouverture, colonne Montant dû à la bascule (FCFA) : saisissez 0 et notez l’avance sur la fiche du locataire.'
		]);
		expect(p.issues.some((i) => i.message === 'Ligne 51 de Baux écartée : l’unité B-06-10 est en erreur (Unités, ligne 54).')).toBe(true);
		expect(p.pending.depositsWithoutReceived).toHaveLength(38);
		expect(p.blockers.map((b) => b.code)).toEqual(['DEPOSIT_RECEIVED_UNKNOWN']);
		expect(p.summary).toMatchObject({ newUnits: 52, leases: 46, leasesWithOpeningBalance: 9 });
		expect(p.places.filter((x) => x.status === 'unresolved').map((x) => x.neighborhood)).toEqual(['Tampoui', 'Dasasgho', 'Pisy']);
		// Rien n'est encore créé.
		expect(await inOrg(a.id, `select id from units where organization_id = $1`, [a.id])).toEqual([]);
	});

	it('exécution refusée tant que le choix unique des cautions n’est pas fait', async () => {
		const r = await refusal(a.director, 'POST', `/imports/${job.id}/execute`);
		expect(r).toMatchObject({ status: 409, code: 'IMPORT_BLOCKED' });
		expect(r.message).toContain('38 cautions n’ont pas de montant reçu');
		expect((await call<ImportJobView>(a.director, 'GET', `/imports/${job.id}`)).status).toBe('analyzed');
	});

	it('choix faits (« versée en entier », quartier corrigé) : exécution, tout est importé par les services', async () => {
		const tampoui = job.preview!.places.find((x) => x.neighborhood === 'Tampoui')!;
		job = await analyze(a.director, job.id, { choices: { depositReceived: 'full', places: { [tampoui.key]: tampouy } } });
		expect(job.preview!.blockers).toEqual([]);
		job = await execute(a.director, job.id);
		expect(job.status, JSON.stringify(job.report)).toBe('completed');
		expect(Object.values(job.report!.sheets).map((s) => s!.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done']);
		expect(await createdBy(a.id, job.id, 'owners')).toBe(3);
		expect(await createdBy(a.id, job.id, 'mandates')).toBe(4);
		expect(await createdBy(a.id, job.id, 'properties')).toBe(6);
		expect(await createdBy(a.id, job.id, 'units')).toBe(52);
		expect(await createdBy(a.id, job.id, 'tenants')).toBe(48);
		expect(await createdBy(a.id, job.id, 'leases')).toBe(46);
		expect(await createdBy(a.id, job.id, 'deposit_accounts')).toBe(39);
		expect(await createdBy(a.id, job.id, 'deposit_movements', `and type = 'received' and payment_id is null`)).toBe(39);
		expect(await createdBy(a.id, job.id, 'rent_dues', `and kind = 'opening_balance'`)).toBe(9);
		// Bail échu : durée indéterminée, date de fin d'origine gardée.
		expect(await createdBy(a.id, job.id, 'leases', `and original_ends_on = '2024-02-28' and ends_on is null`)).toBe(1);
		// Aucun reçu pour une caution reprise (D33), et aucun encaissement.
		expect(await inOrg(a.id, `select id from receipts where organization_id = $1`, [a.id])).toEqual([]);
		expect(await inOrg(a.id, `select id from payments where organization_id = $1`, [a.id])).toEqual([]);
	});

	it('journal : origine « import », avec l’identifiant de l’import ; personne qui l’a lancé en acteur', async () => {
		const rows = await inOrg<{ action: string; actor_user_id: string; origin: string }>(
			a.id,
			`select action, actor_user_id, origin from audit_log where import_job_id = $1`,
			[job.id]
		);
		expect(rows.length).toBeGreaterThan(200);
		expect(rows.every((r) => r.origin === 'import' && r.actor_user_id === a.director.userId)).toBe(true);
		const actions = new Set(rows.map((r) => r.action));
		for (const action of [
			'owner.create',
			'mandate.create',
			'property.create',
			'unit.create',
			'tenant.create',
			'lease.create',
			'lease.validate',
			'deposit.create'
		]) {
			expect(actions.has(action), action).toBe(true);
		}
		// Caution au-delà de deux mois de loyer : avertissement journalisé (D15).
		expect(actions.has('deposit.above_legal_cap')).toBe(true);
	});

	it('unités occupées, calculées à partir des baux ; libres « à remettre en état » ; baux en vigueur sans contrat signé, alertés', async () => {
		const [occupied] = await inOrg<{ id: string }>(a.id, `select id from units where label = 'Appartement A2' and import_job_id = $1`, [
			job.id
		]);
		const unit = await call<{ occupancy: string; technicalStatus: string; recordStatus: string }>(
			a.director,
			'GET',
			`/units/${occupied!.id}`
		);
		expect(unit).toMatchObject({ occupancy: 'occupied', technicalStatus: 'ready', recordStatus: 'active' });
		const [vacant] = await inOrg<{ id: string }>(a.id, `select id from units where label = 'Appartement 16' and import_job_id = $1`, [
			job.id
		]);
		expect(await call(a.director, 'GET', `/units/${vacant!.id}`)).toMatchObject({ occupancy: 'free', technicalStatus: 'to_refurbish' });
		const [leaseRow] = await inOrg<{ id: string }>(
			a.id,
			`select l.id from leases l join units u on u.id = l.unit_id where l.organization_id = $1 and u.label = 'Appartement A2'`,
			[a.id]
		);
		const lease = await call<LeaseDetailView>(a.director, 'GET', `/leases/${leaseRow!.id}`);
		expect(lease.status).toBe('active');
		expect(lease.alerts).toContain('contract_unsigned');
		// Échéances générées à partir de la date de bascule, jamais avant.
		expect(lease.rentDues.every((d) => d.periodStart >= firstOfThisMonth())).toBe(true);
	});

	it('premier reçu le jour même : l’encaissement solde d’abord le solde d’ouverture', async () => {
		const [row] = await inOrg<{ id: string }>(
			a.id,
			`select l.id from leases l join units u on u.id = l.unit_id where l.organization_id = $1 and u.label = 'Villa'`,
			[a.id]
		);
		const before = await call<LeaseDetailView>(a.director, 'GET', `/leases/${row!.id}`);
		const opening = before.rentDues.find((d) => d.kind === 'opening_balance')!;
		expect(opening).toMatchObject({ amountDue: 250_000, dueOn: firstOfThisMonth() });
		const receiptId = newId();
		const [paid] = await call<{ payment: { status: string }; receipt: { id: string } | null }[]>(
			a.director,
			'POST',
			'/payments',
			{
				payments: [
					{
						id: newId(),
						leaseId: row!.id,
						purpose: 'rent',
						amount: 250_000,
						method: 'cash',
						paidOn: today,
						receiptId,
						provisionalNumber: provisionalReceiptNumber(receiptId),
						verificationToken: newReceiptToken(),
						shareToken: newReceiptToken()
					}
				]
			},
			201
		);
		expect(paid!.payment.status).toBe('confirmed');
		expect(paid!.receipt).not.toBeNull();
		const after = await call<LeaseDetailView>(a.director, 'GET', `/leases/${row!.id}`);
		expect(after.rentDues.find((d) => d.kind === 'opening_balance')).toMatchObject({ amountPaid: 250_000, status: 'paid' });
		expect(await inOrg(a.id, `select id from receipts where organization_id = $1`, [a.id])).toHaveLength(1);
	});

	it('rapport téléchargeable : lignes importées, écartées et erreurs', async () => {
		const link = await call<{ url: string }>(a.director, 'GET', `/imports/${job.id}/report`);
		const [report] = await readXlsxFile(Buffer.from(await (await fetch(local(link.url))).arrayBuffer()));
		expect(report!.data[0]).toEqual(['Onglet', 'Ligne', 'Statut', 'Élément', 'Message']);
		const statuses = report!.data.slice(1).map((r) => r[2]);
		expect(statuses.filter((s) => s === 'Erreur')).toHaveLength(4);
		expect(statuses).toContain('Importée');
		expect(statuses).toContain('Écartée');
	});

	it('après un encaissement sur un bail de l’import, l’annulation est refusée', async () => {
		const r = await refusal(a.director, 'POST', `/imports/${job.id}/cancel`, { reason: 'Registre à reprendre' });
		expect(r).toMatchObject({ status: 409, code: 'IMPORT_CANCEL_PAYMENTS' });
	});
});

describe('accès croisé (règle 1)', () => {
	it('un import de A ne crée jamais rien dans B ; B ne voit pas l’import de A', async () => {
		const a = await createOrg(t, 'agency', 'Agence A cloisonnement import');
		const b = await createOrg(t, 'agency', 'Agence B cloisonnement import');
		const job = await importedRegistry(a);
		for (const table of ['owners', 'properties', 'units', 'tenants', 'leases', 'deposit_accounts', 'rent_dues']) {
			expect(await inOrg(b.id, `select id from ${table} where organization_id = $1`, [b.id]), table).toEqual([]);
		}
		expect((await refusal(b.director, 'GET', `/imports/${job.id}`)).status).toBe(404);
		expect((await refusal(b.director, 'GET', `/imports/${job.id}/report`)).status).toBe(404);
		expect((await refusal(b.director, 'POST', `/imports/${job.id}/cancel`, { reason: 'Pas le mien' })).status).toBe(404);
		expect(await call<ImportJobView[]>(b.director, 'GET', '/imports')).toEqual([]);
	});
});

describe('quota, rejeu, échec imprévu d’un onglet', () => {
	it('quota d’unités dépassé : refus avant toute exécution, message clair', async () => {
		const a = await createOrg(t, 'agency', 'Agence au quota');
		await owner.query(
			`insert into quota_overrides (id, organization_id, quota, value, reason, created_by) values ($1, $2, 'units', 10, 'Test du quota d’import', $3)`,
			[newId(), a.id, a.director.userId]
		);
		await t.app.get(FeaturesService).invalidate();
		const up = await uploadImport(a.director, local, registry);
		await analyze(a.director, up.id, { choices: { depositReceived: 'full' } });
		const r = await refusal(a.director, 'POST', `/imports/${up.id}/execute`);
		expect(r).toMatchObject({ status: 403, code: 'QUOTA_EXCEEDED' });
		expect(r.message).toBe(
			'Cet import ajoute 52 unités ; votre formule en permet 10 (0 déjà utilisée). Passez à une formule supérieure ou contactez Ziga.'
		);
		expect((await call<ImportJobView>(a.director, 'GET', `/imports/${up.id}`)).status).toBe('analyzed');
		expect(await inOrg(a.id, `select id from units where organization_id = $1`, [a.id])).toEqual([]);
	});

	it('rejeu par BullMQ après une coupure : les onglets déjà validés sont sautés, aucun doublon', async () => {
		const a = await createOrg(t, 'agency', 'Agence du rejeu');
		const spy = vi.spyOn(LeasesService.prototype, 'createTenant').mockImplementationOnce(() => {
			throw new Error('connexion à la base perdue');
		});
		try {
			const job = await importedRegistry(a);
			expect(spy).toHaveBeenCalled();
			expect(await createdBy(a.id, job.id, 'owners')).toBe(3);
			expect(await createdBy(a.id, job.id, 'units')).toBe(52);
			expect(await createdBy(a.id, job.id, 'tenants')).toBe(48);
			expect(await createdBy(a.id, job.id, 'leases')).toBe(46);
			// Rejouée à la main une fois terminée : rien de plus.
			const again = await queue.add('execute', { organizationId: a.id, importJobId: job.id, userId: a.director.userId });
			await again.waitUntilFinished(importEvents, 30_000);
			expect(await createdBy(a.id, job.id, 'units')).toBe(52);
		} finally {
			spy.mockRestore();
		}
	});

	it('échec imprévu d’un onglet : rien de lui (une transaction), ses dépendants non exécutés, les autres importés', async () => {
		const a = await createOrg(t, 'agency', 'Agence de l’onglet en échec');
		let calls = 0;
		const original = LeasesService.prototype.createLease;
		const spy = vi.spyOn(LeasesService.prototype, 'createLease').mockImplementation(function (this: LeasesService, ...args) {
			calls += 1;
			if (calls === 3) throw new AppError('LEASE_SIMULATED', 'Refus simulé du service des baux.', 409);
			return original.apply(this, args);
		});
		try {
			const up = await uploadImport(a.director, local, registry);
			await analyze(a.director, up.id, { choices: { depositReceived: 'full' } });
			const job = await execute(a.director, up.id);
			expect(job.status).toBe('completed');
			expect(job.report!.sheets.leases).toMatchObject({ status: 'failed', created: 0 });
			expect(job.report!.sheets.leases!.message).toBe('Onglet Baux non importé : Refus simulé du service des baux. (ligne 4)');
			expect(job.report!.sheets.deposits).toMatchObject({ status: 'not_run' });
			expect(job.report!.sheets.opening_balances).toMatchObject({ status: 'not_run' });
			expect(job.report!.sheets.tenants).toMatchObject({ status: 'done', created: 48 });
			expect(await createdBy(a.id, job.id, 'leases')).toBe(0);
			expect(await createdBy(a.id, job.id, 'units')).toBe(52);
		} finally {
			spy.mockRestore();
		}
	});
});

describe('fichier hostile, envoyé par l’API', () => {
	it('archive qui se décompresse démesurément : analyse refusée proprement, rien de créé', async () => {
		const a = await createOrg(t, 'agency', 'Agence de la bombe');
		const up = await uploadImport(a.director, local, minimalXlsx('Unités', { deflated: deflatedSpaces(64 * 1024 * 1024) }));
		const job = await analyze(a.director, up.id);
		expect(job).toMatchObject({ status: 'analysis_failed', preview: null });
		expect(job.error).toContain('une fois décompressé, il dépasse 50 Mo');
		expect(await inOrg(a.id, `select id from units where organization_id = $1`, [a.id])).toEqual([]);
	});
});

describe('performance', () => {
	it('1 000 lignes importées en moins de 60 secondes', async () => {
		const a = await createOrg(t, 'agency', 'Agence des mille lignes', 'custom');
		const sheets = smallRegistry(250);
		expect(sheets.reduce((n, s) => n + s.rows.length, 0)).toBeGreaterThanOrEqual(1_000);
		const up = await uploadImport(a.director, local, await workbook(sheets));
		await analyze(a.director, up.id);
		const job = await execute(a.director, up.id);
		expect(job.status).toBe('completed');
		expect(await createdBy(a.id, job.id, 'leases')).toBe(250);
		expect(Date.parse(job.completedAt!) - Date.parse(job.startedAt!)).toBeLessThan(60_000);
	}, 180_000);
});

describe('annulation dans les 24 heures (prompt §4, réponse 7)', () => {
	it('tout ce que l’import a créé est archivé, annulé ou contre-passé ; rien n’est supprimé', async () => {
		const a = await createOrg(t, 'agency', 'Agence de l’annulation');
		const up = await uploadImport(a.director, local, await workbook(smallRegistry(3)));
		await analyze(a.director, up.id);
		const job = await execute(a.director, up.id);
		expect(job.status).toBe('completed');
		expect(job.cancellableUntil).not.toBeNull();
		await call(a.director, 'POST', `/imports/${job.id}/cancel`, { reason: 'Registre de la mauvaise agence' }, 202);
		const cancelled = await settled(a.director, job.id, (j) => j.status === 'cancelled');
		expect(cancelled).toMatchObject({ cancellationReason: 'Registre de la mauvaise agence', cancellableUntil: null });
		expect(await createdBy(a.id, job.id, 'leases', `and status = 'cancelled'`)).toBe(3);
		expect(await createdBy(a.id, job.id, 'units', `and record_status = 'archived'`)).toBe(3);
		expect(await createdBy(a.id, job.id, 'properties', `and record_status = 'archived'`)).toBe(1);
		expect(await createdBy(a.id, job.id, 'tenants', `and status = 'archived'`)).toBe(3);
		expect(await createdBy(a.id, job.id, 'owners', `and status = 'archived'`)).toBe(1);
		expect(await createdBy(a.id, job.id, 'mandates', `and status = 'revoked'`)).toBe(1);
		expect(await createdBy(a.id, job.id, 'rent_dues', `and status <> 'waived'`)).toBe(0);
		expect(await createdBy(a.id, job.id, 'deposit_movements', `and type = 'received_cancelled'`)).toBe(3);
		// Rien n'est supprimé : les lignes de l'import sont toujours là.
		expect(await createdBy(a.id, job.id, 'leases')).toBe(3);
		const audit = await inOrg<{ action: string }>(a.id, `select action from audit_log where action = 'import.cancel' and object_id = $1`, [
			job.id
		]);
		expect(audit).toHaveLength(1);
	});
});

describe('annulation d’un bien importé sans quartier (étape 4a)', () => {
	it('un bien resté en brouillon, sans commune ni quartier, est archivé à l’annulation comme les autres', async () => {
		const a = await createOrg(t, 'agency', 'Agence du bien sans quartier');
		const sheets = smallRegistry(2).map((s) =>
			s.name === PROPERTIES.name ? { ...s, rows: s.rows.map((r) => r.map((c, i) => (i === 5 ? 'Quartier introuvable' : c))) } : s
		);
		const up = await uploadImport(a.director, local, await workbook(sheets));
		await analyze(a.director, up.id);
		const job = await execute(a.director, up.id);
		expect(job.status, JSON.stringify(job.report)).toBe('completed');
		expect(await createdBy(a.id, job.id, 'properties', `and record_status = 'draft' and neighborhood_id is null`)).toBe(1);
		await call(a.director, 'POST', `/imports/${job.id}/cancel`, { reason: 'Registre à reprendre' }, 202);
		const cancelled = await settled(a.director, job.id, (j) => j.status === 'cancelled');
		expect(cancelled.status).toBe('cancelled');
		expect(await createdBy(a.id, job.id, 'properties', `and record_status = 'archived' and neighborhood_id is null`)).toBe(1);
		expect(await createdBy(a.id, job.id, 'leases', `and status = 'cancelled'`)).toBe(2);
	}, 120_000);
});

describe('fichier libre sur une seule feuille (étape 4b)', () => {
	it('aucun onglet reconnu : la prévisualisation montre les colonnes de la feuille et propose une correspondance ; import impossible', async () => {
		const a = await createOrg(t, 'agency', 'Agence du fichier libre');
		const up = await uploadImport(a.director, local, await workbook([FREE_SHEET]));
		const job = await analyze(a.director, up.id);
		expect(job.status).toBe('analyzed');
		expect(job.preview!.sheets).toEqual([]);
		expect(job.preview!.fileSheets).toHaveLength(1);
		expect(job.preview!.fileSheets[0]).toMatchObject({ name: 'Feuil1', headers: FREE_SHEET.headers, rows: FREE_SHEET.rows.length });
		expect(job.preview!.fileSheets[0]!.suggested).toMatchObject({ 'tenants.fullName': 7, 'leases.startsOn': 9 });
		expect(job.preview!.blockers.map((b) => b.code)).toContain('NOTHING_TO_IMPORT');
		expect(await refusal(a.director, 'POST', `/imports/${up.id}/execute`)).toMatchObject({ status: 409, code: 'IMPORT_BLOCKED' });
	});

	it('correspondance incomplète : le champ obligatoire manquant est nommé, l’exécution refusée', async () => {
		const a = await createOrg(t, 'agency', 'Agence de la correspondance incomplète');
		const up = await uploadImport(a.director, local, await workbook([FREE_SHEET]));
		await analyze(a.director, up.id);
		const constants: Record<string, string> = { ...FREE_MAPPING.constants };
		delete constants['properties.type'];
		const job = await analyze(a.director, up.id, { mapping: { single: { ...FREE_MAPPING, constants } } });
		const blocker = job.preview!.blockers.find((b) => b.code === 'MAPPING_INCOMPLETE')!;
		expect(blocker.message).toContain('Type de bien');
		expect(await refusal(a.director, 'POST', `/imports/${up.id}/execute`)).toMatchObject({ status: 409, code: 'IMPORT_BLOCKED' });
	});

	it('correspondance faite : répartition dans les sept groupes, répétitions réunies, messages sur la feuille du fichier, import', async () => {
		const a = await createOrg(t, 'agency', 'Agence du registre libre');
		const up = await uploadImport(a.director, local, await workbook([FREE_SHEET]));
		await analyze(a.director, up.id);
		const analyzed = await analyze(a.director, up.id, { mapping: { single: FREE_MAPPING }, choices: { depositReceived: 'full' } });
		expect(analyzed.mapping).toEqual({ single: FREE_MAPPING });
		expect(analyzed.preview!.blockers).toEqual([]);
		expect(analyzed.preview!.sheets.map((s) => s.key)).toEqual(['owners', 'properties', 'units', 'tenants', 'leases', 'deposits', 'opening_balances']);
		const phone = analyzed.preview!.issues.find((i) => i.severity === 'error')!;
		expect(phone.message).toMatch(/^Ligne 7 de Feuil1, colonne Contact : /);
		const job = await execute(a.director, up.id);
		expect(job.status, JSON.stringify(job.report)).toBe('completed');
		expect(await createdBy(a.id, job.id, 'owners')).toBe(FREE_EXPECTED.owners);
		expect(await createdBy(a.id, job.id, 'properties')).toBe(FREE_EXPECTED.properties);
		expect(await createdBy(a.id, job.id, 'units')).toBe(FREE_EXPECTED.units);
		expect(await createdBy(a.id, job.id, 'tenants')).toBe(FREE_EXPECTED.tenants);
		expect(await createdBy(a.id, job.id, 'leases', `and status = 'active'`)).toBe(FREE_EXPECTED.leases);
		expect(await createdBy(a.id, job.id, 'rent_dues', `and kind = 'opening_balance'`)).toBe(FREE_EXPECTED.openingBalances);
		expect(await createdBy(a.id, job.id, 'mandates')).toBe(3);
	}, 120_000);
});

describe('rapport neutralisé, de bout en bout', () => {
	it('un nom de locataire qui ressemble à une formule ressort du rapport en texte', async () => {
		const a = await createOrg(t, 'agency', 'Agence du rapport');
		const up = await uploadImport(a.director, local, await workbook(smallRegistry(1, () => '=HYPERLINK("http://exemple.test","clic")')));
		await analyze(a.director, up.id);
		const job = await execute(a.director, up.id);
		const link = await call<{ url: string }>(a.director, 'GET', `/imports/${job.id}/report`);
		const [report] = await readXlsxFile(Buffer.from(await (await fetch(local(link.url))).arrayBuffer()));
		const cells = report!.data.flat().filter((c): c is string => typeof c === 'string');
		expect(cells).toContain('\'=HYPERLINK("http://exemple.test","clic")');
		expect(cells.some((c) => /^\s*[=+\-@]/.test(c))).toBe(false);
	});
});

describe('l’échéancier ignore l’échéance « Solde antérieur » (point noté à l’étape 2)', () => {
	it('changement de loyer puis sortie : le solde d’ouverture reste tel quel, jamais abandonné ni recalculé', async () => {
		const a = await createOrg(t, 'agency', 'Agence de l’échéancier');
		const up = await uploadImport(a.director, local, await workbook(smallRegistry(1)));
		await analyze(a.director, up.id);
		const job = await execute(a.director, up.id);
		const [row] = await inOrg<{ id: string }>(a.id, `select id from leases where import_job_id = $1`, [job.id]);
		const lease = await call<LeaseDetailView>(a.director, 'GET', `/leases/${row!.id}`);
		const opening = lease.rentDues.find((d) => d.kind === 'opening_balance')!;
		expect(opening).toMatchObject({ amountDue: 35_000 });
		await call(a.director, 'POST', `/leases/${lease.id}/rent-changes`, {
			rent: 40_000,
			charges: 0,
			effectiveFrom: addMonths(firstOfThisMonth(), 1),
			expectedVersion: lease.version
		});
		const changed = await call<LeaseDetailView>(a.director, 'GET', `/leases/${lease.id}`);
		expect(changed.rentDues.find((d) => d.id === opening.id)).toMatchObject({ amountDue: 35_000, status: opening.status });
		await call(
			a.director,
			'POST',
			`/leases/${lease.id}/notice`,
			{ id: newId(), origin: 'tenant', deliveryMode: 'hand_delivery', notifiedOn: addDays(addMonths(today, -3), 1), plannedExitOn: today },
			201
		);
		const daily = await leasesQueue.add(LEASES_DAILY_JOB, { today });
		await daily.waitUntilFinished(events, 30_000);
		const ended = await call<LeaseDetailView>(a.director, 'GET', `/leases/${lease.id}`);
		expect(ended.status).toBe('ended');
		expect(ended.rentDues.find((d) => d.id === opening.id)).toMatchObject({ amountDue: 35_000, status: opening.status });
	});
});

describe('fichier d’origine conservé 90 jours (prompt §4)', () => {
	it('la tâche du jour efface du stockage les fichiers échus ; l’import reste, sans sa prévisualisation', async () => {
		const a = await createOrg(t, 'agency', 'Agence de la conservation');
		const up = await uploadImport(a.director, local, await workbook(smallRegistry(1)));
		await analyze(a.director, up.id);
		const [row] = await inOrg<{ storage_key: string }>(a.id, `select storage_key from import_jobs where id = $1`, [up.id]);
		const path = join(process.env.STORAGE_LOCAL_DIR!, row!.storage_key);
		expect(existsSync(path)).toBe(true);
		// À 89 jours : rien n'est effacé.
		let purge = await queue.add(IMPORT_PURGE_JOB, { now: new Date(Date.now() + 89 * 86_400_000).toISOString() });
		await purge.waitUntilFinished(importEvents, 30_000);
		expect(existsSync(path)).toBe(true);
		purge = await queue.add(IMPORT_PURGE_JOB, { now: new Date(Date.now() + 91 * 86_400_000).toISOString() });
		await purge.waitUntilFinished(importEvents, 30_000);
		expect(existsSync(path)).toBe(false);
		const job = await call<ImportJobView>(a.director, 'GET', `/imports/${up.id}`);
		expect(job).toMatchObject({ status: 'analyzed', preview: null });
		expect(job.fileDeletedAt).not.toBeNull();
		// Fichier effacé : plus d'exécution possible.
		expect(await refusal(a.director, 'POST', `/imports/${up.id}/execute`)).toMatchObject({ status: 409, code: 'IMPORT_FILE_DELETED' });
	});
});
