import { describe, expect, it } from 'vitest';
import {
	blankFields,
	classifyTemplateTags,
	CONTRACT_FIELDS,
	contractField,
	countInWords,
	EXAMPLE_CONTRACT_DATA,
	fieldsForKind,
	identityLine,
	leaseDurationMonths,
	resolveContractFields,
	type ContractData
} from './contract-fields.js';
import { NBSP as MONEY_NBSP, THIN_NBSP as THIN } from './money.js';

/** Espace insécable des textes du catalogue (n°, m²) ; les montants et les taux suivent packages/shared/money. */
const NB = '\u00a0';

/** Toutes les options remplies : chaque champ texte du catalogue doit avoir une valeur. */
const FULL: ContractData = {
	...EXAMPLE_CONTRACT_DATA,
	organization: { ...EXAMPLE_CONTRACT_DATA.organization },
	owner: { type: 'group', name: 'Indivision Exemple', address: 'Saaba', phone: '+22670000001', representativeName: 'Représentant Exemple' },
	tenant: { ...EXAMPLE_CONTRACT_DATA.tenant, secondaryPhone: '+22676000000' },
	unit: { ...EXAMPLE_CONTRACT_DATA.unit, laundries: 1, furnished: true },
	lease: {
		...EXAMPLE_CONTRACT_DATA.lease,
		charges: 5_000,
		penaltyRateBp: 75,
		penaltyGraceDays: 10,
		penaltyBeneficiary: 'organization',
		reducedNoticeMonths: 1,
		reducedNoticeCases: 'premier emploi, mutation',
		earlyTerminationIndemnityMonths: 1
	},
	deposits: { security: { amount: 150_000, months: 2 }, utilities: { amount: 25_000 } },
	amendment: {
		number: 1,
		type: 'rent_change',
		effectiveFrom: '2027-07-01',
		description: 'Nouveau loyer à compter du 1er juillet.',
		newRent: 80_000,
		newCharges: 5_000,
		newEndsOn: '2028-12-31',
		baseContractSignedOn: '2026-12-15'
	}
};

describe('catalogue des champs', () => {
	it('balises uniques, en minuscules, groupe en tête', () => {
		const tags = CONTRACT_FIELDS.map((f) => f.tag);
		expect(new Set(tags).size).toBe(tags.length);
		for (const f of CONTRACT_FIELDS) {
			expect(f.tag, f.tag).toMatch(/^[a-z_]+(\.[a-z0-9_]+)?$/);
			expect(f.tag.split('.')[0], f.tag).toBe(f.group);
			expect(f.label.length, f.tag).toBeGreaterThan(2);
			expect(f.source.length, f.tag).toBeGreaterThan(2);
		}
	});

	it('toutes options remplies : chaque champ texte a une valeur, chaque condition est un booléen', () => {
		const values = resolveContractFields(FULL, 'amendment');
		for (const f of CONTRACT_FIELDS) {
			const v = values[f.tag];
			if (f.kind === 'condition') expect(typeof v, f.tag).toBe('boolean');
			else expect(typeof v === 'string' && v.length > 0, `${f.tag} = ${String(v)}`).toBe(true);
		}
	});

	it('montants « 75 000 FCFA » et en lettres, dates jj/mm/aaaa, durées en lettres et en chiffres', () => {
		const v = resolveContractFields(EXAMPLE_CONTRACT_DATA);
		expect(v['loyer.montant']).toBe(`75${THIN}000${MONEY_NBSP}FCFA`);
		expect(v['loyer.montant_lettres']).toBe('soixante-quinze mille francs CFA');
		expect(v['caution.montant']).toBe(`150${THIN}000${MONEY_NBSP}FCFA`);
		expect(v['caution.montant_lettres']).toBe('cent cinquante mille francs CFA');
		expect(v['caution.mois']).toBe('deux (2) mois');
		expect(v['caution.delai_restitution']).toBe('trente (30) jours');
		expect(v['bail.date_debut']).toBe('01/01/2027');
		expect(v['bail.date_fin']).toBe('31/12/2027');
		expect(v['bail.duree']).toBe('douze (12) mois');
		expect(v['avance.mois']).toBe('trois (3) mois');
		expect(v['avance.montant']).toBe(`225${THIN}000${MONEY_NBSP}FCFA`);
		expect(v['preavis.locataire_duree_determinee']).toBe('deux (2) mois');
		expect(v['signature.exemplaires_lettres']).toBe('trois');
		expect(v['logement.consistance']).toBe('3 chambres, 1 salon, 1 cuisine, 2 salles de bain, 1 terrasse');
		expect(v['logement.cloture']).toBe('clôturé');
		expect(v['logement.destination']).toBe('à usage d’habitation');
		expect(v['locataire.nom_complet']).toBe('Monsieur Locataire Exemple');
		expect(v['locataire.piece']).toBe(`CNIB n°${NB}B11111111, délivrée le 10/03/2021 par ONI`);
	});

	it('pénalité, garantie des factures, préavis réduit : absents par défaut (D25), présents si choisis', () => {
		const def = resolveContractFields(EXAMPLE_CONTRACT_DATA);
		expect(def.penalite).toBe(false);
		expect(def.garantie_factures).toBe(false);
		expect(def['preavis.reduit']).toBe(false);
		expect(def['penalite.taux']).toBeNull();
		const full = resolveContractFields(FULL);
		expect(full.penalite).toBe(true);
		expect(full['penalite.taux']).toBe(`0,75${MONEY_NBSP}%`);
		expect(full['penalite.delai_grace']).toBe('dix (10) jours');
		expect(full['garantie_factures.montant_lettres']).toBe('vingt-cinq mille francs CFA');
	});

	it('bailleur désigné (D24) : l’organisation en son nom, ou le propriétaire représenté', () => {
		const org = resolveContractFields(EXAMPLE_CONTRACT_DATA);
		expect(org['bailleur.nom']).toBe('Agence Exemple SARL');
		expect(org['bailleur.est_organisation']).toBe(true);
		expect(org['bailleur.represente_par']).toBe('Prénom Nom, gérant');
		const owner = resolveContractFields({ ...EXAMPLE_CONTRACT_DATA, lease: { ...EXAMPLE_CONTRACT_DATA.lease, lessorType: 'owner' } });
		expect(owner['bailleur.nom']).toBe('Propriétaire Exemple');
		expect(owner['bailleur.est_proprietaire']).toBe(true);
		expect(owner['bailleur.qualite']).toBe('propriétaire, représenté par Agence Exemple SARL en vertu d’un mandat de gestion');
		// Bailleur particulier : l'organisation est le bailleur, sans fiche propriétaire.
		const landlord = resolveContractFields({
			...EXAMPLE_CONTRACT_DATA,
			organization: { ...EXAMPLE_CONTRACT_DATA.organization, type: 'landlord', legalName: 'Bailleur Exemple', tradeName: null },
			owner: null
		});
		expect(landlord['bailleur.nom']).toBe('Bailleur Exemple');
		expect(landlord['bailleur.qualite']).toBe('propriétaire');
		expect(landlord['proprietaire.nom']).toBeNull();
	});

	it('bail à durée indéterminée : pas de durée ni de fin, la condition le dit', () => {
		const v = resolveContractFields({
			...EXAMPLE_CONTRACT_DATA,
			lease: { ...EXAMPLE_CONTRACT_DATA.lease, endsOn: null, durationMonths: null }
		});
		expect(v['bail.duree_indeterminee']).toBe(true);
		expect(v['bail.duree']).toBeNull();
		expect(v['bail.date_fin']).toBeNull();
	});

	it('une version garde une copie : les valeurs ne changent pas si les données changent ensuite (D29)', () => {
		const data = structuredClone(FULL);
		const frozen = JSON.parse(JSON.stringify(resolveContractFields(data, 'amendment'))) as Record<string, unknown>;
		data.organization.legalName = 'Nouveau nom';
		data.tenant.fullName = 'Autre locataire';
		expect(frozen['organisation.raison_sociale']).toBe('Agence Exemple SARL');
		expect(frozen['locataire.nom']).toBe('Locataire Exemple');
		expect(resolveContractFields(data, 'amendment')['organisation.raison_sociale']).toBe('Nouveau nom');
	});

	it('formats : pièce sans numéro, durée déduite des dates, compte en lettres', () => {
		expect(identityLine({ type: null, typeOther: null, number: null, issuedOn: null, issuedBy: null })).toBeNull();
		expect(identityLine({ type: 'other', typeOther: 'Permis', number: 'X1', issuedOn: null, issuedBy: 'Mairie' })).toBe(
			`Permis n°${NB}X1, délivrée par Mairie`
		);
		expect(leaseDurationMonths({ startsOn: '2027-01-31', endsOn: '2027-07-30', durationMonths: null })).toBe(6);
		expect(leaseDurationMonths({ startsOn: '2027-01-01', endsOn: '2027-01-20', durationMonths: null })).toBeNull();
		expect(countInWords(1, 'mois', 'mois')).toBe('un (1) mois');
		expect(countInWords(21, 'jour')).toBe('vingt et un (21) jours');
	});
});

