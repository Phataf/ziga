/**
 * Import Excel (lot 11) : le modèle téléchargeable (onglets, colonnes, listes déroulantes, aide de la notice) et la
 * reconnaissance d'un classeur rempli (onglets par leur nom, colonnes par leurs en-têtes, dans n'importe quel ordre).
 *
 * - Agence : sept onglets ; le mandat va dans l'onglet Biens (règle 12, plan validé).
 * - Bailleur particulier : pas d'onglet Propriétaires ni de mandat (gestion directe), ni bailleur désigné, ni
 *   détenteur de caution : c'est lui (`allowedLessorTypes`, `allowedDepositHolders`).
 * - L'occupation d'une unité n'est jamais une colonne : elle se calcule à partir des baux (règle 13).
 *
 * Les textes du modèle sont ceux d'un document produit par la plateforme, comme ceux des reçus : ils vivent ici.
 */
import { labelKey, type CellValue, type ImportChoice } from './import-values.js';
import type { OrganizationType } from './permissions.js';

export const IMPORT_SHEET_KEYS = ['owners', 'properties', 'units', 'tenants', 'leases', 'deposits', 'opening_balances'] as const;
export type ImportSheetKey = (typeof IMPORT_SHEET_KEYS)[number];

export const IMPORT_SHEET_NAMES: Record<ImportSheetKey, string> = {
	owners: 'Propriétaires',
	properties: 'Biens',
	units: 'Unités',
	tenants: 'Locataires',
	leases: 'Baux',
	deposits: 'Cautions',
	opening_balances: 'Soldes d’ouverture'
};

export type ImportFieldKind = 'text' | 'reference' | 'amount' | 'phone' | 'date' | 'integer' | 'percent' | 'boolean' | 'choice';

export interface ImportField {
	key: string;
	header: string;
	/** En-têtes courants des registres, reconnus en plus de celui du modèle. */
	aliases?: readonly string[];
	required: boolean;
	kind: ImportFieldKind;
	choices?: readonly ImportChoice[];
	/** Bornes d'un nombre entier. */
	min?: number;
	max?: number;
	/** Longueur maximale d'un texte. */
	maxLength?: number;
	/** Aide affichée dans la notice. */
	help: string;
	/** Valeur de la ligne d'exemple. */
	example?: string | number;
}

export interface ImportSheetDefinition {
	key: ImportSheetKey;
	name: string;
	help: string;
	fields: ImportField[];
}

// ---------------------------------------------------------------- listes

export const OWNER_TYPE_CHOICES: readonly ImportChoice[] = [
	{ value: 'person', label: 'Personne', aliases: ['Particulier', 'Personne physique'] },
	{ value: 'company', label: 'Société', aliases: ['Entreprise', 'SARL', 'SA', 'SCI', 'Personne morale'] },
	{ value: 'group', label: 'Groupe d’indivisaires', aliases: ['Indivision', 'Indivisaires', 'Héritiers', 'Famille'] }
];

export const PROPERTY_TYPE_CHOICES: readonly ImportChoice[] = [
	{ value: 'house', label: 'Villa ou maison', aliases: ['Villa', 'Maison'] },
	{ value: 'apartment_building', label: 'Immeuble d’appartements', aliases: ['Immeuble'] },
	{ value: 'shared_compound', label: 'Cour commune', aliases: ['Cour'] },
	{ value: 'commercial', label: 'Local commercial', aliases: ['Commerce', 'Boutiques', 'Magasin'] },
	{ value: 'land', label: 'Terrain', aliases: ['Parcelle'] }
];

export const UNIT_TYPE_CHOICES: readonly ImportChoice[] = [
	{ value: 'room_lounge', label: 'Chambre-salon', aliases: ['Chambre salon'] },
	{ value: 'single_room', label: 'Entrée-couchée', aliases: ['Entrée couchée', 'Chambre'] },
	{ value: 'celibatorium', label: 'Célibatorium' },
	{ value: 'studio', label: 'Studio' },
	{ value: 'apartment', label: 'Appartement', aliases: ['Appart'] },
	{ value: 'mini_villa', label: 'Mini-villa', aliases: ['Mini villa'] },
	{ value: 'villa', label: 'Villa', aliases: ['Maison'] },
	{ value: 'duplex', label: 'Duplex' },
	{ value: 'shop', label: 'Boutique' },
	{ value: 'office', label: 'Bureau' },
	{ value: 'store', label: 'Magasin' },
	{ value: 'warehouse', label: 'Entrepôt' },
	{ value: 'other', label: 'Autre' }
];

export const TECHNICAL_STATUS_CHOICES: readonly ImportChoice[] = [
	{ value: 'ready', label: 'Prête', aliases: ['Prêt', 'Bon état'] },
	{ value: 'to_refurbish', label: 'À remettre en état', aliases: ['A remettre en etat', 'À rénover'] },
	{ value: 'under_works', label: 'En travaux', aliases: ['Travaux'] },
	{ value: 'unavailable', label: 'Indisponible' }
];

