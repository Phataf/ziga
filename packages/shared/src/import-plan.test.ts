import { describe, expect, it } from 'vitest';
import { formatFcfa } from './money.js';
import { planImport, type ImportContext, type ImportPlan } from './import-plan.js';
import { importSheet, matchImportColumns, type ImportSheetKey } from './import-template.js';
import type { CellValue, ImportSheetInput } from './import-rows.js';

/** Onglet lu : en-têtes du modèle (ou d'un registre), puis les lignes ; colonnes reconnues comme à l'envoi. */
function sheet(key: ImportSheetKey, headers: string[], rows: CellValue[][], type: 'agency' | 'landlord' = 'agency'): ImportSheetInput {
	const match = matchImportColumns(headers, importSheet(key, type));
	return { key, rows: [headers, ...rows], columns: match.columns };
}

const OUAGA = 'commune-ouaga';
const SAABA = 'commune-saaba';
const TAMPOUY = 'nb-tampouy';
const SOMGANDE = 'nb-somgande';
const PISSY = 'nb-pissy';

const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({
	organizationType: 'agency',
	switchOn: '2026-11-01',
	today: '2026-11-22',
	billingMode: 'calendar_prorata',
	existing: {
		owners: [],
		tenants: [],
		communes: [
			{ id: OUAGA, name: 'Ouagadougou' },
			{ id: SAABA, name: 'Saaba' }
		],
		neighborhoods: [
			{ id: TAMPOUY, communeId: OUAGA, name: 'Tampouy' },
			{ id: SOMGANDE, communeId: OUAGA, name: 'Somgandé' },
			{ id: PISSY, communeId: OUAGA, name: 'Pissy' },
			{ id: 'nb-ouaga2000', communeId: OUAGA, name: 'Ouaga 2000' }
		]
	},
	...over
});

const OWNER_H = ['Référence', 'Forme', 'Nom ou raison sociale', 'Téléphone', 'Représentant (nom)', 'Représentant (téléphone)'];
const PROPERTY_H = [
	'Référence du bien',
	'Propriétaire',
	'Type de bien',
	'Nom du bien',
	'Commune',
	'Quartier',
	'Type de mandat',
	'Commission (%)',
	'Début du mandat',
	'Publication autorisée',
	'Encaissement par l’agence'
];
const UNIT_H = ['Référence de l’unité', 'Bien', 'Type d’unité', 'Libellé', 'Chambres', 'Loyer (FCFA)', 'État technique'];
const TENANT_H = ['Référence du locataire', 'Civilité', 'Nom et prénoms', 'Téléphone'];
const LEASE_H = [
	'Unité',
	'Locataire',
	'Date d’entrée',
	'Date de fin',
	'Date de sortie',
	'Loyer mensuel (FCFA)',
	'Charges mensuelles (FCFA)',
	'Avance (mois)'
];
const DEPOSIT_H = ['Bail ou unité', 'Nature', 'Montant convenu (FCFA)', 'Montant reçu (FCFA)', 'Date du versement', 'Détenteur'];
const BALANCE_H = ['Bail ou unité', 'Montant dû à la bascule (FCFA)'];

/** Petit registre d'agence complet et sans erreur. */
function registry(): Record<string, ImportSheetInput> {
	return {
		owners: sheet('owners', OWNER_H, [
			['P1', 'Personne', 'Ouédraogo Mariam', '70 11 22 33', '', ''],
			['P2', 'Société', 'SCI Wend Panga', '+226 25 30 40 50', '', ''],
			['P3', 'Indivision', 'Héritiers Sawadogo', '76 00 11 22', 'Sawadogo Ali', '76001122']
		]),
		properties: sheet('properties', PROPERTY_H, [
			['B-01', 'P1', 'Villa ou maison', 'Villa Tampouy', 'Ouagadougou', 'Tampouy', 'Gestion locative', '10 %', '01/01/2020', 'Non', 'Oui'],
			['B-02', 'P1', 'Cour commune', 'Cour Pissy', 'Ouagadougou', 'Pissy', 'Gestion locative', '10', '01/01/2020', 'Non', 'Oui'],
			['B-03', 'P2', 'Immeuble d’appartements', 'Immeuble Somgandé', 'Ouagadougou', 'Somgande', 'Gestion locative', '8 %', '2021-06-01', 'Non', 'Non']
		]),
		units: sheet('units', UNIT_H, [
			['B-01-A', 'B-01', 'Villa', 'Villa', 3, '150 000', ''],
			['B-02-1', 'B-02', 'Chambre-salon', 'Chambre 1', 1, '35.000 F', ''],
			['B-02-2', 'B-02', 'Chambre-salon', 'Chambre 2', 1, '35000 FCFA', ''],
			['B-03-A1', 'B-03', 'Appartement', 'Appartement A1', 2, 90000, '']
		]),
		tenants: sheet('tenants', TENANT_H, [
			['L1', 'M.', 'Kaboré Issouf', '70 12 34 56'],
			['L2', 'Mme', 'Traoré Awa', '76543210'],
			['L3', 'M.', 'Zongo Paul', '00226 65 43 21 09']
		]),
		leases: sheet('leases', LEASE_H, [
			['B-01-A', 'L1', '01/03/2021', '', '', '150 000', '', ''],
			['B-02-1', 'Traoré Awa', 44256, '', '', '35 000', '', ''],
			['B-03-A1', 'L3', '2026-12-01', '', '', '90000', '5 000', '2']
		]),
		deposits: sheet('deposits', DEPOSIT_H, [
			['B-01-A', 'Caution', '300 000', '', '', ''],
			['B-02-1', 'Caution', '70 000', '50 000', '05/03/2021', 'Propriétaire']
		]),
		opening_balances: sheet('opening_balances', BALANCE_H, [['B-01-A', '300 000']])
	};
}

