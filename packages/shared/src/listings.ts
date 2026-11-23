/**
 * Annonces et prospects (lot 12, module listings) : règles pures partagées par l'API, la vitrine et l'application.
 *
 * - Publication (règle 7 de CLAUDE.md, D14, D34) : ce qui manque pour publier, dans un ordre stable, avec un code par
 *   condition. Location : une unité disponible au sens de `isAvailable`, un mandat qui autorise la publication.
 *   Vente : le bien entier, une agence vérifiée, un mandat de vente sur le bien entier ; le bien peut être occupé
 *   (« Vente occupée »).
 * - Statut de l'annonce : `internal` → `pending_review` (préparation des photos et de l'image Open Graph) →
 *   `published` ; `suspended` quand la cible cesse d'être publiable, retirée (`archived`) au bout de 30 jours ; une
 *   annonce suspendue n'est jamais remise en ligne seule. L'interrupteur `listings.publication` ne change pas l'état :
 *   il masque l'annonce de la vitrine (`showcaseVisible`).
 * - Quatrième dimension du statut de l'unité (D14), calculée à partir de l'annonce.
 * - Vitrine : référence, adresses, recherche (paramètres tolérants, forme canonique, curseur), cache et purge.
 * - Prospects : statuts, formulaire de contact (champ piège, délai minimal), doublons.
 *
 * Les libellés français sont dans apps/web/src/lib/i18n/fr.ts. La migration du lot reprend les mêmes listes dans ses
 * contraintes CHECK ; un test compare les deux.
 */
import { z } from 'zod';
import { addDays, daysBetween, isIsoDate } from './dates.js';
import { publicLocation, type OptionalPoint, type PlaceOfProperty } from './geography.js';
import { idSchema, isUuid } from './ids.js';
import { fcfaSchema, type Fcfa } from './money.js';
import type { MandateType } from './owners.js';
import { base64Url } from './payments.js';
import { phoneSchema, waNumber } from './phone.js';
import {
	communeIdSchema,
	MAX_PHOTOS_PER_OBJECT,
	PROPERTY_TYPES,
	UNIT_TYPES,
	type Occupancy,
	type PropertyOperation,
	type RecordStatus,
	type TechnicalStatus
} from './properties.js';
import { patchShape } from './schema-helpers.js';

// ---------------------------------------------------------------- listes fermées

/** Opération d'une annonce : une location vise une unité, une vente le bien entier (D34). */
export const LISTING_OPERATIONS = ['rent', 'sale'] as const;
export type ListingOperation = (typeof LISTING_OPERATIONS)[number];

/**
 * État d'une annonce. `pending_review` : publication demandée, photos et image Open Graph en préparation (quelques
 * secondes). `archived` : retirée, définitivement ; une nouvelle publication crée une nouvelle annonce.
 */
export const LISTING_VISIBILITIES = ['internal', 'pending_review', 'published', 'suspended', 'archived'] as const;
export type ListingVisibility = (typeof LISTING_VISIBILITIES)[number];

/** Quatrième dimension du statut d'une unité (D14), calculée à partir de son annonce. */
export const UNIT_LISTING_STATUSES = ['not_published', 'pending_review', 'published', 'suspended', 'withdrawn'] as const;
export type UnitListingStatus = (typeof UNIT_LISTING_STATUSES)[number];

/** Pourquoi une annonce est suspendue ; dans l'ordre de priorité quand plusieurs causes se cumulent. */
export const SUSPENSION_REASONS = [
	'unit_rented',
	'unit_unavailable',
	'mandate_ended',
	'organization_not_eligible',
	'photos_missing'
] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/** Pourquoi une annonce est retirée : à la main, ou au bout de 30 jours de suspension. */
export const ARCHIVE_REASONS = ['withdrawn', 'suspension_expired'] as const;
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

/** Précision de l'emplacement publié : le quartier par défaut, le point du bien si l'organisation le choisit. */
export const LOCATION_PRECISIONS = ['neighborhood', 'exact'] as const;
export type LocationPrecision = (typeof LOCATION_PRECISIONS)[number];

