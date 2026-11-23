import { describe, expect, it } from 'vitest';
import {
	detectImportSheet,
	importSheet,
	importTemplate,
	matchImportColumns,
	workbookImportSheets,
	type ImportSheetKey
} from './import-template.js';

const headersOf = (key: ImportSheetKey, type: 'agency' | 'landlord' = 'agency') => importSheet(key, type).fields.map((f) => f.header);

describe('modèle Excel (prompt §1)', () => {
	it('agence : sept onglets, dans l’ordre d’exécution', () => {
		expect(importTemplate('agency').map((s) => s.name)).toEqual([
			'Propriétaires',
			'Biens',
			'Unités',
			'Locataires',
			'Baux',
			'Cautions',
			'Soldes d’ouverture'
		]);
	});

	it('bailleur particulier : ni onglet Propriétaires, ni mandat, ni bailleur désigné, ni détenteur de caution', () => {
		const sheets = importTemplate('landlord');
		expect(sheets.map((s) => s.key)).toEqual(['properties', 'units', 'tenants', 'leases', 'deposits', 'opening_balances']);
		const properties = sheets.find((s) => s.key === 'properties')!.fields.map((f) => f.key);
		expect(properties).not.toContain('ownerRef');
		expect(properties.some((k) => k.startsWith('mandate') || k.startsWith('commission') || k.startsWith('can'))).toBe(false);
		expect(sheets.find((s) => s.key === 'leases')!.fields.map((f) => f.key)).not.toContain('lessorType');
		expect(sheets.find((s) => s.key === 'deposits')!.fields.map((f) => f.key)).not.toContain('holder');
	});

	it('agence : le mandat va dans l’onglet Biens (règle 12)', () => {
		const keys = importSheet('properties', 'agency').fields.map((f) => f.key);
		expect(keys).toEqual(
			expect.arrayContaining([
				'ownerRef',
				'mandateType',
				'commissionBasis',
				'commissionRate',
				'commissionAmount',
				'mandateStartsOn',
				'mandateEndsOn',
				'canPublish',
				'canTakePhotos',
				'canCollectFunds',
				'canSignLeases'
			])
		);
		const required = importSheet('properties', 'agency')
			.fields.filter((f) => f.required)
			.map((f) => f.key);
		expect(required).toEqual(expect.arrayContaining(['ref', 'ownerRef', 'type', 'name', 'mandateType', 'mandateStartsOn']));
	});

	it('l’occupation d’une unité n’est jamais une colonne (règle 13)', () => {
		for (const type of ['agency', 'landlord'] as const) {
			for (const sheet of importTemplate(type)) {
				for (const f of sheet.fields) expect(`${f.key} ${f.header}`).not.toMatch(/occup|libre|lou[ée]e/i);
			}
		}
	});

	it('les trois formes de propriétaire sont dans la liste', () => {
		const type = importSheet('owners', 'agency').fields.find((f) => f.key === 'type')!;
		expect(type.choices!.map((c) => c.value)).toEqual(['person', 'company', 'group']);
		expect(type.choices!.map((c) => c.label)).toEqual(['Personne', 'Société', 'Groupe d’indivisaires']);
	});

	it('chaque onglet : en-têtes uniques, chaque colonne obligatoire a un exemple, une aide pour la notice', () => {
		for (const type of ['agency', 'landlord'] as const) {
			for (const sheet of importTemplate(type)) {
				const headers = sheet.fields.map((f) => f.header);
				expect(new Set(headers).size, sheet.name).toBe(headers.length);
				expect(sheet.help.length).toBeGreaterThan(10);
				for (const f of sheet.fields.filter((x) => x.required)) expect(f.example, `${sheet.name} : ${f.header}`).toBeDefined();
				for (const f of sheet.fields.filter((x) => x.kind === 'choice')) expect(f.choices?.length, f.header).toBeGreaterThan(0);
			}
		}
	});

	it('la notice des baux dit que la bascule est le 1er d’un mois quand le premier mois est facturé en entier', () => {
		for (const type of ['agency', 'landlord'] as const) {
			expect(importSheet('leases', type).help).toContain('facture le premier mois en entier, c’est toujours le 1er d’un mois');
		}
	});

	it('aucune émoji dans le modèle (CLAUDE.md §6)', () => {
		const text = JSON.stringify([importTemplate('agency'), importTemplate('landlord')]);
		expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
	});
});

