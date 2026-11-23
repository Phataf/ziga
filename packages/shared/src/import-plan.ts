/**
 * Import Excel (lot 11) : plan d'import, calculé à la prévisualisation et recalculé à l'exécution. Fonction pure : les
 * onglets lus et ce qui existe déjà dans l'organisation (fiches, référentiel des quartiers) → ce qui sera créé, avec
 * chaque ligne écartée et sa raison. L'exécution (API) passe ensuite par les services des modules, sans rien décider.
 *
 * Règles (réponses du porteur au plan, `docs/JOURNAL-LOTS.md`, lot 11) :
 * - une ligne en erreur est écartée, et ce qui en dépend l'est aussi, en cascade (« Ligne 14 de Baux écartée :
 *   l'unité B-01-A2 est en erreur ») ;
 * - mandats (règle 12) : dans l'onglet Biens ; les biens d'un même propriétaire aux mêmes conditions forment un seul
 *   mandat ; un bail importé exige un mandat de gestion locative ; bailleur particulier : gestion directe ;
 * - unités (règle 13) : l'occupation n'est jamais lue ; état technique « prête » avec un bail importé, sinon
 *   « à remettre en état » (motif « Import : état à vérifier ») ;
 * - baux (D24, D25) : paramètres légaux par défaut (absents du plan) ; échéances à partir de la date de bascule ; un
 *   bail échu sans congé passe à durée indéterminée, sa date de fin gardée pour information ; un bail terminé est
 *   ignoré ; un bail qui commence après aujourd'hui est réservé ; l'avance d'un bail commencé avant la bascule est
 *   sans objet ;
 * - cautions (D33, règle 14) : détenteur, montant convenu et reçu (vide : en entier), date du versement (vide : début
 *   du bail) ; au-delà de deux mois du loyer actuel, avertissement ;
 * - soldes d'ouverture : exigibles à la date de bascule ; négatif refusé ;
 * - doublons : même nom et même numéro → une seule fiche, ou la fiche existante proposée ; même numéro, autre nom →
 *   deux fiches, avec un avertissement (colocataires, famille) ;
 * - quartiers : rapprochés du référentiel, avec suggestions ; jamais créés ; une correction vaut pour toutes les
 *   lignes de même orthographe.
 */
import { formatDate } from './dates.js';
import { labelKey, type CellValue } from './import-values.js';
import {
	importSheet,
	IMPORT_SHEET_KEYS,
	IMPORT_SHEET_NAMES,
	type ImportField,
	type ImportSheetInput,
	type ImportSheetKey
} from './import-template.js';
import { makeIssue, readImportRows, type ImportIssue, type ImportRow } from './import-rows.js';
import { LEGAL_LEASE_DEFAULTS } from './leases.js';
import { formatFcfa } from './money.js';
import type { OrganizationType } from './permissions.js';
import { anniversaryStart, endOnFromDuration, type RentBillingMode } from './rent-schedule.js';

export type { ImportIssue } from './import-rows.js';

/** Motif de l'état technique d'une unité libre importée (réponse du porteur). */
export const IMPORT_TECHNICAL_REASON = 'Import : état à vérifier';

export interface ImportContext {
	organizationType: OrganizationType;
	/** Date de bascule : une par import, choisie à l'envoi, jamais dans le futur (réponse 1). */
	switchOn: string;
	today: string;
	/** Découpage des loyers de l'organisation (`rent_billing_mode`). */
	billingMode: RentBillingMode;
	existing: {
		owners: readonly { id: string; name: string; phone: string | null }[];
		tenants: readonly { id: string; fullName: string; phone: string | null }[];
		communes: readonly { id: string; name: string }[];
		neighborhoods: readonly { id: string; communeId: string; name: string }[];
	};
	choices?: {
		/** Clé d'un lieu (`PlaceResolution.key`) → quartier choisi, ou null : sans quartier. */
		places?: Record<string, string | null>;
		/** Clé d'un rapprochement (`MatchProposal.key`) → fiche existante, ou null : nouvelle fiche. */
		matches?: Record<string, string | null>;
		/**
		 * Cautions dont le montant reçu est vide (inconnu, réponse du porteur après l'étape 1) : un seul choix pour toutes,
		 * « versée en entier » (`full`) ou « à compléter » (`to_complete`). Sans ce choix, l'exécution est refusée.
		 */
		depositReceived?: 'full' | 'to_complete';
	};
}

export interface PlannedOwner {
	row: number;
	ref: string;
	data: {
		type: 'person' | 'company' | 'group';
		name: string;
		phone: string;
		email: string | null;
		address: string | null;
		representative: { name: string; phone: string } | null;
		notes: string | null;
	};
	existingId: string | null;
}

export interface PlannedMandate {
	ownerRef: string;
	rows: number[];
	propertyRefs: string[];
	type: 'rental_management' | 'letting' | 'sale' | 'other';
	terms: {
		startsOn: string;
		endsOn: string | null;
		commission:
			{ basis: 'percent_of_collected'; rateBp: number } | { basis: 'fixed_per_month' | 'fixed_per_operation'; amount: number } | null;
		canPublish: boolean;
		canTakePhotos: boolean;
		canCollectFunds: boolean;
		canSignLeases: boolean;
	};
}

export interface PlannedProperty {
	row: number;
	ref: string;
	ownerRef: string | null;
	data: {
		type: string;
		name: string;
		communeId: string | null;
		neighborhoodId: string | null;
		addressHint: string | null;
		notes: string | null;
	};
}

export interface PlannedUnit {
	row: number;
	ref: string;
	propertyRef: string;
	data: {
		type: string;
		label: string;
		rooms: { bedrooms: number; livingRooms: number; bathrooms: number };
		rent: number | null;
		charges: number | null;
	};
	technicalStatus: 'ready' | 'to_refurbish' | 'under_works' | 'unavailable';
	technicalReason: string | null;
}

export interface PlannedTenant {
	row: number;
	/** Clé interne du plan (les baux la désignent). */
	key: string;
	ref: string | null;
	data: {
		civility: 'mr' | 'mrs' | 'miss' | null;
		fullName: string;
		phone: string | null;
		secondaryPhone: string | null;
		profession: string | null;
		nationality: string | null;
		emergencyContactName: string | null;
		emergencyContactPhone: string | null;
		notes: string | null;
	};
	existingId: string | null;
}

