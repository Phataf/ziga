import { describe, expect, it } from 'vitest';
import type { ImportIssue } from '@ziga/shared/import-rows';
import { checkImportFile, contractsToDeposit, importBusy, issuesBySheet, switchDateChoices } from './views';

describe('date de bascule à l’envoi (réponses 1 et 6 du porteur)', () => {
	it('facturation du premier mois en entier : seulement le 1er d’un mois, le plus récent d’abord, jamais dans le futur', () => {
		const choices = switchDateChoices('2026-11-23', 'calendar_full_first');
		expect(choices).not.toBeNull();
		expect(choices![0]).toBe('2026-11-01');
		expect(choices![1]).toBe('2026-10-01');
		expect(choices).toHaveLength(12);
		expect(choices!.every((d) => d.endsWith('-01') && d <= '2026-11-23')).toBe(true);
		expect(choices!.at(-1)).toBe('2025-12-01');
	});

	it('autres modes : date libre (aucune liste imposée)', () => {
		expect(switchDateChoices('2026-11-23', 'calendar_prorata')).toBeNull();
		expect(switchDateChoices('2026-11-23', 'anniversary')).toBeNull();
	});
});

describe('fichier envoyé', () => {
	it('.xlsx et .csv seulement, 5 Mo au plus, jamais vide', () => {
		expect(checkImportFile({ name: 'Registre 2026.XLSX', size: 1000 })).toEqual({ format: 'xlsx' });
		expect(checkImportFile({ name: 'locataires.csv', size: 10 })).toEqual({ format: 'csv' });
		expect(checkImportFile({ name: 'registre.xls', size: 1000 })).toHaveProperty('error');
		expect(checkImportFile({ name: 'registre.pdf', size: 1000 })).toHaveProperty('error');
		expect(checkImportFile({ name: 'vide.xlsx', size: 0 })).toHaveProperty('error');
		expect(checkImportFile({ name: 'gros.xlsx', size: 5 * 1024 * 1024 + 1 })).toHaveProperty('error');
	});
});

describe('état de l’import', () => {
	it('en cours tant que le serveur travaille (l’écran relit l’import)', () => {
		expect(importBusy('uploaded')).toBe(true);
		expect(importBusy('analyzing')).toBe(true);
		expect(importBusy('running')).toBe(true);
		for (const s of ['analyzed', 'analysis_failed', 'completed', 'failed', 'cancelled'] as const) expect(importBusy(s)).toBe(false);
	});
});

describe('lignes de la prévisualisation', () => {
	const issue = (sheet: ImportIssue['sheet'], row: number, severity: ImportIssue['severity'], message = 'm'): ImportIssue => ({
		sheet,
		row,
		field: null,
		column: null,
		severity,
		code: 'X',
		message,
		value: null
	});

	it('par onglet dans l’ordre du modèle ; erreurs, puis lignes écartées, puis avertissements, chacun par ligne', () => {
		const groups = issuesBySheet([
			issue('leases', 9, 'warning'),
			issue('tenants', 14, 'error'),
			issue('leases', 3, 'skipped'),
			issue('leases', 7, 'error'),
			issue('leases', 2, 'error')
		]);
		expect(groups.map((g) => g.sheet)).toEqual(['tenants', 'leases']);
		expect(groups[1]!.issues.map((i) => [i.severity, i.row])).toEqual([
			['error', 2],
			['error', 7],
			['skipped', 3],
			['warning', 9]
		]);
		expect(groups[1]!.counts).toEqual({ error: 2, skipped: 1, warning: 1 });
	});
});

describe('contrats à déposer', () => {
	const lease = (id: string, over: Record<string, unknown> = {}) => ({
		id,
		status: 'active',
		import_job_id: 'job-1',
		unit_label: `Unité ${id}`,
		tenant_name: `Locataire ${id}`,
		starts_on: '2021-03-01',
		...over
	});

	it('baux de l’import en vigueur ou réservés, sans contrat signé ni scan signé ; par unité', () => {
		const list = contractsToDeposit(
			[
				lease('b'),
				lease('a'),
				lease('signed', { status: 'signed' }),
				lease('notice', { status: 'notice' }),
				lease('manual', { import_job_id: null }),
				lease('cancelled', { status: 'cancelled' }),
				lease('ended', { status: 'ended' }),
				lease('withContract'),
				lease('withScan'),
				lease('amendmentOnly')
			],
			[
				{ lease_id: 'withContract', status: 'signed', amendment_id: null },
				{ lease_id: 'amendmentOnly', status: 'signed', amendment_id: 'am-1' },
				{ lease_id: 'a', status: 'draft', amendment_id: null }
			],
			['withScan']
		);
		expect(list.map((l) => l.id)).toEqual(['a', 'amendmentOnly', 'b', 'notice', 'signed']);
		expect(list[0]).toEqual({ id: 'a', unitLabel: 'Unité a', tenantName: 'Locataire a', startsOn: '2021-03-01', status: 'active' });
	});
});
