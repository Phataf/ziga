import { describe, expect, it } from 'vitest';
import {
	contractList,
	contractTimeline,
	filterContracts,
	DEFAULT_CONTRACT_FILTERS,
	signerDates,
	templatesInUse,
	toContract,
	toContractVersion,
	toTemplate
} from './views';

const today = '2027-03-01';
const ctx = { leaseVersion: 1, frozenLeaseVersion: 1, recordedByName: 'Awa O.', today };

const row = (patch: Record<string, unknown> = {}) => ({
	id: 'c1',
	lease_id: 'l1',
	amendment_id: null,
	origin: 'generated',
	template_source: 'platform',
	template_version: 2,
	status: 'draft',
	current_version: 1,
	frozen_version: null,
	frozen_at: null,
	generation_status: 'idle',
	expected_signers: '["organization","tenant"]',
	legalization_reminder: 1,
	created_at: '2027-01-01T10:00:00Z',
	updated_at: '2027-01-01T10:00:00Z',
	...patch
});

const lease = (patch: Partial<Parameters<typeof contractList>[0][number]> = {}) => ({
	id: 'l1',
	status: 'active' as const,
	startsOn: '2027-01-01',
	endsOn: '2027-12-31',
	noticeGivenOn: null,
	lastAutomaticRenewalOn: null,
	unitLabel: 'Villa A',
	tenantName: 'Locataire Exemple',
	...patch
});

describe('contrat sur l’appareil (lot 08 bis)', () => {
	it('lit la ligne synchronisée : signataires, modèle par défaut non relu (D25), aucune alerte en brouillon', () => {
		const c = toContract(row(), ctx);
		expect(c.expectedSigners).toEqual(['organization', 'tenant']);
		expect(c.defaultTemplateNotice).toBe(true);
		expect(c.alerts).toEqual([]);
		expect(toContract(row({ template_source: 'organization' }), ctx).defaultTemplateNotice).toBe(false);
	});

	it('prêt à signer depuis 7 jours : en attente de signature ; bail modifié depuis le figement : à régénérer', () => {
		const ready = row({ status: 'ready_to_sign', frozen_version: 1, frozen_at: '2027-02-20T09:00:00Z' });
		expect(toContract(ready, ctx).alerts).toEqual(['signature_pending']);
		const changed = toContract(ready, { ...ctx, leaseVersion: 2 });
		expect(changed.outdated).toBe(true);
		expect(changed.alerts).toContain('contract_outdated');
		expect(toContract(row({ status: 'ready_to_sign', frozen_version: 1, frozen_at: '2027-02-26T09:00:00Z' }), ctx).alerts).toEqual([]);
	});

	it('signé : libellé « Signature manuscrite, scan déposé par … le … », jamais « signé électroniquement » (D21)', () => {
		const c = toContract(
			row({
				status: 'signed',
				signature_recorded_at: '2027-02-01T10:00:00Z',
				organization_signed_on: '2027-02-01',
				tenant_signed_on: '2027-02-01'
			}),
			ctx
		);
		expect(c.signatureLabel).toBe('Signature manuscrite, scan déposé par Awa O. le 01/02/2027');
		expect(c.signatureLabel).not.toMatch(/lectronique/);
		// Un mois après la signature, non légalisé, rappel actif : le rappel s'affiche 7 jours.
		expect(c.alerts).toEqual(['not_legalized']);
		expect(toContract(row({ status: 'signed', organization_signed_on: '2027-02-01', legalization_reminder: 0 }), ctx).alerts).toEqual([]);
		expect(toContract(row({ status: 'signed', organization_signed_on: '2027-02-01', legalized_on: '2027-02-10' }), ctx).alerts).toEqual([]);
	});
});

