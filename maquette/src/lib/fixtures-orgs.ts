/**
 * Données de démonstration du lot 00 ter : une deuxième agence et un bailleur particulier (D12).
 *
 * Chaque organisation a son propre jeu de données, isolé : ses fiches propriétaires et locataires,
 * ses biens, ses baux, ses encaissements, sa numérotation de reçus. Aucune ligne ne pointe vers
 * une autre organisation (CLAUDE.md règles 1 et 15).
 *
 * Deux personnes existent dans plusieurs organisations, chacune avec une fiche distincte :
 * - Issouf Sawadogo : propriétaire chez Immo Démo (fiche o1), chez Horizon Immo (h-o1),
 *   et bailleur particulier de son propre immeuble à Larlé (c-o1, gestion directe) ;
 * - Rodrigue Yaméogo : locataire chez Horizon Immo jusqu'au 31/03/2025 (h-t4), puis chez Immo Démo (t9).
 */
import { addDays, buildLedger, dateIn, depositReceipts, receiptNumber, shiftMonth, unitsFrom } from './fixtures';
import { withUnitStatus } from './unit-status';
import type { Agency, Civility, ClosedSettlement, Dataset, DepositMovement, Lease, Mandate, Payment, RentDue } from './types';

// ---------------------------------------------------------------------------
// Horizon Immo : deuxième agence
// ---------------------------------------------------------------------------

export const horizon: Agency = {
	id: 'agency-horizon',
	kind: 'agency',
	name: 'Horizon Immo',
	phone: '+22625364810',
	address: 'Zone du Bois, Ouagadougou'
};