export const MIN_LISTING_PHOTOS = 3;
export const MAX_LISTING_PHOTOS = MAX_PHOTOS_PER_OBJECT;

/** Une annonce suspendue est retirée au bout de 30 jours (réponse du porteur, Q2). */
export const SUSPENSION_RETENTION_DAYS = 30;

/** Mandats qui permettent de publier une location (avec `can_publish`) ; `sale` et `other` ne le permettent pas. */
export const RENT_PUBLISHING_MANDATE_TYPES = ['rental_management', 'letting', 'self_managed'] as const satisfies readonly MandateType[];

/** Image Open Graph : JPEG dédié, WhatsApp n'affichant pas toujours le WebP. */
export const OG_IMAGE = { width: 1200, height: 630, quality: 75, maxBytes: 150_000 } as const;

// ---------------------------------------------------------------- publication (règle 7, D14, D34)

/** Un mandat qui couvre la cible, avec ses autorisations en vigueur (`effectiveAuthorizations`). */
export interface PublishingMandate {
	type: MandateType;
	canPublish: boolean;
	/** La portée vise le bien entier (`mandate_scopes.unit_id` vide), et non une seule unité. */
	wholeProperty: boolean;
}

export interface RentTarget {
	operation: 'rent';
	unit: { recordStatus: RecordStatus; technicalStatus: TechnicalStatus; occupancy: Occupancy };
	/** Le bien a sa commune et son quartier (la vitrine les affiche). */
	propertyLocated: boolean;
}

export interface SaleTarget {
	operation: 'sale';
	property: { recordStatus: RecordStatus; operation: PropertyOperation };
}

export interface PublicationContext {
	target: RentTarget | SaleTarget;
	organization: { type: 'agency' | 'landlord'; verificationStatus: 'pending' | 'verified' | 'suspended' };
	/** `listings.publication` pour l'organisation (`features.isEnabled`). */
	publicationEnabled: boolean;
	/** Mandats de l'organisation qui couvrent la cible (unité ou bien entier). */
	mandates: readonly PublishingMandate[];
	photoCount: number;
	price: Fcfa | null;
}

/** Codes de ce qui manque pour publier, dans l'ordre où l'écran les liste. */
export const PUBLICATION_BLOCKERS = [
	'PUBLICATION_DISABLED',
	'SALE_RESERVED_TO_VERIFIED_AGENCIES',
	'NO_PUBLISHING_MANDATE',
	'NO_SALE_MANDATE',
	'PROPERTY_NOT_ACTIVE',
	'PROPERTY_NOT_FOR_SALE',
	'PROPERTY_NOT_LOCATED',
	'UNIT_NOT_ACTIVE',
	'UNIT_OCCUPIED',
	'UNIT_NOT_READY',
	'NOT_ENOUGH_PHOTOS',
	'PRICE_MISSING'
] as const;
export type PublicationBlocker = (typeof PUBLICATION_BLOCKERS)[number];

/** Ce qui manque pour publier ; une liste vide veut dire « publiable ». */
export function publicationBlockers(ctx: PublicationContext): PublicationBlocker[] {
	const out = new Set<PublicationBlocker>();
	if (!ctx.publicationEnabled) out.add('PUBLICATION_DISABLED');
	const t = ctx.target;
	if (t.operation === 'sale') {
		if (ctx.organization.type !== 'agency' || ctx.organization.verificationStatus !== 'verified')
			out.add('SALE_RESERVED_TO_VERIFIED_AGENCIES');
		if (!ctx.mandates.some((m) => m.type === 'sale' && m.canPublish && m.wholeProperty)) out.add('NO_SALE_MANDATE');
		if (t.property.recordStatus !== 'active') out.add('PROPERTY_NOT_ACTIVE');
		if (t.property.operation === 'rent') out.add('PROPERTY_NOT_FOR_SALE');
	} else {
		const allowed: readonly string[] = RENT_PUBLISHING_MANDATE_TYPES;
		if (!ctx.mandates.some((m) => allowed.includes(m.type) && m.canPublish)) out.add('NO_PUBLISHING_MANDATE');
		if (!t.propertyLocated) out.add('PROPERTY_NOT_LOCATED');
		if (t.unit.recordStatus !== 'active') out.add('UNIT_NOT_ACTIVE');
		if (t.unit.occupancy === 'occupied' || t.unit.occupancy === 'reserved') out.add('UNIT_OCCUPIED');
		// Les trois contrôles de la règle 13, détaillés pour la liste de ce qui manque ; le test les compare à isAvailable
		// sur toutes les combinaisons.
		if (t.unit.technicalStatus !== 'ready') out.add('UNIT_NOT_READY');
	}
	if (ctx.photoCount < MIN_LISTING_PHOTOS) out.add('NOT_ENOUGH_PHOTOS');
	if (ctx.price === null || ctx.price < 1) out.add('PRICE_MISSING');
	return PUBLICATION_BLOCKERS.filter((b) => out.has(b));
}

