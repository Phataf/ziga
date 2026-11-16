import { describe, expect, it } from 'vitest';
import {
	canPartyReadDocument,
	CONTRACT_DOCUMENT_TYPES,
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

	it('se rattachent au bail ou au locataire, pas seulement à un bien', () => {
		const base = {
			id: '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e6f',
			propertyId: '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e70',
			fileName: 'bail.pdf',
			mimeType: 'application/pdf',
			byteSize: 1000
		};
		for (const type of LEASE_DOCUMENT_TYPES) expect(createDocumentSchema.safeParse({ ...base, type }).success).toBe(false);
		const leaseId = '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e71';
		const { propertyId: _p, ...noProperty } = base;
		expect(createDocumentSchema.safeParse({ ...noProperty, type: 'signed_lease_scan', leaseId }).success).toBe(true);
		expect(createDocumentSchema.safeParse({ ...noProperty, type: 'tenant_identity', tenantId: leaseId }).success).toBe(true);
		expect(createDocumentSchema.safeParse({ ...base, type: 'title_deed' }).success).toBe(true);
	});
});

describe('documents vus par les parties (espaces personnels, lot 08 bis puis lot 10 ter)', () => {
	it('le locataire ne voit pas le mandat, ni les pièces du propriétaire ; le propriétaire ne voit pas la pièce du locataire', () => {
		for (const type of ['mandate', 'owner_identity', 'title_deed', 'puh', 'allocation_certificate', 'apfr'] as const) {
			expect(canPartyReadDocument('tenant', { type, restriction: null }, { isParty: true }), type).toBe(false);
			expect(canPartyReadDocument('owner', { type, restriction: null }, { isParty: true }), type).toBe(true);
		}
		expect(canPartyReadDocument('owner', { type: 'tenant_identity', restriction: null }, { isParty: true })).toBe(false);
		expect(canPartyReadDocument('tenant', { type: 'tenant_identity', restriction: null }, { isParty: true })).toBe(true);
	});

	it('jamais sans être partie, jamais un document restreint, jamais une note interne', () => {
		for (const type of DOCUMENT_TYPES) {
			for (const party of ['owner', 'tenant'] as const) {
				expect(canPartyReadDocument(party, { type, restriction: null }, { isParty: false }), `${party}/${type}`).toBe(false);
				expect(canPartyReadDocument(party, { type, restriction: 'director_only' }, { isParty: true }), `${party}/${type}`).toBe(false);
			}
		}
		for (const type of ['document_photo', 'other'] as const) {
			expect(canPartyReadDocument('owner', { type, restriction: null }, { isParty: true })).toBe(false);
			expect(canPartyReadDocument('tenant', { type, restriction: null }, { isParty: true })).toBe(false);
		}
	});

	it('bail signé : le propriétaire et le locataire qui en sont parties', () => {
		for (const party of ['owner', 'tenant'] as const) {
			expect(canPartyReadDocument(party, { type: 'signed_lease_scan', restriction: null }, { isParty: true })).toBe(true);
		}
	});
});

describe('documents du contrat (lot 08 bis, docs/UX.md §10)', () => {
	it('projet de contrat : direction et gestion ; jamais l’agent de terrain ni le profil lecture', () => {
		const draft = { type: 'contract_draft' as const, restriction: null };
		expect(canReadDocument('director', draft)).toBe(true);
		expect(canReadDocument('manager', draft)).toBe(true);
		expect(canReadDocument('field_agent', draft, { assignedUnit: true })).toBe(false);
		expect(canReadDocument('viewer', draft)).toBe(false);
	});

	it('projet de contrat : le locataire à partir de « prêt à signer » seulement ; le propriétaire, pas avant la P2', () => {
		const draft = { type: 'contract_draft' as const, restriction: null };
		expect(canPartyReadDocument('tenant', draft, { isParty: true, contractStatus: 'draft' })).toBe(false);
		expect(canPartyReadDocument('tenant', draft, { isParty: true, contractStatus: 'in_review' })).toBe(false);
		expect(canPartyReadDocument('tenant', draft, { isParty: true, contractStatus: 'ready_to_sign' })).toBe(true);
		expect(canPartyReadDocument('tenant', draft, { isParty: true, contractStatus: 'signed' })).toBe(true);
		expect(canPartyReadDocument('tenant', draft, { isParty: true })).toBe(false);
		expect(canPartyReadDocument('owner', draft, { isParty: true, contractStatus: 'signed' })).toBe(false);
	});

	it('modèle de contrat : l’organisation seule ; avenant signé et preuves : comme le contrat signé', () => {
		expect(DOCUMENT_ACCESS.contract_template).toMatchObject({ owner: 'never', tenant: 'never', fieldAgent: 'never' });
		for (const type of ['signed_amendment_scan', 'contract_legalization', 'contract_registration'] as const) {
			expect(DOCUMENT_ACCESS[type]).toEqual(DOCUMENT_ACCESS.signed_lease_scan);
		}
	});

	it('la route générique refuse les documents du contrat et le Word', () => {
		const base = {
			id: '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e6f',
			leaseId: '019a5e2c-7d1e-7c3a-8b2f-1a2b3c4d5e71',
			fileName: 'contrat.pdf',
			mimeType: 'application/pdf',
			byteSize: 1000
		};
		for (const type of CONTRACT_DOCUMENT_TYPES) expect(createDocumentSchema.safeParse({ ...base, type }).success, type).toBe(false);
		const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
		expect(createDocumentSchema.safeParse({ ...base, type: 'signed_lease_scan', mimeType: docx }).success).toBe(false);
		expect(createDocumentSchema.safeParse({ ...base, type: 'signed_lease_scan' }).success).toBe(true);
	});
});
