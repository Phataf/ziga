/**
 * Lot 10 bis, étape 3 : sortie du locataire par l'API, par l'appareil (POST /sync/upload) et par le worker (tâche du
 * jour). Points du porteur :
 * 1. synchronisation : retenue sans ligne tenant_damage, sans montant ou sans justificatif, et imputation sur loyer sans
 *    accord accepté, refusées avec leur code ;
 * 2. tâche du jour idempotente : bail terminé à la date de sortie, dernier mois au prorata, échéances suivantes
 *    abandonnées, unité à remettre en état ; alerte avant la fin du délai de restitution ;
 * 3. imputation sur caution : encaissement interne confirmé, imputé exactement, reçu numéroté ; jamais saisi ;
 * 4. caution détenue par le propriétaire : restitution « par le propriétaire » ; relevé : loyer couvert en information,
 *    réparation avancée par l'organisation déduite ;
 * 5. signature de l'état des lieux : case cochée par chaque partie, « Case cochée par … le … sur l'appareil de … » ;
 * 6. contestation : la part non contestée restituée sans attendre, jamais au-delà ;
 * 7. transfert de gestion : écrit chez A seulement, aucune ligne chez B ;
 * 8. accès croisé par l'API et par la synchronisation sur chaque route.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { addDays, addMonths, monthDay, toIsoDate } from '@ziga/shared/dates';
import type { DocumentView } from '@ziga/shared/documents';
import { newId } from '@ziga/shared/ids';
import type { LeaseDetailView, TenantView } from '@ziga/shared/leases';
import type { OwnerView } from '@ziga/shared/owners';
import { newReceiptToken, provisionalReceiptNumber, type PaymentEntryInput, type PaymentView } from '@ziga/shared/payments';
import type { PropertyView, UnitView } from '@ziga/shared/properties';
import type { PaymentDetailView } from '@ziga/shared/receipts';
import type { StatementDetailView } from '@ziga/shared/statements';
import type { SyncOperationResult } from '@ziga/shared/sync';
import { Queue, QueueEvents } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { LEASES_DAILY_JOB, LEASES_QUEUE } from '../src/jobs/queues.js';
import { bullConnection } from '../src/redis/redis.module.js';
import { ExitHooks } from '../src/modules/leases/exit-hooks.js';
import { WorkerModule } from '../src/worker.module.js';
import { newPhone, startApp, type TestApp } from './http.js';
import { addMember, createOrg, type Member, type Org } from './orgs.js';

type Row = Record<string, unknown>;

let t: TestApp;
let a: Org;
let b: Org;
let manager: Member;
let agent: Member;
let owner: pg.Client;
let tampouy: string;
let worker: INestApplicationContext;
let queue: Queue;
let events: QueueEvents;
let counter = 0;
const config = parseConfig(process.env);
const today = toIsoDate();
const [ty, tm] = today.split('-').map(Number) as [number, number];
const firstOfMonth = (offset: number) => monthDay(ty, tm, offset, 1);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

async function call<T = Row>(m: Member, method: string, path: string, body?: unknown, status = 200): Promise<T> {
	const r = await m.call<T>(method, path, body);
	expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(status);
	return r.body;
}

async function refusal(m: Member, method: string, path: string, body?: unknown): Promise<{ status: number; code: string }> {
	const r = await m.call<{ code: string }>(method, path, body);
	return { status: r.status, code: r.body.code };
}

async function upload(m: Member, operations: unknown[]): Promise<SyncOperationResult[]> {
	const r = await m.client.call<{ results: SyncOperationResult[] }>('POST', '/sync/upload', { operations });
	expect(r.status).toBe(200);
	return r.body.results;
}

async function runDaily(day = today): Promise<{ ended: number; refundAlerts: number }> {
	const job = await queue.add(LEASES_DAILY_JOB, { today: day });
	return (await job.waitUntilFinished(events, 30_000)) as { ended: number; refundAlerts: number };
}

interface Unit {
	ownerId: string;
	propertyId: string;
	unit: UnitView;
	mandateId: string;
}

/** Un propriétaire, un bien et une unité active et prête, sous mandat de gestion. */
async function unitUnderMandate(m: Member, agentId?: string): Promise<Unit> {
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
	const unit = await call<UnitView>(
		m,
		'POST',
		'/units',
		{ id: newId(), propertyId: p.id, type: 'apartment', label: `S${++counter}`, rent: 75_000 },
		201
	);
	await call(m, 'POST', `/properties/${p.id}/status`, { status: 'active' });
	await call(m, 'POST', `/units/${unit.id}/status`, { status: 'active' });
	if (agentId) await call(m, 'POST', `/units/${unit.id}/assign`, { agentId });
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
			canCollectFunds: true
		},
		201
	);
	await call(m, 'POST', `/mandates/${md.id}/scopes`, { id: newId(), propertyId: p.id }, 201);
	return { ownerId: o.id, propertyId: p.id, unit, mandateId: md.id };
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