/** Termes du bail : seuls les paramètres écrits dans le fichier y figurent ; les autres prennent les valeurs légales. */
export interface PlannedLeaseTerms {
	startsOn: string;
	endsOn: string | null;
	durationMonths: number | null;
	duesStartOn: string | null;
	rent: number;
	charges: number;
	advanceMonths: number;
	lessorType: 'owner' | 'organization';
	dueDay?: number;
	noticeTenantFixedTermMonths?: number;
	noticeTenantOpenEndedMonths?: number;
	noticeLessorFixedTermMonths?: number;
	noticeLessorOpenEndedMonths?: number;
	renewalMode?: 'open_ended' | 'same_duration';
	penaltyRateBp?: number;
	penaltyGraceDays?: number;
	penaltyBeneficiary?: 'organization' | 'owner';
	depositRefundDays?: number;
}

export interface PlannedLease {
	row: number;
	ref: string;
	unitRef: string;
	tenantKey: string;
	/** `active` : en vigueur (début passé) ; `signed` : réservé (commence après aujourd'hui). */
	status: 'active' | 'signed';
	terms: PlannedLeaseTerms;
	/** Fin d'origine d'un bail échu passé à durée indéterminée (réponse 3). */
	originalEndsOn: string | null;
}

export interface PlannedDeposit {
	row: number;
	leaseRef: string;
	type: 'security_deposit' | 'utilities_guarantee';
	agreedAmount: number;
	/** Null : montant reçu vide, en attente du choix unique (`ImportContext.choices.depositReceived`). */
	receivedAmount: number | null;
	receivedOn: string | null;
	/** Complément attendu (montant convenu moins montant reçu) ; null tant que le montant reçu est inconnu. */
	outstanding: number | null;
	holder: 'organization' | 'owner';
}

export interface PlannedOpeningBalance {
	row: number;
	leaseRef: string;
	amount: number;
	dueOn: string;
}

export interface PlaceSuggestion {
	id: string;
	name: string;
	communeName: string;
}

export interface PlaceResolution {
	key: string;
	commune: string | null;
	neighborhood: string;
	communeId: string | null;
	neighborhoodId: string | null;
	/** `none` : la personne a choisi d'importer sans quartier. */
	status: 'matched' | 'corrected' | 'unresolved' | 'none';
	suggestions: PlaceSuggestion[];
	rows: number[];
}

export interface MatchProposal {
	sheet: 'owners' | 'tenants';
	row: number;
	key: string;
	existingId: string;
	existingName: string;
	chosen: 'existing' | 'new';
}

/** Raison qui refuse l'exécution tant qu'elle n'est pas levée (choix à faire, date de bascule refusée). */
export interface ImportBlocker {
	code: 'DEPOSIT_RECEIVED_UNKNOWN' | 'SWITCH_DATE_FUTURE' | 'SWITCH_DATE_FIRST_OF_MONTH';
	message: string;
}

export interface ImportPlan {
	issues: ImportIssue[];
	/** Vide : l'exécution est possible. */
	blockers: ImportBlocker[];
	/** Lignes qui attendent un choix de la personne (Cautions : montant reçu vide). */
	pending: { depositsWithoutReceived: number[] };
	owners: PlannedOwner[];
	mandates: PlannedMandate[];
	properties: PlannedProperty[];
	units: PlannedUnit[];
	tenants: PlannedTenant[];
	leases: PlannedLease[];
	deposits: PlannedDeposit[];
	openingBalances: PlannedOpeningBalance[];
	places: PlaceResolution[];
	matches: MatchProposal[];
	summary: { newUnits: number; leases: number; leasesWithOpeningBalance: number; depositsAboveCap: number };
}

// ---------------------------------------------------------------- outils

/** Comparaison de noms : sans accents, casse ni ponctuation. */
const nameKey = (s: string) => labelKey(s);
/** Comparaison de lieux : en plus, sans espaces ni tirets (« Ouaga2000 » = « Ouaga 2000 »). */
const placeKey = (s: string) => labelKey(s).replace(/ /g, '');
const refKey = (s: string) => labelKey(s);

/** Distance d'édition (transpositions comprises) entre deux clés. */
export function editDistance(a: string, b: string): number {
	const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
	for (let j = 0; j <= b.length; j++) d[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
			d[i]![j] = v;
		}
	}
	return d[a.length]![b.length]!;
}

/**
 * Première échéance d'un bail repris (réponse 1) : la date de bascule, ou, en facturation à la date anniversaire, la
 * première date anniversaire du bail à la bascule ou après.
 */
/** Date de bascule proposée : le 1er du mois en cours (réponse 1). */
export function defaultSwitchOn(today: string): string {
	return `${today.slice(0, 7)}-01`;
}

/**
 * Date de bascule refusée (réponses 1 et 3) : jamais dans le futur ; le 1er d'un mois quand l'organisation facture le
 * premier mois en entier (sinon la première échéance couvrirait de nouveau ce que le solde d'ouverture couvre déjà).
 */
export function switchDateIssue(switchOn: string, today: string, mode: RentBillingMode): ImportBlocker | null {
	if (switchOn > today) return { code: 'SWITCH_DATE_FUTURE', message: 'La date de bascule ne peut pas être dans le futur.' };
	if (mode === 'calendar_full_first' && !switchOn.endsWith('-01')) {
		return {
			code: 'SWITCH_DATE_FIRST_OF_MONTH',
			message: 'Votre organisation facture le premier mois en entier : la date de bascule est le 1er d’un mois.'
		};
	}
	return null;
}

export function importedDuesStartOn(startsOn: string, switchOn: string, mode: RentBillingMode): string {
	if (mode !== 'anniversary') return switchOn;
	const [sy, sm] = startsOn.split('-').map(Number) as [number, number];
	const [y, m] = switchOn.split('-').map(Number) as [number, number];
	for (let k = Math.max(0, (y - sy) * 12 + (m - sm) - 1); ; k++) {
		const d = anniversaryStart(startsOn, k);
		if (d >= switchOn) return d;
	}
}

type Status = 'ok' | 'error' | 'skipped' | 'ended';

interface Tracked<T> {
	row: number;
	status: Status;
	planned?: T;
}

type MandateDraft = PlannedMandate['terms'] & { type: PlannedMandate['type'] };
type TrackedProperty = Tracked<PlannedProperty> & { mandate?: MandateDraft };
/** `technicalDefault` : colonne vide, état fixé après les baux. */
type TrackedUnit = Tracked<PlannedUnit> & { property?: TrackedProperty; technicalDefault?: boolean };
type TrackedTenant = Tracked<PlannedTenant> & { ref: string | null; name: string | null; merged?: boolean };
type TrackedLease = Tracked<PlannedLease> & { unitKey: string | null; ref: string | null; unit?: TrackedUnit };

const sheetName = (k: ImportSheetKey) => IMPORT_SHEET_NAMES[k];

// ---------------------------------------------------------------- plan