describe('balises d’un modèle', () => {
	it('reconnues ou inconnues ; les champs d’avenant sont inconnus dans un modèle de bail', () => {
		const report = classifyTemplateTags(
			['locataire.nom', 'loyer.montant_lettres', 'locataire.nom', 'client.nom', 'avenant.numero'],
			'lease'
		);
		expect(report).toEqual({ known: ['locataire.nom', 'loyer.montant_lettres'], unknown: ['client.nom', 'avenant.numero'] });
		expect(classifyTemplateTags(['avenant.numero'], 'amendment').unknown).toEqual([]);
		expect(fieldsForKind('lease').some((f) => f.amendmentOnly)).toBe(false);
		expect(contractField('loyer.montant')?.group).toBe('loyer');
	});

	it('sans aucun blanc : une valeur vide n’est un blanc que si elle est rendue', () => {
		const values = resolveContractFields({
			...EXAMPLE_CONTRACT_DATA,
			organization: { ...EXAMPLE_CONTRACT_DATA.organization, poBox: null }
		});
		const usages = [
			{ tag: 'locataire.nom', role: 'value' as const, sections: [] },
			// BP hors section : un blanc.
			{ tag: 'organisation.boite_postale', role: 'value' as const, sections: [] },
			// Pénalité dans sa section, fausse par défaut : pas de blanc.
			{ tag: 'penalite.taux', role: 'value' as const, sections: [{ tag: 'penalite', inverted: false }] },
			// Durée dans « pas à durée indéterminée » : rendue, et remplie.
			{ tag: 'bail.duree', role: 'value' as const, sections: [{ tag: 'bail.duree_indeterminee', inverted: true }] },
			// Section conditionnée par le texte lui-même (BP vide : la section n'est pas rendue).
			{ tag: 'organisation.boite_postale', role: 'value' as const, sections: [{ tag: 'organisation.boite_postale', inverted: false }] },
			{ tag: 'penalite', role: 'section' as const, sections: [] }
		];
		expect(blankFields(usages, values)).toEqual(['organisation.boite_postale']);
		expect(blankFields(usages.slice(2), values)).toEqual([]);
		// Une pénalité choisie sans taux : un blanc dans sa section.
		expect(blankFields([usages[2]!], { ...values, penalite: true, 'penalite.taux': null })).toEqual(['penalite.taux']);
	});
});
