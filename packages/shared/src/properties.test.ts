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
