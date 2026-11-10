/**
 * Lot 06 : la migration 0008 s'applique sur une base du lot 05 qui a déjà des organisations (CLAUDE.md §7).
 * Base jetable : migrée jusqu'à 0007 (dossier de migrations tronqué), remplie comme avant le lot 06 (un bailleur, une
 * agence), puis migrée jusqu'au bout. Le bailleur reçoit sa fiche et son mandat self_managed ; l'agence, rien.
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

const SCRATCH = 'ziga_lot05_test';

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

/** Copie du dossier de migrations, arrêtée à `lastTag` (journal et fichiers SQL). */
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

async function migrateWith(folder: string): Promise<void> {
	await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
}

describe('migration 0008 sur une base du lot 05', () => {
	const landlord = newId();
	const agency = newId();
	let lot05: string;

	beforeAll(async () => {
		await withClient(server(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		lot05 = foldersUpTo('0007_sync_operations');
		await migrateWith(lot05);
		await withClient(scratch(), async (c) => {
			const user = newId();
			await c.query(
				`insert into users (id, phone, name, password_hash, status) values ($1, '+22670555001', 'Ancien bailleur', 'x', 'active')`,
				[user]
			);
			for (const [id, type, name] of [
				[landlord, 'landlord', 'Rasmané Ouédraogo'],
				[agency, 'agency', 'Ancienne agence']
			] as const) {
				await c.query('BEGIN');
				await c.query(`select set_config('app.organization_id', $1, true)`, [id]);
				await c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, $2, $3, '+22625300001', 'Saaba', $4)`,
					[id, type, name, user]
				);
				await c.query('COMMIT');
			}
		});
	});
	afterAll(async () => {
		rmSync(lot05, { recursive: true, force: true });
		await withClient(server(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('avant : aucune table de propriétaires', async () => {
		const r = await withClient(scratch(), (c) => c.query(`select to_regclass('owners') as t`));
		expect(r.rows[0].t).toBeNull();
	});

	it('après : le bailleur a sa fiche et son mandat self_managed ; l’agence n’a rien ; le journal le dit', async () => {
		await migrateWith(MIGRATIONS_FOLDER);
		await withClient(scratch(), async (c) => {
			const owners = await c.query(`select organization_id, type, name, phone from owners order by name`);
			expect(owners.rows).toEqual([{ organization_id: landlord, type: 'person', name: 'Rasmané Ouédraogo', phone: '+22625300001' }]);
			const mandates = await c.query(`select organization_id, type, status, version, ends_on from mandates`);
			expect(mandates.rows).toEqual([{ organization_id: landlord, type: 'self_managed', status: 'active', version: 1, ends_on: null }]);
			const versions = await c.query(`select count(*)::int as n from mandate_versions where organization_id = $1`, [landlord]);
			expect(versions.rows[0].n).toBe(1);
			const audit = await c.query(`select action, origin from audit_log where organization_id = $1 order by id`, [landlord]);
			expect(audit.rows).toEqual([
				{ action: 'owner.create', origin: 'migration' },
				{ action: 'mandate.create', origin: 'migration' }
			]);
			// Rejouer le backfill ne crée rien de plus.
			expect((await c.query(`select backfill_landlord_self_managed() as n`)).rows[0].n).toBe(0);
		});
	});

	it('les migrations se rejouent sans erreur sur la base ainsi migrée', async () => {
		await migrateWith(MIGRATIONS_FOLDER);
		const r = await withClient(scratch(), (c) => c.query(`select count(*)::int as n from mandates`));
		expect(r.rows[0].n).toBe(1);
	});
});
