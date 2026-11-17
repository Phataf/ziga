import { describe, expect, it } from 'vitest';
import {
	localSnapshot,
	pendingRentAmount,
	receiptToShow,
	searchTargets,
	shareUrl,
	suggestedRentAmount,
	toPayment,
	toReceipt,
	toTarget,
	verificationUrl,
	whatsappLink,
	type DueForScreen,
	type LocalPayment
} from './views';

const TODAY = '2027-01-10';
const due = (id: string, dueOn: string, amountPaid = 0, extra: Partial<DueForScreen> = {}): DueForScreen => ({
	id,
	dueOn,
	periodStart: dueOn.slice(0, 8) + '01',
	periodEnd: dueOn.slice(0, 8) + '28',
	amountDue: 80_000,
	amountPaid,
	waived: false,
	isAdvance: false,
	...extra
});
const org = {
	name: 'Agence du Faso',
	address: null,
	commune: 'Ouagadougou',
	poBox: null,
	phone: '+226 70 12 34 56',
	rccm: null,
	ifu: null,
	logoId: null
};

describe('encaissements lus sur l’appareil', () => {
	it('saisi sur l’appareil : « en attente d’envoi » tant que le serveur n’a pas décidé du statut', () => {
		expect(toPayment({ id: 'p', lease_id: 'l', amount: 80000, method: 'cash', paid_on: TODAY }).status).toBe('pending_upload');
		expect(toPayment({ id: 'p', lease_id: 'l', amount: 80000, method: 'cash', paid_on: TODAY, status: 'to_validate' }).status).toBe(
			'to_validate'
		);
	});

	it('reçu : copie figée relue du JSON ; illisible, ignorée', () => {
		expect(toReceipt({ id: 'r', payment_id: 'p', status: 'valid', number: 'AG-2027-000001', snapshot: '{"amount":1}' }).snapshot).toEqual({
			amount: 1
		});
		expect(toReceipt({ id: 'r', payment_id: 'p', snapshot: '{' }).snapshot).toBeNull();
	});
});

describe('recherche du locataire', () => {
	const targets = [
		toTarget({
			id: 'l1',
			tenant_id: 't1',
			tenant_name: 'Fatimata Sana',
			tenant_phone: '+22670112233',
			unit_label: 'A2',
			property_name: 'Résidence Wend-Panga'
		}),
		toTarget({
			id: 'l2',
			tenant_id: 't2',
			tenant_name: 'Issa Kaboré',
			tenant_phone: '+22676445566',
			unit_label: 'Villa 3',
			property_name: 'Cité An III'
		})
	];
	it('par nom sans accents, par téléphone, par unité ou bien', () => {
		expect(searchTargets(targets, 'kabore').map((t) => t.leaseId)).toEqual(['l2']);
		expect(searchTargets(targets, '70 11').map((t) => t.leaseId)).toEqual(['l1']);
		expect(searchTargets(targets, 'villa').map((t) => t.leaseId)).toEqual(['l2']);
		expect(searchTargets(targets, 'wend panga').map((t) => t.leaseId)).toEqual(['l1']);
		expect(searchTargets(targets, '')).toHaveLength(2);
	});
});

describe('montant pré-rempli', () => {
	const dues = [due('nov', '2026-11-05', 80_000), due('dec', '2026-12-05', 30_000), due('jan', '2027-01-05'), due('feb', '2027-02-05')];
	const pay = (amount: number, status: LocalPayment['status'], extra: Partial<LocalPayment> = {}): LocalPayment => ({
		...toPayment({ id: 'x', lease_id: 'l1', amount, method: 'cash', paid_on: TODAY, status }),
		...extra
	});
	it('reste exigible moins ce qui attend validation ou envoi', () => {
		expect(suggestedRentAmount(dues, 0, TODAY)).toBe(130_000);
		const pending = pendingRentAmount(
			[
				pay(50_000, 'to_validate'),
				pay(10_000, 'pending_upload'),
				pay(99_000, 'confirmed'),
				pay(5_000, 'to_validate', { leaseId: 'autre' })
			],
			'l1'
		);
		expect(pending).toBe(60_000);
		expect(suggestedRentAmount(dues, pending, TODAY)).toBe(70_000);
	});
	it('rien d’exigible : la prochaine échéance ouverte', () => {
		expect(suggestedRentAmount(dues, 130_000, TODAY)).toBe(80_000);
		expect(suggestedRentAmount([due('jan', '2027-01-05', 80_000)], 0, TODAY)).toBe(0);
	});
	it('une caution en attente ne réduit pas le loyer proposé', () => {
		expect(pendingRentAmount([pay(50_000, 'to_validate', { purpose: 'deposit' })], 'l1')).toBe(0);
	});
});

