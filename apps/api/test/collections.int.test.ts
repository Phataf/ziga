/**
 * Lot 10, étape 3 : impayés, relances, dépenses, relevés et reversements par l'API, par l'appareil (POST /sync/upload)
 * et par le worker (PDF du relevé, brouillons du mois). Tests attendus par le prompt :
 * - accès croisé A/B par l'API ; un jeton de relevé de A ne donne rien de B ; jeton révoqué ou expiré refusé ;
 * - totaux d'un relevé égaux aux reçus valides de la période (rapprochement), paiement partiel, paiement annulé exclu,
 *   dépense du locataire exclue, dépense avancée pour le propriétaire incluse une seule fois, commission sur le loyer ;
 * - relevé émis non modifiable ; le rectificatif référence l'original ;
 * - quota de la formule Découverte ;
 * - interrupteur `collections.reminders_whatsapp_link` coupé : relance par WhatsApp refusée ;
 * - aucun numéro de téléphone de locataire sur la page partagée (demande du porteur).
 */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ArrearsGroup } from '@ziga/shared/collections';
import { monthDay, toIsoDate } from '@ziga/shared/dates';
import type { ExpenseView } from '@ziga/shared/expenses';
import { newId } from '@ziga/shared/ids';
import type { LeaseDetailView, Page, TenantView } from '@ziga/shared/leases';
import type { OwnerView } from '@ziga/shared/owners';
import { newReceiptToken, provisionalReceiptNumber, type PaymentEntryInput, type PaymentView } from '@ziga/shared/payments';
import type { PropertyView, UnitView } from '@ziga/shared/properties';
import type { PaymentDetailView } from '@ziga/shared/receipts';
import type { ReminderView } from '@ziga/shared/reminders';
import {
	monthEnd,
	type PayoutView,
	type SharedStatementView,
	type StatementDetailView,
	type StatementShareLinkView
} from '@ziga/shared/statements';
import type { SyncOperationResult } from '@ziga/shared/sync';
import { Queue, QueueEvents } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { STATEMENTS_MONTHLY_JOB, STATEMENTS_QUEUE } from '../src/jobs/queues.js';
import { bullConnection } from '../src/redis/redis.module.js';
import { WorkerModule } from '../src/worker.module.js';
import { Client, newPhone, startApp, type TestApp } from './http.js';
import { addMember, createOrg, type Member, type Org } from './orgs.js';
import { sha256 } from './payments.js';

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
let queue: Queue;
let events: QueueEvents;
const config = parseConfig(process.env);
const today = toIsoDate();
const [ty, tm] = today.split('-').map(Number) as [number, number];
const firstOfMonth = (offset: number) => monthDay(ty, tm, offset, 1);
/** Mois écoulé (terminé, donc émissible) et jours dans ce mois. */
const PREVIOUS = firstOfMonth(-1).slice(0, 7);
const dayOf = (month: string, day: number) => `${month}-${String(day).padStart(2, '0')}`;

async function call<T>(m: Member, method: string, path: string, body?: unknown, status = 200): Promise<T> {
	const r = await m.call<T>(method, path, body);
	expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(status);
	return r.body;
}

async function refusal(m: Member, method: string, path: string, body?: unknown): Promise<{ status: number; code: string }> {
	const r = await m.call<{ code: string }>(method, path, body);
	return { status: r.status, code: r.body.code };
}

interface Portfolio {
	ownerId: string;
	propertyId: string;
	units: UnitView[];
	mandateId: string;
}

/** Un propriétaire, un bien de `n` unités actives et prêtes, un mandat de gestion (10 % du loyer encaissé par défaut). */
async function portfolio(m: Member, n = 1, mandate: Record<string, unknown> = {}, agentId?: string): Promise<Portfolio> {
	const o = await call<OwnerView>(
		m,
		'POST',
		'/owners',
		{ id: newId(), type: 'person', name: 'Mariam Compaoré', phone: newPhone(), country: 'BF' },
		201
	);
	const p = await call<PropertyView>(
		m,
		'POST',
		'/properties',
		{ id: newId(), ownerId: o.id, type: 'apartment_building', name: 'Résidence Laafi', communeId: 'ouagadougou', neighborhoodId: tampouy },
		201
	);
	const units: UnitView[] = [];
	for (let i = 0; i < n; i += 1) {
		const u = await call<UnitView>(
			m,
			'POST',
			'/units',
			{ id: newId(), propertyId: p.id, type: 'apartment', label: `B${++counter}`, rent: 75_000 },
			201
		);
		units.push(u);
	}
	await call(m, 'POST', `/properties/${p.id}/status`, { status: 'active' });
	for (const u of units) {
		await call(m, 'POST', `/units/${u.id}/status`, { status: 'active' });
		if (agentId) await call(m, 'POST', `/units/${u.id}/assign`, { agentId });
	}
	const md = await call<{ id: string }>(
		m,
		'POST',
		'/mandates',
		{
			id: newId(),
			ownerId: o.id,
			type: 'rental_management',
			startsOn: '2025-01-01',
			commission: { basis: 'percent_of_collected', rateBp: 1000 },
			canCollectFunds: true,
			...mandate
		},
		201
	);
	await call(m, 'POST', `/mandates/${md.id}/scopes`, { id: newId(), propertyId: p.id }, 201);
	return { ownerId: o.id, propertyId: p.id, units, mandateId: md.id };
}

