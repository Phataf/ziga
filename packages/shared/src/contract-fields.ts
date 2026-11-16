/**
 * Catalogue des champs des contrats (lot 08 bis, D20, D24, D25, D29) : chaque balise que la plateforme sait remplir
 * dans un modèle Word, avec sa source, son format d'affichage et une valeur d'exemple (aperçu de la mise en place).
 *
 * - Les balises sont en français, telles qu'elles s'écrivent dans le Word : `{locataire.nom}`,
 *   `{loyer.montant_lettres}`. Une section `{#penalite}…{/penalite}` n'est rendue que si sa valeur est vraie (ou un
 *   texte non vide) ; `{^penalite}…{/penalite}`, seulement si elle est fausse.
 * - Les valeurs sont résolues à partir d'une COPIE des données (`ContractData`), prise à la génération : une version
 *   de contrat garde cette copie et ses valeurs, et ne change plus si l'organisation, le propriétaire ou le locataire
 *   sont modifiés ensuite (D29).
 * - « Sans aucun blanc » : toute balise rendue (hors d'une section fausse) doit avoir une valeur ; sinon le contrat ne
 *   peut pas être figé (`blankFields`).
 * - Le texte du modèle reste sous la responsabilité de l'organisation : la plateforme ne vérifie que les valeurs
 *   qu'elle y insère.
 */
import { amountInFrenchWords, dateInFrenchWords, numberInFrenchWords } from './french-words.js';
import type { Civility, LessorType, PenaltyBeneficiary, RenewalMode } from './leases.js';
import { formatFcfa, type Fcfa } from './money.js';
import { ID_DOCUMENT_LABELS, type IdDocumentType } from './organizations.js';
import { formatRateBp, type OwnerType } from './owners.js';
import type { OrganizationType } from './permissions.js';
import { formatPhone } from './phone.js';
import type { Amenity, UnitType, UnitUsage } from './properties.js';
import { endOnFromDuration, generateRentSchedule, type RentBillingMode, type RentPeriodicity } from './rent-schedule.js';

// ---------------------------------------------------------------- données copiées à la génération

export interface ContractIdentityDocument {
	type: IdDocumentType | null;
	typeOther: string | null;
	number: string | null;
	issuedOn: string | null;
	issuedBy: string | null;
}

/** Données de l'organisation, de son représentant et de la version du logo, copiées à l'émission (D29). */
export interface ContractOrganizationData {
	type: OrganizationType;
	legalName: string;
	tradeName: string | null;
	address: string | null;
	commune: string;
	poBox: string | null;
	rccm: string | null;
	ifu: string | null;
	phone: string;
	/** Version du logo au moment de l'émission (le logo entre par l'image du modèle Word, D29). */
	logoId: string | null;
	representative: {
		name: string | null;
		title: string | null;
		profession: string | null;
		address: string | null;
		nationality: string | null;
		identity: ContractIdentityDocument;
	};
}

export interface ContractOwnerData {
	type: OwnerType;
	name: string;
	address: string | null;
	phone: string;
	representativeName: string | null;
}

export interface ContractTenantData {
	civility: Civility | null;
	fullName: string;
	birthDate: string | null;
	birthPlace: string | null;
	nationality: string | null;
	profession: string | null;
	previousAddress: string | null;
	phone: string | null;
	secondaryPhone: string | null;
	identity: ContractIdentityDocument;
}

export interface ContractUnitData {
	type: UnitType;
	label: string;
	usage: UnitUsage;
	furnished: boolean;
	bedrooms: number;
	livingRooms: number;
	kitchens: number;
	bathrooms: number;
	terraces: number;
	laundries: number;
	surfaceM2: number | null;
	landAreaM2: number | null;
	amenities: readonly Amenity[];
	propertyName: string;
	addressHint: string | null;
	neighborhood: string | null;
	commune: string;
}

export interface ContractLeaseData {
	/** Référence courte du bail, imprimée en pied de page (« B-01A2B3C4 »). */
	reference: string;
	startsOn: string;
	endsOn: string | null;
	durationMonths: number | null;
	rent: Fcfa;
	charges: Fcfa;
	dueDay: number;
	paymentTerms: string | null;
	advanceMonths: number;
	lessorType: LessorType;
	penaltyRateBp: number | null;
	penaltyGraceDays: number | null;
	penaltyBeneficiary: PenaltyBeneficiary | null;
	noticeTenantFixedTermMonths: number;
	noticeTenantOpenEndedMonths: number;
	noticeLessorFixedTermMonths: number;
	noticeLessorOpenEndedMonths: number;
	reducedNoticeMonths: number | null;
	reducedNoticeCases: string | null;
	earlyTerminationIndemnityMonths: number | null;
	renewalMode: RenewalMode;
	depositRefundDays: number;
	/** Découpage des périodes, première date facturée, périodicité : le premier mois incomplet (calendar_prorata). */
	billingMode: RentBillingMode;
	periodicity: RentPeriodicity;
	duesStartOn: string;
	/** Version du bail utilisée (contrôle « bail modifié depuis le figement »). */
	version: number;
}

export interface ContractDepositsData {
	/** Caution (compte `security_deposit`) : montant convenu. */
	security: { amount: Fcfa; months: number | null; holder: 'organization' | 'owner' } | null;
	/** Garantie des factures (compte `utilities_guarantee`) : seulement si l'organisation l'a choisie. */
	utilities: { amount: Fcfa } | null;
}

/** Lieu, date et nombre d'exemplaires : saisis à la génération. */
export interface ContractSigningData {
	place: string | null;
	date: string | null;
	copies: number | null;
	/** Parties qui signent et gardent un exemplaire : organisation (ou bailleur) et locataire, propriétaire s'il signe. */
	parties: number;
	/** Le propriétaire, bailleur désigné, signe lui-même (son mandat ne permet pas à l'organisation de signer pour lui). */
	ownerSigns: boolean;
}

export const AMENDMENT_TYPES = ['renewal', 'rent_change', 'other'] as const;
export type AmendmentType = (typeof AMENDMENT_TYPES)[number];