describe('reçu provisoire de l’appareil', () => {
	const payment = {
		id: 'p1',
		purpose: 'rent' as const,
		amount: 100_000,
		method: 'cash' as const,
		operator: null,
		transactionReference: null,
		paidOn: TODAY
	};
	it('imputation prévisionnelle (les plus anciennes d’abord), solde restant dû, mêmes mentions que le reçu émis', () => {
		const snap = localSnapshot({
			organization: org,
			tenantName: 'Fatimata Sana',
			unit: { label: 'Résidence — A2', address: 'Tampouy, Ouagadougou' },
			payment,
			dues: [due('dec', '2026-12-05'), due('jan', '2027-01-05')],
			deposit: null,
			collectedBy: 'Awa',
			today: TODAY
		});
		expect(snap.periods.map((p) => p.amount)).toEqual([80_000, 20_000]);
		expect(snap.balanceDue).toBe(60_000);
		const doc = receiptToShow(
			null,
			{ id: 'r', paymentId: 'p1', provisionalNumber: 'PROV-ABCDEF', verificationToken: 'v'.repeat(43), shareToken: 's' },
			snap,
			'https://ziga.com/'
		);
		expect(doc).toMatchObject({ title: 'Reçu provisoire', number: 'PROV-ABCDEF', verificationUrl: `https://ziga.com/r/${'v'.repeat(43)}` });
	});
	it('caution : objet et reste du dépôt de garantie', () => {
		const snap = localSnapshot({
			organization: org,
			tenantName: 'Fatimata Sana',
			unit: { label: 'A2', address: null },
			payment: { ...payment, purpose: 'deposit', amount: 50_000 },
			dues: [],
			deposit: { type: 'security_deposit', holder: 'owner', remainingDue: 150_000 },
			collectedBy: 'Awa',
			today: TODAY
		});
		expect(snap).toMatchObject({ deposit: { type: 'security_deposit', holder: 'owner' }, balanceDue: 100_000, periods: [] });
	});
	it('reçu émis : la copie figée du serveur et son numéro l’emportent', () => {
		const receipt = toReceipt({
			id: 'r',
			payment_id: 'p1',
			status: 'valid',
			number: 'AG-2027-000124',
			provisional_number: 'PROV-ABCDEF',
			issued_on: TODAY,
			snapshot: JSON.stringify(
				localSnapshot({
					organization: org,
					tenantName: 'F',
					unit: { label: 'A', address: null },
					payment,
					dues: [],
					deposit: null,
					collectedBy: 'Awa',
					today: TODAY
				})
			)
		});
		expect(receiptToShow(receipt, null, null, 'https://ziga.com')).toMatchObject({
			title: 'Reçu de paiement',
			number: 'AG-2027-000124',
			verificationUrl: null
		});
	});
});

describe('adresses du reçu', () => {
	it('page de vérification, lien partagé, WhatsApp pré-rempli', () => {
		expect(verificationUrl('https://ziga.com/', 'abc')).toBe('https://ziga.com/r/abc');
		expect(shareUrl('https://ziga.com', 'xyz')).toBe('https://ziga.com/recu/xyz');
		expect(whatsappLink('+22670112233', 'Reçu https://ziga.com/recu/xyz')).toBe(
			'https://wa.me/22670112233?text=Re%C3%A7u%20https%3A%2F%2Fziga.com%2Frecu%2Fxyz'
		);
		expect(whatsappLink(null, 'x')).toBe('https://wa.me/?text=x');
	});
});
