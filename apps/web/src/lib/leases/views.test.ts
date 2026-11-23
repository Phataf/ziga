import { describe, expect, it } from 'vitest';
import { generateRentSchedule } from '@ziga/shared/rent-schedule';
import {
	leaseTimeline,
	occupancyFromSignals,
	previewSchedule,
	searchTenants,
	toDepositAccount,
	toLease,
	toMovement,
	toRentDue,
	toTenant
} from './views';

const TODAY = '2026-11-15';

const leaseRow = (over: Record<string, unknown> = {}) => ({
	id: 'l1',
	organization_id: 'o1',
	unit_id: 'u1',
	tenant_id: 't1',
	starts_on: '2026-12-01',
	ends_on: null,
	dues_start_on: '2026-12-01',
	rent: 75000,
	charges: 5000,
	periodicity: 'monthly',
	due_day: 5,
	billing_mode: 'calendar_prorata',
	advance_months: 2,
	lessor_type: 'owner',
	status: 'draft',
	version: 1,
	created_at: '2026-11-15T08:00:00Z',
	...over
});

describe('vues locales des baux (lot 08)', () => {
	it('occupation calculée à partir des signaux des baux, jamais lue', () => {
		expect(occupancyFromSignals(null, TODAY)).toBe('free');
		expect(occupancyFromSignals('[]', TODAY)).toBe('free');
		expect(occupancyFromSignals(JSON.stringify([{ status: 'signed', starts_on: '2027-01-01' }]), TODAY)).toBe('reserved');
		expect(occupancyFromSignals(JSON.stringify([{ status: 'active', starts_on: '2026-01-01' }]), TODAY)).toBe('occupied');
		expect(
			occupancyFromSignals(
				JSON.stringify([
					{ status: 'notice', starts_on: '2025-01-01' },
					{ status: 'signed', starts_on: '2027-01-01' }
				]),
				TODAY
			)
		).toBe('notice');
		expect(occupancyFromSignals('illisible', TODAY)).toBe('free');
	});

	it('bail : valeurs de la base locale, alerte « Contrat non signé » selon le scan', () => {
		const draft = toLease(leaseRow());
		expect(draft).toMatchObject({ status: 'draft', rent: 75000, advanceMonths: 2, alerts: [] });
		expect(toLease(leaseRow({ status: 'active' })).alerts).toEqual(['contract_unsigned']);
		expect(toLease(leaseRow({ status: 'active' }), true).alerts).toEqual([]);
	});

	it('lot 11 : bail importé (fin d’origine d’un bail échu passé à durée indéterminée) ; échéance « Solde antérieur »', () => {
		const imported = toLease(leaseRow({ status: 'active', ends_on: null, original_ends_on: '2025-02-28', import_job_id: 'job-1' }));
		expect(imported).toMatchObject({ endsOn: null, originalEndsOn: '2025-02-28', importJobId: 'job-1' });
		expect(toLease(leaseRow())).toMatchObject({ originalEndsOn: null, importJobId: null });
		const due = (kind: string) =>
			toRentDue(
				{
					id: 'd1',
					lease_id: 'l1',
					kind,
					period_start: '2021-03-01',
					period_end: '2026-10-31',
					due_on: '2026-11-01',
					rent: 90000,
					charges: 0,
					amount_due: 90000,
					amount_paid: 0,
					status: 'due',
					prorated: 0,
					is_advance: 0
				},
				TODAY
			);
		expect(due('opening_balance').kind).toBe('opening_balance');
		expect(due('rent').kind).toBe('rent');
	});

	it('aperçu de l’échéancier : la même fonction pure que le serveur', () => {
		const lease = toLease(leaseRow());
		const preview = previewSchedule(lease, TODAY);
		const server = generateRentSchedule({
			billingMode: 'calendar_prorata',
			periodicity: 'monthly',
			startOn: '2026-12-01',
			endOn: null,
			duesStartOn: '2026-12-01',
			dueDay: 5,
			advanceMonths: 2,
			activatedOn: TODAY,
			rates: [{ effectiveFrom: '2026-12-01', rent: 75000, charges: 5000, version: 1 }],
			until: '2027-11-30'
		});
		expect(preview).toEqual(server);
		expect(preview.filter((d) => d.isAdvance).map((d) => d.dueOn)).toEqual([TODAY, TODAY]);
	});

	it('échéance : statut du jour et solde calculés', () => {
		const due = toRentDue({ id: 'd', lease_id: 'l1', due_on: '2026-11-05', amount_due: 80000, amount_paid: 30000, status: 'due' }, TODAY);
		expect(due).toMatchObject({ status: 'overdue', balance: 50000 });
		expect(toRentDue({ id: 'd', due_on: '2026-11-05', amount_due: 80000, amount_paid: 0, status: 'waived' }, TODAY).status).toBe('waived');
	});

	it('avance due à la signature : due jusqu’au début du bail, puis en retard (lot 09, même règle que le serveur)', () => {
		const advance = {
			id: 'd',
			due_on: '2026-11-10',
			period_start: '2026-12-01',
			is_advance: 1,
			prorated: 0,
			amount_due: 80000,
			amount_paid: 0,
			status: 'due'
		};
		expect(toRentDue({ ...advance, lease_starts_on: '2026-12-01' }, TODAY).status).toBe('due');
		expect(toRentDue({ ...advance, lease_starts_on: '2026-12-01' }, '2026-12-01').status).toBe('overdue');
		// Sans la date de début jointe : la règle ordinaire.
		expect(toRentDue(advance, TODAY).status).toBe('overdue');
	});

	it('compte de caution : soldes, plafond, détenteur suivi par le mouvement en attente', () => {
		const movements = [
			toMovement({ id: 'm1', account_id: 'a1', type: 'received', amount: 100000, occurred_on: TODAY }),
			toMovement({ id: 'm2', account_id: 'a1', type: 'holder_changed', amount: 0, new_holder: 'organization', occurred_on: TODAY }),
			toMovement({ id: 'm3', account_id: 'autre', type: 'received', amount: 5, occurred_on: TODAY })
		];
		const account = toDepositAccount(
			{ id: 'a1', lease_id: 'l1', type: 'security_deposit', agreed_amount: 225000, holder: 'owner' },
			movements,
			75000
		);
		expect(account).toMatchObject({ holder: 'organization', aboveLegalCap: true, balances: { received: 100000, remainingDue: 125000 } });
		expect(account.movements).toHaveLength(2);
	});

	it('recherche de locataires sans accents ni espaces dans le numéro', () => {
		const list = [
			toTenant({ id: '1', full_name: 'Awa Ouédraogo', phone: '+22670112233' }),
			toTenant({ id: '2', full_name: 'Issa Kaboré', phone: null })
		];
		expect(searchTenants(list, 'ouedraogo').map((t) => t.id)).toEqual(['1']);
		expect(searchTenants(list, '70 11').map((t) => t.id)).toEqual(['1']);
		expect(searchTenants(list, '')).toHaveLength(2);
	});

	it('chronologie : du plus récent au plus ancien', () => {
		const lease = toLease(leaseRow({ status: 'active', activated_on: '2026-11-20' }));
		const events = leaseTimeline(
			lease,
			[
				{
					version: 1,
					rent: 75000,
					charges: 5000,
					rentEffectiveFrom: '2026-12-01',
					status: 'active',
					changedBy: null,
					recordedAt: '2026-11-20T09:00:00Z'
				},
				{
					version: 2,
					rent: 90000,
					charges: 5000,
					rentEffectiveFrom: '2027-06-01',
					status: 'active',
					changedBy: null,
					recordedAt: '2027-03-01T09:00:00Z'
				}
			],
			[toMovement({ id: 'm1', account_id: 'a1', type: 'received', amount: 100000, occurred_on: '2026-11-21' })],
			[{ fileName: 'bail.pdf', type: 'signed_lease_scan', createdAt: '2026-11-22T10:00:00Z', status: 'active' }]
		);
		expect(events.map((e) => e.kind)).toEqual(['rent_change', 'document', 'deposit', 'validated', 'created']);
	});
});