export interface ContractAmendmentData {
	number: number;
	type: AmendmentType;
	effectiveFrom: string;
	description: string | null;
	newRent: Fcfa | null;
	newCharges: Fcfa | null;
	/** Renouvellement : nouvelle date de fin, ou `null` pour un passage à durée indéterminée. */
	newEndsOn: string | null;
	/** Date de signature du contrat initial, s'il a été signé. */
	baseContractSignedOn: string | null;
}

/** Tout ce qu'un contrat peut citer, copié à la génération. */
export interface ContractData {
	organization: ContractOrganizationData;
	/** Propriétaire de l'unité (absent pour un bailleur particulier, qui est lui-même l'organisation). */
	owner: ContractOwnerData | null;
	tenant: ContractTenantData;
	unit: ContractUnitData;
	lease: ContractLeaseData;
	deposits: ContractDepositsData;
	signing: ContractSigningData;
	/** Mandat de gestion qui couvre l'unité : sa date est citée quand le propriétaire est représenté (D24). */
	mandate: { startsOn: string } | null;
	/** Présent seulement pour un avenant. */
	amendment: ContractAmendmentData | null;
}

// ---------------------------------------------------------------- formats d'affichage

const CIVILITY_WORDS: Record<Civility, string> = { mr: 'Monsieur', mrs: 'Madame', miss: 'Mademoiselle' };

const OWNER_TYPE_WORDS: Record<OwnerType, string> = {
	person: 'personne physique',
	company: 'société',
	group: 'indivision'
};

const UNIT_TYPE_WORDS: Record<UnitType, string> = {
	room_lounge: 'chambre-salon',
	single_room: 'entrée-couchée',
	celibatorium: 'célibatorium',
	studio: 'studio',
	apartment: 'appartement',
	mini_villa: 'mini-villa',
	villa: 'villa',
	duplex: 'duplex',
	shop: 'boutique',
	office: 'bureau',
	store: 'magasin',
	warehouse: 'entrepôt',
	other: 'local'
};

const USAGE_WORDS: Record<UnitUsage, string> = {
	residential: 'à usage d’habitation',
	professional: 'à usage professionnel',
	mixed: 'à usage professionnel et d’habitation'
};

const AMENITY_WORDS: Record<Amenity, string> = {
	fence: 'clôture',
	guard: 'gardien',
	separate_water_meter: 'compteur d’eau séparé',
	separate_electricity_meter: 'compteur électrique séparé',
	air_conditioning: 'climatisation',
	fans: 'ventilateurs',
	garage: 'garage',
	running_water: 'eau courante',
	borehole: 'forage',
	water_tower: 'château d’eau',
	equipped_kitchen: 'cuisine équipée',
	generator: 'groupe électrogène',
	indoor_shower: 'douche interne',
	indoor_toilet: 'WC interne',
	paved_road_access: 'accès par une route bitumée',
	yard_or_parking: 'cour ou parking'
};

const RENEWAL_WORDS: Record<RenewalMode, string> = {
	open_ended: 'le bail se poursuit pour une durée indéterminée',
	same_duration: 'le bail est reconduit pour une durée égale à la durée initiale'
};

const BENEFICIARY_WORDS: Record<PenaltyBeneficiary, string> = { organization: 'l’organisation', owner: 'le propriétaire' };

const AMENDMENT_TYPE_WORDS: Record<AmendmentType, string> = {
	renewal: 'renouvellement du bail',
	rent_change: 'modification du loyer',
	other: 'modification du bail'
};

/** « deux (2) mois », « trente (30) jours » : en lettres, puis en chiffres. */
export function countInWords(n: number, singular: string, plural: string = `${singular}s`): string {
	return `${numberInFrenchWords(n)} (${n}) ${n > 1 ? plural : singular}`;
}

/** Pièce d'identité en une ligne : « CNIB n° B1234567, délivrée le 03/02/2021 par ONI ». */
export function identityLine(doc: ContractIdentityDocument): string | null {
	if (!doc.type || !doc.number) return null;
	const kind = doc.type === 'other' ? (doc.typeOther ?? 'Pièce') : ID_DOCUMENT_LABELS[doc.type];
	let line = `${kind} n°\u00a0${doc.number}`;
	if (doc.issuedOn) line += `, délivrée le ${dateInFrenchWords(doc.issuedOn)}`;
	if (doc.issuedBy) line += `${doc.issuedOn ? '' : ', délivrée'} par ${doc.issuedBy}`;
	return line;
}

/** Durée en mois entiers d'un bail à durée déterminée (durée saisie, ou déduite des dates), sinon `null`. */
export function leaseDurationMonths(lease: Pick<ContractLeaseData, 'startsOn' | 'endsOn' | 'durationMonths'>): number | null {
	if (!lease.endsOn) return null;
	if (lease.durationMonths) return lease.durationMonths;
	for (let m = 1; m <= 600; m++) {
		const end = endOnFromDuration(lease.startsOn, m);
		if (end === lease.endsOn) return m;
		if (end > lease.endsOn) return null;
	}
	return null;
}