/** Bail en vigueur depuis quatre mois (75 000 + 5 000), caution de 100 000 reçue, détenue par `holder`. */
async function leaseWithDeposit(m: Member, u: Unit, holder: 'organization' | 'owner' = 'organization') {
	const tn = await call<TenantView>(m, 'POST', '/tenants', { id: newId(), fullName: `Locataire ${++counter}`, phone: newPhone() }, 201);
	const lease = await call<LeaseDetailView>(
		m,
		'POST',
		'/leases',
		{ id: newId(), unitId: u.unit.id, tenantId: tn.id, startsOn: firstOfMonth(-4), rent: 75_000, charges: 5_000, lessorType: 'owner' },
		201
	);
	const accountId = newId();
	await call(
		m,
		'POST',
		'/deposit-accounts',
		{ id: accountId, leaseId: lease.id, type: 'security_deposit', agreedAmount: 100_000, holder },
		201
	);
	await pay(m, entry(lease.id, { purpose: 'deposit', depositAccountId: accountId, amount: 100_000 }));
	return { lease, accountId, tenantId: tn.id };
}

/** Tout le loyer dû payé (pour isoler les retenues). */
async function payAllDue(m: Member, leaseId: string): Promise<void> {
	const l = await call<LeaseDetailView>(m, 'GET', `/leases/${leaseId}`);
	const owed = l.rentDues.filter((d) => d.status !== 'waived').reduce((s, d) => s + d.amountDue - d.amountPaid, 0);
	if (owed > 0) await pay(m, entry(leaseId, { amount: owed }));
}

/** Congé du locataire notifié il y a trois mois (préavis de 3 mois en durée indéterminée), sortie aujourd'hui. */
async function noticeExitingToday(m: Member, leaseId: string): Promise<Row> {
	return call(
		m,
		'POST',
		`/leases/${leaseId}/notice`,
		{
			id: newId(),
			origin: 'tenant',
			deliveryMode: 'hand_delivery',
			notifiedOn: addDays(addMonths(today, -3), 1),
			plannedExitOn: today
		},
		201
	);
}

async function document(
	m: Member,
	d: { type: string; leaseId?: string; propertyId?: string; unitId?: string; inspectionId?: string }
): Promise<string> {
	const created = await call<{ document: DocumentView; upload: { url: string } }>(
		m,
		'POST',
		'/documents',
		{ id: newId(), ...d, fileName: 'piece.pdf', mimeType: 'application/pdf', byteSize: PDF.length },
		201
	);
	const u = new URL(created.upload.url);
	expect(
		(await fetch(new URL(u.pathname + u.search, t.url), { method: 'PUT', body: PDF, headers: { 'content-type': 'application/pdf' } }))
			.status
	).toBe(200);
	await call(m, 'POST', `/documents/${created.document.id}/uploaded`);
	return created.document.id;
}

/** État des lieux de sortie, une ligne imputable au locataire par élément, signé des deux parties (cases cochées). */
async function exitInspection(m: Member, leaseId: string, elements: string[], sign = true) {
	const insp = await call<Row>(m, 'POST', '/inspections', { id: newId(), leaseId, type: 'exit', inspectedOn: today }, 201);
	const items: string[] = [];
	for (const element of elements) {
		const item = await call<Row>(
			m,
			'POST',
			`/inspections/${insp.id}/items`,
			{ id: newId(), room: 'Douche et WC', element, description: `${element} : cassé, à remplacer entièrement`, finding: 'tenant_damage' },
			201
		);
		items.push(item.id as string);
	}
	if (sign) {
		await call(m, 'POST', `/inspections/${insp.id}/sign`, { party: 'organization' });
		await call(m, 'POST', `/inspections/${insp.id}/sign`, { party: 'tenant' });
	}
	return { inspectionId: insp.id as string, items };
}

