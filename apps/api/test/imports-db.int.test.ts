/**
 * Lot 11, étape 2 : l'import Excel dans la base (migration 0025), en SQL avec le rôle de l'API (app_api, sans
 * BYPASSRLS). Écrit avant la migration (rouge).
 * - import_jobs : accès croisé A/B (lire, modifier, référencer : règle 1), née « envoyée » par la direction ou la
 *   gestion, passages d'état, fichier conservé 90 jours, date de bascule jamais dans le futur et au 1er du mois si le
 *   premier mois est facturé en entier, jamais supprimée, jamais synchronisée.
 * - Chaque ligne créée pendant l'exécution porte l'identifiant de l'import (prompt §4), posé par la base depuis le
 *   contexte de la transaction, jamais par le client ; il ne change plus ; origine d'audit `import`.
 * - D33 : versement de caution sans encaissement seulement pour un compte créé par l'import en cours, une fois ; aucun
 *   reçu ; hors import, toujours refusé.
 * - Échéance « Solde antérieur » : seulement pour un bail de l'import, une par bail, du début du bail à la veille de la
 *   bascule, exigible à la date de bascule.
 * - Date de fin d'origine d'un bail échu (réponse 3) : seulement à l'import, figée.
 * - Annulation sous 24 heures sans encaissement : le bail importé en vigueur s'annule, sa caution par contre-écriture ;
 *   hors de l'annulation de son import, un bail en vigueur ne s'annule toujours pas.
 */
import { newId } from '@ziga/shared/ids';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './http.js';
import {
	cancelImportJob,
	completeImportJob,
	firstOfMonth,
	inImport,
	insertImportedLease,
	insertImportedReceived,
	insertImportJob,
	insertOpeningBalance,
	startImportJob
} from './imports.js';
import { insertDepositAccount, insertLease, insertTenant } from './leases.js';
import { addMember, apiSql, createOrg, inContext, sqlError, type Member, type Org } from './orgs.js';
import { insertPayment } from './payments.js';
import { insertOwnerRecord, migrationClient, seedIn } from './portals.js';
import { propertyWithUnit } from './properties.js';

let t: TestApp;
let owner: pg.Client;
let api: pg.Client;
let a: Org;
let b: Org;
let managerA: Member;
let viewerA: Member;
let ownerA: string;
let jobB: string;

const ctxA = () => ({ organizationId: a.id, userId: a.director.userId });
const yesterdayPlus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Import en cours d'exécution dans A (dans la transaction de test). */
async function runningInA(): Promise<string> {
	const job = await insertImportJob(api, a.id, managerA.userId);
	await startImportJob(api, a.id, job);
	return job;
}

beforeAll(async () => {
	t = await startApp();
	owner = await migrationClient();
	api = await apiSql();
	a = await createOrg(t, 'agency', 'Agence A (import)');
	b = await createOrg(t, 'agency', 'Agence B (import)');
	managerA = await addMember(t, a, 'manager');
	viewerA = await addMember(t, a, 'viewer');
	ownerA = await seedIn(owner, a.id, (c) => insertOwnerRecord(c, a.id, 'Mariam Ouédraogo', '+22670112233'));
	jobB = await seedIn(owner, b.id, (c) => insertImportJob(c, b.id, b.director.userId));
});

afterAll(async () => {
	await api?.end();
	await owner?.end();
	await t?.close();
});

