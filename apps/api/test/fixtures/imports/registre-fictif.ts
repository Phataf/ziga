/**
 * Registre fictif d'une agence (lot 11), demandé par le porteur faute de registre réel : trois propriétaires (une
 * personne, une société, un groupe d'indivisaires), six biens, 53 unités et 50 baux, avec les désordres d'un vrai
 * registre tenu sur Excel :
 * - téléphones écrits de plusieurs façons (espaces, tirets, points, « +226 », « 00226 », « Tél : », cellule nombre) ;
 * - montants avec points, espaces, « F », « FCFA » ou « F CFA », ou en cellule nombre ;
 * - dates en jj/mm/aaaa, en aaaa-mm-jj, en numéro de série Excel ou en cellule date ;
 * - quartiers mal orthographiés (« Tampoui », « Dasasgho », « Pisy », « kalgonde », « Ouaga2000 ») et commune abrégée ;
 * - doublons de locataires (même personne écrite deux fois ; famille au même numéro) ;
 * - lignes incomplètes (unité sans type, locataire sans nom, bail sans date d'entrée), un solde négatif ;
 * - colonnes dans un autre ordre que le modèle, une colonne « Observations » hors modèle.
 *
 * Données déterministes (aucun hasard) : `scripts/generate-import-fixtures.mjs` les écrit en `.xlsx` et en `.csv`,
 * et `registre-fictif.test.ts` vérifie que les fichiers versionnés leur correspondent. Noms et numéros inventés.
 */

export type FixtureCell = string | number | Date | null;

export interface FixtureSheet {
	name: string;
	headers: string[];
	rows: FixtureCell[][];
}

/** Date de cellule (minuit UTC, comme la lit le lecteur). */
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
/** Numéro de série Excel (calendrier 1900) d'une date. */
const serial = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
const pad = (n: number) => String(n).padStart(2, '0');

/** Date écrite de quatre façons, à tour de rôle. */
function writtenDate(i: number, y: number, m: number, d: number): FixtureCell {
	switch (i % 4) {
		case 0:
			return `${pad(d)}/${pad(m)}/${y}`;
		case 1:
			return serial(y, m, d);
		case 2:
			return `${y}-${pad(m)}-${pad(d)}`;
		default:
			return day(y, m, d);
	}
}

/** Montant écrit de cinq façons, à tour de rôle. */
function writtenAmount(i: number, amount: number): FixtureCell {
	const spaced = amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
	switch (i % 5) {
		case 0:
			return amount;
		case 1:
			return spaced.replaceAll(' ', '.');
		case 2:
			return `${spaced} F`;
		case 3:
			return `${amount} FCFA`;
		default:
			return `${spaced} F CFA`;
	}
}

/** Téléphone national (8 chiffres) écrit de six façons, à tour de rôle. */
function writtenPhone(i: number, national: string): FixtureCell {
	const pairs = national.match(/../g)!;
	switch (i % 6) {
		case 0:
			return pairs.join(' ');
		case 1:
			return `+226 ${pairs.join('-')}`;
		case 2:
			return `00226 ${national}`;
		case 3:
			return `226.${pairs.join('.')}`;
		case 4:
			return Number(national);
		default:
			return `Tél : ${pairs.join(' ')}`;
	}
}

// ---------------------------------------------------------------- propriétaires et biens

export const OWNERS: FixtureSheet = {
	name: 'Propriétaires',
	headers: ['Forme', 'Référence', 'Nom ou raison sociale', 'Téléphone', 'E-mail', 'Représentant (nom)', 'Représentant (téléphone)'],
	rows: [
		['Personne', 'P1', 'OUEDRAOGO Mariam', '70 11 22 33', 'mariam.ouedraogo@exemple.test', '', ''],
		['Société', 'P2', 'SCI Wend Panga', '+226 25-30-40-50', '', '', ''],
		['Indivision', 'P3', 'Héritiers Sawadogo', 76001122, '', 'Sawadogo Ali', '0022676001122']
	]
};

