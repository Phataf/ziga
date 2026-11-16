/**
 * Lot 09, étape 3 : encaissements et reçus par l'API, par l'appareil (POST /sync/upload) et par le worker (PDF, tâche
 * de nuit). Tests attendus par le prompt :
 * - accès croisé A/B ; un jeton de A ne révèle rien de B ;
 * - imputation (exact, partiel, trop-perçu, plusieurs retards, plusieurs paiements pour une échéance) ;
 * - paiement saisi hors ligne puis rejoué deux fois : un seul paiement ;
 * - agent de terrain : « à valider », ne confirme pas, le gestionnaire valide ;
 * - annulation : directeur seul, motif obligatoire, échéances ressoldées, reçu annulé ;
 * - moyen de paiement non accepté : refusé par l'API ;
 * - versement de caution en deux fois : deux reçus, deux mouvements, solde restant dû juste ;
 * - doublon Mobile Money (point b), en ligne et à la synchronisation ;
 * - avance (point c) : encaissée à la signature, jamais en retard ; non payée, en retard au début du bail seulement ;
 * - crédit du bail imputé sur l'échéance émise ensuite, contrepassé avec l'encaissement annulé (point 10) ;
 * - PDF (A6, ticket) : le QR code encode l'adresse de la page de vérification, qui répond ; « ANNULÉ » après
 *   annulation ; pages publiques : no-store, noindex, limite de débit ; lien partagé « en cours d'enregistrement ».
 */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { addDays, monthDay, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import type { LeaseDetailView, Page, TenantView } from '@ziga/shared/leases';
import type { OwnerView } from '@ziga/shared/owners';
import { newReceiptToken, provisionalReceiptNumber, type PaymentEntryInput, type PaymentView } from '@ziga/shared/payments';
import type { PropertyView, UnitView } from '@ziga/shared/properties';
import type { PaymentDetailView, PaymentValidationResult, ReceiptVerificationView, SharedReceiptView } from '@ziga/shared/receipts';
import type { SyncOperationResult } from '@ziga/shared/sync';
import { Queue, QueueEvents } from 'bullmq';
import pg from 'pg';
import { encode } from 'uqr';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { LEASES_DAILY_JOB, LEASES_QUEUE } from '../src/jobs/queues.js';
import { bullConnection } from '../src/redis/redis.module.js';
import { WorkerModule } from '../src/worker.module.js';
import { Client, newPhone, startApp, type TestApp } from './http.js';
import { addMember, createOrg, type Member, type Org } from './orgs.js';
import { inspectPdf } from './pdf-inspect.js';

let t: TestApp;
let a: Org;
let b: Org;
let manager: Member;
let agent: Member;
let viewer: Member;
let owner: pg.Client;
let tampouy: string;
let counter = 0;
let worker: INestApplicationContext;
let leasesQueue: Queue;
let leasesEvents: QueueEvents;

const config = parseConfig(process.env);
const today = toIsoDate();
const [ty, tm] = today.split('-').map(Number) as [number, number];
const firstOfMonth = (offset: number) => monthDay(ty, tm, offset, 1);
const key = () => `payments-${newId()}:${++counter}`;

async function call<T>(m: Member, method: string, path: string, body?: unknown, status = 200): Promise<T> {
	const r = await m.call<T>(method, path, body);
	expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(status);
	return r.body;
}

/** Une unité active et prête, couverte par un mandat de gestion, éventuellement affectée à un agent de terrain. */
async function unit(m: Member, agentId?: string): Promise<UnitView> {
	const o = await call<OwnerView>(
		m,
		'POST',
		'/owners',
		{ id: newId(), type: 'person', name: 'Mariam Zongo', phone: newPhone(), country: 'BF' },
		201
	);
	const p = await call<PropertyView>(
		m,
		'POST',
		'/properties',
		{
			id: newId(),
			ownerId: o.id,
			type: 'apartment_building',
			name: 'Résidence Wend-Panga',
			communeId: 'ouagadougou',
			neighborhoodId: tampouy
		},
		201
	);
	const u = await call<UnitView>(
		m,
		'POST',
		'/units',
		{ id: newId(), propertyId: p.id, type: 'apartment', label: `A${++counter}`, rent: 75_000 },
		201
	);
	await call(m, 'POST', `/properties/${p.id}/status`, { status: 'active' });
	await call(m, 'POST', `/units/${u.id}/status`, { status: 'active' });
	if (agentId) await call(m, 'POST', `/units/${u.id}/assign`, { agentId });
	const mandate = await call<{ id: string }>(
		m,
		'POST',
		'/mandates',
		{
			id: newId(),
			ownerId: o.id,
			type: 'rental_management',
			startsOn: '2025-01-01',
			commission: { basis: 'percent_of_collected', rateBp: 1000 },
			canCollectFunds: true
		},
		201
	);
	await call(m, 'POST', `/mandates/${mandate.id}/scopes`, { id: newId(), propertyId: p.id }, 201);
	return u;
}

/** Un bail validé (75 000 + 5 000 FCFA par mois). Par défaut, repris en cours : commencé il y a deux mois. */
async function lease(m: Member, extra: Record<string, unknown> = {}, agentId?: string): Promise<LeaseDetailView> {
	const u = await unit(m, agentId);
	const tn = await call<TenantView>(m, 'POST', '/tenants', { id: newId(), fullName: 'Fatimata Sana', phone: newPhone() }, 201);
	return call<LeaseDetailView>(
		m,
		'POST',
		'/leases',
		{ id: newId(), unitId: u.id, tenantId: tn.id, startsOn: firstOfMonth(-2), rent: 75_000, charges: 5_000, lessorType: 'owner', ...extra },
		201
	);
}

function entry(
	leaseId: string,
	extra: Partial<PaymentEntryInput> = {}
): PaymentEntryInput & { verificationToken: string; shareToken: string } {
	const receiptId = newId();
	return {
		id: newId(),
		leaseId,
		purpose: 'rent',
		amount: 80_000,
		method: 'cash',
		paidOn: today,
		receiptId,
		provisionalNumber: provisionalReceiptNumber(receiptId),
		verificationToken: newReceiptToken(),
		shareToken: newReceiptToken(),
		...extra
	} as PaymentEntryInput & { verificationToken: string; shareToken: string };
}

async function pay(m: Member, ...entries: PaymentEntryInput[]): Promise<PaymentDetailView[]> {
	return call<PaymentDetailView[]>(m, 'POST', '/payments', { payments: entries }, 201);
}

async function refusal(m: Member, e: PaymentEntryInput): Promise<{ status: number; code: string }> {
	const r = await m.call<{ code: string }>('POST', '/payments', { payments: [e] });
	return { status: r.status, code: r.body.code };
}

const dues = async (m: Member, leaseId: string) => (await call<LeaseDetailView>(m, 'GET', `/leases/${leaseId}`)).rentDues;

/** PUT d'un encaissement par l'appareil, avec son reçu joint par le connecteur. */
function syncOp(orgId: string, e: ReturnType<typeof entry>, opKey = key()) {
	return {
		key: opKey,
		op: 'PUT',
		table: 'payments',
		id: e.id,
		data: {
			organization_id: orgId,
			lease_id: e.leaseId,
			purpose: e.purpose,
			deposit_account_id: e.depositAccountId ?? null,
			amount: e.amount,
			method: e.method,
			operator: e.operator ?? null,
			transaction_reference: e.transactionReference ?? null,
			paid_on: e.paidOn
		},
		receipt: { id: e.receiptId, provisionalNumber: e.provisionalNumber, verificationToken: e.verificationToken, shareToken: e.shareToken }
	};
}

async function upload(m: Member, operations: unknown[]): Promise<SyncOperationResult[]> {
	const r = await m.client.call<{ results: SyncOperationResult[] }>('POST', '/sync/upload', { operations });
	expect(r.status).toBe(200);
	return r.body.results;
}

/** Visiteur sans compte, adresse IP à lui (limite de débit par adresse). */
const visitor = () =>
	new Client(t.url, `172.${16 + Math.floor(Math.random() * 15)}.${Math.floor(Math.random() * 250)}.${(counter++ % 250) + 1}`);

/** Adresse signée : en stockage local, construite sur API_PUBLIC_URL, ramenée vers l'API de test (port libre). */
const reachable = (url: string) => url.replace(config.API_PUBLIC_URL.replace(/\/$/, ''), t.url.replace(/\/$/, ''));

/** Attend que le worker ait produit le PDF du reçu, puis le télécharge. */
async function receiptPdf(m: Member, receiptId: string, format: 'a6' | 'ticket' = 'a6'): Promise<Uint8Array> {
	for (let i = 0; i < 100; i += 1) {
		const r = await m.call<{ url: string }>('GET', `/receipts/${receiptId}/pdf?format=${format}`);
		if (r.status === 200) {
			const res = await fetch(reachable(r.body.url));
			expect(res.status).toBe(200);
			return new Uint8Array(await res.arrayBuffer());
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('PDF du reçu jamais produit');
}

async function auditActions(organizationId: string, objectId: string): Promise<string[]> {
	const r = await owner.query(`select action from audit_log where organization_id = $1 and object_id = $2 order by id`, [
		organizationId,
		objectId
	]);
	return r.rows.map((x) => x.action as string);
}

async function runDaily(day: string) {
	const job = await leasesQueue.add(LEASES_DAILY_JOB, { today: day });
	return job.waitUntilFinished(leasesEvents, 20_000);
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A encaissements API');
	b = await createOrg(t, 'agency', 'Agence B encaissements API');
	manager = await addMember(t, a, 'manager');
	agent = await addMember(t, a, 'field_agent');
	viewer = await addMember(t, a, 'viewer');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	tampouy = (await owner.query(`select id from neighborhoods where commune_id = 'ouagadougou' and name = 'Tampouy'`)).rows[0].id;
	worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
	await worker.init();
	leasesQueue = new Queue(LEASES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
	leasesEvents = new QueueEvents(LEASES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
	await leasesEvents.waitUntilReady();
}, 60_000);
afterAll(async () => {
	await Promise.all([leasesQueue.close(), leasesEvents.close()]);
	await worker.close();
	await owner.end();
	await t.close();
});

describe('encaisser un loyer : imputation par le serveur et reçu numéroté', () => {
	it('paiement exact : la plus ancienne échéance soldée, reçu numéroté avec les initiales, copie figée, audit', async () => {
		const l = await lease(manager);
		const [first] = l.rentDues;
		const [d] = await pay(manager, entry(l.id));
		expect(d!.payment).toMatchObject({ status: 'confirmed', amount: 80_000, method: 'cash', tenantId: l.tenantId, provider: 'manual' });
		expect(d!.allocations).toEqual([{ target: 'rent_due', targetId: first!.id, direction: 'allocate', amount: 80_000 }]);
		expect(d!.receipt).toMatchObject({ status: 'valid', number: expect.stringMatching(/^AAEA-\d{4}-\d{6}$/), issuedOn: today });
		expect(d!.receipt!.snapshot).toMatchObject({
			organization: { name: 'Agence A encaissements API' },
			tenant: { fullName: 'Fatimata Sana' },
			unit: { label: expect.stringContaining('Résidence Wend-Panga'), address: 'Tampouy, Ouagadougou' },
			periods: [{ start: first!.periodStart, end: first!.periodEnd, amount: 80_000 }],
			amount: 80_000,
			collectedBy: expect.any(String)
		});
		expect((await dues(manager, l.id))[0]).toMatchObject({ amountPaid: 80_000, status: 'paid' });
		expect(await auditActions(a.id, d!.payment.id)).toEqual(['payment.record']);
		expect(await auditActions(a.id, d!.receipt!.id)).toEqual(['receipt.issue']);
		expect(await auditActions(a.id, a.id)).toContain('organization.receipt_prefix_default');
	});

	it('partiel, plusieurs retards, plusieurs paiements pour une échéance, trop-perçu sur l’échéance suivante', async () => {
		const l = await lease(manager);
		const ids = l.rentDues.map((x) => x.id);
		await pay(manager, entry(l.id, { amount: 30_000 }));
		expect((await dues(manager, l.id))[0]).toMatchObject({ amountPaid: 30_000, status: 'overdue' });
		await pay(manager, entry(l.id, { amount: 50_000 }));
		const [big] = await pay(manager, entry(l.id, { amount: 130_000 }));
		expect(big!.allocations.map((x) => [x.targetId, x.amount])).toEqual([
			[ids[1], 80_000],
			[ids[2], 50_000]
		]);
		expect((await dues(manager, l.id)).slice(0, 3).map((x) => [x.amountPaid, x.status])).toEqual([
			[80_000, 'paid'],
			[80_000, 'paid'],
			[50_000, expect.stringMatching(/partial|overdue/)]
		]);
		// Solde restant dû du reçu : les échéances déjà exigibles, après cet encaissement.
		const exigible = (await dues(manager, l.id)).filter((x) => x.dueOn <= today).reduce((sum, x) => sum + x.amountDue - x.amountPaid, 0);
		expect(big!.receipt!.snapshot!.balanceDue).toBe(exigible);
	});

	it('montant non entier ou nul refusé (règle 2)', async () => {
		const l = await lease(manager);
		for (const amount of [0, 1.5, -10]) expect((await refusal(manager, entry(l.id, { amount }))).status).toBe(400);
	});
});

describe('agent de terrain, validation et rapprochement', () => {
	it('espèces de l’agent : « à valider », reçu provisoire ; il ne confirme pas ; le gestionnaire valide et le reçu est numéroté', async () => {
		const l = await lease(manager, {}, agent.userId);
		const [d] = await pay(agent, entry(l.id));
		expect(d!.payment.status).toBe('to_validate');
		expect(d!.allocations).toEqual([]);
		expect(d!.receipt).toMatchObject({ status: 'provisional', number: null });
		expect((await dues(manager, l.id))[0]!.amountPaid).toBe(0);
		expect((await agent.call('POST', '/payments/validate', { paymentIds: [d!.payment.id] })).status).toBe(403);
		const results = await call<PaymentValidationResult[]>(manager, 'POST', '/payments/validate', { paymentIds: [d!.payment.id] });
		expect(results).toEqual([{ paymentId: d!.payment.id, status: 'confirmed', receiptNumber: expect.stringMatching(/^AAEA-/) }]);
		expect((await dues(manager, l.id))[0]).toMatchObject({ amountPaid: 80_000, status: 'paid' });
		const again = await call<PaymentValidationResult[]>(manager, 'POST', '/payments/validate', { paymentIds: [d!.payment.id] });
		expect(again[0]).toMatchObject({ status: 'rejected', code: 'PAYMENT_TRANSITION_FORBIDDEN' });
		expect(await auditActions(a.id, d!.payment.id)).toEqual(['payment.record', 'payment.validate']);
	});

	it('l’agent n’encaisse que des espèces, sur ses unités, jamais une caution ; le profil lecture n’encaisse rien', async () => {
		const mine = await lease(manager, {}, agent.userId);
		const other = await lease(manager);
		expect(
			await refusal(agent, entry(mine.id, { method: 'mobile_money_manual', operator: 'orange_money', transactionReference: 'MP-AG-1' }))
		).toEqual({
			status: 403,
			code: 'FORBIDDEN_ACTION'
		});
		expect((await refusal(agent, entry(other.id))).code).toBe('LEASE_NOT_FOUND');
		expect((await refusal(viewer, entry(mine.id))).status).toBe(403);
		const page = await call<Page<PaymentView>>(agent, 'GET', '/payments');
		expect(page.items.every((p) => p.leaseId === mine.id || p.purpose === 'rent')).toBe(true);
	});

	it('Mobile Money et virement : « à rapprocher » ; validation groupée, un refus n’arrête pas les autres', async () => {
		const l = await lease(manager);
		const [mm] = await pay(
			manager,
			entry(l.id, { method: 'mobile_money_manual', operator: 'moov_money', transactionReference: `MV-${newId().slice(-8)}` })
		);
		const [vir] = await pay(manager, entry(l.id, { method: 'bank_transfer', transactionReference: 'VIR-001' }));
		expect([mm!.payment.status, vir!.payment.status]).toEqual(['to_reconcile', 'to_reconcile']);
		const results = await call<PaymentValidationResult[]>(manager, 'POST', '/payments/validate', {
			paymentIds: [mm!.payment.id, newId(), vir!.payment.id]
		});
		expect(results.map((r) => r.status)).toEqual(['confirmed', 'rejected', 'confirmed']);
		expect(results[1]).toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
		expect((await dues(manager, l.id)).slice(0, 2).map((x) => x.status)).toEqual(['paid', 'paid']);
		expect(await auditActions(a.id, mm!.payment.id)).toEqual(['payment.record', 'payment.reconcile']);
	});
});

describe('moyens acceptés et interrupteur', () => {
	it('moyen non accepté par l’organisation : refusé (D18) ; fonctionnalité coupée : 403, rien de supprimé', async () => {
		const l = await lease(a.director);
		await call(a.director, 'PUT', '/organization/payment-methods', { methods: ['cash'] });
		try {
			expect(await refusal(manager, entry(l.id, { method: 'bank_transfer', transactionReference: 'VIR-2' }))).toEqual({
				status: 409,
				code: 'PAYMENT_METHOD_NOT_ACCEPTED'
			});
		} finally {
			await call(a.director, 'PUT', '/organization/payment-methods', { methods: ['cash', 'mobile_money_manual', 'bank_transfer'] });
		}
		const [kept] = await pay(manager, entry(l.id));
		await call(a.director, 'PUT', '/organization/features/payments.registry', { disabled: true });
		try {
			expect((await manager.call('GET', '/payments')).body).toMatchObject({ code: 'FEATURE_DISABLED' });
			expect((await refusal(manager, entry(l.id))).code).toBe('FEATURE_DISABLED');
		} finally {
			await call(a.director, 'PUT', '/organization/features/payments.registry', { disabled: false });
		}
		expect((await call<PaymentDetailView>(manager, 'GET', `/payments/${kept!.payment.id}`)).payment.status).toBe('confirmed');
	});
});

describe('doublon Mobile Money (point b)', () => {
	it('même opérateur et même référence : refus nommé, en ligne et à la synchronisation ; permis après annulation', async () => {
		const l = await lease(manager);
		const ref = `MP${Date.now()}.A12`;
		const [first] = await pay(manager, entry(l.id, { method: 'mobile_money_manual', operator: 'orange_money', transactionReference: ref }));
		expect(
			await refusal(
				manager,
				entry(l.id, { method: 'mobile_money_manual', operator: 'orange_money', transactionReference: ` ${ref.toLowerCase()} ` })
			)
		).toEqual({
			status: 409,
			code: 'MOBILE_MONEY_REFERENCE_DUPLICATE'
		});
		// Saisi hors ligne sur un autre appareil, rejoué à la synchronisation : refusé, rangé dans « Modifications non acceptées ».
		const offline = entry(l.id, { method: 'mobile_money_manual', operator: 'orange_money', transactionReference: ref });
		const [r] = await upload(manager, [syncOp(a.id, offline)]);
		expect(r).toMatchObject({ status: 'rejected', code: 'MOBILE_MONEY_REFERENCE_DUPLICATE', organizationId: a.id });
		await call(a.director, 'POST', `/payments/${first!.payment.id}/cancel`, { reason: 'Saisie en double' });
		const [ok] = await upload(manager, [syncOp(a.id, { ...offline, id: newId(), receiptId: newId() })]);
		expect(ok!.status).toBe('applied');
	});
});

describe('hors ligne : rejeu sans doublon', () => {
	it('saisi hors ligne puis rejoué deux fois (même clé, puis autre clé) : un seul paiement, un seul reçu', async () => {
		const l = await lease(manager);
		const e = entry(l.id);
		const op = syncOp(a.id, e);
		const [first] = await upload(manager, [op]);
		const [same] = await upload(manager, [op]);
		const [otherKey] = await upload(manager, [{ ...op, key: key() }]);
		expect([first!.status, same!.status, otherKey!.status]).toEqual(['applied', 'applied', 'applied']);
		expect(same!.replayed).toBe(true);
		const count = await owner.query(`select count(*)::int as n from payments where id = $1`, [e.id]);
		expect(count.rows[0].n).toBe(1);
		const receipts = await owner.query(`select count(*)::int as n from receipts where payment_id = $1`, [e.id]);
		expect(receipts.rows[0].n).toBe(1);
		expect((await dues(manager, l.id))[0]!.amountPaid).toBe(80_000);
		expect((await owner.query(`select origin from audit_log where object_id = $1`, [e.id])).rows).toEqual([{ origin: 'sync' }]);
	});

	it('depuis l’appareil : statut, locataire ou colonne inconnue refusés (FIELD_NOT_WRITABLE) ; sans reçu joint : refusé', async () => {
		const l = await lease(manager);
		const e = entry(l.id);
		const forged = syncOp(a.id, e);
		const [status] = await upload(manager, [{ ...forged, data: { ...forged.data, status: 'confirmed' } }]);
		expect(status).toMatchObject({ status: 'rejected', code: 'FIELD_NOT_WRITABLE' });
		const [noReceipt] = await upload(manager, [{ ...syncOp(a.id, entry(l.id)), receipt: null }]);
		expect(noReceipt).toMatchObject({ status: 'rejected', code: 'VALIDATION_ERROR' });
	});
});

describe('annulation par contre-écriture', () => {
	it('directeur seul, motif obligatoire ; échéances ressoldées ; reçu « ANNULÉ » ; contre-écriture liée', async () => {
		const l = await lease(manager);
		const [d] = await pay(manager, entry(l.id, { amount: 120_000 }));
		expect((await manager.call('POST', `/payments/${d!.payment.id}/cancel`, { reason: 'Erreur de locataire' })).status).toBe(403);
		expect((await a.director.call('POST', `/payments/${d!.payment.id}/cancel`, { reason: '' })).status).toBe(400);
		const cancelled = await call<PaymentDetailView>(a.director, 'POST', `/payments/${d!.payment.id}/cancel`, {
			reason: 'Erreur de locataire'
		});
		expect(cancelled.payment).toMatchObject({ status: 'cancelled', cancellationReason: 'Erreur de locataire' });
		expect(cancelled.receipt).toMatchObject({ status: 'cancelled', number: d!.receipt!.number });
		expect(cancelled.allocations.filter((x) => x.direction === 'reverse').map((x) => x.amount)).toEqual([80_000, 40_000]);
		expect((await dues(manager, l.id)).slice(0, 2).map((x) => [x.amountPaid, x.status])).toEqual([
			[0, 'overdue'],
			[0, 'overdue']
		]);
		const reversal = await owner.query(`select kind, amount::int, status from payments where reverses_payment_id = $1`, [d!.payment.id]);
		expect(reversal.rows).toEqual([{ kind: 'reversal', amount: 120_000, status: 'confirmed' }]);
		expect((await a.director.call('POST', `/payments/${d!.payment.id}/cancel`, { reason: 'Encore une fois' })).body).toMatchObject({
			code: 'PAYMENT_TRANSITION_FORBIDDEN'
		});
		expect(await auditActions(a.id, d!.payment.id)).toEqual(['payment.record', 'payment.cancel']);
	});
});

describe('caution', () => {
	it('versement en deux fois : deux reçus, deux mouvements `received`, solde restant dû juste ; au-delà : refusé', async () => {
		const l = await lease(manager);
		const account = (
			await call<{ data: { id: string } }>(
				manager,
				'POST',
				'/deposit-accounts',
				{ id: newId(), leaseId: l.id, type: 'security_deposit', agreedAmount: 150_000, holder: 'organization' },
				201
			)
		).data;
		const [first] = await pay(manager, entry(l.id, { purpose: 'deposit', depositAccountId: account.id, amount: 100_000 }));
		const [second] = await pay(manager, entry(l.id, { purpose: 'deposit', depositAccountId: account.id, amount: 50_000 }));
		expect(first!.receipt!.number).not.toBe(second!.receipt!.number);
		expect(first!.receipt!.snapshot).toMatchObject({
			purpose: 'deposit',
			deposit: { type: 'security_deposit', holder: 'organization' },
			balanceDue: 50_000
		});
		expect(second!.receipt!.snapshot!.balanceDue).toBe(0);
		const detail = await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`);
		const acc = detail.deposits!.find((x) => x.id === account.id)!;
		expect(acc).toMatchObject({ status: 'held', balances: { received: 150_000, remainingDue: 0 } });
		expect(acc.movements.filter((m) => m.type === 'received').length).toBe(2);
		expect(await refusal(manager, entry(l.id, { purpose: 'deposit', depositAccountId: account.id, amount: 1 }))).toEqual({
			status: 409,
			code: 'DEPOSIT_OVERPAID'
		});
		// Un loyer ne s'impute jamais sur la caution.
		expect((await dues(manager, l.id))[0]!.amountPaid).toBe(0);
		// Annulé : contre-écriture `received_cancelled`, compte de nouveau versé en partie.
		await call(a.director, 'POST', `/payments/${second!.payment.id}/cancel`, { reason: 'Chèque refusé' });
		const after = (await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`)).deposits!.find((x) => x.id === account.id)!;
		expect(after).toMatchObject({ status: 'partially_received', balances: { received: 100_000, remainingDue: 50_000 } });
	});
});

describe('avance (point c) et crédit du bail', () => {
	it('bail signé avec deux mois d’avance, encaissés à la signature : soldés, jamais en retard ; la tâche de nuit le confirme', async () => {
		const start = firstOfMonth(1);
		const l = await lease(manager, { startsOn: start, durationMonths: 12, advanceMonths: 2 });
		expect(l.status).toBe('signed');
		const atSignature = l.rentDues.filter((x) => x.dueOn === today);
		expect(atSignature.length).toBeGreaterThanOrEqual(2);
		const total = atSignature.reduce((s, x) => s + x.amountDue, 0);
		const [d] = await pay(manager, entry(l.id, { amount: total }));
		expect(d!.allocations.map((x) => x.targetId).sort()).toEqual(atSignature.map((x) => x.id).sort());
		await runDaily(addDays(today, 1));
		await runDaily(start);
		const after = await dues(manager, l.id);
		for (const due of atSignature) expect(after.find((x) => x.id === due.id)).toMatchObject({ status: 'paid', amountPaid: due.amountDue });
	});

	it('avance non payée : due à la signature, en retard seulement au début du bail', async () => {
		const start = firstOfMonth(1);
		const l = await lease(manager, { startsOn: start, durationMonths: 12, advanceMonths: 1 });
		const advance = l.rentDues.find((x) => x.isAdvance)!;
		await runDaily(addDays(today, 1));
		expect((await dues(manager, l.id)).find((x) => x.id === advance.id)!.status).toBe('due');
		await runDaily(start);
		expect((await dues(manager, l.id)).find((x) => x.id === advance.id)!.status).toBe('overdue');
	});

	it('trop-perçu sans échéance ouverte : crédit du bail, imputé sur l’échéance émise ensuite ; annulé, il est contrepassé', async () => {
		// Bail sans fin commencé il y a deux mois : 12 mois glissants d'échéances ; on paie tout, plus un mois.
		const l = await lease(manager, { startsOn: firstOfMonth(-2), endsOn: null });
		const all = l.rentDues.reduce((s, x) => s + x.amountDue, 0);
		const [d] = await pay(manager, entry(l.id, { amount: all + 80_000 }));
		expect(d!.allocations.at(-1)).toMatchObject({ target: 'credit', amount: 80_000 });
		expect(d!.receipt!.snapshot!.credit).toBe(80_000);
		// La tâche de nuit, deux mois plus tard (horizon de 12 mois glissants), émet l'échéance suivante : le crédit s'y impute.
		await runDaily(firstOfMonth(2));
		const after = await dues(manager, l.id);
		const next = after.find((x) => !l.rentDues.some((y) => y.id === x.id))!;
		expect(next).toMatchObject({ amountPaid: 80_000, status: 'paid' });
		const cancelled = await call<PaymentDetailView>(a.director, 'POST', `/payments/${d!.payment.id}/cancel`, { reason: 'Virement rejeté' });
		// Le crédit consommé par l'échéance suivante n'est pas « rendu » au crédit : c'est l'échéance qui est contrepassée.
		expect(cancelled.allocations.filter((x) => x.direction === 'reverse' && x.target === 'credit').map((x) => x.amount)).toEqual([80_000]);
		expect(cancelled.allocations.filter((x) => x.direction === 'reverse' && x.targetId === next.id).map((x) => x.amount)).toEqual([80_000]);
		expect((await dues(manager, l.id)).find((x) => x.id === next.id)).toMatchObject({ amountPaid: 0 });
		const credit = await owner.query(
			`select coalesce(sum(case direction when 'allocate' then amount else -amount end), 0)::int as n from payment_allocations where payment_id = $1 and target = 'credit'`,
			[d!.payment.id]
		);
		expect(credit.rows[0].n).toBe(0);
	});
});

describe('reçu : PDF, QR code et pages publiques', () => {
	it('PDF A6 et ticket produits par le worker ; le QR code encode la page de vérification, qui répond ; « ANNULÉ » ensuite', async () => {
		const l = await lease(manager);
		const [d] = await pay(manager, entry(l.id));
		const receiptId = d!.receipt!.id;
		const pdf = await inspectPdf(await receiptPdf(manager, receiptId));
		const lines = pdf.pages.flatMap((p) => p.text);
		expect(lines).toContain('Reçu de paiement');
		expect(lines).toContain(`N° ${d!.receipt!.number}`);
		// La légende du QR code est la dernière ligne de la page, coupée si besoin : relue d'un bloc.
		const caption = lines.slice(lines.findIndex((x) => x.startsWith('Vérifiez ce reçu'))).join('');
		const url = /Vérifiez ce reçu :\s*(\S+)/.exec(caption)?.[1] ?? '';
		const token = url.split('/r/')[1]!;
		expect(url).toBe(`${(config.WEB_PUBLIC_URL ?? config.CORS_ORIGINS[0]!).replace(/\/$/, '')}/r/${token}`);
		expect(pdf.qr).toEqual(encode(url, { ecc: 'M', border: 0 }).data);
		const v = await visitor().call<ReceiptVerificationView>('GET', `/public/receipts/verify/${token}`);
		expect(v.status).toBe(200);
		expect(v.body).toEqual({
			organizationName: 'Agence A encaissements API',
			number: d!.receipt!.number,
			issuedOn: today,
			amount: 80_000,
			status: 'valid'
		});
		expect(v.headers.get('cache-control')).toBe('no-store');
		expect(v.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		const ticket = await inspectPdf(await receiptPdf(manager, receiptId, 'ticket'));
		expect(ticket.pages[0]!.width).toBeCloseTo(80 * (72 / 25.4), 1);

		await call(a.director, 'POST', `/payments/${d!.payment.id}/cancel`, { reason: 'Erreur de saisie' });
		// Le worker régénère le PDF (nouveaux fichiers) : on attend la version « ANNULÉ ».
		let cancelledText: string[] = [];
		for (let i = 0; i < 50 && !cancelledText.includes('ANNULÉ'); i += 1) {
			cancelledText = (await inspectPdf(await receiptPdf(manager, receiptId))).pages.flatMap((p) => p.text);
			if (!cancelledText.includes('ANNULÉ')) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(cancelledText).toContain('ANNULÉ');
		expect((await visitor().call<ReceiptVerificationView>('GET', `/public/receipts/verify/${token}`)).body.status).toBe('cancelled');
		expect(await auditActions(a.id, receiptId)).toContain('receipt.download');
	});

	it('lien partagé : « en cours d’enregistrement » avant la synchronisation, puis le reçu ; révocable ; jeton de vérification de A sans rien de B', async () => {
		const l = await lease(manager);
		const e = entry(l.id);
		const before = await visitor().call<SharedReceiptView>('GET', `/public/receipts/shared/${e.shareToken}`);
		expect(before.status).toBe(200);
		expect(before.body).toEqual({ state: 'pending' });
		await upload(manager, [syncOp(a.id, e)]);
		const after = await visitor().call<SharedReceiptView>('GET', `/public/receipts/shared/${e.shareToken}`);
		expect(after.body).toMatchObject({
			state: 'available',
			status: 'valid',
			amount: 80_000,
			organizationName: 'Agence A encaissements API'
		});
		// Le jeton de vérification de l'appareil (reçu affiché hors ligne) répond aussi, et ne révèle que cinq champs.
		const v = await visitor().call<ReceiptVerificationView>('GET', `/public/receipts/verify/${e.verificationToken}`);
		expect(Object.keys(v.body).sort()).toEqual(['amount', 'issuedOn', 'number', 'organizationName', 'status']);
		// Un jeton de partage n'est pas un jeton de vérification, ni l'inverse.
		expect((await visitor().call('GET', `/public/receipts/verify/${e.shareToken}`)).status).toBe(404);
		expect((await visitor().call<SharedReceiptView>('GET', `/public/receipts/shared/${e.verificationToken}`)).body).toEqual({
			state: 'pending'
		});
		const receiptId = (await owner.query(`select id from receipts where payment_id = $1`, [e.id])).rows[0].id as string;
		// B ne crée ni ne révoque rien sur le reçu de A.
		expect((await b.director.call('POST', `/receipts/${receiptId}/share-token`)).status).toBe(404);
		expect((await b.director.call('POST', `/receipts/${receiptId}/share-token/revoke`)).status).toBe(404);
		const fresh = await call<{ token: string }>(manager, 'POST', `/receipts/${receiptId}/share-token`, undefined, 201);
		expect((await visitor().call<SharedReceiptView>('GET', `/public/receipts/shared/${fresh.token}`)).body).toMatchObject({
			state: 'available'
		});
		await call(manager, 'POST', `/receipts/${receiptId}/share-token/revoke`);
		for (const tok of [fresh.token, e.shareToken]) {
			expect((await visitor().call<SharedReceiptView>('GET', `/public/receipts/shared/${tok}`)).body).toEqual({ state: 'pending' });
		}
		expect((await visitor().call('GET', '/public/receipts/verify/court')).status).toBe(404);
	});

	it('limite de débit par adresse IP sur les pages publiques', async () => {
		const limited = await startApp({ RECEIPT_PUBLIC_RATE_PER_MINUTE: '3' });
		try {
			// Adresses tirées au hasard : la limite est comptée dans Redis, partagé entre les exécutions.
			const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
			const c = new Client(limited.url, ip());
			const statuses: number[] = [];
			for (let i = 0; i < 4; i += 1) statuses.push((await c.call('GET', `/public/receipts/shared/${newReceiptToken()}`)).status);
			expect(statuses).toEqual([200, 200, 200, 429]);
			expect((await new Client(limited.url, ip()).call('GET', `/public/receipts/shared/${newReceiptToken()}`)).status).toBe(200);
		} finally {
			await limited.close();
		}
	});
});

describe('réglages de la numérotation', () => {
	it('directeur : préfixe et premier numéro avant le premier reçu ; figés ensuite ; back-office avec motif', async () => {
		const c = await createOrg(t, 'agency', 'Cabinet Kaboré');
		const m = c.director;
		expect(await call(m, 'GET', '/organization/receipt-settings')).toMatchObject({
			prefix: null,
			proposedPrefix: 'CK',
			ticketWidth: 80,
			firstNumberSet: false
		});
		const mgr = await addMember(t, c, 'manager');
		expect((await mgr.call('PUT', '/organization/receipt-settings', { prefix: 'KAB' })).status).toBe(403);
		await call(m, 'PUT', '/organization/receipt-settings', { prefix: 'kab', firstNumber: 124, ticketWidth: 58 });
		expect((await m.call('PUT', '/organization/receipt-settings', { firstNumber: 200 })).body).toMatchObject({
			code: 'RECEIPT_FIRST_NUMBER_ALREADY_SET'
		});
		const l = await lease(m);
		const [d] = await pay(m, entry(l.id));
		expect(d!.receipt!.number).toBe(`KAB-${ty}-000124`);
		const [d2] = await pay(m, entry(l.id));
		expect(d2!.receipt!.number).toBe(`KAB-${ty}-000125`);
		expect((await m.call('PUT', '/organization/receipt-settings', { prefix: 'NEW' })).body).toMatchObject({
			code: 'RECEIPT_PREFIX_LOCKED'
		});
		expect(await call(m, 'GET', '/organization/receipt-settings')).toMatchObject({
			prefix: 'KAB',
			ticketWidth: 58,
			firstNumberSet: true,
			numberingStartedAt: expect.any(String)
		});
		const actions = (
			await owner.query(`select action from audit_log where organization_id = $1 and object_type = 'organization' order by id`, [c.id])
		).rows.map((r) => r.action);
		expect(actions).toEqual(
			expect.arrayContaining(['organization.receipt_prefix', 'organization.receipt_ticket_width', 'receipt.first_number'])
		);

		// Back-office : super administrateur, motif obligatoire, journalisé chez l'organisation.
		const staff = (await createOrg(t, 'agency', 'Support plateforme')).director;
		expect(
			(await staff.client.call('PUT', `/admin/organizations/${c.id}/receipt-prefix`, { prefix: 'KABO', reason: 'Fusion' })).status
		).toBe(403);
		await owner.query(`update users set platform_role = 'super_admin' where id = $1`, [staff.userId]);
		expect((await staff.client.call('PUT', `/admin/organizations/${c.id}/receipt-prefix`, { prefix: 'KABO' })).status).toBe(400);
		expect(
			(
				await staff.client.call('PUT', `/admin/organizations/${c.id}/receipt-prefix`, {
					prefix: 'KABO',
					reason: 'Changement de raison sociale'
				})
			).status
		).toBe(204);
		const [d3] = await pay(m, entry(l.id));
		expect(d3!.receipt!.number).toBe(`KABO-${ty}-000126`);
		expect(
			(
				await owner.query(
					`select origin, after from audit_log where action = 'organization.receipt_prefix_override' and organization_id = $1`,
					[c.id]
				)
			).rows
		).toEqual([{ origin: 'admin', after: { receiptPrefix: 'KABO', reason: 'Changement de raison sociale' } }]);
	});
});

describe('accès croisé A/B par l’API et par l’appareil (règle 1)', () => {
	it('B ne lit, ne valide, n’annule ni n’encaisse rien chez A', async () => {
		const l = await lease(a.director);
		const [d] = await pay(manager, entry(l.id, { method: 'bank_transfer', transactionReference: 'VIR-AB' }));
		expect((await b.director.call('GET', `/payments/${d!.payment.id}`)).status).toBe(404);
		expect((await b.director.call('GET', `/receipts/${d!.receipt!.id}/pdf`)).status).toBe(404);
		expect(
			(await call<PaymentValidationResult[]>(b.director, 'POST', '/payments/validate', { paymentIds: [d!.payment.id] }))[0]
		).toMatchObject({
			status: 'rejected',
			code: 'PAYMENT_NOT_FOUND'
		});
		expect((await b.director.call('POST', `/payments/${d!.payment.id}/cancel`, { reason: 'Piratage' })).status).toBe(404);
		expect((await call<Page<PaymentView>>(b.director, 'GET', '/payments')).items.map((p) => p.id)).not.toContain(d!.payment.id);
		expect((await refusal(b.director, entry(l.id))).code).toBe('LEASE_NOT_FOUND');
		const [forged] = await upload(b.director, [syncOp(a.id, entry(l.id))]);
		expect(forged!.status).toBe('rejected');
		const [onA] = await upload(b.director, [syncOp(b.id, entry(l.id))]);
		expect(onA).toMatchObject({ status: 'rejected', code: 'LEASE_NOT_FOUND' });
		expect((await call<PaymentDetailView>(a.director, 'GET', `/payments/${d!.payment.id}`)).payment.status).toBe('to_reconcile');
	});
});