describe('import_jobs : cloisonnement et règles (règle 1, prompt §4)', () => {
	it('accès croisé : depuis A, rien de B en lecture ; modification sans effet ; création chez B refusée', async () => {
		await inContext(api, ctxA(), async () => {
			expect((await api.query(`select 1 from import_jobs where id = $1`, [jobB])).rowCount).toBe(0);
			expect((await api.query(`update import_jobs set status = 'analyzing' where id = $1`, [jobB])).rowCount).toBe(0);
			const other = await sqlError(
				api,
				`insert into import_jobs (id, organization_id, created_by, status, file_name, file_format, file_size, storage_key, switch_on)
				 values ($1, $2, $3, 'uploaded', 'x.xlsx', 'xlsx', 10, 'k', $4)`,
				[newId(), b.id, a.director.userId, firstOfMonth()]
			);
			expect(other.code).toBe('42501');
		});
	});

	it('accès croisé : une ligne de A ne peut pas porter un import de B', async () => {
		await inContext(api, ctxA(), async () => {
			await inImport(api, jobB);
			const e = await sqlError(api, `insert into tenants (id, organization_id, full_name) values ($1, $2, 'Awa Traoré')`, [newId(), a.id]);
			expect(e.message).toContain('IMPORT_JOB_UNKNOWN');
		});
	});

	it('née « envoyée », par la direction ou la gestion ; jamais par un lecteur', async () => {
		await inContext(api, ctxA(), async () => {
			const job = await insertImportJob(api, a.id, managerA.userId);
			const row = (await api.query(`select status, file_expires_at - created_at as kept from import_jobs where id = $1`, [job])).rows[0];
			expect(row.status).toBe('uploaded');
			// Fichier d'origine conservé 90 jours (prompt §4), quelle que soit la valeur envoyée.
			expect(row.kept.days).toBe(90);
			const viewer = await sqlError(
				api,
				`insert into import_jobs (id, organization_id, created_by, status, file_name, file_format, file_size, storage_key, switch_on)
				 values ($1, $2, $3, 'uploaded', 'x.xlsx', 'xlsx', 10, 'k', $4)`,
				[newId(), a.id, viewerA.userId, firstOfMonth()]
			);
			expect(viewer.message).toContain('IMPORT_RUNNER');
			const running = await sqlError(
				api,
				`insert into import_jobs (id, organization_id, created_by, status, file_name, file_format, file_size, storage_key, switch_on)
				 values ($1, $2, $3, 'running', 'x.xlsx', 'xlsx', 10, 'k', $4)`,
				[newId(), a.id, managerA.userId, firstOfMonth()]
			);
			expect(running.message).toContain('IMPORT_BORN_UPLOADED');
		});
	});

	it('date de bascule : jamais dans le futur ; au 1er du mois si le premier mois est facturé en entier (réponses 1 et 3)', async () => {
		await inContext(api, ctxA(), async () => {
			const future = await sqlError(
				api,
				`insert into import_jobs (id, organization_id, created_by, status, file_name, file_format, file_size, storage_key, switch_on)
				 values ($1, $2, $3, 'uploaded', 'x.xlsx', 'xlsx', 10, 'k', $4)`,
				[newId(), a.id, managerA.userId, yesterdayPlus(2)]
			);
			expect(future.message).toContain('IMPORT_SWITCH_FUTURE');
		});
		await seedIn(owner, a.id, (c) => c.query(`update organizations set rent_billing_mode = 'calendar_full_first' where id = $1`, [a.id]));
		try {
			await inContext(api, ctxA(), async () => {
				const e = await sqlError(
					api,
					`insert into import_jobs (id, organization_id, created_by, status, file_name, file_format, file_size, storage_key, switch_on)
					 values ($1, $2, $3, 'uploaded', 'x.xlsx', 'xlsx', 10, 'k', '2026-01-15')`,
					[newId(), a.id, managerA.userId]
				);
				expect(e.message).toContain('IMPORT_SWITCH_FIRST_OF_MONTH');
				await insertImportJob(api, a.id, managerA.userId, { switchOn: firstOfMonth() });
			});
		} finally {
			await seedIn(owner, a.id, (c) => c.query(`update organizations set rent_billing_mode = 'calendar_prorata' where id = $1`, [a.id]));
		}
	});

	it('passages d’état ; fichier et auteur figés ; bascule figée dès l’exécution', async () => {
		await inContext(api, ctxA(), async () => {
			const job = await insertImportJob(api, a.id, managerA.userId);
			const skip = await sqlError(api, `update import_jobs set status = 'running', started_at = now() where id = $1`, [job]);
			expect(skip.message).toContain('IMPORT_STATUS');
			await startImportJob(api, a.id, job);
			const file = await sqlError(api, `update import_jobs set storage_key = 'autre' where id = $1`, [job]);
			expect(file.message).toContain('IMPORT_JOB_IMMUTABLE');
			const switchOn = await sqlError(api, `update import_jobs set switch_on = switch_on - 1 where id = $1`, [job]);
			expect(switchOn.message).toContain('IMPORT_JOB_IMMUTABLE');
			await completeImportJob(api, a.id, job);
			const again = await sqlError(api, `update import_jobs set status = 'running' where id = $1`, [job]);
			expect(again.message).toContain('IMPORT_STATUS');
		});
	});

	it('jamais supprimée ; jamais synchronisée (ni publiée, ni lisible par app_sync)', async () => {
		await inContext(api, ctxA(), async () => {
			const job = await insertImportJob(api, a.id, managerA.userId);
			expect((await sqlError(api, `delete from import_jobs where id = $1`, [job])).code).toBe('42501');
		});
		const published = await owner.query(`select 1 from pg_publication_tables where pubname = 'powersync' and tablename = 'import_jobs'`);
		expect(published.rowCount).toBe(0);
		const grant = await owner.query(`select has_table_privilege('app_sync', 'import_jobs', 'SELECT') as can`);
		expect(grant.rows[0].can).toBe(false);
	});
});