const errors = (plan: ImportPlan) => plan.issues.filter((i) => i.severity === 'error').map((i) => i.message);
const warnings = (plan: ImportPlan) => plan.issues.filter((i) => i.severity === 'warning').map((i) => i.message);

describe('registre complet du modèle', () => {
	const plan = planImport(registry(), ctx());

	it('aucune erreur ; chaque ligne est planifiée', () => {
		expect(errors(plan)).toEqual([]);
		expect(plan.owners).toHaveLength(3);
		expect(plan.properties).toHaveLength(3);
		expect(plan.units).toHaveLength(4);
		expect(plan.tenants).toHaveLength(3);
		expect(plan.leases).toHaveLength(3);
		expect(plan.deposits).toHaveLength(2);
		expect(plan.openingBalances).toHaveLength(1);
	});

	it('valeurs normalisées : téléphones E.164, montants entiers, dates ISO', () => {
		expect(plan.tenants.map((t) => t.data.phone)).toEqual(['+22670123456', '+22676543210', '+22665432109']);
		expect(plan.units.map((u) => u.data.rent)).toEqual([150000, 35000, 35000, 90000]);
		expect(plan.leases.map((l) => l.terms.startsOn)).toEqual(['2021-03-01', '2021-03-01', '2026-12-01']);
	});

	it('trois formes de propriétaire ; le représentant du groupe', () => {
		expect(plan.owners.map((o) => o.data.type)).toEqual(['person', 'company', 'group']);
		expect(plan.owners[2]!.data.representative).toEqual({ name: 'Sawadogo Ali', phone: '+22676001122' });
		expect(plan.owners[0]!.data.representative).toBeNull();
	});

	it('mandats : un seul par propriétaire aux mêmes conditions, avec ses biens (règle 12)', () => {
		expect(plan.mandates).toHaveLength(2);
		const p1 = plan.mandates.find((m) => m.ownerRef === 'P1')!;
		expect(p1.propertyRefs).toEqual(['B-01', 'B-02']);
		expect(p1.terms).toMatchObject({
			startsOn: '2020-01-01',
			endsOn: null,
			commission: { basis: 'percent_of_collected', rateBp: 1000 },
			canCollectFunds: true
		});
		expect(p1.type).toBe('rental_management');
		expect(plan.mandates.find((m) => m.ownerRef === 'P2')!.propertyRefs).toEqual(['B-03']);
	});

	it('baux : bascule, bail réservé, avance sans objet avant la bascule', () => {
		const [kabore, traore, zongo] = plan.leases;
		expect(kabore!.status).toBe('active');
		expect(kabore!.terms.duesStartOn).toBe('2026-11-01');
		expect(kabore!.terms.lessorType).toBe('owner');
		expect(zongo!.status).toBe('signed');
		expect(zongo!.terms.duesStartOn).toBeNull();
		expect(zongo!.terms.advanceMonths).toBe(2);
		expect(traore!.terms.advanceMonths).toBe(0);
	});

	it('paramètres légaux par défaut (D24, D25) : rien n’est imposé par le fichier', () => {
		const t = plan.leases[0]!.terms;
		expect(t).not.toHaveProperty('dueDay');
		expect(t).not.toHaveProperty('noticeTenantFixedTermMonths');
		expect(t).not.toHaveProperty('depositRefundDays');
		expect(t).not.toHaveProperty('penaltyRateBp');
	});

	it('unités : état technique « prête » avec un bail, « à remettre en état » libre (règle 13)', () => {
		const byRef = Object.fromEntries(plan.units.map((u) => [u.ref, u]));
		expect(byRef['B-01-A']!.technicalStatus).toBe('ready');
		expect(byRef['B-01-A']!.technicalReason).toBeNull();
		expect(byRef['B-03-A1']!.technicalStatus).toBe('ready');
		expect(byRef['B-02-2']!.technicalStatus).toBe('to_refurbish');
		expect(byRef['B-02-2']!.technicalReason).toBe('Import : état à vérifier');
		expect(plan.units.every((u) => !('occupancy' in u.data))).toBe(true);
	});

	it('cautions (D33) : détenteur, reçu complet par défaut, reçu partiel, date du versement', () => {
		const [kabore, traore] = plan.deposits;
		// B-01 : encaissement par l'agence → l'organisation détient la caution.
		expect(kabore).toMatchObject({
			leaseRef: 'B-01-A',
			type: 'security_deposit',
			agreedAmount: 300000,
			receivedAmount: 300000,
			receivedOn: '2021-03-01',
			holder: 'organization'
		});
		expect(traore).toMatchObject({ agreedAmount: 70000, receivedAmount: 50000, receivedOn: '2021-03-05', holder: 'owner' });
	});

	it('solde d’ouverture : exigible à la date de bascule', () => {
		expect(plan.openingBalances).toEqual([{ row: 2, leaseRef: 'B-01-A', amount: 300000, dueOn: '2026-11-01' }]);
	});

	it('résumé : unités nouvelles (quota), baux avec un solde antérieur (avertissement avant l’exécution)', () => {
		expect(plan.summary).toMatchObject({ newUnits: 4, leases: 3, leasesWithOpeningBalance: 1 });
	});

	it('quartiers : orthographe rapprochée du référentiel', () => {
		expect(plan.properties.map((p) => p.data.neighborhoodId)).toEqual([TAMPOUY, PISSY, SOMGANDE]);
		expect(plan.properties.every((p) => p.data.communeId === OUAGA)).toBe(true);
	});
});