export type PublicationWarning = 'PRICE_DIFFERS_FROM_RENT';

/** Avertissements, jamais bloquants : prix affiché différent du loyer de l'unité (Q7). */
export function publicationWarnings(input: {
	operation: ListingOperation;
	price: Fcfa | null;
	unitRent: Fcfa | null;
}): PublicationWarning[] {
	if (input.operation === 'rent' && input.price !== null && input.unitRent !== null && input.price !== input.unitRent) {
		return ['PRICE_DIFFERS_FROM_RENT'];
	}
	return [];
}

/** Disponibilité affichée d'une location : maintenant, ou « Libre le » lendemain de la fin du bail en préavis. */
export type RentAvailability = { kind: 'now' } | { kind: 'from'; date: string };

export function rentAvailability(input: { occupancy: Occupancy; leaseEndsOn: string | null }): RentAvailability {
	if (input.occupancy === 'free') return { kind: 'now' };
	if (input.occupancy === 'notice') {
		if (!input.leaseEndsOn || !isIsoDate(input.leaseEndsOn)) throw new RangeError('Unité en préavis sans date de fin de bail.');
		return { kind: 'from', date: addDays(input.leaseEndsOn, 1) };
	}
	throw new RangeError(`Unité non disponible : ${input.occupancy}.`);
}

/** Vente : « Vente occupée » dès qu'une unité du bien a un bail (en cours, en préavis ou à venir). Aucun autre détail. */
export function saleOccupancy(occupancies: readonly Occupancy[]): 'vacant' | 'occupied' {
	return occupancies.some((o) => o !== 'free') ? 'occupied' : 'vacant';
}

// ---------------------------------------------------------------- statut de l'annonce

export const LISTING_TRANSITIONS: Record<ListingVisibility, readonly ListingVisibility[]> = {
	internal: ['pending_review', 'archived'],
	pending_review: ['published', 'internal', 'suspended', 'archived'],
	published: ['suspended', 'archived'],
	// Republication à la main seulement (Q2) : elle repasse par la préparation et par toutes les conditions.
	suspended: ['pending_review', 'archived'],
	archived: []
};

export function canTransitionListing(from: ListingVisibility, to: ListingVisibility): boolean {
	return LISTING_TRANSITIONS[from].includes(to);
}

/** Quatrième dimension du statut de l'unité (D14). Sans annonce, ou annonce interne : non publiée. */
export function unitListingStatus(listing: { visibility: ListingVisibility } | null): UnitListingStatus {
	switch (listing?.visibility) {
		case 'pending_review':
			return 'pending_review';
		case 'published':
			return 'published';
		case 'suspended':
			return 'suspended';
		case 'archived':
			return 'withdrawn';
		default:
			return 'not_published';
	}
}

