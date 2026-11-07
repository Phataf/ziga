/**
 * Données fictives de la démo « Immo Démo ».
 *
 * Les échéances et paiements sont générés à partir de la date du jour, pour que
 * la démo reste juste pendant toutes les semaines d'entretiens : trois mois
 * d'échéances (M-2, M-1, mois en cours), des impayés, un paiement partiel et
 * deux échéances qui tombent aujourd'hui.
 */
import { isoDate } from './format';
import { allocateOldestFirst, dueStates } from './rules';
import type {
	Agency,
	Dataset,
	Expense,
	Lease,
	Mandate,
	Owner,
	Payment,
	PaymentMethod,
	Property,
	RentDue,
	Tenant,
	Unit
} from './types';

export const agency: Agency = {
	id: 'agency-demo',
	name: 'Immo Démo',
	phone: '+22670123456',
	address: 'Avenue Kwame Nkrumah, Ouagadougou'
};

export const owners: Owner[] = [
	{ id: 'o1', civility: 'M.', name: 'Issouf Sawadogo', phone: '+22670451203', residence: 'Ouagadougou' },
	{ id: 'o2', civility: 'Mme', name: 'Aminata Ouédraogo', phone: '+22676239814', residence: 'Lyon (diaspora)' },
	{ id: 'o3', civility: 'M.', name: 'Paul Kaboré', phone: '+22678110542', residence: 'Ouagadougou' },
	{ id: 'o4', civility: 'Mme', name: 'Mariam Traoré', phone: '+22665902317', residence: 'Abidjan (diaspora)' },
	{ id: 'o5', civility: 'M.', name: 'Boukary Compaoré', phone: '+22671384056', residence: 'Saaba' },
	{ id: 'o6', civility: 'Mme', name: 'Clémence Zongo', phone: '+22670998412', residence: 'Ouagadougou' }
];

export const properties: Property[] = [
	{ id: 'p1', ownerId: 'o1', mandateId: 'm1', name: 'Villa Ouaga 2000', kind: 'Villa', city: 'Ouagadougou', district: 'Ouaga 2000', address: 'Secteur 15, rue 15.32' },
	{ id: 'p2', ownerId: 'o1', mandateId: 'm1', name: 'Résidence Tampouy', kind: 'Immeuble', city: 'Ouagadougou', district: 'Tampouy', address: 'Secteur 21, près du marché' },
	{ id: 'p3', ownerId: 'o2', mandateId: 'm2', name: 'Cour Pissy', kind: 'Cour commune', city: 'Ouagadougou', district: 'Pissy', address: 'Secteur 17, derrière l’école' },
	{ id: 'p4', ownerId: 'o2', mandateId: 'm2', name: 'Immeuble Patte d’Oie', kind: 'Immeuble', city: 'Ouagadougou', district: 'Patte d’Oie', address: 'Secteur 15, boulevard des Tansoba' },
	{ id: 'p5', ownerId: 'o3', mandateId: 'm3', name: 'Villa Dassasgho', kind: 'Villa', city: 'Ouagadougou', district: 'Dassasgho', address: 'Secteur 28, rue 28.115' },
	{ id: 'p6', ownerId: 'o3', mandateId: 'm3', name: 'Résidence Saaba centre', kind: 'Immeuble', city: 'Saaba', district: 'Saaba centre', address: 'Près de la mairie' },
	{ id: 'p7', ownerId: 'o4', mandateId: 'm4', name: 'Boutique Gounghin', kind: 'Local commercial', city: 'Ouagadougou', district: 'Gounghin', address: 'Avenue de la Liberté' },
	{ id: 'p8', ownerId: 'o4', mandateId: 'm4', name: 'Villa Ouaga 2000 Sud', kind: 'Villa', city: 'Ouagadougou', district: 'Ouaga 2000', address: 'Secteur 54, rue 54.20' },
	{ id: 'p9', ownerId: 'o5', mandateId: 'm5', name: 'Cour Wemtenga', kind: 'Cour commune', city: 'Ouagadougou', district: 'Wemtenga', address: 'Secteur 29, rue 29.40' },
	{ id: 'p10', ownerId: 'o5', mandateId: 'm5', name: 'Mini-villa Saaba', kind: 'Villa', city: 'Saaba', district: 'Saaba — Kouanda', address: 'Route de Koupéla' },
	{ id: 'p11', ownerId: 'o6', mandateId: 'm6', name: 'Immeuble Zogona', kind: 'Immeuble', city: 'Ouagadougou', district: 'Zogona', address: 'Secteur 13, près de l’université' },
	{ id: 'p12', ownerId: 'o6', mandateId: 'm6', name: 'Villa Somgandé', kind: 'Villa', city: 'Ouagadougou', district: 'Somgandé', address: 'Secteur 23, rue 23.18' }
];

