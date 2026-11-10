import { describe, expect, it } from 'vitest';
import {
	emptyMandateForm,
	emptyOwnerForm,
	mandateFromForm,
	mandateToForm,
	ownerFromForm,
	ownerToForm,
	termsFromForm,
	withType
} from './forms';

const today = '2026-11-10';
const ids = { id: '0195f3a0-0000-7000-8000-000000000001', ownerId: '0195f3a0-0000-7000-8000-000000000002' };

describe('formulaire propriétaire (lot 06)', () => {
	it('numéro national avec son indicatif → E.164 ; champs facultatifs vides → null', () => {
		const r = ownerFromForm({ ...emptyOwnerForm(), name: ' Issa Ouédraogo ', phone: '70 11 22 33' });
		expect(r).toEqual({
			ok: true,
			value: {
				type: 'person',
				name: 'Issa Ouédraogo',
				phone: '+22670112233',
				email: null,
				address: null,
				country: 'BF',
				representative: null,
				notes: null
			}
		});
	});

	it('erreurs par champ : nom, téléphone, représentant d’un groupe', () => {
		const r = ownerFromForm({ ...emptyOwnerForm(), type: 'group', name: 'X', phone: '12' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['name', 'phone', 'repName', 'repPhone']);
	});

	it('diaspora : indicatif et pays de résidence ; aller-retour avec une fiche existante', () => {
		const r = ownerFromForm({ ...emptyOwnerForm(), name: 'Awa Traoré', phone: '06 12 34 56 78', phoneCountry: '33', country: 'FR' });
		expect(r.ok && r.value.phone).toBe('+33612345678');
		const form = ownerToForm({
			id: 'o',
			type: 'person',
			name: 'Awa Traoré',
			phone: '+33612345678',
			email: null,
			address: null,
			country: 'FR',
			representative: null,
			notes: null,
			status: 'active',
			archivedAt: null,
			createdAt: '',
			updatedAt: ''
		});
		expect(form).toMatchObject({ phone: '612345678', phoneCountry: '33', country: 'FR' });
		expect(ownerFromForm(form)).toMatchObject({ ok: true, value: { phone: '+33612345678' } });
	});
});

describe('formulaire mandat (lot 06)', () => {
	it('valeurs proposées : gestion locative, 10 % des loyers encaissés, sans signature des baux', () => {
		const r = mandateFromForm(emptyMandateForm(today), ids);
		expect(r).toMatchObject({
			ok: true,
			value: {
				type: 'rental_management',
				startsOn: today,
				endsOn: null,
				commission: { basis: 'percent_of_collected', rateBp: 1000 },
				canSignLeases: false
			}
		});
	});

	it('taux en pourcentage → points de base entiers ; taux invalide → erreur sur le champ', () => {
		expect(mandateFromForm({ ...emptyMandateForm(today), rate: '7,5' }, ids)).toMatchObject({
			ok: true,
			value: { commission: { rateBp: 750 } }
		});
		const bad = mandateFromForm({ ...emptyMandateForm(today), rate: '12,345' }, ids);
		expect(bad.ok === false && bad.errors.rate).toBe('Taux entre 0 et 100 %, deux décimales au plus.');
	});

	it('mise en location : montant fixe par opération proposé, saisi en FCFA entiers', () => {
		const f = withType(emptyMandateForm(today), 'letting');
		expect(f.basis).toBe('fixed_per_operation');
		expect(mandateFromForm({ ...f, amount: '150 000' }, ids)).toMatchObject({
			ok: true,
			value: { commission: { basis: 'fixed_per_operation', amount: 150000 } }
		});
		const bad = mandateFromForm({ ...f, amount: '1500,50' }, ids);
		expect(bad.ok === false && bad.errors.amount).toBe('Montant en FCFA, sans centimes.');
	});

	it('gestion sans commission : refusée ; fin avant le début : refusée', () => {
		const none = mandateFromForm({ ...emptyMandateForm(today), basis: '' }, ids);
		expect(none.ok === false && none.errors.basis).toBeTruthy();
		const dates = mandateFromForm({ ...emptyMandateForm(today), endsOn: '2026-11-01' }, ids);
		expect(dates.ok === false && dates.errors.endsOn).toBeTruthy();
	});

	it('modification : aller-retour des conditions d’un mandat existant', () => {
		const form = mandateToForm({
			type: 'rental_management',
			startsOn: '2026-01-01',
			endsOn: '2026-12-31',
			commission: { basis: 'percent_of_collected', rateBp: 1225 },
			canPublish: true,
			canTakePhotos: false,
			canCollectFunds: true,
			canSignLeases: false,
			exclusive: true
		});
		expect(form).toMatchObject({ rate: '12,25', endsOn: '2026-12-31', exclusive: true });
		expect(termsFromForm(form)).toMatchObject({ ok: true, value: { commission: { rateBp: 1225 }, canTakePhotos: false, exclusive: true } });
	});
});