describe('identifiant de l’import sur chaque ligne créée (prompt §4)', () => {
	it('posé par la base depuis le contexte de l’import, sur les fiches, biens, unités, baux, échéances, cautions et le journal', async () => {
		await inContext(api, ctxA(), async () => {
			const job = await runningInA();
			await inImport(api, job);
			const tenant = await insertTenant(api, a.id);
			const { property, unit } = await propertyWithUnit(api, a.id, ownerA);
			const lease = await insertImportedLease(api, a.id, unit, tenant);
			const account = await insertDepositAccount(api, a.id, lease);
			const audit = newId();
			await api.query(
				`insert into audit_log (id, occurred_at, actor_type, actor_user_id, organization_id, action, object_type, object_id, origin)
				 values ($1, now(), 'user', $2, $3, 'tenant.create', 'tenant', $4, 'import')`,
				[audit, managerA.userId, a.id, tenant]
			);
			for (const [table, id] of [
				['tenants', tenant],
				['properties', property],
				['units', unit],
				['leases', lease],
				['deposit_accounts', account],
				['audit_log', audit]
			] as const) {
				const r = await api.query(`select import_job_id from ${table} where id = $1`, [id]);
				expect(r.rows[0].import_job_id, table).toBe(job);
			}
			// La version du bail, écrite par la base, porte aussi l'import.
			const v = await api.query(`select import_job_id from lease_versions where lease_id = $1`, [lease]);
			expect(v.rows.every((r: { import_job_id: string }) => r.import_job_id === job)).toBe(true);
		});
	});

	it('hors import : vide, même si le client l’écrit ; jamais modifié ensuite', async () => {
		await inContext(api, ctxA(), async () => {
			const job = await runningInA();
			const id = newId();
			await api.query(`insert into tenants (id, organization_id, full_name, import_job_id) values ($1, $2, 'Paul Zongo', $3)`, [
				id,
				a.id,
				job
			]);
			expect((await api.query(`select import_job_id from tenants where id = $1`, [id])).rows[0].import_job_id).toBeNull();
			const forged = await sqlError(api, `update tenants set import_job_id = $2 where id = $1`, [id, job]);
			expect(forged.message).toContain('IMPORT_JOB_IMMUTABLE');
		});
	});

	it('un import qui n’est pas en cours d’exécution ne marque rien', async () => {
		await inContext(api, ctxA(), async () => {
			const job = await insertImportJob(api, a.id, managerA.userId);
			await inImport(api, job);
			const e = await sqlError(api, `insert into tenants (id, organization_id, full_name) values ($1, $2, 'Awa Traoré')`, [newId(), a.id]);
			expect(e.message).toContain('IMPORT_JOB_NOT_RUNNING');
		});
	});
});

