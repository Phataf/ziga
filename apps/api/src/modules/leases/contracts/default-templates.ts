/**
 * Modèles de contrat par défaut de la plateforme (D25), pour toute organisation qui n'a pas le sien : bail d'habitation
 * et avenant. Le texte est ici, lisible et relu tel quel par le juriste ; le .docx en est construit à la demande (même
 * texte, mêmes octets). Version et relecture : `PLATFORM_TEMPLATES` (packages/shared/contracts.ts).
 *
 * Le bail suit les douze clauses du prompt du lot 08 bis, dans l'ordre. Conformément à D25, aucune pénalité de retard
 * ni garantie des factures par défaut : leurs sections ne s'affichent que si le bail les prévoit. Les articles cités de
 * la loi n° 103-2015/CNT viennent de docs/AUDIT.md : ils sont À CONFIRMER PAR LE JURISTE avant la première signature
 * réelle (question ouverte de docs/DECISIONS.md, écart noté au journal du lot).
 */
import type { ContractTemplateKind } from '@ziga/shared/contract-fields';
import { buildDocx, h, p, type DocxBlock, type DocxParagraph, type DocxTable } from './docx-builder.js';

/** Titres des douze clauses du bail, dans l'ordre (prompt du lot 08 bis, « Modèle par défaut »). */
export const DEFAULT_LEASE_CLAUSE_TITLES = [
	'Article 1 – Parties',
	'Article 2 – Désignation du logement',
	'Article 3 – Durée et date d’effet',
	'Article 4 – Loyer et modalités de paiement',
	'Article 5 – Dépôt de garantie',
	'Article 6 – États des lieux',
	'Article 7 – Obligations des parties',
	'Article 8 – Sous-location et cession',
	'Article 9 – Congé et préavis',
	'Article 10 – Résiliation et litiges',
	'Article 11 – Légalisation et enregistrement',
	'Article 12 – Signatures'
] as const;

const j = (text: string, extra: Omit<DocxParagraph, 'runs'> = {}) => p(text, { align: 'both', ...extra });

/**
 * Paragraphes rendus seulement si `tag` est vrai : les balises de section sont seules sur leur ligne, et docxtemplater
 * (paragraphLoop) retire alors ces lignes, sans laisser de paragraphe vide quand la section est fausse.
 */
const when = <B extends DocxBlock>(tag: string, ...blocks: B[]): (B | DocxParagraph)[] => [p(`{#${tag}}`), ...blocks, p(`{/${tag}}`)];
const unless = (tag: string, ...blocks: DocxParagraph[]): DocxParagraph[] => [p(`{^${tag}}`), ...blocks, p(`{/${tag}}`)];

/** Case de signature : intitulé, signataire, puis l'espace de la mention manuscrite et de la signature. */
function signatureTable(left: [string, string], right: [string, string], options: { keepWithNext?: boolean } = {}): DocxTable {
	const space = () =>
		p([
			{ text: ' ', lineBreak: true },
			{ text: ' ', lineBreak: true },
			{ text: ' ', lineBreak: true },
			{ text: ' ', lineBreak: true },
			' '
		]);
	const title = (t: string) => p([{ text: t, bold: true }], { align: 'center' });
	return {
		kind: 'table',
		widths: [4800, 4800],
		keepTogether: true,
		...options,
		rows: [
			[title(left[0]), title(right[0])],
			[p(left[1], { align: 'center' }), p(right[1], { align: 'center' })],
			[space(), space()]
		]
	};
}