/** Consistance : « 2 chambres, 1 salon, 1 cuisine, 1 salle de bain ». */
function roomsLine(u: ContractUnitData): string | null {
	const rooms: [number, string, string][] = [
		[u.bedrooms, 'chambre', 'chambres'],
		[u.livingRooms, 'salon', 'salons'],
		[u.kitchens, 'cuisine', 'cuisines'],
		[u.bathrooms, 'salle de bain', 'salles de bain'],
		[u.terraces, 'terrasse', 'terrasses'],
		[u.laundries, 'buanderie', 'buanderies']
	];
	const parts = rooms.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n > 1 ? many : one}`);
	return parts.length ? parts.join(', ') : null;
}

function locationLine(u: ContractUnitData): string {
	return [u.addressHint, u.neighborhood, u.commune].filter((v): v is string => !!v).join(', ');
}

const fcfa = (v: Fcfa | null | undefined) => (v === null || v === undefined ? null : formatFcfa(v));
const words = (v: Fcfa | null | undefined) => (v === null || v === undefined ? null : amountInFrenchWords(v));
/** Dates des documents en toutes lettres (« 1er janvier 2027 ») ; les écrans gardent jj/mm/aaaa. */
const date = (v: string | null | undefined) => (v ? dateInFrenchWords(v) : null);
const months = (v: number | null | undefined) => (v === null || v === undefined ? null : countInWords(v, 'mois', 'mois'));
const orNull = (v: string | null | undefined) => (v ? v : null);
const count = (v: number) => String(v);
const lessorIsOrganization = (d: ContractData) => d.lease.lessorType === 'organization' || !d.owner;
const organizationName = (o: ContractOrganizationData) => o.tradeName ?? o.legalName;
const headOffice = (o: ContractOrganizationData) => [o.address, o.commune].filter((v): v is string => !!v).join(', ');
const representedBy = (o: ContractOrganizationData) =>
	o.representative.name ? [o.representative.name, o.representative.title].filter(Boolean).join(', ') : null;

/** « en vertu du mandat de gestion du 1er janvier 2024 » (D24), ou sans date si le mandat n'est pas connu. */
function mandateClause(d: ContractData): string {
	return d.mandate ? `en vertu du mandat de gestion du ${dateInFrenchWords(d.mandate.startsOn)}` : 'en vertu d’un mandat de gestion';
}

/** « né » ou « née » selon la civilité ; « né(e) » sans civilité. */
function bornWord(c: Civility | null): string {
	return c === 'mr' ? 'né' : c === 'mrs' || c === 'miss' ? 'née' : 'né(e)';
}

/** Préavis du bailleur : « trois (3) mois dans les deux cas » quand les deux durées sont égales. */
function lessorNotice(l: ContractLeaseData): string {
	const fixed = countInWords(l.noticeLessorFixedTermMonths, 'mois', 'mois');
	if (l.noticeLessorFixedTermMonths === l.noticeLessorOpenEndedMonths) return `${fixed} dans les deux cas`;
	return `${fixed} pour un bail à durée déterminée et de ${countInWords(l.noticeLessorOpenEndedMonths, 'mois', 'mois')} pour un bail à durée indéterminée`;
}

/**
 * « trois (3) exemplaires originaux, dont un pour chaque partie et un pour l’enregistrement » : le texte suit le nombre
 * choisi (chaque partie, puis l'enregistrement, tant que les exemplaires suffisent).
 */
function copiesText(signing: ContractSigningData): string | null {
	const c = signing.copies;
	if (!c) return null;
	const base = c === 1 ? 'un (1) exemplaire original' : `${countInWords(c, 'exemplaire')} originaux`;
	if (c >= signing.parties + 1) return `${base}, dont un pour chaque partie et un pour l’enregistrement`;
	if (c >= signing.parties) return `${base}, dont un pour chaque partie`;
	return base;
}

/**
 * Premier mois incomplet en calendar_prorata (entrée en cours de mois) : la même fonction que l'échéancier ; dû à la
 * signature, en plus de l'avance. `null` dans les autres cas.
 */
export function firstPartialMonth(d: Pick<ContractData, 'lease' | 'signing'>): { amount: Fcfa; start: string; end: string } | null {
	const l = d.lease;
	if (l.billingMode !== 'calendar_prorata') return null;
	try {
		const [first] = generateRentSchedule({
			billingMode: l.billingMode,
			periodicity: l.periodicity,
			startOn: l.startsOn,
			endOn: l.endsOn,
			duesStartOn: l.duesStartOn,
			dueDay: l.dueDay,
			advanceMonths: l.advanceMonths,
			activatedOn: d.signing.date ?? l.startsOn,
			rates: [{ effectiveFrom: l.duesStartOn, rent: l.rent, charges: l.charges, version: l.version }],
			until: l.duesStartOn
		});
		return first && first.prorated && first.dueAtSignature && first.periodStart === l.duesStartOn
			? { amount: first.amountDue, start: first.periodStart, end: first.periodEnd }
			: null;
	} catch {
		return null;
	}
}

/** Détenteur du dépôt de garantie, d'après le compte de caution (D15) : l'organisation, ou le propriétaire. */
function depositHolder(d: ContractData): string | null {
	const security = d.deposits.security;
	if (!security) return null;
	if (security.holder === 'owner' && d.owner) return `le propriétaire, ${d.owner.name}`;
	return d.organization.legalName;
}

// ---------------------------------------------------------------- catalogue

export const CONTRACT_FIELD_GROUPS = [
	'organisation',
	'representant',
	'bailleur',
	'proprietaire',
	'locataire',
	'logement',
	'bail',
	'loyer',
	'avance',
	'caution',
	'garantie_factures',
	'penalite',
	'preavis',
	'reconduction',
	'signature',
	'avenant'
] as const;
export type ContractFieldGroup = (typeof CONTRACT_FIELD_GROUPS)[number];

export const CONTRACT_TEMPLATE_KINDS = ['lease', 'amendment'] as const;
export type ContractTemplateKind = (typeof CONTRACT_TEMPLATE_KINDS)[number];

/** Une valeur de champ : un texte (vide : `null`) ou, pour une condition, un booléen. */
export type ContractFieldValue = string | boolean | null;

export interface ContractField {
	/** La balise, telle qu'elle s'écrit dans le Word, sans les accolades. */
	tag: string;
	group: ContractFieldGroup;
	/** Libellé de l'écran de mise en place. */
	label: string;
	/** `text` : une valeur à insérer ; `condition` : une section `{#…}…{/…}` rendue si vraie. */
	kind: 'text' | 'condition';
	/** D'où vient la valeur (affiché à la mise en place). */
	source: string;
	/** Seulement dans un modèle d'avenant (`amendment`) ; sinon dans les deux. */
	amendmentOnly?: boolean;
	resolve: (d: ContractData) => ContractFieldValue;
}

const F = (
	tag: string,
	group: ContractFieldGroup,
	label: string,
	source: string,
	resolve: (d: ContractData) => string | null,
	amendmentOnly = false
): ContractField => ({ tag, group, label, kind: 'text', source, resolve, amendmentOnly });

