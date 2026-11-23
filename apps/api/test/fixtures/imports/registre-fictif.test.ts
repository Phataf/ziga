/**
 * Registre fictif (lot 11) : les fichiers versionnés correspondent aux données de `registre-fictif.ts`, et leur plan
 * d'import donne exactement ce que les désordres du registre annoncent. Ce registre sert aussi aux tests de bout en
 * bout et à l'essai complet du porteur (import, puis premier reçu le jour même).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeImportText, parseCsv } from '@ziga/shared/import-csv';
import { planImport, type ImportContext } from '@ziga/shared/import-plan';
import { workbookImportSheets } from '@ziga/shared/import-template';
import readXlsxFile from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import {
	DUPLICATE_TENANT,
	ENDED_LEASE_UNIT,
	FUTURE_LEASE_UNIT,
	LAPSED_FIXED_TERM_UNIT,
	REGISTRY_SHEETS,
	REGISTRY_SWITCH_ON,
	REGISTRY_TODAY,
	SHARED_PHONE_TENANTS,
	TENANTS,
	type FixtureCell
} from './registre-fictif.js';

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const XLSX = here('registre-fictif.xlsx');
const CSV = here('registre-fictif-locataires.csv');

/** Cellule telle que le lecteur la rend : vide → null. */
const asRead = (v: FixtureCell) => (v === '' ? null : v);

const NEIGHBORHOODS = ['Tampouy', 'Dassasgho', 'Ouaga 2000', 'Kalgondé', 'Zogona', 'Pissy', 'Somgandé', 'Gounghin Nord', 'Gounghin Sud'];

const ctx: ImportContext = {
	organizationType: 'agency',
	switchOn: REGISTRY_SWITCH_ON,
	today: REGISTRY_TODAY,
	billingMode: 'calendar_prorata',
	existing: {
		owners: [],
		tenants: [],
		communes: [
			{ id: 'ouagadougou', name: 'Ouagadougou' },
			{ id: 'saaba', name: 'Saaba' }
		],
		neighborhoods: NEIGHBORHOODS.map((name) => ({ id: `nb:${name}`, communeId: 'ouagadougou', name }))
	}
};

async function readRegistry() {
	return readXlsxFile(readFileSync(XLSX));
}

describe('fichiers du registre fictif', () => {
	it('le classeur versionné correspond aux données (relancer scripts/generate-import-fixtures.mjs sinon)', async () => {
		const workbook = await readRegistry();
		expect(workbook.map((s) => s.sheet)).toEqual(REGISTRY_SHEETS.map((s) => s.name));
		for (const [i, sheet] of REGISTRY_SHEETS.entries()) {
			const data = workbook[i]!.data;
			expect(data[0], sheet.name).toEqual(sheet.headers);
			const expected = sheet.rows.map((r) => r.map(asRead));
			// Le lecteur coupe les cellules vides de fin de ligne : on compare sur la largeur de l'en-tête.
			const read = data.slice(1).map((r) => sheet.headers.map((_, c) => r[c] ?? null));
			expect(read, sheet.name).toEqual(expected);
		}
	});

	it('le CSV des locataires (Windows-1252, point-virgule) correspond aux données', () => {
		const bytes = new Uint8Array(readFileSync(CSV));
		// Écrit comme Excel en français : aucun BOM, accents sur un octet.
		expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
		const rows = parseCsv(decodeImportText(bytes));
		expect(rows[0]).toEqual(TENANTS.headers);
		expect(rows.slice(1)).toEqual(TENANTS.rows.map((r) => r.map((v) => (v === null ? '' : String(v)))));
	});
});