export const PROPERTIES: FixtureSheet = {
	name: 'Biens',
	headers: [
		'Référence du bien',
		'Nom du bien',
		'Propriétaire',
		'Type de bien',
		'Commune',
		'Quartier',
		'Type de mandat',
		'Commission (%)',
		'Commission (FCFA)',
		'Base de la commission',
		'Début du mandat',
		'Publication autorisée',
		'Encaissement par l’agence'
	],
	rows: [
		[
			'B-01',
			'Villa Tampouy',
			'P1',
			'Villa ou maison',
			'Ouagadougou',
			'Tampoui',
			'Gestion locative',
			'10 %',
			'',
			'',
			'01/01/2019',
			'Non',
			'Oui'
		],
		[
			'B-02',
			'Cour Dassasgho',
			'OUEDRAOGO Mariam',
			'Cour commune',
			'Ouaga',
			'Dasasgho',
			'Gestion locative',
			'10',
			'',
			'',
			serial(2019, 1, 1),
			'non',
			'oui'
		],
		[
			'B-03',
			'Immeuble Wend Panga',
			'P2',
			'Immeuble d’appartements',
			'Ouagadougou',
			'Ouaga2000',
			'Gestion locative',
			'8 %',
			'',
			'',
			'2020-06-01',
			'Oui',
			'Oui'
		],
		[
			'B-04',
			'Résidence Kalgondé',
			'P2',
			"Immeuble d'appartements",
			'OUAGADOUGOU',
			'kalgonde',
			'gestion locative',
			'8%',
			'',
			'',
			'01/06/2020',
			'Oui',
			'Oui'
		],
		[
			'B-05',
			'Boutiques Zogona',
			'P2',
			'Local commercial',
			'Ouagadougou',
			'Zogona',
			'Gestion locative',
			'',
			'25 000',
			'Montant fixe par mois',
			'01/01/2022',
			'Non',
			'Non'
		],
		['B-06', 'Cour Pissy', 'P3', 'Cour commune', 'Ouagadougou', 'Pisy', 'Gestion locative', '12 %', '', '', '15/03/2021', 'Non', 'Non']
	]
};

// ---------------------------------------------------------------- unités

interface UnitSpec {
	ref: string;
	property: string;
	type: string;
	label: string;
	bedrooms: number;
	rent: number;
}

function unitSpecs(): UnitSpec[] {
	const out: UnitSpec[] = [{ ref: 'B-01-V', property: 'B-01', type: 'Villa', label: 'Villa', bedrooms: 4, rent: 250_000 }];
	for (let i = 1; i <= 8; i++) {
		out.push({ ref: `B-02-${pad(i)}`, property: 'B-02', type: 'Chambre-salon', label: `Chambre ${i}`, bedrooms: 1, rent: 35_000 });
	}
	for (let i = 1; i <= 12; i++) {
		const big = i > 8;
		out.push({
			ref: `B-03-A${i}`,
			property: 'B-03',
			type: big ? 'Duplex' : 'Appartement',
			label: `${big ? 'Duplex' : 'Appartement'} A${i}`,
			bedrooms: big ? 3 : 2,
			rent: big ? 150_000 : 90_000
		});
	}
	for (let i = 1; i <= 16; i++) {
		out.push({ ref: `B-04-${pad(i)}`, property: 'B-04', type: 'Appartement', label: `Appartement ${pad(i)}`, bedrooms: 2, rent: 100_000 });
	}
	for (let i = 1; i <= 6; i++) {
		out.push({ ref: `B-05-B${i}`, property: 'B-05', type: 'Boutique', label: `Boutique ${i}`, bedrooms: 0, rent: 50_000 });
	}
	for (let i = 1; i <= 10; i++) {
		out.push({
			ref: `B-06-${pad(i)}`,
			property: 'B-06',
			type: i % 2 ? 'Entrée-couchée' : 'Chambre-salon',
			label: `Logement ${i}`,
			bedrooms: 1,
			rent: i % 2 ? 20_000 : 30_000
		});
	}
	return out;
}

export const UNIT_SPECS = unitSpecs();

/** Ligne incomplète : unité sans type. */
export const UNIT_WITHOUT_TYPE = 'B-06-10';