async function repair(m: Member, itemId: string, amount: number | null, quoteDocumentId: string | null, performedBy = 'organization') {
	return call<Row>(
		m,
		'POST',
		'/repairs',
		{ id: newId(), inspectionItemId: itemId, description: 'Remplacer', performedBy, estimatedAmount: amount, quoteDocumentId },
		201
	);
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A sortie API');
	b = await createOrg(t, 'agency', 'Agence B sortie API');
	manager = await addMember(t, a, 'manager');
	agent = await addMember(t, a, 'field_agent');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	tampouy = (await owner.query(`select id from neighborhoods where commune_id = 'ouagadougou' and name = 'Tampouy'`)).rows[0].id;
	worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
	await worker.init();
	queue = new Queue(LEASES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
	events = new QueueEvents(LEASES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
	await events.waitUntilReady();
}, 60_000);
afterAll(async () => {
	await Promise.all([queue.close(), events.close()]);
	await worker.close();
	await owner.end();
	await t.close();
});

describe('sortie complète : exemple du porteur (caution détenue par l’organisation)', () => {
	it('préavis, tâche du jour, état des lieux signé, deux retenues justifiées, 85 000 restitués ; imputation jamais saisie', async () => {
		const u = await unitUnderMandate(manager);
		const { lease, accountId } = await leaseWithDeposit(manager, u);
		const notice = await noticeExitingToday(manager, lease.id);
		expect(notice).toMatchObject({ status: 'recorded', noticeMonths: 3, rentEndsOn: today });
		expect((await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`)).status).toBe('notice');

		// Point 2 : la tâche du jour termine le bail, ajuste les échéances, l'unité passe à remettre en état ; rejouée, rien.
		await runDaily();
		const ended = await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`);
		expect(ended.status).toBe('ended');
		expect(ended.rentDues.filter((d) => d.periodStart > today).every((d) => d.status === 'waived')).toBe(true);
		const last = ended.rentDues.find((d) => d.periodStart <= today && d.periodEnd >= today)!;
		expect(last.periodEnd).toBe(today);
		const unit = await call<UnitView>(manager, 'GET', `/units/${u.unit.id}`);
		expect(unit.technicalStatus).toBe('to_refurbish');
		const before = JSON.stringify((await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`)).rentDues);
		await runDaily();
		expect(JSON.stringify((await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`)).rentDues)).toBe(before);
		await payAllDue(manager, lease.id);

		// Point 5 : cases cochées, jamais une signature électronique.
		const { inspectionId, items } = await exitInspection(manager, lease.id, ['shower', 'door']);
		const exit = await call<{ inspections: { id: string; status: string; signatures: { organization: string; tenant: string } }[] }>(
			manager,
			'GET',
			`/leases/${lease.id}/exit`
		);
		const signed = exit.inspections.find((i) => i.id === inspectionId)!;
		expect(signed.status).toBe('signed_both');
		expect(signed.signatures.organization).toMatch(/^Case cochée par .+ le \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2} sur l’appareil de .+$/);
		expect(signed.signatures.tenant).toMatch(/^Case cochée par le locataire le .+ sur l’appareil de .+$/);
		expect(JSON.stringify(signed.signatures)).not.toMatch(/électronique/);

		const q1 = await document(manager, { type: 'repair_quote', leaseId: lease.id });
		const q2 = await document(manager, { type: 'repair_quote', leaseId: lease.id });
		await repair(manager, items[0]!, 10_000, q1);
		await repair(manager, items[1]!, 5_000, q2);
		const s = await call<Row & { id: string; lines: Row[] }>(manager, 'POST', `/deposit-accounts/${accountId}/settlement`);
		expect(s).toMatchObject({ status: 'draft', received: 100_000, deductions: 15_000, refund: 85_000, claim: 0, outcome: 'refund' });
		expect(s.lines.map((l) => [l.kind, l.amount, l.blocker])).toEqual([
			['repair', 10_000, null],
			['repair', 5_000, null]
		]);
		await call(manager, 'POST', `/deposit-settlements/${s.id}/propose`);
		await call(manager, 'POST', `/deposit-settlements/${s.id}/accept`);
		expect(await refusal(manager, 'POST', `/deposit-settlements/${s.id}/close`, {})).toMatchObject({
			status: 400,
			code: 'SETTLEMENT_REFUND_DETAILS_REQUIRED'
		});
		const closed = await call<Row & { movements: Row[] }>(manager, 'POST', `/deposit-settlements/${s.id}/close`, {
			refund: { id: newId(), refundedOn: today, refundedBy: 'organization', method: 'cash' }
		});
		expect(closed.status).toBe('closed');
		expect(closed.movements.map((m) => [m.type, m.amount])).toEqual([
			['retained', 10_000],
			['retained', 5_000],
			['refunded', 85_000]
		]);
		// Point 3 : jamais saisi à la main (schéma de saisie).
		expect(
			(await refusal(manager, 'POST', '/payments', { payments: [entry(lease.id, { method: 'deposit_offset' as never })] })).status
		).toBe(400);
	});
});

