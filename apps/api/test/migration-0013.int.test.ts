/**
 * Lot 08 : la migration 0013 s'applique sur une base du lot 07 déjà remplie (CLAUDE.md §7). Base jetable migrée
 * jusqu'à 0012, avec une agence, un bailleur, un bien, une unité et un document, puis migrée jusqu'au bout. Les
 * organisations reçoivent le découpage par défaut ; le document reste valide ; les nouvelles tables sont vides et
 * publiées ; les migrations se rejouent sans erreur.
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

const SCRATCH = 'ziga_lot07_for_0013_test';
const NEW_TABLES = ['deposit_accounts', 'deposit_movements', 'lease_versions', 'leases', 'rent_dues', 'tenants'];

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

describe('migration 0013 sur une base du lot 07', () => {
	const agency = newId();
	const landlord = newId();
	const user = newId();
	const ownerId = newId();
	const property = newId();
	const unit = newId();
	const documentId = newId();

	beforeAll(async () => {
		await withClient(server(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		const folder = foldersUpTo('0012_tabtenga_ouagadougou');
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
		rmSync(folder, { recursive: true, force: true });
		await withClient(scratch(), async (c) => {
			await c.query(`insert into users (id, phone, name, password_hash, status) values ($1, '+22670555081', 'Directrice', 'x', 'active')`, [
				user
			]);
			for (const [id, type, name] of [
				[agency, 'agency', 'Agence du lot 07'],
				[landlord, 'landlord', 'Bailleur du lot 07']
			] as const) {
				await c.query('BEGIN');
				await c.query(`select set_config('app.organization_id', $1, true)`, [id]);
				await c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, $2, $3, '+22625300081', 'Ouagadougou', $4)`,
					[id, type, name, user]
				);
				await c.query('COMMIT');
			}
			await c.query('BEGIN');
			await c.query(`select set_config('app.organization_id', $1, true)`, [agency]);
			await c.query(
				`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555082')`,
				[ownerId, agency]
			);
			await c.query(`insert into properties (id, organization_id, owner_id, type, name) values ($1, $2, $3, 'house', 'Villa')`, [
				property,
				agency,
				ownerId
			]);
			await c.query(`insert into units (id, organization_id, property_id, type, label) values ($1, $2, $3, 'villa', 'Villa')`, [
				unit,
				agency,
				property
			]);
			await c.query(
				`insert into documents (id, organization_id, type, property_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
				 values ($1, $2, 'title_deed', $3, 'titre.pdf', 'application/pdf', 1000, $4, $5)`,
				[documentId, agency, property, `documents/${documentId}`, user]
			);
			await c.query(`update documents set status = 'active', sha256 = $2, activated_at = now() where id = $1`, [
				documentId,
				'b'.repeat(64)
			]);
			await c.query('COMMIT');
		});
	});
	afterAll(async () => {
		await withClient(server(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('avant : aucune table de baux', async () => {
		const r = await withClient(scratch(), (c) => c.query(`select to_regclass('leases') as t`));
		expect(r.rows[0].t).toBeNull();
	});

	it('après : découpage par défaut pour chaque organisation, document intact, tables vides et publiées', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		await withClient(scratch(), async (c) => {
			const orgs = await c.query(`select id, rent_billing_mode from organizations order by legal_name`);
			expect(orgs.rows).toEqual([
				{ id: agency, rent_billing_mode: 'calendar_prorata' },
				{ id: landlord, rent_billing_mode: 'calendar_prorata' }
			]);
			await c.query('BEGIN');
			await c.query(`select set_config('app.organization_id', $1, true)`, [agency]);
			const doc = await c.query(`select status, type, tenant_id, lease_id from documents where id = $1`, [documentId]);
			expect(doc.rows).toEqual([{ status: 'active', type: 'title_deed', tenant_id: null, lease_id: null }]);
			// Le trigger de version, remplacé, s'applique toujours à un document du lot 07.
			await c.query('SAVEPOINT s');
			await expect(c.query(`update documents set file_name = 'autre.pdf' where id = $1`, [documentId])).rejects.toThrow(
				/DOCUMENT_IMMUTABLE/
			);
			await c.query('ROLLBACK TO SAVEPOINT s');
			await c.query('ROLLBACK');
			for (const table of NEW_TABLES) {
				const r = await c.query(`select count(*)::int as n from ${table}`);
				expect(r.rows[0].n, table).toBe(0);
			}
			const published = await c.query(`select tablename from pg_publication_tables where pubname = 'powersync' and tablename = any($1)`, [
				NEW_TABLES
			]);
			expect(published.rows.map((r) => r.tablename).sort()).toEqual(NEW_TABLES);
		});
	});

	it('après : l’unité du lot 07 reçoit un bail', async () => {
		await withClient(scratch(), async (c) => {
			await c.query('BEGIN');
			await c.query(`select set_config('app.organization_id', $1, true)`, [agency]);
			const tenant = newId();
			await c.query(`insert into tenants (id, organization_id, full_name) values ($1, $2, 'Issa Kaboré')`, [tenant, agency]);
			await c.query(
				`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, dues_start_on, rent, rent_effective_from, billing_mode, lessor_type)
				 select $1, $2, $3, $4, '2026-12-01', '2026-12-01', 75000, '2026-12-01', rent_billing_mode, 'owner' from organizations where id = $2`,
				[newId(), agency, unit, tenant]
			);
			const r = await c.query(`select billing_mode, status, version from leases where unit_id = $1`, [unit]);
			expect(r.rows).toEqual([{ billing_mode: 'calendar_prorata', status: 'draft', version: 1 }]);
			await c.query('ROLLBACK');
		});
	});

	it('les migrations se rejouent sans erreur sur la base ainsi migrée', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		const r = await withClient(scratch(), (c) => c.query(`select count(*)::int as n from organizations`));
		expect(r.rows[0].n).toBe(2);
	});
});