describe('mandats', () => {
	it('conditions différentes → un mandat par jeu de conditions', () => {
		const r = registry();
		r.properties = sheet('properties', PROPERTY_H, [
			['B-01', 'P1', 'Villa ou maison', 'Villa', 'Ouagadougou', 'Tampouy', 'Gestion locative', '10 %', '01/01/2020', 'Oui', 'Oui'],
			['B-02', 'P1', 'Cour commune', 'Cour', 'Ouagadougou', 'Pissy', 'Gestion locative', '10 %', '01/01/2020', 'Non', 'Oui'],
			['B-03', 'P1', 'Cour commune', 'Cour 2', 'Ouagadougou', 'Pissy', 'Gestion locative', '10', '1/1/2020', 'non', 'oui']
		]);
		const plan = planImport(r, ctx());
		// Publication autorisée diffère entre B-01 et B-02 ; B-03 a les conditions de B-02, écrites autrement.
		expect(plan.mandates.map((m) => m.propertyRefs)).toEqual([['B-01'], ['B-02', 'B-03']]);
		expect(plan.mandates.map((m) => m.rows)).toEqual([[2], [3, 4]]);
	});

	it('commission obligatoire pour la gestion locative ; montant fixe accepté', () => {
		const r = registry();
		r.properties = sheet('properties', [...PROPERTY_H, 'Commission (FCFA)', 'Base de la commission'], [
			['B-01', 'P1', 'Villa ou maison', 'Villa', 'Ouagadougou', 'Tampouy', 'Gestion locative', '', '01/01/2020', 'Non', 'Oui', '', ''],
			['B-02', 'P1', 'Cour commune', 'Cour', 'Ouagadougou', 'Pissy', 'Gestion locative', '', '01/01/2020', 'Non', 'Oui', '20 000', 'Montant fixe par mois'],
			['B-03', 'P2', 'Villa ou maison', 'Villa 2', 'Ouagadougou', 'Pissy', 'Gestion locative', '', '01/01/2020', 'Non', 'Oui', '15 000', '']
		]);
		const plan = planImport(r, ctx());
		expect(errors(plan)).toContain('Ligne 2 de Biens, colonne Commission (%) : indiquez la commission du mandat (en % ou en FCFA).');
		expect(plan.mandates.find((m) => m.propertyRefs.includes('B-02'))!.terms.commission).toEqual({ basis: 'fixed_per_month', amount: 20000 });
		// Montant sans base : montant fixe par mois.
		expect(plan.mandates.find((m) => m.propertyRefs.includes('B-03'))!.terms.commission).toEqual({ basis: 'fixed_per_month', amount: 15000 });
	});

	it('un bail importé exige un mandat de gestion locative', () => {
		const r = registry();
		r.properties = sheet('properties', PROPERTY_H, [
			['B-01', 'P1', 'Villa ou maison', 'Villa', 'Ouagadougou', 'Tampouy', 'Mise en location', '10', '01/01/2020', 'Oui', 'Oui'],
			['B-02', 'P1', 'Cour commune', 'Cour', 'Ouagadougou', 'Pissy', 'Gestion locative', '10', '01/01/2020', 'Non', 'Oui'],
			['B-03', 'P2', 'Villa ou maison', 'Villa 2', 'Ouagadougou', 'Pissy', 'Gestion locative', '10', '01/01/2020', 'Non', 'Non']
		]);
		const plan = planImport(r, ctx());
		expect(errors(plan)).toContain(
			'Ligne 2 de Baux, colonne Unité : le bien B-01 est sous mandat de mise en location ; un bail exige un mandat de gestion locative.'
		);
		expect(plan.leases.map((l) => l.unitRef)).toEqual(['B-02-1', 'B-03-A1']);
	});

	it('bailleur particulier : gestion directe, aucune colonne de mandat, l’organisation bailleur et détentrice', () => {
		const plan = planImport(
			{
				properties: sheet('properties', ['Référence du bien', 'Type de bien', 'Nom du bien'], [['B-01', 'Villa ou maison', 'Ma villa']], 'landlord'),
				units: sheet('units', UNIT_H, [['U1', 'B-01', 'Villa', 'Villa', 3, '100000', '']], 'landlord'),
				tenants: sheet('tenants', TENANT_H, [['L1', '', 'Kaboré Issouf', '70123456']], 'landlord'),
				leases: sheet('leases', LEASE_H, [['U1', 'L1', '01/01/2024', '', '', '100000', '', '']], 'landlord'),
				deposits: sheet('deposits', DEPOSIT_H.slice(0, 5), [['U1', 'Caution', '200000', '', '']], 'landlord')
			},
			ctx({ organizationType: 'landlord' })
		);
		expect(errors(plan)).toEqual([]);
		expect(plan.mandates).toEqual([]);
		expect(plan.owners).toEqual([]);
		expect(plan.properties[0]!.ownerRef).toBeNull();
		expect(plan.leases[0]!.terms.lessorType).toBe('organization');
		expect(plan.deposits[0]!.holder).toBe('organization');
	});
});