describe('D33 : caution reçue avant l’adoption, sans encaissement ni reçu', () => {
	it('hors import : refusé, comme depuis la migration 0016', async () => {
		await inContext(api, ctxA(), async () => {
			const tenant = await insertTenant(api, a.id);
			const { unit } = await propertyWithUnit(api, a.id, ownerA);
			const lease = await insertLease(api, a.id, unit, tenant);
			const account = await insertDepositAccount(api, a.id, lease);
			const e = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'received', 1000, current_date)`,
				[newId(), a.id, account]
			);
			expect(e.message).toContain('DEPOSIT_RECEIPT_VIA_PAYMENT');
		});
	});

	it('import en cours, compte créé par cet import : accepté une fois, daté du versement, sans reçu', async () => {
		await inContext(api, ctxA(), async () => {
			const job = await runningInA();
			await inImport(api, job);
			const tenant = await insertTenant(api, a.id);
			const { unit } = await propertyWithUnit(api, a.id, ownerA);
			const lease = await insertImportedLease(api, a.id, unit, tenant);
			const account = await insertDepositAccount(api, a.id, lease, { agreed: 150_000 });
			const receiptsBefore = (await api.query(`select count(*)::int as n from receipts`)).rows[0].n;
			const movement = await insertImportedReceived(api, a.id, account, 100_000, '2021-03-05');
			const row = (await api.query(`select occurred_on::text, payment_id, import_job_id from deposit_movements where id = $1`, [movement]))
				.rows[0];
			expect(row).toEqual({ occurred_on: '2021-03-05', payment_id: null, import_job_id: job });
			expect((await api.query(`select status from deposit_accounts where id = $1`, [account])).rows[0].status).toBe('partially_received');
			expect((await api.query(`select count(*)::int as n from receipts`)).rows[0].n).toBe(receiptsBefore);
			const second = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'received', 1000, current_date)`,
				[newId(), a.id, account]
			);
			expect(second.message).toContain('DEPOSIT_IMPORT_FIRST');
		});
	});

	it('import en cours, compte qui n’est pas de cet import : refusé', async () => {
		await inContext(api, ctxA(), async () => {
			const tenant = await insertTenant(api, a.id);
			const { unit } = await propertyWithUnit(api, a.id, ownerA);
			const lease = await insertLease(api, a.id, unit, tenant);
			const account = await insertDepositAccount(api, a.id, lease);
			const job = await runningInA();
			await inImport(api, job);
			const e = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'received', 1000, current_date)`,
				[newId(), a.id, account]
			);
			expect(e.message).toContain('DEPOSIT_IMPORT_ACCOUNT');
		});
	});
});

describe('échéance « Solde antérieur » (prompt §3, réponse 2)', () => {
	it('hors import : refusée', async () => {
		await inContext(api, ctxA(), async () => {
			const tenant = await insertTenant(api, a.id);
			const { unit } = await propertyWithUnit(api, a.id, ownerA);
			const lease = await insertLease(api, a.id, unit, tenant, { startsOn: '2021-03-01' });
			const e = await sqlError(
				api,
				`insert into rent_dues (id, organization_id, lease_id, kind, period_start, period_end, due_on, rent, charges, amount_due, status, lease_version)
				 values ($1, $2, $3, 'opening_balance', '2021-03-01', '2021-03-31', '2021-04-01', 1000, 0, 1000, 'overdue', 1)`,
				[newId(), a.id, lease]
			);
			expect(e.message).toContain('RENT_DUE_OPENING_IMPORT');
		});
	});

	it('bail de l’import : du début du bail à la veille de la bascule, exigible à la bascule, une seule par bail', async () => {
		await inContext(api, ctxA(), async () => {
			const job = await runningInA();
			await inImport(api, job);
			const tenant = await insertTenant(api, a.id);
			const { unit } = await propertyWithUnit(api, a.id, ownerA);
			const lease = await insertImportedLease(api, a.id, unit, tenant);
			const due = await insertOpeningBalance(api, a.id, lease);
			const row = (await api.query(`select kind, due_on::text, period_end::text, import_job_id from rent_dues where id = $1`, [due]))
				.rows[0];
			expect(row.kind).toBe('opening_balance');
			expect(row.due_on).toBe(firstOfMonth());
			expect(row.import_job_id).toBe(job);
			const twice = await sqlError(
				api,
				`insert into rent_dues (id, organization_id, lease_id, kind, period_start, period_end, due_on, rent, charges, amount_due, status, lease_version)
				 values ($1, $2, $3, 'opening_balance', '2021-04-01', $4::date - 1, $4, 1000, 0, 1000, 'overdue', 1)`,
				[newId(), a.id, lease, firstOfMonth()]
			);
			expect(twice.code).toBe('23505');
			const kind = await sqlError(api, `update rent_dues set kind = 'rent' where id = $1`, [due]);
			expect(kind.message).toContain('RENT_DUE_IMMUTABLE');
		});
	});

	it('dates : exigible à la date de bascule de l’import, jamais au-delà du début de la facturation', async () => {
		await inContext(api, ctxA(), async () => {
			const job = await runningInA();
			await inImport(api, job);
			const tenant = await insertTenant(api, a.id);
			const { unit } = await propertyWithUnit(api, a.id, ownerA);
			const lease = await insertImportedLease(api, a.id, unit, tenant);
			const wrong = await sqlError(
				api,
				`insert into rent_dues (id, organization_id, lease_id, kind, period_start, period_end, due_on, rent, charges, amount_due, status, lease_version)
				 values ($1, $2, $3, 'opening_balance', '2021-03-01', '2021-03-31', '2021-04-01', 1000, 0, 1000, 'overdue', 1)`,
				[newId(), a.id, lease]
			);
			expect(wrong.message).toContain('RENT_DUE_OPENING_DATES');
		});
	});

	it('bail qui n’est pas de cet import : refusée', async () => {
		await inContext(api, ctxA(), async () => {
			const tenant = await insertTenant(api, a.id);
			const { unit } = await propertyWithUnit(api, a.id, ownerA);
			const lease = await insertLease(api, a.id, unit, tenant, { startsOn: '2021-03-01' });
			const job = await runningInA();
			await inImport(api, job);
			const e = await sqlError(
				api,
				`insert into rent_dues (id, organization_id, lease_id, kind, period_start, period_end, due_on, rent, charges, amount_due, status, lease_version)
				 values ($1, $2, $3, 'opening_balance', '2021-03-01', $4::date - 1, $4, 1000, 0, 1000, 'overdue', 1)`,
				[newId(), a.id, lease, firstOfMonth()]
			);
			expect(e.message).toContain('RENT_DUE_OPENING_IMPORT');
		});
	});
});

describe('date de fin d’origine d’un bail échu (réponse 3)', () => {
	it('seulement à l’import, puis figée', async () => {
		await inContext(api, ctxA(), async () => {
			const tenant = await insertTenant(api, a.id);
			const { unit } = await propertyWithUnit(api, a.id, ownerA);
			const outside = await sqlError(
				api,
				`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, dues_start_on, rent, charges, rent_effective_from, billing_mode,
					lessor_type, status, activated_on, activated_at, original_ends_on)
				 values ($1, $2, $3, $4, '2021-03-01', '2021-03-01', 75000, 0, '2021-03-01', 'calendar_prorata', 'owner', 'active', current_date, now(), '2024-02-28')`,
				[newId(), a.id, unit, tenant]
			);
			expect(outside.message).toContain('LEASE_ORIGINAL_END_IMPORT');
			const job = await runningInA();
			await inImport(api, job);
			const lease = await insertImportedLease(api, a.id, unit, tenant, { originalEndsOn: '2024-02-28' });
			const changed = await sqlError(api, `update leases set original_ends_on = '2024-03-31' where id = $1`, [lease]);
			expect(changed.message).toContain('LEASE_ORIGINAL_END_IMMUTABLE');
		});
	});
});

describe('annulation d’un import dans les 24 heures, sans encaissement (prompt §4, réponse 7)', () => {
	/** Un import terminé dans A avec un bail en vigueur et sa caution versée (D33). */
	async function completedImport(completedAt = 'now()') {
		const job = await runningInA();
		await inImport(api, job);
		const tenant = await insertTenant(api, a.id);
		const { unit } = await propertyWithUnit(api, a.id, ownerA);
		const lease = await insertImportedLease(api, a.id, unit, tenant);
		const account = await insertDepositAccount(api, a.id, lease, { agreed: 150_000 });
		await insertImportedReceived(api, a.id, account, 150_000);
		await inImport(api, null);
		await completeImportJob(api, a.id, job, completedAt);
		return { job, lease, account };
	}

	it('le bail importé en vigueur s’annule avec son import ; la caution, par contre-écriture sans encaissement', async () => {
		await inContext(api, ctxA(), async () => {
			const { job, lease, account } = await completedImport();
			await cancelImportJob(api, a.id, job, managerA.userId);
			await api.query(`update leases set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Import annulé' where id = $1`, [
				lease
			]);
			await api.query(
				`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'received_cancelled', 150000, current_date)`,
				[newId(), a.id, account]
			);
			expect((await api.query(`select status from leases where id = $1`, [lease])).rows[0].status).toBe('cancelled');
		});
	});

	it('hors de l’annulation de son import, un bail en vigueur ne s’annule pas ; un bail non importé non plus', async () => {
		await inContext(api, ctxA(), async () => {
			const { lease } = await completedImport();
			const e = await sqlError(
				api,
				`update leases set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Erreur' where id = $1`,
				[lease]
			);
			expect(e.message).toContain('LEASE_STATUS');
			const tenant = await insertTenant(api, a.id);
			const { unit } = await propertyWithUnit(api, a.id, ownerA);
			const plain = await insertLease(api, a.id, unit, tenant);
			const p = await sqlError(
				api,
				`update leases set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Erreur' where id = $1`,
				[plain]
			);
			expect(p.message).toContain('LEASE_STATUS');
		});
	});

	it('hors de l’annulation, un versement d’import ne s’annule pas sans encaissement', async () => {
		await inContext(api, ctxA(), async () => {
			const { account } = await completedImport();
			const e = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'received_cancelled', 150000, current_date)`,
				[newId(), a.id, account]
			);
			expect(e.message).toContain('DEPOSIT_IMPORT_CANCELLATION');
		});
	});

	it('refusée après 24 heures', async () => {
		await inContext(api, ctxA(), async () => {
			const { job } = await completedImport(`now() - interval '25 hours'`);
			const e = await sqlError(
				api,
				`update import_jobs set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Trop tard' where id = $1`,
				[job, managerA.userId]
			);
			expect(e.message).toContain('IMPORT_CANCEL_EXPIRED');
		});
	});

	it('refusée après un encaissement sur un bail de l’import', async () => {
		await inContext(api, ctxA(), async () => {
			const { job, lease } = await completedImport();
			await insertPayment(api, a.id, lease, { confirmedBy: a.director.userId });
			const e = await sqlError(
				api,
				`update import_jobs set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Après un loyer' where id = $1`,
				[job, managerA.userId]
			);
			expect(e.message).toContain('IMPORT_CANCEL_PAYMENTS');
		});
	});

	it('par la direction ou la gestion seulement', async () => {
		await inContext(api, ctxA(), async () => {
			const { job } = await completedImport();
			const e = await sqlError(
				api,
				`update import_jobs set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Lecteur' where id = $1`,
				[job, viewerA.userId]
			);
			expect(e.message).toContain('IMPORT_RUNNER');
		});
	});
});