export const UNITS: FixtureSheet = {
	name: 'Unités',
	headers: ['Bien', 'Référence de l’unité', 'Libellé', 'Type d’unité', 'Chambres', 'Loyer (FCFA)', 'Observations'],
	rows: UNIT_SPECS.map((u, i) => [
		u.property,
		u.ref,
		u.label,
		u.ref === UNIT_WITHOUT_TYPE ? '' : u.type,
		u.bedrooms,
		writtenAmount(i, u.rent),
		i === 3 ? 'Peinture refaite en 2024' : ''
	])
};

// ---------------------------------------------------------------- locataires et baux

const FIRST_NAMES = ['Issouf', 'Awa', 'Paul', 'Aminata', 'Boukary', 'Fatimata', 'Salif', 'Rasmata', 'Adama', 'Mariétou'];
const LAST_NAMES = ['Kaboré', 'Traoré', 'Zongo', 'Compaoré', 'Ouédraogo', 'Sawadogo', 'Ilboudo', 'Nikiéma', 'Kiemdé', 'Yaméogo'];
const CIVILITY: Record<string, string> = {
	Issouf: 'M.',
	Paul: 'M.',
	Boukary: 'M.',
	Salif: 'M.',
	Adama: 'M.',
	Awa: 'Mme',
	Aminata: 'Mme',
	Fatimata: 'Mme',
	Rasmata: 'Mlle',
	Mariétou: 'Mme'
};

/** Unités sans bail (libres). */
export const VACANT_UNITS = ['B-02-08', 'B-04-16', 'B-05-B6'];
/** Bail terminé : ignoré (réponse 5). */
export const ENDED_LEASE_UNIT = 'B-03-A12';
/** Bail signé qui commence après aujourd'hui : réservé (réponse 5). */
export const FUTURE_LEASE_UNIT = 'B-04-15';
/** Bail à durée déterminée échu sans congé : durée indéterminée (réponse 3). */
export const LAPSED_FIXED_TERM_UNIT = 'B-03-A1';
/** Bail sans date d'entrée : ligne incomplète. */
export const LEASE_WITHOUT_START_UNIT = 'B-06-09';
/** Locataire sans nom : ligne incomplète, son bail est écarté en cascade. */
export const TENANT_WITHOUT_NAME_REF = 'L-30';
/** Même personne écrite deux fois (même nom, même numéro autrement écrit). */
export const DUPLICATE_TENANT = { first: 'L-01', second: 'L-48' };
/** Famille au même numéro, noms différents : deux fiches, avec un avertissement (réponse 8). */
export const SHARED_PHONE_TENANTS = ['L-02', 'L-03'];

interface TenantSpec {
	ref: string;
	civility: string;
	fullName: string;
	national: string;
}

const leasedUnits = UNIT_SPECS.filter((u) => !VACANT_UNITS.includes(u.ref));

function tenantSpecs(): TenantSpec[] {
	return leasedUnits.map((_, i) => {
		const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
		const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length]!;
		const ref = `L-${pad(i + 1)}`;
		let fullName = `${last} ${first}`;
		let national = `7${(1_000_000 + i * 7_919).toString().slice(0, 7)}`;
		if (ref === SHARED_PHONE_TENANTS[1]) {
			fullName = 'Kaboré Alima';
			national = '';
		}
		if (ref === DUPLICATE_TENANT.second) {
			fullName = 'KABORE Issouf';
			national = '';
		}
		if (ref === TENANT_WITHOUT_NAME_REF) fullName = '';
		return { ref, civility: CIVILITY[first] ?? '', fullName, national };
	});
}

const TENANT_SPECS = tenantSpecs();
// Numéros partagés : L-03 reprend celui de L-02 ; L-48 reprend celui de L-01, écrit autrement.
TENANT_SPECS[2]!.national = TENANT_SPECS[1]!.national;
TENANT_SPECS[47]!.national = TENANT_SPECS[0]!.national;

export const TENANTS: FixtureSheet = {
	name: 'Locataires',
	headers: ['Nom et prénoms', 'Téléphone', 'Civilité', 'Référence du locataire', 'Profession'],
	rows: TENANT_SPECS.map((t, i) => [t.fullName, writtenPhone(i, t.national), t.civility, t.ref, i % 3 ? 'Commerçant' : 'Fonctionnaire'])
};

