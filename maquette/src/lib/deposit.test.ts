import { describe, expect, it } from 'vitest';
import {
	computeSettlement,
	depositBalance,
	depositWarning,
	noticeEffectiveDate,
	remainingAfterOffsets,
	retentionErrors,
	settlementMovements,
	type Agreement,
	type InspectionItem
} from './deposit';

/** L'exemple du porteur : 100 000 FCFA de caution, douche 10 000, porte 5 000. */
const items: InspectionItem[] = [
	{ id: 'sejour-murs', room: 'Séjour', element: 'Murs et peinture', entry: 'Peinture blanche refaite, sans trace', finding: 'normal_wear' },
	{ id: 'douche', room: 'Douche', element: 'Pommeau et flexible', entry: 'Neufs', finding: 'tenant', note: 'pommeau et flexible cassés', amount: 10000, proof: 'Devis du plombier', repairedBy: 'owner' },
	{ id: 'porte', room: 'Chambre', element: 'Porte', entry: 'Porte pleine, sans fissure', finding: 'tenant', note: 'porte fendue', amount: 5000, proof: 'Photo datée', repairedBy: 'owner' }
];

const accepted = (kind: Agreement['kind'], proposedOn = '2026-10-20'): Agreement => ({
	kind,
	proposedBy: 'tenant',
	proposedOn,
	text: '',
	status: 'accepted',
	decidedOn: proposedOn
});

describe('décompte de sortie (D15)', () => {
	it('A. restitution après réparations : 100 000 − 10 000 − 5 000 = 85 000', () => {
		const s = computeSettlement({ deposit: 100000, items, unpaid: [] });
		expect(s.lines.map((l) => l.amount)).toEqual([10000, 5000]);
		expect(s.refund).toBe(85000);
		expect(s.claim).toBe(0);
		expect(s.errors).toEqual([]);
	});

	it('B. caution imputée sur le dernier loyer par accord écrit et daté avant le mois', () => {
		const offsets = [{ period: '2026-11', amount: 70000 }];
		expect(remainingAfterOffsets(100000, offsets)).toBe(30000);
		const s = computeSettlement({ deposit: 100000, items, unpaid: [], offsets, offsetAgreement: accepted('rent_offset') });
		expect(s.refund).toBe(15000);
		expect(s.lines[0]).toMatchObject({ kind: 'rent_offset', amount: 70000 });
	});

	it('B. refuse l’imputation sans accord, avec un accord non accepté ou daté dans le mois', () => {
		const offsets = [{ period: '2026-11', amount: 70000 }];
		expect(computeSettlement({ deposit: 100000, items, unpaid: [], offsets }).errors[0]).toMatch(/sans accord écrit/);
		expect(computeSettlement({ deposit: 100000, items, unpaid: [], offsets, offsetAgreement: { ...accepted('rent_offset'), status: 'proposed' } }).errors[0]).toMatch(
			/pas encore accepté/
		);
		const late = computeSettlement({ deposit: 100000, items, unpaid: [], offsets, offsetAgreement: accepted('rent_offset', '2026-11-03') });
		expect(late.errors[0]).toMatch(/avant le mois concerné/);
		expect(late.refund).toBe(85000);
	});

	it('C. réparé par le locataire : lignes à 0 FCFA après accord et contre-visite', () => {
		const byTenant = items.map((i) => (i.finding === 'tenant' ? { ...i, repairedBy: 'tenant' as const } : i));
		const pending = computeSettlement({ deposit: 100000, items: byTenant, unpaid: [], repairAgreement: accepted('tenant_repair') });
		expect(pending.refund).toBe(85000); // pas encore de contre-visite : la retenue reste justifiée
		const done = computeSettlement({ deposit: 100000, items: byTenant, unpaid: [], repairAgreement: accepted('tenant_repair'), recheckDone: true });
		expect(done.lines.map((l) => [l.kind, l.amount])).toEqual([
			['tenant_repaired', 0],
			['tenant_repaired', 0]
		]);
		expect(done.refund).toBe(100000);
	});

	it('aucune retenue sans ligne imputable, montant et justificatif (règle 14)', () => {
		expect(retentionErrors({ ...items[1], proof: '' })).toEqual(['Douche — Pommeau et flexible : justificatif manquant (devis, facture ou photo).']);
		expect(retentionErrors({ ...items[1], amount: 0 })[0]).toMatch(/montant/);
		expect(retentionErrors({ ...items[0], amount: 20000 })[0]).toMatch(/usure normale/);
		const s = computeSettlement({ deposit: 100000, items: [{ ...items[0], amount: 20000 }, { ...items[1], proof: undefined }], unpaid: [] });
		expect(s.lines).toEqual([]);
		expect(s.refund).toBe(100000);
		expect(s.errors).toHaveLength(2);
	});

	it('le total des sorties ne dépasse jamais la caution : le reste est réclamé', () => {
		const s = computeSettlement({ deposit: 100000, items, unpaid: [{ period: '2026-10', amount: 95000 }] });
		expect(s.total).toBe(110000);
		expect(s.out).toBe(100000);
		expect(s.refund).toBe(0);
		expect(s.claim).toBe(10000);
		const movements = settlementMovements('l', s, '2026-11-07');
		const outflows = movements.filter((m) => m.kind !== 'claim').reduce((sum, m) => sum + m.amount, 0);
		expect(outflows).toBe(100000);
		expect(movements.at(-1)).toMatchObject({ kind: 'claim', amount: 10000 });
	});

	it('chaque retenue du compte de caution pointe vers sa ligne d’état des lieux, et le solde revient à zéro', () => {
		const s = computeSettlement({ deposit: 100000, items, unpaid: [] });
		const movements = settlementMovements('l', s, '2026-11-07');
		expect(movements.filter((m) => m.kind === 'retention').map((m) => m.inspectionItemId)).toEqual(['douche', 'porte']);
		expect(depositBalance([{ id: '0', leaseId: 'l', date: '2024-12-01', kind: 'received', amount: 100000, label: '' }, ...movements])).toBe(0);
	});

	it('avertit au-delà de deux mois de loyer, sans bloquer', () => {
		expect(depositWarning(100000, 70000)).toBeUndefined();
		expect(depositWarning(100000, 45000)).toMatch(/plus de deux mois/);
	});

	it('préavis : trois mois pour un bail à durée indéterminée, deux mois pour un bail à durée déterminée', () => {
		expect(noticeEffectiveDate('2026-08-31', 'open')).toBe('2026-11-30');
		expect(noticeEffectiveDate('2026-09-15', 'fixed')).toBe('2026-11-15');
	});
});
