/**
 * Lot 08 bis : la migration 0014 s'applique sur une base du lot 08 déjà remplie (CLAUDE.md §7), et reprend les baux
 * qui ont déjà un bail signé scanné (point 5 du porteur, D21). Base jetable migrée jusqu'à 0013, avec une agence,
 * trois baux en vigueur et leurs documents :
 * - bail 1 : un bail signé scanné actif, remplacé par une seconde version (la version active est reprise) ;
 * - bail 2 : un scan retiré (aucun contrat) ;
 * - bail 3 : aucun scan (aucun contrat).
 * Après migration : un seul contrat, `uploaded_scan`, signé, « signature manuscrite, scan déposé » par la personne qui
 * l'a déposé, à la date du dépôt ; une ligne d'audit d'origine `migration` ; statut des baux inchangé ; nouvelles
 * tables publiées ; migrations rejouées sans doublon.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@ziga/shared/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';

const SCRATCH = 'ziga_lot08_for_0014_test';
const NEW_TABLES = ['contract_templates', 'contract_versions', 'lease_amendments', 'lease_contracts'];

function urlFor(base: string, database: string): string {
	const u = new URL(base);
	u.pathname = `/${database}`;
	return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
	const c = new pg.Client({ connectionString: url });
	await c.connect();
	try {
		return await fn(c);
	} finally {
		await c.end();
	}
}

const server = () => urlFor(process.env.DATABASE_MIGRATION_URL!, 'postgres');
const scratch = () => urlFor(process.env.DATABASE_MIGRATION_URL!, SCRATCH);

function foldersUpTo(lastTag: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'ziga-migrations-'));
	cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
	const journalPath = join(dir, 'meta', '_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
	const keep = journal.entries.findIndex((e) => e.tag === lastTag);
	for (const e of journal.entries.slice(keep + 1)) rmSync(join(dir, `${e.tag}.sql`));
	journal.entries = journal.entries.slice(0, keep + 1);
	writeFileSync(journalPath, JSON.stringify(journal));
	return dir;
}

/** Dans le contexte de l'agence (la RLS s'applique aussi au propriétaire des tables). */
async function inAgency<T>(c: pg.Client, agency: string, fn: () => Promise<T>, commit = true): Promise<T> {
	await c.query('BEGIN');
	await c.query(`select set_config('app.organization_id', $1, true)`, [agency]);
	try {
		const r = await fn();
		await c.query(commit ? 'COMMIT' : 'ROLLBACK');
		return r;
	} catch (error) {
		await c.query('ROLLBACK');
		throw error;
	}
}

