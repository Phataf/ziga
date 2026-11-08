import { describe, expect, it } from 'vitest';
import { buildDataset } from './fixtures';
import { buildHorizonDataset, buildLandlordDataset, memberships, personLinks, persons, type PersonLink } from './fixtures-orgs';
import { ownerPortfolio, spacesOf, tenantHistory, type Organizations, type PortalRead } from './portals';

const today = '2026-11-07';
const orgs: Organizations = {
	'agency-demo': buildDataset(today),
	'agency-horizon': buildHorizonDataset(today),
	'landlord-sawadogo': buildLandlordDataset(today)
};
const periods = ['2026-10', '2026-11'];

describe('espace propriétaire (D13)', () => {
	it('regroupe les biens par gestionnaire : deux agences, puis la gestion directe', () => {
		const groups = ownerPortfolio('person-issouf', personLinks, orgs, periods);
		expect(groups.map((g) => [g.organization.name, g.managedBy])).toEqual([
			['Horizon Immo', 'agency'],
			['Immo Démo', 'agency'],
			['Issouf Sawadogo', 'self']
		]);
		expect(groups.find((g) => g.organization.id === 'agency-demo')!.properties.map((p) => p.name)).toEqual(['Villa Ouaga 2000', 'Résidence Tampouy']);
		expect(groups.find((g) => g.managedBy === 'self')!.properties[0].units.map((u) => u.summary.label)).toEqual(['Louée', 'À remettre en état']);
	});

	it('ne lit que les biens de cette personne, sans les coordonnées des locataires', () => {
		const json = JSON.stringify(ownerPortfolio('person-issouf', personLinks, orgs, periods));
		expect(json).not.toContain('Cour Pissy'); // bien d'une autre propriétaire chez Immo Démo
		expect(json).not.toContain('Cour Dapoya'); // bien d'une autre propriétaire chez Horizon Immo
		for (const data of Object.values(orgs)) {
			for (const t of data.tenants) {
				expect(json).not.toContain(t.phone);
				expect(json).not.toContain(t.name);
			}
		}
	});

	it('n’ouvre une organisation qu’après vérification du téléphone ET acceptation du lien', () => {
		const pending: PersonLink[] = personLinks.map((l) => (l.organizationId === 'agency-horizon' && l.kind === 'owner' ? { ...l, acceptedOn: undefined } : l));
		const groups = ownerPortfolio('person-issouf', pending, orgs, periods);
		expect(groups.map((g) => g.organization.id)).not.toContain('agency-horizon');
		const unverified: PersonLink[] = personLinks.map((l) => ({ ...l, verifiedOn: undefined }));
		expect(ownerPortfolio('person-issouf', unverified, orgs, periods)).toEqual([]);
	});

	it('lit chaque organisation une à la fois et journalise chaque lecture', () => {
		const journal: PortalRead[] = [];
		ownerPortfolio('person-issouf', personLinks, orgs, periods, journal);
		expect(journal.map((r) => r.organizationId)).toEqual(['agency-demo', 'agency-horizon', 'landlord-sawadogo']);
		expect(journal.every((r) => r.kind === 'owner' && r.personId === 'person-issouf')).toBe(true);
	});

	it('calcule les revenus de chaque gestionnaire sans commission en gestion directe', () => {
		const groups = ownerPortfolio('person-issouf', personLinks, orgs, periods);
		const self = groups.find((g) => g.managedBy === 'self')!;
		expect(self.months[0].commission).toBe(0);
		const immo = groups.find((g) => g.organization.id === 'agency-demo')!;
		expect(immo.months[0].net).toBe(428000); // même relevé d'octobre que l'agence (lot 00)
	});
});

describe('espace locataire (D13, D17)', () => {
	it('présente les deux baux, chacun avec son organisation, le plus récent d’abord', () => {
		const h = tenantHistory('person-rodrigue', personLinks, orgs);
		expect(h.map((x) => [x.organization.name, x.current])).toEqual([
			['Immo Démo', true],
			['Horizon Immo', false]
		]);
		expect(h[1].settlement).toMatchObject({ deposit: 100000, refund: 85000 });
		expect(h[1].settlement!.lines.map((l) => l.amount)).toEqual([10000, 5000]);
	});

	it('aucune donnée d’un autre locataire, même dans la même cour', () => {
		const json = JSON.stringify(tenantHistory('person-rodrigue', personLinks, orgs));
		expect(json).not.toContain('Boris Tiendrébéogo'); // locataire actuel de son ancien logement
		expect(json).not.toContain('+22665448810');
	});

	it('une agence ne voit jamais les données d’une autre : chaque jeu de données ne contient que ses lignes', () => {
		const immo = orgs['agency-demo'];
		const json = JSON.stringify(immo);
		expect(json).not.toContain('Horizon');
		expect(json).not.toContain('hl0');
		expect(JSON.stringify(orgs['agency-horizon'])).not.toContain('Immo Démo');
	});
});

describe('choix de l’espace', () => {
	it('une personne qui a plusieurs espaces les voit tous, et seulement les siens', () => {
		const issouf = persons.find((p) => p.id === 'person-issouf')!;
		const spaces = spacesOf(issouf, personLinks, memberships, orgs);
		expect(spaces.map((s) => s.id)).toEqual(['owner', 'landlord']);
		expect(spaces[0].detail).toContain('Immo Démo, Horizon Immo, gestion directe');
		const rodrigue = persons.find((p) => p.id === 'person-rodrigue')!;
		expect(spacesOf(rodrigue, personLinks, memberships, orgs).map((s) => s.id)).toEqual(['tenant']);
	});
});