const BLOCKER_SUSPENSION: Partial<Record<PublicationBlocker, SuspensionReason>> = {
	UNIT_OCCUPIED: 'unit_rented',
	UNIT_NOT_ACTIVE: 'unit_unavailable',
	UNIT_NOT_READY: 'unit_unavailable',
	PROPERTY_NOT_ACTIVE: 'unit_unavailable',
	PROPERTY_NOT_FOR_SALE: 'unit_unavailable',
	PROPERTY_NOT_LOCATED: 'unit_unavailable',
	NO_PUBLISHING_MANDATE: 'mandate_ended',
	NO_SALE_MANDATE: 'mandate_ended',
	SALE_RESERVED_TO_VERIFIED_AGENCIES: 'organization_not_eligible',
	NOT_ENOUGH_PHOTOS: 'photos_missing'
	// PUBLICATION_DISABLED : l'interrupteur masque sans suspendre. PRICE_MISSING : le prix ne change qu'à la main.
};

/** Cause de suspension la plus forte parmi ce qui manque, ou rien. */
export function suspensionReasonOf(blockers: readonly PublicationBlocker[]): SuspensionReason | null {
	const reasons = new Set(blockers.map((b) => BLOCKER_SUSPENSION[b]).filter((r): r is SuspensionReason => !!r));
	return SUSPENSION_REASONS.find((r) => reasons.has(r)) ?? null;
}

/** Mention publique d'une annonce suspendue : « Loué » ou « Indisponible ». */
export function publicSuspensionLabel(reason: SuspensionReason): 'rented' | 'unavailable' {
	return reason === 'unit_rented' ? 'rented' : 'unavailable';
}

export type ListingAction =
	{ kind: 'none' } | { kind: 'suspend'; reason: SuspensionReason } | { kind: 'archive'; reason: 'suspension_expired' };

/**
 * Ce que devient une annonce quand sa cible change (bail, état technique, mandat, photos, vérification) ou chaque
 * nuit. Une annonce en ligne ou en préparation qui n'est plus publiable est suspendue ; une annonce suspendue depuis
 * 30 jours est retirée ; rien n'est jamais remis en ligne ici.
 */
export function reconcileListing(
	state: { visibility: ListingVisibility; suspendedOn: string | null },
	ctx: PublicationContext,
	today: string
): ListingAction {
	if (state.visibility === 'published' || state.visibility === 'pending_review') {
		const reason = suspensionReasonOf(publicationBlockers(ctx));
		return reason ? { kind: 'suspend', reason } : { kind: 'none' };
	}
	if (state.visibility === 'suspended' && state.suspendedOn && daysBetween(state.suspendedOn, today) >= SUSPENSION_RETENTION_DAYS) {
		return { kind: 'archive', reason: 'suspension_expired' };
	}
	return { kind: 'none' };
}

/** La vitrine ne montre que les annonces publiées d'une organisation non suspendue dont l'interrupteur est ouvert. */
export function showcaseVisible(input: {
	visibility: ListingVisibility;
	publicationEnabled: boolean;
	organizationSuspended: boolean;
}): boolean {
	return input.visibility === 'published' && input.publicationEnabled && !input.organizationSuspended;
}

export interface ListingPoint {
	lat: number;
	lng: number;
	precision: 'exact' | 'neighborhood' | 'commune';
}

/**
 * Emplacement publié : le point pris sur place seulement si l'organisation a choisi la précision « exacte » ;
 * sinon le centre du quartier (ou de la commune). Le repère du bien n'est jamais publié (Q6).
 */
export function listingPublicPoint(input: {
	precision: LocationPrecision;
	gps: OptionalPoint | null;
	place: PlaceOfProperty;
}): ListingPoint {
	const g = input.gps;
	if (
		input.precision === 'exact' &&
		g &&
		typeof g.lat === 'number' &&
		Number.isFinite(g.lat) &&
		typeof g.lng === 'number' &&
		Number.isFinite(g.lng)
	) {
		return { lat: g.lat, lng: g.lng, precision: 'exact' };
	}
	return publicLocation(input.place);
}

// ---------------------------------------------------------------- référence et adresses

/** Alphabet de Crockford : sans I, L, O ni U, pour une référence dictée au téléphone. */
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REFERENCE_PATTERN = /^ZG-[0-9A-HJKMNP-TV-Z]{6}$/;