export function buildHorizonDataset(today: string): Dataset {
	const owners = [
		{ id: 'h-o1', civility: 'M.' as Civility, name: 'Issouf Sawadogo', phone: '+22670451203', residence: 'Ouagadougou' },
		{ id: 'h-o2', civility: 'Mme' as Civility, name: 'Bintou Nana', phone: '+22671230987', residence: 'Ouagadougou' }
	];
	const mandates: Mandate[] = [
		{ id: 'hm1', ownerId: 'h-o1', type: 'management', startDate: '2024-12-01', endDate: '2027-11-30', commissionRate: 9, canPublish: true, canPhotograph: true, canCollect: true },
		{ id: 'hm2', ownerId: 'h-o2', type: 'management', startDate: '2022-01-01', endDate: '2027-12-31', commissionRate: 10, canPublish: true, canPhotograph: true, canCollect: true }
	];
	const properties = [
		{ id: 'hp1', ownerId: 'h-o1', mandateId: 'hm1', name: 'Maison Kossodo', kind: 'Villa', city: 'Ouagadougou' as const, district: 'Kossodo', address: 'Secteur 26, rue 26.12' },
		{ id: 'hp2', ownerId: 'h-o2', mandateId: 'hm2', name: 'Cour Dapoya', kind: 'Cour commune', city: 'Ouagadougou' as const, district: 'Dapoya', address: 'Secteur 12, près du marché' }
	];
	const units = unitsFrom([
		{ id: 'hu1', propertyId: 'hp1', label: 'Villa', kind: 'Villa', rooms: 3, surface: 120, rent: 150000, status: 'rented', photos: 6, showers: 2 },
		{ id: 'hu2', propertyId: 'hp2', label: 'Chambre-salon 1', kind: 'Chambre-salon', rooms: 2, surface: 30, rent: 50000, status: 'rented', photos: 3, showers: 1 },
		{ id: 'hu3', propertyId: 'hp2', label: 'Chambre-salon 2', kind: 'Chambre-salon', rooms: 2, surface: 30, rent: 50000, status: 'rented', photos: 3, showers: 1 }
	]);
	const tenants = [
		{ id: 'h-t1', civility: 'M.' as Civility, name: 'Daouda Kinda', phone: '+22670112290' },
		{ id: 'h-t2', civility: 'Mme' as Civility, name: 'Clarisse Bado', phone: '+22676540031' },
		{ id: 'h-t3', civility: 'M.' as Civility, name: 'Boris Tiendrébéogo', phone: '+22665448810' },
		{ id: 'h-t4', civility: 'M.' as Civility, name: 'Rodrigue Yaméogo', phone: '+22676012249' }
	];
	const leases: Lease[] = [
		{ id: 'hl1', unitId: 'hu1', tenantId: 'h-t1', startDate: '2025-01-01', rent: 150000, charges: 0, deposit: 300000, dueDay: 5, term: 'open', depositHolder: 'owner' },
		{ id: 'hl2', unitId: 'hu2', tenantId: 'h-t2', startDate: '2024-06-01', rent: 50000, charges: 0, deposit: 100000, dueDay: 5, term: 'open', depositHolder: 'agency' },
		{ id: 'hl3', unitId: 'hu3', tenantId: 'h-t3', startDate: '2025-05-01', rent: 50000, charges: 0, deposit: 100000, dueDay: 5, term: 'open', depositHolder: 'agency' },
		// Ancien bail de Rodrigue Yaméogo, terminé : l'exemple du porteur, déjà clos.
		{
			id: 'hl0', unitId: 'hu3', tenantId: 'h-t4', startDate: '2023-03-01', endDate: '2025-03-31', rent: 50000, charges: 0, deposit: 100000, dueDay: 5,
			term: 'open', depositHolder: 'agency',
			notice: { givenOn: '2024-12-30', by: 'tenant', reason: 'Déménagement à Saaba', effectiveDate: '2025-03-31' }
		}
	];

	const ledger = buildLedger(
		today,
		leases.filter((l) => !l.endDate),
		[
			{ leaseId: 'hl1', pattern: [1, 1, 1], method: 'transfer' },
			{ leaseId: 'hl2', pattern: [1, 1, 1], method: 'cash' },
			{ leaseId: 'hl3', pattern: [1, 1, 1], method: 'orange_money' }
		],
		412
	);

	// Derniers loyers de l'ancien bail : reçus de 2025, numérotés dans la série d'Horizon Immo.
	const oldDues: RentDue[] = ['2025-01', '2025-02', '2025-03'].map((period) => ({
		id: `hl0-${period}`,
		leaseId: 'hl0',
		period,
		dueDate: `${period}-05`,
		amount: 50000
	}));
	const oldPayments: Payment[] = oldDues.map((d, i) => ({
		id: `pay-hl0-${d.period}`,
		leaseId: 'hl0',
		date: addDays(d.dueDate, 1),
		amount: 50000,
		method: 'orange_money',
		reference: `PP25${d.period.slice(5)}0${i + 1}.0915`,
		status: 'validated',
		receiptNumber: receiptNumber('2025', 61 + i * 9),
		allocations: [{ rentDueId: d.id, period: d.period, amount: 50000 }]
	}));

	const settlements: ClosedSettlement[] = [
		{
			leaseId: 'hl0',
			date: '2025-04-12',
			inspectionDate: '2025-03-31',
			deposit: 100000,
			lines: [
				{ label: 'Douche — pommeau et flexible cassés', amount: 10000, proof: 'Devis du plombier du 02/04/2025' },
				{ label: 'Chambre — porte fendue', amount: 5000, proof: 'Facture du menuisier du 08/04/2025' }
			],
			refund: 85000,
			claim: 0,
			refundMethod: 'Orange Money'
		}
	];
	const movements: DepositMovement[] = [
		...depositReceipts(leases),
		{ id: 'hl0-mvt-1', leaseId: 'hl0', date: '2025-04-12', kind: 'retention', amount: 10000, label: 'Douche — pommeau et flexible cassés', proof: 'Devis du plombier du 02/04/2025', inspectionItemId: 'hl0-edl-douche' },
		{ id: 'hl0-mvt-2', leaseId: 'hl0', date: '2025-04-12', kind: 'retention', amount: 5000, label: 'Chambre — porte fendue', proof: 'Facture du menuisier du 08/04/2025', inspectionItemId: 'hl0-edl-porte' },
		{ id: 'hl0-mvt-3', leaseId: 'hl0', date: '2025-04-12', kind: 'refund', amount: 85000, label: 'Restitution au locataire par Orange Money' }
	];

	const prev = shiftMonth(today, -1);
	return withUnitStatus({
		today,
		agency: horizon,
		owners,
		mandates,
		properties,
		units,
		tenants,
		leases,
		dues: [...oldDues, ...ledger.dues],
		payments: [...oldPayments, ...ledger.payments],
		expenses: [{ id: 'hx1', propertyId: 'hp1', date: dateIn(prev.year, prev.month0, 14), label: 'Réparation du portail', amount: 20000 }],
		depositMovements: movements,
		settlements
	});
}

