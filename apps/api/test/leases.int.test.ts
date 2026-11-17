/**
 * Lot 08, étape 3 : locataires, baux, échéances et cautions par l'API, par la synchronisation (POST /sync/upload) et
 * par la tâche quotidienne du worker.
 * - Locataire : état civil réservé au directeur et au gestionnaire ; agent de terrain limité aux baux de ses unités.
 * - Bail : brouillon puis validation ; statut décidé par le serveur ; échéances générées par le serveur, sans doublon ;
 *   découpage recopié du réglage de l'organisation, figé ensuite ; garde-fous (mandat, disponibilité, règle 8).
 * - Deux appareils hors ligne, un bail chacun sur la même unité : le second est refusé (UNIT_ALREADY_LEASED).
 * - Changement de loyer : version attendue, échéances émises intactes ; annulation : échéances abandonnées.
 * - Tâche quotidienne : bail signé qui commence, échéance due à sa date, en retard le lendemain, rejouée sans effet.
 * - Caution : avertissement et audit au-delà de deux mois de loyer, versements partiels, détenteur par mouvement.
 * - Occupation calculée sur la fiche de l'unité ; accès croisé A/B par l'API et par l'appareil.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { addDays, addMonths, monthDay, toIsoDate } from '@ziga/shared/dates';
import type { DocumentView } from '@ziga/shared/documents';
import { newId } from '@ziga/shared/ids';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import type { DepositAccountView, LeaseDetailView, Page, TenantDetailView, TenantView, WithWarnings } from '@ziga/shared/leases';
import type { MandateView, OwnerView } from '@ziga/shared/owners';
import type { PropertyView, UnitView } from '@ziga/shared/properties';
import type { SyncOperationResult } from '@ziga/shared/sync';
import { Queue, QueueEvents } from 'bullmq';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.js';
import { LEASES_DAILY_JOB, LEASES_QUEUE } from '../src/jobs/queues.js';
import { bullConnection } from '../src/redis/redis.module.js';
import type { PresignedUpload } from '../src/storage/storage.js';
import { WorkerModule } from '../src/worker.module.js';
import { newPhone, startApp, type TestApp } from './http.js';
import { addMember, createOrg, type Member, type Org } from './orgs.js';

let t: TestApp;
let a: Org;
let b: Org;
let landlord: Org;
let manager: Member;
let agent: Member;
let viewer: Member;
let owner: pg.Client;
let tampouy: string;
let counter = 0;

const today = toIsoDate();
const [ty, tm] = today.split('-').map(Number) as [number, number];
/** Le 1er du mois prochain, et du mois suivant. */
const nextMonth = monthDay(ty, tm, 1, 1);
const key = () => `leases-${newId()}:${++counter}`;

async function call<T>(m: Member, method: string, path: string, body?: unknown, status = 200): Promise<T> {
	const r = await m.call<T>(method, path, body);
	expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(status);
	return r.body;
}

interface Place {
	owner: OwnerView;
	mandate: MandateView | null;
	property: PropertyView;
	unit: UnitView;
}

/** Une unité active et prête, couverte (ou non) par un mandat de gestion de l'organisation. */
async function place(m: Member, opts: { mandate?: boolean; canCollectFunds?: boolean; agentId?: string } = {}): Promise<Place> {
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
		{ id: newId(), ownerId: o.id, type: 'apartment_building', name: 'Immeuble', communeId: 'ouagadougou', neighborhoodId: tampouy },
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
	if (opts.agentId) await call(m, 'POST', `/units/${u.id}/assign`, { agentId: opts.agentId });
	let mandate: MandateView | null = null;
	if (opts.mandate !== false) {
		mandate = await call<MandateView>(
			m,
			'POST',
			'/mandates',
			{
				id: newId(),
				ownerId: o.id,
				type: 'rental_management',
				startsOn: '2025-01-01',
				commission: { basis: 'percent_of_collected', rateBp: 1000 },
				canCollectFunds: opts.canCollectFunds ?? true
			},
			201
		);
		await call(m, 'POST', `/mandates/${mandate.id}/scopes`, { id: newId(), propertyId: p.id }, 201);
	}
	return { owner: o, mandate, property: p, unit: await call<UnitView>(m, 'GET', `/units/${u.id}`) };
}

async function tenant(m: Member, extra: Record<string, unknown> = {}): Promise<TenantView> {
	return call<TenantView>(m, 'POST', '/tenants', { id: newId(), fullName: 'Issa Kaboré', phone: newPhone(), ...extra }, 201);
}

function leaseBody(unitId: string, tenantId: string, extra: Record<string, unknown> = {}) {
	return { id: newId(), unitId, tenantId, startsOn: nextMonth, rent: 75_000, charges: 5_000, lessorType: 'owner', ...extra };
}

async function lease(m: Member, unitId: string, tenantId: string, extra: Record<string, unknown> = {}): Promise<LeaseDetailView> {
	return call<LeaseDetailView>(m, 'POST', '/leases', leaseBody(unitId, tenantId, extra), 201);
}

async function upload(m: Member, operations: unknown[]): Promise<SyncOperationResult[]> {
	const r = await m.client.call<{ results: SyncOperationResult[] }>('POST', '/sync/upload', { operations });
	expect(r.status).toBe(200);
	return r.body.results;
}