const webCrypto = (globalThis as unknown as { crypto: { getRandomValues<T extends Uint8Array>(array: T): T } }).crypto;

/** Référence publique d'une annonce (« ZG-7K4M2P ») : 30 bits aléatoires ; unicité garantie par la base. */
export function newListingReference(): string {
	const bytes = webCrypto.getRandomValues(new Uint8Array(6));
	let out = 'ZG-';
	for (const b of bytes) out += REFERENCE_ALPHABET[b & 31];
	return out;
}

export function isListingReference(value: string): boolean {
	return REFERENCE_PATTERN.test(value);
}

/** Texte → segment d'adresse : minuscules, sans accents, tirets ; coupé sur un mot entier. */
export function slugify(text: string, maxLength = 60): string {
	const slug = text
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (slug.length <= maxLength) return slug;
	const cut = slug.slice(0, maxLength + 1);
	const end = cut.lastIndexOf('-');
	return (end > 0 ? cut.slice(0, end) : slug.slice(0, maxLength)).replace(/-+$/g, '');
}

/** Adresse d'une annonce : `/annonce/<titre>-<référence>`. La référence suffit à la retrouver (titre changé : 301). */
export function listingPath(title: string, reference: string): string {
	const slug = slugify(title);
	const ref = reference.toLowerCase();
	return `/annonce/${slug ? `${slug}-${ref}` : ref}`;
}

const SEGMENT_PATTERN = /^(?:([a-z0-9]+(?:-[a-z0-9]+)*)-)?(zg-[0-9a-hjkmnp-tv-z]{6})$/;

/** Segment d'adresse → référence et titre ; `null` si le segment ne finit pas par une référence. */
export function parseListingSegment(segment: string): { reference: string; slug: string } | null {
	const m = SEGMENT_PATTERN.exec(segment);
	return m ? { reference: m[2]!.toUpperCase(), slug: m[1] ?? '' } : null;
}

/**
 * Mots que les adresses publiques des organisations ne prennent jamais : les routes du site, et ce qui pourrait le
 * devenir (Q9).
 */
export const RESERVED_PUBLIC_SLUGS = [
	'app',
	'espace',
	'admin',
	'annonce',
	'annonces',
	'agence',
	'agences',
	'louer',
	'acheter',
	'vendre',
	'recherche',
	'api',
	'media',
	'medias',
	'static',
	'assets',
	'fonts',
	'sitemap',
	'robots',
	'favicon',
	'manifest',
	'service-worker',
	'hors-ligne',
	'maintenance',
	'connexion',
	'inscription',
	'compte',
	'mot-de-passe',
	'recu',
	'releve',
	'aide',
	'contact',
	'mentions-legales',
	'confidentialite',
	'conditions',
	'cgu',
	'ziga',
	'www'
] as const;

/** Adresse publique d'une organisation (`/agence/<adresse>`). */
export const publicSlugSchema = z
	.string()
	.trim()
	.toLowerCase()
	.min(3, { error: 'L’adresse fait 3 caractères au moins.' })
	.max(60, { error: 'L’adresse fait 60 caractères au plus.' })
	.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, { error: 'Lettres sans accents, chiffres et tirets seulement, par exemple « faso-immo ».' })
	.refine((v) => !(RESERVED_PUBLIC_SLUGS as readonly string[]).includes(v), { error: 'Cette adresse est réservée par le site.' });

/** Présentation de l'organisation sur sa page publique ; vide : aucune. */
export const publicPresentationSchema = z
	.string()
	.trim()
	.max(1500, { error: 'La présentation fait 1 500 caractères au plus.' })
	.nullish()
	.transform((v) => (v ? v : null));

