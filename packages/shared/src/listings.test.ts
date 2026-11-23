import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';
import { isAvailable, OCCUPANCIES, RECORD_STATUSES, TECHNICAL_STATUSES } from './properties.js';
import {
	ARCHIVE_REASONS,
	canTransitionLead,
	canTransitionListing,
	CONTACT_MIN_FILL_MS,
	CONTACT_TOKEN_MAX_AGE_MS,
	contactFormSchema,
	contactVerdict,
	createListingSchema,
	decodeShowcaseCursor,
	encodeShowcaseCursor,
	isLeadDuplicate,
	isListingReference,
	LEAD_DEDUP_HOURS,
	LEAD_STATUSES,
	LISTING_VISIBILITIES,
	listingPath,
	listingPublicPoint,
	manualLeadSchema,
	MIN_LISTING_PHOTOS,
	newListingReference,
	parseListingSegment,
	parseShowcaseQuery,
	publicationBlockers,
	publicationWarnings,
	publicPresentationSchema,
	publicSlugSchema,
	publicSuspensionLabel,
	purgePaths,
	RESERVED_PUBLIC_SLUGS,
	reconcileListing,
	rentAvailability,
	saleOccupancy,
	SHOWCASE_CACHE_CONTROL,
	showcaseCacheKey,
	showcaseQueryString,
	showcaseVisible,
	slugify,
	SUSPENSION_REASONS,
	SUSPENSION_RETENTION_DAYS,
	UNIT_LISTING_STATUSES,
	unitListingStatus,
	updateLeadSchema,
	updateListingSchema,
	whatsappUrl,
	type PublicationContext
} from './listings.js';

// ---------------------------------------------------------------- publication (règle 7, D14, D34)

const agency = { type: 'agency' as const, verificationStatus: 'verified' as const };
const rentMandate = { type: 'rental_management' as const, canPublish: true, wholeProperty: false };
const saleMandate = { type: 'sale' as const, canPublish: true, wholeProperty: true };

function rentCtx(
	over: Partial<PublicationContext> = {},
	unit: Partial<{ recordStatus: string; technicalStatus: string; occupancy: string }> = {}
) {
	return {
		target: {
			operation: 'rent',
			unit: { recordStatus: 'active', technicalStatus: 'ready', occupancy: 'free', ...unit },
			propertyLocated: true
		},
		organization: agency,
		publicationEnabled: true,
		mandates: [rentMandate],
		photoCount: 3,
		price: 75_000,
		...over
	} as PublicationContext;
}

function saleCtx(over: Partial<PublicationContext> = {}, property: Partial<{ recordStatus: string; operation: string }> = {}) {
	return {
		target: { operation: 'sale', property: { recordStatus: 'active', operation: 'sale', ...property } },
		organization: agency,
		publicationEnabled: true,
		mandates: [saleMandate],
		photoCount: 5,
		price: 45_000_000,
		...over
	} as PublicationContext;
}

