import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';
import {
	canTransition,
	commissionColumns,
	commissionFromColumns,
	commissionSchema,
	createMandateSchema,
	createOwnerSchema,
	effectiveAuthorizations,
	effectiveMandateStatus,
	formatRateBp,
	parseRatePercent,
	rateBpToInput,
	isManagementMandate,
	mandateAlert,
	mandateTermsSchema,
	ownerSchema,
	revokeMandateSchema,
	updateMandateSchema,
	type MandateDates
} from './owners.js';

const all = { canPublish: true, canTakePhotos: true, canCollectFunds: true, canSignLeases: true };

describe('propriétaires (lot 06)', () => {
	it('création : identifiant du client, téléphone en E.164, pays par défaut BF, champs vides à null', () => {
		const id = newId();
		expect(createOwnerSchema.parse({ id, type: 'person', name: ' Issa Ouédraogo ', phone: '70 11 22 33', email: '', notes: '' })).toEqual({
			id,
			type: 'person',
			name: 'Issa Ouédraogo',
			phone: '+22670112233',
			email: null,
			address: null,
			country: 'BF',
			representative: null,
			notes: null
		});
	});

	it('diaspora : pays de résidence à deux lettres, en majuscules ; e-mail en minuscules', () => {
		const o = ownerSchema.parse({ type: 'person', name: 'Awa Traoré', phone: '+33612345678', country: 'fr', email: 'Awa@Exemple.FR' });
		expect(o).toMatchObject({ country: 'FR', phone: '+33612345678', email: 'awa@exemple.fr' });
		expect(ownerSchema.safeParse({ type: 'person', name: 'Awa', phone: '70112233', country: 'France' }).success).toBe(false);
		expect(ownerSchema.safeParse({ type: 'person', name: 'Awa', phone: '70112233', email: 'pas-une-adresse' }).success).toBe(false);
	});

	it('groupe d’indivisaires : représentant (nom et téléphone) obligatoire ; interdit pour une personne ou une société', () => {
		const group = { type: 'group', name: 'Héritiers Kaboré', phone: '70112233' } as const;
		expect(ownerSchema.safeParse(group).success).toBe(false);
		expect(ownerSchema.parse({ ...group, representative: { name: 'Paul Kaboré', phone: '76 00 00 01' } }).representative).toEqual({
			name: 'Paul Kaboré',
			phone: '+22676000001'
		});
		expect(
			ownerSchema.safeParse({ type: 'company', name: 'SCI Faso', phone: '70112233', representative: { name: 'X Y', phone: '70112233' } })
				.success
		).toBe(false);
	});
});

