import { describe, expect, it } from 'vitest';
import { deviceOf } from './device';
import { activeNav, knownPaths, menuOf, moreOf, profiles, sectionsOf, spaceOfPath, tabsOf, type ProfileId } from './profiles';

const ids = Object.keys(profiles) as ProfileId[];

describe('navigation par profil (docs/UX.md §2)', () => {
	it('chaque profil a 4 onglets au plus sur téléphone, chacun avec un libellé', () => {
		for (const id of ids) {
			const tabs = tabsOf(profiles[id]);
			expect(tabs.length, id).toBeLessThanOrEqual(4);
			for (const t of tabs) expect((t.short ?? t.label).length).toBeGreaterThan(0);
		}
	});

	it('donne les onglets prévus par docs/UX.md', () => {
		const tabs = (id: ProfileId) => tabsOf(profiles[id]).map((t) => t.short ?? t.label);
		expect(tabs('director')).toEqual(['Accueil', 'Biens', 'Encaissements', 'Plus']);
		expect(tabs('manager')).toEqual(['Accueil', 'Biens', 'Encaissements', 'Plus']);
		expect(tabs('viewer')).toEqual(['Accueil', 'Biens', 'Encaissements', 'Plus']);
		expect(tabs('field_agent')).toEqual(['Tournée', 'Biens', 'Encaissements', 'Plus']);
		expect(tabs('landlord')).toEqual(['Accueil', 'Logements', 'Loyers', 'Plus']);
		expect(tabs('owner')).toEqual(['Patrimoine', 'Revenus', 'Relevés', 'Plus']);
		expect(tabs('tenant')).toEqual(['Logement', 'Reçus', 'Caution', 'Plus']);
		expect(tabs('visitor')).toEqual([]);
	});

	it('équipe, paramètres et journal selon le rôle (lot 03)', () => {
		const labels = (id: ProfileId) => menuOf(profiles[id]).map((i) => i.label);
		expect(labels('director')).toEqual(expect.arrayContaining(['Équipe', 'Paramètres de l’organisation', 'Journal']));
		// Le gestionnaire voit l'équipe (en lecture), sans les paramètres ni le journal.
		expect(labels('manager')).toContain('Équipe');
		expect(labels('manager')).not.toContain('Paramètres de l’organisation');
		expect(labels('manager')).not.toContain('Journal');
		// La lecture et comptabilité ne voit pas l'équipe.
		expect(labels('viewer')).not.toContain('Équipe');
		expect(labels('landlord')).toEqual(expect.arrayContaining(['Paramètres de l’organisation', 'Journal']));
		expect(labels('landlord')).not.toContain('Équipe');
		expect(sectionsOf(profiles.director).map(([s]) => s)).toEqual(['Pilotage', 'Gestion', 'Contrôle', 'Agence']);
	});

	it('« Plus » n’apparaît que sur téléphone et rassemble les entrées sans onglet', () => {
		expect(menuOf(profiles.manager).some((i) => i.phoneOnly)).toBe(false);
		expect(moreOf(profiles.manager).map((i) => i.label)).toEqual(['Impayés', 'Propriétaires', 'À valider', 'Équipe']);
	});

	it('trouve l’entrée active par le plus long préfixe', () => {
		expect(activeNav(profiles.owner.nav, '/espace/proprietaire/revenus')?.label).toBe('Revenus');
		expect(activeNav(profiles.owner.nav, '/espace/proprietaire')?.label).toBe('Mon patrimoine');
	});

	it('rattache chaque chemin à son espace', () => {
		expect(spaceOfPath('/app/biens')).toBe('agency');
		expect(spaceOfPath('/espace/locataire/recus')).toBe('tenant');
		expect(spaceOfPath('/admin')).toBe('admin');
		expect(spaceOfPath('/louer')).toBe('public');
		expect(knownPaths.has('/app/equipe')).toBe(true);
		expect(knownPaths.has('/app/inconnu')).toBe(false);
	});
});

describe('type d’appareil (docs/UX.md §3)', () => {
	it('téléphone < 768 px ≤ tablette < 1280 px ≤ ordinateur', () => {
		expect([360, 767, 768, 1279, 1280, 1440].map(deviceOf)).toEqual(['phone', 'phone', 'tablet', 'tablet', 'desktop', 'desktop']);
	});
});