/** Mandats qu'une agence crée (`self_managed` est réservé au bailleur particulier). */
export const MANDATE_TYPE_CHOICES: readonly ImportChoice[] = [
	{ value: 'rental_management', label: 'Gestion locative', aliases: ['Gestion'] },
	{ value: 'letting', label: 'Mise en location', aliases: ['Location seule'] },
	{ value: 'sale', label: 'Vente' },
	{ value: 'other', label: 'Autre mandat', aliases: ['Autre'] }
];

export const COMMISSION_BASIS_CHOICES: readonly ImportChoice[] = [
	{ value: 'percent_of_collected', label: 'Pourcentage des loyers encaissés', aliases: ['Pourcentage', '%'] },
	{ value: 'fixed_per_month', label: 'Montant fixe par mois', aliases: ['Fixe par mois', 'Forfait mensuel'] },
	{ value: 'fixed_per_operation', label: 'Montant fixe par opération', aliases: ['Fixe par opération'] }
];

export const CIVILITY_CHOICES: readonly ImportChoice[] = [
	{ value: 'mr', label: 'M.', aliases: ['M', 'Monsieur', 'Mr'] },
	{ value: 'mrs', label: 'Mme', aliases: ['Madame'] },
	{ value: 'miss', label: 'Mlle', aliases: ['Mademoiselle'] }
];

export const LESSOR_CHOICES: readonly ImportChoice[] = [
	{ value: 'owner', label: 'Le propriétaire', aliases: ['Propriétaire'] },
	{ value: 'organization', label: 'L’agence', aliases: ['Agence', 'L’organisation', 'Organisation'] }
];

export const RENEWAL_CHOICES: readonly ImportChoice[] = [
	{ value: 'open_ended', label: 'Durée indéterminée', aliases: ['Passage à durée indéterminée', 'Indéterminée'] },
	{ value: 'same_duration', label: 'Reconduction pour la même durée', aliases: ['Reconduction'] }
];

export const PENALTY_BENEFICIARY_CHOICES: readonly ImportChoice[] = [
	{ value: 'organization', label: 'L’agence', aliases: ['Agence'] },
	{ value: 'owner', label: 'Le propriétaire', aliases: ['Propriétaire'] }
];

export const DEPOSIT_TYPE_CHOICES: readonly ImportChoice[] = [
	{ value: 'security_deposit', label: 'Caution', aliases: ['Dépôt de garantie'] },
	{ value: 'utilities_guarantee', label: 'Garantie des factures', aliases: ['Garantie eau électricité', 'Garantie SONABEL ONEA'] }
];

export const DEPOSIT_HOLDER_CHOICES: readonly ImportChoice[] = [
	{ value: 'organization', label: 'L’agence', aliases: ['Agence'] },
	{ value: 'owner', label: 'Le propriétaire', aliases: ['Propriétaire'] }
];

const YES_NO: readonly ImportChoice[] = [
	{ value: 'yes', label: 'Oui' },
	{ value: 'no', label: 'Non' }
];

// ---------------------------------------------------------------- onglets

type Audience = 'agency' | 'landlord' | 'both';
type FieldSpec = ImportField & { for?: Audience };

const yesNo = (key: string, header: string, help: string): FieldSpec => ({
	key,
	header,
	required: false,
	kind: 'boolean',
	choices: YES_NO,
	help,
	example: 'Non',
	for: 'agency'
});