describe('impayés couverts par la caution détenue par le propriétaire (points 3 et 4)', () => {
	it('imputation sur caution numérotée ; restitution par le propriétaire ; relevé : loyer en information, réparation déduite', async () => {
		const u = await unitUnderMandate(manager);
		const { lease, accountId } = await leaseWithDeposit(manager, u, 'owner');
		await noticeExitingToday(manager, lease.id);
		await runDaily();
		// Tout est payé sauf l'échéance du mois de la sortie.
		const l = await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`);
		const lastDue = l.rentDues.find((d) => d.periodStart <= today && d.periodEnd >= today)!;
		const owedBefore = l.rentDues
			.filter((d) => d.status !== 'waived' && d.id !== lastDue.id)
			.reduce((s, d) => s + d.amountDue - d.amountPaid, 0);
		if (owedBefore > 0) await pay(manager, entry(lease.id, { amount: owedBefore }));
		const unpaid =
			lastDue.amountDue -
			(await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`)).rentDues.find((d) => d.id === lastDue.id)!.amountPaid;
		expect(unpaid).toBeGreaterThan(0);

		const { items } = await exitInspection(manager, lease.id, ['taps']);
		const r = await repair(manager, items[0]!, 12_000, await document(manager, { type: 'repair_quote', leaseId: lease.id }));
		const invoice = await document(manager, { type: 'expense_receipt', propertyId: u.propertyId, unitId: u.unit.id, leaseId: lease.id });
		const done = await call<Row>(manager, 'POST', `/repairs/${r.id}/done`, {
			doneOn: today,
			actualAmount: 12_000,
			invoiceDocumentId: invoice
		});
		expect(done.expenseId).toBeTruthy();
		const s = await call<Row & { id: string; lines: Row[] }>(manager, 'POST', `/deposit-accounts/${accountId}/settlement`);
		expect(s.lines.map((x) => x.kind).sort()).toEqual(['repair', 'unpaid_rent']);
		expect(s).toMatchObject({ deductions: 12_000 + unpaid, refund: 100_000 - 12_000 - unpaid });
		await call(manager, 'POST', `/deposit-settlements/${s.id}/propose`);
		await call(manager, 'POST', `/deposit-settlements/${s.id}/accept`);
		// Le propriétaire détient la caution : c'est lui qui restitue (enregistré, jamais exécuté).
		const closed = await call<Row & { movements: Row[] }>(manager, 'POST', `/deposit-settlements/${s.id}/close`, {
			refund: { id: newId(), refundedOn: today, refundedBy: 'owner', method: 'mobile_money', reference: 'MP777' }
		});
		expect(closed.movements.find((m) => m.type === 'refunded')).toMatchObject({
			refundedBy: 'owner',
			reason: 'Restituée par le propriétaire',
			refundReference: 'MP777'
		});

		// Point 3 : l'échéance est soldée par un encaissement interne, confirmé, imputé exactement, avec un reçu numéroté.
		const payments = await call<{ items: PaymentView[] }>(manager, 'GET', `/payments?leaseId=${lease.id}`);
		const offset = payments.items.find((p) => p.method === 'deposit_offset')!;
		expect(offset).toMatchObject({ status: 'confirmed', amount: unpaid, purpose: 'rent' });
		const detail = await call<PaymentDetailView>(manager, 'GET', `/payments/${offset.id}`);
		expect(detail.receipt?.number).toMatch(/^[A-Z]{2,6}-\d{4}-\d{6}$/);
		expect((await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`)).rentDues.find((d) => d.id === lastDue.id)!.status).toBe(
			'paid'
		);

		// Point 4 : le relevé du mois, de bout en bout.
		const statement = await call<StatementDetailView>(manager, 'POST', '/owner-statements/generate', {
			ownerId: u.ownerId,
			month: today.slice(0, 7)
		});
		expect(statement.totals.rentCollectedByOwner + statement.totals.chargesCollectedByOwner).toBeGreaterThanOrEqual(unpaid);
		expect(statement.totals.expenses).toBe(-12_000);
		expect(JSON.stringify(statement.document)).toContain('retenue par vous sur la caution');
	});
});

describe('contestation (point 6) et alerte de restitution (point 2)', () => {
	it('part non contestée restituée sans attendre, jamais au-delà ; issue exigée pour clore ; alerte une fois par niveau', async () => {
		const u = await unitUnderMandate(manager);
		const { lease, accountId } = await leaseWithDeposit(manager, u);
		await noticeExitingToday(manager, lease.id);
		await runDaily();
		await payAllDue(manager, lease.id);
		const { items } = await exitInspection(manager, lease.id, ['door']);
		await repair(manager, items[0]!, 30_000, await document(manager, { type: 'repair_quote', leaseId: lease.id }));
		const s = await call<Row & { id: string }>(manager, 'POST', `/deposit-accounts/${accountId}/settlement`);
		await call(manager, 'POST', `/deposit-settlements/${s.id}/propose`);
		await call(manager, 'POST', `/deposit-settlements/${s.id}/dispute`, {
			party: 'tenant',
			observations: 'La porte était déjà abîmée à l’entrée'
		});
		expect(
			await refusal(manager, 'POST', `/deposit-settlements/${s.id}/refunds`, {
				id: newId(),
				amount: 70_001,
				refundedOn: today,
				refundedBy: 'organization',
				method: 'cash'
			})
		).toMatchObject({
			status: 409,
			code: 'SETTLEMENT_REFUND_EXCEEDS'
		});
		const partial = await call<Row>(manager, 'POST', `/deposit-settlements/${s.id}/refunds`, {
			id: newId(),
			amount: 70_000,
			refundedOn: today,
			refundedBy: 'organization',
			method: 'cash'
		});
		expect(partial).toMatchObject({ status: 'disputed', alreadyRefunded: 70_000, refundRemaining: 0 });
		expect(await refusal(manager, 'POST', `/deposit-settlements/${s.id}/close`, {})).toMatchObject({ code: 'SETTLEMENT_DISPUTE_OUTCOME' });
		const outcome = await document(manager, { type: 'settlement_outcome', leaseId: lease.id });
		const closed = await call<Row>(manager, 'POST', `/deposit-settlements/${s.id}/close`, {
			disputeOutcome: 'amicable_agreement',
			documentId: outcome
		});
		expect(closed).toMatchObject({ status: 'closed', disputeOutcome: 'amicable_agreement' });

		// Alerte : un décompte encore ouvert, sept jours avant le terme, puis après ; rejouée le même jour, rien.
		const u2 = await unitUnderMandate(manager);
		const second = await leaseWithDeposit(manager, u2);
		await noticeExitingToday(manager, second.lease.id);
		await runDaily();
		const open = await call<Row & { id: string; refundDeadline: string }>(
			manager,
			'POST',
			`/deposit-accounts/${second.accountId}/settlement`
		);
		const soon = addDays(open.refundDeadline, -3);
		expect((await runDaily(soon)).refundAlerts).toBeGreaterThanOrEqual(1);
		const alerts = async () =>
			(
				await owner.query(
					`select action from audit_log where object_id = $1 and action like 'deposit.refund_deadline_%' order by occurred_at`,
					[open.id]
				)
			).rows.map((r) => r.action);
		await runDaily(soon);
		expect(await alerts()).toEqual(['deposit.refund_deadline_soon']);
		await runDaily(addDays(open.refundDeadline, 1));
		expect(await alerts()).toEqual(['deposit.refund_deadline_soon', 'deposit.refund_deadline_overdue']);
	});
});

describe('synchronisation en écriture (point 1)', () => {
	it('état des lieux hors ligne par l’agent de terrain ; retenue et imputation non justifiées refusées avec leur code', async () => {
		const u = await unitUnderMandate(manager, agent.userId);
		const { lease, accountId } = await leaseWithDeposit(manager, u);
		await noticeExitingToday(manager, lease.id);
		const inspectionId = newId();
		const itemId = newId();
		const itemId2 = newId();
		const itemId3 = newId();
		const damaged = (id: string, element: string, position: number) => ({
			key: `it-${id}`,
			op: 'PUT',
			table: 'inspection_items',
			id,
			data: {
				organization_id: a.id,
				inspection_id: inspectionId,
				room: 'Chambre 1',
				element,
				position,
				description: `${element} : fendu sur toute la hauteur`,
				finding: 'tenant_damage'
			}
		});
		const results = await upload(agent, [
			{
				key: `i-${inspectionId}`,
				op: 'PUT',
				table: 'inspections',
				id: inspectionId,
				data: { organization_id: a.id, lease_id: lease.id, type: 'exit', inspected_on: today, furnished: 0 }
			},
			{
				key: `it-${itemId}`,
				op: 'PUT',
				table: 'inspection_items',
				id: itemId,
				data: {
					organization_id: a.id,
					inspection_id: inspectionId,
					room: 'Douche et WC',
					element: 'shower',
					position: 0,
					description: 'Pommeau arraché, flexible coupé',
					finding: 'tenant_damage'
				}
			},
			{
				key: `vague-${itemId}`,
				op: 'PUT',
				table: 'inspection_items',
				id: newId(),
				data: {
					organization_id: a.id,
					inspection_id: inspectionId,
					room: 'Salon',
					element: 'door',
					position: 1,
					description: 'Bon état général, RAS',
					finding: 'normal_wear'
				}
			},
			damaged(itemId2, 'window', 2),
			damaged(itemId3, 'wardrobe', 3),
			{
				key: `sign-o-${inspectionId}`,
				op: 'PATCH',
				table: 'inspections',
				id: inspectionId,
				organizationId: a.id,
				data: { organization_signed_at: new Date().toISOString() }
			},
			{
				key: `sign-t-${inspectionId}`,
				op: 'PATCH',
				table: 'inspections',
				id: inspectionId,
				organizationId: a.id,
				data: { tenant_signed_at: new Date().toISOString() }
			}
		]);
		expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'rejected', 'applied', 'applied', 'applied', 'applied']);
		const exit = await call<{ inspections: { status: string; signatures: { tenant: string } }[] }>(
			manager,
			'GET',
			`/leases/${lease.id}/exit`
		);
		expect(exit.inspections[0]!.status).toBe('signed_both');
		expect(exit.inspections[0]!.signatures.tenant).toMatch(/sur l’appareil de /);

		// Réparations : sans montant ; sans justificatif ; puis un accord proposé, jamais accepté.
		const noAmount = await repair(manager, itemId, null, null);
		const s = await call<Row & { id: string }>(manager, 'POST', `/deposit-accounts/${accountId}/settlement`);
		// Accord d'imputation sur le loyer du mois en cours : proposé, jamais accepté.
		const current = (await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`)).rentDues.find(
			(d) => d.periodStart === firstOfMonth(0)
		)!;
		const proposal = await call<Row>(
			manager,
			'POST',
			'/agreements',
			{
				id: newId(),
				leaseId: lease.id,
				type: 'deposit_applied_to_rent',
				proposedBy: 'tenant',
				proposedOn: addDays(firstOfMonth(0), -10),
				months: [firstOfMonth(0)]
			},
			201
		);
		const line = (data: Row) => ({
			key: `line-${newId()}`,
			op: 'PUT',
			table: 'deposit_settlement_lines',
			id: newId(),
			data: { organization_id: a.id, settlement_id: s.id, ...data }
		});
		const refused = await upload(manager, [
			line({ kind: 'repair', repair_id: noAmount.id }),
			line({ kind: 'repair', repair_id: newId() }),
			line({ kind: 'rent_by_agreement', agreement_id: proposal.id, rent_due_id: current.id }),
			line({ kind: 'rent_by_agreement', agreement_id: newId(), rent_due_id: current.id })
		]);
		expect(refused.map((r) => [r.status, r.code])).toEqual([
			['rejected', 'RETENTION_AMOUNT_MISSING'],
			['rejected', 'RETENTION_NOT_TENANT_DAMAGE'],
			['rejected', 'AGREEMENT_NOT_ACCEPTED'],
			['rejected', 'AGREEMENT_MISSING']
		]);
		// Montant sans justificatif : refusé aussi.
		const noProof = await repair(manager, itemId2, 9_000, null);
		expect((await upload(manager, [line({ kind: 'repair', repair_id: noProof.id })]))[0]).toMatchObject({
			status: 'rejected',
			code: 'RETENTION_PROOF_MISSING'
		});
		// Justifiée (montant et devis) : acceptée ; le montant est celui de la réparation, calculé par le serveur.
		const justified = await repair(manager, itemId3, 7_000, await document(manager, { type: 'repair_quote', leaseId: lease.id }));
		expect((await upload(manager, [line({ kind: 'repair', repair_id: justified.id })]))[0]).toMatchObject({ status: 'applied' });
		const draft = (
			await call<{ settlements: { id: string; lines: { repairId: string | null; amount: number }[] }[] }>(
				manager,
				'GET',
				`/leases/${lease.id}/exit`
			)
		).settlements.find((x) => x.id === s.id)!;
		expect(draft.lines.find((l) => l.repairId === justified.id)?.amount).toBe(7_000);
		// L'agent de terrain ne touche pas au décompte.
		expect((await upload(agent, [line({ kind: 'repair', repair_id: noAmount.id })]))[0]).toMatchObject({
			status: 'rejected',
			code: 'FORBIDDEN_ACTION'
		});
	});
});

