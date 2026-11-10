/**
 * Formulaires des propriétaires et des mandats (lot 06) : saisie de l'écran → données validées par les schémas Zod
 * partagés (ceux du serveur), ou erreurs par champ. Taux saisi en pourcentage et converti en points de base entiers,
 * montant en FCFA entiers (règle 2). Fonctions pures, testées.
 */
import { parseFcfa } from '@ziga/shared/money';
import {
	DEFAULT_COMMISSION_BASIS,
	createMandateSchema,
	mandateTermsSchema,
	ownerSchema,
	parseRatePercent,
	rateBpToInput,
	type CommissionBasis,
	type CreateMandateData,
	type MandateTerms,
	type MandateType,
	type MandateView,
	type OwnerData,
	type OwnerType,
	type OwnerView
} from '@ziga/shared/owners';
import { BF_COUNTRY_CODE, countryOf, PHONE_INVALID_MESSAGE, toE164 } from '@ziga/shared/phone';
import { fr } from '../i18n/fr';

export type Errors = Record<string, string>;
export type Result<T> = { ok: true; value: T } | { ok: false; errors: Errors };

export interface OwnerForm {
	type: OwnerType;
	name: string;
	phone: string;
	/** Indicatif du téléphone (226 par défaut). */
	phoneCountry: string;
	/** Pays de résidence (ISO à deux lettres). */
	country: string;
	email: string;
	address: string;
	notes: string;
	repName: string;
	repPhone: string;
	repPhoneCountry: string;
}

export function emptyOwnerForm(): OwnerForm {
	return {
		type: 'person',
		name: '',
		phone: '',
		phoneCountry: BF_COUNTRY_CODE,
		country: 'BF',
		email: '',
		address: '',
		notes: '',
		repName: '',
		repPhone: '',
		repPhoneCountry: BF_COUNTRY_CODE
	};
}

/** Fiche existante → formulaire (numéros en national, avec leur indicatif). */
export function ownerToForm(o: OwnerView): OwnerForm {
	const split = (e164: string) => {
		const c = countryOf(e164);
		return c ? { national: e164.slice(c.code.length + 1), code: c.code } : { national: e164, code: BF_COUNTRY_CODE };
	};
	const phone = split(o.phone);
	const rep = o.representative ? split(o.representative.phone) : { national: '', code: BF_COUNTRY_CODE };
	return {
		type: o.type,
		name: o.name,
		phone: phone.national,
		phoneCountry: phone.code,
		country: o.country,
		email: o.email ?? '',
		address: o.address ?? '',
		notes: o.notes ?? '',
		repName: o.representative?.name ?? '',
		repPhone: rep.national,
		repPhoneCountry: rep.code
	};
}

/** Erreurs de Zod, par champ (premier message de chacun). */
function issues(error: { issues: { path: PropertyKey[]; message: string }[] }, rename: Record<string, string> = {}): Errors {
	const out: Errors = {};
	for (const issue of error.issues) {
		const path = issue.path.map(String).join('.');
		const field = rename[path] ?? path;
		out[field] ??= issue.message;
	}
	return out;
}

export function ownerFromForm(f: OwnerForm): Result<OwnerData> {
	const errors: Errors = {};
	const phone = toE164(f.phone, f.phoneCountry);
	if (!phone) errors.phone = PHONE_INVALID_MESSAGE;
	let representative: { name: string; phone: string | null } | null = null;
	if (f.type === 'group') {
		const repPhone = toE164(f.repPhone, f.repPhoneCountry);
		if (!repPhone) errors.repPhone = PHONE_INVALID_MESSAGE;
		representative = { name: f.repName, phone: repPhone };
	}
	const parsed = ownerSchema.safeParse({
		type: f.type,
		name: f.name,
		phone: phone ?? '',
		email: f.email,
		address: f.address,
		country: f.country,
		representative,
		notes: f.notes
	});
	if (!parsed.success)
		Object.assign(
			errors,
			issues(parsed.error, { 'representative.name': 'repName', 'representative.phone': 'repPhone', representative: 'repName' }),
			errors
		);
	return Object.keys(errors).length || !parsed.success ? { ok: false, errors } : { ok: true, value: parsed.data };
}

