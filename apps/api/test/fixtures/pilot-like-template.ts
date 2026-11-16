/**
 * Modèle SYNTHÉTIQUE de même structure que celui de l'agence pilote (docs/AUDIT.md §C7), versionné à sa place : le
 * modèle réel de l'agence reste hors de git (consigne du porteur). Aucune donnée réelle : textes inventés, balises du
 * catalogue. Même structure : cinq pages (Word inscrit 5 dans docProps/app.xml), l'agence désignée « le Bailleur »,
 * deux dépôts (caution et garantie des factures), intérêt de retard, préavis particuliers, reconduction tacite,
 * tableaux et cases à cocher, mêmes familles de polices (Calibri, Cambria, Times New Roman, Arial).
 */
import { buildDocx, h, p, type DocxBlock, type DocxParagraph } from '../../src/modules/leases/contracts/docx-builder.js';

const CAL = 'Calibri';
const CAM = 'Cambria';
const TNR = 'Times New Roman';
const ARI = 'Arial';

const t = (text: string, font = CAL, extra: Omit<DocxParagraph, 'runs'> = {}): DocxParagraph =>
	p([{ text, font }], { align: 'both', ...extra });
const title = (text: string, extra: Omit<DocxParagraph, 'runs'> = {}): DocxParagraph =>
	p([{ text, font: CAM, bold: true, size: 13 }], extra);
const cell = (text: string, font = ARI): DocxParagraph => p([{ text, font, size: 10 }]);
const box = (label: string, condition: string): DocxParagraph =>
	p([
		{ text: `{#${condition}}`, font: ARI },
		{ checkbox: 'checked' },
		{ text: `{/${condition}}{^${condition}}`, font: ARI },
		{ checkbox: true },
		{ text: `{/${condition}} ${label}`, font: ARI, size: 10 }
	]);

/** Un paragraphe de remplissage réaliste (clauses générales), pour donner à chaque page la densité d'un vrai contrat. */
const filler = (n: number, font = CAL): DocxParagraph[] =>
	Array.from({ length: n }, (_, i) =>
		t(
			`${i + 1}. Le Locataire s’engage à entretenir le logement en bon père de famille, à signaler sans délai toute dégradation au Bailleur, à laisser exécuter les travaux urgents et à permettre la visite des lieux sur rendez-vous, aux heures ouvrables, pendant la durée du préavis.`,
			font
		)
	);

const PAGE_1: DocxBlock[] = [
	p([{ text: 'CONTRAT DE BAIL À USAGE D’HABITATION', font: CAM, bold: true, size: 16 }], { align: 'center', spacingAfter: 12 }),
	t('ENTRE LES SOUSSIGNÉS :', CAL, { spacingAfter: 6 }),
	t(
		'{organisation.raison_sociale}, société immobilière dont le siège est à {organisation.siege}, {organisation.boite_postale}, RCCM {organisation.rccm}, IFU {organisation.ifu}, téléphone {organisation.telephone}, représentée par {representant.nom}, {representant.qualite}, né(e) de nationalité {representant.nationalite}, titulaire de la pièce {representant.piece}, ci-après dénommée « LE BAILLEUR », d’une part ;'
	),
	t('ET'),
	t(
		'{locataire.nom_complet}, né(e) le {locataire.date_naissance} à {locataire.lieu_naissance}, de nationalité {locataire.nationalite}, profession {locataire.profession}, demeurant à {locataire.domicile}, titulaire de la pièce {locataire.piece}, téléphone {locataire.telephone}, ci-après dénommé(e) « LE LOCATAIRE », d’autre part.'
	),
	title('ARTICLE 1 : OBJET ET DÉSIGNATION'),
	t('Le Bailleur donne à bail au Locataire, qui accepte, le logement ci-après désigné, situé à {logement.localisation} :'),
	{
		kind: 'table',
		widths: [3400, 1400, 3400, 1400],
		rows: [
			[cell('Type de logement'), cell('{logement.type}'), cell('Destination'), cell('{logement.destination}')],
			[cell('Chambres'), cell('{logement.chambres}'), cell('Salons'), cell('{logement.salons}')],
			[cell('Cuisines'), cell('{logement.cuisines}'), cell('Salles de bain'), cell('{logement.salles_de_bain}')],
			[cell('Terrasses'), cell('{logement.terrasses}'), cell('Surface'), cell('{logement.surface}')]
		]
	},
	box('Meublé', 'logement.est_meuble'),
	box('Clôturé', 'logement.est_cloture'),
	box('Garage', 'logement.avec_garage'),
	...filler(6)
];