describe('mandats : commission (règle 2)', () => {
	it('taux en points de base entiers de 0 à 10 000 ; jamais de flottant', () => {
		expect(commissionSchema.parse({ basis: 'percent_of_collected', rateBp: 1000 })).toEqual({
			basis: 'percent_of_collected',
			rateBp: 1000
		});
		expect(commissionSchema.safeParse({ basis: 'percent_of_collected', rateBp: 0 }).success).toBe(true);
		expect(commissionSchema.safeParse({ basis: 'percent_of_collected', rateBp: 10_000 }).success).toBe(true);
		expect(commissionSchema.safeParse({ basis: 'percent_of_collected', rateBp: 10_001 }).success).toBe(false);
		expect(commissionSchema.safeParse({ basis: 'percent_of_collected', rateBp: -1 }).success).toBe(false);
		expect(commissionSchema.safeParse({ basis: 'percent_of_collected', rateBp: 10.5 }).success).toBe(false);
	});

	it('montant fixe en FCFA entiers, par mois ou par opération', () => {
		expect(commissionSchema.parse({ basis: 'fixed_per_month', amount: 25_000 })).toEqual({ basis: 'fixed_per_month', amount: 25_000 });
		expect(commissionSchema.parse({ basis: 'fixed_per_operation', amount: 150_000 }).basis).toBe('fixed_per_operation');
		expect(commissionSchema.safeParse({ basis: 'fixed_per_month', amount: 2500.5 }).success).toBe(false);
		expect(commissionSchema.safeParse({ basis: 'fixed_per_month', amount: -1 }).success).toBe(false);
	});

	it('jamais les deux : un taux avec un montant, ou un champ qui ne va pas avec la base, est refusé', () => {
		expect(commissionSchema.safeParse({ basis: 'percent_of_collected', rateBp: 1000, amount: 5000 }).success).toBe(false);
		expect(commissionSchema.safeParse({ basis: 'fixed_per_month', amount: 5000, rateBp: 1000 }).success).toBe(false);
		expect(commissionSchema.safeParse({ basis: 'fixed_per_month', rateBp: 1000 }).success).toBe(false);
		expect(commissionSchema.safeParse({ basis: 'unknown', amount: 1 }).success).toBe(false);
	});

	it('colonnes : une seule valeur renseignée, selon la base ; aller-retour sans perte', () => {
		expect(commissionColumns({ basis: 'percent_of_collected', rateBp: 750 })).toEqual({
			commission_basis: 'percent_of_collected',
			commission_rate_bp: 750,
			commission_amount: null
		});
		expect(commissionColumns({ basis: 'fixed_per_operation', amount: 100_000 })).toEqual({
			commission_basis: 'fixed_per_operation',
			commission_rate_bp: null,
			commission_amount: 100_000
		});
		expect(commissionColumns(null)).toEqual({ commission_basis: null, commission_rate_bp: null, commission_amount: null });
		const c = { basis: 'fixed_per_month', amount: 30_000 } as const;
		expect(commissionFromColumns(commissionColumns(c))).toEqual(c);
	});

	it('saisie d’un taux en pourcentage : points de base entiers, jamais de flottant', () => {
		expect(parseRatePercent('10')).toBe(1000);
		expect(parseRatePercent('7,5')).toBe(750);
		expect(parseRatePercent('12.25')).toBe(1225);
		expect(parseRatePercent(' 10 % ')).toBe(1000);
		expect(parseRatePercent('0')).toBe(0);
		expect(parseRatePercent('100')).toBe(10_000);
		// 0,1 + 0,2 en flottant donnerait 30,000000000000004 : ici, 0,3 % vaut exactement 30.
		expect(parseRatePercent('0,3')).toBe(30);
		for (const bad of ['', '100,01', '101', '7,555', '-5', 'dix', '1e3']) expect(parseRatePercent(bad), bad).toBeNull();
		expect(rateBpToInput(750)).toBe('7,5');
		expect(rateBpToInput(1000)).toBe('10');
		expect(parseRatePercent(rateBpToInput(1225))).toBe(1225);
	});

	it('affichage du taux', () => {
		expect(formatRateBp(1000)).toBe('10 %');
		expect(formatRateBp(250)).toBe('2,5 %');
		expect(formatRateBp(1234)).toBe('12,34 %');
		expect(formatRateBp(0)).toBe('0 %');
		expect(() => formatRateBp(10.5)).toThrow();
	});
});

describe('mandats : création, modification, révocation', () => {
	const base = { id: newId(), ownerId: newId(), startsOn: '2026-11-10' };

	it('gestion locative : commission exigée ; autorisations fausses par défaut, signature des baux comprise', () => {
		expect(createMandateSchema.safeParse({ ...base, type: 'rental_management' }).success).toBe(false);
		const m = createMandateSchema.parse({
			...base,
			type: 'rental_management',
			commission: { basis: 'percent_of_collected', rateBp: 1000 }
		});
		expect(m).toMatchObject({
			endsOn: null,
			canPublish: false,
			canTakePhotos: false,
			canCollectFunds: false,
			canSignLeases: false,
			exclusive: false
		});
	});

	it('mise en location et vente : commission exigée ; « autre » : facultative', () => {
		for (const type of ['letting', 'sale'] as const) expect(createMandateSchema.safeParse({ ...base, type }).success).toBe(false);
		expect(createMandateSchema.safeParse({ ...base, type: 'other' }).success).toBe(true);
	});

	it('self_managed n’est jamais créé par une organisation ; ses conditions : sans commission, sans fin', () => {
		expect(createMandateSchema.safeParse({ ...base, type: 'self_managed' }).success).toBe(false);
		expect(mandateTermsSchema('self_managed').safeParse({ startsOn: '2026-01-01' }).success).toBe(true);
		expect(mandateTermsSchema('self_managed').safeParse({ startsOn: '2026-01-01', endsOn: '2027-01-01' }).success).toBe(false);
		expect(
			mandateTermsSchema('self_managed').safeParse({ startsOn: '2026-01-01', commission: { basis: 'fixed_per_month', amount: 1 } }).success
		).toBe(false);
	});

	it('la fin ne précède pas le début ; dates au format ISO', () => {
		const ok = { ...base, type: 'other' as const };
		expect(createMandateSchema.safeParse({ ...ok, endsOn: '2026-11-09' }).success).toBe(false);
		expect(createMandateSchema.safeParse({ ...ok, endsOn: '2026-11-10' }).success).toBe(true);
		expect(createMandateSchema.safeParse({ ...ok, startsOn: '10/11/2026' }).success).toBe(false);
	});

	it('modification : au moins un champ ; révocation : motif obligatoire', () => {
		expect(updateMandateSchema.safeParse({}).success).toBe(false);
		expect(updateMandateSchema.parse({ canPublish: false })).toEqual({ canPublish: false });
		expect(revokeMandateSchema.safeParse({ reason: '' }).success).toBe(false);
		expect(revokeMandateSchema.safeParse({ reason: 'abc' }).success).toBe(false);
		expect(revokeMandateSchema.parse({ reason: ' Fin de collaboration ' }).reason).toBe('Fin de collaboration');
	});

	it('machine d’états : un mandat naît actif, ne se ferme qu’une fois, jamais ne revient', () => {
		expect(canTransition('active', 'revoked')).toBe(true);
		expect(canTransition('active', 'expired')).toBe(true);
		expect(canTransition('revoked', 'active')).toBe(false);
		expect(canTransition('expired', 'active')).toBe(false);
		expect(canTransition('expired', 'revoked')).toBe(false);
		expect(canTransition('active', 'active')).toBe(false);
	});

	it('règle 12 : seuls la gestion locative et le bailleur qui gère lui-même occupent l’unité', () => {
		expect(isManagementMandate('rental_management')).toBe(true);
		expect(isManagementMandate('self_managed')).toBe(true);
		expect(isManagementMandate('letting')).toBe(false);
		expect(isManagementMandate('sale')).toBe(false);
		expect(isManagementMandate('other')).toBe(false);
	});
});