export interface MandateForm {
	type: MandateType;
	startsOn: string;
	endsOn: string;
	/** Base de la commission, ou '' pour « sans commission ». */
	basis: CommissionBasis | '';
	/** Taux saisi en pourcentage (« 10 », « 7,5 »). */
	rate: string;
	/** Montant saisi en FCFA (« 25 000 »). */
	amount: string;
	canPublish: boolean;
	canTakePhotos: boolean;
	canCollectFunds: boolean;
	canSignLeases: boolean;
	exclusive: boolean;
}

/** Valeurs proposées : gestion locative dès aujourd'hui, 10 % des loyers encaissés, sans signature des baux. */
export function emptyMandateForm(today: string, type: MandateType = 'rental_management'): MandateForm {
	return {
		type,
		startsOn: today,
		endsOn: '',
		basis: DEFAULT_COMMISSION_BASIS[type] ?? '',
		rate: '10',
		amount: '',
		canPublish: true,
		canTakePhotos: true,
		canCollectFunds: true,
		canSignLeases: false,
		exclusive: false
	};
}

/** Changement de type : la base de commission proposée suit, la saisie reste. */
export function withType(f: MandateForm, type: MandateType): MandateForm {
	return { ...f, type, basis: DEFAULT_COMMISSION_BASIS[type] ?? f.basis };
}

export function mandateToForm(m: Pick<MandateView, 'type' | keyof MandateTerms>): MandateForm {
	const c = m.commission;
	return {
		type: m.type,
		startsOn: m.startsOn,
		endsOn: m.endsOn ?? '',
		basis: c?.basis ?? '',
		rate: c?.basis === 'percent_of_collected' ? rateBpToInput(c.rateBp) : '',
		amount: c && c.basis !== 'percent_of_collected' ? String(c.amount) : '',
		canPublish: m.canPublish,
		canTakePhotos: m.canTakePhotos,
		canCollectFunds: m.canCollectFunds,
		canSignLeases: m.canSignLeases,
		exclusive: m.exclusive
	};
}

function commissionOf(f: MandateForm, errors: Errors) {
	if (!f.basis) return null;
	if (f.basis === 'percent_of_collected') {
		const rateBp = parseRatePercent(f.rate);
		if (rateBp === null) errors.rate = fr.mandates.rateInvalid;
		return { basis: f.basis, rateBp: rateBp ?? 0 };
	}
	const amount = parseFcfa(f.amount);
	if (amount === null) errors.amount = fr.mandates.amountInvalid;
	return { basis: f.basis, amount: amount ?? 0 };
}

function termsInput(f: MandateForm, errors: Errors) {
	return {
		startsOn: f.startsOn,
		endsOn: f.endsOn || null,
		commission: commissionOf(f, errors),
		canPublish: f.canPublish,
		canTakePhotos: f.canTakePhotos,
		canCollectFunds: f.canCollectFunds,
		canSignLeases: f.canSignLeases,
		exclusive: f.exclusive
	};
}

const MANDATE_FIELDS = { 'commission.rateBp': 'rate', 'commission.amount': 'amount', commission: 'basis' };

/** Nouveau mandat d'un propriétaire. */
export function mandateFromForm(f: MandateForm, ids: { id: string; ownerId: string }): Result<CreateMandateData> {
	const errors: Errors = {};
	const parsed = createMandateSchema.safeParse({ ...ids, type: f.type, ...termsInput(f, errors) });
	if (!parsed.success) Object.assign(errors, { ...issues(parsed.error, MANDATE_FIELDS), ...errors });
	return Object.keys(errors).length || !parsed.success ? { ok: false, errors } : { ok: true, value: parsed.data };
}

/** Conditions modifiées d'un mandat existant (son type ne change pas). */
export function termsFromForm(f: MandateForm): Result<MandateTerms> {
	const errors: Errors = {};
	const parsed = mandateTermsSchema(f.type).safeParse(termsInput(f, errors));
	if (!parsed.success) Object.assign(errors, { ...issues(parsed.error, MANDATE_FIELDS), ...errors });
	return Object.keys(errors).length || !parsed.success ? { ok: false, errors } : { ok: true, value: parsed.data };
}