const PAGE_2: DocxBlock[] = [
	title('ARTICLE 2 : DURÉE', { pageBreakBefore: true }),
	t(
		'Le présent bail est consenti pour une durée de {bail.duree} qui commence à courir le {bail.date_debut} pour prendre fin le {bail.date_fin}. À défaut de congé donné dans les formes et délais prévus ci-après, il se renouvelle par tacite reconduction pour une durée égale.',
		TNR
	),
	title('ARTICLE 3 : LOYER'),
	t(
		'Le loyer mensuel est fixé à la somme de {loyer.montant_lettres} ({loyer.montant}), payable d’avance au plus tard le {loyer.jour_limite} de chaque mois, au siège du Bailleur ou par tout moyen convenu, contre quittance.',
		TNR
	),
	t(
		'Passé un délai de {penalite.delai_grace} après la date limite, toute somme due porte intérêt au taux de {penalite.taux} par mois de retard, au profit de {penalite.beneficiaire}.',
		TNR
	),
	...filler(8, TNR)
];

const PAGE_3: DocxBlock[] = [
	title('ARTICLE 4 : DÉPÔTS', { pageBreakBefore: true }),
	t(
		'À la signature du présent contrat, le Locataire verse : une caution de {caution.montant_lettres} ({caution.montant}) ; une somme forfaitaire de {garantie_factures.montant_lettres} ({garantie_factures.montant}) en garantie des factures d’eau et d’électricité restées impayées.'
	),
	t(
		'Ces dépôts ne peuvent en aucun cas servir au paiement des loyers en cours de bail. Ils sont restitués dans un délai maximal de {caution.delai_restitution} après la remise des clés, déduction faite des sommes dues.'
	),
	{
		kind: 'table',
		widths: [6000, 3600],
		rows: [
			[cell('Caution'), cell('{caution.montant}')],
			[cell('Garantie des factures'), cell('{garantie_factures.montant}')],
			[cell('Avance sur loyers'), cell('{avance.montant}')]
		]
	},
	...filler(8)
];

const PAGE_4: DocxBlock[] = [
	title('ARTICLE 5 : PRÉAVIS ET RÉSILIATION', { pageBreakBefore: true }),
	t(
		'Le congé est notifié par lettre recommandée avec accusé de réception ou par acte d’huissier. Le préavis est de {preavis.locataire_duree_determinee} pendant la durée du bail et de {preavis.locataire_duree_indeterminee} au-delà.'
	),
	t(
		'Il est réduit à {preavis.reduit_duree} dans les cas suivants : {preavis.reduit_cas}. Tout départ anticipé sans préavis donne lieu à une indemnité de {preavis.indemnite_duree}.'
	),
	t('Le bail est résilié de plein droit deux mois après un commandement de payer resté sans effet.'),
	...filler(8)
];

const PAGE_5: DocxBlock[] = [
	title('ARTICLE 6 : DISPOSITIONS FINALES', { pageBreakBefore: true }),
	t('Fait à {signature.lieu}, le {signature.date}, en {signature.exemplaires} exemplaires originaux.'),
	{
		kind: 'table',
		widths: [4800, 4800],
		rows: [
			[cell('LE BAILLEUR', CAM), cell('LE LOCATAIRE', CAM)],
			[cell('« Lu et approuvé »'), cell('« Lu et approuvé »')],
			[cell('{representant.nom}, {representant.qualite}'), cell('{locataire.nom_complet}')]
		]
	},
	h('Annexes'),
	t('État des lieux d’entrée ; copie des pièces d’identité.')
];

/** Le modèle synthétique (.docx), avec 5 pages inscrites comme Word le fait à l'enregistrement. */
export function pilotLikeTemplate(): Buffer {
	return buildDocx({
		blocks: [...PAGE_1, ...PAGE_2, ...PAGE_3, ...PAGE_4, ...PAGE_5],
		defaultFont: CAL,
		defaultSize: 11,
		pages: 5,
		title: 'Contrat de bail'
	});
}

/** Polices de même métrique attendues dans le PDF (image Gotenberg 8.40 : fonts-crosextra-*, fonts-liberation). */
export const EXPECTED_PDF_FONTS = ['Carlito', 'Caladea', 'LiberationSerif', 'LiberationSans'];
