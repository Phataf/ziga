/**
 * Sync Streams (infra/powersync/sync-config.yaml), vérifiés par le moteur de PowerSync contre le schéma réel :
 * syntaxe, colonnes et tables existantes ; chaque table lue est dans la publication `powersync` (D30) ; jamais de
 * `SELECT *` ; l'appartenance exige un membre actif d'une organisation non suspendue.
 * Ce que chaque personne reçoit réellement est vérifié contre le service PowerSync par les tests Playwright
 * (lot 05, étape 2).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const CONFIG = resolve(import.meta.dirname, '../../../infra/powersync/sync-config.yaml');
const SCRIPT = resolve(import.meta.dirname, '../scripts/check-sync-config.mjs');

function check(file = CONFIG): { problems: { type: string; message: string }[]; sourceTables: string[] } {
	const out = execFileSync(process.execPath, ['--js-explicit-resource-management', SCRIPT, process.env.DATABASE_MIGRATION_URL!, file], {
		encoding: 'utf8'
	});
	return JSON.parse(out);
}

describe('Sync Streams (lot 05, D30)', () => {
	it('valides pour le moteur de PowerSync, sans erreur ni avertissement, contre le schéma réel', () => {
		expect(check().problems).toEqual([]);
	});

	it('la vérification détecte bien une colonne inexistante (garde-fou du test lui-même)', () => {
		const typo = join(tmpdir(), `ziga-sync-config-${process.pid}.yaml`);
		writeFileSync(typo, readFileSync(CONFIG, 'utf8').replace('display_name', 'display_nom'));
		expect(check(typo).problems).toContainEqual({ type: 'warning', message: 'Column not found.' });
	});

	it('chaque table lue par les streams est dans la publication powersync', async () => {
		const { sourceTables } = check();
		const c = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
		await c.connect();
		try {
			const r = await c.query(`select tablename from pg_publication_tables where pubname = 'powersync'`);
			const published = r.rows.map((row) => row.tablename as string);
			expect(sourceTables.length).toBeGreaterThan(0);
			for (const table of sourceTables) expect(published, table).toContain(table);
		} finally {
			await c.end();
		}
	});

	it('jamais de SELECT * : chaque colonne synchronisée est choisie', () => {
		const queries = readFileSync(CONFIG, 'utf8')
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		expect(queries).toMatch(/select/i);
		expect(queries).not.toMatch(/select\s+(\w+\.)?\*/i);
	});

	it('l’appartenance exige un membre actif d’une organisation non suspendue, pour la personne du jeton', () => {
		const yaml = readFileSync(CONFIG, 'utf8');
		expect(yaml).toContain('organization_members.user_id = auth.user_id()');
		expect(yaml).toContain("organization_members.status = 'active'");
		expect(yaml).toContain("organizations.verification_status != 'suspended'");
	});
});
