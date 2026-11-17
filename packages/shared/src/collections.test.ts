/** Impayés (lot 10) : groupement, ancienneté, tranches, encaissements en attente, suggestion de relance, filtres. */
import { describe, expect, it } from 'vitest';
import { arrearsBucket, arrearsGroups, canRemind, reminderSuggestion, type ArrearsDueInput } from './collections.js';

const due = (id: string, tenantId: string, dueOn: string, amountPaid = 0, over: Partial<ArrearsDueInput> = {}): ArrearsDueInput => ({
	id,
	leaseId: `lease-${tenantId}`,
	tenantId,
	unitId: `unit-${tenantId}`,
	dueOn,
	periodStart: `${dueOn.slice(0, 8)}01`,
	periodEnd: `${dueOn.slice(0, 8)}28`,
	amountDue: 80_000,
	amountPaid,
	...over
});

const tenants = [
	{ id: 'awa', name: 'Awa Ouédraogo', phone: '+22670112233' },
	{ id: 'issa', name: 'Issa Sawadogo', phone: '+22676554433' },
	{ id: 'sali', name: 'Salimata Kaboré', phone: null }
];

describe('vue des impayés', () => {
	const today = '2027-04-20';
	const dues = [
		due('awa-mar', 'awa', '2027-03-05'),
		due('awa-apr', 'awa', '2027-04-05', 30_000),
		due('awa-may', 'awa', '2027-05-05', 10_000),
		due('issa-apr', 'issa', '2027-04-05'),
		due('issa-mar', 'issa', '2027-03-05', 80_000),
		due('sali-apr', 'sali', '2027-04-18', 0)
	];

	it('retards et paiements partiels exigibles, groupés par locataire, du plus ancien retard au plus récent', () => {
		const groups = arrearsGroups({ today, dues, tenants });
		expect(groups.map((g) => [g.tenantName, g.items.map((i) => i.id), g.total, g.daysLate, g.bucket])).toEqual([
			['Awa Ouédraogo', ['awa-mar', 'awa-apr'], 130_000, 46, 'over_30'],
			['Issa Sawadogo', ['issa-apr'], 80_000, 15, '8_30'],
			['Salimata Kaboré', ['sali-apr'], 80_000, 2, '1_7']
		]);
		// Échéance de mai payée en partie d'avance : pas un impayé.
		expect(groups.flatMap((g) => g.items).some((i) => i.id === 'awa-may')).toBe(false);
	});

	it('tranches de retard', () => {
		expect([0, 1, 7, 8, 30, 31].map(arrearsBucket)).toEqual([null, '1_7', '1_7', '8_30', '8_30', 'over_30']);
	});

	it('une échéance couverte par un encaissement à valider ou à rapprocher n’est ni proposée ni relancée', () => {
		const groups = arrearsGroups({ today, dues, tenants, pendingRentPayments: [{ leaseId: 'lease-issa', amount: 80_000 }] });
		const issa = groups.find((g) => g.tenantId === 'issa')!;
		expect(issa.items[0]).toMatchObject({ id: 'issa-apr', awaitingValidation: true });
		expect(issa).toMatchObject({ remindable: 0, suggestion: null, awaitingValidation: true });
		expect(canRemind(issa)).toBe(false);
		// Un encaissement en attente qui ne couvre que la plus ancienne : la suivante reste relançable.
		const awa = arrearsGroups({ today, dues, tenants, pendingRentPayments: [{ leaseId: 'lease-awa', amount: 80_000 }] }).find(
			(g) => g.tenantId === 'awa'
		)!;
		expect(awa.remindableItems.map((i) => i.id)).toEqual(['awa-apr']);
		expect(awa.remindable).toBe(50_000);
		expect(awa.suggestion).toEqual({ level: 2, thresholdDays: 15 });
	});

	it('dépense réclamée au locataire : une créance de plus, sans copie', () => {
		const groups = arrearsGroups({
			today,
			dues: [],
			tenants,
			claims: [
				{
					expenseId: 'exp1',
					leaseId: 'lease-issa',
					tenantId: 'issa',
					unitId: 'unit-issa',
					date: '2027-04-10',
					category: 'plumbing',
					description: 'Robinet',
					amount: 15_000,
					recovered: 5_000,
					cancelled: false
				},
				{
					expenseId: 'exp2',
					leaseId: 'lease-issa',
					tenantId: 'issa',
					unitId: 'unit-issa',
					date: '2027-04-10',
					category: 'painting',
					description: 'Mur',
					amount: 9_000,
					recovered: 0,
					cancelled: true
				}
			]
		});
		expect(groups[0]!.items).toMatchObject([{ kind: 'expense_claim', id: 'exp1', balance: 10_000, daysLate: 10 }]);
	});

	it('pas de numéro : pas de relance par WhatsApp', () => {
		expect(canRemind(arrearsGroups({ today, dues, tenants }).find((g) => g.tenantId === 'sali')!)).toBe(false);
	});

	it('filtres : quartier, propriétaire, agent, tranche', () => {
		const units = new Map([
			['unit-awa', { neighborhoodId: 'n1', ownerId: 'o1', agentIds: ['ag1'] }],
			['unit-issa', { neighborhoodId: 'n2', ownerId: 'o1', agentIds: [] }],
			['unit-sali', { neighborhoodId: 'n2', ownerId: 'o2', agentIds: ['ag1'] }]
		]);
		const names = (filter: Parameters<typeof arrearsGroups>[0]['filter']) =>
			arrearsGroups({ today, dues, tenants, units, filter }).map((g) => g.tenantId);
		expect(names({ neighborhoodId: 'n2' })).toEqual(['issa', 'sali']);
		expect(names({ ownerId: 'o1' })).toEqual(['awa', 'issa']);
		expect(names({ agentId: 'ag1' })).toEqual(['awa', 'sali']);
		expect(names({ bucket: '8_30' })).toEqual(['issa']);
	});

	it('« Ma tournée » : les échéances du jour en plus', () => {
		const groups = arrearsGroups({ today: '2027-04-05', dues: [due('x', 'issa', '2027-04-05')], tenants, includeDueToday: true });
		expect(groups[0]!.items[0]).toMatchObject({ status: 'due', daysLate: 0 });
	});
});

