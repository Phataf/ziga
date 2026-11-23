import { describe, expect, it } from 'vitest';
import { planImport, type ImportContext } from './import-plan.js';
import {
	fileSheetPreview,
	singleSheetImport,
	singleSheetMissing,
	singleSheetTargets,
	suggestSingleSheetMapping,
	type SingleSheetMapping
} from './import-single-sheet.js';
import type { CellValue } from './import-values.js';

const OUAGA = 'commune-ouaga';
const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({
	organizationType: 'agency',
	switchOn: '2026-11-01',
	today: '2026-11-22',
	billingMode: 'calendar_prorata',
	existing: {
		owners: [],
		tenants: [],
		communes: [{ id: OUAGA, name: 'Ouagadougou' }],
		neighborhoods: [
			{ id: 'nb-tampouy', communeId: OUAGA, name: 'Tampouy' },
			{ id: 'nb-dassasgho', communeId: OUAGA, name: 'Dassasgho' }
		]
	},
	...over
});

/** Registre tenu sur une seule feuille : une ligne par logement, le propriétaire et le bien répétés. */
const HEADERS = [
	'N°',
	'Propriétaire',
	'Tél propriétaire',
	'Maison',
	'Quartier',
	'Logement',
	'Loyer',
	'Locataire',
	'Contact',
	'Entrée',
	'Caution',
	'Arriérés'
];
const ROWS: CellValue[][] = [
	[
		1,
		'Ouédraogo Mariam',
		'70 11 22 33',
		'Cour Tampouy',
		'Tampouy',
		'Chambre 1',
		'35 000',
		'Kaboré Awa',
		'76 00 00 01',
		'01/03/2022',
		'70 000',
		''
	],
	[
		2,
		'Ouédraogo Mariam',
		'70 11 22 33',
		'Cour Tampouy',
		'Tampouy',
		'Chambre 2',
		'35 000',
		'Zongo Paul',
		'76 00 00 02',
		'01/06/2023',
		'70 000',
		'35 000'
	],
	[3, 'OUEDRAOGO Mariam', '70112233', 'Cour Tampouy', 'Tampouy', 'Chambre 3', '35 000', '', '', '', '', ''],
	[
		4,
		'SCI Wend Panga',
		'25 30 40 50',
		'Villa Dassasgho',
		'Dassasgho',
		'Villa',
		'150 000',
		'Traoré Issouf',
		'76 00 00 03',
		'15/01/2021',
		'300 000',
		''
	],
	[
		5,
		'SCI Wend Panga',
		'25 30 40 50',
		'Villa Dassasgho',
		'Dassasgho',
		'Annexe',
		'50 000',
		'Kaboré Awa',
		'76 00 00 01',
		'01/09/2024',
		'',
		''
	],
	[6, 'Ouédraogo Mariam', '70 11 22 33', 'Cour Tampouy', 'Tampouy', 'Chambre 4', '35 000', 'Sawadogo Ali', '12345', '01/01/2024', '', '']
];
const SHEET = { sheet: 'Feuil1', data: [HEADERS, ...ROWS] };