describe('publicationBlockers : location (règle 7)', () => {
	it('toutes les conditions réunies : aucun blocage', () => {
		expect(publicationBlockers(rentCtx())).toEqual([]);
	});

	it('chaque condition manquante donne son motif', () => {
		expect(publicationBlockers(rentCtx({ publicationEnabled: false }))).toEqual(['PUBLICATION_DISABLED']);
		expect(publicationBlockers(rentCtx({ mandates: [] }))).toEqual(['NO_PUBLISHING_MANDATE']);
		expect(publicationBlockers(rentCtx({ photoCount: MIN_LISTING_PHOTOS - 1 }))).toEqual(['NOT_ENOUGH_PHOTOS']);
		expect(publicationBlockers(rentCtx({ price: null }))).toEqual(['PRICE_MISSING']);
		expect(publicationBlockers(rentCtx({ price: 0 }))).toEqual(['PRICE_MISSING']);
		expect(publicationBlockers(rentCtx({}, { recordStatus: 'draft' }))).toEqual(['UNIT_NOT_ACTIVE']);
		expect(publicationBlockers(rentCtx({}, { recordStatus: 'archived' }))).toEqual(['UNIT_NOT_ACTIVE']);
		expect(publicationBlockers(rentCtx({}, { occupancy: 'occupied' }))).toEqual(['UNIT_OCCUPIED']);
		expect(publicationBlockers(rentCtx({}, { occupancy: 'reserved' }))).toEqual(['UNIT_OCCUPIED']);
		expect(publicationBlockers(rentCtx({}, { technicalStatus: 'to_refurbish' }))).toEqual(['UNIT_NOT_READY']);
		expect(publicationBlockers(rentCtx({}, { technicalStatus: 'under_works' }))).toEqual(['UNIT_NOT_READY']);
		expect(publicationBlockers(rentCtx({}, { technicalStatus: 'unavailable' }))).toEqual(['UNIT_NOT_READY']);
		const unlocated = rentCtx();
		if (unlocated.target.operation === 'rent') unlocated.target.propertyLocated = false;
		expect(publicationBlockers(unlocated)).toEqual(['PROPERTY_NOT_LOCATED']);
	});

	it('plusieurs conditions manquantes : toutes listées, dans un ordre stable', () => {
		expect(
			publicationBlockers(rentCtx({ publicationEnabled: false, mandates: [], photoCount: 0, price: null }, { occupancy: 'occupied' }))
		).toEqual(['PUBLICATION_DISABLED', 'NO_PUBLISHING_MANDATE', 'UNIT_OCCUPIED', 'NOT_ENOUGH_PHOTOS', 'PRICE_MISSING']);
	});

	it('unité : bloquée exactement quand isAvailable dit non (règle 13, 48 combinaisons)', () => {
		const unitBlockers = ['UNIT_NOT_ACTIVE', 'UNIT_OCCUPIED', 'UNIT_NOT_READY'];
		for (const recordStatus of RECORD_STATUSES)
			for (const occupancy of OCCUPANCIES)
				for (const technicalStatus of TECHNICAL_STATUSES) {
					const blocked = publicationBlockers(rentCtx({}, { recordStatus, occupancy, technicalStatus })).some((b) =>
						unitBlockers.includes(b)
					);
					expect(blocked, `${recordStatus}/${occupancy}/${technicalStatus}`).toBe(
						!isAvailable({ recordStatus, occupancy, technicalStatus })
					);
				}
	});

	it('unité en préavis : publiable', () => {
		expect(publicationBlockers(rentCtx({}, { occupancy: 'notice' }))).toEqual([]);
	});

	it('mandats : gestion locative, mise en location et bailleur autorisent ; vente, autre ou sans autorisation, non', () => {
		for (const type of ['rental_management', 'letting', 'self_managed'] as const) {
			expect(publicationBlockers(rentCtx({ mandates: [{ type, canPublish: true, wholeProperty: false }] }))).toEqual([]);
			expect(publicationBlockers(rentCtx({ mandates: [{ type, canPublish: true, wholeProperty: true }] }))).toEqual([]);
		}
		for (const type of ['sale', 'other'] as const) {
			expect(publicationBlockers(rentCtx({ mandates: [{ type, canPublish: true, wholeProperty: true }] }))).toEqual([
				'NO_PUBLISHING_MANDATE'
			]);
		}
		expect(publicationBlockers(rentCtx({ mandates: [{ ...rentMandate, canPublish: false }] }))).toEqual(['NO_PUBLISHING_MANDATE']);
	});

	it('un bailleur particulier publie ses locations', () => {
		expect(
			publicationBlockers(
				rentCtx({
					organization: { type: 'landlord', verificationStatus: 'pending' },
					mandates: [{ type: 'self_managed', canPublish: true, wholeProperty: true }]
				})
			)
		).toEqual([]);
	});
});

describe('publicationBlockers : vente (D34)', () => {
	it('agence vérifiée, mandat de vente sur le bien entier : aucun blocage', () => {
		expect(publicationBlockers(saleCtx())).toEqual([]);
		expect(publicationBlockers(saleCtx({}, { operation: 'both' }))).toEqual([]);
	});

	it('réservée aux agences vérifiées : bailleur particulier et agence non vérifiée refusés', () => {
		const landlord = saleCtx({
			organization: { type: 'landlord', verificationStatus: 'verified' },
			mandates: [{ type: 'self_managed', canPublish: true, wholeProperty: true }]
		});
		expect(publicationBlockers(landlord)).toContain('SALE_RESERVED_TO_VERIFIED_AGENCIES');
		expect(publicationBlockers(saleCtx({ organization: { type: 'agency', verificationStatus: 'pending' } }))).toEqual([
			'SALE_RESERVED_TO_VERIFIED_AGENCIES'
		]);
		expect(publicationBlockers(saleCtx({ organization: { type: 'agency', verificationStatus: 'suspended' } }))).toEqual([
			'SALE_RESERVED_TO_VERIFIED_AGENCIES'
		]);
	});

	it('mandat de vente exigé, sur le bien entier, avec l’autorisation de publier', () => {
		expect(publicationBlockers(saleCtx({ mandates: [] }))).toEqual(['NO_SALE_MANDATE']);
		expect(publicationBlockers(saleCtx({ mandates: [{ ...saleMandate, wholeProperty: false }] }))).toEqual(['NO_SALE_MANDATE']);
		expect(publicationBlockers(saleCtx({ mandates: [{ ...saleMandate, canPublish: false }] }))).toEqual(['NO_SALE_MANDATE']);
		expect(publicationBlockers(saleCtx({ mandates: [{ ...rentMandate, wholeProperty: true }] }))).toEqual(['NO_SALE_MANDATE']);
	});

	it('bien actif et proposé à la vente ; les autres conditions restent exigées', () => {
		expect(publicationBlockers(saleCtx({}, { recordStatus: 'draft' }))).toEqual(['PROPERTY_NOT_ACTIVE']);
		expect(publicationBlockers(saleCtx({}, { operation: 'rent' }))).toEqual(['PROPERTY_NOT_FOR_SALE']);
		expect(publicationBlockers(saleCtx({ photoCount: 2 }))).toEqual(['NOT_ENOUGH_PHOTOS']);
		expect(publicationBlockers(saleCtx({ price: null }))).toEqual(['PRICE_MISSING']);
		expect(publicationBlockers(saleCtx({ publicationEnabled: false }))).toEqual(['PUBLICATION_DISABLED']);
	});

	it('bien occupé : publiable, affiché « Vente occupée »', () => {
		expect(saleOccupancy(['occupied', 'free'])).toBe('occupied');
		expect(saleOccupancy(['notice'])).toBe('occupied');
		expect(saleOccupancy(['reserved'])).toBe('occupied');
		expect(saleOccupancy(['free', 'free'])).toBe('vacant');
		expect(saleOccupancy([])).toBe('vacant');
	});
});

