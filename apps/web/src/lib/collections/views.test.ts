/** Vues locales du lot 10 : conversions des lignes de l'appareil vers les fonctions pures partagées. */
import { describe, expect, it } from 'vitest';
import {
	groupLink,
	groupMessage,
	jsonArray,
	latestByOwner,
	localArrears,
	localDashboard,
	ownersWithStatement,
	recentMonths,
	reminderFor,
	reminderSettingsOf,
	toExpense,
	toStatement
} from './views';

const due = (id: string, dueOn: string, paid = 0) => ({
	id,
	lease_id: 'l1',
	tenant_id: 't1',
	unit_id: 'u1',
	due_on: dueOn,
	period_start: `${dueOn.slice(0, 8)}01`,
	period_end: `${dueOn.slice(0, 8)}28`,
	amount_due: 80000,
	amount_paid: paid,
	status: 'due',
	is_advance: 0,
	prorated: 0,
	lease_starts_on: '2027-01-01'
});

const rows = (extra: Partial<Parameters<typeof localArrears>[0]> = {}) => ({
	dues: [due('mar', '2027-03-05'), due('apr', '2027-04-05', 30000)],
	claims: [],
	tenants: [{ id: 't1', full_name: 'Awa Ouédraogo', phone: '+22670112233' }],
	awaiting: [],
	reminders: [],
	units: [{ id: 'u1', neighborhood_id: 'n1', owner_id: 'o1', assigned_agent_id: null }],
	settings: null,
	...extra
});

describe('impayés sur l’appareil', () => {
	it('mêmes groupes que l’API, relance sans date d’envoi comptée « à l’instant »', () => {
		const [g] = localArrears(rows(), '2027-04-20');
		expect(g).toMatchObject({ tenantName: 'Awa Ouédraogo', total: 130000, daysLate: 46, suggestion: { level: 3 } });
		const after = localArrears(rows({ reminders: [{ tenant_id: 't1', sent_at: null, channel: 'whatsapp_link' }] }), '2027-04-20');
		expect(after[0]!.suggestion).toBeNull();
	});

	it('message, lien wa.me encodé et relance à enregistrer', () => {
		const [g] = localArrears(rows(), '2027-04-20');
		const text = groupMessage(g!, 1, reminderSettingsOf(null), { name: 'Agence Kanazoé', phone: '+22625300000' });
		expect(text).toContain('130 000 FCFA');
		expect(text).toContain('loyers de mars et avril 2027');
		expect(groupLink(g!, text)).toMatch(/^https:\/\/wa\.me\/22670112233\?text=Bonjour%20Awa/);
		expect(reminderFor(g!, 'r1', 'whatsapp_link', 1)).toMatchObject({
			tenantId: 't1',
			rentDueIds: ['mar', 'apr'],
			expenseIds: [],
			templateLevel: 1
		});
	});

	it('réglages : ceux de l’organisation, sinon les modèles par défaut', () => {
		expect(reminderSettingsOf({ template_1: 'a', template_2: 'b', template_3: 'c', offset_1: 3, offset_2: 9, offset_3: 20 })).toEqual({
			templates: ['a', 'b', 'c'],
			offsets: [3, 9, 20]
		});
		expect(reminderSettingsOf(null).offsets).toEqual([5, 15, 30]);
	});
});

describe('accueil, dépenses, relevés', () => {
	it('tableau de bord', () => {
		const s = localDashboard([due('apr', '2027-04-05', 30000)], [{ amount: 30000, paid_on: '2027-04-02' }], '2027-04-10', 2);
		expect(s).toMatchObject({ expected: 80000, collected: 30000, collectionRate: 37, arrears: 50000, statementsToIssue: 2 });
	});

	it('dépense : effet déduit des trois rôles', () => {
		const e = toExpense({
			id: 'e',
			property_id: 'p',
			spent_on: '2027-04-01',
			category: 'plumbing',
			amount: 1000,
			paid_by: 'organization',
			borne_by: 'owner',
			recovery: 'owner_statement',
			status: 'recorded'
		});
		expect(e).toMatchObject({ effect: 'statement_deduction', status: 'recorded' });
	});

	it('relevés : copie JSON lue, dernière version par propriétaire, mois proposés, propriétaires sous mandat', () => {
		const snapshot = { owner: { displayName: 'Mariam' }, month: '2027-03' };
		const a = toStatement({
			id: 'a',
			owner_id: 'o',
			month: '2027-03',
			version: 1,
			status: 'issued',
			net: 100,
			snapshot: JSON.stringify(snapshot)
		});
		const b = toStatement({
			id: 'b',
			owner_id: 'o',
			month: '2027-03',
			version: 2,
			status: 'draft',
			net: -5,
			snapshot: JSON.stringify(snapshot)
		});
		expect(a.ownerName).toBe('Mariam');
		expect(latestByOwner([a, b], '2027-03').get('o')!.id).toBe('b');
		expect(recentMonths('2027-04-15', 3)).toEqual(['2027-03', '2027-02', '2027-01']);
		expect(
			ownersWithStatement(
				[
					{ owner_id: 'o1', type: 'rental_management', starts_on: '2026-01-01', ends_on: null },
					{ owner_id: 'o2', type: 'self_managed', starts_on: '2026-01-01', ends_on: null },
					{ owner_id: 'o3', type: 'rental_management', starts_on: '2027-04-01', ends_on: null },
					{ owner_id: 'o4', type: 'letting', starts_on: '2026-01-01', ends_on: '2027-02-28' }
				],
				'2027-03'
			)
		).toEqual(['o1']);
		expect(jsonArray('["x","y"]')).toEqual(['x', 'y']);
		expect(jsonArray('pas du JSON')).toEqual([]);
	});
});