/** Lien WhatsApp avec un message pré-rempli ; `null` si le numéro est invalide. */
export function whatsappUrl(phone: string, text: string): string | null {
	const n = waNumber(phone);
	return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

// ---------------------------------------------------------------- recherche de la vitrine

export const SHOWCASE_PAGE_SIZE = 20;
export const SHOWCASE_MAX_BEDROOMS_FILTER = 10;

export interface ShowcaseFilters {
	communeId?: string;
	neighborhoodId?: string;
	/** Type d'unité (location) ou de bien (vente). */
	type?: string;
	budgetMax?: Fcfa;
	bedroomsMin?: number;
	furnished?: true;
}

export interface ShowcaseCursor {
	publishedAt: string;
	id: string;
}

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** Ce que la recherche lit d'une adresse (`URLSearchParams` dans le navigateur et dans Node). */
export interface QueryParams {
	get(name: string): string | null;
}

/** Codes d'un texte ASCII (le curseur ne contient qu'une date ISO et un identifiant). */
function asciiCodes(text: string): number[] {
	return [...text].map((ch) => ch.charCodeAt(0) & 0x7f);
}

/** Curseur de pagination : date de publication et identifiant, en base64url. */
export function encodeShowcaseCursor(c: ShowcaseCursor): string {
	return base64Url(Uint8Array.from(asciiCodes(`${c.publishedAt}|${c.id}`)));
}

const BASE64_URL_INDEX = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'].map((ch, i) => [ch, i]));

function fromBase64Url(text: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of text) {
		value = (value << 6) | BASE64_URL_INDEX.get(ch)!;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push((value >> bits) & 0xff);
		}
	}
	return Uint8Array.from(out);
}

/** Curseur reçu dans l'adresse : `null` s'il est invalide (jamais une erreur sur une page publique). */
export function decodeShowcaseCursor(token: string): ShowcaseCursor | null {
	if (token.length > 200) return null;
	const bytes = fromBase64Url(token);
	if (!bytes) return null;
	const [publishedAt, id, ...rest] = String.fromCharCode(...bytes).split('|');
	if (rest.length || !publishedAt || !id) return null;
	if (!INSTANT_PATTERN.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt)) || !isUuid(id)) return null;
	return { publishedAt, id };
}

/**
 * Paramètres de recherche de la vitrine (`commune`, `quartier`, `type`, `budget`, `chambres`, `meuble`, `apres`).
 * Une valeur invalide est ignorée, jamais une erreur : l'adresse vient d'un visiteur ou d'un lien partagé.
 */
export function parseShowcaseQuery(
	operation: ListingOperation,
	params: QueryParams
): { filters: ShowcaseFilters; cursor: ShowcaseCursor | null } {
	const filters: ShowcaseFilters = {};
	const commune = params.get('commune');
	if (commune && communeIdSchema.safeParse(commune).success) {
		filters.communeId = commune;
		const neighborhood = params.get('quartier');
		if (neighborhood && isUuid(neighborhood)) filters.neighborhoodId = neighborhood.toLowerCase();
	}
	const type = params.get('type');
	const types: readonly string[] = operation === 'rent' ? UNIT_TYPES : PROPERTY_TYPES;
	if (type && types.includes(type)) filters.type = type;
	const budget = params.get('budget')?.replace(/[\s  .]/g, '');
	if (budget && /^\d{1,15}$/.test(budget)) {
		const n = Number(budget);
		if (n >= 1 && Number.isSafeInteger(n)) filters.budgetMax = n;
	}
	const bedrooms = params.get('chambres');
	if (bedrooms && /^\d{1,2}$/.test(bedrooms)) {
		const n = Number(bedrooms);
		if (n >= 1 && n <= SHOWCASE_MAX_BEDROOMS_FILTER) filters.bedroomsMin = n;
	}
	if (operation === 'rent' && ['1', 'oui', 'true'].includes(params.get('meuble') ?? '')) filters.furnished = true;
	const after = params.get('apres');
	return { filters, cursor: after ? decodeShowcaseCursor(after) : null };
}

