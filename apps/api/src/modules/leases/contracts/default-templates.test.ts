/**
 * Modèles par défaut de la plateforme (D25) : chaque balise est reconnue, les douze clauses sont dans l'ordre, et un
 * contrat généré n'a aucun blanc, pour un bailleur organisation, un propriétaire représenté et un bailleur particulier.
 * Pénalité de retard et garantie des factures : absentes par défaut, présentes seulement si le bail les prévoit.
 */
import { blankFields, EXAMPLE_CONTRACT_DATA, resolveContractFields, type ContractData } from '@ziga/shared/contract-fields';
import { describe, expect, it } from 'vitest';
import { docxText, fillTemplate } from './contract-renderer.js';
import { DEFAULT_LEASE_CLAUSE_TITLES, defaultTemplate } from './default-templates.js';
import { inspectTemplate } from './template-inspection.js';

const ownerLessor: ContractData = { ...EXAMPLE_CONTRACT_DATA, lease: { ...EXAMPLE_CONTRACT_DATA.lease, lessorType: 'owner' } };
const landlord: ContractData = {
	...EXAMPLE_CONTRACT_DATA,
	organization: {
		...EXAMPLE_CONTRACT_DATA.organization,
		type: 'landlord',
		legalName: 'Bailleur Exemple',
		tradeName: null,
		rccm: null,
		ifu: null
	},
	owner: null
};
const withOptions: ContractData = {
	...EXAMPLE_CONTRACT_DATA,
	unit: { ...EXAMPLE_CONTRACT_DATA.unit, furnished: true },
	lease: {
		...EXAMPLE_CONTRACT_DATA.lease,
		endsOn: null,
		durationMonths: null,
		charges: 5_000,
		penaltyRateBp: 75,
		penaltyGraceDays: 10,
		penaltyBeneficiary: 'organization',
		reducedNoticeMonths: 1,
		reducedNoticeCases: 'premier emploi, mutation',
		earlyTerminationIndemnityMonths: 1
	},
	deposits: { security: { amount: 150_000, months: 2 }, utilities: { amount: 25_000 } }
};

function generated(data: ContractData, kind: 'lease' | 'amendment' = 'lease'): { text: string; blanks: string[] } {
	const template = defaultTemplate(kind);
	const values = resolveContractFields(data, kind);
	const { usages } = inspectTemplate(template, kind);
	return { text: docxText(fillTemplate(template, values)), blanks: blankFields(usages, values) };
}

describe('modèle de bail par défaut (D25)', () => {
	it('chaque balise est reconnue ; police disponible (Times New Roman → Liberation Serif)', () => {
		const r = inspectTemplate(defaultTemplate('lease'), 'lease');
		expect(r.unknown).toEqual([]);
		expect(r.unmatchedFonts).toEqual([]);
		expect(r.known.length).toBeGreaterThan(40);
	});

	it('les douze clauses, dans l’ordre du prompt', () => {
		const { text } = generated(EXAMPLE_CONTRACT_DATA);
		let at = 0;
		for (const title of DEFAULT_LEASE_CLAUSE_TITLES) {
			const found = text.indexOf(title, at);
			expect(found, title).toBeGreaterThan(-1);
			at = found + title.length;
		}
		expect(DEFAULT_LEASE_CLAUSE_TITLES).toHaveLength(12);
	});

	it('sans aucun blanc ni balise restante : organisation bailleur, propriétaire représenté, bailleur particulier, options', () => {
		for (const [name, data] of [
			['organisation', EXAMPLE_CONTRACT_DATA],
			['propriétaire', ownerLessor],
			['bailleur particulier', landlord],
			['options', withOptions]
		] as const) {
			const { text, blanks } = generated(data);
			expect(blanks, name).toEqual([]);
			expect(text, name).not.toMatch(/[{}]/);
			expect(text, name).toContain('soixante-quinze mille francs CFA');
		}
	});

	it('bailleur : l’organisation en son nom, ou le propriétaire représenté en vertu d’un mandat (D24)', () => {
		expect(generated(EXAMPLE_CONTRACT_DATA).text).toContain('Agence Exemple SARL (siège : Avenue de l’Exemple, secteur 0, Ouagadougou)');
		expect(generated(ownerLessor).text).toContain('Propriétaire Exemple, propriétaire du logement');
		expect(generated(ownerLessor).text).toContain('en vertu d’un mandat de gestion');
	});

	it('pénalité, garantie des factures, préavis réduit : absents par défaut, présents si le bail les prévoit', () => {
		const plain = generated(EXAMPLE_CONTRACT_DATA).text;
		expect(plain).not.toContain('intérêt de retard');
		expect(plain).not.toContain('factures d’eau et d’électricité');
		expect(plain).not.toContain('Par exception');
		expect(plain).toContain('il ne peut excéder deux mois de loyer');
		const full = generated(withOptions).text;
		expect(full).toContain('au taux de 0,75');
		expect(full).toContain('vingt-cinq mille francs CFA');
		expect(full).toContain('réduit à un (1) mois dans les cas suivants : premier emploi, mutation');
		expect(full).toContain('pour une durée indéterminée, à compter du 01/01/2027');
		expect(full).toContain('inventaire du mobilier');
	});

	it('un champ obligatoire manquant est un blanc : la pièce d’identité du locataire', () => {
		const data = {
			...EXAMPLE_CONTRACT_DATA,
			tenant: { ...EXAMPLE_CONTRACT_DATA.tenant, identity: { ...EXAMPLE_CONTRACT_DATA.tenant.identity, number: null } }
		};
		expect(generated(data).blanks).toEqual(['locataire.piece']);
	});

	it('mêmes entrées, mêmes octets', () => {
		expect(defaultTemplate('lease').equals(defaultTemplate('lease'))).toBe(true);
	});
});

describe('modèle d’avenant par défaut', () => {
	const amendment = (patch: Partial<NonNullable<ContractData['amendment']>>): ContractData => ({
		...EXAMPLE_CONTRACT_DATA,
		amendment: {
			number: 1,
			type: 'rent_change',
			effectiveFrom: '2027-07-01',
			description: null,
			newRent: 80_000,
			newCharges: 0,
			newEndsOn: null,
			baseContractSignedOn: '2026-12-15',
			...patch
		}
	});

	it('chaque balise est reconnue ; aucun blanc pour un changement de loyer, un renouvellement, une autre modification', () => {
		expect(inspectTemplate(defaultTemplate('amendment'), 'amendment').unknown).toEqual([]);
		const rent = generated(amendment({}), 'amendment');
		expect(rent.blanks).toEqual([]);
		expect(rent.text).toContain('quatre-vingt mille francs CFA');
		const renewal = generated(
			amendment({ type: 'renewal', newRent: null, newCharges: null, newEndsOn: '2028-12-31', effectiveFrom: '2028-01-01' }),
			'amendment'
		);
		expect(renewal.blanks).toEqual([]);
		expect(renewal.text).toContain('jusqu’au 31/12/2028');
		const open = generated(amendment({ type: 'renewal', newRent: null, newCharges: null, newEndsOn: null }), 'amendment');
		expect(open.text).toContain('pour une durée indéterminée');
		const other = generated(amendment({ type: 'other', newRent: null, newCharges: null, description: 'Ajout d’un garage.' }), 'amendment');
		expect(other.blanks).toEqual([]);
		expect(other.text).toContain('Ajout d’un garage.');
		expect(other.text).not.toMatch(/[{}]/);
	});
});
