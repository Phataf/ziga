/**
 * Modèles par défaut de la plateforme (D25) : chaque balise est reconnue, les douze clauses sont dans l'ordre, et un
 * contrat généré n'a aucun blanc, pour un bailleur organisation, un propriétaire représenté et un bailleur particulier.
 * Pénalité de retard et garantie des factures : absentes par défaut, présentes seulement si le bail les prévoit.
 */
import { blankFields, EXAMPLE_CONTRACT_DATA, resolveContractFields, type ContractData } from '@ziga/shared/contract-fields';
import { PLATFORM_TEMPLATES } from '@ziga/shared/contracts';
import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
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
	deposits: { security: { amount: 150_000, months: 2, holder: 'organization' }, utilities: { amount: 25_000 } }
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
		// i. Le mandat est cité par sa date.
		expect(generated(ownerLessor).text).toContain(
			'représenté par Agence Exemple SARL (siège : Avenue de l’Exemple, secteur 0, Ouagadougou), en vertu du mandat de gestion du 1er\u00a0janvier 2024, elle-même représentée par Prénom Nom'
		);
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
		expect(full).toContain('pour une durée indéterminée, à compter du 1er\u00a0janvier 2027');
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

describe('corrections du porteur, dans le texte (étape 4)', () => {
	const mid: ContractData = {
		...EXAMPLE_CONTRACT_DATA,
		tenant: { ...EXAMPLE_CONTRACT_DATA.tenant, civility: 'mrs', fullName: 'Locataire Exemple' },
		lease: { ...EXAMPLE_CONTRACT_DATA.lease, startsOn: '2027-01-15', endsOn: '2028-01-14', duesStartOn: '2027-01-15' },
		deposits: { security: { amount: 150_000, months: 2, holder: 'owner' }, utilities: null }
	};

	it('c, d, e, f, g, h : accord, préavis du bailleur, exemplaires, dates en lettres, premier mois, détenteur', () => {
		const { text, blanks } = generated(mid);
		expect(blanks).toEqual([]);
		expect(text).toContain('Madame Locataire Exemple, née le 1er\u00a0juin 1990');
		expect(text).toContain('respecte un préavis de trois (3) mois dans les deux cas');
		expect(text).toContain('en trois (3) exemplaires originaux, dont un pour chaque partie et un pour l’enregistrement.');
		expect(text).toContain('Fait à Ouagadougou, le 15\u00a0décembre 2026');
		expect(text).toContain(
			'le loyer du 15\u00a0janvier 2027 au 31\u00a0janvier 2027, calculé au prorata des jours, soit 41\u202f129\u00a0FCFA (quarante et un mille cent vingt-neuf francs CFA), est dû à la signature, en plus de l’avance prévue ci-après.'
		);
		expect(text).toContain('Il est détenu par le propriétaire, Propriétaire Exemple.');
		expect(text).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
		// Entrée le 1er du mois : pas de premier mois au prorata.
		expect(generated(EXAMPLE_CONTRACT_DATA).text).not.toContain('au prorata des jours');
	});

	it('b : pied de page sur chaque page, avec la référence du bail, « Page X sur Y » et les paraphes', () => {
		const filled = fillTemplate(defaultTemplate('lease'), resolveContractFields(EXAMPLE_CONTRACT_DATA));
		const footer = new PizZip(filled).file('word/footer1.xml')!.asText();
		expect(footer).toContain('Bail B-EXEMPLE1 – Page ');
		expect(footer).toContain('w:instr=" PAGE \\* MERGEFORMAT "');
		expect(footer).toContain('w:instr=" NUMPAGES \\* MERGEFORMAT "');
		expect(footer).toContain('Paraphes : ______ ______');
		expect(new PizZip(defaultTemplate('lease')).file('word/document.xml')!.asText()).toContain('<w:footerReference w:type="default"');
	});

	it('a : articles 11 et 12, « Fait à… », la mention et le tableau des signatures se suivent sur une même page', () => {
		const xml = new PizZip(defaultTemplate('lease')).file('word/document.xml')!.asText();
		// L'article 11 est lié aux signatures : jamais une page de signatures seules.
		const from = xml.indexOf('Article 11');
		const signature = xml.slice(xml.lastIndexOf('<w:p>', from), xml.indexOf('</w:tbl>', from));
		// Titre (style à « garder avec le suivant »), puis chaque paragraphe lié au suivant, lignes du tableau insécables.
		const paragraphs = signature.split('<w:tbl>')[0]!.split('<w:p>').slice(2);
		for (const para of paragraphs) expect(para.includes('<w:keepNext/>') || para.includes('<w:pStyle w:val="Heading1"/>'), para).toBe(true);
		// Les titres d'article (style Titre 1) sont liés au paragraphe suivant par leur style.
		const styles = new PizZip(defaultTemplate('lease')).file('word/styles.xml')!.asText();
		expect(styles.slice(styles.indexOf('w:styleId="Heading1"'))).toMatch(/^[^]*?<w:keepNext\/>[^]*?<\/w:style>/);
		expect(signature).toContain('<w:cantSplit/>');
	});

	it('version 3 (lot 09) : l’article 4 prévoit un « reçu de paiement », jamais une « quittance »', () => {
		expect(PLATFORM_TEMPLATES.lease.version).toBe(3);
		const text = docxText(defaultTemplate('lease'));
		const article4 = text.slice(text.indexOf('Article 4'), text.indexOf('Article 5'));
		expect(article4).toContain('Un reçu de paiement est remis au Locataire à chaque paiement.');
		expect(text.toLowerCase()).not.toContain('quittance');
		expect(docxText(defaultTemplate('amendment')).toLowerCase()).not.toContain('quittance');
	});

	it('texte des clauses : identique à la version relue (fichier versionné, à mettre à jour avec le texte)', async () => {
		const withFooter = (docx: Buffer) => `${docxText(docx)}\n\n[Pied de page]\n${docxText(docx, 'word/footer1.xml')}`;
		await expect(withFooter(defaultTemplate('lease'))).toMatchFileSnapshot('./default-templates.lease.txt');
		const amendment = withFooter(defaultTemplate('amendment'));
		await expect(amendment).toMatchFileSnapshot('./default-templates.amendment.txt');
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
		expect(renewal.text).toContain('jusqu’au 31\u00a0décembre 2028');
		expect(renewal.text).toContain('Agence Exemple SARL, représentée par Prénom Nom, en sa qualité de gérant, ci-après « le Bailleur »');
		const open = generated(amendment({ type: 'renewal', newRent: null, newCharges: null, newEndsOn: null }), 'amendment');
		expect(open.text).toContain('pour une durée indéterminée');
		const other = generated(amendment({ type: 'other', newRent: null, newCharges: null, description: 'Ajout d’un garage.' }), 'amendment');
		expect(other.blanks).toEqual([]);
		expect(other.text).toContain('Ajout d’un garage.');
		expect(other.text).not.toMatch(/[{}]/);
	});
});