describe('mandats : statut effectif, autorisations et alerte', () => {
	const m = (over: Partial<MandateDates> = {}): MandateDates => ({
		status: 'active',
		startsOn: '2026-01-01',
		endsOn: '2026-12-31',
		...over
	});

	it('à venir avant la date de début, en vigueur jusqu’au dernier jour inclus, expiré le lendemain', () => {
		expect(effectiveMandateStatus(m(), '2025-12-31')).toBe('upcoming');
		expect(effectiveMandateStatus(m(), '2026-01-01')).toBe('active');
		expect(effectiveMandateStatus(m(), '2026-12-31')).toBe('active');
		expect(effectiveMandateStatus(m(), '2027-01-01')).toBe('expired');
		expect(effectiveMandateStatus(m({ endsOn: null }), '2099-01-01')).toBe('active');
	});

	it('révoqué ou expiré en base : ce statut, quelle que soit la date', () => {
		expect(effectiveMandateStatus(m({ status: 'revoked' }), '2026-06-01')).toBe('revoked');
		expect(effectiveMandateStatus(m({ status: 'expired' }), '2026-06-01')).toBe('expired');
	});

	it('aucune autorisation avant la date de début, après la fin, ni après une révocation', () => {
		const none = { canPublish: false, canTakePhotos: false, canCollectFunds: false, canSignLeases: false };
		expect(effectiveAuthorizations({ ...m(), ...all }, '2026-06-01')).toEqual(all);
		expect(effectiveAuthorizations({ ...m(), ...all }, '2025-12-31')).toEqual(none);
		expect(effectiveAuthorizations({ ...m(), ...all }, '2027-01-01')).toEqual(none);
		expect(effectiveAuthorizations({ ...m({ status: 'revoked' }), ...all }, '2026-06-01')).toEqual(none);
		expect(effectiveAuthorizations({ ...m(), ...all, canSignLeases: false }, '2026-06-01').canSignLeases).toBe(false);
	});

	it('alerte à 30 jours de la fin (J-30 compris), jusqu’au dernier jour ; rien sans date de fin ou hors vigueur', () => {
		expect(mandateAlert(m(), '2026-11-30')).toBeNull();
		expect(mandateAlert(m(), '2026-12-01')).toEqual({ daysLeft: 30 });
		expect(mandateAlert(m(), '2026-12-31')).toEqual({ daysLeft: 0 });
		expect(mandateAlert(m(), '2027-01-01')).toBeNull();
		expect(mandateAlert(m({ endsOn: null }), '2026-12-31')).toBeNull();
		expect(mandateAlert(m({ status: 'revoked' }), '2026-12-15')).toBeNull();
	});
});