const MAPPING: SingleSheetMapping = {
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

describe('fichier libre sur une seule feuille : champs proposés', () => {
	it('les références entre onglets ne sont jamais demandées : elles se déduisent des lignes', () => {
		const ids = singleSheetTargets('agency').map((t) => t.id);
		for (const generated of [
			'owners.ref',
			'properties.ref',
			'properties.ownerRef',
			'units.ref',
			'units.propertyRef',
			'tenants.ref',
			'leases.ref',
			'leases.unitRef',
			'leases.tenant',
			'deposits.lease',
			'opening_balances.lease'
		])
			expect(ids).not.toContain(generated);
		expect(ids).toEqual(
			expect.arrayContaining(['owners.name', 'properties.name', 'units.label', 'tenants.fullName', 'leases.rent', 'deposits.agreedAmount'])
		);
		// Bailleur particulier : ni propriétaire ni mandat.
		const landlord = singleSheetTargets('landlord').map((t) => t.id);
		expect(landlord.some((id) => id.startsWith('owners.') || id.startsWith('properties.mandate'))).toBe(false);
	});

	it('valeur commune possible pour les listes, les dates du mandat et la commission ; jamais pour ce qui change à chaque ligne', () => {
		const byId = new Map(singleSheetTargets('agency').map((t) => [t.id, t]));
		for (const id of [
			'owners.type',
			'properties.type',
			'properties.mandateType',
			'properties.mandateStartsOn',
			'properties.commissionRate',
			'properties.commune',
			'units.type'
		])
			expect(byId.get(id)?.constantAllowed, id).toBe(true);
		for (const id of ['units.label', 'tenants.fullName', 'tenants.phone', 'leases.startsOn', 'leases.rent', 'deposits.agreedAmount'])
			expect(byId.get(id)?.constantAllowed, id).toBe(false);
	});

	it('suggestion d’après les en-têtes : sans ambiguïté seulement ; « Loyer » vaut pour l’unité et pour le bail', () => {
		const s = suggestSingleSheetMapping(HEADERS, 'agency');
		expect(s).toMatchObject({
			'owners.name': 1,
			'properties.neighborhood': 4,
			'units.label': 5,
			'units.rent': 6,
			'leases.rent': 6,
			'tenants.fullName': 7,
			'leases.startsOn': 9,
			'deposits.agreedAmount': 10,
			'opening_balances.amount': 11
		});
		// « Contact » pourrait être le téléphone du propriétaire ou celui du locataire : la personne choisit.
		expect(s['tenants.phone']).toBeUndefined();
		expect(s['owners.phone']).toBeUndefined();
	});

	it('champs obligatoires manquants, selon les groupes utilisés', () => {
		expect(singleSheetMissing(MAPPING, 'agency')).toEqual([]);
		const without = { ...MAPPING, constants: { ...MAPPING.constants, 'properties.type': '' } };
		expect(singleSheetMissing(without, 'agency').map((t) => t.id)).toEqual(['properties.type']);
		// Sans colonne de locataire, ni locataires ni baux : leurs champs ne sont pas exigés.
		const unitsOnly: SingleSheetMapping = {
			...MAPPING,
			columns: Object.fromEntries(Object.entries(MAPPING.columns).filter(([k]) => !/^(tenants|leases|deposits|opening_balances)\./.test(k)))
		};
		expect(singleSheetMissing(unitsOnly, 'agency')).toEqual([]);
	});

	it('aperçu des colonnes du fichier : en-têtes, trois lignes d’exemple, textes courts', () => {
		const p = fileSheetPreview(SHEET, 'agency');
		expect(p).toMatchObject({ name: 'Feuil1', rows: 6, headers: HEADERS });
		expect(p.samples).toHaveLength(3);
		expect(p.samples[0]![7]).toBe('Kaboré Awa');
		expect(p.suggested['tenants.fullName']).toBe(7);
	});
});

describe('fichier libre sur une seule feuille : répartition dans les sept groupes', () => {
	it('une fiche par propriétaire, bien, locataire ; une unité par ligne ; les numéros de ligne du fichier gardés', () => {
		const { sheets } = singleSheetImport(SHEET, MAPPING, 'agency');
		const lines = (key: keyof typeof sheets) =>
			sheets[key]!.rows.flatMap((r, i) => (i > 0 && r.some((c) => c !== null && c !== '') ? [i + 1] : []));
		expect(lines('owners')).toEqual([2, 5]);
		expect(lines('properties')).toEqual([2, 5]);
		expect(lines('units')).toEqual([2, 3, 4, 5, 6, 7]);
		expect(lines('tenants')).toEqual([2, 3, 5, 7]);
		expect(lines('leases')).toEqual([2, 3, 5, 6, 7]);
		expect(lines('deposits')).toEqual([2, 3, 5]);
		expect(lines('opening_balances')).toEqual([3]);
	});

	it('le plan importe le registre ; chaque message cite la feuille et la colonne du fichier', () => {
		const { sheets, relabel } = singleSheetImport(SHEET, MAPPING, 'agency');
		const plan = planImport(sheets, ctx());
		expect(plan.owners).toHaveLength(2);
		expect(plan.properties).toHaveLength(2);
		expect(plan.units).toHaveLength(6);
		expect(plan.tenants).toHaveLength(3);
		// Ligne 7 : téléphone du locataire faux, le bail est écarté avec lui.
		expect(plan.leases).toHaveLength(4);
		expect(plan.openingBalances).toHaveLength(1);
		const issues = relabel(plan.issues);
		const phone = issues.find((i) => i.severity === 'error' && i.row === 7)!;
		expect(phone.message).toMatch(/^Ligne 7 de Feuil1, colonne Contact : /);
		expect(phone.column).toBe('Contact');
		const cascade = issues.find((i) => i.severity === 'skipped' && i.sheet === 'leases' && i.row === 7)!;
		expect(cascade.message).toMatch(/^Ligne 7 de Feuil1\b/);
		expect(cascade.message).not.toMatch(/Locataires, ligne/);
		// Une valeur commune est nommée comme telle.
		const bad = singleSheetImport(
			SHEET,
			{ ...MAPPING, constants: { ...MAPPING.constants, 'properties.mandateStartsOn': 'bientôt' } },
			'agency'
		);
		const dated = bad.relabel(planImport(bad.sheets, ctx()).issues).find((i) => i.field === 'mandateStartsOn')!;
		expect(dated.message).toMatch(/^Ligne 2 de Feuil1, valeur commune « Début du mandat » : /);
	});

	it('bailleur particulier : biens, unités, locataires et baux sans propriétaire ni mandat', () => {
		const landlord: SingleSheetMapping = {
			sheet: 'Feuil1',
			columns: Object.fromEntries(Object.entries(MAPPING.columns).filter(([k]) => !k.startsWith('owners.'))),
			constants: { 'properties.type': 'Cour commune', 'properties.commune': 'Ouagadougou', 'units.type': 'Chambre-salon' }
		};
		expect(singleSheetMissing(landlord, 'landlord')).toEqual([]);
		const { sheets } = singleSheetImport(SHEET, landlord, 'landlord');
		expect(sheets.owners).toBeUndefined();
		const plan = planImport(sheets, ctx({ organizationType: 'landlord' }));
		expect(plan.properties).toHaveLength(2);
		expect(plan.leases).toHaveLength(4);
	});
});
