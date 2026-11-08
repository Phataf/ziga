import { describe, expect, it } from 'vitest';
import { buildDataset } from './fixtures';
import { buildLandlordDataset } from './fixtures-orgs';
import { publicationBlockers } from './rules';
import type { Lease, Mandate, Unit } from './types';
import { isAvailable, listingStateOf, occupancyOf, summaryOfUnit, unitSummary, withUnitStatus } from './unit-status';

const today = '2026-11-07';
const lease = (over: Partial<Lease>): Lease => ({
	id: 'l',
	unitId: 'u',
	tenantId: 't',
	startDate: '2025-01-01',
	rent: 50000,
	charges: 0,
	deposit: 100000,
	dueDay: 5,
	...over
});

describe('occupation calculée à partir des baux (D14)', () => {
	it('libre sans bail', () => {
		expect(occupancyOf('u', [], today).occupancy).toBe('free');
	});
	it('louée avec un bail en cours', () => {
		expect(occupancyOf('u', [lease({})], today).occupancy).toBe('occupied');
	});
	it('en préavis, libre à la date de fin du préavis', () => {
		const r = occupancyOf('u', [lease({ notice: { givenOn: '2026-08-31', by: 'tenant', reason: '', effectiveDate: '2026-11-30' } })], today);
		expect(r).toMatchObject({ occupancy: 'notice', until: '2026-11-30' });
	});
	it('réservée quand un bail signé commence plus tard', () => {
		expect(occupancyOf('u', [lease({ startDate: '2026-12-01' })], today)).toMatchObject({ occupancy: 'reserved', from: '2026-12-01' });
	});
	it('redevient libre à la remise des clés, et l’ancien bail ne compte plus', () => {
		expect(occupancyOf('u', [lease({ endDate: today })], today).occupancy).toBe('free');
		expect(occupancyOf('u', [lease({ endDate: '2025-03-31' }), lease({ id: 'l2', startDate: '2025-05-01' })], today).lease?.id).toBe('l2');
	});
	it('ignore les baux des autres unités', () => {
		expect(occupancyOf('u', [lease({ unitId: 'autre' })], today).occupancy).toBe('free');
	});
});

describe('disponibilité et pastille de synthèse', () => {
	it('disponible = fiche active, libre ou en préavis, et prête', () => {
		expect(isAvailable({ record: 'active', occupancy: 'free', technical: 'ready' })).toBe(true);
		expect(isAvailable({ record: 'active', occupancy: 'notice', technical: 'ready' })).toBe(true);
		expect(isAvailable({ record: 'active', occupancy: 'free', technical: 'to_refurbish' })).toBe(false);
		expect(isAvailable({ record: 'draft', occupancy: 'free', technical: 'ready' })).toBe(false);
		expect(isAvailable({ record: 'active', occupancy: 'occupied', technical: 'ready' })).toBe(false);
	});
	it('une seule pastille de synthèse par unité', () => {
		expect(unitSummary({ record: 'active', occupancy: 'free', technical: 'ready' }).label).toBe('Disponible');
		expect(unitSummary({ record: 'active', occupancy: 'free', technical: 'to_refurbish' }).label).toBe('À remettre en état');
		expect(unitSummary({ record: 'active', occupancy: 'occupied', technical: 'ready' }).label).toBe('Louée');
		expect(unitSummary({ record: 'active', occupancy: 'notice', technical: 'ready' }, { until: '2026-11-30' }).label).toBe('En préavis, libre le 30/11/2026');
	});
	it('une annonce publiée d’une unité qui n’est plus disponible est suspendue', () => {
		expect(listingStateOf({ visibility: 'published', status: 'free', technical: 'works' })).toBe('suspended');
		expect(listingStateOf({ visibility: 'published', status: 'free' })).toBe('published');
	});
});

describe('publication et disponibilité (règles 7, 8 et 13)', () => {
	const mandate: Mandate = { id: 'm', ownerId: 'o', type: 'management', startDate: '2025-01-01', endDate: '2027-12-31', commissionRate: 10, canPublish: true, canPhotograph: true, canCollect: true };
	const unit: Unit = { id: 'u', propertyId: 'p', label: 'A', kind: 'Appartement', rooms: 2, surface: 50, rent: 75000, charges: 0, status: 'rented', occupancy: 'notice', photos: 4, features: [], description: '', visibility: 'internal' };
	it('autorise une unité en préavis', () => {
		expect(publicationBlockers(unit, mandate, today)).toEqual([]);
	});
	it('refuse une unité à remettre en état', () => {
		expect(publicationBlockers({ ...unit, status: 'free', occupancy: 'free', technical: 'to_refurbish' }, mandate, today)).toEqual([
			'L’unité n’est pas prête (à remettre en état).'
		]);
	});
	it('un bailleur particulier publie ses propres logements sans mandat', () => {
		expect(publicationBlockers({ ...unit, occupancy: 'free', status: 'free' }, { ...mandate, selfManaged: true, canPublish: false, endDate: '2020-01-01' }, today)).toEqual([]);
	});
});

describe('données de démonstration du lot 00 ter', () => {
	const data = buildDataset(today);
	it('le statut de chaque unité découle des baux', () => {
		expect(withUnitStatus(data).units.map((u) => u.status)).toEqual(data.units.map((u) => u.status));
		expect(data.units.find((u) => u.id === 'u12')?.status).toBe('reserved');
		expect(data.units.find((u) => u.id === 'u20')?.status).toBe('reserved');
	});
	it('contient un bail en préavis avec une caution de 100 000 FCFA', () => {
		const l14 = data.leases.find((l) => l.id === 'l14')!;
		expect(l14.deposit).toBe(100000);
		expect(summaryOfUnit(data, data.units.find((u) => u.id === 'u17')!).label).toBe('En préavis, libre le 30/11/2026');
	});
	it('contient une unité à remettre en état, chez le bailleur particulier', () => {
		const landlord = buildLandlordDataset(today);
		const c2 = landlord.units.find((u) => u.id === 'cu2')!;
		expect(summaryOfUnit(landlord, c2).label).toBe('À remettre en état');
	});
});