/** Forme canonique des paramètres (ordre fixe, valeurs normalisées) : adresse canonique et clé de cache. */
export function showcaseQueryString(filters: ShowcaseFilters, cursor?: ShowcaseCursor | null): string {
	const p: [string, string][] = [];
	if (filters.communeId) p.push(['commune', filters.communeId]);
	if (filters.neighborhoodId) p.push(['quartier', filters.neighborhoodId]);
	if (filters.type) p.push(['type', filters.type]);
	if (filters.budgetMax !== undefined) p.push(['budget', String(filters.budgetMax)]);
	if (filters.bedroomsMin !== undefined) p.push(['chambres', String(filters.bedroomsMin)]);
	if (filters.furnished) p.push(['meuble', '1']);
	if (cursor) p.push(['apres', encodeShowcaseCursor(cursor)]);
	return p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** Clé Redis d'une page de résultats ; la version de la vitrine change à chaque modification de la projection. */
export function showcaseCacheKey(
	operation: ListingOperation,
	filters: ShowcaseFilters,
	cursor: ShowcaseCursor | null,
	version: number
): string {
	return `showcase:v${version}:${operation}:${showcaseQueryString(filters, cursor)}`;
}

// ---------------------------------------------------------------- cache et purge

/** En-têtes de cache des pages publiques (Cloudflare lit `s-maxage`, le navigateur `max-age`). */
export const SHOWCASE_CACHE_CONTROL = {
	listing: 'public, max-age=60, s-maxage=900, stale-while-revalidate=3600',
	listRoot: 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
	listFiltered: 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
	agency: 'public, max-age=60, s-maxage=900, stale-while-revalidate=3600',
	gone: 'public, max-age=60, s-maxage=300',
	maintenance: 'public, max-age=0, s-maxage=60',
	sitemap: 'public, max-age=3600, s-maxage=3600',
	robots: 'public, max-age=86400, s-maxage=86400',
	media: 'public, max-age=31536000, immutable',
	private: 'no-store'
} as const;
export type ShowcaseCacheKind = keyof typeof SHOWCASE_CACHE_CONTROL;

/** Pages à purger quand une annonce change ou disparaît : la sienne, les listes racines, la page de l'agence. */
export function purgePaths(input: { listingPath: string; operation: ListingOperation; organizationSlug: string | null }): string[] {
	const out = [input.listingPath, '/', input.operation === 'rent' ? '/louer' : '/acheter'];
	if (input.organizationSlug) out.push(`/agence/${input.organizationSlug}`);
	return out;
}

// ---------------------------------------------------------------- schémas des annonces

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, { error: 'Texte trop long.' })
		.nullish()
		.transform((v) => (v ? v : null));

const photoIdsSchema = z
	.array(idSchema)
	.max(MAX_LISTING_PHOTOS, { error: `${MAX_LISTING_PHOTOS} photos au plus.` })
	.refine((ids) => new Set(ids).size === ids.length, { error: 'Une photo est choisie deux fois.' });

const listingFields = {
	title: z
		.string()
		.trim()
		.min(5, { error: 'Le titre fait 5 caractères au moins.' })
		.max(100, { error: 'Le titre fait 100 caractères au plus.' }),
	description: optionalText(4000),
	price: fcfaSchema.min(1, { error: 'Indiquez le prix.' }).nullable().default(null),
	locationPrecision: z.enum(LOCATION_PRECISIONS).default('neighborhood'),
	photoIds: photoIdsSchema.default([])
};

/** Création d'une annonce (état interne) : une unité pour une location, le bien entier pour une vente. */
export const createListingSchema = z.discriminatedUnion('operation', [
	z.strictObject({ id: idSchema, operation: z.literal('rent'), unitId: idSchema, ...listingFields }),
	z.strictObject({ id: idSchema, operation: z.literal('sale'), propertyId: idSchema, ...listingFields })
]);
export type CreateListingInput = z.input<typeof createListingSchema>;
export type CreateListingData = z.output<typeof createListingSchema>;

/** Modification : la cible et l'opération ne changent jamais. */
export const updateListingSchema = z.strictObject(patchShape(listingFields));
export type UpdateListingInput = z.input<typeof updateListingSchema>;

/** Demande de publication ; un bailleur y donne (ou non) son accord pour afficher son numéro (Q4). */
export const publishListingSchema = z.strictObject({ phoneVisible: z.boolean().optional() });

// ---------------------------------------------------------------- prospects