describe('transfert de gestion (point 7)', () => {
	it('écrit chez A seulement : mandat terminé, bail terminé, caution au nouveau gestionnaire ; aucune ligne chez B', async () => {
		const u = await unitUnderMandate(manager);
		const { lease, accountId } = await leaseWithDeposit(manager, u);
		const countsOfB = async () => {
			const out: Record<string, number> = {};
			for (const table of [
				'management_transfers',
				'leases',
				'deposit_accounts',
				'deposit_movements',
				'mandates',
				'mandate_scopes',
				'tenants',
				'owners',
				'documents',
				'payments',
				'rent_dues',
				'audit_log'
			]) {
				out[table] = (await owner.query(`select count(*)::int as n from ${table} where organization_id = $1`, [b.id])).rows[0].n as number;
			}
			return out;
		};
		const before = await countsOfB();
		const transfer = await call<Row>(
			manager,
			'POST',
			`/mandates/${u.mandateId}/transfer`,
			{
				id: newId(),
				propertyId: u.propertyId,
				transferOn: today,
				newManagerName: 'Agence Faso Habitat',
				handedOverOn: today,
				handedOverItems: ['Bail signé', 'État des lieux d’entrée', 'Reçus de caution']
			},
			201
		);
		expect(transfer).toMatchObject({ mandateAction: 'end_mandate', leaseIds: [lease.id] });
		const l = await call<LeaseDetailView>(manager, 'GET', `/leases/${lease.id}`);
		expect(l.status).toBe('ended');
		const account = l.deposits!.find((d) => d.id === accountId)!;
		expect(account).toMatchObject({ holder: 'third_party', status: 'closed' });
		expect((await call<UnitView>(manager, 'GET', `/units/${u.unit.id}`)).technicalStatus).toBe('ready');
		expect(await countsOfB()).toEqual(before);
		// Rien n'est copié : B ne voit ni le transfert ni le bail.
		expect((await b.director.call('GET', `/leases/${lease.id}`)).status).toBe(404);
	});
});