describe('reconnaissance des onglets', () => {
	it.each([
		['Propriétaires', 'owners'],
		['proprietaires', 'owners'],
		['BIENS', 'properties'],
		['Unités', 'units'],
		['Locataires', 'tenants'],
		['Baux', 'leases'],
		['Cautions', 'deposits'],
		['Soldes d’ouverture', 'opening_balances'],
		["Soldes d'ouverture", 'opening_balances'],
		['Notice', null],
		['Feuil1', null]
	])('« %s » → %s', (name, key) => {
		expect(detectImportSheet(name)).toBe(key);
	});
});

describe('correspondance automatique des colonnes (prompt §2.2)', () => {
	it('en-têtes du modèle, dans un autre ordre', () => {
		const headers = [...headersOf('tenants')].reverse();
		const m = matchImportColumns(headers, importSheet('tenants', 'agency'));
		expect(m.missing).toEqual([]);
		expect(m.ignored).toEqual([]);
		expect(m.columns.fullName).toBe(headers.indexOf('Nom et prénoms'));
		expect(m.columns.phone).toBe(headers.indexOf('Téléphone'));
	});

	it('sans accents ni casse, avec « * » ou « (FCFA) », et des variantes courantes', () => {
		const m = matchImportColumns(['LOCATAIRE', 'telephone *', 'Tel 2', 'Profession'], importSheet('tenants', 'agency'));
		expect(m.columns).toMatchObject({ fullName: 0, phone: 1, secondaryPhone: 2, profession: 3 });
		const l = matchImportColumns(['Unite', 'Locataire', "Date d'entree", 'Loyer', 'Charges'], importSheet('leases', 'agency'));
		expect(l.columns).toMatchObject({ unitRef: 0, tenant: 1, startsOn: 2, rent: 3, charges: 4 });
		expect(l.missing).toEqual([]);
	});

	it('colonne obligatoire absente : nommée par son en-tête', () => {
		const m = matchImportColumns(['Unité', 'Locataire'], importSheet('leases', 'agency'));
		expect(m.missing).toEqual(['startsOn', 'rent']);
	});

	it('colonne inconnue : ignorée, nommée ; colonne vide sans en-tête : ignorée sans bruit', () => {
		const m = matchImportColumns(['Nom et prénoms', 'Couleur préférée', '', null], importSheet('tenants', 'agency'));
		expect(m.ignored).toEqual([{ index: 1, header: 'Couleur préférée' }]);
	});

	it('deux colonnes pour le même champ : la première est retenue, la seconde signalée', () => {
		const m = matchImportColumns(['Nom', 'Nom et prénoms'], importSheet('tenants', 'agency'));
		expect(m.columns.fullName).toBe(0);
		expect(m.duplicates).toEqual([{ field: 'fullName', index: 1, header: 'Nom et prénoms' }]);
	});
});

describe('classeur lu → onglets à importer', () => {
	it('onglets reconnus par leur nom, colonnes par leurs en-têtes ; la notice et un onglet inconnu sont nommés', () => {
		const { sheets, unknownSheets, columnIssues } = workbookImportSheets(
			[
				{ sheet: 'Notice', data: [['Mode d’emploi']] },
				{
					sheet: 'Locataires',
					data: [
						['Téléphone', 'Nom et prénoms', 'Couleur'],
						['70123456', 'Kaboré Issouf', 'bleu']
					]
				},
				{ sheet: 'Baux', data: [['Unité', 'Locataire']] },
				{ sheet: 'Feuil3', data: [] }
			],
			'agency'
		);
		expect(Object.keys(sheets)).toEqual(['tenants', 'leases']);
		expect(sheets.tenants!.columns).toMatchObject({ phone: 0, fullName: 1 });
		expect(sheets.tenants!.rows).toHaveLength(2);
		expect(unknownSheets).toEqual(['Feuil3']);
		expect(columnIssues).toEqual([
			{
				sheet: 'tenants',
				kind: 'ignored',
				header: 'Couleur',
				message: 'Locataires : la colonne « Couleur » ne correspond à aucun champ ; elle est ignorée.'
			},
			{
				sheet: 'leases',
				kind: 'missing',
				header: 'Date d’entrée',
				message: 'Baux : la colonne obligatoire « Date d’entrée » est absente.'
			},
			{
				sheet: 'leases',
				kind: 'missing',
				header: 'Loyer mensuel (FCFA)',
				message: 'Baux : la colonne obligatoire « Loyer mensuel (FCFA) » est absente.'
			}
		]);
	});

	it('bailleur particulier : un onglet Propriétaires est ignoré et nommé', () => {
		const { sheets, unknownSheets } = workbookImportSheets([{ sheet: 'Propriétaires', data: [['Nom']] }], 'landlord');
		expect(sheets).toEqual({});
		expect(unknownSheets).toEqual(['Propriétaires']);
	});
});