describe('publicationWarnings (Q7)', () => {
	it('prix différent du loyer de l’unité : avertissement, jamais un blocage', () => {
		expect(publicationWarnings({ operation: 'rent', price: 80_000, unitRent: 75_000 })).toEqual(['PRICE_DIFFERS_FROM_RENT']);
		expect(publicationWarnings({ operation: 'rent', price: 75_000, unitRent: 75_000 })).toEqual([]);
		expect(publicationWarnings({ operation: 'rent', price: 75_000, unitRent: null })).toEqual([]);
		expect(publicationWarnings({ operation: 'sale', price: 45_000_000, unitRent: null })).toEqual([]);
	});
});

describe('rentAvailability : libre maintenant, ou libre le…', () => {
	it('libre : maintenant', () => {
		expect(rentAvailability({ occupancy: 'free', leaseEndsOn: null })).toEqual({ kind: 'now' });
	});
	it('en préavis : libre le lendemain de la fin du bail', () => {
		expect(rentAvailability({ occupancy: 'notice', leaseEndsOn: '2026-12-31' })).toEqual({ kind: 'from', date: '2027-01-01' });
	});
	it('en préavis sans date de fin : refusé (une donnée manque)', () => {
		expect(() => rentAvailability({ occupancy: 'notice', leaseEndsOn: null })).toThrow();
	});
	it('occupée ou réservée : pas disponible', () => {
		expect(() => rentAvailability({ occupancy: 'occupied', leaseEndsOn: null })).toThrow();
	});
});

// ---------------------------------------------------------------- statut de l'annonce

describe('machine d’états de l’annonce', () => {
	it('demande de publication, préparation, publication', () => {
		expect(canTransitionListing('internal', 'pending_review')).toBe(true);
		expect(canTransitionListing('pending_review', 'published')).toBe(true);
		expect(canTransitionListing('internal', 'published')).toBe(false);
	});
	it('suspension, republication à la main, retrait', () => {
		expect(canTransitionListing('published', 'suspended')).toBe(true);
		expect(canTransitionListing('pending_review', 'suspended')).toBe(true);
		expect(canTransitionListing('suspended', 'pending_review')).toBe(true);
		expect(canTransitionListing('suspended', 'published')).toBe(false);
		expect(canTransitionListing('suspended', 'archived')).toBe(true);
		expect(canTransitionListing('published', 'archived')).toBe(true);
	});
	it('une annonce retirée ne revient jamais', () => {
		for (const to of LISTING_VISIBILITIES) expect(canTransitionListing('archived', to)).toBe(false);
	});
});

describe('quatrième dimension du statut de l’unité (D14)', () => {
	it('correspondance avec l’état de l’annonce', () => {
		expect(unitListingStatus(null)).toBe('not_published');
		expect(unitListingStatus({ visibility: 'internal' })).toBe('not_published');
		expect(unitListingStatus({ visibility: 'pending_review' })).toBe('pending_review');
		expect(unitListingStatus({ visibility: 'published' })).toBe('published');
		expect(unitListingStatus({ visibility: 'suspended' })).toBe('suspended');
		expect(unitListingStatus({ visibility: 'archived' })).toBe('withdrawn');
		expect([...UNIT_LISTING_STATUSES]).toEqual(['not_published', 'pending_review', 'published', 'suspended', 'withdrawn']);
	});
});