const SHEETS: { key: ImportSheetKey; for: Audience; help: Record<'agency' | 'landlord', string>; fields: FieldSpec[] }[] = [
	{
		key: 'owners',
		for: 'agency',
		help: {
			agency:
				'Une ligne par propriétaire. La référence sert à le désigner dans l’onglet Biens. Un groupe d’indivisaires a un représentant (nom et téléphone).',
			landlord: ''
		},
		fields: [
			{
				key: 'ref',
				header: 'Référence',
				aliases: ['Code', 'Code propriétaire', 'N°'],
				required: true,
				kind: 'reference',
				maxLength: 40,
				help: 'Code libre, unique dans l’onglet.',
				example: 'P1'
			},
			{
				key: 'type',
				header: 'Forme',
				aliases: ['Type', 'Type de propriétaire'],
				required: true,
				kind: 'choice',
				choices: OWNER_TYPE_CHOICES,
				help: 'Personne, société ou groupe d’indivisaires.',
				example: 'Personne'
			},
			{
				key: 'name',
				header: 'Nom ou raison sociale',
				aliases: ['Nom', 'Propriétaire', 'Nom du propriétaire', 'Raison sociale'],
				required: true,
				kind: 'text',
				maxLength: 120,
				help: 'Nom et prénoms, ou raison sociale.',
				example: 'Ouédraogo Mariam'
			},
			{
				key: 'phone',
				header: 'Téléphone',
				aliases: ['Tél', 'Tel', 'Contact', 'Numéro'],
				required: true,
				kind: 'phone',
				help: '8 chiffres pour un numéro du Burkina, sinon avec l’indicatif (+33…).',
				example: '70 11 22 33'
			},
			{
				key: 'email',
				header: 'E-mail',
				aliases: ['Email', 'Courriel', 'Mail'],
				required: false,
				kind: 'text',
				maxLength: 254,
				help: 'Facultatif.'
			},
			{ key: 'address', header: 'Adresse', required: false, kind: 'text', maxLength: 200, help: 'Facultatif.' },
			{
				key: 'representativeName',
				header: 'Représentant (nom)',
				aliases: ['Représentant'],
				required: false,
				kind: 'text',
				maxLength: 120,
				help: 'Seulement pour un groupe d’indivisaires.'
			},
			{
				key: 'representativePhone',
				header: 'Représentant (téléphone)',
				aliases: ['Téléphone du représentant'],
				required: false,
				kind: 'phone',
				help: 'Seulement pour un groupe d’indivisaires.'
			},
			{
				key: 'notes',
				header: 'Notes',
				aliases: ['Observations', 'Remarques'],
				required: false,
				kind: 'text',
				maxLength: 2000,
				help: 'Notes internes, jamais publiées.'
			}
		]
	},
	{
		key: 'properties',
		for: 'both',
		help: {
			agency:
				'Une ligne par bien, avec le mandat qui vous en confie la gestion. Les biens d’un même propriétaire aux mêmes conditions forment un seul mandat. Un bail importé exige un mandat de gestion locative.',
			landlord: 'Une ligne par bien. Vous gérez vous-même vos biens : aucun mandat à renseigner.'
		},
		fields: [
			{
				key: 'ref',
				header: 'Référence du bien',
				aliases: ['Référence', 'Code bien', 'Code'],
				required: true,
				kind: 'reference',
				maxLength: 40,
				help: 'Code libre, unique dans l’onglet ; il sert à désigner le bien dans l’onglet Unités.',
				example: 'B-01'
			},
			{
				key: 'ownerRef',
				header: 'Propriétaire',
				aliases: ['Référence du propriétaire', 'Code propriétaire'],
				required: true,
				kind: 'reference',
				maxLength: 120,
				help: 'Référence ou nom du propriétaire, tel qu’il figure dans l’onglet Propriétaires.',
				example: 'P1',
				for: 'agency'
			},
			{
				key: 'type',
				header: 'Type de bien',
				aliases: ['Type'],
				required: true,
				kind: 'choice',
				choices: PROPERTY_TYPE_CHOICES,
				help: 'Villa ou maison, immeuble, cour commune, local commercial ou terrain.',
				example: 'Villa ou maison'
			},
			{
				key: 'name',
				header: 'Nom du bien',
				aliases: ['Nom', 'Désignation', 'Bien'],
				required: true,
				kind: 'text',
				maxLength: 120,
				help: 'Pour vous retrouver (« Villa Tampouy ») ; jamais publié.',
				example: 'Villa Tampouy'
			},
			{
				key: 'commune',
				header: 'Commune',
				aliases: ['Ville'],
				required: false,
				kind: 'text',
				maxLength: 120,
				help: 'Ouagadougou ou Saaba.',
				example: 'Ouagadougou'
			},
			{
				key: 'neighborhood',
				header: 'Quartier',
				aliases: ['Secteur', 'Zone'],
				required: false,
				kind: 'text',
				maxLength: 120,
				help: 'Nom du quartier ; une orthographe proche est rapprochée du référentiel, avec des suggestions.',
				example: 'Tampouy'
			},
			{
				key: 'addressHint',
				header: 'Indication d’adresse',
				aliases: ['Adresse', 'Repère', 'Localisation'],
				required: false,
				kind: 'text',
				maxLength: 300,
				help: 'Repère pour trouver le bien.'
			},
			{
				key: 'mandateType',
				header: 'Type de mandat',
				aliases: ['Mandat'],
				required: true,
				kind: 'choice',
				choices: MANDATE_TYPE_CHOICES,
				help: 'Gestion locative pour un bien dont vous gérez les baux.',
				example: 'Gestion locative',
				for: 'agency'
			},
			{
				key: 'commissionRate',
				header: 'Commission (%)',
				aliases: ['Commission', 'Taux de commission', 'Taux'],
				required: false,
				kind: 'percent',
				help: 'Pourcentage des loyers encaissés, par exemple 10 %.',
				example: '10 %',
				for: 'agency'
			},
			{
				key: 'commissionAmount',
				header: 'Commission (FCFA)',
				aliases: ['Montant de la commission'],
				required: false,
				kind: 'amount',
				help: 'Commission en montant fixe, à la place du pourcentage.',
				for: 'agency'
			},
			{
				key: 'commissionBasis',
				header: 'Base de la commission',
				aliases: ['Base'],
				required: false,
				kind: 'choice',
				choices: COMMISSION_BASIS_CHOICES,
				help: 'Pour un montant fixe : par mois (par défaut) ou par opération.',
				for: 'agency'
			},
			{
				key: 'mandateStartsOn',
				header: 'Début du mandat',
				aliases: ['Date du mandat', 'Date de début du mandat'],
				required: true,
				kind: 'date',
				help: 'Date jj/mm/aaaa.',
				example: '01/01/2020',
				for: 'agency'
			},
			{
				key: 'mandateEndsOn',
				header: 'Fin du mandat',
				aliases: ['Date de fin du mandat'],
				required: false,
				kind: 'date',
				help: 'Facultatif ; vide pour un mandat sans date de fin.',
				for: 'agency'
			},
			yesNo(
				'canPublish',
				'Publication autorisée',
				'Le propriétaire autorise la publication des logements libres (Oui ou Non, Non par défaut).'
			),
			yesNo('canTakePhotos', 'Prises de vue autorisées', 'Photos du bien autorisées (Oui ou Non, Non par défaut).'),
			yesNo(
				'canCollectFunds',
				'Encaissement par l’agence',
				'L’agence encaisse les loyers et détient la caution, sauf indication contraire (Oui ou Non, Non par défaut).'
			),
			yesNo(
				'canSignLeases',
				'Signature des baux par l’agence',
				'L’agence signe les baux au nom du propriétaire (Oui ou Non, Non par défaut).'
			),
			{
				key: 'notes',
				header: 'Notes',
				aliases: ['Observations', 'Remarques'],
				required: false,
				kind: 'text',
				maxLength: 2000,
				help: 'Notes internes, jamais publiées.'
			}
		]
	},
	{
		key: 'units',
		for: 'both',
		help: {
			agency:
				'Une ligne par logement ou local. N’indiquez pas s’il est libre ou loué : c’est calculé à partir des baux. Un logement sans bail importé est « à remettre en état » tant que vous ne l’avez pas vérifié.',
			landlord:
				'Une ligne par logement ou local. N’indiquez pas s’il est libre ou loué : c’est calculé à partir des baux. Un logement sans bail importé est « à remettre en état » tant que vous ne l’avez pas vérifié.'
		},
		fields: [
			{
				key: 'ref',
				header: 'Référence de l’unité',
				aliases: ['Référence', 'Code unité', 'Code', 'N° logement'],
				required: true,
				kind: 'reference',
				maxLength: 40,
				help: 'Code libre, unique dans l’onglet ; il sert à désigner l’unité dans l’onglet Baux.',
				example: 'B-01-A'
			},
			{
				key: 'propertyRef',
				header: 'Bien',
				aliases: ['Référence du bien', 'Code bien'],
				required: true,
				kind: 'reference',
				maxLength: 40,
				help: 'Référence du bien dans l’onglet Biens.',
				example: 'B-01'
			},
			{
				key: 'type',
				header: 'Type d’unité',
				aliases: ['Type', 'Type de logement'],
				required: true,
				kind: 'choice',
				choices: UNIT_TYPE_CHOICES,
				help: 'Chambre-salon, entrée-couchée, appartement, villa, boutique…',
				example: 'Villa'
			},
			{
				key: 'label',
				header: 'Libellé',
				aliases: ['Désignation', 'Nom', 'Logement'],
				required: true,
				kind: 'text',
				maxLength: 80,
				help: '« Appartement A2 », « Boutique 1 »…',
				example: 'Villa'
			},
			{
				key: 'bedrooms',
				header: 'Chambres',
				aliases: ['Nombre de chambres', 'Nb chambres'],
				required: false,
				kind: 'integer',
				min: 0,
				max: 50,
				help: 'Nombre entier.'
			},
			{
				key: 'livingRooms',
				header: 'Salons',
				aliases: ['Nombre de salons'],
				required: false,
				kind: 'integer',
				min: 0,
				max: 50,
				help: 'Nombre entier.'
			},
			{
				key: 'bathrooms',
				header: 'Salles de bain',
				aliases: ['Douches'],
				required: false,
				kind: 'integer',
				min: 0,
				max: 50,
				help: 'Nombre entier.'
			},
			{
				key: 'rent',
				header: 'Loyer (FCFA)',
				aliases: ['Loyer', 'Loyer demandé', 'Prix'],
				required: false,
				kind: 'amount',
				help: 'Loyer demandé pour ce logement.',
				example: '150 000'
			},
			{
				key: 'charges',
				header: 'Charges (FCFA)',
				aliases: ['Charges'],
				required: false,
				kind: 'amount',
				help: 'Charges mensuelles, s’il y en a.'
			},
			{
				key: 'technicalStatus',
				header: 'État technique',
				aliases: ['État'],
				required: false,
				kind: 'choice',
				choices: TECHNICAL_STATUS_CHOICES,
				help: 'Prête, à remettre en état, en travaux ou indisponible. Vide : « prête » s’il a un bail importé, sinon « à remettre en état ».'
			},
			{
				key: 'technicalReason',
				header: 'Motif de l’état',
				aliases: ['Motif'],
				required: false,
				kind: 'text',
				maxLength: 500,
				help: 'Pour un état autre que « prête ».'
			}
		]
	},
	{
		key: 'tenants',
		for: 'both',
		help: {
			agency:
				'Une ligne par locataire. Une même personne écrite deux fois (même nom, même téléphone) devient une seule fiche ; des personnes différentes qui partagent un numéro gardent chacune la leur.',
			landlord:
				'Une ligne par locataire. Une même personne écrite deux fois (même nom, même téléphone) devient une seule fiche ; des personnes différentes qui partagent un numéro gardent chacune la leur.'
		},
		fields: [
			{
				key: 'ref',
				header: 'Référence du locataire',
				aliases: ['Référence', 'Code locataire', 'Code'],
				required: false,
				kind: 'reference',
				maxLength: 40,
				help: 'Facultatif ; sinon, désignez le locataire par son nom dans l’onglet Baux.',
				example: 'L1'
			},
			{
				key: 'civility',
				header: 'Civilité',
				aliases: ['Titre'],
				required: false,
				kind: 'choice',
				choices: CIVILITY_CHOICES,
				help: 'M., Mme ou Mlle.',
				example: 'M.'
			},
			{
				key: 'fullName',
				header: 'Nom et prénoms',
				aliases: ['Nom', 'Locataire', 'Nom du locataire', 'Nom complet'],
				required: true,
				kind: 'text',
				maxLength: 120,
				help: 'Nom et prénoms.',
				example: 'Kaboré Issouf'
			},
			{
				key: 'phone',
				header: 'Téléphone',
				aliases: ['Tél', 'Tel', 'Contact', 'Numéro', 'Téléphone 1'],
				required: false,
				kind: 'phone',
				help: 'Un seul numéro par cellule.',
				example: '70 12 34 56'
			},
			{
				key: 'secondaryPhone',
				header: 'Téléphone 2',
				aliases: ['Tél 2', 'Tel 2', 'Autre téléphone'],
				required: false,
				kind: 'phone',
				help: 'Second numéro, s’il y en a un.'
			},
			{
				key: 'profession',
				header: 'Profession',
				aliases: ['Métier', 'Emploi'],
				required: false,
				kind: 'text',
				maxLength: 80,
				help: 'Facultatif.'
			},
			{ key: 'nationality', header: 'Nationalité', required: false, kind: 'text', maxLength: 60, help: 'Facultatif.' },
			{
				key: 'emergencyContactName',
				header: 'Personne à prévenir',
				aliases: ['Contact d’urgence'],
				required: false,
				kind: 'text',
				maxLength: 120,
				help: 'Facultatif.'
			},
			{
				key: 'emergencyContactPhone',
				header: 'Téléphone de la personne à prévenir',
				aliases: ['Téléphone d’urgence'],
				required: false,
				kind: 'phone',
				help: 'Facultatif.'
			},
			{
				key: 'notes',
				header: 'Notes',
				aliases: ['Observations', 'Remarques'],
				required: false,
				kind: 'text',
				maxLength: 2000,
				help: 'Notes internes. Notez ici une avance versée par le locataire.'
			}
		]
	},
	{
		key: 'leases',
		for: 'both',
		help: {
			agency:
				'Une ligne par bail en cours ou signé. Un bail terminé (date de sortie passée) est ignoré : l’historique n’est pas importé. Les échéances sont générées à partir de la date de bascule ; ce qui était dû avant va dans l’onglet Soldes d’ouverture. Les paramètres laissés vides prennent les valeurs prévues par la loi.',
			landlord:
				'Une ligne par bail en cours ou signé. Un bail terminé (date de sortie passée) est ignoré : l’historique n’est pas importé. Les échéances sont générées à partir de la date de bascule ; ce qui était dû avant va dans l’onglet Soldes d’ouverture. Les paramètres laissés vides prennent les valeurs prévues par la loi.'
		},
		fields: [
			{
				key: 'ref',
				header: 'Référence du bail',
				aliases: ['Code bail', 'N° bail'],
				required: false,
				kind: 'reference',
				maxLength: 40,
				help: 'Facultatif ; sinon le bail est désigné par son unité dans les onglets Cautions et Soldes d’ouverture.'
			},
			{
				key: 'unitRef',
				header: 'Unité',
				aliases: ['Référence de l’unité', 'Code unité', 'Logement'],
				required: true,
				kind: 'reference',
				maxLength: 40,
				help: 'Référence de l’unité dans l’onglet Unités.',
				example: 'B-01-A'
			},
			{
				key: 'tenant',
				header: 'Locataire',
				aliases: ['Référence du locataire', 'Nom du locataire'],
				required: true,
				kind: 'reference',
				maxLength: 120,
				help: 'Référence ou nom du locataire, tel qu’il figure dans l’onglet Locataires.',
				example: 'L1'
			},
			{
				key: 'startsOn',
				header: 'Date d’entrée',
				aliases: ['Début du bail', 'Date de début', 'Entrée', 'Date d’effet'],
				required: true,
				kind: 'date',
				help: 'Date jj/mm/aaaa.',
				example: '01/03/2021'
			},
			{
				key: 'endsOn',
				header: 'Date de fin',
				aliases: ['Fin du bail', 'Échéance du bail'],
				required: false,
				kind: 'date',
				help: 'Pour un bail à durée déterminée. Échue sans congé : le bail est importé à durée indéterminée.'
			},
			{
				key: 'durationMonths',
				header: 'Durée (mois)',
				aliases: ['Durée'],
				required: false,
				kind: 'integer',
				min: 1,
				max: 600,
				help: 'À la place de la date de fin.'
			},
			{
				key: 'exitOn',
				header: 'Date de sortie',
				aliases: ['Sortie', 'Date de départ'],
				required: false,
				kind: 'date',
				help: 'Date de départ du locataire ; un bail terminé est ignoré.'
			},
			{
				key: 'rent',
				header: 'Loyer mensuel (FCFA)',
				aliases: ['Loyer', 'Loyer actuel', 'Montant du loyer'],
				required: true,
				kind: 'amount',
				help: 'Loyer actuel, hors charges.',
				example: '150 000'
			},
			{
				key: 'charges',
				header: 'Charges mensuelles (FCFA)',
				aliases: ['Charges'],
				required: false,
				kind: 'amount',
				help: 'Charges mensuelles, s’il y en a.'
			},
			{
				key: 'dueDay',
				header: 'Jour d’échéance',
				aliases: ['Jour de paiement'],
				required: false,
				kind: 'integer',
				min: 1,
				max: 28,
				help: 'Le 5 du mois par défaut.'
			},
			{
				key: 'lessorType',
				header: 'Bailleur désigné',
				aliases: ['Bailleur'],
				required: false,
				kind: 'choice',
				choices: LESSOR_CHOICES,
				help: 'Le propriétaire, représenté par l’agence (par défaut), ou l’agence en son nom.',
				for: 'agency'
			},
			{
				key: 'advanceMonths',
				header: 'Avance (mois)',
				aliases: ['Avance', 'Mois d’avance'],
				required: false,
				kind: 'integer',
				min: 0,
				max: 24,
				help: 'Seulement pour un bail qui commence après la date de bascule.'
			},
			{
				key: 'noticeTenantMonths',
				header: 'Préavis du locataire (mois)',
				aliases: ['Préavis locataire'],
				required: false,
				kind: 'integer',
				min: 0,
				max: 12,
				help: 'Par défaut, selon la loi : 2 mois en durée déterminée, 3 mois en durée indéterminée.'
			},
			{
				key: 'noticeLessorMonths',
				header: 'Préavis du bailleur (mois)',
				aliases: ['Préavis bailleur'],
				required: false,
				kind: 'integer',
				min: 0,
				max: 12,
				help: 'Par défaut, selon la loi : 3 mois.'
			},
			{
				key: 'renewalMode',
				header: 'À l’échéance',
				aliases: ['Reconduction'],
				required: false,
				kind: 'choice',
				choices: RENEWAL_CHOICES,
				help: 'Durée indéterminée par défaut, selon la loi.'
			},
			{
				key: 'penaltyRate',
				header: 'Pénalité de retard (%)',
				aliases: ['Pénalité'],
				required: false,
				kind: 'percent',
				help: 'Aucune par défaut. Avec le délai de grâce et le bénéficiaire.'
			},
			{
				key: 'penaltyGraceDays',
				header: 'Délai de grâce (jours)',
				required: false,
				kind: 'integer',
				min: 0,
				max: 365,
				help: 'Avec la pénalité.'
			},
			{
				key: 'penaltyBeneficiary',
				header: 'Bénéficiaire de la pénalité',
				required: false,
				kind: 'choice',
				choices: PENALTY_BENEFICIARY_CHOICES,
				help: 'Avec la pénalité.',
				for: 'agency'
			},
			{
				key: 'depositRefundDays',
				header: 'Délai de restitution de la caution (jours)',
				aliases: ['Délai de restitution'],
				required: false,
				kind: 'integer',
				min: 0,
				max: 365,
				help: '30 jours par défaut, selon la loi.'
			}
		]
	},
	{
		key: 'deposits',
		for: 'both',
		help: {
			agency:
				'Une ligne par caution ou garantie des factures déjà convenue. Montant reçu vide : versé en entier ; inférieur au montant convenu : la différence reste à recevoir. Aucun reçu n’est émis pour une caution reçue avant l’import.',
			landlord:
				'Une ligne par caution ou garantie des factures déjà convenue. Montant reçu vide : versé en entier ; inférieur au montant convenu : la différence reste à recevoir. Aucun reçu n’est émis pour une caution reçue avant l’import.'
		},
		fields: [
			{
				key: 'lease',
				header: 'Bail ou unité',
				aliases: ['Unité', 'Bail', 'Référence du bail', 'Logement'],
				required: true,
				kind: 'reference',
				maxLength: 40,
				help: 'Référence du bail, ou de son unité.',
				example: 'B-01-A'
			},
			{
				key: 'type',
				header: 'Nature',
				aliases: ['Type'],
				required: false,
				kind: 'choice',
				choices: DEPOSIT_TYPE_CHOICES,
				help: 'Caution (par défaut) ou garantie des factures.',
				example: 'Caution'
			},
			{
				key: 'agreedAmount',
				header: 'Montant convenu (FCFA)',
				aliases: ['Caution', 'Montant de la caution', 'Montant'],
				required: true,
				kind: 'amount',
				help: 'Montant prévu au bail.',
				example: '300 000'
			},
			{
				key: 'receivedAmount',
				header: 'Montant reçu (FCFA)',
				aliases: ['Reçu', 'Versé', 'Montant versé'],
				required: false,
				kind: 'amount',
				help: 'Vide : versé en entier.'
			},
			{
				key: 'receivedOn',
				header: 'Date du versement',
				aliases: ['Versée le', 'Date de versement'],
				required: false,
				kind: 'date',
				help: 'Vide : date d’entrée du bail.'
			},
			{
				key: 'holder',
				header: 'Détenteur',
				aliases: ['Détenue par', 'Gardée par'],
				required: false,
				kind: 'choice',
				choices: DEPOSIT_HOLDER_CHOICES,
				help: 'Vide : l’agence si elle encaisse les loyers de ce bien, sinon le propriétaire.',
				for: 'agency'
			}
		]
	},
	{
		key: 'opening_balances',
		for: 'both',
		help: {
			agency:
				'Une ligne par bail qui a des loyers ou charges impayés à la date de bascule. Ce montant devient une échéance « Solde antérieur », exigible à la date de bascule, sans reçu. Une avance du locataire ne se saisit pas ici : saisissez 0 et notez-la sur sa fiche.',
			landlord:
				'Une ligne par bail qui a des loyers ou charges impayés à la date de bascule. Ce montant devient une échéance « Solde antérieur », exigible à la date de bascule, sans reçu. Une avance du locataire ne se saisit pas ici : saisissez 0 et notez-la sur sa fiche.'
		},
		fields: [
			{
				key: 'lease',
				header: 'Bail ou unité',
				aliases: ['Unité', 'Bail', 'Référence du bail', 'Logement'],
				required: true,
				kind: 'reference',
				maxLength: 40,
				help: 'Référence du bail, ou de son unité.',
				example: 'B-01-A'
			},
			{
				key: 'amount',
				header: 'Montant dû à la bascule (FCFA)',
				aliases: ['Solde', 'Solde antérieur', 'Arriéré', 'Arriérés', 'Montant dû', 'Reste à payer'],
				required: true,
				kind: 'amount',
				help: 'Loyers et charges impayés avant la date de bascule.',
				example: '150 000'
			}
		]
	}
];