type UnitSeed = Omit<Unit, 'visibility' | 'charges' | 'features' | 'description'> &
	Partial<Pick<Unit, 'visibility' | 'charges' | 'features' | 'description'>>;

const unitSeeds: UnitSeed[] = [
	{ id: 'u1', propertyId: 'p1', label: 'Villa', kind: 'Villa', rooms: 4, surface: 220, rent: 350000, status: 'rented', photos: 8 },
	{ id: 'u2', propertyId: 'p2', label: 'App. A1', kind: 'Appartement', rooms: 2, surface: 55, rent: 85000, status: 'rented', photos: 5 },
	{ id: 'u3', propertyId: 'p2', label: 'App. A2', kind: 'Appartement', rooms: 2, surface: 55, rent: 85000, status: 'rented', photos: 5 },
	{
		id: 'u4', propertyId: 'p2', label: 'App. B1', kind: 'Appartement', rooms: 3, surface: 80, rent: 110000, status: 'free', photos: 6,
		visibility: 'published',
		features: ['2 chambres', 'Salon', 'Cuisine', 'Douche interne', 'Compteur SONABEL individuel', 'Parking moto'],
		description: 'Appartement lumineux au 1er étage, carrelé, dans une résidence calme et gardée, à deux pas du marché de Tampouy.'
	},
	{ id: 'u5', propertyId: 'p3', label: 'Chambre-salon 1', kind: 'Chambre-salon', rooms: 2, surface: 30, rent: 40000, status: 'rented', photos: 3 },
	{ id: 'u6', propertyId: 'p3', label: 'Chambre-salon 2', kind: 'Chambre-salon', rooms: 2, surface: 30, rent: 40000, status: 'rented', photos: 3 },
	{
		id: 'u7', propertyId: 'p3', label: 'Chambre-salon 3', kind: 'Chambre-salon', rooms: 2, surface: 32, rent: 40000, status: 'free', photos: 4,
		features: ['1 chambre', 'Salon', 'Douche interne', 'Cour commune', 'Compteur ONEA partagé'],
		description: 'Chambre-salon propre dans une cour calme de Pissy, proche du goudron et des commerces.'
	},
	{ id: 'u8', propertyId: 'p4', label: 'App. 1', kind: 'Appartement', rooms: 3, surface: 90, rent: 150000, status: 'rented', photos: 6 },
	{ id: 'u9', propertyId: 'p4', label: 'App. 2', kind: 'Appartement', rooms: 3, surface: 90, rent: 150000, status: 'rented', photos: 6 },
	{ id: 'u10', propertyId: 'p5', label: 'Villa', kind: 'Villa', rooms: 3, surface: 140, rent: 175000, charges: 5000, status: 'rented', photos: 7 },
	{ id: 'u11', propertyId: 'p6', label: 'Studio 1', kind: 'Studio', rooms: 1, surface: 25, rent: 35000, status: 'rented', photos: 3 },
	{
		id: 'u12', propertyId: 'p6', label: 'Studio 2', kind: 'Studio', rooms: 1, surface: 25, rent: 35000, status: 'reserved', photos: 3,
		features: ['Pièce unique', 'Douche interne', 'Coin cuisine'],
		description: 'Studio neuf à Saaba centre.'
	},
	{ id: 'u13', propertyId: 'p7', label: 'Boutique', kind: 'Boutique', rooms: 1, surface: 20, rent: 60000, status: 'rented', photos: 3 },
	{ id: 'u14', propertyId: 'p8', label: 'Villa', kind: 'Villa', rooms: 5, surface: 300, rent: 450000, status: 'rented', photos: 10 },
	{ id: 'u15', propertyId: 'p9', label: 'Chambre-salon A', kind: 'Chambre-salon', rooms: 2, surface: 30, rent: 45000, status: 'rented', photos: 3 },
	{ id: 'u16', propertyId: 'p9', label: 'Chambre-salon B', kind: 'Chambre-salon', rooms: 2, surface: 30, rent: 45000, status: 'rented', photos: 3 },
	{ id: 'u17', propertyId: 'p10', label: 'Mini-villa', kind: 'Villa', rooms: 2, surface: 70, rent: 70000, status: 'rented', photos: 4 },
	{ id: 'u18', propertyId: 'p11', label: 'App. 1', kind: 'Appartement', rooms: 2, surface: 60, rent: 95000, status: 'rented', photos: 5 },
	{
		id: 'u19', propertyId: 'p11', label: 'App. 2', kind: 'Appartement', rooms: 2, surface: 60, rent: 95000, status: 'free', photos: 5,
		features: ['1 chambre', 'Salon', 'Cuisine', 'Balcon'],
		description: 'Appartement au 2e étage, proche de l’université Joseph Ki-Zerbo.'
	},
	{
		id: 'u20', propertyId: 'p12', label: 'Villa', kind: 'Villa', rooms: 4, surface: 200, rent: 200000, status: 'reserved', photos: 6,
		features: ['3 chambres', 'Salon', 'Garage', 'Jardin'],
		description: 'Villa familiale avec garage et jardin.'
	}
];