describe('reconcileListing : l’annonce suit l’unité', () => {
	const today = '2026-11-23';
	const published = { visibility: 'published' as const, suspendedOn: null };

	it('unité toujours disponible : rien ne change', () => {
		expect(reconcileListing(published, rentCtx(), today)).toEqual({ kind: 'none' });
		expect(reconcileListing(published, rentCtx({}, { occupancy: 'notice' }), today)).toEqual({ kind: 'none' });
	});

	it('bail signé : suspendue « Loué »', () => {
		const a = reconcileListing(published, rentCtx({}, { occupancy: 'reserved' }), today);
		expect(a).toEqual({ kind: 'suspend', reason: 'unit_rented' });
		expect(publicSuspensionLabel('unit_rented')).toBe('rented');
	});

	it('à remettre en état, en travaux, fiche archivée : suspendue « Indisponible »', () => {
		for (const u of [{ technicalStatus: 'to_refurbish' }, { technicalStatus: 'under_works' }, { recordStatus: 'archived' }]) {
			expect(reconcileListing(published, rentCtx({}, u), today)).toEqual({ kind: 'suspend', reason: 'unit_unavailable' });
		}
		expect(publicSuspensionLabel('unit_unavailable')).toBe('unavailable');
	});

	it('mandat expiré ou révoqué : suspendue', () => {
		expect(reconcileListing(published, rentCtx({ mandates: [] }), today)).toEqual({ kind: 'suspend', reason: 'mandate_ended' });
		expect(reconcileListing(published, saleCtx({ mandates: [] }), today)).toEqual({ kind: 'suspend', reason: 'mandate_ended' });
	});

	it('photos retirées sous le minimum : suspendue', () => {
		expect(reconcileListing(published, rentCtx({ photoCount: 2 }), today)).toEqual({ kind: 'suspend', reason: 'photos_missing' });
	});

	it('agence qui perd sa vérification : sa vente est suspendue', () => {
		expect(reconcileListing(published, saleCtx({ organization: { type: 'agency', verificationStatus: 'pending' } }), today)).toEqual({
			kind: 'suspend',
			reason: 'organization_not_eligible'
		});
	});

	it('vente d’un bien devenu occupé : rien ne change (« Vente occupée »)', () => {
		expect(reconcileListing(published, saleCtx(), today)).toEqual({ kind: 'none' });
	});

	it('interrupteur coupé : l’état interne ne change pas (l’annonce est masquée ailleurs)', () => {
		expect(reconcileListing(published, rentCtx({ publicationEnabled: false }), today)).toEqual({ kind: 'none' });
	});

	it('plusieurs causes : « Loué » l’emporte', () => {
		expect(
			reconcileListing(
				published,
				rentCtx({ mandates: [], photoCount: 0 }, { occupancy: 'occupied', technicalStatus: 'under_works' }),
				today
			)
		).toEqual({
			kind: 'suspend',
			reason: 'unit_rented'
		});
	});

	it('en préparation : suspendue de même', () => {
		expect(reconcileListing({ visibility: 'pending_review', suspendedOn: null }, rentCtx({}, { occupancy: 'occupied' }), today)).toEqual({
			kind: 'suspend',
			reason: 'unit_rented'
		});
	});

	it('suspendue : retirée au bout de 30 jours, jamais remise en ligne seule', () => {
		const suspended = { visibility: 'suspended' as const, suspendedOn: '2026-10-25' };
		expect(SUSPENSION_RETENTION_DAYS).toBe(30);
		expect(reconcileListing(suspended, rentCtx(), '2026-11-23')).toEqual({ kind: 'none' });
		expect(reconcileListing(suspended, rentCtx(), '2026-11-24')).toEqual({ kind: 'archive', reason: 'suspension_expired' });
		expect(reconcileListing(suspended, rentCtx({}, { occupancy: 'occupied' }), '2026-12-30')).toEqual({
			kind: 'archive',
			reason: 'suspension_expired'
		});
	});

	it('brouillon et annonce retirée : rien', () => {
		expect(reconcileListing({ visibility: 'internal', suspendedOn: null }, rentCtx({}, { occupancy: 'occupied' }), today)).toEqual({
			kind: 'none'
		});
		expect(reconcileListing({ visibility: 'archived', suspendedOn: null }, rentCtx({}, { occupancy: 'occupied' }), today)).toEqual({
			kind: 'none'
		});
	});

	it('listes fermées', () => {
		expect([...SUSPENSION_REASONS]).toEqual([
			'unit_rented',
			'unit_unavailable',
			'mandate_ended',
			'organization_not_eligible',
			'photos_missing'
		]);
		expect([...ARCHIVE_REASONS]).toEqual(['withdrawn', 'suspension_expired']);
	});
});