/** Onglets du modèle pour ce type d'organisation, dans l'ordre d'exécution. */
export function importTemplate(type: OrganizationType): ImportSheetDefinition[] {
	return SHEETS.filter((s) => s.for === 'both' || s.for === type).map((s) => sheetFor(s, type));
}

export function importSheet(key: ImportSheetKey, type: OrganizationType): ImportSheetDefinition {
	return sheetFor(
		SHEETS.find((s) => s.key === key)!,
		type
	);
}

function sheetFor(s: (typeof SHEETS)[number], type: OrganizationType): ImportSheetDefinition {
	return {
		key: s.key,
		name: IMPORT_SHEET_NAMES[s.key],
		help: s.help[type],
		fields: s.fields.filter((f) => !f.for || f.for === 'both' || f.for === type).map(({ for: _audience, ...f }) => f)
	};
}

// ---------------------------------------------------------------- reconnaissance d'un classeur

/** Onglet du modèle d'après son nom, sans accents ni casse ; null pour la notice ou un onglet inconnu. */
export function detectImportSheet(name: string): ImportSheetKey | null {
	const key = labelKey(name);
	for (const k of IMPORT_SHEET_KEYS) if (labelKey(IMPORT_SHEET_NAMES[k]) === key) return k;
	const aliases: Record<string, ImportSheetKey> = {
		soldes: 'opening_balances',
		arrieres: 'opening_balances',
		bail: 'leases',
		unites: 'units'
	};
	return aliases[key] ?? null;
}