describe('lignes en erreur, écartées en cascade (ajout 3 du porteur)', () => {
	it('message : la ligne, la colonne et quoi corriger', () => {
		const r = registry();
		r.tenants = sheet('tenants', TENANT_H, [
			['L1', 'M.', 'Kaboré Issouf', '70 12 34 5'],
			['L2', 'Mme', 'Traoré Awa', '76543210'],
			['L3', 'M.', 'Zongo Paul', '65432109']
		]);
		const plan = planImport(r, ctx());
		expect(errors(plan)).toContain('Ligne 2 de Locataires, colonne Téléphone : 8 chiffres attendus, par exemple 70 12 34 56.');
	});

	it('une unité en erreur écarte son bail, puis la caution et le solde de ce bail', () => {
		const r = registry();
		r.units = sheet('units', UNIT_H, [
			['B-01-A', 'B-01', 'Palais', 'Villa', 3, '150 000', ''],
			['B-02-1', 'B-02', 'Chambre-salon', 'Chambre 1', 1, '35000', ''],
			['B-02-2', 'B-02', 'Chambre-salon', 'Chambre 2', 1, '35000', ''],
			['B-03-A1', 'B-03', 'Appartement', 'Appartement A1', 2, 90000, '']
		]);
		const plan = planImport(r, ctx());
		expect(errors(plan)[0]).toMatch(/^Ligne 2 de Unités, colonne Type d’unité : valeur de la liste attendue : Chambre-salon, /);
		const cascade = plan.issues.filter((i) => i.code === 'DEPENDENCY_REJECTED').map((i) => i.message);
		expect(plan.issues.filter((i) => i.code === 'DEPENDENCY_REJECTED').every((i) => i.severity === 'skipped')).toBe(true);
		expect(cascade).toEqual([
			'Ligne 2 de Baux écartée : l’unité B-01-A est en erreur (Unités, ligne 2).',
			'Ligne 2 de Cautions écartée : le bail B-01-A est écarté (Baux, ligne 2).',
			'Ligne 2 de Soldes d’ouverture écartée : le bail B-01-A est écarté (Baux, ligne 2).'
		]);
		expect(plan.leases.map((l) => l.unitRef)).toEqual(['B-02-1', 'B-03-A1']);
		expect(plan.deposits.map((d) => d.leaseRef)).toEqual(['B-02-1']);
		expect(plan.openingBalances).toEqual([]);
	});

	it('un propriétaire en erreur écarte ses biens, leurs unités et tout ce qui en dépend', () => {
		const r = registry();
		r.owners = sheet('owners', OWNER_H, [
			['P1', 'Personne', 'Ouédraogo Mariam', '', '', ''],
			['P2', 'Société', 'SCI Wend Panga', '+226 25 30 40 50', '', ''],
			['P3', 'Indivision', 'Héritiers Sawadogo', '76 00 11 22', '', '']
		]);
		const plan = planImport(r, ctx());
		expect(errors(plan)).toEqual([
			'Ligne 2 de Propriétaires, colonne Téléphone : à remplir.',
			'Ligne 4 de Propriétaires, colonne Représentant (nom) : indiquez le représentant du groupe d’indivisaires (nom et téléphone).'
		]);
		expect(plan.properties.map((p) => p.ref)).toEqual(['B-03']);
		expect(plan.units.map((u) => u.ref)).toEqual(['B-03-A1']);
		expect(plan.leases.map((l) => l.unitRef)).toEqual(['B-03-A1']);
		expect(plan.issues.find((i) => i.code === 'DEPENDENCY_REJECTED' && i.sheet === 'properties')!.message).toBe(
			'Ligne 2 de Biens écartée : le propriétaire P1 est en erreur (Propriétaires, ligne 2).'
		);
	});

	it('référence inconnue : nommée, avec l’onglet où l’ajouter', () => {
		const r = registry();
		r.leases = sheet('leases', LEASE_H, [['B-09', 'L1', '01/03/2021', '', '', '150000', '', '']]);
		const plan = planImport(r, ctx());
		expect(errors(plan)).toContain('Ligne 2 de Baux, colonne Unité : l’unité B-09 n’existe pas dans l’onglet Unités.');
	});

	it('colonne obligatoire vide', () => {
		const r = registry();
		r.leases = sheet('leases', LEASE_H, [['B-01-A', 'L1', '', '', '', '150000', '', '']]);
		expect(errors(planImport(r, ctx()))).toContain('Ligne 2 de Baux, colonne Date d’entrée : à remplir.');
	});

	it('les lignes vides sont ignorées, sans décaler les numéros', () => {
		const r = registry();
		r.tenants = sheet('tenants', TENANT_H, [
			['L1', 'M.', 'Kaboré Issouf', '70123456'],
			[null, '', '', ''],
			['L2', 'Mme', 'Traoré Awa', '7654321'],
			['L3', 'M.', 'Zongo Paul', '65432109']
		]);
		expect(errors(planImport(r, ctx()))).toContain('Ligne 4 de Locataires, colonne Téléphone : 8 chiffres attendus, par exemple 70 12 34 56.');
	});
});