describe('showcaseVisible : ce que montre la vitrine', () => {
	it('publiée, interrupteur ouvert, organisation non suspendue', () => {
		expect(showcaseVisible({ visibility: 'published', publicationEnabled: true, organizationSuspended: false })).toBe(true);
	});
	it('interrupteur coupé pour l’organisation : masquée sans changer son état', () => {
		expect(showcaseVisible({ visibility: 'published', publicationEnabled: false, organizationSuspended: false })).toBe(false);
	});
	it('organisation suspendue : masquée', () => {
		expect(showcaseVisible({ visibility: 'published', publicationEnabled: true, organizationSuspended: true })).toBe(false);
	});
	it('autres états : jamais visibles', () => {
		for (const visibility of ['internal', 'pending_review', 'suspended', 'archived'] as const) {
			expect(showcaseVisible({ visibility, publicationEnabled: true, organizationSuspended: false })).toBe(false);
		}
	});
});

describe('listingPublicPoint : jamais le point du bien, sauf choix de l’organisation', () => {
	const place = { neighborhood: { lat: 12.4, lng: -1.5 }, commune: { lat: 12.37, lng: -1.53 } };
	const gps = { lat: 12.41234, lng: -1.51234 };
	it('précision « quartier » : centre du quartier, même si le bien a un point', () => {
		expect(listingPublicPoint({ precision: 'neighborhood', gps, place })).toEqual({ lat: 12.4, lng: -1.5, precision: 'neighborhood' });
	});
	it('quartier sans point : centre de la commune', () => {
		expect(listingPublicPoint({ precision: 'neighborhood', gps, place: { ...place, neighborhood: { lat: null, lng: null } } })).toEqual({
			lat: 12.37,
			lng: -1.53,
			precision: 'commune'
		});
	});
	it('précision « exacte » : le point du bien', () => {
		expect(listingPublicPoint({ precision: 'exact', gps, place })).toEqual({ ...gps, precision: 'exact' });
	});
	it('« exacte » sans point pris sur place : centre du quartier', () => {
		expect(listingPublicPoint({ precision: 'exact', gps: null, place })).toEqual({ lat: 12.4, lng: -1.5, precision: 'neighborhood' });
	});
});

// ---------------------------------------------------------------- référence, adresses

describe('référence et adresse de l’annonce', () => {
	it('référence courte, sans caractère ambigu', () => {
		const seen = new Set<string>();
		for (let i = 0; i < 500; i++) {
			const ref = newListingReference();
			expect(isListingReference(ref)).toBe(true);
			expect(ref).toMatch(/^ZG-[0-9A-HJKMNP-TV-Z]{6}$/);
			expect(ref).not.toMatch(/[ILOU]/);
			seen.add(ref);
		}
		expect(seen.size).toBeGreaterThan(495);
		expect(isListingReference('ZG-ILOU00')).toBe(false);
		expect(isListingReference('zg-7k4m2p')).toBe(false);
	});

	it('slugify : minuscules, sans accents, tirets, longueur bornée sur un mot entier', () => {
		expect(slugify('Appartement 2 chambres à Tampouy !')).toBe('appartement-2-chambres-a-tampouy');
		expect(slugify('  Villa — Ouaga 2000  ')).toBe('villa-ouaga-2000');
		expect(slugify('Écôle ÇA')).toBe('ecole-ca');
		const long = slugify('Très belle villa avec piscine et jardin arboré dans le quartier calme de Ouaga 2000', 40);
		expect(long.length).toBeLessThanOrEqual(40);
		expect(long.endsWith('-')).toBe(false);
		expect(long).toBe('tres-belle-villa-avec-piscine-et-jardin');
		expect(slugify('!!!')).toBe('');
	});

	it('adresse : titre puis référence ; la référence suffit à retrouver l’annonce', () => {
		const path = listingPath('Appartement 2 chambres, Tampouy', 'ZG-7K4M2P');
		expect(path).toBe('/annonce/appartement-2-chambres-tampouy-zg-7k4m2p');
		expect(parseListingSegment('appartement-2-chambres-tampouy-zg-7k4m2p')).toEqual({
			reference: 'ZG-7K4M2P',
			slug: 'appartement-2-chambres-tampouy'
		});
		// Titre changé : l'ancienne adresse retrouve l'annonce par sa référence (redirection 301 vers la nouvelle).
		expect(parseListingSegment('ancien-titre-zg-7k4m2p')?.reference).toBe('ZG-7K4M2P');
		expect(parseListingSegment('zg-7k4m2p')).toEqual({ reference: 'ZG-7K4M2P', slug: '' });
		expect(listingPath('!!!', 'ZG-7K4M2P')).toBe('/annonce/zg-7k4m2p');
		expect(parseListingSegment('appartement-2-chambres')).toBeNull();
		expect(parseListingSegment('x-zg-7k4m2i')).toBeNull();
		expect(parseListingSegment('X-ZG-7K4M2P')).toBeNull();
	});
});

