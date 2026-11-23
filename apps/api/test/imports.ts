/**
 * Imports Excel de test (lot 11), écrits en SQL : une tâche d'import et ses passages d'état, et le contexte d'import
 * d'une transaction (`app.import_job_id`), que l'exécution de l'import pose dans chaque transaction d'onglet.
 */
import { newId } from '@ziga/shared/ids';
import type pg from 'pg';

export interface ImportJobExtra {
	switchOn?: string;
	fileName?: string;
}

/** Une tâche d'import née « envoyée » (client déjà dans le contexte de l'organisation). */
export async function insertImportJob(c: pg.Client, organizationId: string, userId: string, extra: ImportJobExtra = {}): Promise<string> {
	const id = newId();
	await c.query(
		`insert into import_jobs (id, organization_id, created_by, status, file_name, file_format, file_size, storage_key, switch_on)
		 values ($1, $2, $3, 'uploaded', $4, 'xlsx', 15803, $5, $6)`,
		[
			id,
			organizationId,
			userId,
			extra.fileName ?? 'registre.xlsx',
			`imports/${organizationId}/${id}.xlsx`,
			extra.switchOn ?? firstOfMonth()
		]
	);
	return id;
}

/** 1er du mois en cours (UTC, l'heure de Ouagadougou). */
export function firstOfMonth(): string {
	return `${new Date().toISOString().slice(0, 7)}-01`;
}

/** Envoyée → analysée → en cours d'exécution, par les passages permis. */
export async function startImportJob(c: pg.Client, organizationId: string, jobId: string): Promise<void> {
	await c.query(`update import_jobs set status = 'analyzing' where organization_id = $1 and id = $2`, [organizationId, jobId]);
	await c.query(`update import_jobs set status = 'analyzed', preview = '{}'::jsonb where organization_id = $1 and id = $2`, [
		organizationId,
		jobId
	]);
	await c.query(`update import_jobs set status = 'running', started_at = now() where organization_id = $1 and id = $2`, [
		organizationId,
		jobId
	]);
}

/** En cours → terminée, à l'instant donné (par défaut maintenant). */
export async function completeImportJob(c: pg.Client, organizationId: string, jobId: string, completedAt = 'now()'): Promise<void> {
	await c.query(
		`update import_jobs set status = 'completed', completed_at = ${completedAt}, report = '{}'::jsonb where organization_id = $1 and id = $2`,
		[organizationId, jobId]
	);
}

/** Contexte d'import de la transaction en cours (comme l'exécution de l'import). */
export async function inImport(c: pg.Client, jobId: string | null): Promise<void> {
	await c.query(`select set_config('app.import_job_id', $1, true)`, [jobId ?? '']);
}

/** Annulation de l'import (dans la transaction en cours), puis contexte d'import pour les contre-écritures. */
export async function cancelImportJob(c: pg.Client, organizationId: string, jobId: string, userId: string): Promise<void> {
	await c.query(
		`update import_jobs set status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancellation_reason = 'Import annulé : registre erroné'
		 where organization_id = $1 and id = $2`,
		[organizationId, jobId, userId]
	);
	await inImport(c, jobId);
}

/** Bail importé : facturé à partir de la date de bascule, avec la date de fin d'origine d'un bail échu. */
export async function insertImportedLease(
	c: pg.Client,
	organizationId: string,
	unitId: string,
	tenantId: string,
	extra: { startsOn?: string; duesStartOn?: string; originalEndsOn?: string | null; status?: 'active' | 'signed' } = {}
): Promise<string> {
	const id = newId();
	const startsOn = extra.startsOn ?? '2021-03-01';
	const duesStartOn = extra.duesStartOn ?? firstOfMonth();
	const status = extra.status ?? 'active';
	await c.query(
		`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, dues_start_on, rent, charges, rent_effective_from,
			billing_mode, lessor_type, status, activated_on, activated_at, original_ends_on)
		 values ($1, $2, $3, $4, $5, $6, 75000, 0, $6, 'calendar_prorata', 'owner', $7, current_date, now(), $8)`,
		[id, organizationId, unitId, tenantId, startsOn, duesStartOn, status, extra.originalEndsOn ?? null]
	);
	return id;
}

/** Échéance « Solde antérieur » : du début du bail à la veille de la bascule, exigible à la bascule. */
export async function insertOpeningBalance(
	c: pg.Client,
	organizationId: string,
	leaseId: string,
	extra: { startsOn?: string; switchOn?: string; amount?: number; dueOn?: string } = {}
): Promise<string> {
	const id = newId();
	const switchOn = extra.switchOn ?? firstOfMonth();
	const amount = extra.amount ?? 150_000;
	await c.query(
		`insert into rent_dues (id, organization_id, lease_id, kind, period_start, period_end, due_on, rent, charges, amount_due, status, lease_version)
		 values ($1, $2, $3, 'opening_balance', $4, $5::date - 1, $6, $7, 0, $7, 'overdue', 1)`,
		[id, organizationId, leaseId, extra.startsOn ?? '2021-03-01', switchOn, extra.dueOn ?? switchOn, amount]
	);
	return id;
}

/** Versement d'une caution sans encaissement, daté (D33 : seulement pour une ligne d'import). */
export async function insertImportedReceived(
	c: pg.Client,
	organizationId: string,
	accountId: string,
	amount: number,
	on = '2021-03-01'
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'received', $4, $5)`,
		[id, organizationId, accountId, amount, on]
	);
	return id;
}