describe('baux : bascule et règles des réponses du porteur', () => {
	const lease = (row: CellValue[]) => {
		const r = registry();
		r.leases = sheet('leases', LEASE_H, [row]);
		r.deposits = sheet('deposits', DEPOSIT_H, []);
		r.opening_balances = sheet('opening_balances', BALANCE_H, []);
		return planImport(r, ctx());
	};

	it('bail à durée déterminée échu sans congé : importé à durée indéterminée, date de fin d’origine gardée (réponse 3)', () => {
		const plan = lease(['B-01-A', 'L1', '01/03/2021', '28/02/2024', '', '150000', '', '']);
		expect(plan.leases[0]!.terms).toMatchObject({ endsOn: null, durationMonths: null, renewalMode: 'open_ended' });
		expect(plan.leases[0]!.originalEndsOn).toBe('2024-02-28');
		expect(warnings(plan)).toContain(
			'Ligne 2 de Baux, colonne Date de fin : bail échu le 28/02/2024 sans congé ; importé à durée indéterminée, la date de fin est gardée pour information.'
		);
	});

	it('bail à durée déterminée en cours : gardé tel quel', () => {
		const plan = lease(['B-01-A', 'L1', '01/03/2025', '28/02/2027', '', '150000', '', '']);
		expect(plan.leases[0]!.terms.endsOn).toBe('2027-02-28');
		expect(plan.leases[0]!.originalEndsOn).toBeNull();
	});

	it('bail terminé : ignoré, avec une ligne au rapport (réponse 5) ; sa caution et son solde aussi', () => {
		const r = registry();
		r.leases = sheet('leases', LEASE_H, [['B-01-A', 'L1', '01/03/2021', '', '31/08/2025', '150000', '', '']]);
		const plan = planImport(r, ctx());
		expect(plan.leases).toEqual([]);
		expect(plan.issues.filter((i) => i.code === 'LEASE_ENDED').map((i) => i.message)).toEqual([
			'Ligne 2 de Baux ignorée : bail terminé le 31/08/2025 ; l’historique n’est pas importé.'
		]);
		expect(plan.deposits).toEqual([]);
		expect(plan.issues.find((i) => i.sheet === 'deposits' && i.row === 2)).toMatchObject({
			severity: 'skipped',
			message: 'Ligne 2 de Cautions ignorée : le bail B-01-A est terminé (Baux, ligne 2).'
		});
		expect(errors(plan)).toContain('Ligne 3 de Cautions, colonne Bail ou unité : aucun bail importé sur l’unité B-02-1.');
		// Le solde d'ouverture de B-01-A suit son bail ignoré, sans erreur.
		expect(plan.openingBalances).toEqual([]);
		expect(plan.issues.find((i) => i.sheet === 'opening_balances')!.message).toBe(
			'Ligne 2 de Soldes d’ouverture ignorée : le bail B-01-A est terminé (Baux, ligne 2).'
		);
	});

	it('avance remplie sur un bail commencé avant la bascule : ignorée avec un avertissement (réponse 4)', () => {
		const plan = lease(['B-01-A', 'L1', '01/03/2021', '', '', '150000', '', '2']);
		expect(plan.leases[0]!.terms.advanceMonths).toBe(0);
		expect(warnings(plan)).toContain('Ligne 2 de Baux, colonne Avance (mois) : sans objet pour un bail commencé avant la bascule ; ignorée.');
	});

	it('bail commencé entre la bascule et aujourd’hui : facturé depuis son début', () => {
		const plan = lease(['B-01-A', 'L1', '10/11/2026', '', '', '150000', '', '']);
		expect(plan.leases[0]!.status).toBe('active');
		expect(plan.leases[0]!.terms.duesStartOn).toBeNull();
	});

	it('facturation à la date anniversaire : première période qui commence à la bascule ou après', () => {
		const r = registry();
		r.leases = sheet('leases', LEASE_H, [['B-01-A', 'L1', '15/03/2021', '', '', '150000', '', '']]);
		const plan = planImport(r, ctx({ billingMode: 'anniversary' }));
		expect(plan.leases[0]!.terms.duesStartOn).toBe('2026-11-15');
	});

	it('un seul bail en vigueur par unité dans le fichier (règle 8)', () => {
		const r = registry();
		r.leases = sheet('leases', LEASE_H, [
			['B-01-A', 'L1', '01/03/2021', '', '', '150000', '', ''],
			['B-01-A', 'L2', '01/06/2022', '', '', '150000', '', '']
		]);
		expect(errors(planImport(r, ctx()))).toContain(
			'Ligne 3 de Baux, colonne Unité : l’unité B-01-A a déjà un bail en vigueur (Baux, ligne 2) ; un seul bail en vigueur par unité.'
		);
	});

	it('un bail en vigueur et un bail réservé sur la même unité : le solde vise le bail en vigueur', () => {
		const r = registry();
		r.leases = sheet('leases', LEASE_H, [
			['B-01-A', 'L1', '01/03/2021', '', '', '150000', '', ''],
			['B-01-A', 'L2', '01/01/2027', '', '', '150000', '', '']
		]);
		r.deposits = sheet('deposits', DEPOSIT_H, []);
		const plan = planImport(r, ctx());
		expect(errors(plan)).toEqual([]);
		expect(plan.leases.map((l) => l.status)).toEqual(['active', 'signed']);
		expect(plan.openingBalances[0]!.leaseRef).toBe(plan.leases[0]!.ref);
	});

	it('locataire désigné par son nom : deux fiches de même nom, la référence est demandée', () => {
		const r = registry();
		r.tenants = sheet('tenants', TENANT_H, [
			['L1', 'M.', 'Kaboré Issouf', '70123456'],
			['L2', 'M.', 'Kaboré Issouf', '76543210'],
			['L3', 'M.', 'Zongo Paul', '65432109']
		]);
		r.leases = sheet('leases', LEASE_H, [['B-01-A', 'Kabore Issouf', '01/03/2021', '', '', '150000', '', '']]);
		expect(errors(planImport(r, ctx()))).toContain(
			'Ligne 2 de Baux, colonne Locataire : deux locataires s’appellent Kabore Issouf (Locataires, lignes 2 et 3) ; indiquez la référence du locataire.'
		);
	});
});