describe('accès croisé A/B (point 8)', () => {
	it('B n’atteint aucune route de la sortie de A, ni par l’API ni par l’appareil', async () => {
		const u = await unitUnderMandate(manager);
		const { lease, accountId } = await leaseWithDeposit(manager, u);
		await noticeExitingToday(manager, lease.id);
		const { inspectionId, items } = await exitInspection(manager, lease.id, ['door'], false);
		const r = await repair(manager, items[0]!, 5_000, await document(manager, { type: 'repair_quote', leaseId: lease.id }));
		const agreement = await call<Row>(
			manager,
			'POST',
			'/agreements',
			{ id: newId(), leaseId: lease.id, type: 'tenant_self_repair', proposedBy: 'tenant', proposedOn: today },
			201
		);
		const s = await call<Row & { id: string }>(manager, 'POST', `/deposit-accounts/${accountId}/settlement`);
		const B = b.director;
		const routes: [string, string, unknown][] = [
			[
				'POST',
				`/leases/${lease.id}/notice`,
				{ id: newId(), origin: 'tenant', deliveryMode: 'other', notifiedOn: today, plannedExitOn: today }
			],
			['GET', `/leases/${lease.id}/exit`, undefined],
			['POST', '/inspections', { id: newId(), leaseId: lease.id, type: 'entry', inspectedOn: today }],
			[
				'POST',
				`/inspections/${inspectionId}/items`,
				{ id: newId(), room: 'Salon', element: 'door', description: 'Porte forcée par effraction', finding: 'tenant_damage' }
			],
			['PATCH', `/inspection-items/${items[0]}`, { description: 'Réécrite par une autre agence' }],
			['DELETE', `/inspection-items/${items[0]}`, undefined],
			['POST', `/inspections/${inspectionId}/sign`, { party: 'tenant' }],
			['POST', `/inspections/${inspectionId}/dispute`, { party: 'tenant', observations: 'Essai de B' }],
			[
				'POST',
				'/repairs',
				{ id: newId(), inspectionItemId: items[0], description: 'Essai', performedBy: 'organization', estimatedAmount: 1 }
			],
			['POST', `/repairs/${r.id}/verify`, { verifiedOn: today }],
			['POST', '/agreements', { id: newId(), leaseId: lease.id, type: 'tenant_self_repair', proposedBy: 'tenant', proposedOn: today }],
			['POST', `/agreements/${agreement.id}/decision`, { decision: 'accepted', decidedByParty: 'organization', decidedOn: today }],
			['POST', `/deposit-accounts/${accountId}/settlement`, undefined],
			['POST', `/deposit-settlements/${s.id}/propose`, undefined],
			['POST', `/deposit-settlements/${s.id}/dispute`, { party: 'tenant', observations: 'Essai de B' }],
			[
				'POST',
				`/deposit-settlements/${s.id}/refunds`,
				{ id: newId(), amount: 1, refundedOn: today, refundedBy: 'organization', method: 'cash' }
			],
			['POST', `/deposit-settlements/${s.id}/close`, {}],
			[
				'POST',
				`/mandates/${u.mandateId}/transfer`,
				{
					id: newId(),
					propertyId: u.propertyId,
					transferOn: today,
					newManagerName: 'Agence B',
					handedOverOn: today,
					handedOverItems: ['x']
				}
			]
		];
		for (const [method, path, body] of routes) {
			const res = await B.call(method, path, body);
			expect([404, 409], `${method} ${path} ${JSON.stringify(res.body)}`).toContain(res.status);
		}
		// Rien n'a changé chez A.
		const after = await call<{ inspections: { items: unknown[]; status: string }[]; settlements: { status: string }[] }>(
			manager,
			'GET',
			`/leases/${lease.id}/exit`
		);
		expect(after.inspections[0]).toMatchObject({ status: 'draft' });
		expect(after.inspections[0]!.items).toHaveLength(1);
		expect(after.settlements[0]).toMatchObject({ status: 'draft' });
		// Par l'appareil : B vise les lignes de A en se disant de A (non membre) ou de B (introuvable).
		for (const organizationId of [a.id, b.id]) {
			const res = await upload(B, [
				{
					key: `b-${newId()}`,
					op: 'PATCH',
					table: 'inspections',
					id: inspectionId,
					organizationId,
					data: { tenant_signed_at: new Date().toISOString() }
				},
				{ key: `b-${newId()}`, op: 'DELETE', table: 'inspection_items', id: items[0], organizationId },
				{
					key: `b-${newId()}`,
					op: 'PUT',
					table: 'deposit_settlement_lines',
					id: newId(),
					data: { organization_id: organizationId, settlement_id: s.id, kind: 'repair', repair_id: r.id }
				}
			]);
			expect(res.map((x) => x.status)).toEqual(['rejected', 'rejected', 'rejected']);
		}
		// L'agent de terrain non affecté : introuvable ; et jamais le décompte.
		expect((await agent.call('GET', `/leases/${lease.id}/exit`)).status).toBe(404);
		expect((await agent.call('POST', `/deposit-accounts/${accountId}/settlement`)).status).toBe(403);
	});
});