const LEASE_CLAUSES: DocxBlock[][] = [
	// 1. Parties : bailleur désigné (D24), représentant et qualité, locataire et sa pièce.
	[
		j('Entre les soussignés :'),
		j(
			'{#bailleur.est_organisation}{organisation.raison_sociale} (siège : {organisation.siege}){#organisation.rccm}, RCCM {organisation.rccm}{/organisation.rccm}{#organisation.ifu}, IFU {organisation.ifu}{/organisation.ifu}, téléphone {organisation.telephone}, représentée par {representant.nom}, en sa qualité de {representant.qualite},{/bailleur.est_organisation}{#bailleur.est_proprietaire}{proprietaire.nom}, propriétaire du logement{#proprietaire.adresse}, demeurant à {proprietaire.adresse}{/proprietaire.adresse}, représenté par {organisation.raison_sociale} (siège : {organisation.siege}), {bailleur.mandat}, elle-même représentée par {representant.nom}, en sa qualité de {representant.qualite},{/bailleur.est_proprietaire}'
		),
		j('ci-après dénommé « le Bailleur », d’une part ;'),
		j(
			'Et {locataire.nom_complet}, {locataire.ne} le {locataire.date_naissance} à {locataire.lieu_naissance}{#locataire.nationalite}, de nationalité {locataire.nationalite}{/locataire.nationalite}{#locataire.profession}, {locataire.profession}{/locataire.profession}, titulaire de la pièce d’identité {locataire.piece}{#locataire.telephone}, téléphone {locataire.telephone}{/locataire.telephone},'
		),
		j('ci-après dénommé « le Locataire », d’autre part.'),
		j('Il a été convenu et arrêté ce qui suit, conformément à la loi n° 103-2015/CNT portant bail d’habitation privée au Burkina Faso.')
	],
	// 2. Désignation : adresse, destination (habitation), consistance, meublé ou non.
	[
		j(
			'Le Bailleur donne en location au Locataire, qui accepte, le logement suivant : {logement.type} « {logement.designation} », {logement.bien}. Localisation : {logement.localisation}.'
		),
		j('Destination : {logement.destination}. Le Locataire ne peut en changer l’usage sans l’accord écrit du Bailleur.'),
		j(
			'Consistance : {logement.consistance}{#logement.surface}, d’une surface d’environ {logement.surface}{/logement.surface}.{#logement.equipements} Équipements : {logement.equipements}.{/logement.equipements}'
		),
		j(
			'Le logement est loué {logement.meuble}.{#logement.est_meuble} Un inventaire du mobilier, établi contradictoirement, est annexé au présent contrat.{/logement.est_meuble}'
		)
	],
	// 3. Durée et date d'effet ; à durée déterminée, maintenu au-delà du terme : durée indéterminée (par défaut).
	[
		j(
			'{#bail.duree_determinee}Le présent bail est consenti pour une durée de {bail.duree}, à compter du {bail.date_debut} pour se terminer le {bail.date_fin}.{/bail.duree_determinee}{#bail.duree_indeterminee}Le présent bail est consenti pour une durée indéterminée, à compter du {bail.date_debut}.{/bail.duree_indeterminee}'
		),
		...when(
			'bail.duree_determinee',
			j(
				'{#reconduction.duree_indeterminee}Si, à son terme, aucune des parties n’a donné congé et que le Locataire reste dans les lieux, le bail se poursuit pour une durée indéterminée, aux mêmes conditions.{/reconduction.duree_indeterminee}{#reconduction.meme_duree}Si, à son terme, aucune des parties n’a donné congé, le bail est reconduit pour une durée égale à la durée initiale, aux mêmes conditions.{/reconduction.meme_duree}'
			)
		)
	],
	// 4. Loyer en chiffres et en lettres, jour limite, modalités, reçu de paiement, révision selon la réglementation.
	[
		j(
			'Le loyer mensuel est fixé à {loyer.montant} ({loyer.montant_lettres}){#loyer.avec_charges}, auquel s’ajoutent des charges de {loyer.charges} ({loyer.charges_lettres}), soit un total de {loyer.total} par mois{/loyer.avec_charges}.'
		),
		j(
			'Le loyer est payable d’avance, au plus tard le {loyer.jour_limite} de chaque mois{#loyer.modalites}, {loyer.modalites}{/loyer.modalites}. Un reçu de paiement est remis au Locataire à chaque paiement.'
		),
		...when(
			'loyer.premier_mois_prorata',
			j(
				'Le Locataire entrant en cours de mois, le loyer du {loyer.premier_mois_debut} au {loyer.premier_mois_fin}, calculé au prorata des jours, soit {loyer.premier_mois_montant} ({loyer.premier_mois_lettres}), est dû à la signature{#avance}, en plus de l’avance prévue ci-après{/avance}.'
			)
		),
		...when(
			'avance',
			j(
				'À la signature, le Locataire verse une avance de {avance.mois} de loyer, soit {avance.montant} ({avance.montant_lettres}), imputée sur les premiers loyers. Cette avance est distincte du dépôt de garantie.'
			)
		),
		...when(
			'penalite',
			j(
				'Tout loyer qui n’est pas payé {penalite.delai_grace} après la date limite porte intérêt de retard au taux de {penalite.taux} par mois, au profit de {penalite.beneficiaire}.'
			)
		),
		j('Le loyer ne peut être révisé que dans les conditions prévues par la réglementation en vigueur.')
	],
	// 5. Dépôt de garantie : au plus deux mois ; restitution après l'état des lieux de sortie ; imputation par accord écrit.
	[
		...when(
			'caution',
			j(
				'Le Locataire verse un dépôt de garantie de {caution.montant} ({caution.montant_lettres}){#caution.mois}, soit {caution.mois} de loyer{/caution.mois}. Conformément à la loi (article 26), il ne peut excéder deux mois de loyer. Il garantit le paiement des loyers et des charges et les réparations locatives. Il est détenu par {caution.detenteur}.'
			),
			j(
				'Le dépôt de garantie est restitué dans un délai de {caution.delai_restitution} après la remise des clés et l’état des lieux de sortie, déduction faite des sommes dues par le Locataire et justifiées par le Bailleur. Il ne peut être imputé sur les derniers loyers qu’avec l’accord écrit et daté des deux parties.'
			)
		),
		...unless('caution', j('Aucun dépôt de garantie n’est demandé au Locataire.')),
		...when(
			'garantie_factures',
			j(
				'Le Locataire verse en outre une garantie de {garantie_factures.montant} ({garantie_factures.montant_lettres}) pour les factures d’eau et d’électricité restées impayées à son départ, restituée dans les mêmes conditions que le dépôt de garantie.'
			)
		)
	],
	// 6. États des lieux d'entrée et de sortie, écrits, contradictoires, datés, signés ; inventaire pour un meublé.
	[
		j(
			'Un état des lieux d’entrée et un état des lieux de sortie sont établis par écrit, contradictoirement, datés et signés par les deux parties (articles 8 et 9 de la loi). Ils décrivent pièce par pièce l’état du logement et de ses équipements, sans formule générale.'
		),
		...when('logement.est_meuble', j('L’inventaire du mobilier est vérifié à l’entrée et à la sortie, dans les mêmes formes.'))
	],
	// 7. Obligations ; réparations locatives au locataire (hors usure normale et vétusté), grosses réparations au bailleur.
	[
		j(
			'Le Bailleur délivre un logement en bon état d’usage et de réparation, en assure la jouissance paisible et effectue les grosses réparations.'
		),
		j(
			'Le Locataire paie le loyer et les charges aux termes convenus, use paisiblement du logement suivant sa destination et prend à sa charge les réparations locatives. Il ne répond ni de l’usure normale ni de la vétusté (article 20 de la loi), ni des dégradations dues à un cas de force majeure ou au fait du Bailleur.'
		),
		j('Le Locataire ne peut transformer les lieux sans l’accord écrit du Bailleur.')
	],
	// 8. Sous-location et cession interdites sans accord écrit.
	[j('Le Locataire ne peut ni sous-louer tout ou partie du logement, ni céder le présent bail, sans l’accord écrit du Bailleur.')],
	// 9. Congé et préavis, par écrit, délais légaux selon la partie et le type de bail.
	[
		j(
			'Le congé est donné par écrit, par lettre remise contre décharge, par lettre recommandée avec accusé de réception ou par acte d’huissier. Le délai de préavis court à compter de sa réception.'
		),
		j(
			'Le Locataire respecte un préavis de {preavis.locataire_duree_determinee} pour un bail à durée déterminée et de {preavis.locataire_duree_indeterminee} pour un bail à durée indéterminée. Le Bailleur, dans les cas prévus par la loi, respecte un préavis de {preavis.bailleur} (articles 45 et 46 de la loi).'
		),
		...when(
			'preavis.reduit',
			j('Par exception, le préavis du Locataire est réduit à {preavis.reduit_duree} dans les cas suivants : {preavis.reduit_cas}.')
		),
		...when(
			'preavis.indemnite',
			j(
				'Le Locataire qui quitte les lieux avant le terme sans respecter son préavis verse une indemnité de {preavis.indemnite_duree} de loyer.'
			)
		)
	],
	// 10. Résiliation et litiges : amiable, puis juridiction du lieu du logement.
	[
		j(
			'En cas de manquement grave de l’une des parties à ses obligations, notamment le non-paiement du loyer, le bail peut être résilié dans les conditions prévues par la loi.'
		),
		j(
			'Les parties recherchent d’abord un règlement amiable de tout différend relatif au présent bail. À défaut, le litige est porté devant la juridiction compétente du lieu de situation du logement.'
		)
	],
	// 11. Légalisation à la commune et enregistrement.
	[
		j(
			'Le présent contrat est légalisé auprès de la commune du lieu de situation du logement, puis enregistré auprès des services des impôts (articles 5 et 11 de la loi). Les parties s’engagent à accomplir ou à faciliter ces formalités.',
			// Lié aux signatures : la dernière page porte toujours une clause du contrat, jamais les signatures seules.
			{ keepNext: true }
		)
	],
	// 12. Lieu, date, nombre d'exemplaires, mention manuscrite « lu et approuvé », signatures.
	[
		j('Fait à {signature.lieu}, le {signature.date}, en {signature.exemplaires_texte}.', { keepNext: true }),
		j('Chaque partie fait précéder sa signature de la mention manuscrite « lu et approuvé ».', { keepNext: true }),
		signatureTable(
			[
				'Le Bailleur',
				'{#bailleur.est_organisation}Pour {organisation.raison_sociale}, {representant.nom}{/bailleur.est_organisation}{#bailleur.est_proprietaire}Pour {proprietaire.nom}, {organisation.raison_sociale}, représentée par {representant.nom}{/bailleur.est_proprietaire}'
			],
			['Le Locataire', '{locataire.nom_complet}'],
			{ keepWithNext: true }
		),
		// Propriétaire bailleur dont le mandat ne donne pas le pouvoir de signer : il signe lui-même, sur la même page.
		...when('signature.proprietaire_signe', signatureTable(['Le Propriétaire', '{proprietaire.nom}'], ['', '']))
	]
];