/** En-tête comparé sans accents, casse ni « * ». */
const headerKey = (header: string) => labelKey(header.replace(/\*/g, ' '));
/** Même chose, sans l'unité entre parenthèses (« Loyer (FCFA) » → « loyer ») : pour les variantes seulement. */
const looseHeaderKey = (header: string) => headerKey(header.replace(/\((fcfa|f|%|mois|jours|m²|m2)\)/gi, ' '));

export interface ColumnMatch {
	/** Champ → indice de colonne (0 = première colonne). */
	columns: Record<string, number>;
	ignored: { index: number; header: string }[];
	/** Champs obligatoires sans colonne. */
	missing: string[];
	duplicates: { field: string; index: number; header: string }[];
}

/**
 * Correspondance automatique des colonnes (prompt §2.2) : en-tête du modèle, puis variantes courantes, dans
 * n'importe quel ordre. Une colonne inconnue est ignorée et nommée ; deux colonnes pour un champ : la première gagne.
 */
export function matchImportColumns(headers: readonly CellValue[], sheet: ImportSheetDefinition): ColumnMatch {
	const columns: Record<string, number> = {};
	const ignored: ColumnMatch['ignored'] = [];
	const duplicates: ColumnMatch['duplicates'] = [];
	const exact = new Map<string, string>();
	const alias = new Map<string, string>();
	const addAlias = (key: string, field: string) => {
		if (!exact.has(key) && !alias.has(key)) alias.set(key, field);
	};
	for (const f of sheet.fields) exact.set(headerKey(f.header), f.key);
	for (const f of sheet.fields) for (const a of f.aliases ?? []) addAlias(headerKey(a), f.key);
	for (const f of sheet.fields) addAlias(looseHeaderKey(f.header), f.key);
	headers.forEach((h, index) => {
		const text = h === null || h === undefined ? '' : String(h).trim();
		if (!text) return;
		const key = headerKey(text);
		const field = exact.get(key) ?? alias.get(key) ?? alias.get(looseHeaderKey(text));
		if (!field) {
			ignored.push({ index, header: text });
			return;
		}
		if (field in columns) duplicates.push({ field, index, header: text });
		else columns[field] = index;
	});
	const missing = sheet.fields.filter((f) => f.required && !(f.key in columns)).map((f) => f.key);
	return { columns, ignored, missing, duplicates };
}