describe('propriétaire signataire (mandat sans pouvoir de signer)', () => {
	const owner: ContractData = {
		...EXAMPLE_CONTRACT_DATA,
		lease: { ...EXAMPLE_CONTRACT_DATA.lease, lessorType: 'owner' },
		signing: { ...EXAMPLE_CONTRACT_DATA.signing, parties: 3, ownerSigns: true }
	};

	it('une case « Le Propriétaire » s’ajoute au bail et à l’avenant ; absente sinon', () => {
		for (const kind of ['lease', 'amendment'] as const) {
			const data: ContractData =
				kind === 'lease'
					? owner
					: {
							...owner,
							amendment: {
								number: 1,
								type: 'other',
								effectiveFrom: '2027-07-01',
								description: 'Ajout d’un garage.',
								newRent: null,
								newCharges: null,
								newEndsOn: null,
								baseContractSignedOn: '2026-12-15'
							}
						};
			const { text, blanks } = generated(data, kind);
			expect(blanks, kind).toEqual([]);
			expect(text, kind).toContain('Le Propriétaire\nPropriétaire Exemple');
			expect(text, kind).not.toMatch(/[{}]/);
			// Une case de paraphe par partie.
			const footer = new PizZip(fillTemplate(defaultTemplate(kind), resolveContractFields(data, kind))).file('word/footer1.xml')!.asText();
			expect(footer, kind).toContain('Paraphes : ______ ______ ______<');
		}
		expect(generated(ownerLessor).text).not.toContain('Le Propriétaire\n');
	});
});