describe('migration 0014 sur une base du lot 08', () => {
	const agency = newId();
	const user = newId();
	const uploader = newId();
	const leases = [newId(), newId(), newId()];
	const firstScan = newId();
	const secondScan = newId();
	const withdrawnScan = newId();

	async function scan(c: pg.Client, id: string, lease: string, by: string, replaces: string | null = null): Promise<void> {
		await c.query(
			`insert into documents (id, organization_id, type, lease_id, version, replaces_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
			 values ($1, $2, 'signed_lease_scan', $3, $4, $5, 'bail.pdf', 'application/pdf', 1000, $6, $7)`,
			[id, agency, lease, replaces ? 2 : 1, replaces, `documents/${id}`, by]
		);
		await c.query(`update documents set status = 'active', sha256 = $2, activated_at = $3 where id = $1`, [
			id,
			(replaces ? 'c' : 'b').repeat(64),
			replaces ? '2026-11-14T10:00:00Z' : '2026-11-10T09:00:00Z'
		]);
	}

	beforeAll(async () => {
		await withClient(server(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		const folder = foldersUpTo('0013_leases');
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
		rmSync(folder, { recursive: true, force: true });
		await withClient(scratch(), async (c) => {
			for (const [id, phone, name] of [
				[user, '+22670555091', 'Directrice'],
				[uploader, '+22670555092', 'Gestionnaire']
			] as const) {
				await c.query(`insert into users (id, phone, name, password_hash, status) values ($1, $2, $3, 'x', 'active')`, [id, phone, name]);
			}
			await inAgency(c, agency, async () => {
				await c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, 'agency', 'Agence du lot 08', '+22625300091', 'Ouagadougou', $2)`,
					[agency, user]
				);
			});
			await inAgency(c, agency, async () => {
				const ownerId = newId();
				const property = newId();
				await c.query(
					`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555093')`,
					[ownerId, agency]
				);
				await c.query(
					`insert into properties (id, organization_id, owner_id, type, name) values ($1, $2, $3, 'apartment_building', 'Immeuble')`,
					[property, agency, ownerId]
				);
				for (const [i, lease] of leases.entries()) {
					const unit = newId();
					const tenant = newId();
					await c.query(`insert into units (id, organization_id, property_id, type, label) values ($1, $2, $3, 'apartment', $4)`, [
						unit,
						agency,
						property,
						`Appartement ${i + 1}`
					]);
					await c.query(`insert into tenants (id, organization_id, full_name) values ($1, $2, 'Issa Kaboré')`, [tenant, agency]);
					await c.query(
						`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, ends_on, dues_start_on, rent, charges, rent_effective_from,
							billing_mode, lessor_type, status, activated_on, activated_at)
						 values ($1, $2, $3, $4, '2026-01-01', '2026-12-31', '2026-01-01', 75000, 0, '2026-01-01', 'calendar_prorata', 'owner', 'active',
							'2026-01-01', now())`,
						[lease, agency, unit, tenant]
					);
				}
				await scan(c, firstScan, leases[0]!, user);
				await scan(c, secondScan, leases[0]!, uploader, firstScan);
				await scan(c, withdrawnScan, leases[1]!, user);
				await c.query(
					`update documents set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = $2, withdrawal_reason = 'Mauvais fichier' where id = $1`,
					[withdrawnScan, user]
				);
			});
		});
	});
	afterAll(async () => {
		await withClient(server(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('avant : aucune table de contrats', async () => {
		const r = await withClient(scratch(), (c) => c.query(`select to_regclass('lease_contracts') as t`));
		expect(r.rows[0].t).toBeNull();
	});

	it('après : le bail scanné devient un contrat signé « scan déposé », les autres baux n’en ont pas', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		await withClient(scratch(), async (c) => {
			await inAgency(
				c,
				agency,
				async () => {
					const contracts = await c.query(
						`select lease_id, origin, status, signature_mode, signed_document_id, signature_recorded_by, signature_recorded_at,
							organization_signed_on, tenant_signed_on, template_source, current_version, legalized_on
						 from lease_contracts order by lease_id`
					);
					expect(contracts.rows).toEqual([
						{
							lease_id: leases[0],
							origin: 'uploaded_scan',
							status: 'signed',
							signature_mode: 'handwritten_scan',
							// La version en vigueur du scan, déposée par la gestionnaire, à sa date de dépôt.
							signed_document_id: secondScan,
							signature_recorded_by: uploader,
							signature_recorded_at: new Date('2026-11-14T10:00:00Z'),
							organization_signed_on: null,
							tenant_signed_on: null,
							template_source: null,
							current_version: 0,
							legalized_on: null
						}
					]);
					const audit = await c.query(
						`select action, object_type, actor_type, origin, after->>'leaseId' as lease from audit_log where action = 'contract.import_scan'`
					);
					expect(audit.rows).toEqual([
						{ action: 'contract.import_scan', object_type: 'lease_contract', actor_type: 'system', origin: 'migration', lease: leases[0] }
					]);
					// Le statut des baux ne change pas ; aucune version de contrat n'est inventée.
					const statuses = await c.query(`select distinct status from leases`);
					expect(statuses.rows).toEqual([{ status: 'active' }]);
					expect((await c.query(`select count(*)::int as n from contract_versions`)).rows[0].n).toBe(0);
				},
				false
			);
			const published = await c.query(`select tablename from pg_publication_tables where pubname = 'powersync' and tablename = any($1)`, [
				NEW_TABLES
			]);
			expect(published.rows.map((r) => r.tablename).sort()).toEqual(NEW_TABLES);
		});
	});

	it('après : le contrat repris ne se modifie pas ; un bail du lot 08 se renouvelle par sa version suivante', async () => {
		await withClient(scratch(), async (c) => {
			await inAgency(
				c,
				agency,
				async () => {
					await c.query('SAVEPOINT s');
					await expect(c.query(`update lease_contracts set signed_document_id = $1`, [firstScan])).rejects.toThrow(/CONTRACT_SIGNED/);
					await c.query('ROLLBACK TO SAVEPOINT s');
					await c.query(
						`update leases set ends_on = '2027-12-31', last_renewed_on = '2027-01-01', last_renewal_automatic = true, version = 2 where id = $1`,
						[leases[2]]
					);
					const v = await c.query(`select ends_on::text from lease_versions where lease_id = $1 and version = 2`, [leases[2]]);
					expect(v.rows).toEqual([{ ends_on: '2027-12-31' }]);
				},
				false
			);
		});
	});

	it('les migrations se rejouent sans erreur ni doublon sur la base ainsi migrée', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		const n = await withClient(scratch(), (c) =>
			inAgency(c, agency, async () => (await c.query(`select count(*)::int as n from lease_contracts`)).rows[0].n as number, false)
		);
		expect(n).toBe(1);
	});
});