async function audit(organizationId: string, objectId: string) {
	const r = await owner.query(
		`select action, origin, before, after from audit_log where organization_id = $1 and object_id = $2 order by id`,
		[organizationId, objectId]
	);
	return r.rows as { action: string; origin: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[];
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A baux API');
	b = await createOrg(t, 'agency', 'Agence B baux API');
	landlord = await createOrg(t, 'landlord', 'Bailleur baux API');
	manager = await addMember(t, a, 'manager');
	agent = await addMember(t, a, 'field_agent');
	viewer = await addMember(t, a, 'viewer');
	owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await owner.connect();
	tampouy = (await owner.query(`select id from neighborhoods where commune_id = 'ouagadougou' and name = 'Tampouy'`)).rows[0].id;
});
afterAll(async () => {
	await owner.end();
	await t.close();
});

describe('locataires', () => {
	it('aucun champ obligatoire hormis le nom ; état civil chez le directeur et le gestionnaire seulement', async () => {
		const minimal = await tenant(manager, { phone: undefined });
		expect(minimal).toMatchObject({ fullName: 'Issa Kaboré', phone: null, status: 'active' });
		const full = await tenant(manager, {
			civility: 'mrs',
			fullName: 'Awa Ouédraogo',
			profession: 'Infirmière',
			identity: { birthDate: '1990-04-12', birthPlace: 'Koudougou', idType: 'cnib', idNumber: 'B12345678', idIssuedOn: '2022-01-10' }
		});
		const asManager = await call<TenantDetailView>(manager, 'GET', `/tenants/${full.id}`);
		expect(asManager.identity).toMatchObject({ birthPlace: 'Koudougou', idNumber: 'B12345678' });
		const asViewer = await call<TenantDetailView>(viewer, 'GET', `/tenants/${full.id}`);
		expect(asViewer.identity).toBeNull();
		expect(asViewer.fullName).toBe('Awa Ouédraogo');
		expect((await viewer.call('GET', `/tenants/${full.id}/identity`)).status).toBe(403);
		expect((await viewer.call('PUT', `/tenants/${full.id}/identity`, { idNumber: 'X' })).status).toBe(403);
		expect((await agent.call('POST', '/tenants', { id: newId(), fullName: 'Intrus' })).status).toBe(403);
		const updated = await call(manager, 'PUT', `/tenants/${full.id}/identity`, { idNumber: 'B87654321' });
		expect(updated).toMatchObject({ idNumber: 'B87654321', birthPlace: 'Koudougou' });
		expect((await audit(a.id, full.id)).map((e) => e.action)).toEqual(['tenant.create', 'tenant.identity_update']);
	});

	it('liste paginée par curseur', async () => {
		for (let i = 0; i < 3; i++) await tenant(a.director, { fullName: `Locataire ${i}` });
		const first = await call<Page<TenantView>>(a.director, 'GET', '/tenants?limit=2');
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).toBe(first.items[1]!.id);
		const second = await call<Page<TenantView>>(a.director, 'GET', `/tenants?limit=2&cursor=${first.nextCursor}`);
		expect(second.items[0]!.id > first.items[1]!.id).toBe(true);
	});
});