/** Le bail de L-05 désigne son locataire par son nom, comme le font beaucoup de registres. */
const LEASE_TENANT_BY_NAME = 'L-05';

export const LEASES: FixtureSheet = {
	name: 'Baux',
	headers: ['Locataire', 'Unité', 'Loyer', "Date d'entree", 'Date de fin', 'Date de sortie', 'Charges', 'Avance (mois)', 'Observations'],
	rows: leasedUnits.map((u, i) => {
		const tenant = TENANT_SPECS[i]!;
		const year = 2019 + (i % 7);
		const month = 1 + (i % 12);
		let start: FixtureCell = writtenDate(i, year, month, 1);
		let end: FixtureCell = '';
		let exit: FixtureCell = '';
		if (u.ref === FUTURE_LEASE_UNIT) start = '01/12/2026';
		if (u.ref === LAPSED_FIXED_TERM_UNIT) {
			start = '01/03/2021';
			end = '28/02/2024';
		}
		if (u.ref === ENDED_LEASE_UNIT) {
			start = '01/02/2020';
			exit = '31/08/2025';
		}
		if (u.ref === LEASE_WITHOUT_START_UNIT) start = '';
		const tenantCell = tenant.ref === LEASE_TENANT_BY_NAME ? tenant.fullName : tenant.ref;
		return [
			tenantCell,
			u.ref,
			writtenAmount(i + 2, u.rent),
			start,
			end,
			exit,
			u.property === 'B-03' ? '5 000' : '',
			i === 4 ? 2 : '',
			i === 10 ? 'Paie souvent en retard' : ''
		];
	})
};

// ---------------------------------------------------------------- cautions et soldes d'ouverture

/** Caution de trois mois : avertissement journalisé (D15). */
export const DEPOSIT_ABOVE_CAP_UNIT = 'B-01-V';
/** Caution versée en partie : complément à recevoir (réponse 6). */
export const PARTIAL_DEPOSIT_UNIT = 'B-02-01';
/** Solde négatif : ligne refusée (réponse 2). */
export const NEGATIVE_BALANCE_UNIT = 'B-04-03';

const withDeposit = leasedUnits.filter((_, i) => i % 5 !== 4);

export const DEPOSITS: FixtureSheet = {
	name: 'Cautions',
	headers: ['Bail ou unité', 'Montant convenu (FCFA)', 'Montant reçu (FCFA)', 'Date du versement', 'Détenteur', 'Nature'],
	rows: withDeposit.map((u, i) => {
		const agreed = u.ref === DEPOSIT_ABOVE_CAP_UNIT ? 3 * u.rent : 2 * u.rent;
		const received = u.ref === PARTIAL_DEPOSIT_UNIT ? u.rent : '';
		return [
			u.ref,
			writtenAmount(i, agreed),
			received === '' ? '' : writtenAmount(i, received),
			'',
			u.property === 'B-06' ? 'Propriétaire' : '',
			'Caution'
		];
	})
};

const BALANCES: [string, number][] = [
	['B-01-V', 250_000],
	['B-02-02', 35_000],
	['B-02-05', 70_000],
	['B-03-A3', 90_000],
	['B-03-A7', 0],
	['B-04-01', 100_000],
	[NEGATIVE_BALANCE_UNIT, -15_000],
	['B-04-09', 200_000],
	['B-05-B2', 50_000],
	['B-06-02', 30_000],
	['B-06-04', 60_000]
];

export const OPENING_BALANCES: FixtureSheet = {
	name: 'Soldes d’ouverture',
	headers: ['Bail ou unité', 'Montant dû à la bascule (FCFA)'],
	rows: BALANCES.map(([unit, amount], i) => [unit, amount < 0 ? `-${Math.abs(amount)}` : writtenAmount(i, amount)])
};

/** Onglets du classeur, dans l'ordre du modèle. */
export const REGISTRY_SHEETS: FixtureSheet[] = [OWNERS, PROPERTIES, UNITS, TENANTS, LEASES, DEPOSITS, OPENING_BALANCES];

/** Date de bascule et jour de l'essai : figés, pour que les attentes ne bougent pas avec le calendrier. */
export const REGISTRY_SWITCH_ON = '2026-11-01';
export const REGISTRY_TODAY = '2026-11-22';