describe('ExitHooks dans les deux processus', () => {
	it('l’API (AppModule) et le worker (WorkerModule) ont chacun leurs points inscrits par payments et collections', () => {
		expect(t.app.get(ExitHooks).missing()).toEqual([]);
		expect(worker.get(ExitHooks).missing()).toEqual([]);
		expect(t.app.get(ExitHooks)).not.toBe(worker.get(ExitHooks));
	});
});

describe('étape 4 : photos et scan d’un état des lieux (agent de terrain, sans document.upload)', () => {
	const JPEG = Buffer.from(
		'/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
		'base64'
	);
	async function send(m: Member, inspectionId: string, body: Record<string, unknown>, file: Buffer, mimeType: string) {
		const created = await call<{ document: DocumentView; upload: { url: string } }>(
			m,
			'POST',
			`/inspections/${inspectionId}/documents`,
			{ id: newId(), fileName: 'photo.jpg', mimeType, byteSize: file.length, ...body },
			201
		);
		const u = new URL(created.upload.url);
		expect((await fetch(new URL(u.pathname + u.search, t.url), { method: 'PUT', body: file, headers: { 'content-type': mimeType } })).status).toBe(200);
		return created.document.id;
	}

	it('l’agent de terrain dépose la photo d’une ligne de ses unités ; jamais ailleurs, jamais signé, jamais par B', async () => {
		const u = await unitUnderMandate(manager, agent.userId);
		const { lease } = await leaseWithDeposit(manager, u);
		await noticeExitingToday(manager, lease.id);
		const insp = await call<Row>(agent, 'POST', '/inspections', { id: newId(), leaseId: lease.id, type: 'exit', inspectedOn: today }, 201);
		const item = await call<Row>(
			agent,
			'POST',
			`/inspections/${insp.id}/items`,
			{ id: newId(), room: 'Cuisine', element: 'sink', description: 'Évier fendu sur le côté gauche', finding: 'tenant_damage' },
			201
		);
		// L'agent n'a pas la route générale des documents.
		expect((await agent.call('POST', '/documents', { id: newId(), type: 'inspection_photo', leaseId: lease.id, fileName: 'a.jpg', mimeType: 'image/jpeg', byteSize: 10 })).status).toBe(403);
		const photo = await send(agent, insp.id as string, { type: 'inspection_photo', inspectionItemId: item.id }, JPEG, 'image/jpeg');
		const doc = await call<DocumentView>(agent, 'POST', `/inspections/${insp.id}/documents/${photo}/uploaded`);
		expect(doc).toMatchObject({ type: 'inspection_photo', status: 'active', leaseId: lease.id, unitId: u.unit.id, propertyId: u.propertyId });
		const row = (await owner.query(`select inspection_id, inspection_item_id, uploaded_by from documents where id = $1`, [photo])).rows[0];
		expect(row).toEqual({ inspection_id: insp.id, inspection_item_id: item.id, uploaded_by: agent.userId });
		// Une photo a sa ligne ; un scan n'en a pas.
		expect(await refusal(agent, 'POST', `/inspections/${insp.id}/documents`, { id: newId(), type: 'inspection_photo', fileName: 'a.jpg', mimeType: 'image/jpeg', byteSize: 10 })).toMatchObject({ status: 400 });
		// B ne l'atteint pas ; un document d'un autre état des lieux non plus.
		expect((await b.director.call('POST', `/inspections/${insp.id}/documents`, { id: newId(), type: 'inspection_photo', inspectionItemId: item.id, fileName: 'a.jpg', mimeType: 'image/jpeg', byteSize: 10 })).status).toBe(404);
		expect((await b.director.call('POST', `/inspections/${insp.id}/documents/${photo}/uploaded`)).status).toBe(404);
		const other = await call<Row>(manager, 'POST', '/inspections', { id: newId(), leaseId: lease.id, type: 'entry', inspectedOn: today }, 201);
		expect((await manager.call('POST', `/inspections/${other.id}/documents/${photo}/upload-url`)).status).toBe(404);
		// Scan signé : il signe l'état des lieux, affiché comme scan déposé, jamais comme une signature électronique.
		const scan = await send(manager, insp.id as string, { type: 'inspection_scan', fileName: 'edl.pdf' }, PDF, 'application/pdf');
		await call(manager, 'POST', `/inspections/${insp.id}/documents/${scan}/uploaded`);
		const signed = await call<Row>(manager, 'POST', `/inspections/${insp.id}/sign`, { scanDocumentId: scan });
		expect(signed.status).toBe('signed_both');
		// Signé : plus aucune photo.
		expect(await refusal(agent, 'POST', `/inspections/${insp.id}/documents`, { id: newId(), type: 'inspection_photo', inspectionItemId: item.id, fileName: 'b.jpg', mimeType: 'image/jpeg', byteSize: 10 })).toMatchObject({ status: 409, code: 'INSPECTION_LOCKED' });
		// Désaffecté : l'agent ne l'atteint plus.
		await call(manager, 'POST', `/units/${u.unit.id}/assign`, { agentId: null });
		expect((await agent.call('POST', `/inspections/${insp.id}/documents/${photo}/uploaded`)).status).toBe(404);
	});
});