/** Onglet prêt à lire : ses lignes (en-tête comprise, en ligne 1) et la correspondance de ses colonnes. */
export interface ImportSheetInput {
	key: ImportSheetKey;
	rows: CellValue[][];
	columns: Record<string, number>;
}

export interface ColumnIssue {
	sheet: ImportSheetKey;
	kind: 'ignored' | 'missing' | 'duplicate';
	header: string;
	message: string;
}

/** Classeur lu (`{ sheet, data }[]`) → onglets à importer, onglets inconnus et remarques sur les colonnes. */
export function workbookImportSheets(
	workbook: readonly { sheet: string; data: readonly (readonly CellValue[])[] }[],
	type: OrganizationType
): { sheets: Partial<Record<ImportSheetKey, ImportSheetInput>>; unknownSheets: string[]; columnIssues: ColumnIssue[] } {
	const allowed = new Set(importTemplate(type).map((s) => s.key));
	const found = new Map<ImportSheetKey, ImportSheetInput>();
	const unknownSheets: string[] = [];
	const columnIssues: ColumnIssue[] = [];
	for (const { sheet: name, data } of workbook) {
		const key = detectImportSheet(name);
		if (!key || !allowed.has(key) || found.has(key)) {
			if (labelKey(name) !== 'notice' && labelKey(name) !== 'listes') unknownSheets.push(name);
			continue;
		}
		const def = importSheet(key, type);
		const match = matchImportColumns(data[0] ?? [], def);
		found.set(key, { key, rows: data.map((r) => [...r]), columns: match.columns });
		for (const i of match.ignored) {
			columnIssues.push({
				sheet: key,
				kind: 'ignored',
				header: i.header,
				message: `${def.name} : la colonne « ${i.header} » ne correspond à aucun champ ; elle est ignorée.`
			});
		}
		for (const d of match.duplicates) {
			columnIssues.push({
				sheet: key,
				kind: 'duplicate',
				header: d.header,
				message: `${def.name} : la colonne « ${d.header} » répète un champ déjà lu ; elle est ignorée.`
			});
		}
		for (const m of match.missing) {
			const header = def.fields.find((f) => f.key === m)!.header;
			columnIssues.push({
				sheet: key,
				kind: 'missing',
				header,
				message: `${def.name} : la colonne obligatoire « ${header} » est absente.`
			});
		}
	}
	const sheets: Partial<Record<ImportSheetKey, ImportSheetInput>> = {};
	for (const k of IMPORT_SHEET_KEYS) if (found.has(k)) sheets[k] = found.get(k)!;
	return { sheets, unknownSheets, columnIssues };
}
