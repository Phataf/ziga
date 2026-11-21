/**
 * Lot 10 bis, étape 3 : la tâche du jour tourne dans le worker, seul. Les points d'inscription d'ExitHooks y sont remplis
 * par les modules payments et collections, comme dans l'API ; un point vide fait échouer l'opération, jamais en silence.
 *
 * Les données sont préparées par l'API, qui est ensuite arrêtée : seul le worker (WorkerModule, comme `worker.ts`) reste
 * dans le processus quand la fin de bail est traitée. Le résultat est lu en SQL.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { addDays, addMonths, monthDay, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import type { LeaseDetailView, TenantView } from '@ziga/shared/leases';
import type { OwnerView } from '@ziga/shared/owners';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import type { PropertyView, UnitView } from '@ziga/shared/properties';
import { Queue, QueueEvents } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { DatabaseService } from '../src/db/database.module.js';
import { LEASES_DAILY_JOB, LEASES_QUEUE } from '../src/jobs/queues.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { ExitHooks, ExitHooksModule, ExitHooksNotRegisteredError } from '../src/modules/leases/exit-hooks.js';
import { leasesDailyFor } from '../src/modules/leases/leases-daily.js';
import { bullConnection } from '../src/redis/redis.module.js';
import { WorkerModule } from '../src/worker.module.js';
import { newPhone, startApp } from './http.js';
import { addMember, createOrg, type Member, type Org } from './orgs.js';

const config = parseConfig(process.env);
const today = toIsoDate();
const [ty, tm] = today.split('-').map(Number) as [number, number];
const firstOfMonth = (offset: number) => monthDay(ty, tm, offset, 1);

let a: Org;
let owner: pg.Client;
let worker: INestApplicationContext | null = null;
let leaseId: string;
let unitId: string;
/** Total des loyers payés par le locataire (deux mois d'avance compris). */
let paid = 0;

async function call<T>(m: Member, method: string, path: string, body?: unknown, status = 200): Promise<T> {
	const r = await m.call<T>(method, path, body);
	expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(status);
	return r.body;
}

async function rows<T = Record<string, unknown>>(q: string, params: unknown[] = []): Promise<T[]> {
	return (await owner.query(q, params)).rows as T[];
}

/** Ce que la fin de bail écrit : échéances, imputations, bail, unité, journal. */
async function snapshot() {
	return {
		dues: await rows<{
			id: string;
			period_start: string;
			period_end: string;
			status: string;
			amount_due: string;
			exit_adjusted_at: Date | null;
		}>(
			`select id, period_start::text, period_end::text, status, amount_due, exit_adjusted_at from rent_dues where lease_id = $1 order by period_start`,
			[leaseId]
		),
		allocations: await rows<{ payment_id: string; target: string; rent_due_id: string | null; direction: string; amount: string }>(
			`select payment_id, target, rent_due_id, direction, amount from payment_allocations where lease_id = $1 order by created_at, id`,
			[leaseId]
		),
		lease: (await rows<{ status: string; end_kind: string | null }>(`select status, end_kind from leases where id = $1`, [leaseId]))[0]!,
		unit: (await rows<{ technical_status: string }>(`select technical_status from units where id = $1`, [unitId]))[0]!,
		audit: await rows<{ action: string; origin: string; object_id: string }>(
			`select action, origin, object_id from audit_log where organization_id = $1 and action in ('lease.end', 'payment.credit_released') order by occurred_at, id`,
			[a.id]
		)
	};
}