// ---------------------------------------------------------------------------
// Issouf Sawadogo : bailleur particulier (gestion directe)
// ---------------------------------------------------------------------------

export const landlordOrg: Agency = {
	id: 'landlord-sawadogo',
	kind: 'landlord',
	name: 'Issouf Sawadogo',
	phone: '+22670451203',
	address: 'Larlé, Ouagadougou'
};

export function buildLandlordDataset(today: string): Dataset {
	const prev = shiftMonth(today, -1);
	// Le locataire de C2 a rendu les clés le dernier jour du mois précédent.
	const lastMonthEnd = dateIn(prev.year, prev.month0, 31);
	const leases: Lease[] = [
		{ id: 'cl1', unitId: 'cu1', tenantId: 'c-t1', startDate: '2025-10-01', rent: 75000, charges: 0, deposit: 150000, dueDay: 5, term: 'open', depositHolder: 'owner' },
		{
			id: 'cl0', unitId: 'cu2', tenantId: 'c-t2', startDate: '2024-02-01', endDate: lastMonthEnd, rent: 75000, charges: 0, deposit: 150000, dueDay: 5,
			term: 'open', depositHolder: 'owner'
		}
	];
	const ledger = buildLedger(
		today,
		leases,
		[
			{ leaseId: 'cl1', pattern: [1, 1, 1], method: 'cash' },
			{ leaseId: 'cl0', pattern: [1, 1, 0], method: 'orange_money' }
		],
		37
	);
	return withUnitStatus({
		today,
		agency: landlordOrg,
		owners: [{ id: 'c-o1', civility: 'M.', name: 'Issouf Sawadogo', phone: '+22670451203', residence: 'Ouagadougou' }],
		mandates: [
			{ id: 'cm1', ownerId: 'c-o1', type: 'management', startDate: '2022-01-01', endDate: '2099-12-31', commissionRate: 0, canPublish: true, canPhotograph: true, canCollect: true, selfManaged: true }
		],
		properties: [
			{ id: 'cp1', ownerId: 'c-o1', mandateId: 'cm1', name: 'Résidence Larlé', kind: 'Immeuble', city: 'Ouagadougou', district: 'Larlé', address: 'Secteur 9, rue 9.27, derrière la pharmacie' }
		],
		units: unitsFrom([
			{ id: 'cu1', propertyId: 'cp1', label: 'Appartement C1', kind: 'Appartement', rooms: 2, surface: 60, rent: 75000, status: 'rented', photos: 5, showers: 1 },
			{
				id: 'cu2', propertyId: 'cp1', label: 'Appartement C2', kind: 'Appartement', rooms: 2, surface: 60, rent: 75000, status: 'free', photos: 4, showers: 1,
				technical: 'to_refurbish', technicalReason: 'Peinture du séjour et robinet de la cuisine à reprendre après le départ du locataire',
				features: ['1 chambre', 'Salon', 'Cuisine', 'Douche interne'],
				description: 'Appartement au rez-de-chaussée, dans une rue calme de Larlé.'
			}
		]),
		tenants: [
			{ id: 'c-t1', civility: 'Mme', name: 'Aïcha Sore', phone: '+22670903347' },
			{ id: 'c-t2', civility: 'M.', name: 'Hervé Kambou', phone: '+22676228804' }
		],
		leases,
		dues: ledger.dues,
		payments: ledger.payments,
		expenses: [],
		depositMovements: [
			...depositReceipts(leases),
			{ id: 'cl0-mvt-1', leaseId: 'cl0', date: lastMonthEnd, kind: 'refund', amount: 150000, label: 'Restitution au locataire (rien à retenir)' }
		],
		settlements: [{ leaseId: 'cl0', date: lastMonthEnd, inspectionDate: lastMonthEnd, deposit: 150000, lines: [], refund: 150000, claim: 0, refundMethod: 'Espèces' }]
	});
}