describe('soldes d’ouverture et cautions (réponses 2 et 6)', () => {
	it('solde négatif refusé, avec le message du porteur', () => {
		const r = registry();
		r.opening_balances = sheet('opening_balances', BALANCE_H, [['B-01-A', '-25 000']]);
		expect(errors(planImport(r, ctx()))).toContain(
			'Ligne 2 de Soldes d’ouverture, colonne Montant dû à la bascule (FCFA) : saisissez 0 et notez l’avance sur la fiche du locataire.'
		);
	});

	it('solde nul : rien n’est créé', () => {
		const r = registry();
		r.opening_balances = sheet('opening_balances', BALANCE_H, [['B-01-A', '0']]);
		const plan = planImport(r, ctx());
		expect(plan.openingBalances).toEqual([]);
		expect(plan.summary.leasesWithOpeningBalance).toBe(0);
	});

	it('solde sur un bail qui commence après la bascule : refusé', () => {
		const r = registry();
		r.opening_balances = sheet('opening_balances', BALANCE_H, [['B-03-A1', '10000']]);
		expect(errors(planImport(r, ctx()))).toContain(
			'Ligne 2 de Soldes d’ouverture, colonne Bail ou unité : ce bail commence après la bascule (01/11/2026) ; il n’a pas de solde antérieur.'
		);
	});

	it('montant reçu supérieur au montant convenu : refusé ; date du versement future : refusée', () => {
		const r = registry();
		r.deposits = sheet('deposits', DEPOSIT_H, [
			['B-01-A', 'Caution', '300000', '350000', '', ''],
			['B-02-1', 'Caution', '70000', '70000', '01/12/2026', '']
		]);
		const plan = planImport(r, ctx());
		expect(errors(plan)).toContain(
			`Ligne 2 de Cautions, colonne Montant reçu (FCFA) : le montant reçu dépasse le montant convenu (${formatFcfa(300000)}).`
		);
		expect(errors(plan)).toContain('Ligne 3 de Cautions, colonne Date du versement : la date du versement est dans le futur.');
	});

	it('caution au-delà de deux mois du loyer actuel : avertissement (D15), jamais un blocage', () => {
		const r = registry();
		r.deposits = sheet('deposits', DEPOSIT_H, [['B-01-A', 'Caution', '450 000', '', '', '']]);
		const plan = planImport(r, ctx());
		expect(plan.deposits).toHaveLength(1);
		expect(plan.summary.depositsAboveCap).toBe(1);
		expect(warnings(plan).some((w) => w.startsWith('Ligne 2 de Cautions, colonne Montant convenu (FCFA) : caution supérieure à deux mois de loyer'))).toBe(true);
	});

	it('garantie des factures : jamais comptée dans le seuil de deux mois', () => {
		const r = registry();
		r.deposits = sheet('deposits', DEPOSIT_H, [['B-01-A', 'Garantie des factures', '450 000', '', '', '']]);
		const plan = planImport(r, ctx());
		expect(plan.deposits[0]!.type).toBe('utilities_guarantee');
		expect(plan.summary.depositsAboveCap).toBe(0);
	});

	it('montant reçu nul : compte de caution sans versement', () => {
		const r = registry();
		r.deposits = sheet('deposits', DEPOSIT_H, [['B-01-A', 'Caution', '300000', '0', '', '']]);
		expect(planImport(r, ctx()).deposits[0]).toMatchObject({ receivedAmount: 0, receivedOn: null });
	});

	it('deux cautions de même nature sur un bail : la seconde refusée', () => {
		const r = registry();
		r.deposits = sheet('deposits', DEPOSIT_H, [
			['B-01-A', 'Caution', '300000', '', '', ''],
			['B-01-A', 'Caution', '300000', '', '', '']
		]);
		expect(errors(planImport(r, ctx()))).toContain('Ligne 3 de Cautions, colonne Bail ou unité : ce bail a déjà une caution (Cautions, ligne 2).');
	});
});