export const LEAD_SOURCES = ['form', 'whatsapp', 'call'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STATUSES = ['new', 'contacted', 'visit_planned', 'no_follow_up', 'converted'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** On avance ; un prospect clos (sans suite, converti) peut être rouvert ; jamais de retour à « nouveau ». */
export const LEAD_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
	new: ['contacted', 'visit_planned', 'no_follow_up', 'converted'],
	contacted: ['visit_planned', 'no_follow_up', 'converted'],
	visit_planned: ['contacted', 'no_follow_up', 'converted'],
	no_follow_up: ['contacted'],
	converted: ['contacted']
};

export function canTransitionLead(from: LeadStatus, to: LeadStatus): boolean {
	return LEAD_TRANSITIONS[from].includes(to);
}

/** Délai minimal pour remplir le formulaire (un robot envoie aussitôt) et âge maximal du jeton du formulaire. */
export const CONTACT_MIN_FILL_MS = 3_000;
export const CONTACT_TOKEN_MAX_AGE_MS = 6 * 3600_000;

/** Même numéro sur la même annonce en moins de 24 heures : le message rejoint le prospect existant. */
export const LEAD_DEDUP_HOURS = 24;

/** Limites de débit de la vitrine (Redis, par adresse IP et par numéro). */
export const SHOWCASE_RATE_LIMITS = {
	search: { limit: 60, windowSeconds: 60 },
	contactPerIp: { limit: 5, windowSeconds: 600 },
	contactPerPhone: { limit: 3, windowSeconds: 86_400 }
} as const;

const leadName = z.string().trim().min(2, { error: 'Indiquez votre nom.' }).max(80, { error: 'Nom trop long (80 caractères au plus).' });

/** Formulaire de contact de la vitrine. `website` est le champ piège, invisible pour une personne. */
export const contactFormSchema = z.object({
	name: leadName,
	phone: phoneSchema,
	message: optionalText(1000),
	website: z.string().max(200).default(''),
	token: z.string().min(1).max(200)
});
export type ContactFormData = z.output<typeof contactFormSchema>;

export type ContactVerdict = 'accepted' | 'honeypot' | 'too_fast' | 'expired';

/** Verdict anti-robots, sans service tiers : champ piège, délai minimal de saisie, jeton périmé. */
export function contactVerdict(input: { website: string; issuedAt: number; now: number }): ContactVerdict {
	if (input.website.trim() !== '') return 'honeypot';
	const age = input.now - input.issuedAt;
	if (age < CONTACT_MIN_FILL_MS) return 'too_fast';
	if (age > CONTACT_TOKEN_MAX_AGE_MS) return 'expired';
	return 'accepted';
}

export function isLeadDuplicate(
	existing: { phone: string; listingId: string | null; createdAt: Date },
	incoming: { phone: string; listingId: string | null; at: Date }
): boolean {
	if (!existing.listingId || existing.listingId !== incoming.listingId || existing.phone !== incoming.phone) return false;
	const elapsed = incoming.at.getTime() - existing.createdAt.getTime();
	return elapsed >= 0 && elapsed < LEAD_DEDUP_HOURS * 3600_000;
}

/** Prospect noté à la main (échange WhatsApp, appel) ; un clic sur WhatsApp n'en crée jamais. */
export const manualLeadSchema = z.strictObject({
	id: idSchema,
	listingId: idSchema.nullable(),
	source: z.enum(['whatsapp', 'call']),
	name: leadName,
	phone: phoneSchema,
	message: optionalText(1000)
});
export type ManualLeadData = z.output<typeof manualLeadSchema>;

export const updateLeadSchema = z.strictObject({
	status: z.enum(LEAD_STATUSES).optional(),
	assignedMemberId: idSchema.nullable().optional(),
	notes: z
		.string()
		.trim()
		.max(2000, { error: 'Notes trop longues (2 000 caractères au plus).' })
		.nullable()
		.transform((v) => (v ? v : null))
		.optional()
});
export type UpdateLeadData = z.output<typeof updateLeadSchema>;
