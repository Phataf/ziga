import { describe, expect, it } from 'vitest';
import {
	canReadDocument,
	createDocumentSchema,
	DOCUMENT_ACCESS,
	DOCUMENT_RESTRICTIONS,
	DOCUMENT_TYPES,
	LEASE_DOCUMENT_TYPES
} from './documents.js';
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

describe('documents du bail (lot 08)', () => {
	it('matrice : bail signé et pièce du locataire, direction et gestion ; jamais l’agent de terrain ni le profil lecture', () => {
		for (const type of ['signed_lease_scan', 'tenant_identity'] as const) {
			expect(canReadDocument('director', { type, restriction: null })).toBe(true);
			expect(canReadDocument('manager', { type, restriction: null })).toBe(true);
			expect(canReadDocument('field_agent', { type, restriction: null }, { assignedUnit: true })).toBe(false);
			expect(canReadDocument('viewer', { type, restriction: null })).toBe(false);
			expect(canReadDocument('manager', { type, restriction: 'director_only' })).toBe(false);
		}
		expect(DOCUMENT_ACCESS.signed_lease_scan).toMatchObject({ owner: 'own', tenant: 'own' });
		expect(DOCUMENT_ACCESS.tenant_identity).toMatchObject({ owner: 'never', tenant: 'own' });
	});

	it('ne se déposent pas depuis un bien : ils se rattachent au bail ou au locataire', () => {
		const base = {
			id: '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e6f',
			propertyId: '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e70',
			fileName: 'bail.pdf',
			mimeType: 'application/pdf',
			byteSize: 1000
		};
		for (const type of LEASE_DOCUMENT_TYPES) expect(createDocumentSchema.safeParse({ ...base, type }).success).toBe(false);
		expect(createDocumentSchema.safeParse({ ...base, type: 'title_deed' }).success).toBe(true);
	});
});