const C = (
	tag: string,
	group: ContractFieldGroup,
	label: string,
	source: string,
	resolve: (d: ContractData) => boolean,
	amendmentOnly = false
): ContractField => ({ tag, group, label, kind: 'condition', source, resolve, amendmentOnly });

const ORG = 'Paramètres de l’organisation';
const REP = 'Représentant légal (paramètres de l’organisation)';
const OWNER = 'Fiche du propriétaire';
const TENANT = 'Fiche du locataire';
const IDENTITY = 'État civil du locataire';
const UNIT = 'Fiche de l’unité';
const LEASE = 'Bail';
const DEPOSIT = 'Compte de caution du bail';
const SIGNING = 'Saisi à la génération';
const AMENDMENT = 'Avenant';

export const CONTRACT_FIELDS: readonly ContractField[] = [
	// Organisation (lot 03), copiée à l'émission (D29).
	F('organisation.nom', 'organisation', 'Nom (commercial, sinon raison sociale)', ORG, (d) => organizationName(d.organization)),
	F('organisation.raison_sociale', 'organisation', 'Raison sociale', ORG, (d) => d.organization.legalName),
	F('organisation.nom_commercial', 'organisation', 'Nom commercial', ORG, (d) => orNull(d.organization.tradeName)),
	F('organisation.siege', 'organisation', 'Siège (adresse et commune)', ORG, (d) => headOffice(d.organization)),
	F('organisation.adresse', 'organisation', 'Adresse', ORG, (d) => orNull(d.organization.address)),
	F('organisation.commune', 'organisation', 'Commune', ORG, (d) => d.organization.commune),
	F('organisation.boite_postale', 'organisation', 'Boîte postale', ORG, (d) => orNull(d.organization.poBox)),
	F('organisation.rccm', 'organisation', 'RCCM', ORG, (d) => orNull(d.organization.rccm)),
	F('organisation.ifu', 'organisation', 'IFU', ORG, (d) => orNull(d.organization.ifu)),
	F('organisation.telephone', 'organisation', 'Téléphone', ORG, (d) => formatPhone(d.organization.phone)),
	C('organisation.est_agence', 'organisation', 'L’organisation est une agence', ORG, (d) => d.organization.type === 'agency'),

	// Représentant légal de l'organisation.
	F('representant.nom', 'representant', 'Nom', REP, (d) => orNull(d.organization.representative.name)),
	F('representant.qualite', 'representant', 'Qualité (gérant, directeur…)', REP, (d) => orNull(d.organization.representative.title)),
	F('representant.profession', 'representant', 'Profession', REP, (d) => orNull(d.organization.representative.profession)),
	F('representant.domicile', 'representant', 'Domicile', REP, (d) => orNull(d.organization.representative.address)),
	F('representant.nationalite', 'representant', 'Nationalité', REP, (d) => orNull(d.organization.representative.nationality)),
	F('representant.piece', 'representant', 'Pièce d’identité (en une ligne)', REP, (d) =>
		identityLine(d.organization.representative.identity)
	),
	F('representant.piece_numero', 'representant', 'Numéro de la pièce', REP, (d) => orNull(d.organization.representative.identity.number)),
	F('representant.piece_date', 'representant', 'Date de délivrance de la pièce', REP, (d) =>
		date(d.organization.representative.identity.issuedOn)
	),
	F('representant.piece_autorite', 'representant', 'Autorité de délivrance', REP, (d) =>
		orNull(d.organization.representative.identity.issuedBy)
	),

	// Bailleur désigné (D24) : le propriétaire représenté par l'organisation, ou l'organisation en son nom.
	F('bailleur.nom', 'bailleur', 'Nom du bailleur désigné', LEASE, (d) =>
		lessorIsOrganization(d) ? d.organization.legalName : d.owner!.name
	),
	F('bailleur.represente_par', 'bailleur', 'Représenté par (nom et qualité)', LEASE, (d) => representedBy(d.organization)),
	F('bailleur.qualite', 'bailleur', 'Qualité du bailleur', LEASE, (d) =>
		lessorIsOrganization(d)
			? d.organization.type === 'agency'
				? 'agence immobilière, agissant en son nom'
				: 'propriétaire'
			: `propriétaire, représenté par ${d.organization.legalName} ${mandateClause(d)}`
	),
	F('bailleur.mandat', 'bailleur', 'Mandat de gestion (« en vertu du mandat de gestion du … »)', LEASE, (d) => mandateClause(d)),
	C('bailleur.est_organisation', 'bailleur', 'Le bailleur est l’organisation', LEASE, (d) => lessorIsOrganization(d)),
	C('bailleur.est_proprietaire', 'bailleur', 'Le bailleur est le propriétaire représenté', LEASE, (d) => !lessorIsOrganization(d)),

	// Propriétaire (lot 06) : aucune colonne ajoutée.
	F('proprietaire.nom', 'proprietaire', 'Nom ou raison sociale', OWNER, (d) => d.owner?.name ?? null),
	F('proprietaire.type', 'proprietaire', 'Personne, société ou indivision', OWNER, (d) =>
		d.owner ? OWNER_TYPE_WORDS[d.owner.type] : null
	),
	F('proprietaire.adresse', 'proprietaire', 'Adresse', OWNER, (d) => orNull(d.owner?.address)),
	F('proprietaire.telephone', 'proprietaire', 'Téléphone', OWNER, (d) => (d.owner ? formatPhone(d.owner.phone) : null)),
	F('proprietaire.representant', 'proprietaire', 'Représentant de l’indivision', OWNER, (d) => orNull(d.owner?.representativeName)),

	// Locataire (lot 08) ; état civil et pièce : directeur et gestionnaire seulement.
	F('locataire.ne', 'locataire', '« né » ou « née » selon la civilité', TENANT, (d) => bornWord(d.tenant.civility)),
	F('locataire.civilite', 'locataire', 'Civilité (Monsieur, Madame…)', TENANT, (d) =>
		d.tenant.civility ? CIVILITY_WORDS[d.tenant.civility] : null
	),
	F('locataire.nom', 'locataire', 'Nom', TENANT, (d) => d.tenant.fullName),
	F('locataire.nom_complet', 'locataire', 'Civilité et nom', TENANT, (d) =>
		d.tenant.civility ? `${CIVILITY_WORDS[d.tenant.civility]} ${d.tenant.fullName}` : d.tenant.fullName
	),
	F('locataire.date_naissance', 'locataire', 'Date de naissance', IDENTITY, (d) => date(d.tenant.birthDate)),
	F('locataire.lieu_naissance', 'locataire', 'Lieu de naissance', IDENTITY, (d) => orNull(d.tenant.birthPlace)),
	F('locataire.nationalite', 'locataire', 'Nationalité', TENANT, (d) => orNull(d.tenant.nationality)),
	F('locataire.profession', 'locataire', 'Profession', TENANT, (d) => orNull(d.tenant.profession)),
	F('locataire.domicile', 'locataire', 'Domicile actuel', TENANT, (d) => orNull(d.tenant.previousAddress)),
	F('locataire.telephone', 'locataire', 'Téléphone', TENANT, (d) => (d.tenant.phone ? formatPhone(d.tenant.phone) : null)),
	F('locataire.telephone_2', 'locataire', 'Second téléphone', TENANT, (d) =>
		d.tenant.secondaryPhone ? formatPhone(d.tenant.secondaryPhone) : null
	),
	F('locataire.piece', 'locataire', 'Pièce d’identité (en une ligne)', IDENTITY, (d) => identityLine(d.tenant.identity)),
	F('locataire.piece_type', 'locataire', 'Type de pièce', IDENTITY, (d) =>
		d.tenant.identity.type
			? d.tenant.identity.type === 'other'
				? orNull(d.tenant.identity.typeOther)
				: ID_DOCUMENT_LABELS[d.tenant.identity.type]
			: null
	),
	F('locataire.piece_numero', 'locataire', 'Numéro de la pièce', IDENTITY, (d) => orNull(d.tenant.identity.number)),
	F('locataire.piece_date', 'locataire', 'Date de délivrance', IDENTITY, (d) => date(d.tenant.identity.issuedOn)),
	F('locataire.piece_autorite', 'locataire', 'Autorité de délivrance', IDENTITY, (d) => orNull(d.tenant.identity.issuedBy)),

	// Logement (lot 07). La clôture et le garage viennent des équipements (une seule source).
	F('logement.designation', 'logement', 'Libellé de l’unité', UNIT, (d) => d.unit.label),
	F('logement.bien', 'logement', 'Nom du bien', UNIT, (d) => d.unit.propertyName),
	F('logement.type', 'logement', 'Type (villa, appartement…)', UNIT, (d) => UNIT_TYPE_WORDS[d.unit.type]),
	F('logement.destination', 'logement', 'Destination (à usage d’habitation…)', UNIT, (d) => USAGE_WORDS[d.unit.usage]),
	F('logement.meuble', 'logement', '« meublé » ou « non meublé »', UNIT, (d) => (d.unit.furnished ? 'meublé' : 'non meublé')),
	C('logement.est_meuble', 'logement', 'Le logement est meublé', UNIT, (d) => d.unit.furnished),
	F('logement.consistance', 'logement', 'Pièces (« 2 chambres, 1 salon… »)', UNIT, (d) => roomsLine(d.unit)),
	F('logement.chambres', 'logement', 'Nombre de chambres', UNIT, (d) => count(d.unit.bedrooms)),
	F('logement.salons', 'logement', 'Nombre de salons', UNIT, (d) => count(d.unit.livingRooms)),
	F('logement.cuisines', 'logement', 'Nombre de cuisines', UNIT, (d) => count(d.unit.kitchens)),
	F('logement.salles_de_bain', 'logement', 'Nombre de salles de bain', UNIT, (d) => count(d.unit.bathrooms)),
	F('logement.terrasses', 'logement', 'Nombre de terrasses', UNIT, (d) => count(d.unit.terraces)),
	F('logement.buanderies', 'logement', 'Nombre de buanderies', UNIT, (d) => count(d.unit.laundries)),
	F('logement.surface', 'logement', 'Surface (m²)', UNIT, (d) => (d.unit.surfaceM2 ? `${d.unit.surfaceM2}\u00a0m²` : null)),
	F('logement.terrain', 'logement', 'Surface du terrain (m²)', UNIT, (d) => (d.unit.landAreaM2 ? `${d.unit.landAreaM2}\u00a0m²` : null)),
	F('logement.cloture', 'logement', '« clôturé » ou « non clôturé »', UNIT, (d) =>
		d.unit.amenities.includes('fence') ? 'clôturé' : 'non clôturé'
	),
	C('logement.est_cloture', 'logement', 'Le logement est clôturé', UNIT, (d) => d.unit.amenities.includes('fence')),
	C('logement.avec_garage', 'logement', 'Le logement a un garage', UNIT, (d) => d.unit.amenities.includes('garage')),
	F('logement.equipements', 'logement', 'Équipements (liste)', UNIT, (d) =>
		d.unit.amenities.length ? d.unit.amenities.map((a) => AMENITY_WORDS[a]).join(', ') : null
	),
	F('logement.localisation', 'logement', 'Localisation (repère, quartier, commune)', UNIT, (d) => locationLine(d.unit)),
	F('logement.quartier', 'logement', 'Quartier', UNIT, (d) => orNull(d.unit.neighborhood)),
	F('logement.commune', 'logement', 'Commune', UNIT, (d) => d.unit.commune),

	// Conditions du bail (lot 08, D24).
	F('bail.date_debut', 'bail', 'Date d’effet', LEASE, (d) => dateInFrenchWords(d.lease.startsOn)),
	F('bail.reference', 'bail', 'Référence du bail (pied de page)', LEASE, (d) => d.lease.reference),
	F('bail.date_fin', 'bail', 'Date de fin', LEASE, (d) => date(d.lease.endsOn)),
	F('bail.duree', 'bail', 'Durée (« douze (12) mois »)', LEASE, (d) => months(leaseDurationMonths(d.lease))),
	F('bail.duree_mois', 'bail', 'Durée en mois (chiffres)', LEASE, (d) => {
		const m = leaseDurationMonths(d.lease);
		return m === null ? null : String(m);
	}),
	C('bail.duree_determinee', 'bail', 'Bail à durée déterminée', LEASE, (d) => d.lease.endsOn !== null),
	C('bail.duree_indeterminee', 'bail', 'Bail à durée indéterminée', LEASE, (d) => d.lease.endsOn === null),

	F('loyer.montant', 'loyer', 'Loyer mensuel (« 75 000 FCFA »)', LEASE, (d) => fcfa(d.lease.rent)),
	F('loyer.montant_lettres', 'loyer', 'Loyer en lettres', LEASE, (d) => words(d.lease.rent)),
	F('loyer.charges', 'loyer', 'Charges mensuelles', LEASE, (d) => fcfa(d.lease.charges)),
	F('loyer.charges_lettres', 'loyer', 'Charges en lettres', LEASE, (d) => words(d.lease.charges)),
	C('loyer.avec_charges', 'loyer', 'Des charges s’ajoutent au loyer', LEASE, (d) => d.lease.charges > 0),
	F('loyer.total', 'loyer', 'Loyer et charges', LEASE, (d) => fcfa(d.lease.rent + d.lease.charges)),
	F('loyer.total_lettres', 'loyer', 'Loyer et charges en lettres', LEASE, (d) => words(d.lease.rent + d.lease.charges)),
	F('loyer.jour_limite', 'loyer', 'Jour limite de paiement (« 5 »)', LEASE, (d) => String(d.lease.dueDay)),
	F('loyer.modalites', 'loyer', 'Modalités de paiement', LEASE, (d) => orNull(d.lease.paymentTerms)),
	C(
		'loyer.premier_mois_prorata',
		'loyer',
		'Entrée en cours de mois : premier mois au prorata',
		LEASE,
		(d) => firstPartialMonth(d) !== null
	),
	F('loyer.premier_mois_montant', 'loyer', 'Montant du premier mois incomplet', LEASE, (d) => fcfa(firstPartialMonth(d)?.amount)),
	F('loyer.premier_mois_lettres', 'loyer', 'Premier mois incomplet en lettres', LEASE, (d) => words(firstPartialMonth(d)?.amount)),
	F('loyer.premier_mois_debut', 'loyer', 'Début du premier mois incomplet', LEASE, (d) => date(firstPartialMonth(d)?.start)),
	F('loyer.premier_mois_fin', 'loyer', 'Fin du premier mois incomplet', LEASE, (d) => date(firstPartialMonth(d)?.end)),

	C('avance', 'avance', 'Une avance est versée', LEASE, (d) => d.lease.advanceMonths > 0),
	F('avance.mois', 'avance', 'Avance en mois (« trois (3) mois »)', LEASE, (d) =>
		d.lease.advanceMonths > 0 ? months(d.lease.advanceMonths) : null
	),
	F('avance.montant', 'avance', 'Montant de l’avance', LEASE, (d) =>
		d.lease.advanceMonths > 0 ? fcfa(d.lease.advanceMonths * (d.lease.rent + d.lease.charges)) : null
	),
	F('avance.montant_lettres', 'avance', 'Avance en lettres', LEASE, (d) =>
		d.lease.advanceMonths > 0 ? words(d.lease.advanceMonths * (d.lease.rent + d.lease.charges)) : null
	),

	C('caution', 'caution', 'Une caution est prévue', DEPOSIT, (d) => d.deposits.security !== null),
	F('caution.montant', 'caution', 'Montant de la caution', DEPOSIT, (d) => fcfa(d.deposits.security?.amount)),
	F('caution.montant_lettres', 'caution', 'Caution en lettres', DEPOSIT, (d) => words(d.deposits.security?.amount)),
	F('caution.mois', 'caution', 'Caution en mois de loyer', DEPOSIT, (d) => months(d.deposits.security?.months)),
	F('caution.detenteur', 'caution', 'Détenteur du dépôt (organisation ou propriétaire)', DEPOSIT, (d) => depositHolder(d)),
	F('caution.delai_restitution', 'caution', 'Délai de restitution (« trente (30) jours »)', LEASE, (d) =>
		countInWords(d.lease.depositRefundDays, 'jour')
	),

	C('garantie_factures', 'garantie_factures', 'Une garantie des factures est prévue', DEPOSIT, (d) => d.deposits.utilities !== null),
	F('garantie_factures.montant', 'garantie_factures', 'Montant de la garantie des factures', DEPOSIT, (d) =>
		fcfa(d.deposits.utilities?.amount)
	),
	F('garantie_factures.montant_lettres', 'garantie_factures', 'Garantie des factures en lettres', DEPOSIT, (d) =>
		words(d.deposits.utilities?.amount)
	),

	C('penalite', 'penalite', 'Une pénalité de retard est prévue', LEASE, (d) => d.lease.penaltyRateBp !== null),
	F('penalite.taux', 'penalite', 'Taux par mois (« 0,75 % »)', LEASE, (d) =>
		d.lease.penaltyRateBp === null ? null : formatRateBp(d.lease.penaltyRateBp)
	),
	F('penalite.delai_grace', 'penalite', 'Délai avant pénalité (« dix (10) jours »)', LEASE, (d) =>
		d.lease.penaltyGraceDays === null ? null : countInWords(d.lease.penaltyGraceDays, 'jour')
	),
	F('penalite.beneficiaire', 'penalite', 'Bénéficiaire de la pénalité', LEASE, (d) =>
		d.lease.penaltyBeneficiary ? BENEFICIARY_WORDS[d.lease.penaltyBeneficiary] : null
	),

	F('preavis.locataire_duree_determinee', 'preavis', 'Préavis du locataire, durée déterminée', LEASE, (d) =>
		months(d.lease.noticeTenantFixedTermMonths)
	),
	F('preavis.locataire_duree_indeterminee', 'preavis', 'Préavis du locataire, durée indéterminée', LEASE, (d) =>
		months(d.lease.noticeTenantOpenEndedMonths)
	),
	F('preavis.bailleur_duree_determinee', 'preavis', 'Préavis du bailleur, durée déterminée', LEASE, (d) =>
		months(d.lease.noticeLessorFixedTermMonths)
	),
	F('preavis.bailleur', 'preavis', 'Préavis du bailleur (« trois (3) mois dans les deux cas »)', LEASE, (d) => lessorNotice(d.lease)),
	F('preavis.bailleur_duree_indeterminee', 'preavis', 'Préavis du bailleur, durée indéterminée', LEASE, (d) =>
		months(d.lease.noticeLessorOpenEndedMonths)
	),
	C('preavis.reduit', 'preavis', 'Un préavis réduit est prévu', LEASE, (d) => d.lease.reducedNoticeMonths !== null),
	F('preavis.reduit_duree', 'preavis', 'Durée du préavis réduit', LEASE, (d) => months(d.lease.reducedNoticeMonths)),
	F('preavis.reduit_cas', 'preavis', 'Cas du préavis réduit', LEASE, (d) => orNull(d.lease.reducedNoticeCases)),
	C(
		'preavis.indemnite',
		'preavis',
		'Une indemnité de départ anticipé est prévue',
		LEASE,
		(d) => d.lease.earlyTerminationIndemnityMonths !== null
	),
	F('preavis.indemnite_duree', 'preavis', 'Indemnité de départ anticipé (en mois)', LEASE, (d) =>
		months(d.lease.earlyTerminationIndemnityMonths)
	),

	F('reconduction.mode', 'reconduction', 'Comportement au terme (texte)', LEASE, (d) => RENEWAL_WORDS[d.lease.renewalMode]),
	C('reconduction.duree_indeterminee', 'reconduction', 'Au terme : durée indéterminée', LEASE, (d) => d.lease.renewalMode === 'open_ended'),
	C(
		'reconduction.meme_duree',
		'reconduction',
		'Au terme : reconduction pour la même durée',
		LEASE,
		(d) => d.lease.renewalMode === 'same_duration'
	),

	F('signature.lieu', 'signature', 'Lieu de signature', SIGNING, (d) => orNull(d.signing.place)),
	F('signature.date', 'signature', 'Date de signature', SIGNING, (d) => date(d.signing.date)),
	F('signature.exemplaires', 'signature', 'Nombre d’exemplaires (chiffres)', SIGNING, (d) =>
		d.signing.copies ? String(d.signing.copies) : null
	),
	C(
		'signature.proprietaire_signe',
		'signature',
		'Le propriétaire signe lui-même (sans pouvoir de signature au mandat)',
		SIGNING,
		(d) => d.signing.ownerSigns
	),
	F('signature.exemplaires_texte', 'signature', 'Exemplaires (« trois (3) exemplaires originaux, dont un pour… »)', SIGNING, (d) =>
		copiesText(d.signing)
	),
	F('signature.paraphes', 'signature', 'Cases de paraphe en pied de page, une par partie', SIGNING, (d) =>
		Array.from({ length: Math.max(d.signing.parties, 2) }, () => '______').join(' ')
	),
	F('signature.exemplaires_lettres', 'signature', 'Nombre d’exemplaires en lettres', SIGNING, (d) =>
		d.signing.copies ? numberInFrenchWords(d.signing.copies) : null
	),

	// Avenants : seulement dans un modèle d'avenant.
	F('avenant.numero', 'avenant', 'Numéro de l’avenant', AMENDMENT, (d) => (d.amendment ? String(d.amendment.number) : null), true),
	F(
		'avenant.objet',
		'avenant',
		'Objet (renouvellement, modification du loyer…)',
		AMENDMENT,
		(d) => (d.amendment ? AMENDMENT_TYPE_WORDS[d.amendment.type] : null),
		true
	),
	F('avenant.date_effet', 'avenant', 'Date d’effet', AMENDMENT, (d) => date(d.amendment?.effectiveFrom), true),
	F('avenant.description', 'avenant', 'Texte de la modification', AMENDMENT, (d) => orNull(d.amendment?.description), true),
	F('avenant.nouveau_loyer', 'avenant', 'Nouveau loyer', AMENDMENT, (d) => fcfa(d.amendment?.newRent), true),
	F('avenant.nouveau_loyer_lettres', 'avenant', 'Nouveau loyer en lettres', AMENDMENT, (d) => words(d.amendment?.newRent), true),
	F('avenant.nouvelles_charges', 'avenant', 'Nouvelles charges', AMENDMENT, (d) => fcfa(d.amendment?.newCharges), true),
	F('avenant.nouvelle_date_fin', 'avenant', 'Nouvelle date de fin', AMENDMENT, (d) => date(d.amendment?.newEndsOn), true),
	F(
		'avenant.contrat_initial_date',
		'avenant',
		'Date de signature du contrat initial',
		AMENDMENT,
		(d) => date(d.amendment?.baseContractSignedOn),
		true
	),
	C('avenant.est_changement_loyer', 'avenant', 'L’avenant modifie le loyer', AMENDMENT, (d) => d.amendment?.type === 'rent_change', true),
	C('avenant.est_renouvellement', 'avenant', 'L’avenant renouvelle le bail', AMENDMENT, (d) => d.amendment?.type === 'renewal', true),
	C('avenant.est_autre', 'avenant', 'Autre modification', AMENDMENT, (d) => d.amendment?.type === 'other', true),
	C(
		'avenant.duree_indeterminee',
		'avenant',
		'Le renouvellement passe à durée indéterminée',
		AMENDMENT,
		(d) => d.amendment?.type === 'renewal' && d.amendment.newEndsOn === null,
		true
	)
];

