/**
 * Reçus de paiement (lot 09) : numérotation, réglages de l'organisation, statuts et contenu du document, partagés par
 * l'API, le worker (PDF) et l'appareil (reçu affiché hors ligne). Le document s'intitule toujours « Reçu de paiement »,
 * jamais « quittance » (réponse du porteur).
 *
 * Numérotation (règle 9, réponses du porteur) :
 * - `PRÉFIXE-AAAA-NNNNNN`, continue, sans trou ni doublon, par organisation et par année, attribuée par le serveur à
 *   la confirmation ;
 * - préfixe de 2 à 6 lettres majuscules, proposé à partir du nom de l'organisation, modifiable par le directeur jusqu'au
 *   premier reçu, puis figé (un changement exceptionnel passe par le back-office, avec motif et audit) ;
 * - le directeur peut fixer une seule fois le premier numéro de l'année en cours, avant le premier reçu, pour
 *   continuer son carnet papier ; ensuite, plus aucun changement.
 */
import { z } from 'zod';
import { formatDate } from './dates.js';
import { amountInFrenchWords } from './french-words.js';
import { formatFcfa, type Fcfa } from './money.js';
import type { MobileMoneyOperator, PaymentMeans, PaymentPurpose } from './payments.js';

export const RECEIPT_TITLE = 'Reçu de paiement';
export const RECEIPT_PROVISIONAL_TITLE = 'Reçu provisoire';
export const RECEIPT_CANCELLED_MARK = 'ANNULÉ';