export function planImport(sheets: Partial<Record<ImportSheetKey, ImportSheetInput>>, ctx: ImportContext): ImportPlan {
	const type = ctx.organizationType;
	const agency = type === 'agency';
	const issues: ImportIssue[] = [];
	const def = (k: ImportSheetKey) => importSheet(k, type);
	const field = (k: ImportSheetKey, key: string): ImportField => def(k).fields.find((f) => f.key === key)!;
	const issue = (
		k: ImportSheetKey,
		row: number,
		fieldKey: string | null,
		severity: ImportIssue['severity'],
		code: string,
		text: string,
		value: CellValue | null = null
	) => issues.push(makeIssue(k, row, fieldKey ? field(k, fieldKey) : null, severity, code, text, value));
	const error = (k: ImportSheetKey, row: ImportRow, fieldKey: string | null, text: string) =>
		issue(k, row.row, fieldKey, 'error', 'INVALID', text, fieldKey ? (row.cells[fieldKey] ?? null) : null);
	const read = (k: ImportSheetKey, messages?: Record<string, Record<string, string>>) => {
		const input = sheets[k];
		if (!input) return [] as ImportRow[];
		const r = readImportRows(def(k), input, { messages });
		issues.push(...r.issues);
		return r.rows;
	};
	const rowHasError = (k: ImportSheetKey, row: number) => issues.some((i) => i.sheet === k && i.row === row && i.severity === 'error');
	const skip = (k: ImportSheetKey, row: number, text: string, code = 'DEPENDENCY_REJECTED') =>
		issues.push({ ...makeIssue(k, row, null, 'skipped', code, text), message: `Ligne ${row} de ${sheetName(k)} ${text}` });
	/** Texte de la cascade : « écartée : l'unité B-01-A est en erreur (Unités, ligne 2). » */
	const because = (what: string, feminine: boolean, dep: Tracked<unknown>, depSheet: ImportSheetKey) =>
		`écartée : ${what} ${dep.status === 'error' ? 'est en erreur' : feminine ? 'est écartée' : 'est écarté'} (${sheetName(depSheet)}, ligne ${dep.row}).`;
	const v = <T>(row: ImportRow, key: string) => row.values[key] as T | null;
	const shortNotice = (row: ImportRow, key: string, months: number, legal: number) =>
		issue(
			'leases',
			row.row,
			key,
			'warning',
			'NOTICE_SHORTER_THAN_LAW',
			`${months} mois, plus court que le préavis prévu par la loi pour ce bail (${legal} mois) ; vérifiez le contrat.`,
			row.cells[key] ?? null
		);
	const choice = (key: string) => ctx.choices?.matches?.[key];

	// ------------------------------------------------ propriétaires
	const owners = new Map<string, Tracked<PlannedOwner>>();
	const ownerByName = new Map<string, string[]>();
	const matches: MatchProposal[] = [];
	if (agency) {
		for (const row of read('owners')) {
			const ref = v<string>(row, 'ref');
			if (ref && owners.has(refKey(ref))) {
				error('owners', row, 'ref', `la référence ${ref} est déjà utilisée (Propriétaires, ligne ${owners.get(refKey(ref))!.row}).`);
			}
			const ownerType = v<PlannedOwner['data']['type']>(row, 'type');
			const repName = v<string>(row, 'representativeName');
			const repPhone = v<string>(row, 'representativePhone');
			if (ownerType === 'group' && (!repName || !repPhone) && !rowHasError('owners', row.row)) {
				error(
					'owners',
					row,
					repName ? 'representativePhone' : 'representativeName',
					'indiquez le représentant du groupe d’indivisaires (nom et téléphone).'
				);
			}
			if (ownerType && ownerType !== 'group' && (repName || repPhone)) {
				error('owners', row, 'representativeName', 'seul un groupe d’indivisaires a un représentant ; videz cette colonne.');
			}
			const email = v<string>(row, 'email');
			if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
				error('owners', row, 'email', 'adresse e-mail invalide, par exemple nom@exemple.com.');
			const tracked: Tracked<PlannedOwner> = { row: row.row, status: rowHasError('owners', row.row) ? 'error' : 'ok' };
			if (ref && !owners.has(refKey(ref))) owners.set(refKey(ref), tracked);
			const name = v<string>(row, 'name');
			if (name) ownerByName.set(nameKey(name), [...(ownerByName.get(nameKey(name)) ?? []), ref ?? '']);
			if (tracked.status !== 'ok') continue;
			const phone = v<string>(row, 'phone')!;
			const data: PlannedOwner['data'] = {
				type: ownerType!,
				name: name!,
				phone,
				email: email ? email.toLowerCase() : null,
				address: v<string>(row, 'address'),
				representative: ownerType === 'group' ? { name: repName!, phone: repPhone! } : null,
				notes: v<string>(row, 'notes')
			};
			const existing = ctx.existing.owners.find((o) => o.phone === phone && nameKey(o.name) === nameKey(data.name));
			let existingId: string | null = null;
			if (existing) {
				const key = `owners:${row.row}`;
				const chosen = choice(key) === null ? 'new' : 'existing';
				existingId = chosen === 'existing' ? existing.id : null;
				matches.push({ sheet: 'owners', row: row.row, key, existingId: existing.id, existingName: existing.name, chosen });
				issue(
					'owners',
					row.row,
					null,
					'warning',
					'EXISTING_MATCH',
					`« ${existing.name} » existe déjà avec ce numéro ; ${chosen === 'existing' ? 'la fiche existante sera utilisée' : 'une nouvelle fiche sera créée'}.`
				);
			}
			tracked.planned = { row: row.row, ref: ref!, data, existingId };
		}
	}
	const findOwner = (text: string): Tracked<PlannedOwner> | 'ambiguous' | undefined => {
		const byRef = owners.get(refKey(text));
		if (byRef) return byRef;
		const refs = ownerByName.get(nameKey(text));
		if (!refs) return undefined;
		if (refs.length > 1) return 'ambiguous';
		return owners.get(refKey(refs[0]!));
	};

	// ------------------------------------------------ lieux
	const places = new Map<string, PlaceResolution>();
	const communeName = (id: string) => ctx.existing.communes.find((c) => c.id === id)?.name ?? id;
	const resolveCommune = (raw: string | null): { id: string | null; known: boolean } => {
		if (!raw) return { id: null, known: true };
		const key = nameKey(raw);
		const exact = ctx.existing.communes.filter((c) => nameKey(c.name) === key);
		if (exact.length === 1) return { id: exact[0]!.id, known: true };
		const prefix = key.length >= 4 ? ctx.existing.communes.filter((c) => nameKey(c.name).startsWith(key)) : [];
		if (prefix.length === 1) return { id: prefix[0]!.id, known: true };
		return { id: null, known: false };
	};
	const resolvePlace = (communeRaw: string | null, neighborhoodRaw: string, row: number): PlaceResolution => {
		const commune = resolveCommune(communeRaw);
		const key = `${commune.id ?? `?${nameKey(communeRaw ?? '')}`}|${placeKey(neighborhoodRaw)}`;
		const known = places.get(key);
		if (known) {
			known.rows.push(row);
			return known;
		}
		const pool = ctx.existing.neighborhoods.filter((n) => !commune.id || n.communeId === commune.id);
		const target = placeKey(neighborhoodRaw);
		const exact = pool.filter((n) => placeKey(n.name) === target);
		const place: PlaceResolution = {
			key,
			commune: communeRaw,
			neighborhood: neighborhoodRaw,
			communeId: commune.id,
			neighborhoodId: null,
			status: 'unresolved',
			suggestions: [],
			rows: [row]
		};
		if (exact.length === 1) {
			place.status = 'matched';
			place.neighborhoodId = exact[0]!.id;
			place.communeId = exact[0]!.communeId;
		} else {
			const threshold = Math.max(1, Math.floor(target.length / 4));
			place.suggestions = pool
				.map((n) => ({ n, d: editDistance(target, placeKey(n.name)) }))
				.filter(({ n, d }) => d <= threshold || (target.length >= 4 && placeKey(n.name).includes(target)))
				.sort((a, b) => a.d - b.d || a.n.name.localeCompare(b.n.name, 'fr'))
				.slice(0, 3)
				.map(({ n }) => ({ id: n.id, name: n.name, communeName: communeName(n.communeId) }));
			const chosen = ctx.choices?.places?.[key];
			const picked = typeof chosen === 'string' ? pool.find((n) => n.id === chosen) : undefined;
			if (picked) {
				place.status = 'corrected';
				place.neighborhoodId = picked.id;
				place.communeId = picked.communeId;
			} else if (chosen === null) {
				place.status = 'none';
			}
		}
		places.set(key, place);
		return place;
	};

	// ------------------------------------------------ biens et mandats
	const properties = new Map<string, TrackedProperty>();
	const mandateGroups = new Map<string, PlannedMandate>();
	for (const row of read('properties')) {
		const ref = v<string>(row, 'ref');
		if (ref && properties.has(refKey(ref)))
			error('properties', row, 'ref', `la référence ${ref} est déjà utilisée (Biens, ligne ${properties.get(refKey(ref))!.row}).`);
		let ownerRef: string | null = null;
		let ownerDep: Tracked<PlannedOwner> | undefined;
		if (agency) {
			const ownerText = v<string>(row, 'ownerRef');
			if (ownerText) {
				const found = findOwner(ownerText);
				if (found === 'ambiguous')
					error('properties', row, 'ownerRef', `deux propriétaires s’appellent ${ownerText} ; indiquez la référence du propriétaire.`);
				else if (!found) error('properties', row, 'ownerRef', `le propriétaire ${ownerText} n’existe pas dans l’onglet Propriétaires.`);
				else {
					ownerDep = found;
					ownerRef = found.planned?.ref ?? ownerText;
				}
			}
		}
		// Mandat (agence).
		let mandate: MandateDraft | undefined;
		if (agency) {
			const mandateType = v<PlannedMandate['type']>(row, 'mandateType');
			const rate = v<number>(row, 'commissionRate');
			const amount = v<number>(row, 'commissionAmount');
			const basis = v<string>(row, 'commissionBasis');
			let commission: PlannedMandate['terms']['commission'] = null;
			if (rate !== null && amount !== null) error('properties', row, 'commissionRate', 'un pourcentage ou un montant, pas les deux.');
			else if (rate !== null) {
				if (basis && basis !== 'percent_of_collected')
					error('properties', row, 'commissionBasis', 'un pourcentage se calcule sur les loyers encaissés ; videz cette colonne.');
				commission = { basis: 'percent_of_collected', rateBp: rate };
			} else if (amount !== null) {
				if (basis === 'percent_of_collected') error('properties', row, 'commissionBasis', 'un montant fixe est par mois ou par opération.');
				commission = { basis: basis === 'fixed_per_operation' ? 'fixed_per_operation' : 'fixed_per_month', amount };
			}
			const startsOn = v<string>(row, 'mandateStartsOn');
			const endsOn = v<string>(row, 'mandateEndsOn');
			if (mandateType && mandateType !== 'other' && !commission && !rowHasError('properties', row.row)) {
				error('properties', row, 'commissionRate', 'indiquez la commission du mandat (en % ou en FCFA).');
			}
			if (startsOn && endsOn && endsOn < startsOn) error('properties', row, 'mandateEndsOn', 'la fin du mandat précède son début.');
			if (mandateType && startsOn) {
				mandate = {
					type: mandateType,
					startsOn,
					endsOn,
					commission,
					canPublish: v<boolean>(row, 'canPublish') ?? false,
					canTakePhotos: v<boolean>(row, 'canTakePhotos') ?? false,
					canCollectFunds: v<boolean>(row, 'canCollectFunds') ?? false,
					canSignLeases: v<boolean>(row, 'canSignLeases') ?? false
				};
			}
		}
		const tracked: TrackedProperty = { row: row.row, status: 'ok', mandate };
		if (ref && !properties.has(refKey(ref))) properties.set(refKey(ref), tracked);
		if (rowHasError('properties', row.row)) {
			tracked.status = 'error';
			continue;
		}
		if (ownerDep && ownerDep.status !== 'ok') {
			tracked.status = 'skipped';
			skip('properties', row.row, because(`le propriétaire ${ownerRef}`, false, ownerDep, 'owners'));
			continue;
		}
		// Lieu.
		const communeRaw = v<string>(row, 'commune');
		const neighborhoodRaw = v<string>(row, 'neighborhood');
		let communeId = resolveCommune(communeRaw).id;
		let neighborhoodId: string | null = null;
		if (communeRaw && !resolveCommune(communeRaw).known) {
			issue(
				'properties',
				row.row,
				'commune',
				'warning',
				'UNKNOWN_COMMUNE',
				`commune « ${communeRaw} » inconnue ; le bien est importé sans commune.`,
				communeRaw
			);
		}
		if (neighborhoodRaw) {
			const place = resolvePlace(communeRaw, neighborhoodRaw, row.row);
			if (place.neighborhoodId) {
				neighborhoodId = place.neighborhoodId;
				communeId = place.communeId;
			} else if (place.status === 'unresolved') {
				const where = place.communeId ? ` à ${communeName(place.communeId)}` : '';
				issue(
					'properties',
					row.row,
					'neighborhood',
					'warning',
					'UNKNOWN_NEIGHBORHOOD',
					`quartier « ${neighborhoodRaw} » inconnu${where} ; choisissez-le dans les suggestions, sinon le bien est importé sans quartier.`,
					neighborhoodRaw
				);
			}
		}
		tracked.planned = {
			row: row.row,
			ref: ref!,
			ownerRef,
			data: {
				type: v<string>(row, 'type')!,
				name: v<string>(row, 'name')!,
				communeId,
				neighborhoodId,
				addressHint: v<string>(row, 'addressHint'),
				notes: v<string>(row, 'notes')
			}
		};
		if (agency && mandate && ownerRef) {
			const groupKey = JSON.stringify([refKey(ownerRef), mandate]);
			const group = mandateGroups.get(groupKey);
			if (group) {
				group.rows.push(row.row);
				group.propertyRefs.push(ref!);
			} else {
				const { type: mandateType, ...terms } = mandate;
				mandateGroups.set(groupKey, { ownerRef, rows: [row.row], propertyRefs: [ref!], type: mandateType, terms });
			}
		}
	}

	// ------------------------------------------------ unités
	const units = new Map<string, TrackedUnit>();
	for (const row of read('units')) {
		const ref = v<string>(row, 'ref');
		if (ref && units.has(refKey(ref))) {
			error('units', row, 'ref', `la référence ${ref} est déjà utilisée (Unités, ligne ${units.get(refKey(ref))!.row}).`);
		}
		const propertyText = v<string>(row, 'propertyRef');
		const property = propertyText ? properties.get(refKey(propertyText)) : undefined;
		if (propertyText && !property) error('units', row, 'propertyRef', `le bien ${propertyText} n’existe pas dans l’onglet Biens.`);
		const tracked: TrackedUnit = { row: row.row, status: 'ok', property };
		if (ref && !units.has(refKey(ref))) units.set(refKey(ref), tracked);
		if (rowHasError('units', row.row)) {
			tracked.status = 'error';
			continue;
		}
		if (property && property.status !== 'ok') {
			tracked.status = 'skipped';
			skip('units', row.row, because(`le bien ${propertyText}`, false, property, 'properties'));
			continue;
		}
		const technical = v<PlannedUnit['technicalStatus']>(row, 'technicalStatus');
		tracked.planned = {
			row: row.row,
			ref: ref!,
			propertyRef: property!.planned!.ref,
			data: {
				type: v<string>(row, 'type')!,
				label: v<string>(row, 'label')!,
				rooms: {
					bedrooms: v<number>(row, 'bedrooms') ?? 0,
					livingRooms: v<number>(row, 'livingRooms') ?? 0,
					bathrooms: v<number>(row, 'bathrooms') ?? 0
				},
				rent: v<number>(row, 'rent'),
				charges: v<number>(row, 'charges')
			},
			// Fixé après les baux, si la colonne est vide.
			technicalStatus: technical ?? 'ready',
			technicalReason: technical && technical !== 'ready' ? (v<string>(row, 'technicalReason') ?? IMPORT_TECHNICAL_REASON) : null
		};
		tracked.technicalDefault = !technical;
	}

	// ------------------------------------------------ locataires
	const tenants = new Map<string, TrackedTenant>();
	const tenantRows: TrackedTenant[] = [];
	const firstByPhone = new Map<string, { row: number; name: string; key: string }>();
	for (const row of read('tenants')) {
		const ref = v<string>(row, 'ref');
		if (ref && tenants.has(refKey(ref)))
			error('tenants', row, 'ref', `la référence ${ref} est déjà utilisée (Locataires, ligne ${tenants.get(refKey(ref))!.row}).`);
		const name = v<string>(row, 'fullName');
		const tracked: TrackedTenant = { row: row.row, status: 'ok', ref, name };
		if (ref && !tenants.has(refKey(ref))) tenants.set(refKey(ref), tracked);
		tenantRows.push(tracked);
		if (rowHasError('tenants', row.row)) {
			tracked.status = 'error';
			continue;
		}
		const phone = v<string>(row, 'phone');
		const data: PlannedTenant['data'] = {
			civility: v<PlannedTenant['data']['civility']>(row, 'civility'),
			fullName: name!,
			phone,
			secondaryPhone: v<string>(row, 'secondaryPhone'),
			profession: v<string>(row, 'profession'),
			nationality: v<string>(row, 'nationality'),
			emergencyContactName: v<string>(row, 'emergencyContactName'),
			emergencyContactPhone: v<string>(row, 'emergencyContactPhone'),
			notes: v<string>(row, 'notes')
		};
		const key = `tenant:${row.row}`;
		if (phone) {
			const first = firstByPhone.get(phone);
			if (first && nameKey(first.name) === nameKey(name!)) {
				// La même personne écrite deux fois : une seule fiche, que les baux de cette ligne partagent.
				issue(
					'tenants',
					row.row,
					null,
					'warning',
					'DUPLICATE_MERGED',
					`même nom et même téléphone que la ligne ${first.row} ; une seule fiche est créée.`
				);
				tracked.planned = { row: row.row, key: first.key, ref, data, existingId: null };
				tracked.merged = true;
				continue;
			}
			if (first) {
				issue(
					'tenants',
					row.row,
					'phone',
					'warning',
					'SHARED_PHONE',
					`même téléphone que ${first.name} (ligne ${first.row}) ; deux fiches sont créées (colocataires, famille).`,
					row.cells.phone ?? null
				);
			} else {
				firstByPhone.set(phone, { row: row.row, name: name!, key });
			}
		}
		let existingId: string | null = null;
		if (phone) {
			const same = ctx.existing.tenants.filter((t) => t.phone === phone);
			const existing = same.find((t) => nameKey(t.fullName) === nameKey(name!));
			if (existing) {
				const mkey = `tenants:${row.row}`;
				const chosen = choice(mkey) === null ? 'new' : 'existing';
				existingId = chosen === 'existing' ? existing.id : null;
				matches.push({ sheet: 'tenants', row: row.row, key: mkey, existingId: existing.id, existingName: existing.fullName, chosen });
				issue(
					'tenants',
					row.row,
					null,
					'warning',
					'EXISTING_MATCH',
					`« ${existing.fullName} » existe déjà avec ce numéro ; ${chosen === 'existing' ? 'la fiche existante sera utilisée' : 'une nouvelle fiche sera créée'}.`
				);
			} else if (same.length) {
				issue(
					'tenants',
					row.row,
					'phone',
					'warning',
					'EXISTING_SAME_PHONE',
					`une autre fiche porte déjà ce numéro (${same.map((t) => t.fullName).join(', ')}).`,
					row.cells.phone ?? null
				);
			}
		}
		tracked.planned = { row: row.row, key, ref, data, existingId };
	}
	const findTenant = (text: string): { found: TrackedTenant } | { ambiguous: number[] } | null => {
		const byRef = tenants.get(refKey(text));
		if (byRef) return { found: tenantRows.find((t) => t.row === byRef.row)! };
		const candidates = tenantRows.filter((t) => t.name && nameKey(t.name) === nameKey(text));
		const distinct = new Set(candidates.map((t) => t.planned?.key ?? `row:${t.row}`));
		if (distinct.size > 1) return { ambiguous: candidates.map((t) => t.row) };
		return candidates.length ? { found: candidates[0]! } : null;
	};

	// ------------------------------------------------ baux
	const leaseRows = read('leases');
	const leasesPerUnit = new Map<string, number>();
	for (const row of leaseRows) {
		const u = v<string>(row, 'unitRef');
		if (u) leasesPerUnit.set(refKey(u), (leasesPerUnit.get(refKey(u)) ?? 0) + 1);
	}
	const leases: TrackedLease[] = [];
	const leaseByRef = new Map<string, TrackedLease>();
	const inForce = new Map<string, { active?: number; signed?: number }>();
	for (const row of leaseRows) {
		const unitText = v<string>(row, 'unitRef');
		const explicitRef = v<string>(row, 'ref');
		const unit = unitText ? units.get(refKey(unitText)) : undefined;
		if (unitText && !unit) error('leases', row, 'unitRef', `l’unité ${unitText} n’existe pas dans l’onglet Unités.`);
		const tenantText = v<string>(row, 'tenant');
		let tenant: TrackedTenant | undefined;
		if (tenantText) {
			const found = findTenant(tenantText);
			if (!found) error('leases', row, 'tenant', `le locataire ${tenantText} n’existe pas dans l’onglet Locataires.`);
			else if ('ambiguous' in found) {
				const lines = found.ambiguous;
				error(
					'leases',
					row,
					'tenant',
					`deux locataires s’appellent ${tenantText} (Locataires, lignes ${lines.slice(0, -1).join(', ')} et ${lines[lines.length - 1]}) ; indiquez la référence du locataire.`
				);
			} else tenant = found.found;
		}
		if (explicitRef && leaseByRef.has(refKey(explicitRef)))
			error(
				'leases',
				row,
				'ref',
				`la référence ${explicitRef} est déjà utilisée (Baux, ligne ${leaseByRef.get(refKey(explicitRef))!.row}).`
			);
		const unitKey = unitText ? refKey(unitText) : null;
		const ref = explicitRef ?? (unitText ? ((leasesPerUnit.get(unitKey!) ?? 0) > 1 ? `${unitText} (ligne ${row.row})` : unitText) : null);
		const tracked: TrackedLease = { row: row.row, status: 'ok', unitKey, ref, unit };
		leases.push(tracked);
		if (explicitRef && !leaseByRef.has(refKey(explicitRef))) leaseByRef.set(refKey(explicitRef), tracked);

		const startsOn = v<string>(row, 'startsOn');
		let endsOn = v<string>(row, 'endsOn');
		const duration = v<number>(row, 'durationMonths');
		const exitOn = v<string>(row, 'exitOn');
		if (startsOn && duration) {
			const computed = endOnFromDuration(startsOn, duration);
			if (endsOn && endsOn !== computed)
				error('leases', row, 'endsOn', `la date de fin ne correspond pas à la durée (${formatDate(computed)} pour ${duration} mois).`);
			endsOn = endsOn ?? computed;
		}
		if (startsOn && endsOn && endsOn < startsOn) error('leases', row, 'endsOn', 'la date de fin précède la date d’entrée.');
		if (startsOn && exitOn && exitOn < startsOn) error('leases', row, 'exitOn', 'la date de sortie précède la date d’entrée.');
		// Pénalité : taux, délai de grâce et bénéficiaire ensemble (D24).
		const penaltyRate = v<number>(row, 'penaltyRate');
		const graceDays = v<number>(row, 'penaltyGraceDays');
		const beneficiary = agency ? v<'organization' | 'owner'>(row, 'penaltyBeneficiary') : penaltyRate !== null ? 'organization' : null;
		const penalty = [penaltyRate, graceDays, beneficiary];
		if (penalty.some((x) => x !== null) && penalty.some((x) => x === null)) {
			error(
				'leases',
				row,
				'penaltyRate',
				agency
					? 'pénalité : indiquez le taux, le délai de grâce et le bénéficiaire, ou aucun des trois.'
					: 'pénalité : indiquez le taux et le délai de grâce, ou aucun des deux.'
			);
		}
		if (rowHasError('leases', row.row)) {
			tracked.status = 'error';
			continue;
		}
		if (exitOn && exitOn <= ctx.today) {
			tracked.status = 'ended';
			skip('leases', row.row, `ignorée : bail terminé le ${formatDate(exitOn)} ; l’historique n’est pas importé.`, 'LEASE_ENDED');
			continue;
		}
		if (unit && unit.status !== 'ok') {
			tracked.status = 'skipped';
			skip('leases', row.row, because(`l’unité ${unitText}`, true, unit, 'units'));
			continue;
		}
		if (tenant && tenant.status !== 'ok') {
			tracked.status = 'skipped';
			skip('leases', row.row, because(`le locataire ${tenantText}`, false, tenant, 'tenants'));
			continue;
		}
		// Mandat de gestion locative (agence) : la base l'exige pour valider un bail (règle 12).
		const property = unit!.property!;
		if (agency && property.mandate) {
			const m = property.mandate;
			if (m.type !== 'rental_management') {
				const label = { letting: 'mise en location', sale: 'vente', other: 'autre mandat' }[m.type];
				error(
					'leases',
					row,
					'unitRef',
					`le bien ${property.planned!.ref} est sous mandat de ${label} ; un bail exige un mandat de gestion locative.`
				);
			} else {
				const limit = startsOn! > ctx.today ? startsOn! : ctx.today;
				if (m.startsOn > limit)
					error(
						'leases',
						row,
						'unitRef',
						`le mandat du bien ${property.planned!.ref} ne commence que le ${formatDate(m.startsOn)} ; un bail exige un mandat en vigueur.`
					);
				else if (m.endsOn && m.endsOn < ctx.today)
					error('leases', row, 'unitRef', `le mandat du bien ${property.planned!.ref} a pris fin le ${formatDate(m.endsOn)}.`);
			}
		}
		const status: PlannedLease['status'] = startsOn! > ctx.today ? 'signed' : 'active';
		const slot = inForce.get(unitKey!) ?? {};
		if (!rowHasError('leases', row.row)) {
			if (status === 'active' && slot.active) {
				error(
					'leases',
					row,
					'unitRef',
					`l’unité ${unitText} a déjà un bail en vigueur (Baux, ligne ${slot.active}) ; un seul bail en vigueur par unité.`
				);
			} else if (status === 'signed' && slot.signed) {
				error(
					'leases',
					row,
					'unitRef',
					`l’unité ${unitText} a déjà un bail réservé (Baux, ligne ${slot.signed}) ; un seul bail à venir par unité.`
				);
			}
		}
		if (rowHasError('leases', row.row)) {
			tracked.status = 'error';
			continue;
		}
		slot[status] = row.row;
		inForce.set(unitKey!, slot);
		if (exitOn) {
			issue(
				'leases',
				row.row,
				'exitOn',
				'warning',
				'EXIT_PLANNED',
				`départ prévu le ${formatDate(exitOn)} : le bail est importé en vigueur ; enregistrez le congé après l’import.`,
				row.cells.exitOn ?? null
			);
		}
		let originalEndsOn: string | null = null;
		const terms: PlannedLeaseTerms = {
			startsOn: startsOn!,
			endsOn: endsOn ?? null,
			durationMonths: duration,
			duesStartOn: null,
			rent: v<number>(row, 'rent')!,
			charges: v<number>(row, 'charges') ?? 0,
			advanceMonths: v<number>(row, 'advanceMonths') ?? 0,
			lessorType: agency ? (v<'owner' | 'organization'>(row, 'lessorType') ?? 'owner') : 'organization'
		};
		if (status === 'active' && terms.endsOn && terms.endsOn < ctx.today) {
			originalEndsOn = terms.endsOn;
			terms.endsOn = null;
			terms.durationMonths = null;
			terms.renewalMode = 'open_ended';
			issue(
				'leases',
				row.row,
				'endsOn',
				'warning',
				'LAPSED_FIXED_TERM',
				`bail échu le ${formatDate(originalEndsOn)} sans congé ; importé à durée indéterminée, la date de fin est gardée pour information.`,
				row.cells.endsOn ?? null
			);
		}
		if (terms.startsOn < ctx.switchOn) {
			terms.duesStartOn = importedDuesStartOn(terms.startsOn, ctx.switchOn, ctx.billingMode);
			if (terms.advanceMonths > 0) {
				issue(
					'leases',
					row.row,
					'advanceMonths',
					'warning',
					'ADVANCE_IGNORED',
					'sans objet pour un bail commencé avant la bascule ; ignorée.',
					row.cells.advanceMonths ?? null
				);
				terms.advanceMonths = 0;
			}
		}
		const dueDay = v<number>(row, 'dueDay');
		if (dueDay !== null) terms.dueDay = dueDay;
		// Une seule colonne par partie : la même durée en durée déterminée et indéterminée (réponse du porteur). Plus
		// courte que la loi pour ce bail (selon son type, après le passage d'un bail échu à durée indéterminée) : signalée.
		const fixedTerm = terms.endsOn !== null;
		const noticeTenant = v<number>(row, 'noticeTenantMonths');
		if (noticeTenant !== null) {
			terms.noticeTenantFixedTermMonths = noticeTenant;
			terms.noticeTenantOpenEndedMonths = noticeTenant;
			const legal = fixedTerm ? LEGAL_LEASE_DEFAULTS.noticeTenantFixedTermMonths : LEGAL_LEASE_DEFAULTS.noticeTenantOpenEndedMonths;
			if (noticeTenant < legal) shortNotice(row, 'noticeTenantMonths', noticeTenant, legal);
		}
		const noticeLessor = v<number>(row, 'noticeLessorMonths');
		if (noticeLessor !== null) {
			terms.noticeLessorFixedTermMonths = noticeLessor;
			terms.noticeLessorOpenEndedMonths = noticeLessor;
			const legal = fixedTerm ? LEGAL_LEASE_DEFAULTS.noticeLessorFixedTermMonths : LEGAL_LEASE_DEFAULTS.noticeLessorOpenEndedMonths;
			if (noticeLessor < legal) shortNotice(row, 'noticeLessorMonths', noticeLessor, legal);
		}
		const renewal = v<'open_ended' | 'same_duration'>(row, 'renewalMode');
		if (renewal && !terms.renewalMode) terms.renewalMode = renewal;
		if (penaltyRate !== null && graceDays !== null && beneficiary !== null) {
			terms.penaltyRateBp = penaltyRate;
			terms.penaltyGraceDays = graceDays;
			terms.penaltyBeneficiary = beneficiary;
		}
		const refund = v<number>(row, 'depositRefundDays');
		if (refund !== null) terms.depositRefundDays = refund;
		tracked.planned = {
			row: row.row,
			ref: ref!,
			unitRef: unit!.planned!.ref,
			tenantKey: tenant!.planned!.key,
			status,
			terms,
			originalEndsOn
		};
	}

	/** Bail visé par « Bail ou unité » : référence du bail, sinon le bail de l'unité (en vigueur d'abord). */
	const findLease = (text: string): { lease: TrackedLease } | { unitWithoutLease: true } | null => {
		const byRef = leaseByRef.get(refKey(text));
		if (byRef) return { lease: byRef };
		const onUnit = leases.filter((l) => l.unitKey === refKey(text));
		if (!onUnit.length) return units.has(refKey(text)) ? { unitWithoutLease: true } : null;
		const pick =
			onUnit.find((l) => l.planned?.status === 'active') ??
			onUnit.find((l) => l.planned?.status === 'signed') ??
			onUnit.find((l) => l.status !== 'ended') ??
			onUnit[0]!;
		return { lease: pick };
	};
	/** Résout le bail d'une ligne de Cautions ou de Soldes ; écarte la ligne si ce bail n'est pas importé. */
	const leaseOf = (k: 'deposits' | 'opening_balances', row: ImportRow): PlannedLease | null => {
		const text = v<string>(row, 'lease');
		if (!text) return null;
		const found = findLease(text);
		if (!found) {
			error(k, row, 'lease', `aucun bail ni aucune unité ne porte la référence ${text} dans l’onglet Baux.`);
			return null;
		}
		if ('unitWithoutLease' in found) {
			error(k, row, 'lease', `aucun bail importé sur l’unité ${text}.`);
			return null;
		}
		const lease = found.lease;
		if (rowHasError(k, row.row)) return null;
		if (lease.status === 'ended') {
			skip(k, row.row, `ignorée : le bail ${text} est terminé (Baux, ligne ${lease.row}).`, 'LEASE_ENDED_DEPENDENT');
			return null;
		}
		if (lease.status !== 'ok') {
			skip(
				k,
				row.row,
				`écartée : le bail ${text} ${lease.status === 'error' ? 'est en erreur' : 'est écarté'} (Baux, ligne ${lease.row}).`
			);
			return null;
		}
		return lease.planned!;
	};

	// ------------------------------------------------ cautions
	const deposits: PlannedDeposit[] = [];
	const depositSeen = new Map<string, number>();
	const depositsWithoutReceived: number[] = [];
	let depositsAboveCap = 0;
	for (const row of read('deposits')) {
		const lease = leaseOf('deposits', row);
		if (!lease) continue;
		const depositType = v<PlannedDeposit['type']>(row, 'type') ?? 'security_deposit';
		const seenKey = `${lease.ref}|${depositType}`;
		if (depositSeen.has(seenKey)) {
			error(
				'deposits',
				row,
				'lease',
				`ce bail a déjà ${depositType === 'security_deposit' ? 'une caution' : 'une garantie des factures'} (Cautions, ligne ${depositSeen.get(seenKey)}).`
			);
			continue;
		}
		const agreed = v<number>(row, 'agreedAmount')!;
		const written = v<number>(row, 'receivedAmount');
		const choice = ctx.choices?.depositReceived;
		const received = written ?? (choice === 'full' ? agreed : choice === 'to_complete' ? 0 : null);
		if (received !== null && received > agreed) {
			error('deposits', row, 'receivedAmount', `le montant reçu dépasse le montant convenu (${formatFcfa(agreed)}).`);
		}
		let receivedOn = v<string>(row, 'receivedOn');
		if (receivedOn && receivedOn > ctx.today) error('deposits', row, 'receivedOn', 'la date du versement est dans le futur.');
		if (agreed === 0) error('deposits', row, 'agreedAmount', 'indiquez le montant convenu.');
		if (rowHasError('deposits', row.row)) continue;
		depositSeen.set(seenKey, row.row);
		if (written === null) depositsWithoutReceived.push(row.row);
		if (received === null || received === 0) receivedOn = null;
		else receivedOn = receivedOn ?? (lease.terms.startsOn <= ctx.today ? lease.terms.startsOn : ctx.today);
		const unit = units.get(refKey(lease.unitRef))!;
		const holder: PlannedDeposit['holder'] = agency
			? (v<PlannedDeposit['holder']>(row, 'holder') ?? (unit.property?.mandate?.canCollectFunds ? 'organization' : 'owner'))
			: 'organization';
		if (depositType === 'security_deposit' && agreed > 2 * lease.terms.rent) {
			depositsAboveCap++;
			issue(
				'deposits',
				row.row,
				'agreedAmount',
				'warning',
				'DEPOSIT_ABOVE_CAP',
				`caution supérieure à deux mois de loyer (${formatFcfa(2 * lease.terms.rent)}) : un avertissement sera journalisé.`,
				row.cells.agreedAmount ?? null
			);
		}
		deposits.push({
			row: row.row,
			leaseRef: lease.ref,
			type: depositType,
			agreedAmount: agreed,
			receivedAmount: received,
			receivedOn,
			outstanding: received === null ? null : agreed - received,
			holder
		});
	}

	// ------------------------------------------------ soldes d'ouverture
	const openingBalances: PlannedOpeningBalance[] = [];
	const balanceSeen = new Map<string, number>();
	const balanceRows = read('opening_balances', {
		amount: { 'un montant ne peut pas être négatif.': 'saisissez 0 et notez l’avance sur la fiche du locataire.' }
	});
	for (const row of balanceRows) {
		const lease = leaseOf('opening_balances', row);
		if (!lease) continue;
		const amount = v<number>(row, 'amount')!;
		if (balanceSeen.has(lease.ref)) {
			error(
				'opening_balances',
				row,
				'lease',
				`ce bail a déjà un solde d’ouverture (Soldes d’ouverture, ligne ${balanceSeen.get(lease.ref)}).`
			);
			continue;
		}
		balanceSeen.set(lease.ref, row.row);
		if (amount === 0) continue;
		if (lease.terms.startsOn >= ctx.switchOn) {
			error(
				'opening_balances',
				row,
				'lease',
				`ce bail commence après la bascule (${formatDate(ctx.switchOn)}) ; il n’a pas de solde antérieur.`
			);
			continue;
		}
		openingBalances.push({ row: row.row, leaseRef: lease.ref, amount, dueOn: ctx.switchOn });
	}

	// ------------------------------------------------ état technique par défaut (règle 13, réponse du porteur)
	const plannedLeases = leases.flatMap((l) => (l.planned ? [l.planned] : []));
	const leasedUnits = new Set(plannedLeases.map((l) => refKey(l.unitRef)));
	const plannedUnits: PlannedUnit[] = [];
	for (const [key, u] of units) {
		if (!u.planned) continue;
		const unit = { ...u.planned };
		if (u.technicalDefault && !leasedUnits.has(key)) {
			unit.technicalStatus = 'to_refurbish';
			unit.technicalReason = IMPORT_TECHNICAL_REASON;
		}
		plannedUnits.push(unit);
	}
	plannedUnits.sort((a, b) => a.row - b.row);

	const order = (k: ImportSheetKey) => IMPORT_SHEET_KEYS.indexOf(k);
	issues.sort((a, b) => order(a.sheet) - order(b.sheet) || a.row - b.row);
	const byRow = <T extends { row: number }>(list: T[]) => list.sort((a, b) => a.row - b.row);

	return {
		issues,
		owners: byRow([...owners.values()].flatMap((o) => (o.planned ? [o.planned] : []))),
		mandates: [...mandateGroups.values()],
		properties: byRow([...properties.values()].flatMap((p) => (p.planned ? [p.planned] : []))),
		units: plannedUnits,
		tenants: tenantRows.filter((t) => t.planned && !t.merged).map((t) => t.planned!),
		leases: plannedLeases,
		deposits,
		openingBalances,
		places: [...places.values()],
		matches,
		blockers: importBlockers(ctx, depositsWithoutReceived),
		pending: { depositsWithoutReceived },
		summary: {
			newUnits: plannedUnits.length,
			leases: plannedLeases.length,
			leasesWithOpeningBalance: openingBalances.length,
			depositsAboveCap
		}
	};
}

function importBlockers(ctx: ImportContext, depositsWithoutReceived: readonly number[]): ImportBlocker[] {
	const blockers: ImportBlocker[] = [];
	const switchIssue = switchDateIssue(ctx.switchOn, ctx.today, ctx.billingMode);
	if (switchIssue) blockers.push(switchIssue);
	if (depositsWithoutReceived.length && !ctx.choices?.depositReceived) {
		const n = depositsWithoutReceived.length;
		const lines =
			n === 1
				? `ligne ${depositsWithoutReceived[0]}`
				: `lignes ${depositsWithoutReceived.slice(0, -1).join(', ')} et ${depositsWithoutReceived[n - 1]}`;
		blockers.push({
			code: 'DEPOSIT_RECEIVED_UNKNOWN',
			message: `${n} ${n === 1 ? 'caution n’a' : 'cautions n’ont'} pas de montant reçu (Cautions, ${lines}) : choisissez pour toutes « versée en entier » ou « à compléter ».`
		});
	}
	return blockers;
}