const BY_TAG = new Map(CONTRACT_FIELDS.map((f) => [f.tag, f]));

export function contractField(tag: string): ContractField | undefined {
	return BY_TAG.get(tag);
}

/** Balises utilisables dans un modèle de ce type (les champs d'avenant n'existent que dans un modèle d'avenant). */
export function fieldsForKind(kind: ContractTemplateKind): readonly ContractField[] {
	return kind === 'amendment' ? CONTRACT_FIELDS : CONTRACT_FIELDS.filter((f) => !f.amendmentOnly);
}

/** Toutes les valeurs, par balise : la copie qu'une version de contrat garde (D29). */
export function resolveContractFields(
	data: ContractData,
	kind: ContractTemplateKind = data.amendment ? 'amendment' : 'lease'
): Record<string, ContractFieldValue> {
	const out: Record<string, ContractFieldValue> = {};
	for (const f of fieldsForKind(kind)) {
		const v = f.resolve(data);
		out[f.tag] = typeof v === 'string' && v.trim() === '' ? null : v;
	}
	return out;
}

// ---------------------------------------------------------------- balises d'un modèle

/** Où une balise apparaît : les sections qui l'entourent (`inverted` : `{^…}`, rendue si la valeur est fausse). */
export interface TemplateTagUsage {
	tag: string;
	/** Balise de section `{#…}` ou `{^…}` elle-même, ou valeur `{…}`. */
	role: 'value' | 'section';
	sections: readonly { tag: string; inverted: boolean }[];
}