describe('bail : création, validation et échéances générées par le serveur', () => {
	it('bail validé : statut décidé par le serveur, échéances générées une fois, audit, occupation calculée, alerte', async () => {
		const p = await place(manager);
		const tn = await tenant(manager);
		const l = await lease(manager, p.unit.id, tn.id, { durationMonths: 12, advanceMonths: 2 });
		expect(l).toMatchObject({
			status: 'signed',
			billingMode: 'calendar_prorata',
			version: 1,
			activatedOn: today,
			alerts: ['contract_unsigned']
		});
		expect(l.endsOn).toBe(addDays(addMonths(nextMonth, 12), -1));
		expect(l.rentDues).toHaveLength(12);
		expect(l.rentDues.filter((d) => d.isAdvance).map((d) => d.dueOn)).toEqual([today, today]);
		// L'avance est due dès la signature ; les autres échéances sont à venir.
		expect(l.rentDues.every((d) => d.amountDue === 80_000)).toBe(true);
		expect(l.rentDues.map((d) => d.status)).toEqual(['due', 'due', ...Array(10).fill('upcoming')]);
		expect((await audit(a.id, l.id)).map((e) => e.action)).toEqual(['lease.create', 'lease.validate', 'rent_dues.generate']);
		expect(await call<UnitView>(manager, 'GET', `/units/${p.unit.id}`)).toMatchObject({ occupancy: 'reserved', available: false });
		// Revalider ne génère rien de plus.
		expect((await manager.call('POST', `/leases/${l.id}/validate`)).body).toMatchObject({ code: 'LEASE_ALREADY_VALIDATED' });
		const n = await owner.query(`select count(*)::int as n from rent_dues where lease_id = $1`, [l.id]);
		expect(n.rows[0].n).toBe(12);
	});

	it('brouillon : modifiable, sans échéance ; validé ensuite ; un bail validé ne change plus ses conditions', async () => {
		const p = await place(manager);
		const tn = await tenant(manager);
		const draft = await lease(manager, p.unit.id, tn.id, { validate: false });
		expect(draft).toMatchObject({ status: 'draft', rentDues: [], activatedOn: null });
		expect(await call<UnitView>(manager, 'GET', `/units/${p.unit.id}`)).toMatchObject({ occupancy: 'free' });
		const edited = await call<LeaseDetailView>(manager, 'PATCH', `/leases/${draft.id}`, { dueDay: 10, rent: 90_000 });
		expect(edited).toMatchObject({ dueDay: 10, rent: 90_000, status: 'draft' });
		const valid = await call<LeaseDetailView>(manager, 'POST', `/leases/${draft.id}/validate`);
		expect(valid.rentDues[0]).toMatchObject({ dueOn: monthDay(ty, tm, 1, 10), amountDue: 95_000 });
		expect((await manager.call('PATCH', `/leases/${draft.id}`, { dueDay: 12 })).body).toMatchObject({ code: 'LEASE_TERMS_LOCKED' });
	});

	it('bail en vigueur depuis aujourd’hui : actif et occupé ; un second bail sur l’unité est refusé (règle 8)', async () => {
		const p = await place(manager);
		const first = await lease(manager, p.unit.id, (await tenant(manager)).id, { startsOn: today });
		expect(first.status).toBe('active');
		expect(await call<UnitView>(manager, 'GET', `/units/${p.unit.id}`)).toMatchObject({ occupancy: 'occupied', available: false });
		const r = await manager.call('POST', '/leases', leaseBody(p.unit.id, (await tenant(manager)).id, { startsOn: today }));
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject({ code: 'UNIT_NOT_AVAILABLE' });
		// Le refus n'a rien laissé : ni brouillon ni échéance.
		expect((await call<LeaseDetailView[]>(manager, 'GET', `/leases?unitId=${p.unit.id}`)).map((x) => x.id)).toEqual([first.id]);
	});

	it('garde-fous : mandat de gestion exigé ; disponibilité exigée pour un bail qui commence aujourd’hui ou plus tard seulement', async () => {
		const noMandate = await place(manager, { mandate: false });
		const tn = await tenant(manager);
		expect((await manager.call('POST', '/leases', leaseBody(noMandate.unit.id, tn.id))).body).toMatchObject({
			code: 'NO_MANAGEMENT_MANDATE'
		});
		const p = await place(manager);
		await call(manager, 'POST', `/units/${p.unit.id}/technical-status`, {
			technicalStatus: 'to_refurbish',
			reason: 'Peinture à refaire'
		});
		expect((await manager.call('POST', '/leases', leaseBody(p.unit.id, tn.id))).body).toMatchObject({ code: 'UNIT_NOT_AVAILABLE' });
		// Bail déjà en cours (repris) : seule l'absence d'un autre bail en vigueur compte, quel que soit l'état technique.
		const running = await lease(manager, p.unit.id, tn.id, { startsOn: '2024-03-01', duesStartOn: monthDay(ty, tm, 0, 1) });
		expect(running.status).toBe('active');
		expect(running.rentDues[0]!.periodStart).toBe(monthDay(ty, tm, 0, 1));
		const again = await manager.call('POST', '/leases', leaseBody(p.unit.id, tn.id, { startsOn: '2024-06-01' }));
		expect(again.body).toMatchObject({ code: 'UNIT_ALREADY_LEASED' });
	});

	it('découpage recopié du réglage de l’organisation, figé ensuite ; bailleur particulier, bailleur désigné', async () => {
		expect((await manager.call('PUT', '/organization/rent-billing-mode', { mode: 'anniversary' })).status).toBe(403);
		await call(a.director, 'PUT', '/organization/rent-billing-mode', { mode: 'anniversary' });
		const p = await place(manager);
		const l = await lease(manager, p.unit.id, (await tenant(manager)).id, { startsOn: addDays(nextMonth, 16) });
		expect(l.billingMode).toBe('anniversary');
		expect(l.rentDues[1]!.periodStart).toBe(addMonths(addDays(nextMonth, 16), 1));
		await call(a.director, 'PUT', '/organization/rent-billing-mode', { mode: 'calendar_prorata' });
		expect((await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`)).billingMode).toBe('anniversary');
		const mode = await owner.query(
			`select action, before, after from audit_log where organization_id = $1 and action = 'organization.rent_billing_mode' order by id`,
			[a.id]
		);
		expect(mode.rows.map((r) => r.after)).toEqual([{ rentBillingMode: 'anniversary' }, { rentBillingMode: 'calendar_prorata' }]);
		// Bailleur particulier : lui-même bailleur désigné et détenteur.
		const landlordOwner = (await owner.query(`select id from owners where organization_id = $1`, [landlord.id])).rows[0].id as string;
		const own = await call<UnitView>(
			landlord.director,
			'POST',
			'/units',
			{
				id: newId(),
				propertyId: (
					await call<PropertyView>(
						landlord.director,
						'POST',
						'/properties',
						{ id: newId(), ownerId: landlordOwner, type: 'house', name: 'Maison', communeId: 'ouagadougou', neighborhoodId: tampouy },
						201
					)
				).id,
				type: 'villa',
				label: 'Villa'
			},
			201
		);
		const lt = await tenant(landlord.director);
		expect((await landlord.director.call('POST', '/leases', leaseBody(own.id, lt.id, { validate: false }))).body).toMatchObject({
			code: 'LANDLORD_IS_LESSOR'
		});
		const ll = await lease(landlord.director, own.id, lt.id, { validate: false, lessorType: 'organization' });
		const holder = await landlord.director.call('POST', '/deposit-accounts', {
			id: newId(),
			leaseId: ll.id,
			type: 'security_deposit',
			agreedAmount: 150_000,
			holder: 'owner'
		});
		expect(holder.body).toMatchObject({ code: 'LANDLORD_IS_HOLDER' });
	});

	it('montants : uniquement des entiers FCFA', async () => {
		const p = await place(manager);
		const tn = await tenant(manager);
		for (const rent of [75_000.5, -1, 0, '75000']) {
			expect((await manager.call('POST', '/leases', leaseBody(p.unit.id, tn.id, { rent }))).status, String(rent)).toBe(400);
		}
		expect((await manager.call('POST', '/leases', leaseBody(p.unit.id, tn.id, { charges: 10.25 }))).status).toBe(400);
	});
});

describe('changement de loyer et annulation', () => {
	it('nouvelle version à une date d’effet ; échéances émises intactes ; version attendue', async () => {
		const p = await place(manager);
		const l = await lease(manager, p.unit.id, (await tenant(manager)).id, { advanceMonths: 1 });
		const effective = monthDay(ty, tm, 4, 1);
		expect(
			(
				await manager.call('POST', `/leases/${l.id}/rent-changes`, {
					rent: 90_000,
					charges: 5_000,
					effectiveFrom: effective,
					expectedVersion: 2
				})
			).body
		).toMatchObject({
			code: 'VERSION_CONFLICT'
		});
		expect(
			(
				await manager.call('POST', `/leases/${l.id}/rent-changes`, {
					rent: 90_000,
					charges: 5_000,
					effectiveFrom: addDays(effective, 3),
					expectedVersion: 1
				})
			).body
		).toMatchObject({ code: 'RENT_CHANGE_NOT_PERIOD_START' });
		// L'avance (due à la signature, donc émise) ne change jamais.
		expect(
			(
				await manager.call('POST', `/leases/${l.id}/rent-changes`, {
					rent: 90_000,
					charges: 5_000,
					effectiveFrom: nextMonth,
					expectedVersion: 1
				})
			).body
		).toMatchObject({ code: 'RENT_CHANGE_ON_ISSUED_DUE' });
		const changed = await call<LeaseDetailView>(manager, 'POST', `/leases/${l.id}/rent-changes`, {
			rent: 90_000,
			charges: 5_000,
			effectiveFrom: effective,
			expectedVersion: 1
		});
		expect(changed).toMatchObject({ version: 2, rent: 90_000, rentEffectiveFrom: effective });
		expect(changed.versions.map((v) => [v.version, v.rent])).toEqual([
			[1, 75_000],
			[2, 90_000]
		]);
		const before = changed.rentDues.filter((d) => d.periodStart < effective);
		const after = changed.rentDues.filter((d) => d.periodStart >= effective);
		expect(before.every((d) => d.amountDue === 80_000 && d.leaseVersion === 1)).toBe(true);
		expect(after.length).toBeGreaterThan(0);
		expect(after.every((d) => d.amountDue === 95_000 && d.leaseVersion === 2)).toBe(true);
		expect((await audit(a.id, l.id)).map((e) => e.action)).toContain('lease.rent_change');
	});

	it('annulation d’un bail signé à venir : motif, échéances abandonnées, unité libérée ; un bail en vigueur ne s’annule pas', async () => {
		const p = await place(manager);
		const l = await lease(manager, p.unit.id, (await tenant(manager)).id);
		expect((await manager.call('POST', `/leases/${l.id}/cancel`, { reason: '' })).status).toBe(400);
		const cancelled = await call<LeaseDetailView>(manager, 'POST', `/leases/${l.id}/cancel`, { reason: 'Le locataire a renoncé' });
		expect(cancelled.status).toBe('cancelled');
		expect(cancelled.rentDues.every((d) => d.status === 'waived')).toBe(true);
		expect(await call<UnitView>(manager, 'GET', `/units/${p.unit.id}`)).toMatchObject({ occupancy: 'free' });
		const active = await lease(manager, p.unit.id, (await tenant(manager)).id, { startsOn: today });
		expect((await manager.call('POST', `/leases/${active.id}/cancel`, { reason: 'Erreur' })).body).toMatchObject({
			code: 'LEASE_NOT_CANCELLABLE'
		});
	});

	it('vente du bien : le bail suit l’unité ; ses échéances et sa caution ne changent pas', async () => {
		const p = await place(manager);
		const l = await lease(manager, p.unit.id, (await tenant(manager)).id, { startsOn: today });
		await call(
			manager,
			'POST',
			'/deposit-accounts',
			{ id: newId(), leaseId: l.id, type: 'security_deposit', agreedAmount: 150_000, holder: 'owner' },
			201
		);
		await call(manager, 'POST', `/mandates/${p.mandate!.id}/revoke`, { reason: 'Vente du bien à un nouveau propriétaire' });
		const buyer = await call<OwnerView>(
			manager,
			'POST',
			'/owners',
			{ id: newId(), type: 'person', name: 'Nouvel acquéreur', phone: newPhone(), country: 'BF' },
			201
		);
		await call(manager, 'PATCH', `/properties/${p.property.id}`, { ownerId: buyer.id });
		const after = await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`);
		expect(after).toMatchObject({ status: 'active', version: 1, rent: 75_000 });
		expect(after.rentDues).toEqual(l.rentDues);
		expect(after.deposits).toHaveLength(1);
	});
});

describe('caution (règle 14, D15)', () => {
	it('au-delà de deux mois de loyer : avertissement et audit, sans blocage ; garantie des factures hors plafond', async () => {
		const p = await place(manager);
		const l = await lease(manager, p.unit.id, (await tenant(manager)).id);
		const over = await call<WithWarnings<DepositAccountView>>(
			manager,
			'POST',
			'/deposit-accounts',
			{ id: newId(), leaseId: l.id, type: 'security_deposit', agreedAmount: 225_000, agreedMonths: 3, holder: 'organization' },
			201
		);
		expect(over.warnings).toEqual(['DEPOSIT_ABOVE_LEGAL_CAP']);
		expect(over.data).toMatchObject({ aboveLegalCap: true, status: 'pending' });
		expect((await audit(a.id, over.data.id)).map((e) => e.action)).toEqual(['deposit.create', 'deposit.above_legal_cap']);
		const utilities = await call<WithWarnings<DepositAccountView>>(
			manager,
			'POST',
			'/deposit-accounts',
			{ id: newId(), leaseId: l.id, type: 'utilities_guarantee', agreedAmount: 300_000, holder: 'organization' },
			201
		);
		expect(utilities.warnings).toEqual([]);
		expect(
			(await manager.call('POST', '/deposit-accounts', { id: newId(), leaseId: l.id, type: 'security_deposit', agreedAmount: 1 })).status
		).toBe(400);
	});

	it('versements partiels, solde restant dû, dépassement refusé ; détenteur par mouvement ; agent de terrain exclu', async () => {
		const p = await place(manager, { canCollectFunds: false, agentId: agent.userId });
		const l = await lease(manager, p.unit.id, (await tenant(manager)).id);
		expect(await call(manager, 'GET', `/leases/${l.id}/proposed-holder`)).toEqual({ holder: 'owner' });
		const account = (
			await call<WithWarnings<DepositAccountView>>(
				manager,
				'POST',
				'/deposit-accounts',
				{ id: newId(), leaseId: l.id, type: 'security_deposit', agreedAmount: 150_000, agreedMonths: 2, holder: 'owner' },
				201
			)
		).data;
		// Lot 09 : la route « versement reçu » du lot 08 est retirée ; un versement de caution est un encaissement, avec son
		// reçu (réponse du porteur, point 3).
		expect(
			(await manager.call('POST', `/deposit-accounts/${account.id}/receipts`, { id: newId(), amount: 100_000, occurredOn: today })).body
		).toMatchObject({ code: 'DEPOSIT_RECEIPT_VIA_PAYMENT' });
		const depositPayment = (amount: number) => {
			const receiptId = newId();
			return {
				payments: [
					{
						id: newId(),
						leaseId: l.id,
						purpose: 'deposit',
						depositAccountId: account.id,
						amount,
						method: 'cash',
						paidOn: today,
						receiptId,
						provisionalNumber: provisionalReceiptNumber(receiptId),
						verificationToken: newReceiptToken(),
						shareToken: newReceiptToken()
					}
				]
			};
		};
		const accountOf = async () =>
			(await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`)).deposits!.find((x) => x.id === account.id)!;
		await call(manager, 'POST', '/payments', depositPayment(100_000), 201);
		expect(await accountOf()).toMatchObject({
			status: 'partially_received',
			balances: { received: 100_000, remainingDue: 50_000, held: 100_000 }
		});
		expect((await manager.call('POST', '/payments', depositPayment(50_001))).body).toMatchObject({ code: 'DEPOSIT_OVERPAID' });
		await call(manager, 'POST', '/payments', depositPayment(50_000), 201);
		expect(await accountOf()).toMatchObject({ status: 'held', balances: { received: 150_000, remainingDue: 0 } });
		const moved = await call<DepositAccountView>(
			manager,
			'POST',
			`/deposit-accounts/${account.id}/holder-changes`,
			{ id: newId(), newHolder: 'organization', occurredOn: today, reason: 'Le propriétaire confie la caution à l’agence' },
			201
		);
		expect(moved.holder).toBe('organization');
		expect(moved.movements.map((m) => m.type)).toEqual(['received', 'received', 'holder_changed']);
		// Montant convenu figé après la validation du bail.
		expect((await manager.call('PATCH', `/deposit-accounts/${account.id}`, { agreedAmount: 200_000 })).body).toMatchObject({
			code: 'DEPOSIT_TERMS_LOCKED'
		});
		// Agent de terrain : il lit le bail de son unité, sans les cautions, et n'encaisse pas de caution.
		const seen = await call<LeaseDetailView>(agent, 'GET', `/leases/${l.id}`);
		expect(seen.deposits).toBeNull();
		expect(seen.rentDues.length).toBeGreaterThan(0);
		expect(
			(await agent.call('POST', `/deposit-accounts/${account.id}/receipts`, { id: newId(), amount: 1, occurredOn: today })).status
		).toBe(403);
		expect((await agent.call('POST', '/payments', depositPayment(1))).body).toMatchObject({ code: 'FORBIDDEN_ACTION' });
		const tenantSeen = await call<TenantDetailView>(agent, 'GET', `/tenants/${l.tenantId}`);
		expect(tenantSeen.identity).toBeNull();
	});
});

describe('synchronisation depuis l’appareil', () => {
	function leasePut(unitId: string, tenantId: string, extra: Record<string, unknown> = {}) {
		return {
			key: key(),
			op: 'PUT',
			table: 'leases',
			id: newId(),
			data: {
				organization_id: a.id,
				unit_id: unitId,
				tenant_id: tenantId,
				starts_on: today,
				rent: 75_000,
				charges: 5_000,
				lessor_type: 'owner',
				status: 'active',
				version: 1,
				...extra
			}
		};
	}

	it('deux appareils hors ligne créent un bail sur la même unité : le premier est appliqué, le second refusé (règle 8)', async () => {
		const p = await place(a.director);
		const t1 = await tenant(a.director);
		const t2 = await tenant(manager);
		const first = leasePut(p.unit.id, t1.id);
		const second = leasePut(p.unit.id, t2.id);
		const [r1] = await upload(a.director, [first]);
		expect(r1).toMatchObject({ status: 'applied' });
		const [r2] = await upload(manager, [second]);
		expect(r2).toMatchObject({ status: 'rejected', code: 'UNIT_NOT_AVAILABLE', organizationId: a.id });
		expect((await owner.query(`select count(*)::int as n from leases where id = $1`, [second.id])).rows[0].n).toBe(0);
		// Rejeu du premier : rien de plus, aucune échéance en double.
		const dues = (await owner.query(`select count(*)::int as n from rent_dues where lease_id = $1`, [first.id])).rows[0].n;
		const [again] = await upload(a.director, [first]);
		expect(again).toMatchObject({ status: 'applied', replayed: true });
		expect((await owner.query(`select count(*)::int as n from rent_dues where lease_id = $1`, [first.id])).rows[0].n).toBe(dues);
		expect((await audit(a.id, first.id)).every((e) => e.origin === 'sync')).toBe(true);
	});

	it('même en même temps : la base tranche (UNIT_ALREADY_LEASED), un seul bail en vigueur', async () => {
		const p = await place(a.director);
		const ops = [leasePut(p.unit.id, (await tenant(a.director)).id), leasePut(p.unit.id, (await tenant(manager)).id)];
		const results = await Promise.all([upload(a.director, [ops[0]]), upload(manager, [ops[1]])]);
		const statuses = results.map(([r]) => r!.status).sort();
		expect(statuses).toEqual(['applied', 'rejected']);
		const rejected = results.map(([r]) => r!).find((r) => r.status === 'rejected')!;
		expect(['UNIT_ALREADY_LEASED', 'UNIT_NOT_AVAILABLE']).toContain(rejected.code);
		const n = await owner.query(`select count(*)::int as n from leases where unit_id = $1 and status in ('active', 'notice')`, [p.unit.id]);
		expect(n.rows[0].n).toBe(1);
	});

	it('statut et colonnes : le statut est une demande, les échéances et l’occupation ne s’écrivent pas', async () => {
		const p = await place(a.director);
		const tn = await tenant(a.director);
		const put = leasePut(p.unit.id, tn.id, { starts_on: nextMonth, status: 'active' });
		expect((await upload(a.director, [put]))[0]).toMatchObject({ status: 'applied' });
		// L'appareil a demandé « active » ; le serveur a décidé « signed » (début futur).
		expect((await call<LeaseDetailView>(a.director, 'GET', `/leases/${put.id}`)).status).toBe('signed');
		const refused = await upload(a.director, [
			leasePut(p.unit.id, tn.id, { status: 'notice' }),
			{ key: key(), op: 'PATCH', table: 'leases', id: put.id, organizationId: a.id, data: { due_day: 12 } },
			{ key: key(), op: 'PATCH', table: 'leases', id: put.id, organizationId: a.id, data: { activated_on: today } },
			{ key: key(), op: 'PUT', table: 'rent_dues', id: newId(), data: { organization_id: a.id, lease_id: put.id } },
			{ key: key(), op: 'PATCH', table: 'units', id: p.unit.id, organizationId: a.id, data: { occupancy: 'free' } },
			{ key: key(), op: 'PATCH', table: 'deposit_accounts', id: newId(), organizationId: a.id, data: { holder: 'owner' } }
		]);
		expect(refused.map((r) => r.code)).toEqual([
			'LEASE_TRANSITION_NOT_ALLOWED',
			'LEASE_TERMS_LOCKED',
			'FIELD_NOT_WRITABLE',
			'TABLE_NOT_WRITABLE',
			'FIELD_NOT_WRITABLE',
			'FIELD_NOT_WRITABLE'
		]);
	});

	it('changement de loyer hors ligne : version suivante attendue ; rejeté si le bail a changé entre-temps', async () => {
		const p = await place(a.director);
		const l = await lease(a.director, p.unit.id, (await tenant(a.director)).id);
		const effective = monthDay(ty, tm, 3, 1);
		const ok = await upload(manager, [
			{
				key: key(),
				op: 'PATCH',
				table: 'leases',
				id: l.id,
				organizationId: a.id,
				data: { rent: 85_000, rent_effective_from: effective, version: 2 }
			}
		]);
		expect(ok[0]).toMatchObject({ status: 'applied' });
		const stale = await upload(a.director, [
			{
				key: key(),
				op: 'PATCH',
				table: 'leases',
				id: l.id,
				organizationId: a.id,
				data: { rent: 99_000, rent_effective_from: monthDay(ty, tm, 5, 1), version: 2 }
			}
		]);
		expect(stale[0]).toMatchObject({ status: 'rejected', code: 'VERSION_CONFLICT' });
		expect((await call<LeaseDetailView>(a.director, 'GET', `/leases/${l.id}`)).rent).toBe(85_000);
	});

	it('locataire, état civil et compte de caution créés hors ligne ; versement de caution refusé (lot 09) ; agent de terrain refusé', async () => {
		const p = await place(a.director);
		const tenantId = newId();
		const leaseOp = leasePut(p.unit.id, tenantId);
		const accountId = newId();
		const results = await upload(manager, [
			{
				key: key(),
				op: 'PUT',
				table: 'tenants',
				id: tenantId,
				data: { organization_id: a.id, full_name: 'Salif Traoré', phone: '+22670998877' }
			},
			{
				key: key(),
				op: 'PUT',
				table: 'tenant_identities',
				id: tenantId,
				data: { organization_id: a.id, id_type: 'passport', id_number: 'P0001' }
			},
			leaseOp,
			{
				key: key(),
				op: 'PUT',
				table: 'deposit_accounts',
				id: accountId,
				data: { organization_id: a.id, lease_id: leaseOp.id, type: 'security_deposit', agreed_amount: 150_000, holder: 'organization' }
			},
			{
				key: key(),
				op: 'PUT',
				table: 'deposit_movements',
				id: newId(),
				data: { organization_id: a.id, account_id: accountId, type: 'received', amount: 75_000, occurred_on: today }
			}
		]);
		// Lot 09 : un versement de caution ne s'écrit plus en mouvement depuis l'appareil ; il s'encaisse, avec son reçu.
		expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'rejected']);
		expect(results[4]).toMatchObject({ code: 'DEPOSIT_RECEIPT_VIA_PAYMENT' });
		expect((await call<TenantDetailView>(manager, 'GET', `/tenants/${tenantId}`)).identity).toMatchObject({
			idType: 'passport',
			idNumber: 'P0001'
		});
		const detail = await call<LeaseDetailView>(manager, 'GET', `/leases/${leaseOp.id}`);
		expect(detail.deposits![0]).toMatchObject({ status: 'pending', balances: { received: 0, remainingDue: 150_000 } });
		const denied = await upload(agent, [
			{ key: key(), op: 'PUT', table: 'tenants', id: newId(), data: { organization_id: a.id, full_name: 'Intrus' } },
			{ key: key(), op: 'PATCH', table: 'tenant_identities', id: tenantId, organizationId: a.id, data: { id_number: 'X' } }
		]);
		expect(denied.map((r) => r.code)).toEqual(['FORBIDDEN_ACTION', 'FORBIDDEN_ACTION']);
	});
});

describe('accès croisé A/B par l’API et par l’appareil (règle 1)', () => {
	it('B ne lit, ne modifie ni ne référence rien de A', async () => {
		const p = await place(a.director);
		const tn = await tenant(a.director);
		const l = await lease(a.director, p.unit.id, tn.id);
		expect((await b.director.call('GET', `/leases/${l.id}`)).status).toBe(404);
		expect((await b.director.call('GET', `/tenants/${tn.id}`)).status).toBe(404);
		expect((await b.director.call('POST', `/leases/${l.id}/cancel`, { reason: 'Piratage' })).status).toBe(404);
		expect((await b.director.call<Page<TenantView>>('GET', '/tenants')).body.items.map((x) => x.id)).not.toContain(tn.id);
		const bTenant = await tenant(b.director);
		expect((await b.director.call('POST', '/leases', leaseBody(p.unit.id, bTenant.id))).body).toMatchObject({ code: 'UNIT_NOT_FOUND' });
		const rejected = await upload(b.director, [
			{
				key: key(),
				op: 'PATCH',
				table: 'leases',
				id: l.id,
				organizationId: b.id,
				data: { rent: 1, rent_effective_from: nextMonth, version: 2 }
			},
			{ key: key(), op: 'PATCH', table: 'tenants', id: tn.id, organizationId: a.id, data: { full_name: 'Piraté' } }
		]);
		expect(rejected.map((r) => r.status)).toEqual(['rejected', 'rejected']);
		expect((await call<TenantDetailView>(a.director, 'GET', `/tenants/${tn.id}`)).fullName).toBe('Issa Kaboré');
		// Un document de B rattaché au bail de A : introuvable.
		const doc = await b.director.call('POST', '/documents', {
			id: newId(),
			type: 'signed_lease_scan',
			leaseId: l.id,
			fileName: 'bail.pdf',
			mimeType: 'application/pdf',
			byteSize: 100
		});
		expect(doc.body).toMatchObject({ code: 'LEASE_NOT_FOUND' });
	});
});

describe('bail scanné : l’alerte « Contrat non signé » tombe', () => {
	it('un bail scanné en vigueur retire l’alerte ; le bail peut rester en vigueur sans contrat (D20)', async () => {
		const p = await place(manager);
		const l = await lease(manager, p.unit.id, (await tenant(manager)).id, { startsOn: today });
		expect(l.alerts).toEqual(['contract_unsigned']);
		const file = Buffer.from('%PDF-1.7\n% bail signé\n%%EOF\n');
		const r = await manager.call<{ document: DocumentView; upload: PresignedUpload }>('POST', '/documents', {
			id: newId(),
			type: 'signed_lease_scan',
			leaseId: l.id,
			fileName: 'Bail signé.pdf',
			mimeType: 'application/pdf',
			byteSize: file.length
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.document).toMatchObject({ leaseId: l.id, type: 'signed_lease_scan' });
		const put = await fetch(new URL(new URL(r.body.upload.url).pathname + new URL(r.body.upload.url).search, t.url), {
			method: 'PUT',
			body: file,
			headers: { 'content-type': 'application/pdf' }
		});
		expect(put.status).toBe(200);
		expect((await manager.call<DocumentView>('POST', `/documents/${r.body.document.id}/uploaded`)).body).toMatchObject({
			status: 'active'
		});
		expect((await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`)).alerts).toEqual([]);
		// L'agent de terrain ne voit jamais le document (matrice D22).
		expect((await agent.call('GET', `/documents/${r.body.document.id}`)).status).toBe(403);
	});
});

