/**
 * PDF d'un reçu (lot 09) : formats A6 et ticket (58 et 80 mm), mentions dans l'ordre, montant en chiffres et en
 * lettres (règle 2 : espace insécable dans le PDF), QR code qui encode exactement l'adresse de vérification,
 * « ANNULÉ » sur un reçu annulé.
 */
import { formatFcfa } from '@ziga/shared/money';
import { receiptDocument, type ReceiptSnapshot } from '@ziga/shared/receipts';
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { inspectPdf } from '../../../test/pdf-inspect.js';
import { renderReceiptPdf } from './receipt-pdf.js';

const MM = 72 / 25.4;
const url = 'https://ziga.com/r/Q8n3V6c0b1Jm2Kx9Tq4Wz7Yh5Ld0Gs2Fp8Ae3Rt1Uu';

const snapshot: ReceiptSnapshot = {
	organization: {
		name: 'Agence Immobilière du Faso',
		address: 'Avenue Kwame Nkrumah',
		commune: 'Ouagadougou',
		poBox: '01 BP 1234 Ouagadougou 01',
		phone: '+226 70 12 34 56',
		rccm: 'BF-OUA-2020-B-1234',
		ifu: '00012345X',
		logoId: null
	},
	tenant: { fullName: 'Fatimata Sana' },
	unit: { label: 'Résidence Wend-Panga — Appartement 2', address: 'Tampouy, Ouagadougou' },
	purpose: 'rent',
	periods: [
		{ start: '2027-01-01', end: '2027-01-31', amount: 80_000, isAdvance: false },
		{ start: '2027-02-01', end: '2027-02-28', amount: 5_000, isAdvance: false }
	],
	credit: 0,
	deposit: null,
	amount: 85_000,
	method: 'mobile_money_manual',
	operator: 'orange_money',
	transactionReference: 'MP231116.1234.A12',
	paidOn: '2027-01-05',
	balanceDue: 75_000,
	collectedBy: 'Awa Ouédraogo'
};

const doc = (status: 'valid' | 'cancelled' = 'valid') =>
	receiptDocument({
		snapshot,
		status,
		number: 'AIF-2027-000124',
		provisionalNumber: 'PROV-ABCDEF',
		issuedOn: '2027-01-05',
		verificationUrl: url
	});

describe('PDF du reçu', () => {
	it('A6 : 105 × 148 mm, « Reçu de paiement », mentions et montant en lettres, sans espace fine (WinAnsi)', async () => {
		const pdf = await inspectPdf(await renderReceiptPdf({ document: doc(), format: 'a6', ticketWidth: 80, logoPng: null }));
		expect(pdf.pages).toHaveLength(1);
		expect(pdf.pages[0]!.width).toBeCloseTo(105 * MM, 1);
		expect(pdf.pages[0]!.height).toBeCloseTo(148 * MM, 1);
		// Une valeur longue peut passer à la ligne : le texte de la page est relu d'un bloc.
		const text = pdf.pages[0]!.text.join(' ');
		for (const expected of [
			'Agence Immobilière du Faso',
			'RCCM BF-OUA-2020-B-1234 · IFU 00012345X',
			'Reçu de paiement',
			'N° AIF-2027-000124',
			'Émis le 05/01/2027',
			'Fatimata Sana',
			'Loyer du 01/01/2027 au 31/01/2027',
			'85 000 FCFA',
			'Mobile Money (Orange Money), référence',
			'MP231116.1234.A12',
			'Solde restant dû',
			'75 000 FCFA',
			'Awa Ouédraogo',
			'En lettres',
			'Quatre-vingt-cinq mille francs CFA'
		]) {
			expect(text, expected).toContain(expected);
		}
		expect(text).not.toContain(' ');
		expect(text.toLowerCase()).not.toContain('quittance');
		expect(text).not.toContain('ANNULÉ');
		expect(formatFcfa(85_000)).toContain(' ');
	});

	it('le QR code encode exactement l’adresse de vérification', async () => {
		for (const format of ['a6', 'ticket'] as const) {
			const pdf = await inspectPdf(await renderReceiptPdf({ document: doc(), format, ticketWidth: 58, logoPng: null }));
			expect(pdf.qr, format).toEqual(encode(url, { ecc: 'M', border: 0 }).data);
			expect(pdf.pages.at(-1)!.text.join('')).toContain('Vérifiez ce reçu');
		}
	});

	it('ticket : 58 ou 80 mm de large, une seule page, hauteur selon le contenu', async () => {
		for (const width of [58, 80] as const) {
			const pdf = await inspectPdf(await renderReceiptPdf({ document: doc(), format: 'ticket', ticketWidth: width, logoPng: null }));
			expect(pdf.pages).toHaveLength(1);
			expect(pdf.pages[0]!.width).toBeCloseTo(width * MM, 1);
			expect(pdf.pages[0]!.height).toBeGreaterThan(100 * MM);
			// Aucune ligne ne déborde : la référence longue est coupée plutôt que de sortir du ticket.
			expect(pdf.pages[0]!.text.join(' ')).toContain('MP231116.1234.A12');
		}
	});

	it('reçu annulé : « ANNULÉ » en tête et en filigrane, sur chaque format', async () => {
		for (const format of ['a6', 'ticket'] as const) {
			const pdf = await inspectPdf(await renderReceiptPdf({ document: doc('cancelled'), format, ticketWidth: 80, logoPng: null }));
			expect(pdf.pages, format).toHaveLength(1);
			expect(pdf.pages[0]!.text.filter((t) => t === 'ANNULÉ').length, format).toBe(2);
			expect(pdf.qr, format).toEqual(encode(url, { ecc: 'M', border: 0 }).data);
		}
	});
});