describe('adresse publique de l’organisation (Q9)', () => {
	it('format : minuscules, chiffres, tirets', () => {
		expect(publicSlugSchema.parse('agence-faso-immo')).toBe('agence-faso-immo');
		expect(publicSlugSchema.parse('  Agence-Faso  ')).toBe('agence-faso');
		for (const bad of ['ab', 'agence faso', 'agence--faso', '-agence', 'agence-', 'agénce', 'a'.repeat(61)]) {
			expect(publicSlugSchema.safeParse(bad).success, bad).toBe(false);
		}
	});
	it('mots réservés des routes refusés', () => {
		for (const word of [
			'app',
			'espace',
			'admin',
			'annonce',
			'agence',
			'louer',
			'acheter',
			'api',
			'media',
			'sitemap.xml'.replace('.xml', '')
		]) {
			expect(RESERVED_PUBLIC_SLUGS).toContain(word);
			expect(publicSlugSchema.safeParse(word).success, word).toBe(false);
		}
	});
	it('présentation : 1 500 caractères au plus, vide autorisé', () => {
		expect(publicPresentationSchema.parse('  Agence fondée en 2010.  ')).toBe('Agence fondée en 2010.');
		expect(publicPresentationSchema.parse('')).toBeNull();
		expect(publicPresentationSchema.safeParse('a'.repeat(1501)).success).toBe(false);
	});
});

describe('whatsappUrl', () => {
	it('numéro sans « + », message encodé', () => {
		expect(whatsappUrl('+22670123456', 'Bonjour, annonce ZG-7K4M2P & visite ?')).toBe(
			'https://wa.me/22670123456?text=Bonjour%2C%20annonce%20ZG-7K4M2P%20%26%20visite%20%3F'
		);
	});
	it('numéro invalide : aucun lien', () => {
		expect(whatsappUrl('123', 'x')).toBeNull();
	});
});

// ---------------------------------------------------------------- recherche de la vitrine

describe('parseShowcaseQuery : paramètres tolérants, forme canonique', () => {
	const q = (s: string) => new URLSearchParams(s);
	const neighborhood = newId();

	it('location : commune, quartier, type, budget, chambres, meublé', () => {
		const { filters } = parseShowcaseQuery(
			'rent',
			q(`commune=ouagadougou&quartier=${neighborhood}&type=apartment&budget=75%20000&chambres=2&meuble=1`)
		);
		expect(filters).toEqual({
			communeId: 'ouagadougou',
			neighborhoodId: neighborhood,
			type: 'apartment',
			budgetMax: 75_000,
			bedroomsMin: 2,
			furnished: true
		});
	});

	it('valeurs invalides ignorées, jamais une erreur', () => {
		const { filters, cursor } = parseShowcaseQuery(
			'rent',
			q('commune=Ouaga%20!&quartier=abc&type=castle&budget=-5&chambres=99&meuble=peut-etre&apres=xxx')
		);
		expect(filters).toEqual({});
		expect(cursor).toBeNull();
	});

	it('quartier sans commune : ignoré', () => {
		expect(parseShowcaseQuery('rent', q(`quartier=${neighborhood}`)).filters).toEqual({});
	});

	it('vente : types de bien, pas de meublé', () => {
		expect(parseShowcaseQuery('sale', q('type=house&meuble=1')).filters).toEqual({ type: 'house' });
		expect(parseShowcaseQuery('sale', q('type=apartment')).filters).toEqual({});
	});

	it('forme canonique : ordre fixe, valeurs normalisées, clé de cache stable', () => {
		const a = parseShowcaseQuery('rent', q('meuble=1&budget=75000&commune=ouagadougou'));
		const b = parseShowcaseQuery('rent', q('commune=ouagadougou&budget=75%20000&meuble=oui&inconnu=1'));
		expect(showcaseQueryString(a.filters)).toBe('commune=ouagadougou&budget=75000&meuble=1');
		expect(showcaseQueryString(b.filters)).toBe(showcaseQueryString(a.filters));
		expect(showcaseCacheKey('rent', a.filters, null, 7)).toBe(showcaseCacheKey('rent', b.filters, null, 7));
		expect(showcaseCacheKey('rent', a.filters, null, 8)).not.toBe(showcaseCacheKey('rent', a.filters, null, 7));
		expect(showcaseCacheKey('sale', a.filters, null, 7)).not.toBe(showcaseCacheKey('rent', a.filters, null, 7));
		expect(showcaseQueryString({})).toBe('');
	});

	it('curseur : aller-retour, falsification refusée', () => {
		const c = { publishedAt: '2026-11-23T10:15:00.000Z', id: newId() };
		const token = encodeShowcaseCursor(c);
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeShowcaseCursor(token)).toEqual(c);
		expect(parseShowcaseQuery('rent', q(`apres=${token}`)).cursor).toEqual(c);
		expect(showcaseQueryString({ budgetMax: 5000 }, c)).toBe(`budget=5000&apres=${token}`);
		expect(decodeShowcaseCursor('bm9uLXZhbGlkZQ')).toBeNull();
		expect(decodeShowcaseCursor(encodeShowcaseCursor({ publishedAt: 'hier', id: c.id }))).toBeNull();
		expect(decodeShowcaseCursor(encodeShowcaseCursor({ publishedAt: c.publishedAt, id: 'pas-un-id' }))).toBeNull();
	});
});