describe('liste des contrats', () => {
	const signed = toContract(row({ status: 'signed', organization_signed_on: '2027-01-01', legalized_on: '2027-01-02' }), ctx);

	it('un bail en vigueur sans contrat signé porte « contrat non signé » ; un bail annulé n’apparaît pas', () => {
		const items = contractList([lease(), lease({ id: 'l2', status: 'cancelled' }), lease({ id: 'l3', status: 'draft' })], [], today);
		expect(items.map((i) => i.leaseId)).toEqual(['l1', 'l3']);
		expect(items[0]!.state).toBe('none');
		expect(items[0]!.alerts).toEqual(['contract_unsigned']);
		expect(items[1]!.alerts).toEqual([]);
	});

	it('le contrat signé l’emporte sur un brouillon plus récent ; un avenant en cours est signalé', () => {
		const draft = toContract(row({ id: 'c2', created_at: '2027-02-01T00:00:00Z' }), ctx);
		const amendment = toContract(row({ id: 'c3', amendment_id: 'a1' }), ctx);
		const [item] = contractList([lease()], [draft, signed, amendment], today);
		expect(item!.contract!.id).toBe('c1');
		expect(item!.state).toBe('signed');
		expect(item!.pendingAmendments).toBe(1);
		expect(item!.alerts).toEqual(['amendment_pending']);
	});

	it('terme du bail : fin dans 4 mois, puis 3 mois ; reconduction appliquée', () => {
		expect(contractList([lease({ endsOn: '2027-06-30' })], [signed], today)[0]!.alerts).toEqual(['lease_ends_in_4_months']);
		expect(contractList([lease({ endsOn: '2027-05-31' })], [signed], today)[0]!.alerts).toEqual(['lease_ends_in_3_months']);
		expect(contractList([lease({ lastAutomaticRenewalOn: '2027-02-15' })], [signed], today)[0]!.alerts).toEqual(['renewed_automatically']);
	});

	it('filtres : statut du bail, statut du contrat, alertes seulement', () => {
		const items = contractList([lease(), lease({ id: 'l3', status: 'draft' })], [signed], today);
		expect(filterContracts(items, DEFAULT_CONTRACT_FILTERS)).toHaveLength(2);
		expect(filterContracts(items, { ...DEFAULT_CONTRACT_FILTERS, leaseStatus: 'draft' }).map((i) => i.leaseId)).toEqual(['l3']);
		expect(filterContracts(items, { ...DEFAULT_CONTRACT_FILTERS, contractState: 'signed' }).map((i) => i.leaseId)).toEqual(['l1']);
		expect(filterContracts(items, { ...DEFAULT_CONTRACT_FILTERS, contractState: 'none' }).map((i) => i.leaseId)).toEqual(['l3']);
		expect(filterContracts(items, { ...DEFAULT_CONTRACT_FILTERS, alertsOnly: true })).toEqual([]);
	});
});

describe('modèles en usage (D25)', () => {
	it('le modèle actif de l’organisation, sinon celui de la plateforme, avec le bandeau tant qu’il n’est pas relu', () => {
		const active = toTemplate({ id: 't1', kind: 'lease', name: 'Bail agence', version: 3, status: 'active', document_id: 'd1' });
		const draft = toTemplate({ id: 't2', kind: 'amendment', name: 'Avenant', version: 1, status: 'draft', document_id: 'd2' });
		const inUse = templatesInUse([active, draft]);
		expect(inUse.lease).toEqual({ source: 'organization', templateId: 't1', version: 3, legalReviewPending: false });
		expect(inUse.amendment).toEqual({ source: 'platform', templateId: null, version: 2, legalReviewPending: true });
	});
});

describe('chronologie du contrat', () => {
	it('création, versions, figement, signature, légalisation : la plus récente d’abord', () => {
		const c = toContract(
			row({
				status: 'signed',
				frozen_version: 2,
				frozen_at: '2027-01-10T08:00:00Z',
				organization_signed_on: '2027-01-12',
				legalized_on: '2027-01-20'
			}),
			ctx
		);
		const versions = [1, 2].map((n) => ({ ...toContractVersionRow(n) }));
		expect(contractTimeline(c, versions).map((e) => e.kind)).toEqual(['legalized', 'signed', 'frozen', 'version', 'version', 'created']);
		expect(signerDates(c)).toEqual([
			{ party: 'organization', date: '2027-01-12' },
			{ party: 'tenant', date: null }
		]);
	});
});

function toContractVersionRow(n: number) {
	return toContractVersion({ id: `v${n}`, number: n, lease_version: 1, created_at: `2027-01-0${n}T10:00:00Z`, blank_fields: '[]' });
}
