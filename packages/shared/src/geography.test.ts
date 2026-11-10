import { describe, expect, it } from 'vitest';
import { placeNameKey, publicLocation } from './geography.js';

const ouagadougou = { lat: 12.368187, lng: -1.527094 };

describe('référentiel géographique (lot 07)', () => {
	it('nom comparé sans accents, sans casse, espaces réduits', () => {
		expect(placeNameKey(' Somgandé ')).toBe(placeNameKey('somgande'));
		expect(placeNameKey('Patte  d’Oie')).toBe('patte d’oie');
		expect(placeNameKey('ZÉKOUNGA')).toBe('zekounga');
		expect(placeNameKey('Kalgondé')).not.toBe(placeNameKey('Kalgodin'));
	});

	it('publicLocation : centre du quartier quand il a un point', () => {
		expect(publicLocation({ neighborhood: { lat: 12.412142, lng: -1.494332 }, commune: ouagadougou })).toEqual({
			lat: 12.412142,
			lng: -1.494332,
			precision: 'neighborhood'
		});
	});

	it('publicLocation : centre de la commune quand le quartier n’a pas de point', () => {
		expect(publicLocation({ neighborhood: { lat: null, lng: null }, commune: ouagadougou })).toEqual({
			...ouagadougou,
			precision: 'commune'
		});
		// Point incomplet ou invalide : jamais publié à moitié.
		expect(publicLocation({ neighborhood: { lat: 12.4, lng: null }, commune: ouagadougou }).precision).toBe('commune');
		expect(publicLocation({ neighborhood: { lat: Number.NaN, lng: -1.5 }, commune: ouagadougou }).precision).toBe('commune');
	});

	it('publicLocation ne reprend jamais le point GPS du bien, même s’il est fourni avec le reste', () => {
		const gps = { lat: 12.3456789, lng: -1.4567891 };
		const property = { gpsLat: gps.lat, gpsLng: gps.lng, neighborhood: { lat: null, lng: null }, commune: ouagadougou };
		const located = publicLocation(property);
		expect(located).toEqual({ ...ouagadougou, precision: 'commune' });
		expect(JSON.stringify(located)).not.toContain(String(gps.lat));
		expect(JSON.stringify(located)).not.toContain(String(gps.lng));
	});
});