// ---------------------------------------------------------------- cache et purge

describe('cache des pages publiques', () => {
	it('durées par type de page', () => {
		expect(SHOWCASE_CACHE_CONTROL.listing).toBe('public, max-age=60, s-maxage=900, stale-while-revalidate=3600');
		expect(SHOWCASE_CACHE_CONTROL.listRoot).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');
		expect(SHOWCASE_CACHE_CONTROL.listFiltered).toBe('public, max-age=30, s-maxage=60, stale-while-revalidate=120');
		expect(SHOWCASE_CACHE_CONTROL.agency).toBe('public, max-age=60, s-maxage=900, stale-while-revalidate=3600');
		expect(SHOWCASE_CACHE_CONTROL.gone).toBe('public, max-age=60, s-maxage=300');
		expect(SHOWCASE_CACHE_CONTROL.maintenance).toBe('public, max-age=0, s-maxage=60');
		expect(SHOWCASE_CACHE_CONTROL.media).toBe('public, max-age=31536000, immutable');
		expect(SHOWCASE_CACHE_CONTROL.private).toBe('no-store');
	});

	it('purge d’une annonce : sa page, les listes racines, la page de l’agence', () => {
		expect(purgePaths({ listingPath: '/annonce/villa-zg-7k4m2p', operation: 'sale', organizationSlug: 'faso-immo' })).toEqual([
			'/annonce/villa-zg-7k4m2p',
			'/',
			'/acheter',
			'/agence/faso-immo'
		]);
		expect(purgePaths({ listingPath: '/annonce/studio-zg-7k4m2p', operation: 'rent', organizationSlug: null })).toEqual([
			'/annonce/studio-zg-7k4m2p',
			'/',
			'/louer'
		]);
	});
});

// ---------------------------------------------------------------- schémas des annonces

describe('schémas des annonces', () => {
	const photos = [newId(), newId(), newId()];
	it('location : une unité ; vente : un bien', () => {
		const rent = createListingSchema.parse({
			id: newId(),
			operation: 'rent',
			unitId: newId(),
			title: 'Studio meublé à Tampouy',
			price: 50_000,
			photoIds: photos
		});
		expect(rent.locationPrecision).toBe('neighborhood');
		expect(rent.description).toBeNull();
		expect(
			createListingSchema.safeParse({ id: newId(), operation: 'rent', propertyId: newId(), title: 'Studio meublé', price: 1, photoIds: [] })
				.success
		).toBe(false);
		expect(
			createListingSchema.safeParse({
				id: newId(),
				operation: 'sale',
				propertyId: newId(),
				title: 'Villa à vendre',
				price: 1,
				photoIds: []
			}).success
		).toBe(true);
	});
	it('prix entier en FCFA, au moins 1', () => {
		const base = { id: newId(), operation: 'rent', unitId: newId(), title: 'Studio meublé', photoIds: [] };
		expect(createListingSchema.safeParse({ ...base, price: 0 }).success).toBe(false);
		expect(createListingSchema.safeParse({ ...base, price: 50_000.5 }).success).toBe(false);
		expect(createListingSchema.safeParse({ ...base, price: null }).success).toBe(true);
	});
	it('photos : 15 au plus, sans doublon', () => {
		const base = { id: newId(), operation: 'rent', unitId: newId(), title: 'Studio meublé', price: 1 };
		expect(createListingSchema.safeParse({ ...base, photoIds: Array.from({ length: 16 }, () => newId()) }).success).toBe(false);
		expect(createListingSchema.safeParse({ ...base, photoIds: [photos[0], photos[0]] }).success).toBe(false);
	});
	it('modification : seulement les champs envoyés, ni cible ni opération', () => {
		expect(updateListingSchema.parse({ price: 60_000 })).toEqual({ price: 60_000 });
		expect(updateListingSchema.safeParse({ unitId: newId() }).success).toBe(false);
		expect(updateListingSchema.safeParse({ operation: 'sale' }).success).toBe(false);
	});
});

// ---------------------------------------------------------------- prospects