describe('plan d’import du registre fictif', async () => {
	const workbook = await readRegistry();
	const { sheets, unknownSheets } = workbookImportSheets(workbook, 'agency');
	const plan = planImport(sheets, ctx);
	const errors = plan.issues.filter((i) => i.severity === 'error').map((i) => i.message);
	const warnings = plan.issues.filter((i) => i.severity === 'warning').map((i) => i.message);

	it('les sept onglets sont reconnus, malgré l’ordre des colonnes ; la colonne hors modèle est ignorée', () => {
		expect(unknownSheets).toEqual([]);
		expect(Object.keys(sheets)).toEqual(['owners', 'properties', 'units', 'tenants', 'leases', 'deposits', 'opening_balances']);
	});

	it('exactement les quatre lignes incomplètes ou fausses du registre, chacune avec sa ligne, sa colonne et quoi corriger', () => {
		expect(errors).toEqual([
			'Ligne 54 de Unités, colonne Type d’unité : à remplir.',
			'Ligne 31 de Locataires, colonne Nom et prénoms : à remplir.',
			'Ligne 50 de Baux, colonne Date d’entrée : à remplir.',
			'Ligne 8 de Soldes d’ouverture, colonne Montant dû à la bascule (FCFA) : saisissez 0 et notez l’avance sur la fiche du locataire.'
		]);
	});

	it('lignes écartées en cascade et bail terminé ignoré', () => {
		const skipped = plan.issues.filter((i) => i.severity === 'skipped').map((i) => i.message);
		expect(skipped).toEqual([
			'Ligne 21 de Baux ignorée : bail terminé le 31/08/2025 ; l’historique n’est pas importé.',
			'Ligne 31 de Baux écartée : le locataire L-30 est en erreur (Locataires, ligne 31).',
			'Ligne 51 de Baux écartée : l’unité B-06-10 est en erreur (Unités, ligne 54).',
			'Ligne 41 de Cautions écartée : le bail B-06-09 est en erreur (Baux, ligne 50).'
		]);
	});

	it('ce qui sera créé', () => {
		expect(plan.owners).toHaveLength(3);
		expect(plan.mandates.map((m) => [m.ownerRef, m.propertyRefs])).toEqual([
			['P1', ['B-01', 'B-02']],
			['P2', ['B-03', 'B-04']],
			['P2', ['B-05']],
			['P3', ['B-06']]
		]);
		expect(plan.properties).toHaveLength(6);
		expect(plan.units).toHaveLength(52);
		expect(plan.tenants).toHaveLength(48);
		expect(plan.leases).toHaveLength(46);
		expect(plan.deposits).toHaveLength(39);
		expect(plan.openingBalances).toHaveLength(9);
		expect(plan.summary).toMatchObject({ newUnits: 52, leases: 46, leasesWithOpeningBalance: 9, depositsAboveCap: 1 });
	});

	it('téléphones, montants et dates normalisés', () => {
		expect(plan.tenants.every((t) => t.data.phone === null || /^\+226\d{8}$/.test(t.data.phone))).toBe(true);
		expect(plan.owners.map((o) => o.data.phone)).toEqual(['+22670112233', '+22625304050', '+22676001122']);
		expect(plan.leases.every((l) => Number.isSafeInteger(l.terms.rent) && l.terms.rent > 0)).toBe(true);
		expect(plan.leases.every((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.terms.startsOn))).toBe(true);
		expect(plan.units.find((u) => u.ref === 'B-02-01')!.data.rent).toBe(35000);
	});

	it('baux : bascule, réservé, échu passé à durée indéterminée', () => {
		expect(plan.leases.find((l) => l.unitRef === FUTURE_LEASE_UNIT)!.status).toBe('signed');
		expect(plan.leases.filter((l) => l.status === 'active')).toHaveLength(45);
		expect(plan.leases.filter((l) => l.status === 'active').every((l) => l.terms.duesStartOn === REGISTRY_SWITCH_ON)).toBe(true);
		const lapsed = plan.leases.find((l) => l.unitRef === LAPSED_FIXED_TERM_UNIT)!;
		expect(lapsed.terms.endsOn).toBeNull();
		expect(lapsed.originalEndsOn).toBe('2024-02-28');
		expect(plan.leases.some((l) => l.unitRef === ENDED_LEASE_UNIT)).toBe(false);
	});

	it('doublons : la même personne écrite deux fois devient une fiche ; une famille au même numéro garde deux fiches', () => {
		const second = Number(DUPLICATE_TENANT.second.slice(2)) + 1;
		const shared = Number(SHARED_PHONE_TENANTS[1]!.slice(2)) + 1;
		expect(warnings).toContain(`Ligne ${second} de Locataires : même nom et même téléphone que la ligne 2 ; une seule fiche est créée.`);
		expect(warnings).toContain(
			`Ligne ${shared} de Locataires, colonne Téléphone : même téléphone que Kaboré Awa (ligne 3) ; deux fiches sont créées (colocataires, famille).`
		);
	});

	it('quartiers mal orthographiés : suggestions du référentiel, jamais un quartier créé', () => {
		const unresolved = plan.places.filter((p) => p.status === 'unresolved');
		expect(unresolved.map((p) => [p.neighborhood, p.suggestions.map((s) => s.name)])).toEqual([
			['Tampoui', ['Tampouy']],
			['Dasasgho', ['Dassasgho']],
			['Pisy', ['Pissy']]
		]);
		expect(plan.properties.find((p) => p.ref === 'B-03')!.data.neighborhoodId).toBe('nb:Ouaga 2000');
		expect(plan.properties.find((p) => p.ref === 'B-04')!.data.neighborhoodId).toBe('nb:Kalgondé');
		// « Ouaga » : commune reconnue.
		expect(plan.properties.find((p) => p.ref === 'B-02')!.data.communeId).toBe('ouagadougou');
	});
});