export interface TemplateTagReport {
	/** Balises reconnues, dans l'ordre de première apparition. */
	known: string[];
	/** Balises inconnues : elles bloquent l'activation du modèle. */
	unknown: string[];
}

/** Classe les balises d'un modèle : reconnues par le catalogue (pour ce type de modèle) ou inconnues. */
export function classifyTemplateTags(tags: readonly string[], kind: ContractTemplateKind): TemplateTagReport {
	const allowed = new Set(fieldsForKind(kind).map((f) => f.tag));
	const known: string[] = [];
	const unknown: string[] = [];
	for (const tag of tags) {
		const list = allowed.has(tag) ? known : unknown;
		if (!list.includes(tag)) list.push(tag);
	}
	return { known, unknown };
}

/** Vraie au sens d'une section docxtemplater : `true`, ou un texte non vide. */
export function isTruthyField(v: ContractFieldValue | undefined): boolean {
	return v === true || (typeof v === 'string' && v.length > 0);
}

/**
 * Balises qui resteraient en blanc dans le document : une valeur vide, rendue parce qu'aucune section qui l'entoure
 * n'est fausse. Un contrat qui en a ne peut pas être figé (« sans aucun blanc »).
 */
export function blankFields(usages: readonly TemplateTagUsage[], values: Readonly<Record<string, ContractFieldValue>>): string[] {
	const out: string[] = [];
	for (const u of usages) {
		if (u.role !== 'value') continue;
		const rendered = u.sections.every((s) => isTruthyField(values[s.tag]) !== s.inverted);
		if (!rendered) continue;
		const v = values[u.tag];
		if ((v === null || v === undefined || v === '') && !out.includes(u.tag)) out.push(u.tag);
	}
	return out;
}