const AMENDMENT_BLOCKS: DocxBlock[] = [
	p('AVENANT N° {avenant.numero} AU CONTRAT DE BAIL D’HABITATION', { style: 'Title' }),
	j('Entre les soussignés :'),
	j(
		'{#bailleur.est_organisation}{organisation.raison_sociale}, représentée par {representant.nom}, en sa qualité de {representant.qualite},{/bailleur.est_organisation}{#bailleur.est_proprietaire}{proprietaire.nom}, propriétaire du logement, représenté par {organisation.raison_sociale}, {bailleur.mandat}, elle-même représentée par {representant.nom}, en sa qualité de {representant.qualite},{/bailleur.est_proprietaire} ci-après « le Bailleur », d’une part ;'
	),
	j('Et {locataire.nom_complet}, titulaire de la pièce d’identité {locataire.piece}, ci-après « le Locataire », d’autre part.'),
	h('Article 1 – Objet'),
	j(
		'Le présent avenant modifie le contrat de bail du logement {logement.type} « {logement.designation} », {logement.bien} ({logement.localisation}), conclu à compter du {bail.date_debut}{#avenant.contrat_initial_date} et signé le {avenant.contrat_initial_date}{/avenant.contrat_initial_date}. Objet : {avenant.objet}.'
	),
	h('Article 2 – Modification'),
	...when(
		'avenant.est_changement_loyer',
		j(
			'À compter du {avenant.date_effet}, le loyer mensuel est fixé à {avenant.nouveau_loyer} ({avenant.nouveau_loyer_lettres}), et les charges à {avenant.nouvelles_charges}. Les échéances déjà émises ne sont pas modifiées.'
		)
	),
	...when(
		'avenant.est_renouvellement',
		j(
			'Le bail est renouvelé à compter du {avenant.date_effet}{#avenant.duree_indeterminee} pour une durée indéterminée{/avenant.duree_indeterminee}{^avenant.duree_indeterminee} jusqu’au {avenant.nouvelle_date_fin}{/avenant.duree_indeterminee}, aux mêmes conditions. Le dépôt de garantie déjà versé reste acquis au bail.'
		)
	),
	...when('avenant.est_autre', j('À compter du {avenant.date_effet} : {avenant.description}')),
	h('Article 3 – Autres clauses'),
	j(
		'Toutes les autres clauses du contrat de bail demeurent inchangées. Le présent avenant en fait partie intégrante ; il est légalisé et enregistré dans les mêmes formes.'
	),
	j(
		'Fait à {signature.lieu}, le {signature.date}, en {signature.exemplaires_texte}, chaque partie faisant précéder sa signature de la mention manuscrite « lu et approuvé ».',
		{ keepNext: true }
	),
	signatureTable(
		[
			'Le Bailleur',
			'{#bailleur.est_organisation}Pour {organisation.raison_sociale}, {representant.nom}{/bailleur.est_organisation}{#bailleur.est_proprietaire}Pour {proprietaire.nom}, {organisation.raison_sociale}, représentée par {representant.nom}{/bailleur.est_proprietaire}'
		],
		['Le Locataire', '{locataire.nom_complet}'],
		{ keepWithNext: true }
	),
	...when('signature.proprietaire_signe', signatureTable(['Le Propriétaire', '{proprietaire.nom}'], ['', '']))
];

