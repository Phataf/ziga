/**
 * Registre libre d'une agence (lot 11, étape 4b) : une seule feuille, une ligne par logement, comme beaucoup d'agences
 * le tiennent. Le propriétaire et le bien se répètent d'une ligne à l'autre (écrits parfois autrement), un locataire
 * occupe deux logements, un logement est libre, un téléphone est faux. Ni références, ni type de bien, ni mandat :
 * la personne fait correspondre les colonnes et donne les valeurs communes (`FREE_MAPPING`).
 *
 * `scripts/generate-import-fixtures.mjs` l'écrit en `registre-libre.xlsx` (tests Playwright).
 */
import type { FixtureSheet } from './registre-fictif.js';

export const FREE_SHEET: FixtureSheet = {
	name: 'Feuil1',
	headers: ['N°', 'Propriétaire', 'Tél propriétaire', 'Maison', 'Quartier', 'Logement', 'Loyer', 'Locataire', 'Contact', 'Entrée', 'Caution', 'Arriérés'],
	rows: [
		[1, 'Ouédraogo Mariam', '70 11 22 33', 'Cour Tampouy', 'Tampouy', 'Chambre 1', '35 000', 'Kaboré Awa', '76 00 00 01', '01/03/2022', '70 000', ''],
		[2, 'Ouédraogo Mariam', '70 11 22 33', 'Cour Tampouy', 'Tampouy', 'Chambre 2', '35 000', 'Zongo Paul', '76 00 00 02', '01/06/2023', '70 000', '35 000'],
		[3, 'OUEDRAOGO Mariam', '70112233', 'Cour Tampouy', 'Tampouy', 'Chambre 3', '35 000', '', '', '', '', ''],
		[4, 'SCI Wend Panga', '25 30 40 50', 'Villa Dassasgho', 'Dassasgho', 'Villa', '150 000', 'Traoré Issouf', '76 00 00 03', '15/01/2021', '300 000', ''],
		[5, 'SCI Wend Panga', '25 30 40 50', 'Villa Dassasgho', 'Dassasgho', 'Annexe', '50 000', 'Kaboré Awa', '76 00 00 01', '01/09/2024', '', ''],
		[6, 'Ouédraogo Mariam', '70 11 22 33', 'Cour Tampouy', 'Tampouy', 'Chambre 4', '35 000', 'Sawadogo Ali', '12345', '01/01/2024', '', ''],
		[7, 'Compaoré Rasmata', '78 55 44 33', 'Cour Pissy', 'Pissy', 'Boutique A', '60 000', 'Ilboudo Salif', '70 20 30 40', '01/02/2020', '120 000', '60 000'],
		[8, 'Compaoré Rasmata', '78 55 44 33', 'Cour Pissy', 'Pissy', 'Boutique B', '60 000', 'Nikiéma Fatimata', '70 20 30 41', '01/05/2025', '120 000', '']
	]
};

/** Correspondance faite par la personne : colonnes du fichier et valeurs communes à toutes les lignes. */
export const FREE_MAPPING = {
	sheet: 'Feuil1',
	columns: {
		'owners.name': 1,
		'owners.phone': 2,
		'properties.name': 3,
		'properties.neighborhood': 4,
		'units.label': 5,
		'units.rent': 6,
		'leases.rent': 6,
		'tenants.fullName': 7,
		'tenants.phone': 8,
		'leases.startsOn': 9,
		'deposits.agreedAmount': 10,
		'opening_balances.amount': 11
	},
	constants: {
		'owners.type': 'Personne',
		'properties.type': 'Cour commune',
		'properties.commune': 'Ouagadougou',
		'properties.mandateType': 'Gestion locative',
		'properties.commissionRate': '10',
		'properties.mandateStartsOn': '2020-01-01',
		'units.type': 'Chambre-salon'
	}
};

/** Ce que donne l'import : 3 propriétaires, 3 biens, 8 unités, 5 locataires (Kaboré Awa une seule fois ; Sawadogo Ali en erreur, son bail écarté), 6 baux, 2 soldes antérieurs. */
export const FREE_EXPECTED = { owners: 3, properties: 3, units: 8, tenants: 5, leases: 6, openingBalances: 2 };
