/** Reçus (lot 09) : numérotation, préfixe, réglages, statuts et contenu du document. */
import { describe, expect, it } from 'vitest';
import { NBSP, THIN_NBSP } from './money.js';
import {
	canTransitionReceipt,
	defaultReceiptPrefix,
	formatReceiptNumber,
	parseReceiptNumber,
	receiptDocument,
	receiptObject,
	receiptPrefixSchema,
	receiptSettingsBlockers,
	receiptSettingsSchema,
	receiptYear,
	RECEIPT_STATUSES,
	type ReceiptSnapshot
} from './receipts.js';

describe('numéro de reçu', () => {
	it('préfixe, année, rang sur six chiffres', () => {
		expect(formatReceiptNumber('AGX', 2027, 124)).toBe('AGX-2027-000124');
		expect(formatReceiptNumber('IMMO', 2027, 1)).toBe('IMMO-2027-000001');
		expect(formatReceiptNumber('AB', 2027, 1_234_567)).toBe('AB-2027-1234567');
	});
	it('refuse un préfixe, une année ou un rang invalides', () => {
		expect(() => formatReceiptNumber('agx', 2027, 1)).toThrow(RangeError);
		expect(() => formatReceiptNumber('A', 2027, 1)).toThrow(RangeError);
		expect(() => formatReceiptNumber('AGX', 2027, 0)).toThrow(RangeError);
		expect(() => formatReceiptNumber('AGX', 27, 1)).toThrow(RangeError);
	});
	it('se relit', () => {
		expect(parseReceiptNumber('AGX-2027-000124')).toEqual({ prefix: 'AGX', year: 2027, sequence: 124 });
		expect(parseReceiptNumber('PROV-7F3A1C')).toBeNull();
		expect(parseReceiptNumber('AGX-2027-000000')).toBeNull();
	});
	it('année de la date d’émission', () => {
		expect(receiptYear('2027-12-31')).toBe(2027);
		expect(receiptYear('2028-01-01')).toBe(2028);
	});
});

describe('préfixe', () => {
	it('2 à 6 lettres majuscules ; la saisie en minuscules est acceptée', () => {
		expect(receiptPrefixSchema.parse(' agx ')).toBe('AGX');
		for (const bad of ['A', 'ABCDEFG', 'AG1', 'ÉTÉ', 'AG-X', '']) expect(receiptPrefixSchema.safeParse(bad).success, bad).toBe(false);
	});
	it('proposé à partir du nom de l’organisation', () => {
		expect(defaultReceiptPrefix('Agence Immobilière du Faso')).toBe('AIF');
		expect(defaultReceiptPrefix('Kaboré')).toBe('KAB');
		expect(defaultReceiptPrefix('SARL Les Toits de Ouaga')).toBe('TO');
		expect(defaultReceiptPrefix('Immo Plus Services Conseils Gestion Faso Ouaga')).toBe('IPSCGF');
		expect(defaultReceiptPrefix('A')).toBe('RECU');
		expect(defaultReceiptPrefix('123')).toBe('RECU');
		for (const name of ['Agence Immobilière du Faso', 'Kaboré', 'Ets Ouédraogo & Fils', 'L’Étoile']) {
			expect(receiptPrefixSchema.safeParse(defaultReceiptPrefix(name)).success, name).toBe(true);
		}
	});
});

describe('réglages de la numérotation (réponse du porteur)', () => {
	const fresh = { issuedCount: 0, firstNumberSet: false };
	it('avant le premier reçu : préfixe et premier numéro modifiables', () => {
		expect(receiptSettingsBlockers(fresh, { prefix: 'AGX', firstNumber: 124 })).toEqual([]);
	});
	it('premier numéro : une seule fois', () => {
		expect(receiptSettingsBlockers({ ...fresh, firstNumberSet: true }, { firstNumber: 200 })).toEqual(['RECEIPT_FIRST_NUMBER_ALREADY_SET']);
		expect(receiptSettingsBlockers({ ...fresh, firstNumberSet: true }, { prefix: 'AGX' })).toEqual([]);
	});
	it('après le premier reçu : préfixe et premier numéro figés ; la largeur du ticket reste réglable', () => {
		const issued = { issuedCount: 1, firstNumberSet: false };
		expect(receiptSettingsBlockers(issued, { prefix: 'AGX' })).toEqual(['RECEIPT_PREFIX_LOCKED']);
		expect(receiptSettingsBlockers(issued, { firstNumber: 5 })).toEqual(['RECEIPT_FIRST_NUMBER_LOCKED']);
		expect(receiptSettingsBlockers(issued, { ticketWidth: 58 })).toEqual([]);
	});
	it('schéma : un réglage au moins ; ticket de 58 ou 80 mm ; premier numéro entier positif', () => {
		expect(receiptSettingsSchema.safeParse({}).success).toBe(false);
		expect(receiptSettingsSchema.parse({ ticketWidth: 58 })).toEqual({ ticketWidth: 58 });
		expect(receiptSettingsSchema.safeParse({ ticketWidth: 72 }).success).toBe(false);
		for (const n of [0, -1, 1.5]) expect(receiptSettingsSchema.safeParse({ firstNumber: n }).success).toBe(false);
	});
});

