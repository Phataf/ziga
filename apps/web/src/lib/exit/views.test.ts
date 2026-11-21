import { describe, expect, it } from 'vitest';
import {
	currentLines,
	exitStage,
	itemBlockers,
	lineProof,
	parseDateArray,
	roomTemplate,
	signatureView,
	toInspection,
	toItem,
	toLine,
	toRepair,
	toSettlement
} from './views';

const inspection = (extra: Record<string, unknown> = {}) =>
	toInspection({ id: 'i1', lease_id: 'l1', type: 'exit', inspected_on: '2026-11-21', ...extra });

describe('sortie du locataire lue sur l’appareil (lot 10 bis, étape 4)', () => {
	it('mois d’un accord : JSON ou littéral PostgreSQL', () => {
		expect(parseDateArray('["2026-11-01","2026-12-01"]')).toEqual(['2026-11-01', '2026-12-01']);
		expect(parseDateArray('{2026-11-01,2026-12-01}')).toEqual(['2026-11-01', '2026-12-01']);
		expect(parseDateArray(null)).toEqual([]);
	});

	it('point 5 : « Case cochée par … le … sur l’appareil de … », jamais une signature électronique', () => {
		const names = new Map([
			['u-agent', 'Awa Ouédraogo'],
			['u-gest', 'Issa Sawadogo']
		]);
		const ctx = { names, tenantName: 'Salif Traoré', me: { id: 'u-agent', name: 'Awa Ouédraogo' } };
		const s = signatureView(
			inspection({
				organization_signed_at: '2026-11-21T09:30:00.000Z',
				organization_signed_by: 'u-gest',
				tenant_signed_at: '2026-11-21T09:31:00.000Z',
				tenant_signed_recorded_by: 'u-agent'
			}),
			ctx
		);
		expect(s.organization).toBe('Case cochée par Issa Sawadogo le 21/11/2026 à 09:30 sur l’appareil de Issa Sawadogo');
		expect(s.tenant).toBe('Case cochée par Salif Traoré le 21/11/2026 à 09:31 sur l’appareil de Awa Ouédraogo');
		expect(s.complete).toBe(true);
		expect(JSON.stringify(s)).not.toMatch(/électronique/i);
		// Cochée sur cet appareil, pas encore reçue par le serveur : la personne connectée.
		const local = signatureView(inspection({ tenant_signed_at: '2026-11-21T09:31:00.000Z' }), ctx);
		expect(local.tenant).toMatch(/sur l’appareil de Awa Ouédraogo$/);
		expect(local.complete).toBe(false);
		// Scan déposé : « signature manuscrite, scan déposé ».
		const scan = signatureView(inspection({ scan_document_id: 'd1' }), {
			...ctx,
			scanUploader: { name: 'Issa Sawadogo', at: '2026-11-21T10:00:00.000Z' }
		});
		expect(scan.scan).toBe('Signature manuscrite, scan déposé par Issa Sawadogo le 21/11/2026');
		expect(scan.complete).toBe(true);
	});

	it('« bon état » seul refusé avant de signer, constat exigé à la sortie (même règle que le serveur)', () => {
		const items = [
			toItem({ id: 'a', inspection_id: 'i1', room: 'Salon', element: 'door', description: 'Bon état', finding: 'normal_wear' }),
			toItem({
				id: 'b',
				inspection_id: 'i1',
				room: 'Salon',
				element: 'floor',
				description: 'Carrelage fendu près de la porte',
				finding: null
			}),
			toItem({
				id: 'c',
				inspection_id: 'i1',
				room: 'Salon',
				element: 'walls_paint',
				description: 'Peinture rayée au-dessus du lit',
				finding: 'tenant_damage'
			})
		];
		expect(Object.fromEntries(itemBlockers('exit', items))).toEqual({
			a: 'INSPECTION_DESCRIPTION_VAGUE',
			b: 'INSPECTION_FINDING_REQUIRED'
		});
	});

	it('point 3 : chaque ligne montre son justificatif ou ce qui manque ; seules les lignes de la révision en cours', () => {
		const s = toSettlement({
			id: 's1',
			deposit_account_id: 'a1',
			lease_id: 'l1',
			revision: 2,
			received: 100000,
			deductions: 15000,
			refund: 85000
		});
		const lines = [
			toLine({ id: 'old', settlement_id: 's1', revision: 1, position: 0, kind: 'repair', amount: 9000, repair_id: 'r1' }),
			toLine({ id: 'x2', settlement_id: 's1', revision: 2, position: 1, kind: 'repair', amount: 5000, repair_id: 'r2' }),
			toLine({ id: 'x1', settlement_id: 's1', revision: 2, position: 0, kind: 'repair', amount: 10000, repair_id: 'r1' }),
			toLine({
				id: 'x3',
				settlement_id: 's1',
				revision: 2,
				position: 2,
				kind: 'repair',
				amount: 0,
				repair_id: 'r3',
				blocker: 'RETENTION_PROOF_MISSING'
			})
		];
		const shown = currentLines(s, lines);
		expect(shown.map((l) => l.id)).toEqual(['x1', 'x2', 'x3']);
		const repairs = new Map(
			[
				toRepair({ id: 'r1', inspection_item_id: 'it1', lease_id: 'l1', quote_document_id: 'devis-1' }),
				toRepair({ id: 'r2', inspection_item_id: 'it2', lease_id: 'l1', quote_document_id: 'devis-2', invoice_document_id: 'facture-2' })
			].map((r) => [r.id, r])
		);
		const ctx = { repairs, agreements: new Map() };
		expect(shown.map((l) => lineProof(l, ctx))).toEqual([
			{ documentId: 'devis-1', missing: null },
			{ documentId: 'facture-2', missing: null },
			{ documentId: null, missing: 'RETENTION_PROOF_MISSING' }
		]);
		expect(s).toMatchObject({ received: 100000, deductions: 15000, refund: 85000 });
	});

	it('étape d’une sortie, et éléments proposés par pièce', () => {
		expect(exitStage({ exitInspection: null, settlement: null })).toBe('notice');
		expect(exitStage({ exitInspection: inspection(), settlement: null })).toBe('inspection');
		expect(
			exitStage({ exitInspection: inspection({ status: 'signed_both' }), settlement: toSettlement({ id: 's', status: 'disputed' }) })
		).toBe('disputed');
		expect(exitStage({ exitInspection: inspection(), settlement: toSettlement({ id: 's', status: 'closed' }) })).toBe('closed');
		expect(roomTemplate('Douche et WC')).toContain('shower');
		expect(roomTemplate('Pièce inconnue')).toEqual(['door', 'walls_paint', 'floor', 'switches_outlets', 'lights']);
	});
});