// ---------------------------------------------------------------- données d'exemple (aperçu de la mise en place)

/** Données fictives, sans personne réelle : l'aperçu d'un modèle avant son activation. */
export const EXAMPLE_CONTRACT_DATA: ContractData = {
	organization: {
		type: 'agency',
		legalName: 'Agence Exemple SARL',
		tradeName: 'Agence Exemple',
		address: 'Avenue de l’Exemple, secteur 0',
		commune: 'Ouagadougou',
		poBox: '01 BP 0000 Ouagadougou 01',
		rccm: 'BF-OUA-00-0000-B00-00000',
		ifu: '00000000X',
		phone: '+22625000000',
		logoId: null,
		representative: {
			name: 'Prénom Nom',
			title: 'gérant',
			profession: 'agent immobilier',
			address: 'Ouagadougou',
			nationality: 'burkinabè',
			identity: { type: 'cnib', typeOther: null, number: 'B00000000', issuedOn: '2022-01-15', issuedBy: 'ONI' }
		}
	},
	owner: { type: 'person', name: 'Propriétaire Exemple', address: 'Ouagadougou', phone: '+22670000000', representativeName: null },
	tenant: {
		civility: 'mr',
		fullName: 'Locataire Exemple',
		birthDate: '1990-06-01',
		birthPlace: 'Bobo-Dioulasso',
		nationality: 'burkinabè',
		profession: 'enseignant',
		previousAddress: 'Saaba',
		phone: '+22671000000',
		secondaryPhone: null,
		identity: { type: 'cnib', typeOther: null, number: 'B11111111', issuedOn: '2021-03-10', issuedBy: 'ONI' }
	},
	unit: {
		type: 'villa',
		label: 'Villa A',
		usage: 'residential',
		furnished: false,
		bedrooms: 3,
		livingRooms: 1,
		kitchens: 1,
		bathrooms: 2,
		terraces: 1,
		laundries: 0,
		surfaceM2: 150,
		landAreaM2: 300,
		amenities: ['fence', 'garage', 'running_water'],
		propertyName: 'Résidence Exemple',
		addressHint: 'Derrière l’école',
		neighborhood: 'Ouaga 2000',
		commune: 'Ouagadougou'
	},
	lease: {
		reference: 'B-EXEMPLE1',
		startsOn: '2027-01-01',
		endsOn: '2027-12-31',
		durationMonths: 12,
		rent: 75_000,
		charges: 0,
		dueDay: 5,
		paymentTerms: 'en espèces ou par Mobile Money, contre reçu',
		advanceMonths: 3,
		lessorType: 'organization',
		penaltyRateBp: null,
		penaltyGraceDays: null,
		penaltyBeneficiary: null,
		noticeTenantFixedTermMonths: 2,
		noticeTenantOpenEndedMonths: 3,
		noticeLessorFixedTermMonths: 3,
		noticeLessorOpenEndedMonths: 3,
		reducedNoticeMonths: null,
		reducedNoticeCases: null,
		earlyTerminationIndemnityMonths: null,
		renewalMode: 'open_ended',
		depositRefundDays: 30,
		billingMode: 'calendar_prorata',
		periodicity: 'monthly',
		duesStartOn: '2027-01-01',
		version: 1
	},
	deposits: { security: { amount: 150_000, months: 2, holder: 'organization' }, utilities: null },
	signing: { place: 'Ouagadougou', date: '2026-12-15', copies: 3, parties: 2, ownerSigns: false },
	mandate: { startsOn: '2024-01-01' },
	amendment: null
};