// ---------------------------------------------------------------------------
// Personnes et liens vérifiés (D13)
// ---------------------------------------------------------------------------

export interface Person {
	id: string;
	civility: Civility;
	name: string;
	phone: string;
}

/**
 * Lien entre une personne (compte vérifié par SMS) et une fiche d'une organisation.
 * Il n'est actif qu'après le code SMS envoyé au numéro de la fiche ET l'acceptation par l'organisation.
 */
export interface PersonLink {
	personId: string;
	organizationId: string;
	kind: 'owner' | 'tenant';
	/** Identifiant de la fiche propriétaire ou locataire dans cette organisation. */
	recordId: string;
	verifiedOn?: string;
	acceptedOn?: string;
}

export interface Membership {
	personId: string;
	organizationId: string;
	role: 'landlord' | 'director' | 'manager' | 'field_agent';
}

export const persons: Person[] = [
	{ id: 'person-issouf', civility: 'M.', name: 'Issouf Sawadogo', phone: '+22670451203' },
	{ id: 'person-rodrigue', civility: 'M.', name: 'Rodrigue Yaméogo', phone: '+22676012249' }
];

export const personLinks: PersonLink[] = [
	{ personId: 'person-issouf', organizationId: 'agency-demo', kind: 'owner', recordId: 'o1', verifiedOn: '2026-10-02', acceptedOn: '2026-10-03' },
	{ personId: 'person-issouf', organizationId: 'agency-horizon', kind: 'owner', recordId: 'h-o1', verifiedOn: '2026-10-02', acceptedOn: '2026-10-06' },
	{ personId: 'person-issouf', organizationId: 'landlord-sawadogo', kind: 'owner', recordId: 'c-o1', verifiedOn: '2026-10-02', acceptedOn: '2026-10-02' },
	{ personId: 'person-rodrigue', organizationId: 'agency-demo', kind: 'tenant', recordId: 't9', verifiedOn: '2026-10-15', acceptedOn: '2026-10-16' },
	{ personId: 'person-rodrigue', organizationId: 'agency-horizon', kind: 'tenant', recordId: 'h-t4', verifiedOn: '2026-10-15', acceptedOn: '2026-10-17' }
];

export const memberships: Membership[] = [{ personId: 'person-issouf', organizationId: 'landlord-sawadogo', role: 'landlord' }];

export const OWNER_PERSON_ID = 'person-issouf';
export const TENANT_PERSON_ID = 'person-rodrigue';

/**
 * Valeur de chaque bien, déclarée par le propriétaire dans son espace personnel (jamais vue par les agences).
 * Elle sert seulement au rendement brut affiché au propriétaire.
 */
export const declaredValues: Record<string, number> = {
	'agency-demo/p1': 60000000,
	'agency-demo/p2': 40000000,
	'agency-horizon/hp1': 25000000,
	'landlord-sawadogo/cp1': 22000000
};