describe('doublons et rapprochements (prompt §2.3, réponse 8)', () => {
	it('dans le fichier : même numéro et même nom → une seule fiche, les baux la partagent', () => {
		const r = registry();
		r.tenants = sheet('tenants', TENANT_H, [
			['L1', 'M.', 'Kaboré Issouf', '70123456'],
			['L2', 'Mme', 'Traoré Awa', '76543210'],
			['L3', 'M.', 'Zongo Paul', '65432109'],
			['L4', 'M.', 'KABORE Issouf', '70 12 34 56']
		]);
		r.leases = sheet('leases', LEASE_H, [
			['B-01-A', 'L1', '01/03/2021', '', '', '150000', '', ''],
			['B-02-1', 'L4', '01/03/2021', '', '', '35000', '', '']
		]);
		const plan = planImport(r, ctx());
		expect(plan.tenants).toHaveLength(3);
		expect(plan.leases[1]!.tenantKey).toBe(plan.leases[0]!.tenantKey);
		expect(warnings(plan)).toContain('Ligne 5 de Locataires : même nom et même téléphone que la ligne 2 ; une seule fiche est créée.');
	});

	it('dans le fichier : même numéro, noms différents → deux fiches, avec un avertissement', () => {
		const r = registry();
		r.tenants = sheet('tenants', TENANT_H, [
			['L1', 'M.', 'Kaboré Issouf', '70123456'],
			['L2', 'Mme', 'Kaboré Aminata', '70 12 34 56'],
			['L3', 'M.', 'Zongo Paul', '65432109']
		]);
		const plan = planImport(r, ctx());
		expect(plan.tenants).toHaveLength(3);
		expect(warnings(plan)).toContain(
			'Ligne 3 de Locataires, colonne Téléphone : même téléphone que Kaboré Issouf (ligne 2) ; deux fiches sont créées (colocataires, famille).'
		);
	});

	it('avec une fiche existante : même nom et même téléphone → la fiche existante est proposée, et retenue par défaut', () => {
		const existing = { id: 'tenant-1', fullName: 'Kaboré Issouf', phone: '+22670123456' };
		const plan = planImport(registry(), ctx({ existing: { ...ctx().existing, tenants: [existing] } }));
		expect(plan.matches).toEqual([
			{ sheet: 'tenants', row: 2, key: 'tenants:2', existingId: 'tenant-1', existingName: 'Kaboré Issouf', chosen: 'existing' }
		]);
		expect(plan.tenants[0]!.existingId).toBe('tenant-1');
		expect(warnings(plan)).toContain('Ligne 2 de Locataires : « Kaboré Issouf » existe déjà avec ce numéro ; la fiche existante sera utilisée.');
	});

	it('la personne peut choisir de créer une nouvelle fiche', () => {
		const existing = { id: 'tenant-1', fullName: 'Kaboré Issouf', phone: '+22670123456' };
		const plan = planImport(
			registry(),
			ctx({ existing: { ...ctx().existing, tenants: [existing] }, choices: { matches: { 'tenants:2': null } } })
		);
		expect(plan.tenants[0]!.existingId).toBeNull();
		expect(plan.matches[0]!.chosen).toBe('new');
	});

	it('avec une fiche existante : même numéro, autre nom → nouvelle fiche, avertissement', () => {
		const existing = { id: 'tenant-1', fullName: 'Ilboudo Marc', phone: '+22670123456' };
		const plan = planImport(registry(), ctx({ existing: { ...ctx().existing, tenants: [existing] } }));
		expect(plan.matches).toEqual([]);
		expect(plan.tenants[0]!.existingId).toBeNull();
		expect(warnings(plan)).toContain('Ligne 2 de Locataires, colonne Téléphone : une autre fiche porte déjà ce numéro (Ilboudo Marc).');
	});

	it('propriétaire existant : même rapprochement', () => {
		const existing = { id: 'owner-1', name: 'Ouédraogo Mariam', phone: '+22670112233' };
		const plan = planImport(registry(), ctx({ existing: { ...ctx().existing, owners: [existing] } }));
		expect(plan.owners[0]!.existingId).toBe('owner-1');
		expect(plan.matches.map((m) => m.key)).toEqual(['owners:2']);
	});

	it('référence d’unité en double : la seconde ligne refusée', () => {
		const r = registry();
		r.units = sheet('units', UNIT_H, [
			['B-01-A', 'B-01', 'Villa', 'Villa', 3, '150 000', ''],
			['B-01-A', 'B-02', 'Chambre-salon', 'Chambre 1', 1, '35000', '']
		]);
		expect(errors(planImport(r, ctx()))).toContain(
			'Ligne 3 de Unités, colonne Référence de l’unité : la référence B-01-A est déjà utilisée (Unités, ligne 2).'
		);
	});
});

