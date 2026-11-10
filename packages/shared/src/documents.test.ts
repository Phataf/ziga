import { describe, expect, it } from 'vitest';
import { canReadDocument, DOCUMENT_ACCESS, DOCUMENT_RESTRICTIONS, DOCUMENT_TYPES } from './documents.js';
import { ORGANIZATION_ROLES } from './permissions.js';

describe('matrice de confidentialité des documents (D22, docs/UX.md §10)', () => {
	it('types du lot 07 : direction et gestion seulement ; ni l’agent de terrain, ni le profil lecture', () => {
		for (const type of DOCUMENT_TYPES) {
			const doc = { type, restriction: null };
			expect(canReadDocument('director', doc), type).toBe(true);
			expect(canReadDocument('manager', doc), type).toBe(true);
			expect(canReadDocument('field_agent', doc, { assignedUnit: true }), type).toBe(false);
			expect(canReadDocument('viewer', doc), type).toBe(false);
			expect(canReadDocument(null, doc), type).toBe(false);
		}
	});

	it('pièces du propriétaire, titres et mandat : le propriétaire voit les siens ; le locataire, jamais', () => {
		for (const type of ['title_deed', 'puh', 'allocation_certificate', 'apfr', 'owner_identity', 'mandate'] as const) {
			expect(DOCUMENT_ACCESS[type]).toMatchObject({ owner: 'own', tenant: 'never' });
		}
		for (const type of ['document_photo', 'other'] as const)
			expect(DOCUMENT_ACCESS[type]).toMatchObject({ owner: 'never', tenant: 'never' });
	});

	it('une restriction ne fait que réduire : jamais un droit de plus qu’avec la matrice seule', () => {
		for (const type of DOCUMENT_TYPES) {
			for (const role of ORGANIZATION_ROLES) {
				for (const assignedUnit of [false, true]) {
					const open = canReadDocument(role, { type, restriction: null }, { assignedUnit });
					for (const restriction of DOCUMENT_RESTRICTIONS) {
						const restricted = canReadDocument(role, { type, restriction }, { assignedUnit });
						if (restricted) expect(open, `${type}/${role}/${restriction}`).toBe(true);
					}
				}
			}
		}
		expect(canReadDocument('manager', { type: 'title_deed', restriction: 'director_only' })).toBe(false);
		expect(canReadDocument('director', { type: 'title_deed', restriction: 'director_only' })).toBe(true);
	});
});
