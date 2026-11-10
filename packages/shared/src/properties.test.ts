import { describe, expect, it } from 'vitest';
import {
	AMENITIES,
	isAvailable,
	OCCUPANCIES,
	occupancyOf,
	RECORD_STATUSES,
	TECHNICAL_STATUSES,
	UNIT_TYPES,
	type OccupancySignal
} from './properties.js';

describe('statut d’unité en quatre dimensions (D14, règle 13)', () => {
	it('isAvailable, sur les 48 combinaisons : fiche active, libre ou en préavis, et prête ; rien d’autre', () => {
		let available = 0;
		for (const recordStatus of RECORD_STATUSES) {
			for (const occupancy of OCCUPANCIES) {
				for (const technicalStatus of TECHNICAL_STATUSES) {
					const expected = recordStatus === 'active' && ['free', 'notice'].includes(occupancy) && technicalStatus === 'ready';
					expect(isAvailable({ recordStatus, occupancy, technicalStatus }), `${recordStatus}/${occupancy}/${technicalStatus}`).toBe(
						expected
					);
					if (expected) available += 1;
				}
			}
		}
		expect(RECORD_STATUSES.length * OCCUPANCIES.length * TECHNICAL_STATUSES.length).toBe(48);
		expect(available).toBe(2);
	});

	it('occupation sans bail : libre (lot 07)', () => {
		expect(occupancyOf()).toBe('free');
		expect(occupancyOf([])).toBe('free');
	});

	it('occupation : le bail le plus fort l’emporte (occupée, puis préavis, puis réservée)', () => {
		const cases: [OccupancySignal[], string][] = [
			[['reserved'], 'reserved'],
			[['notice'], 'notice'],
			[['occupied'], 'occupied'],
			[['reserved', 'notice'], 'notice'],
			[['notice', 'reserved'], 'notice'],
			[['reserved', 'occupied', 'notice'], 'occupied']
		];
		for (const [signals, expected] of cases) expect(occupancyOf(signals), signals.join(',')).toBe(expected);
	});

	it('listes fermées validées par le porteur : 13 types d’unité, 16 équipements, sans doublon', () => {
		expect(UNIT_TYPES).toHaveLength(13);
		expect(AMENITIES).toHaveLength(16);
		expect(new Set(UNIT_TYPES).size).toBe(UNIT_TYPES.length);
		expect(new Set(AMENITIES).size).toBe(AMENITIES.length);
	});
});

describe('schémas des biens et des unités (lot 07)', () => {
	const id = '01a1c6fa-54ad-7465-9101-b3d8373bb2a9';

	it('bien : brouillon minimal ; le quartier exige sa commune ; « aucun » document exclut les autres', async () => {
		const { createPropertySchema } = await import('./properties.js');
		const ok = createPropertySchema.parse({ id, ownerId: id, type: 'house', name: ' Villa Tampouy ' });
		expect(ok).toMatchObject({ name: 'Villa Tampouy', operation: 'rent', communeId: null, gps: null, declaredLandDocuments: [] });
		expect(createPropertySchema.safeParse({ id, ownerId: id, type: 'house', name: 'Villa', neighborhoodId: id }).success).toBe(false);
		expect(
			createPropertySchema.safeParse({ id, ownerId: id, type: 'house', name: 'Villa', declaredLandDocuments: ['none', 'puh'] }).success
		).toBe(false);
		expect(createPropertySchema.safeParse({ id, ownerId: id, type: 'castle', name: 'Villa' }).success).toBe(false);
	});

	it('unité : montants en FCFA entiers, pièces entières, équipements de la liste fermée ; aucune occupation', async () => {
		const { createUnitSchema } = await import('./properties.js');
		const u = createUnitSchema.parse({ id, propertyId: id, type: 'apartment', label: 'A2', rent: 75000, amenities: ['fence', 'garage'] });
		expect(u).toMatchObject({ rent: 75000, rooms: { bedrooms: 0 }, usage: 'residential', furnished: false });
		expect(u).not.toHaveProperty('occupancy');
		expect(createUnitSchema.safeParse({ id, propertyId: id, type: 'apartment', label: 'A2', rent: 75000.5 }).success).toBe(false);
		expect(createUnitSchema.safeParse({ id, propertyId: id, type: 'apartment', label: 'A2', rent: -1 }).success).toBe(false);
		expect(createUnitSchema.safeParse({ id, propertyId: id, type: 'apartment', label: 'A2', amenities: ['piscine'] }).success).toBe(false);
		expect(createUnitSchema.safeParse({ id, propertyId: id, type: 'apartment', label: 'A2', rooms: { bedrooms: 1.5 } }).success).toBe(
			false
		);
	});

	it('état technique : motif obligatoire hors « prête », rien en « prête »', async () => {
		const { technicalStatusSchema } = await import('./properties.js');
		expect(technicalStatusSchema.safeParse({ technicalStatus: 'under_works' }).success).toBe(false);
		expect(technicalStatusSchema.parse({ technicalStatus: 'under_works', reason: 'Toiture', expectedOn: '2026-12-01' })).toEqual({
			technicalStatus: 'under_works',
			reason: 'Toiture',
			expectedOn: '2026-12-01'
		});
		expect(technicalStatusSchema.safeParse({ technicalStatus: 'ready', reason: 'Toiture' }).success).toBe(false);
		expect(technicalStatusSchema.parse({ technicalStatus: 'ready' })).toEqual({ technicalStatus: 'ready', reason: null, expectedOn: null });
	});

	it('statut de fiche : brouillon → active ; archivée → active ; jamais retour au brouillon', async () => {
		const { canChangeRecordStatus } = await import('./properties.js');
		expect(canChangeRecordStatus('draft', 'active')).toBe(true);
		expect(canChangeRecordStatus('archived', 'active')).toBe(true);
		expect(canChangeRecordStatus('active', 'draft')).toBe(false);
		expect(canChangeRecordStatus('archived', 'draft')).toBe(false);
	});
});

describe('modifications partielles des biens et des unités', () => {
	it('un champ absent ne reprend pas sa valeur par défaut (équipements, meublé, pièces, opération, documents)', async () => {
		const { updatePropertySchema, updateUnitSchema } = await import('./properties.js');
		expect(updatePropertySchema.parse({ name: 'Villa' })).toEqual({ name: 'Villa' });
		expect(updateUnitSchema.parse({ rent: 80000 })).toEqual({ rent: 80000 });
		expect(updateUnitSchema.parse({ rooms: { bedrooms: 3 } })).toEqual({ rooms: { bedrooms: 3 } });
	});
});
