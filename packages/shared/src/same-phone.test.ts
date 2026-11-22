import { describe, expect, it } from 'vitest';
import { otherRecordsWithSamePhone } from './same-phone.js';

/** Dette du lot 10 ter, faite au lot 11 : signal « Une autre fiche porte ce numéro ». */
describe('fiches au même numéro dans une organisation', () => {
	const records = [
		{ id: 't1', name: 'Kaboré Issouf', phone: '+22670123456', status: 'active' },
		{ id: 't2', name: 'KABORÉ Issouf', phone: '+22670123456', status: 'active' },
		{ id: 't3', name: 'Kaboré Aminata', phone: '+22670123456', status: 'active' },
		{ id: 't4', name: 'Zongo Paul', phone: '+22665432109', status: 'active' },
		{ id: 't5', name: 'Kaboré Issouf', phone: '+22670123456', status: 'archived' },
		{ id: 't6', name: 'Sans numéro', phone: null, status: 'active' }
	];

	it('les autres fiches actives au même numéro, même nom d’abord, puis par nom', () => {
		expect(otherRecordsWithSamePhone(records[0]!, records)).toEqual([
			{ id: 't2', name: 'KABORÉ Issouf', sameName: true },
			{ id: 't3', name: 'Kaboré Aminata', sameName: false }
		]);
	});

	it('une fiche seule à son numéro, une fiche sans numéro : aucun signal', () => {
		expect(otherRecordsWithSamePhone(records[3]!, records)).toEqual([]);
		expect(otherRecordsWithSamePhone(records[5]!, records)).toEqual([]);
	});

	it('une fiche archivée ne déclenche pas le signal, et n’en reçoit pas', () => {
		expect(otherRecordsWithSamePhone(records[4]!, records)).toEqual([]);
		expect(otherRecordsWithSamePhone(records[1]!, records).map((r) => r.id)).toEqual(['t1', 't3']);
	});
});