describe('suggestion de relance', () => {
	it('J+5, J+15, J+30 ; rien si une relance a été faite depuis le dernier seuil franchi', () => {
		expect(reminderSuggestion(4, '2027-04-10', null)).toBeNull();
		expect(reminderSuggestion(5, '2027-04-10', null)).toEqual({ level: 1, thresholdDays: 5 });
		// Seuil de J+5 franchi le 06/04 ; relancé le 07/04 : rien avant J+15.
		expect(reminderSuggestion(9, '2027-04-10', '2027-04-07')).toBeNull();
		expect(reminderSuggestion(15, '2027-04-16', '2027-04-07')).toEqual({ level: 2, thresholdDays: 15 });
		expect(reminderSuggestion(40, '2027-05-11', '2027-04-30')).toEqual({ level: 3, thresholdDays: 30 });
		expect(reminderSuggestion(40, '2027-05-11', '2027-05-01')).toBeNull();
		expect(reminderSuggestion(40, '2027-05-11', '2027-04-30', [3, 10, 45])).toBeNull();
		expect(reminderSuggestion(45, '2027-05-16', '2027-04-30', [3, 10, 45])).toEqual({ level: 3, thresholdDays: 45 });
	});

	it('la dernière relance compte, quel que soit le canal', () => {
		const groups = arrearsGroups({
			today: '2027-04-15',
			dues: [due('d', 'awa', '2027-04-05')],
			tenants,
			reminders: [{ tenantId: 'awa', sentAt: '2027-04-14T10:00:00Z', channel: 'visit' }]
		});
		expect(groups[0]).toMatchObject({ suggestion: null, lastReminder: { channel: 'visit' } });
	});
});