export const units: Unit[] = unitSeeds.map((u) => ({
	charges: 0,
	visibility: 'internal',
	features: [],
	description: '',
	...u
}));

export const tenants: Tenant[] = [
	{ id: 't1', civility: 'M.', name: 'Jean-Baptiste Ilboudo', phone: '+22670214455' },
	{ id: 't2', civility: 'Mme', name: 'Fatimata Sana', phone: '+22676884120' },
	{ id: 't3', civility: 'M.', name: 'Adama Ouattara', phone: '+22672105533' },
	{ id: 't4', civility: 'Mme', name: 'Rasmata Kaboré', phone: '+22675330917' },
	{ id: 't5', civility: 'M.', name: 'Seydou Bamogo', phone: '+22670667281' },
	{ id: 't6', civility: 'M.', name: 'Hamidou Zoungrana', phone: '+22678449902' },
	{ id: 't7', civility: 'Mme', name: 'Awa Diallo', phone: '+22665127734' },
	{ id: 't8', civility: 'M.', name: 'Ousmane Nikiéma', phone: '+22670553108' },
	{ id: 't9', civility: 'M.', name: 'Rodrigue Yaméogo', phone: '+22676012249' },
	{ id: 't10', civility: 'Mme', name: 'Salimata Tapsoba', phone: '+22671906653' },
	{ id: 't11', civility: 'M.', name: 'Thierry Somé', phone: '+22670381176' },
	{ id: 't12', civility: 'Mme', name: 'Pauline Kientega', phone: '+22674250981' },
	{ id: 't13', civility: 'M.', name: 'Karim Belem', phone: '+22670772604' },
	{ id: 't14', civility: 'Mme', name: 'Mariétou Sorgho', phone: '+22666318825' },
	{ id: 't15', civility: 'M.', name: 'Abdoulaye Guiro', phone: '+22678905517' }
];

/**
 * Profil de paiement de chaque bail sur les trois mois [M-2, M-1, M] :
 * 1 = payé, 0 = impayé, 0.5 = moitié payée.
 * `dueToday` force l'échéance du mois en cours à tomber aujourd'hui (non payée).
 */
interface LeaseSeed {
	id: string;
	unitId: string;
	tenantId: string;
	startDate: string;
	dueDay: number | 'today';
	pattern: [number, number, number];
	method: PaymentMethod;
}

