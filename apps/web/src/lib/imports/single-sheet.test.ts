import { describe, expect, it } from 'vitest';
import type { ImportJobView, ImportPreview } from '@ziga/shared/imports';
import { freeFileNeeded, initialSingleMapping, withColumn, withConstant } from './single-sheet';

const preview = (over: Partial<ImportPreview> = {}): ImportPreview =>
	({
		sheets: [],
		unknownSheets: ['Feuil1'],
		fileSheets: [{ name: 'Feuil1', headers: ['Nom', 'Loyer'], samples: [], rows: 3, suggested: { 'tenants.fullName': 0, 'leases.rent': 1 } }],
		columnIssues: [],
		issues: [],
		blockers: [],
		pending: { depositsWithoutReceived: [] },
		places: [],
		matches: [],
		summary: { newUnits: 0, leases: 0, leasesWithOpeningBalance: 0, depositsAboveCap: 0 },
		...over
	}) as ImportPreview;

describe('fichier libre : état de l’écran de correspondance', () => {
	it('proposé quand aucun onglet du modèle n’est reconnu, ou quand une correspondance a déjà été faite', () => {
		expect(freeFileNeeded({ preview: preview(), mapping: {} } as unknown as ImportJobView)).toBe(true);
		const recognized = preview({ sheets: [{ key: 'leases' } as ImportPreview['sheets'][number]], fileSheets: [] });
		expect(freeFileNeeded({ preview: recognized, mapping: {} } as unknown as ImportJobView)).toBe(false);
		const mapped = { sheet: 'Feuil1', columns: { 'tenants.fullName': 0 }, constants: {} };
		expect(freeFileNeeded({ preview: recognized, mapping: { single: mapped } } as unknown as ImportJobView)).toBe(true);
	});

	it('point de départ : la correspondance déjà faite, sinon les suggestions de la première feuille', () => {
		expect(initialSingleMapping({ preview: preview(), mapping: {} } as unknown as ImportJobView)).toEqual({
			sheet: 'Feuil1',
			columns: { 'tenants.fullName': 0, 'leases.rent': 1 },
			constants: {}
		});
		const mapped = { sheet: 'Feuil1', columns: { 'leases.rent': 1 }, constants: { 'units.type': 'Studio' } };
		expect(initialSingleMapping({ preview: preview(), mapping: { single: mapped } } as unknown as ImportJobView)).toEqual(mapped);
	});

	it('une colonne choisie remplace la valeur commune du champ, et inversement ; vide retire le choix', () => {
		const m = { sheet: 'Feuil1', columns: {}, constants: { 'units.type': 'Studio' } };
		const a = withColumn(m, 'units.type', 3);
		expect(a).toEqual({ sheet: 'Feuil1', columns: { 'units.type': 3 }, constants: {} });
		const b = withConstant(a, 'units.type', 'Chambre-salon');
		expect(b).toEqual({ sheet: 'Feuil1', columns: {}, constants: { 'units.type': 'Chambre-salon' } });
		expect(withColumn(b, 'units.type', null)).toEqual({ sheet: 'Feuil1', columns: {}, constants: { 'units.type': 'Chambre-salon' } });
		expect(withConstant(withColumn(m, 'leases.rent', 2), 'leases.rent', '')).toEqual({ sheet: 'Feuil1', columns: { 'leases.rent': 2 }, constants: { 'units.type': 'Studio' } });
	});
});