/** Bail validé sur une unité, commencé il y a deux mois (échéances des deux mois passés et du mois en cours). */
async function lease(m: Member, unit: UnitView, rent = 75_000, charges = 5_000): Promise<LeaseDetailView & { tenantPhone: string }> {
	const phone = newPhone();
	const tn = await call<TenantView>(m, 'POST', '/tenants', { id: newId(), fullName: `Locataire ${++counter}`, phone }, 201);
	const l = await call<LeaseDetailView>(
		m,
		'POST',
		'/leases',
		{ id: newId(), unitId: unit.id, tenantId: tn.id, startsOn: firstOfMonth(-2), rent, charges, lessorType: 'owner' },
		201
	);
	return { ...l, tenantPhone: phone };
}

function entry(leaseId: string, extra: Partial<PaymentEntryInput> = {}): PaymentEntryInput {
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
	};
}

async function pay(m: Member, e: PaymentEntryInput): Promise<PaymentDetailView> {
	return (await call<PaymentDetailView[]>(m, 'POST', '/payments', { payments: [e] }, 201))[0]!;
}

function expense(propertyId: string, extra: Record<string, unknown> = {}) {
	return {
		id: newId(),
		propertyId,
		spentOn: dayOf(PREVIOUS, 12),
		category: 'plumbing',
		description: 'Fuite sous l’évier',
		amount: 15_000,
		paidBy: 'organization',
		borneBy: 'owner',
		recovery: 'owner_statement',
		...extra
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

const reachable = (url: string) => url.replace(config.API_PUBLIC_URL.replace(/\/$/, ''), t.url.replace(/\/$/, ''));

async function generate(m: Member, ownerId: string, month = PREVIOUS): Promise<StatementDetailView> {
	return call<StatementDetailView>(m, 'POST', '/owner-statements/generate', { ownerId, month });
}

async function issue(m: Member, s: StatementDetailView): Promise<StatementDetailView> {
	return call<StatementDetailView>(m, 'POST', `/owner-statements/${s.id}/issue`, { revision: s.revision });
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A relevés API');
	b = await createOrg(t, 'agency', 'Agence B relevés API');
	manager = await addMember(t, a, 'manager');
	agent = await addMember(t, a, 'field_agent');
	viewer = await addMember(t, a, 'viewer');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	tampouy = (await owner.query(`select id from neighborhoods where commune_id = 'ouagadougou' and name = 'Tampouy'`)).rows[0].id;
	worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
	await worker.init();
	queue = new Queue(STATEMENTS_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
	events = new QueueEvents(STATEMENTS_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
	await events.waitUntilReady();
}, 60_000);
afterAll(async () => {
	await Promise.all([queue.close(), events.close()]);
	await worker.close();
	await owner.end();
	await t.close();
});

// ---------------------------------------------------------------- dépenses

describe('dépenses par l’API (règle 16)', () => {
	let pf: Portfolio;
	beforeAll(async () => {
		pf = await portfolio(manager);
	});

	it('la gestion enregistre (idempotent) ; la lecture lit ; l’agent de terrain et la lecture n’enregistrent pas', async () => {
		const body = expense(pf.propertyId);
		const e = await call<ExpenseView>(manager, 'POST', '/expenses', body, 201);
		expect(e).toMatchObject({ amount: 15_000, effect: 'statement_deduction', status: 'recorded' });
		expect((await call<ExpenseView>(manager, 'POST', '/expenses', body, 201)).id).toBe(e.id);
		expect((await call<Page<ExpenseView>>(viewer, 'GET', `/expenses?propertyId=${pf.propertyId}`)).items.map((x) => x.id)).toContain(e.id);
		expect(await refusal(agent, 'POST', '/expenses', expense(pf.propertyId))).toMatchObject({ status: 403, code: 'FORBIDDEN_ACTION' });
		expect(await refusal(viewer, 'POST', '/expenses', expense(pf.propertyId))).toMatchObject({ status: 403, code: 'FORBIDDEN_ACTION' });
		expect((await refusal(manager, 'POST', '/expenses', expense(pf.propertyId, { recovery: 'none' }))).status).toBe(400);
	});

	it('annulation motivée par le directeur seul, une fois ; la dépense reste', async () => {
		const e = await call<ExpenseView>(manager, 'POST', '/expenses', expense(pf.propertyId), 201);
		expect(await refusal(manager, 'POST', `/expenses/${e.id}/cancel`, { reason: 'Doublon de saisie' })).toMatchObject({
			status: 403,
			code: 'FORBIDDEN_ACTION'
		});
		const cancelled = await call<ExpenseView>(a.director, 'POST', `/expenses/${e.id}/cancel`, { reason: 'Doublon de saisie' });
		expect(cancelled).toMatchObject({ status: 'cancelled', cancellationReason: 'Doublon de saisie', amount: 15_000 });
		expect(await refusal(a.director, 'POST', `/expenses/${e.id}/cancel`, { reason: 'Encore' })).toMatchObject({
			status: 409,
			code: 'EXPENSE_ALREADY_CANCELLED'
		});
	});

	it('B ne lit ni n’annule une dépense de A', async () => {
		const e = await call<ExpenseView>(manager, 'POST', '/expenses', expense(pf.propertyId), 201);
		expect((await b.director.call('GET', `/expenses/${e.id}`)).status).toBe(404);
		expect((await b.director.call('POST', `/expenses/${e.id}/cancel`, { reason: 'Essai de B' })).status).toBe(404);
		// Une dépense de B sur un bien de A : refusée (clé composite).
		expect((await b.director.call('POST', '/expenses', expense(pf.propertyId))).status).toBe(404);
	});
});

// ---------------------------------------------------------------- impayés et relances

describe('impayés et relances', () => {
	let pf: Portfolio;
	let l: Awaited<ReturnType<typeof lease>>;
	beforeAll(async () => {
		pf = await portfolio(manager, 2, {}, agent.userId);
		l = await lease(manager, pf.units[0]!);
	});

	it('impayés groupés par locataire ; une relance WhatsApp enregistrée devient la dernière relance', async () => {
		const page = await call<Page<ArrearsGroup>>(manager, 'GET', '/collections/arrears?limit=200');
		const group = page.items.find((g) => g.tenantId === l.tenantId)!;
		expect(group.items.length).toBeGreaterThanOrEqual(2);
		expect(group.daysLate).toBeGreaterThan(0);
		const r = await call<ReminderView>(
			manager,
			'POST',
			'/reminders',
			{ id: newId(), tenantId: l.tenantId, rentDueIds: group.remindableItems.map((i) => i.id), channel: 'whatsapp_link', templateLevel: 1 },
			201
		);
		expect(r).toMatchObject({ channel: 'whatsapp_link', templateLevel: 1, sentBy: manager.userId });
		const after = (await call<Page<ArrearsGroup>>(manager, 'GET', '/collections/arrears?limit=200')).items.find(
			(g) => g.tenantId === l.tenantId
		)!;
		expect(after.lastReminder).toMatchObject({ channel: 'whatsapp_link' });
		const actions = await owner.query(`select action from audit_log where organization_id = $1 and object_id = $2`, [a.id, l.tenantId]);
		expect(actions.rows.map((x) => x.action)).toContain('reminder.record');
	});

	it('une échéance couverte par un encaissement à valider n’est ni proposée ni relancée', async () => {
		const other = await lease(manager, pf.units[1]!);
		await call(agent, 'POST', '/payments', { payments: [entry(other.id, { amount: 80_000 })] }, 201);
		const group = (await call<Page<ArrearsGroup>>(manager, 'GET', '/collections/arrears?limit=200')).items.find(
			(g) => g.tenantId === other.tenantId
		)!;
		expect(group.items[0]).toMatchObject({ awaitingValidation: true });
		expect(group.remindableItems.map((i) => i.id)).not.toContain(group.items[0]!.id);
	});

	it('agent de terrain : ni message ni impayés d’ailleurs ; visite et appel sur les locataires de ses unités seulement', async () => {
		expect(
			await refusal(agent, 'POST', '/reminders', {
				id: newId(),
				tenantId: l.tenantId,
				rentDueIds: [l.rentDues[0]!.id],
				channel: 'whatsapp_link',
				templateLevel: 1
			})
		).toMatchObject({ status: 403, code: 'FORBIDDEN_ACTION' });
		await call(
			agent,
			'POST',
			'/reminders',
			{ id: newId(), tenantId: l.tenantId, rentDueIds: [l.rentDues[0]!.id], channel: 'visit', note: 'Absent' },
			201
		);
		const elsewhere = await portfolio(manager);
		const foreign = await lease(manager, elsewhere.units[0]!);
		expect(
			await refusal(agent, 'POST', '/reminders', {
				id: newId(),
				tenantId: foreign.tenantId,
				rentDueIds: [foreign.rentDues[0]!.id],
				channel: 'call'
			})
		).toMatchObject({ status: 404 });
		const mine = await call<Page<ArrearsGroup>>(agent, 'GET', '/collections/arrears?limit=200');
		expect(mine.items.some((g) => g.tenantId === foreign.tenantId)).toBe(false);
		expect(mine.items.some((g) => g.tenantId === l.tenantId)).toBe(true);
	});

	it('interrupteur collections.reminders_whatsapp_link coupé : la relance par WhatsApp est refusée, l’appel reste possible', async () => {
		await call(a.director, 'PUT', '/organization/features/collections.reminders_whatsapp_link', { disabled: true });
		try {
			const body = { id: newId(), tenantId: l.tenantId, rentDueIds: [l.rentDues[0]!.id], channel: 'whatsapp_link', templateLevel: 2 };
			expect(await refusal(manager, 'POST', '/reminders', body)).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
			await call(manager, 'POST', '/reminders', { ...body, id: newId(), channel: 'call', templateLevel: null }, 201);
		} finally {
			await call(a.director, 'PUT', '/organization/features/collections.reminders_whatsapp_link', { disabled: false });
		}
	});

	it('modèles et seuils : lus par la gestion, modifiés par le directeur seul (journalisé)', async () => {
		const current = await call<{ templates: string[]; offsets: number[] }>(manager, 'GET', '/organization/reminder-settings');
		expect(current.offsets).toEqual([5, 15, 30]);
		const next = { templates: current.templates.map((x, i) => (i === 0 ? `${x} Merci.` : x)), offsets: [3, 10, 25] };
		expect(await refusal(manager, 'PUT', '/organization/reminder-settings', next)).toMatchObject({ status: 403 });
		expect(await call(a.director, 'PUT', '/organization/reminder-settings', next)).toMatchObject({ offsets: [3, 10, 25] });
		expect((await refusal(a.director, 'PUT', '/organization/reminder-settings', { ...next, offsets: [10, 5, 30] })).status).toBe(400);
		await call(a.director, 'PUT', '/organization/reminder-settings', current);
	});
});

// ---------------------------------------------------------------- encaissement d'une dépense

describe('encaissement d’une dépense réclamée au locataire (option A)', () => {
	it('reçu « Remboursement de dépense », imputation exacte, jamais au-delà ; la créance baisse dans les impayés', async () => {
		const pf = await portfolio(manager, 1, {}, agent.userId);
		const l = await lease(manager, pf.units[0]!);
		const claim = await call<ExpenseView>(
			manager,
			'POST',
			'/expenses',
			expense(pf.propertyId, { leaseId: l.id, borneBy: 'tenant', recovery: 'claimed_from_tenant', amount: 10_000, spentOn: today }),
			201
		);
		const d = await pay(manager, entry(l.id, { purpose: 'expense', expenseId: claim.id, amount: 4_000 }));
		expect(d.allocations).toEqual([{ target: 'expense', targetId: claim.id, direction: 'allocate', amount: 4_000 }]);
		expect(d.receipt).toMatchObject({ status: 'valid' });
		expect(JSON.stringify(d.receipt!.snapshot)).toContain('Fuite sous');
		expect(
			await refusal(manager, 'POST', '/payments', { payments: [entry(l.id, { purpose: 'expense', expenseId: claim.id, amount: 6_001 })] })
		).toMatchObject({
			status: 409,
			code: 'EXPENSE_OVERPAID'
		});
		const forOwner = await call<ExpenseView>(manager, 'POST', '/expenses', expense(pf.propertyId), 201);
		expect(
			await refusal(manager, 'POST', '/payments', {
				payments: [entry(l.id, { purpose: 'expense', expenseId: forOwner.id, amount: 1_000 })]
			})
		).toMatchObject({
			status: 409,
			code: 'PAYMENT_EXPENSE_NOT_CLAIMED'
		});
		expect(
			await refusal(agent, 'POST', '/payments', { payments: [entry(l.id, { purpose: 'expense', expenseId: claim.id, amount: 1_000 })] })
		).toMatchObject({
			status: 403
		});
		const group = (await call<Page<ArrearsGroup>>(manager, 'GET', '/collections/arrears?limit=200')).items.find(
			(g) => g.tenantId === l.tenantId
		)!;
		expect(group.items.find((i) => i.kind === 'expense_claim')).toMatchObject({ id: claim.id, balance: 6_000 });
		// Annulé : la créance revient entière.
		await call(a.director, 'POST', `/payments/${d.payment.id}/cancel`, { reason: 'Erreur de saisie' });
		const again = (await call<Page<ArrearsGroup>>(manager, 'GET', '/collections/arrears?limit=200')).items.find(
			(g) => g.tenantId === l.tenantId
		)!;
		expect(again.items.find((i) => i.kind === 'expense_claim')).toMatchObject({ balance: 10_000 });
	});
});

// ---------------------------------------------------------------- relevés

describe('relevé propriétaire : totaux, rapprochement avec les reçus valides, émission, lien, rectificatif, reversements', () => {
	let pf: Portfolio;
	let l1: Awaited<ReturnType<typeof lease>>;
	let l2: Awaited<ReturnType<typeof lease>>;
	let cancelled: PaymentDetailView;
	let issued: StatementDetailView;

	beforeAll(async () => {
		pf = await portfolio(manager, 2);
		l1 = await lease(manager, pf.units[0]!);
		l2 = await lease(manager, pf.units[1]!, 90_000, 10_000);
		// Mois écoulé : un paiement exact, un paiement partiel, un paiement annulé ensuite (avant l'émission).
		await pay(manager, entry(l1.id, { amount: 80_000, paidOn: dayOf(PREVIOUS, 3) }));
		await pay(manager, entry(l2.id, { amount: 40_000, paidOn: dayOf(PREVIOUS, 10) }));
		cancelled = await pay(manager, entry(l1.id, { amount: 50_000, paidOn: dayOf(PREVIOUS, 20) }));
		await call(a.director, 'POST', `/payments/${cancelled.payment.id}/cancel`, { reason: 'Saisi deux fois' });
		// Dépenses : une avancée pour le propriétaire (déduite), une réclamée au locataire et une de l'organisation (exclues).
		await call(manager, 'POST', '/expenses', expense(pf.propertyId, { unitId: pf.units[0]!.id }), 201);
		await call(
			manager,
			'POST',
			'/expenses',
			expense(pf.propertyId, { leaseId: l1.id, borneBy: 'tenant', recovery: 'claimed_from_tenant', amount: 7_000 }),
			201
		);
		await call(manager, 'POST', '/expenses', expense(pf.propertyId, { borneBy: 'organization', recovery: 'none', amount: 9_000 }), 201);
	});

	it('totaux du brouillon égaux aux reçus valides du mois ; paiement annulé exclu ; dépenses exclues sauf celle du propriétaire', async () => {
		const draft = await generate(manager, pf.ownerId);
		// Rapprochement : reçus valides (encaissements confirmés, non annulés) payés dans le mois, sur les baux du propriétaire.
		let valid = 0;
		for (const l of [l1, l2]) {
			const page = await call<Page<PaymentView>>(manager, 'GET', `/payments?leaseId=${l.id}&limit=200`);
			valid += page.items
				.filter((p) => p.status === 'confirmed' && p.paidOn >= dayOf(PREVIOUS, 1) && p.paidOn <= monthEnd(PREVIOUS))
				.reduce((s, p) => s + p.amount, 0);
		}
		expect(valid).toBe(120_000);
		expect(draft.totals).toMatchObject({
			collected: valid,
			// 75 000 + ⌊40 000 × 90 000 / 100 000⌋ ; charges 5 000 + 4 000.
			rentCollected: 111_000,
			chargesCollected: 9_000,
			// 10 % du loyer seul, hors charges.
			commission: 11_100,
			expenses: -15_000,
			carriedBalance: 0,
			net: 120_000 - 11_100 - 15_000
		});
		expect(draft.status).toBe('draft');
		expect(draft.document.headline).toMatchObject({ tone: 'payout', amount: 93_900 });
	});

	it('émission : brouillon à jour exigé ; relevé figé ; le même mois ne se régénère pas ; B ne voit rien', async () => {
		const draft = await generate(manager, pf.ownerId);
		expect(await refusal(manager, 'POST', `/owner-statements/${draft.id}/issue`, { revision: '00000000' })).toMatchObject({
			status: 409,
			code: 'STATEMENT_DRAFT_STALE'
		});
		expect(await refusal(viewer, 'POST', `/owner-statements/${draft.id}/issue`, { revision: draft.revision })).toMatchObject({
			status: 403
		});
		issued = await issue(manager, draft);
		expect(issued).toMatchObject({ status: 'issued', issuedOn: today, totals: { net: 93_900 } });
		expect(await refusal(manager, 'POST', '/owner-statements/generate', { ownerId: pf.ownerId, month: PREVIOUS })).toMatchObject({
			status: 409,
			code: 'STATEMENT_ALREADY_ISSUED'
		});
		expect((await b.director.call('GET', `/owner-statements/${issued.id}`)).status).toBe(404);
		expect((await b.director.call('POST', `/owner-statements/${issued.id}/share-token`)).status).toBe(404);
		expect((await call<StatementDetailView>(viewer, 'GET', `/owner-statements/${issued.id}`)).status).toBe('issued');
	});

	it('PDF produit par le worker, téléchargement journalisé', async () => {
		let url: string | null = null;
		for (let i = 0; i < 100 && !url; i += 1) {
			const r = await manager.call<{ url: string }>('GET', `/owner-statements/${issued.id}/pdf`);
			if (r.status === 200) url = r.body.url;
			else await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(url).not.toBeNull();
		const res = await fetch(reachable(url!));
		expect(res.status).toBe(200);
		expect(
			Buffer.from(await res.arrayBuffer())
				.subarray(0, 4)
				.toString()
		).toBe('%PDF');
		const actions = await owner.query(`select action from audit_log where organization_id = $1 and object_id = $2`, [a.id, issued.id]);
		expect(actions.rows.map((x) => x.action)).toEqual(
			expect.arrayContaining(['statement.generate', 'statement.issue', 'statement.download'])
		);
	});

	it('lien /s : relevé en lecture seule, sans téléphone de locataire, no-store et noindex ; révoqué ou expiré : refusé', async () => {
		const link = await call<StatementShareLinkView>(manager, 'POST', `/owner-statements/${issued.id}/share-token`, undefined, 201);
		expect(link.url).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/);
		const v = visitor();
		const r = await v.call<SharedStatementView>('GET', `/public/statements/shared/${link.token}`);
		expect(r.status).toBe(200);
		expect(r.headers.get('cache-control')).toBe('no-store');
		expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		expect(r.body.document.title).toMatch(/^Relevé de gestion · /);
		const text = JSON.stringify(r.body);
		for (const phone of [l1.tenantPhone, l2.tenantPhone]) {
			expect(text).not.toContain(phone);
			expect(text).not.toContain(phone.slice(4));
		}
		// Un jeton de A ne donne jamais un relevé de B ; un jeton inconnu ou mal formé : introuvable.
		expect((await v.call('GET', `/public/statements/shared/${'x'.repeat(43)}`)).status).toBe(404);
		expect((await v.call('GET', '/public/statements/shared/court')).status).toBe(404);
		// Expiré : la base ne renvoie plus rien.
		await owner.query(
			`update owner_statement_tokens set created_at = now() - interval '91 days', expires_at = now() - interval '1 day' where token_hash = $1`,
			[sha256(link.token)]
		);
		expect((await v.call('GET', `/public/statements/shared/${link.token}`)).status).toBe(404);
		// Révoqué.
		const second = await call<StatementShareLinkView>(manager, 'POST', `/owner-statements/${issued.id}/share-token`, undefined, 201);
		expect((await v.call('GET', `/public/statements/shared/${second.token}`)).status).toBe(200);
		await call(manager, 'POST', `/owner-statements/${issued.id}/share-token/revoke`);
		expect((await v.call('GET', `/public/statements/shared/${second.token}`)).status).toBe(404);
		expect(await refusal(agent, 'POST', `/owner-statements/${issued.id}/share-token`)).toMatchObject({ status: 403 });
	});

	it('annulation après l’émission : ligne négative sur le relevé du mois de l’annulation, l’ancien inchangé', async () => {
		const payments = await call<Page<PaymentView>>(manager, 'GET', `/payments?leaseId=${l2.id}&limit=200`);
		const partial = payments.items.find((p) => p.amount === 40_000)!;
		await call(a.director, 'POST', `/payments/${partial.id}/cancel`, { reason: 'Chèque refusé' });
		const current = await generate(manager, pf.ownerId, today.slice(0, 7));
		const line = current.document.sections[0]!.rows.find((x) => x.amount === -40_000);
		expect(line?.detail).toContain('Annulation le');
		expect((await call<StatementDetailView>(manager, 'GET', `/owner-statements/${issued.id}`)).totals.net).toBe(93_900);
		// Le mois en cours n'est pas terminé : il ne s'émet pas encore.
		expect(await refusal(manager, 'POST', `/owner-statements/${current.id}/issue`, { revision: current.revision })).toMatchObject({
			status: 409,
			code: 'STATEMENT_PERIOD_NOT_ENDED'
		});
	});

	it('rectificatif : il référence l’original et ne reprend que l’élément nouveau', async () => {
		await call(manager, 'POST', '/expenses', expense(pf.propertyId, { amount: 2_500, spentOn: dayOf(PREVIOUS, 28) }), 201);
		const rect = await call<StatementDetailView>(manager, 'POST', `/owner-statements/${issued.id}/rectify`, undefined, 201);
		expect(rect).toMatchObject({ version: 2, correctsStatementId: issued.id, status: 'draft' });
		expect(rect.totals).toMatchObject({ collected: 0, commission: 0, expenses: -2_500, net: -2_500 });
		expect(rect.document.title).toMatch(/^Relevé rectificatif n° 2 · /);
		const done = await issue(manager, rect);
		expect(done.status).toBe('issued');
		// L'original reste tel quel.
		expect((await call<StatementDetailView>(manager, 'GET', `/owner-statements/${issued.id}`)).totals.net).toBe(93_900);
	});

	it('reversements : jamais au-delà du net, contre-écriture par le directeur seul ; rien sur un relevé négatif', async () => {
		const p = await call<PayoutView>(
			manager,
			'POST',
			'/owner-payouts',
			{ id: newId(), statementId: issued.id, amount: 90_000, paidOn: today, method: 'mobile_money', reference: 'OM-123' },
			201
		);
		expect(
			await refusal(manager, 'POST', '/owner-payouts', {
				id: newId(),
				statementId: issued.id,
				amount: 3_901,
				paidOn: today,
				method: 'cash'
			})
		).toMatchObject({ status: 409, code: 'PAYOUT_EXCEEDS_NET' });
		expect(
			await refusal(viewer, 'POST', '/owner-payouts', { id: newId(), statementId: issued.id, amount: 1, paidOn: today, method: 'cash' })
		).toMatchObject({
			status: 403
		});
		expect(await refusal(manager, 'POST', `/owner-payouts/${p.id}/cancel`, { reason: 'Mauvais montant' })).toMatchObject({ status: 403 });
		const reversal = await call<PayoutView>(a.director, 'POST', `/owner-payouts/${p.id}/cancel`, { reason: 'Mauvais montant' });
		expect(reversal).toMatchObject({ kind: 'reversal', reversesPayoutId: p.id, amount: 90_000 });
		const detail = await call<StatementDetailView>(manager, 'GET', `/owner-statements/${issued.id}`);
		expect(detail).toMatchObject({ paidOut: 0, remaining: 93_900 });
		const rect = (await call<Page<StatementDetailView>>(manager, 'GET', `/owner-statements?ownerId=${pf.ownerId}`)).items.find(
			(s) => s.version === 2
		)!;
		expect(
			await refusal(manager, 'POST', '/owner-payouts', { id: newId(), statementId: rect.id, amount: 1, paidOn: today, method: 'cash' })
		).toMatchObject({
			status: 409,
			code: 'PAYOUT_NOTHING_DUE'
		});
		expect(
			(await b.director.call('POST', '/owner-payouts', { id: newId(), statementId: issued.id, amount: 1, paidOn: today, method: 'cash' }))
				.status
		).toBe(404);
	});
});

describe('relevés : quota Découverte, interrupteur, bailleur particulier', () => {
	it('formule Découverte : 2 relevés émis par mois civil, rectificatif non compté', async () => {
		const small = await createOrg(t, 'agency', 'Agence Découverte', 'discovery');
		const owners: string[] = [];
		for (let i = 0; i < 3; i += 1) owners.push((await portfolio(small.director, 0)).ownerId);
		const first = await issue(small.director, await generate(small.director, owners[0]!));
		await issue(small.director, await generate(small.director, owners[1]!));
		const third = await generate(small.director, owners[2]!);
		expect(await refusal(small.director, 'POST', `/owner-statements/${third.id}/issue`, { revision: third.revision })).toMatchObject({
			status: 403,
			code: 'QUOTA_EXCEEDED'
		});
		// Le rectificatif n'entre pas dans le quota : il est refusé ici parce qu'il n'a rien à rectifier, pas par le quota.
		const rect = await call<StatementDetailView>(small.director, 'POST', `/owner-statements/${first.id}/rectify`, undefined, 201);
		expect(await refusal(small.director, 'POST', `/owner-statements/${rect.id}/issue`, { revision: rect.revision })).toMatchObject({
			status: 409,
			code: 'STATEMENT_RECTIFICATION_EMPTY'
		});
	});

	it('interrupteur collections.owner_statements coupé : routes refusées ; bailleur particulier : pas de relevé', async () => {
		await call(a.director, 'PUT', '/organization/features/collections.owner_statements', { disabled: true });
		try {
			expect(await refusal(manager, 'GET', '/owner-statements')).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
		} finally {
			await call(a.director, 'PUT', '/organization/features/collections.owner_statements', { disabled: false });
		}
		const landlord = await createOrg(t, 'landlord', 'Bailleur relevés API');
		expect(await refusal(landlord.director, 'GET', '/owner-statements')).toMatchObject({ status: 409, code: 'STATEMENT_LANDLORD' });
	});
});

describe('tâche du 1er du mois : brouillons du mois écoulé', () => {
	it('un brouillon par propriétaire sous mandat, jamais pour un mois émis ; rejouée sans doublon', async () => {
		const pf = await portfolio(manager);
		await lease(manager, pf.units[0]!);
		const month = firstOfMonth(-2).slice(0, 7);
		const job = await queue.add(STATEMENTS_MONTHLY_JOB, { month });
		const result = (await job.waitUntilFinished(events, 30_000)) as { drafts: number };
		expect(result.drafts).toBeGreaterThan(0);
		const list = await call<Page<StatementDetailView>>(manager, 'GET', `/owner-statements?ownerId=${pf.ownerId}&month=${month}`);
		expect(list.items).toHaveLength(1);
		expect(list.items[0]).toMatchObject({ status: 'draft', version: 1 });
		const again = await queue.add(STATEMENTS_MONTHLY_JOB, { month });
		await again.waitUntilFinished(events, 30_000);
		expect(
			(await call<Page<StatementDetailView>>(manager, 'GET', `/owner-statements?ownerId=${pf.ownerId}&month=${month}`)).items
		).toHaveLength(1);
		const origins = await owner.query(
			`select origin from audit_log where organization_id = $1 and object_id = $2 and action = 'statement.generate'`,
			[a.id, list.items[0]!.id]
		);
		expect(origins.rows.every((r) => r.origin === 'job')).toBe(true);
	});
});

// ---------------------------------------------------------------- synchronisation

describe('relances et dépenses depuis l’appareil (docs/SYNC.md §5)', () => {
	it('relance et dépense appliquées (audit « sync »), rejouées sans doublon ; refus nommés', async () => {
		const pf = await portfolio(manager, 1, {}, agent.userId);
		const l = await lease(manager, pf.units[0]!);
		const reminderId = newId();
		const op = {
			key: `collections-${reminderId}`,
			op: 'PUT',
			table: 'reminders',
			id: reminderId,
			data: {
				organization_id: a.id,
				tenant_id: l.tenantId,
				rent_due_ids: JSON.stringify([l.rentDues[0]!.id]),
				expense_ids: '[]',
				channel: 'whatsapp_link',
				template_level: 1
			}
		};
		expect((await upload(manager, [op]))[0]).toMatchObject({ status: 'applied' });
		expect((await upload(manager, [op]))[0]).toMatchObject({ status: 'applied' });
		const count = await owner.query(`select count(*)::int as n from reminders where id = $1`, [reminderId]);
		expect(count.rows[0].n).toBe(1);
		const audit = await owner.query(`select origin from audit_log where action = 'reminder.record' and after->>'reminderId' = $1`, [
			reminderId
		]);
		expect(audit.rows).toEqual([{ origin: 'sync' }]);
		// L'agent de terrain : un message refusé, une visite acceptée.
		const agentOp = { ...op, key: `collections-agent-${newId()}`, id: newId() };
		expect((await upload(agent, [agentOp]))[0]).toMatchObject({ status: 'rejected', code: 'FORBIDDEN_ACTION' });
		expect(
			(
				await upload(agent, [
					{ ...agentOp, key: `v-${newId()}`, id: newId(), data: { ...op.data, channel: 'visit', template_level: null } }
				])
			)[0]
		).toMatchObject({ status: 'applied' });

		const expenseId = newId();
		const e = expense(pf.propertyId);
		const expenseOp = {
			key: `expense-${expenseId}`,
			op: 'PUT',
			table: 'expenses',
			id: expenseId,
			data: {
				organization_id: a.id,
				property_id: e.propertyId,
				spent_on: e.spentOn,
				category: e.category,
				description: e.description,
				amount: e.amount,
				paid_by: e.paidBy,
				borne_by: e.borneBy,
				recovery: e.recovery
			}
		};
		expect((await upload(manager, [expenseOp]))[0]).toMatchObject({ status: 'applied' });
		expect(
			(await upload(manager, [{ ...expenseOp, key: `x-${newId()}`, id: newId(), data: { ...expenseOp.data, status: 'cancelled' } }]))[0]
		).toMatchObject({
			status: 'rejected',
			code: 'FIELD_NOT_WRITABLE'
		});
		expect((await upload(agent, [{ ...expenseOp, key: `y-${newId()}`, id: newId() }]))[0]).toMatchObject({
			status: 'rejected',
			code: 'FORBIDDEN_ACTION'
		});
		expect((await upload(b.director, [{ ...expenseOp, key: `z-${newId()}`, id: newId() }]))[0]).toMatchObject({ status: 'rejected' });
	});
});