beforeAll(async () => {
	// 1. L'API prépare un bail en préavis, sortie aujourd'hui, loyers payés jusqu'au mois prochain compris.
	const t = await startApp();
	a = await createOrg(t, 'agency', 'Agence worker seul');
	const manager = await addMember(t, a, 'manager');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	const tampouy = (await owner.query(`select id from neighborhoods where commune_id = 'ouagadougou' and name = 'Tampouy'`)).rows[0].id;
	const o = await call<OwnerView>(
		manager,
		'POST',
		'/owners',
		{ id: newId(), type: 'person', name: 'Awa Ouédraogo', phone: newPhone(), country: 'BF' },
		201
	);
	const p = await call<PropertyView>(
		manager,
		'POST',
		'/properties',
		{ id: newId(), ownerId: o.id, type: 'apartment_building', name: 'Cité An III', communeId: 'ouagadougou', neighborhoodId: tampouy },
		201
	);
	const unit = await call<UnitView>(
		manager,
		'POST',
		'/units',
		{ id: newId(), propertyId: p.id, type: 'apartment', label: 'W1', rent: 75_000 },
		201
	);
	unitId = unit.id;
	await call(manager, 'POST', `/properties/${p.id}/status`, { status: 'active' });
	await call(manager, 'POST', `/units/${unit.id}/status`, { status: 'active' });
	const md = await call<{ id: string }>(
		manager,
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
	await call(manager, 'POST', `/mandates/${md.id}/scopes`, { id: newId(), propertyId: p.id }, 201);
	const tn = await call<TenantView>(manager, 'POST', '/tenants', { id: newId(), fullName: 'Salif Traoré', phone: newPhone() }, 201);
	const lease = await call<LeaseDetailView>(
		manager,
		'POST',
		'/leases',
		{ id: newId(), unitId: unit.id, tenantId: tn.id, startsOn: firstOfMonth(-3), rent: 75_000, charges: 5_000, lessorType: 'owner' },
		201
	);
	leaseId = lease.id;
	// Tout ce qui est émis jusqu'au mois prochain compris : le mois prochain sera abandonné, son paiement revient au crédit.
	const owed = lease.rentDues.filter((d) => d.periodStart <= firstOfMonth(1)).reduce((s, d) => s + d.amountDue - d.amountPaid, 0);
	expect(lease.rentDues.some((d) => d.periodStart === firstOfMonth(1))).toBe(true);
	for (const amount of [owed - 80_000, 80_000]) {
		const receiptId = newId();
		await call(
			manager,
			'POST',
			'/payments',
			{
				payments: [
					{
						id: newId(),
						leaseId,
						purpose: 'rent',
						amount,
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
		paid += amount;
	}
	await call(
		manager,
		'POST',
		`/leases/${leaseId}/notice`,
		{ id: newId(), origin: 'tenant', deliveryMode: 'hand_delivery', notifiedOn: addDays(addMonths(today, -3), 1), plannedExitOn: today },
		201
	);
	// 2. L'API s'arrête : il ne reste que le worker.
	await t.close();
	worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
	await worker.init();
}, 120_000);

afterAll(async () => {
	await worker?.close();
	await owner?.end();
});

describe('ExitHooks : points d’inscription', () => {
	it('remplis dans le worker seul par payments et collections', () => {
		expect(worker!.get(ExitHooks).missing()).toEqual([]);
	});

	it('vides : le processus refuse de démarrer, une lecture lève une erreur nommée, une seconde inscription est refusée', async () => {
		await expect(NestFactory.createApplicationContext(ExitHooksModule, { logger: false })).rejects.toMatchObject({
			code: 'EXIT_HOOKS_NOT_REGISTERED',
			point: 'payments'
		});
		const empty = new ExitHooks();
		expect(() => empty.payments).toThrow(ExitHooksNotRegisteredError);
		expect(() => empty.expenses).toThrow(/le point « expenses » n’est pas inscrit ; le module collections n’est pas chargé/);
		const registered = worker!.get(ExitHooks);
		expect(() => registered.registerPayments({} as never)).toThrow(/inscrit deux fois/);
		expect(() => registered.registerExpenses({} as never)).toThrow(/inscrit deux fois/);
	});

	it('vides pendant la tâche du jour : la fin de bail échoue et rien n’est écrit', async () => {
		const before = await snapshot();
		const database = worker!.get(DatabaseService);
		const audit = worker!.get(AuditService);
		await expect(database.withOrganization(a.id, (tx) => leasesDailyFor(tx, audit, a.id, today, new ExitHooks()))).rejects.toBeInstanceOf(
			ExitHooksNotRegisteredError
		);
		expect(await snapshot()).toEqual(before);
		expect(before.lease.status).toBe('notice');
	});
});

describe('fin de bail par le worker seul', () => {
	it('dernières échéances, retour au crédit, bail terminé, unité à remettre en état ; rejouée, rien ne change', async () => {
		const queue = new Queue(LEASES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
		const events = new QueueEvents(LEASES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
		await events.waitUntilReady();
		try {
			const run = async () => (await (await queue.add(LEASES_DAILY_JOB, { today })).waitUntilFinished(events, 30_000)) as { ended: number };
			const before = await snapshot();
			expect((await run()).ended).toBeGreaterThanOrEqual(1);
			const after = await snapshot();

			expect(after.lease).toEqual({ status: 'ended', end_kind: 'tenant_exit' });
			expect(after.unit.technical_status).toBe('to_refurbish');
			// Échéances suivantes abandonnées ; la période de la sortie s'arrête au dernier jour facturé.
			const later = after.dues.filter((d) => d.period_start > today);
			expect(later.length).toBeGreaterThan(0);
			for (const d of later) expect(d, d.period_start).toMatchObject({ status: 'waived', exit_adjusted_at: expect.any(Date) });
			expect(after.dues.find((d) => d.period_start <= today && d.period_end >= today)?.period_end).toBe(today);

			// Retour au crédit : pour l'échéance du mois prochain, payée d'avance, une ligne inverse et un crédit du même
			// montant, sur le même encaissement ; journalisé par la tâche (origine « job »).
			const added = after.allocations.slice(before.allocations.length);
			const next = after.dues.find((d) => d.period_start === firstOfMonth(1))!;
			const reverse = added.filter((l) => l.direction === 'reverse' && l.rent_due_id === next.id);
			expect(reverse.reduce((s, l) => s + Number(l.amount), 0)).toBe(80_000);
			for (const r of reverse) {
				expect(added).toContainEqual({
					payment_id: r.payment_id,
					target: 'credit',
					rent_due_id: null,
					direction: 'allocate',
					amount: r.amount
				});
			}
			const newAudit = after.audit.slice(before.audit.length);
			expect(newAudit).toContainEqual({ action: 'payment.credit_released', origin: 'job', object_id: next.id });
			expect(newAudit).toContainEqual({ action: 'lease.end', origin: 'job', object_id: leaseId });

			// Rien n'est perdu : ce que le locataire a payé = échéances gardées (soldées) + crédit du bail.
			const net = (l: { direction: string; amount: string }) => (l.direction === 'allocate' ? 1 : -1) * Number(l.amount);
			const onDues = after.allocations.filter((l) => l.target === 'rent_due').reduce((s, l) => s + net(l), 0);
			const credit = after.allocations.filter((l) => l.target === 'credit').reduce((s, l) => s + net(l), 0);
			const kept = after.dues.filter((d) => d.status !== 'waived').reduce((s, d) => s + Number(d.amount_due), 0);
			expect(onDues).toBe(kept);
			expect(onDues + credit).toBe(paid);
			expect(credit).toBeGreaterThanOrEqual(80_000);

			// Rejouée le même jour : rien ne change.
			await run();
			expect(await snapshot()).toEqual(after);
		} finally {
			await Promise.all([queue.close(), events.close()]);
		}
	});
});