const leaseSeeds: LeaseSeed[] = [
	{ id: 'l1', unitId: 'u1', tenantId: 't1', startDate: '2024-03-01', dueDay: 5, pattern: [1, 1, 1], method: 'transfer' },
	{ id: 'l2', unitId: 'u2', tenantId: 't2', startDate: '2025-06-01', dueDay: 'today', pattern: [1, 1, 0], method: 'cash' },
	{ id: 'l3', unitId: 'u3', tenantId: 't3', startDate: '2024-11-01', dueDay: 1, pattern: [1, 1, 1], method: 'moov_money' },
	{ id: 'l4', unitId: 'u5', tenantId: 't4', startDate: '2025-02-01', dueDay: 5, pattern: [1, 0.5, 0], method: 'cash' },
	{ id: 'l5', unitId: 'u6', tenantId: 't5', startDate: '2025-09-01', dueDay: 10, pattern: [1, 1, 1], method: 'cash' },
	{ id: 'l6', unitId: 'u8', tenantId: 't6', startDate: '2024-07-01', dueDay: 5, pattern: [1, 0, 0], method: 'cash' },
	{ id: 'l7', unitId: 'u9', tenantId: 't7', startDate: '2025-01-01', dueDay: 1, pattern: [1, 1, 1], method: 'orange_money' },
	{ id: 'l8', unitId: 'u10', tenantId: 't8', startDate: '2023-10-01', dueDay: 'today', pattern: [1, 1, 0], method: 'cash' },
	{ id: 'l9', unitId: 'u11', tenantId: 't9', startDate: '2025-04-01', dueDay: 1, pattern: [0, 0, 0], method: 'cash' },
	{ id: 'l10', unitId: 'u13', tenantId: 't10', startDate: '2024-01-01', dueDay: 5, pattern: [1, 1, 1], method: 'cash' },
	{ id: 'l11', unitId: 'u14', tenantId: 't11', startDate: '2024-09-01', dueDay: 1, pattern: [1, 1, 1], method: 'transfer' },
	{ id: 'l12', unitId: 'u15', tenantId: 't12', startDate: '2025-05-01', dueDay: 1, pattern: [1, 1, 0], method: 'cash' },
	{ id: 'l13', unitId: 'u16', tenantId: 't13', startDate: '2025-08-01', dueDay: 5, pattern: [1, 1, 1], method: 'orange_money' },
	{ id: 'l14', unitId: 'u17', tenantId: 't14', startDate: '2024-12-01', dueDay: 15, pattern: [1, 1, 1], method: 'cash' },
	{ id: 'l15', unitId: 'u18', tenantId: 't15', startDate: '2025-03-01', dueDay: 10, pattern: [1, 1, 1], method: 'cash' }
];

function daysInMonth(year: number, month0: number): number {
	return new Date(year, month0 + 1, 0).getDate();
}

function shiftMonth(today: string, delta: number): { year: number; month0: number; period: string } {
	const d = new Date(+today.slice(0, 4), +today.slice(5, 7) - 1 + delta, 1);
	const year = d.getFullYear();
	const month0 = d.getMonth();
	return { year, month0, period: `${year}-${String(month0 + 1).padStart(2, '0')}` };
}

function dateIn(year: number, month0: number, day: number): string {
	return isoDate(new Date(year, month0, Math.min(day, daysInMonth(year, month0))));
}

function addDays(iso: string, days: number): string {
	const d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + days);
	return isoDate(d);
}

function addYears(iso: string, years: number): string {
	return `${+iso.slice(0, 4) + years}${iso.slice(4)}`;
}

const REFERENCES: Record<PaymentMethod, string> = {
	cash: '',
	transfer: 'VIR-CORIS',
	orange_money: 'PP2611',
	moov_money: 'MM2611'
};

export function receiptNumber(year: string, n: number): string {
	return `R-${year}-${String(n).padStart(5, '0')}`;
}