describe('prospects : statuts', () => {
	it('liste fermée', () => {
		expect([...LEAD_STATUSES]).toEqual(['new', 'contacted', 'visit_planned', 'no_follow_up', 'converted']);
	});
	it('on avance, on peut rouvrir un prospect clos, jamais revenir à « nouveau »', () => {
		expect(canTransitionLead('new', 'contacted')).toBe(true);
		expect(canTransitionLead('contacted', 'visit_planned')).toBe(true);
		expect(canTransitionLead('visit_planned', 'converted')).toBe(true);
		expect(canTransitionLead('new', 'no_follow_up')).toBe(true);
		expect(canTransitionLead('no_follow_up', 'contacted')).toBe(true);
		expect(canTransitionLead('converted', 'contacted')).toBe(true);
		for (const from of LEAD_STATUSES) expect(canTransitionLead(from, 'new')).toBe(false);
		expect(canTransitionLead('contacted', 'contacted')).toBe(false);
	});
});

describe('formulaire de contact', () => {
	const ok = { name: '  Awa Ouédraogo ', phone: '70 12 34 56', message: ' Je souhaite visiter. ', website: '', token: '1732350000000.abc' };
	it('nom, téléphone en E.164, message facultatif', () => {
		expect(contactFormSchema.parse(ok)).toEqual({
			name: 'Awa Ouédraogo',
			phone: '+22670123456',
			message: 'Je souhaite visiter.',
			website: '',
			token: '1732350000000.abc'
		});
		expect(contactFormSchema.parse({ ...ok, message: '' }).message).toBeNull();
		expect(contactFormSchema.safeParse({ ...ok, phone: '123' }).success).toBe(false);
		expect(contactFormSchema.safeParse({ ...ok, name: 'A' }).success).toBe(false);
		expect(contactFormSchema.safeParse({ ...ok, message: 'x'.repeat(1001) }).success).toBe(false);
	});

	it('champ piège rempli : envoi d’un robot', () => {
		const now = 1_000_000;
		expect(contactVerdict({ website: 'http://spam', issuedAt: now - 10_000, now })).toBe('honeypot');
	});
	it('envoyé trop vite, ou jeton trop ancien', () => {
		const now = 10_000_000;
		expect(contactVerdict({ website: '', issuedAt: now - (CONTACT_MIN_FILL_MS - 1), now })).toBe('too_fast');
		expect(contactVerdict({ website: '', issuedAt: now - CONTACT_MIN_FILL_MS, now })).toBe('accepted');
		expect(contactVerdict({ website: '', issuedAt: now - CONTACT_TOKEN_MAX_AGE_MS - 1, now })).toBe('expired');
		expect(contactVerdict({ website: '', issuedAt: now + 60_000, now })).toBe('too_fast');
	});

	it('même numéro sur la même annonce en moins de 24 heures : doublon', () => {
		const listingId = newId();
		const t = Date.parse('2026-11-23T10:00:00Z');
		const existing = { phone: '+22670123456', listingId, createdAt: new Date(t) };
		expect(LEAD_DEDUP_HOURS).toBe(24);
		expect(isLeadDuplicate(existing, { phone: '+22670123456', listingId, at: new Date(t + 23 * 3600_000) })).toBe(true);
		expect(isLeadDuplicate(existing, { phone: '+22670123456', listingId, at: new Date(t + 24 * 3600_000) })).toBe(false);
		expect(isLeadDuplicate(existing, { phone: '+22670123457', listingId, at: new Date(t) })).toBe(false);
		expect(isLeadDuplicate(existing, { phone: '+22670123456', listingId: newId(), at: new Date(t) })).toBe(false);
	});
});

describe('prospect noté à la main, modification', () => {
	it('WhatsApp ou appel seulement ; le formulaire vient de la vitrine', () => {
		const base = { id: newId(), listingId: newId(), name: 'Issa Kaboré', phone: '+22676000000' };
		expect(manualLeadSchema.parse({ ...base, source: 'whatsapp' }).source).toBe('whatsapp');
		expect(manualLeadSchema.parse({ ...base, source: 'call', listingId: null }).listingId).toBeNull();
		expect(manualLeadSchema.safeParse({ ...base, source: 'form' }).success).toBe(false);
	});
	it('modification : statut, agent affecté, notes', () => {
		const agent = newId();
		expect(updateLeadSchema.parse({ status: 'contacted', assignedMemberId: agent, notes: ' Rappeler lundi ' })).toEqual({
			status: 'contacted',
			assignedMemberId: agent,
			notes: 'Rappeler lundi'
		});
		expect(updateLeadSchema.parse({ assignedMemberId: null })).toEqual({ assignedMemberId: null });
		expect(updateLeadSchema.safeParse({ phone: '+22670000000' }).success).toBe(false);
		expect(updateLeadSchema.safeParse({ status: 'perdu' }).success).toBe(false);
	});
});
