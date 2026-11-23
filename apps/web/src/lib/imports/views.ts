/**
 * Écrans de l'import Excel (lot 11) : règles d'affichage pures. Les règles de l'import sont dans `packages/shared`
 * (`import-*.ts`) et dans l'API ; l'écran ne fait que les montrer.
 */
import type { ImportIssue } from '@ziga/shared/import-rows';
import { IMPORT_SHEET_KEYS, type ImportSheetKey } from '@ziga/shared/import-template';
import { IMPORT_MAX_FILE_BYTES, type ImportFileFormat, type ImportJobStatus } from '@ziga/shared/imports';
import type { RentBillingMode } from '@ziga/shared/rent-schedule';
import { fr } from '../i18n/fr';

type Row = Record<string, unknown>;

/** Mois proposés quand l'organisation facture le premier mois en entier (réponse 6 du porteur). */
const SWITCH_MONTHS = 12;

/**
 * Dates de bascule proposées : en `calendar_full_first`, le 1er du mois en cours et des onze mois précédents (le plus
 * récent d'abord) ; sinon `null`, la date est libre (jamais dans le futur, vérifié par le champ et par le serveur).
 */
export function switchDateChoices(today: string, mode: RentBillingMode): string[] | null {
	if (mode !== 'calendar_full_first') return null;
	let [y, m] = today.split('-').map(Number) as [number, number];
	const out: string[] = [];
	for (let i = 0; i < SWITCH_MONTHS; i++) {
		out.push(`${y}-${String(m).padStart(2, '0')}-01`);
		m -= 1;
		if (m === 0) {
			m = 12;
			y -= 1;
		}
	}
	return out;
}

/** Fichier choisi : `.xlsx` ou `.csv`, 5 Mo au plus, jamais vide. Le serveur le vérifie de nouveau. */
export function checkImportFile(file: { name: string; size: number }): { format: ImportFileFormat } | { error: string } {
	const t = fr.imports.send;
	const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
	if (ext !== 'xlsx' && ext !== 'csv') return { error: t.badFormat };
	if (file.size <= 0) return { error: t.emptyFile };
	if (file.size > IMPORT_MAX_FILE_BYTES) return { error: t.tooLarge };
	return { format: ext };
}

/** Le serveur travaille encore (envoi, analyse, exécution) : l'écran relit l'import. */
export function importBusy(status: ImportJobStatus): boolean {
	return status === 'uploaded' || status === 'analyzing' || status === 'running';
}

const SEVERITY_ORDER: Record<ImportIssue['severity'], number> = { error: 0, skipped: 1, warning: 2 };

export interface IssueGroup {
	sheet: ImportSheetKey;
	issues: ImportIssue[];
	counts: Record<ImportIssue['severity'], number>;
}

/** Lignes de la prévisualisation par onglet, dans l'ordre du modèle : erreurs, lignes écartées, avertissements. */
export function issuesBySheet(issues: readonly ImportIssue[]): IssueGroup[] {
	return IMPORT_SHEET_KEYS.flatMap((sheet): IssueGroup[] => {
		const mine = issues
			.filter((i) => i.sheet === sheet)
			.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.row - b.row);
		if (!mine.length) return [];
		const counts = { error: 0, skipped: 0, warning: 0 };
		for (const i of mine) counts[i.severity] += 1;
		return [{ sheet, issues: mine, counts }];
	});
}

export interface ContractToDeposit {
	id: string;
	unitLabel: string;
	tenantName: string;
	startsOn: string;
	status: string;
}

/** Baux en vigueur, en préavis ou réservés : leur contrat signé est attendu. */
const NEEDS_CONTRACT = new Set(['signed', 'active', 'notice']);

/**
 * « Contrats à déposer » : baux créés par un import, en vigueur ou réservés, sans contrat du bail signé (hors avenant)
 * ni scan signé déposé, par unité. Lus sur l'appareil (`contractLeases`, `contracts`, `signedScans`).
 */
export function contractsToDeposit(
	leases: readonly Row[],
	contracts: readonly Row[],
	signedScanLeaseIds: readonly string[]
): ContractToDeposit[] {
	const signed = new Set([
		...contracts.filter((c) => c.status === 'signed' && !c.amendment_id).map((c) => String(c.lease_id)),
		...signedScanLeaseIds
	]);
	return leases
		.filter((l) => l.import_job_id && NEEDS_CONTRACT.has(String(l.status)) && !signed.has(String(l.id)))
		.map((l) => ({
			id: String(l.id),
			unitLabel: String(l.unit_label ?? ''),
			tenantName: String(l.tenant_name ?? ''),
			startsOn: String(l.starts_on ?? ''),
			status: String(l.status)
		}))
		.sort((a, b) => a.unitLabel.localeCompare(b.unitLabel, 'fr', { numeric: true }) || a.id.localeCompare(b.id));
}