describe('statuts du reçu', () => {
	it('provisoire → valide ou annulé ; valide → annulé ; annulé : définitif', () => {
		const allowed = ['provisional>valid', 'provisional>cancelled', 'valid>cancelled'];
		for (const from of RECEIPT_STATUSES) {
			for (const to of RECEIPT_STATUSES) expect(canTransitionReceipt(from, to), `${from} → ${to}`).toBe(allowed.includes(`${from}>${to}`));
		}
	});
});

describe('contenu du reçu', () => {
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
		unit: { label: 'Villa A — Appartement 2', address: 'Ouaga 2000, secteur 15' },
		purpose: 'rent',
		periods: [
			{ start: '2027-01-01', end: '2027-01-31', amount: 80_000, isAdvance: false },
			{ start: '2027-02-01', end: '2027-02-28', amount: 5_000, isAdvance: true }
		],
		credit: 0,
		deposit: null,
		amount: 85_000,
		method: 'mobile_money_manual',
		operator: 'orange_money',
		transactionReference: 'MP231116.1234',
		paidOn: '2027-01-05',
		balanceDue: 75_000,
		collectedBy: 'Awa Ouédraogo'
	};

	it('« Reçu de paiement », jamais « quittance » ; mentions dans l’ordre retenu', () => {
		const doc = receiptDocument({
			snapshot,
			status: 'valid',
			number: 'AIF-2027-000124',
			provisionalNumber: 'PROV-ABCDEF',
			issuedOn: '2027-01-05',
			verificationUrl: 'https://ziga.com/r/x'
		});
		expect(doc.title).toBe('Reçu de paiement');
		expect(JSON.stringify(doc).toLowerCase()).not.toContain('quittance');
		expect(doc.number).toBe('AIF-2027-000124');
		expect(doc.issuedOn).toBe('05/01/2027');
		expect(doc.organization).toEqual([
			'Agence Immobilière du Faso',
			'Avenue Kwame Nkrumah, Ouagadougou',
			'01 BP 1234 Ouagadougou 01',
			'Tél. +226 70 12 34 56',
			'RCCM BF-OUA-2020-B-1234 · IFU 00012345X'
		]);
		expect(doc.fields.map((f) => f.label)).toEqual([
			'Locataire',
			'Logement',
			'Objet',
			'Montant',
			'Moyen de paiement',
			'Date du paiement',
			'Solde restant dû',
			'Encaissé par'
		]);
		expect(doc.fields.find((f) => f.label === 'Montant')!.value).toBe(`85${THIN_NBSP}000${NBSP}FCFA`);
		expect(doc.fields.find((f) => f.label === 'Moyen de paiement')!.value).toBe('Mobile Money (Orange Money), référence MP231116.1234');
		expect(doc.amountInWords).toBe('Quatre-vingt-cinq mille francs CFA');
		expect(doc.cancelled).toBe(false);
	});

	it('provisoire tant que le numéro n’est pas attribué ; « ANNULÉ » une fois annulé', () => {
		const base = { snapshot, provisionalNumber: 'PROV-ABCDEF', issuedOn: null, verificationUrl: null };
		const provisional = receiptDocument({ ...base, status: 'provisional', number: null });
		expect(provisional.title).toBe('Reçu provisoire');
		expect(provisional.number).toBe('PROV-ABCDEF');
		expect(receiptDocument({ ...base, status: 'cancelled', number: 'AIF-2027-000124' }).cancelled).toBe(true);
	});

	it('organisation sans RCCM ni IFU (bailleur particulier) : rien d’inventé', () => {
		const doc = receiptDocument({
			snapshot: { ...snapshot, organization: { ...snapshot.organization, rccm: null, ifu: null, poBox: null, address: null } },
			status: 'valid',
			number: 'KAB-2027-000001',
			provisionalNumber: 'PROV-ABCDEF',
			issuedOn: '2027-01-05',
			verificationUrl: null
		});
		expect(doc.organization).toEqual(['Agence Immobilière du Faso', 'Ouagadougou', 'Tél. +226 70 12 34 56']);
	});

	it('objet : périodes couvertes, avance, crédit ; versement de caution avec son détenteur', () => {
		expect(receiptObject(snapshot)).toEqual([
			`Loyer du 01/01/2027 au 31/01/2027 : 80${THIN_NBSP}000${NBSP}FCFA`,
			`Loyer du 01/02/2027 au 28/02/2027 (avance) : 5${THIN_NBSP}000${NBSP}FCFA`
		]);
		// Lot 11 : l'échéance « Solde antérieur » d'un bail importé n'est pas un loyer de la période.
		expect(
			receiptObject({
				...snapshot,
				periods: [{ start: '2021-03-01', end: '2026-10-31', amount: 250_000, isAdvance: false, openingBalance: true }]
			})
		).toEqual([`Solde antérieur (du 01/03/2021 au 31/10/2026) : 250${THIN_NBSP}000${NBSP}FCFA`]);
		expect(receiptObject({ ...snapshot, periods: [], credit: 20_000 })).toEqual([
			`Avance sur les loyers à venir : 20${THIN_NBSP}000${NBSP}FCFA`
		]);
		expect(receiptObject({ ...snapshot, purpose: 'deposit', deposit: { type: 'security_deposit', holder: 'owner' } })).toEqual([
			'Versement du dépôt de garantie, détenu par le propriétaire'
		]);
		expect(receiptObject({ ...snapshot, purpose: 'deposit', deposit: { type: 'utilities_guarantee', holder: 'organization' } })).toEqual([
			'Versement de la garantie des factures, détenu par l’organisation'
		]);
	});
});