function leaseBlocks(): DocxBlock[] {
	const blocks: DocxBlock[] = [p('CONTRAT DE BAIL D’HABITATION', { style: 'Title' })];
	DEFAULT_LEASE_CLAUSE_TITLES.forEach((title, i) => blocks.push(h(title), ...LEASE_CLAUSES[i]!));
	return blocks;
}

/**
 * Pied de page de chaque page (correction b du porteur) : référence du bail, « Page X sur Y » (champs calculés par le
 * traitement de texte), et une ligne de paraphes pour chaque partie.
 */
const FOOTER: DocxParagraph[] = [
	p(
		[
			{ text: 'Bail {bail.reference} – Page ', size: 9 },
			{ field: 'PAGE', size: 9 },
			{ text: ' sur ', size: 9 },
			{ field: 'NUMPAGES', size: 9 },
			{ text: '\u2003\u2003Paraphes : {signature.paraphes}', size: 9 }
		],
		{ align: 'center' }
	)
];

const cache = new Map<ContractTemplateKind, Buffer>();

/** Le .docx du modèle par défaut (construit une fois, puis gardé en mémoire ; toujours les mêmes octets). */
export function defaultTemplate(kind: ContractTemplateKind): Buffer {
	let buffer = cache.get(kind);
	if (!buffer) {
		buffer = buildDocx({
			blocks: kind === 'lease' ? leaseBlocks() : AMENDMENT_BLOCKS,
			defaultFont: 'Times New Roman',
			defaultSize: 11,
			footer: FOOTER,
			title: kind === 'lease' ? 'Contrat de bail d’habitation' : 'Avenant au contrat de bail'
		});
		cache.set(kind, buffer);
	}
	return buffer;
}