describe('tâche quotidienne (worker)', () => {
	let worker: INestApplicationContext;
	let queue: Queue;
	let events: QueueEvents;
	const config = parseConfig(process.env);

	beforeAll(async () => {
		worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: false });
		await worker.init();
		queue = new Queue(LEASES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
		events = new QueueEvents(LEASES_QUEUE, { connection: bullConnection(config.REDIS_URL), prefix: 'ziga' });
		await events.waitUntilReady();
	});
	afterAll(async () => {
		await queue.obliterate({ force: true });
		await Promise.all([queue.close(), events.close()]);
		await worker.close();
	});

	async function run(day: string) {
		const job = await queue.add(LEASES_DAILY_JOB, { today: day });
		return (await job.waitUntilFinished(events, 20_000)) as { activated: number; statuses: number; generated: number };
	}

	it('bail signé qui commence : en vigueur ; échéance due à sa date, en retard le lendemain ; rejouée, rien de plus', async () => {
		const p = await place(manager);
		const l = await lease(manager, p.unit.id, (await tenant(manager)).id);
		const firstDue = l.rentDues[0]!;
		expect(firstDue).toMatchObject({ periodStart: nextMonth, dueOn: monthDay(ty, tm, 1, 5), status: 'upcoming' });
		await run(addDays(firstDue.dueOn, -1));
		let detail = await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`);
		expect(detail.status).toBe('active');
		expect(detail.rentDues[0]!.status).toBe('upcoming');
		await run(firstDue.dueOn);
		detail = await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`);
		expect(detail.rentDues[0]!.status).toBe('due');
		await run(addDays(firstDue.dueOn, 1));
		detail = await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`);
		expect(detail.rentDues[0]!.status).toBe('overdue');
		expect(detail.rentDues[1]!.status).toBe('upcoming');
		const trail = (await audit(a.id, firstDue.id)).map((e) => [e.action, e.origin, e.after?.status]);
		expect(trail).toEqual([
			['rent_due.status', 'job', 'due'],
			['rent_due.status', 'job', 'overdue']
		]);
		expect((await audit(a.id, l.id)).find((e) => e.action === 'lease.activate')).toMatchObject({ origin: 'job' });
		const again = await run(addDays(firstDue.dueOn, 1));
		expect((await audit(a.id, firstDue.id)).length).toBe(2);
		expect(again.activated).toBe(0);
	});

	it('bail sans fin : échéances prolongées sur 12 mois glissants, sans doublon', async () => {
		const p = await place(manager);
		const l = await lease(manager, p.unit.id, (await tenant(manager)).id, { startsOn: today });
		const before = l.rentDues.length;
		const later = addMonths(today, 3);
		await run(later);
		await run(later);
		const detail = await call<LeaseDetailView>(manager, 'GET', `/leases/${l.id}`);
		expect(detail.rentDues.length).toBe(before + 3);
		expect(new Set(detail.rentDues.map((d) => d.periodStart)).size).toBe(detail.rentDues.length);
		expect(detail.rentDues.at(-1)!.periodStart <= addDays(addMonths(later, 12), -1)).toBe(true);
	});
});