export const RECEIPT_STATUSES = ['provisional', 'valid', 'cancelled'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Un reçu provisoire devient valide (numéro attribué) ou annulé ; un reçu valide ne peut qu'être annulé. */
export const RECEIPT_TRANSITIONS: Record<ReceiptStatus, readonly ReceiptStatus[]> = {
	provisional: ['valid', 'cancelled'],
	valid: ['cancelled'],
	cancelled: []
};

export function canTransitionReceipt(from: ReceiptStatus, to: ReceiptStatus): boolean {
	return RECEIPT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------- formats d'impression

/** Largeur du ticket de caisse en millimètres : réglage de l'organisation, 80 mm par défaut (réponse du porteur). */
export const RECEIPT_TICKET_WIDTHS = [58, 80] as const;
export type ReceiptTicketWidth = (typeof RECEIPT_TICKET_WIDTHS)[number];
export const DEFAULT_RECEIPT_TICKET_WIDTH: ReceiptTicketWidth = 80;

export const RECEIPT_FORMATS = ['a6', 'ticket'] as const;
export type ReceiptFormat = (typeof RECEIPT_FORMATS)[number];

// ---------------------------------------------------------------- numérotation

export const RECEIPT_PREFIX_PATTERN = /^[A-Z]{2,6}$/;
/** Rang sur six chiffres au moins ; au-delà de 999 999, le numéro s'allonge, jamais tronqué. */
export const RECEIPT_SEQUENCE_DIGITS = 6;
export const RECEIPT_FIRST_NUMBER_MAX = 99_999_999;

export const receiptPrefixSchema = z
	.string()
	.trim()
	.transform((v) => v.toUpperCase())
	.pipe(z.string().regex(RECEIPT_PREFIX_PATTERN, { error: 'Le préfixe compte 2 à 6 lettres majuscules, sans accent ni chiffre.' }));

/** `AGX-2027-000124`. */
export function formatReceiptNumber(prefix: string, year: number, sequence: number): string {
	if (!RECEIPT_PREFIX_PATTERN.test(prefix)) throw new RangeError(`Préfixe de reçu invalide : ${prefix}`);
	if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) throw new RangeError(`Année invalide : ${year}`);
	if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError(`Rang de reçu invalide : ${sequence}`);
	return `${prefix}-${year}-${String(sequence).padStart(RECEIPT_SEQUENCE_DIGITS, '0')}`;
}

export function parseReceiptNumber(value: string): { prefix: string; year: number; sequence: number } | null {
	const m = /^([A-Z]{2,6})-(\d{4})-(\d{6,})$/.exec(value);
	if (!m) return null;
	const sequence = Number(m[3]);
	return Number.isSafeInteger(sequence) && sequence >= 1 ? { prefix: m[1]!, year: Number(m[2]), sequence } : null;
}

/** Année de numérotation : celle de la date d'émission (Ouagadougou est en UTC). */
export function receiptYear(issuedOn: string): number {
	return Number(issuedOn.slice(0, 4));
}

/** Mots ignorés pour les initiales. */
const PREFIX_STOP_WORDS = new Set([
	'DE',
	'DU',
	'DES',
	'LA',
	'LE',
	'LES',
	'L',
	'D',
	'ET',
	'EN',
	'AU',
	'AUX',
	'SARL',
	'SA',
	'SAS',
	'SUARL',
	'ETS'
]);

/**
 * Préfixe proposé à partir du nom de l'organisation : les initiales des mots significatifs (« Agence Immobilière du
 * Faso » → `AIF`), ou les trois premières lettres d'un nom d'un seul mot (« Kaboré » → `KAB`) ; `RECU` à défaut.
 */
export function defaultReceiptPrefix(organizationName: string): string {
	const words = organizationName
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		.split(/[^A-Z]+/)
		.filter((w) => w.length > 0);
	const significant = words.filter((w) => !PREFIX_STOP_WORDS.has(w));
	const kept = significant.length ? significant : words;
	if (kept.length >= 2)
		return kept
			.map((w) => w[0])
			.join('')
			.slice(0, 6);
	const single = kept[0] ?? '';
	return single.length >= 2 ? single.slice(0, 3) : 'RECU';
}

/** Réglages des reçus, par le directeur (en ligne, journalisés). */
export const receiptSettingsSchema = z
	.object({
		prefix: receiptPrefixSchema.optional(),
		/** Premier numéro de l'année en cours, pour continuer un carnet papier : une seule fois, avant le premier reçu. */
		firstNumber: z
			.number({ error: 'Le premier numéro est un nombre entier.' })
			.int({ error: 'Le premier numéro est un nombre entier.' })
			.min(1, { error: 'Le premier numéro vaut 1 au moins.' })
			.max(RECEIPT_FIRST_NUMBER_MAX, { error: 'Premier numéro trop grand.' })
			.optional(),
		ticketWidth: z.literal(RECEIPT_TICKET_WIDTHS, { error: 'Largeur du ticket : 58 ou 80 mm.' }).optional()
	})
	.refine((v) => v.prefix !== undefined || v.firstNumber !== undefined || v.ticketWidth !== undefined, {
		error: 'Aucun réglage à enregistrer.'
	});
export type ReceiptSettingsData = z.output<typeof receiptSettingsSchema>;

/** Changement exceptionnel du préfixe après le premier reçu : back-office de la plateforme seulement, motivé. */
export const adminReceiptPrefixSchema = z.object({
	prefix: receiptPrefixSchema,
	reason: z.string().trim().min(5, { error: 'Indiquez le motif (5 caractères au moins).' }).max(500, { error: 'Motif trop long.' })
});

export type ReceiptSettingsBlocker =
	/** Un reçu a déjà été émis : le préfixe est figé (back-office seulement). */
	| 'RECEIPT_PREFIX_LOCKED'
	/** Un reçu a déjà été émis : le premier numéro ne se fixe plus. */
	| 'RECEIPT_FIRST_NUMBER_LOCKED'
	/** Le premier numéro a déjà été fixé une fois. */
	| 'RECEIPT_FIRST_NUMBER_ALREADY_SET';

export interface ReceiptNumberingState {
	/** Nombre de reçus numérotés de l'organisation, toutes années confondues. */
	issuedCount: number;
	/** Le premier numéro a déjà été fixé (une seule fois, jamais). */
	firstNumberSet: boolean;
}

export function receiptSettingsBlockers(state: ReceiptNumberingState, change: ReceiptSettingsData): ReceiptSettingsBlocker[] {
	const out: ReceiptSettingsBlocker[] = [];
	if (change.prefix !== undefined && state.issuedCount > 0) out.push('RECEIPT_PREFIX_LOCKED');
	if (change.firstNumber !== undefined) {
		if (state.issuedCount > 0) out.push('RECEIPT_FIRST_NUMBER_LOCKED');
		else if (state.firstNumberSet) out.push('RECEIPT_FIRST_NUMBER_ALREADY_SET');
	}
	return out;
}

// ---------------------------------------------------------------- contenu du reçu (copie figée, D29)

/** Données de l'organisation copiées à l'émission : un changement ultérieur ne modifie jamais le reçu (D29). */
export interface ReceiptOrganizationSnapshot {
	name: string;
	address: string | null;
	commune: string | null;
	poBox: string | null;
	phone: string | null;
	rccm: string | null;
	ifu: string | null;
	/** Version du logo en vigueur à l'émission (jamais écrasée). */
	logoId: string | null;
}

export interface ReceiptPeriod {
	start: string;
	end: string;
	/** Montant imputé sur cette période par cet encaissement. */
	amount: Fcfa;
	isAdvance: boolean;
}

/** Contenu du reçu, copié à l'émission (confirmation) et jamais recalculé. */
export interface ReceiptSnapshot {
	organization: ReceiptOrganizationSnapshot;
	tenant: { fullName: string };
	unit: { label: string; address: string | null };
	purpose: PaymentPurpose;
	/** Loyer : périodes couvertes ; crédit restant, imputé sur les échéances à venir. */
	periods: ReceiptPeriod[];
	credit: Fcfa;
	/** Caution : type et détenteur du compte. */
	deposit: { type: 'security_deposit' | 'utilities_guarantee'; holder: 'organization' | 'owner' } | null;
	amount: Fcfa;
	method: PaymentMeans;
	operator: MobileMoneyOperator | null;
	transactionReference: string | null;
	paidOn: string;
	/** Solde restant dû après cet encaissement : loyers exigibles, ou reste du dépôt de garantie. */
	balanceDue: Fcfa;
	collectedBy: string;
}

const OPERATOR_NAMES: Record<MobileMoneyOperator, string> = {
	orange_money: 'Orange Money',
	moov_money: 'Moov Money',
	other: 'autre opérateur'
};

const METHOD_NAMES: Record<PaymentMeans, string> = {
	cash: 'Espèces',
	mobile_money_manual: 'Mobile Money',
	bank_transfer: 'Virement bancaire',
	mobile_money_direct: 'Mobile Money'
};

export function paymentMeansLabel(p: Pick<ReceiptSnapshot, 'method' | 'operator' | 'transactionReference'>): string {
	const name = p.operator && p.method !== 'cash' ? `${METHOD_NAMES[p.method]} (${OPERATOR_NAMES[p.operator]})` : METHOD_NAMES[p.method];
	return p.transactionReference ? `${name}, référence ${p.transactionReference}` : name;
}

/** Objet du reçu : loyer et périodes couvertes, ou versement du dépôt de garantie avec son détenteur. */
export function receiptObject(s: Pick<ReceiptSnapshot, 'purpose' | 'periods' | 'credit' | 'deposit'>): string[] {
	if (s.purpose === 'deposit') {
		const what = s.deposit?.type === 'utilities_guarantee' ? 'Versement de la garantie des factures' : 'Versement du dépôt de garantie';
		const holder = s.deposit?.holder === 'owner' ? 'détenu par le propriétaire' : 'détenu par l’organisation';
		return [`${what}, ${holder}`];
	}
	const lines = s.periods.map(
		(p) => `Loyer du ${formatDate(p.start)} au ${formatDate(p.end)}${p.isAdvance ? ' (avance)' : ''} : ${formatFcfa(p.amount)}`
	);
	if (s.credit > 0) lines.push(`Avance sur les loyers à venir : ${formatFcfa(s.credit)}`);
	return lines.length ? lines : ['Loyer'];
}

export interface ReceiptDocumentInput {
	snapshot: ReceiptSnapshot;
	status: ReceiptStatus;
	/** Numéro définitif, ou `null` pour un reçu provisoire. */
	number: string | null;
	provisionalNumber: string;
	issuedOn: string | null;
	/** Adresse de la page de vérification (QR code). */
	verificationUrl: string | null;
}

export interface ReceiptDocument {
	title: string;
	cancelled: boolean;
	organization: string[];
	number: string;
	issuedOn: string;
	fields: { label: string; value: string | string[] }[];
	amountInWords: string;
	verificationUrl: string | null;
}

/**
 * Contenu du reçu dans l'ordre des mentions retenues (réponse du porteur, à valider par le juriste) : organisation
 * (nom, adresse, RCCM et IFU s'ils existent), numéro, date d'émission, locataire, unité et adresse, objet, montant en
 * chiffres et en lettres, moyen et référence, solde restant dû, personne qui a encaissé, QR code, « ANNULÉ ». Le même
 * pour le PDF (worker) et pour l'écran : ils ne divergent jamais.
 */
export function receiptDocument(input: ReceiptDocumentInput): ReceiptDocument {
	const { snapshot: s } = input;
	const org = s.organization;
	const orgLines = [
		org.name,
		[org.address, org.commune].filter(Boolean).join(', '),
		// Boîte postale telle que saisie (« 01 BP 1234 Ouagadougou 01 »).
		org.poBox ?? '',
		org.phone ? `Tél. ${org.phone}` : '',
		[org.rccm ? `RCCM ${org.rccm}` : '', org.ifu ? `IFU ${org.ifu}` : ''].filter(Boolean).join(' · ')
	].filter((l) => l.length > 0);
	return {
		title: input.number ? RECEIPT_TITLE : RECEIPT_PROVISIONAL_TITLE,
		cancelled: input.status === 'cancelled',
		organization: orgLines,
		number: input.number ?? input.provisionalNumber,
		issuedOn: formatDate(input.issuedOn ?? s.paidOn),
		fields: [
			{ label: 'Locataire', value: s.tenant.fullName },
			{ label: 'Logement', value: [s.unit.label, s.unit.address].filter((v): v is string => !!v) },
			{ label: 'Objet', value: receiptObject(s) },
			{ label: 'Montant', value: formatFcfa(s.amount) },
			{ label: 'Moyen de paiement', value: paymentMeansLabel(s) },
			{ label: 'Date du paiement', value: formatDate(s.paidOn) },
			{ label: 'Solde restant dû', value: formatFcfa(s.balanceDue) },
			{ label: 'Encaissé par', value: s.collectedBy }
		],
		amountInWords: capitalize(amountInFrenchWords(s.amount)),
		verificationUrl: input.verificationUrl
	};
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------- vues

export interface ReceiptView {
	id: string;
	paymentId: string;
	status: ReceiptStatus;
	number: string | null;
	provisionalNumber: string;
	issuedOn: string | null;
	snapshot: ReceiptSnapshot | null;
	cancelledAt: string | null;
}

/** Page publique de vérification (`/r/<jeton>`) : ces cinq informations, aucune autre donnée personnelle. */
export interface ReceiptVerificationView {
	organizationName: string;
	number: string | null;
	issuedOn: string | null;
	amount: Fcfa;
	status: ReceiptStatus;
}
