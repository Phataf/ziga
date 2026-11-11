import { describe, expect, it } from 'vitest';
import type { MediaView, UnitView } from '@ziga/shared/properties';
import {
	filterProperties,
	galleryOf,
	NO_FILTERS,
	reorder,
	suggestLabels,
	toMedia,
	toProperty,
	toUnit,
	unitDimensions,
	unitSummary
} from './views';

const unitRow = (extra: Record<string, unknown> = {}) => ({
	id: 'u1',
	property_id: 'p1',
	type: 'apartment',
	label: 'A1',
	bedrooms: 2,
	furnished: 1,
	amenities: '["fence","garage"]',
	rent: 75000,
	record_status: 'active',
	technical_status: 'ready',
	...extra
});

describe('vues des biens (lot 07)', () => {
	it('bien : documents déclarés depuis le JSON, point GPS complet ou absent, brouillon par défaut', () => {
		const p = toProperty({
			id: 'p1',
			owner_id: 'o1',
			type: 'house',
			name: 'Villa',
			declared_land_documents: '["puh"]',
			gps_lat: 12.3,
			gps_lng: -1.5
		});
		expect(p).toMatchObject({ recordStatus: 'draft', declaredLandDocuments: ['puh'], gps: { lat: 12.3, lng: -1.5, accuracyM: null } });
		expect(toProperty({ id: 'p2', type: 'land', name: 'T', gps_lat: 12.3 }).gps).toBeNull();
		expect(toProperty({ id: 'p3', type: 'land', name: 'T', declared_land_documents: 'pas du json' }).declaredLandDocuments).toEqual([]);
	});

	it('unité : booléens et tableaux de SQLite ; occupation calculée, jamais lue ; disponibilité (règle 13)', () => {
		const u = toUnit(unitRow({ occupancy: 'occupied' }));
		expect(u).toMatchObject({
			furnished: true,
			amenities: ['fence', 'garage'],
			rooms: { bedrooms: 2, livingRooms: 0 },
			occupancy: 'free',
			available: true
		});
		expect(toUnit(unitRow({ technical_status: 'under_works' })).available).toBe(false);
		expect(toUnit(unitRow({ record_status: null })).recordStatus).toBe('draft');
	});

	it('pastille de synthèse et quatre dimensions', () => {
		expect(unitSummary(toUnit(unitRow()))).toEqual({ label: 'Disponible', tone: 'success' });
		expect(unitSummary(toUnit(unitRow({ technical_status: 'to_refurbish' })))).toEqual({ label: 'À remettre en état', tone: 'warning' });
		expect(unitSummary(toUnit(unitRow({ record_status: 'draft' })))).toEqual({ label: 'Brouillon', tone: 'secondary' });
		expect(unitDimensions(toUnit(unitRow())).map((d) => d.value)).toEqual(['Active', 'Libre', 'Prête', 'Non publiée']);
	});

	it('filtres : quartier et propriétaire sur le bien ; disponibilité et état technique sur au moins une unité', () => {
		const properties = [
			toProperty({ id: 'p1', owner_id: 'o1', type: 'house', name: 'A', neighborhood_id: 'n1' }),
			toProperty({ id: 'p2', owner_id: 'o2', type: 'house', name: 'B', neighborhood_id: 'n2' })
		];
		const units: UnitView[] = [toUnit(unitRow()), toUnit(unitRow({ id: 'u2', property_id: 'p2', technical_status: 'under_works' }))];
		const ids = (f: Partial<typeof NO_FILTERS>) => filterProperties(properties, units, { ...NO_FILTERS, ...f }).map((p) => p.id);
		expect(ids({})).toEqual(['p1', 'p2']);
		expect(ids({ neighborhoodId: 'n2' })).toEqual(['p2']);
		expect(ids({ ownerId: 'o1' })).toEqual(['p1']);
		expect(ids({ availability: 'available' })).toEqual(['p1']);
		expect(ids({ availability: 'unavailable' })).toEqual(['p2']);
		expect(ids({ technical: 'under_works' })).toEqual(['p2']);
	});

	it('libellés proposés : suite numérotée, sans reprendre un libellé déjà pris', () => {
		expect(suggestLabels('Appartement', 3, [])).toEqual(['Appartement 1', 'Appartement 2', 'Appartement 3']);
		expect(suggestLabels('Appartement', 2, ['APPARTEMENT 1', 'Appartement 3'])).toEqual(['Appartement 2', 'Appartement 4']);
		expect(suggestLabels('  ', 1, [])).toEqual(['Unité 1']);
	});

	it('galerie : ordre par position, sans les photos retirées ; réordonner ne réécrit que ce qui change', () => {
		const m = (id: string, position: number, extra: Partial<Record<string, unknown>> = {}): MediaView =>
			toMedia({ id, property_id: 'p1', unit_id: 'u1', position, status: 'ready', variants_key: 'k'.repeat(22), ...extra });
		const gallery = galleryOf(
			[m('c', 2), m('a', 0), m('x', 1, { status: 'removed' }), m('b', 1), m('z', 0, { unit_id: null })],
			'p1',
			'u1'
		);
		expect(gallery.map((g) => g.id)).toEqual(['a', 'b', 'c']);
		expect(gallery[0]!.variants![320]).toBe(`/media/v/${'k'.repeat(22)}/320.webp`);
		expect(reorder(gallery, 'c', -1)).toEqual([
			{ id: 'c', position: 1 },
			{ id: 'b', position: 2 }
		]);
		expect(reorder(gallery, 'a', -1)).toEqual([]);
	});
});