describe('quartiers : référentiel du lot 07, suggestions, jamais créés (réponse 7 du plan)', () => {
	const withPlaces = (places: [string, string][], over: Partial<ImportContext> = {}) => {
		const r = registry();
		r.properties = sheet(
			'properties',
			PROPERTY_H,
			places.map(([commune, nb], i) => [`B-0${i + 1}`, 'P1', 'Villa ou maison', `Bien ${i + 1}`, commune, nb, 'Gestion locative', '10', '01/01/2020', 'Non', 'Oui'])
		);
		r.units = sheet('units', UNIT_H, []);
		r.leases = sheet('leases', LEASE_H, []);
		r.deposits = sheet('deposits', DEPOSIT_H, []);
		r.opening_balances = sheet('opening_balances', BALANCE_H, []);
		return planImport(r, ctx(over));
	};

	it('orthographe proche : suggestions classées, bien importé sans quartier tant que rien n’est choisi', () => {
		const plan = withPlaces([
			['Ouagadougou', 'Tampoui'],
			['ouaga', 'Tampoui']
		]);
		const place = plan.places.find((p) => p.neighborhood === 'Tampoui')!;
		expect(place.status).toBe('unresolved');
		expect(place.suggestions.map((s) => s.id)).toEqual([TAMPOUY]);
		expect(plan.properties[0]!.data.neighborhoodId).toBeNull();
		expect(warnings(plan)).toContain(
			'Ligne 2 de Biens, colonne Quartier : quartier « Tampoui » inconnu à Ouagadougou ; choisissez-le dans les suggestions, sinon le bien est importé sans quartier.'
		);
	});

	it('une correction choisie une fois vaut pour toutes les lignes de même orthographe', () => {
		const first = withPlaces([
			['Ouagadougou', 'Tampoui'],
			['Ouagadougou', 'tampoui ']
		]);
		const key = first.places.find((p) => p.neighborhood === 'Tampoui')!.key;
		expect(first.places.filter((p) => p.status === 'unresolved')).toHaveLength(1);
		const plan = withPlaces(
			[
				['Ouagadougou', 'Tampoui'],
				['Ouagadougou', 'tampoui ']
			],
			{ choices: { places: { [key]: TAMPOUY } } }
		);
		expect(plan.properties.map((p) => p.data.neighborhoodId)).toEqual([TAMPOUY, TAMPOUY]);
		expect(plan.places.find((p) => p.key === key)!.status).toBe('corrected');
	});

	it('espaces et tirets ne comptent pas : « Ouaga2000 » est « Ouaga 2000 »', () => {
		expect(withPlaces([['Ouagadougou', 'Ouaga2000']]).properties[0]!.data.neighborhoodId).toBe('nb-ouaga2000');
	});

	it('commune absente : le quartier est cherché dans toutes les communes', () => {
		const plan = withPlaces([['', 'Pissy']]);
		expect(plan.properties[0]!.data).toMatchObject({ communeId: OUAGA, neighborhoodId: PISSY });
	});

	it('une correction ne peut viser qu’un quartier du référentiel', () => {
		const first = withPlaces([['Ouagadougou', 'Tampoui']]);
		const key = first.places[0]!.key;
		const plan = withPlaces([['Ouagadougou', 'Tampoui']], { choices: { places: { [key]: 'nb-invente' } } });
		expect(plan.properties[0]!.data.neighborhoodId).toBeNull();
		expect(plan.places[0]!.status).toBe('unresolved');
	});
});