/** Construit le jeu de données de la démo pour une date donnée (« aaaa-mm-jj »). */
export function buildDataset(today: string): Dataset {
	const todayDay = +today.slice(8, 10);

	const mandates: Mandate[] = owners.map((o, i) => ({
		id: `m${i + 1}`,
		ownerId: o.id,
		type: 'management',
		startDate: addYears(today, -2).slice(0, 8) + '01',
		endDate: addYears(today, 1),
		commissionRate: [10, 8, 10, 8, 10, 10][i],
		canPublish: o.id !== 'o6',
		canPhotograph: true,
		canCollect: true
	}));

	const leases: Lease[] = leaseSeeds.map((s) => {
		const unit = units.find((u) => u.id === s.unitId)!;
		return {
			id: s.id,
			unitId: s.unitId,
			tenantId: s.tenantId,
			startDate: s.startDate,
			rent: unit.rent,
			charges: unit.charges,
			deposit: unit.rent * 2,
			dueDay: s.dueDay === 'today' ? todayDay : s.dueDay
		};
	});

	const months = [-2, -1, 0].map((delta) => shiftMonth(today, delta));
	const dues: RentDue[] = [];
	for (const lease of leases) {
		for (const m of months) {
			dues.push({
				id: `${lease.id}-${m.period}`,
				leaseId: lease.id,
				period: m.period,
				dueDate: dateIn(m.year, m.month0, lease.dueDay),
				amount: lease.rent + lease.charges
			});
		}
	}

	// Paiements historiques, imputés sur l'échéance la plus ancienne.
	const drafts: Omit<Payment, 'receiptNumber'>[] = [];
	leaseSeeds.forEach((seed, li) => {
		const lease = leases[li];
		const leaseDues = dues.filter((d) => d.leaseId === lease.id);
		seed.pattern.forEach((ratio, mi) => {
			if (ratio === 0) return;
			const due = leaseDues[mi];
			if (due.dueDate > today) return; // pas encore échue : pas encore payée
			if (seed.dueDay === 'today' && mi === 2) return; // échéance du jour, en attente
			const amount = ratio === 1 ? due.amount : Math.round((due.amount * ratio) / 5000) * 5000;
			let date = addDays(due.dueDate, (li + mi) % 3);
			if (date > today) date = today;
			const paidSoFar = drafts.filter((p) => p.leaseId === lease.id);
			const states = dueStates(leaseDues, paidSoFar as Payment[]);
			const { allocations } = allocateOldestFirst(amount, states);
			const isMobile = seed.method === 'orange_money' || seed.method === 'moov_money';
			drafts.push({
				id: `pay-${lease.id}-${due.period}`,
				leaseId: lease.id,
				date,
				amount,
				method: seed.method,
				reference: seed.method === 'cash' ? undefined : `${REFERENCES[seed.method]}${String(li + 1).padStart(2, '0')}${mi}.${due.period.slice(5)}`,
				// Le Mobile Money du mois en cours n'est pas encore rapproché.
				status: isMobile && mi === 2 ? 'to_reconcile' : 'validated',
				allocations
			});
		});
	});

	drafts.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
	const year = today.slice(0, 4);
	// Numérotation continue : les reçus d'avant le jeu de données vont jusqu'à 117.
	const payments: Payment[] = drafts.map((p, i) => ({ ...p, receiptNumber: receiptNumber(year, 118 + i) }));

	const prev = months[1];
	const cur = months[2];
	const expenses: Expense[] = [
		{ id: 'e1', propertyId: 'p2', date: dateIn(prev.year, prev.month0, 12), label: 'Réparation plomberie — App. A1', amount: 25000 },
		{ id: 'e2', propertyId: 'p1', date: dateIn(prev.year, prev.month0, 20), label: 'Entretien du jardin', amount: 15000 },
		{ id: 'e3', propertyId: 'p3', date: dateIn(prev.year, prev.month0, 8), label: 'Vidange de la fosse septique', amount: 35000 },
		{ id: 'e4', propertyId: 'p4', date: dateIn(prev.year, prev.month0, 17), label: 'Peinture de la cage d’escalier', amount: 60000 },
		{ id: 'e5', propertyId: 'p8', date: dateIn(prev.year, prev.month0, 22), label: 'Réparation du climatiseur', amount: 45000 },
		{ id: 'e6', propertyId: 'p9', date: dateIn(prev.year, prev.month0, 3), label: 'Remplacement d’une serrure', amount: 12000 },
		{ id: 'e7', propertyId: 'p5', date: dateIn(cur.year, cur.month0, Math.min(2, todayDay)), label: 'Débouchage canalisation', amount: 10000 }
	];

	return {
		today,
		agency,
		owners,
		mandates,
		properties,
		units: units.map((u) => ({ ...u })),
		tenants,
		leases,
		dues,
		payments,
		expenses
	};
}
