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
import { SYNCED_TABLES } from '@ziga/shared/sync-schema';
import { describe, expect, it } from 'vitest';

const CONFIG = resolve(import.meta.dirname, '../../../infra/powersync/sync-config.yaml');
const SCRIPT = resolve(import.meta.dirname, '../scripts/check-sync-config.mjs');

function check(file = CONFIG): {
	problems: { type: string; message: string }[];
	sourceTables: string[];
	clientTables: Record<string, Record<string, string>>;
} {
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

	it('le schéma local du client (packages/shared/sync-schema) est exactement celui que PowerSync déduit des streams', () => {
		expect(check().clientTables).toEqual(SYNCED_TABLES);
	});

	it('le représentant légal (pièce d’identité) ne descend que chez les directeurs', () => {
		const yaml = readFileSync(CONFIG, 'utf8');
		const stream = yaml.slice(yaml.indexOf('  organization_representatives:'), yaml.indexOf('  my_feature_overrides:'));
		expect(stream).toContain("organization_members.role = 'director'");
		expect(stream).toContain('rep_id_number');
		const others = yaml.replace(stream, '');
		expect(others).not.toMatch(/\brep_/);
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

	/** Texte d'un stream (de son nom au stream suivant), sans les commentaires. */
	function stream(name: string): string {
		const yaml = readFileSync(CONFIG, 'utf8');
		const start = yaml.indexOf(`  ${name}:\n`);
		expect(start, name).toBeGreaterThan(-1);
		const rest = yaml.slice(start + name.length + 4);
		const next = rest.search(/\n {2}[a-z_]+:\n/);
		return (next === -1 ? rest : rest.slice(0, next))
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
	}

	it('lot 07 : l’agent de terrain ne reçoit que les unités qui lui sont affectées, leur bien et leurs photos', () => {
		const agent = stream('assigned_units');
		expect(agent).toContain('units.assigned_agent_id = auth.user_id()');
		expect(agent).toContain("organization_members.role = 'field_agent'");
		expect(agent).toContain('organization_members.user_id = auth.user_id()');
		expect(agent).toMatch(/FROM units WHERE id IN my_units/);
		expect(agent).toMatch(/FROM properties WHERE id IN my_unit_properties/);
		expect(agent).toMatch(/FROM media WHERE unit_id IN my_units/);
		expect(agent).not.toMatch(/organization_id IN/);
		// Lot 10 bis (matrice docs/UX.md §10, « État des lieux ») : seulement les photos, scans et PDF des états des lieux
		// de ses baux (le PDF depuis l'étape 4), jamais un document restreint ; aucun autre type.
		const documents = agent.split('\n').filter((line) => /FROM documents\b/.test(line));
		expect(documents).toHaveLength(3);
		for (const line of documents) {
			expect(line).toMatch(/WHERE lease_id IN my_unit_leases AND type = 'inspection_(photo|scan|report)' AND restriction IS NULL$/);
		}
		// Le stream de la gestion exclut l'agent de terrain ; aucun autre stream ne lit biens, unités ou photos.
		const managed = stream('managed_properties');
		expect(managed).toContain("organization_members.role != 'field_agent'");
		const yaml = readFileSync(CONFIG, 'utf8');
		const others = yaml.replace(stream('assigned_units'), '').replace(managed, '');
		expect(others).not.toMatch(/FROM (properties|units|media|mandate_scopes)\b/);
	});

	it('lot 07 : documents en métadonnées, direction et gestion seulement ; restreint à la direction : directeur seul', () => {
		const docs = stream('organization_documents');
		expect(docs).toContain("organization_members.role = 'director'");
		expect(docs).toContain("organization_members.role = 'manager'");
		expect(docs).not.toMatch(/field_agent|viewer|role !=/);
		expect(docs).toMatch(/FROM documents WHERE organization_id IN managed_organizations AND restriction IS NULL/);
		const yaml = readFileSync(CONFIG, 'utf8');
		// Ailleurs, seulement les états des lieux de l'agent de terrain (lot 10 bis, test précédent).
		expect(yaml.replace(docs, '').replace(stream('assigned_units'), '')).not.toMatch(/FROM documents\b/);
		// Jamais la clé de stockage d'un document ni l'original d'une photo (hors commentaires).
		const queries = yaml
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		expect(queries).not.toMatch(/storage_key/);
	});

	it('lot 08 : état civil et pièce d’identité du locataire chez le directeur et le gestionnaire seulement', () => {
		const identities = stream('tenant_identities');
		expect(identities).toContain("organization_members.role != 'field_agent'");
		expect(identities).toContain("organization_members.role != 'viewer'");
		expect(identities).toMatch(/FROM tenants AS tenant_identities WHERE organization_id IN identity_organizations/);
		// Aucune autre requête ne lit ces colonnes de tenants.
		const yaml = readFileSync(CONFIG, 'utf8');
		const others = yaml.replace(identities, '');
		expect(others).not.toMatch(/\b(birth_date|birth_place|id_number|id_issued_on|id_issued_by|id_type_other)\b/);
		expect(others).not.toMatch(/\bid_type\b/);
	});

	it('lot 08 : l’agent de terrain reçoit les baux et échéances de ses unités, leurs locataires sans notes, aucune caution', () => {
		const agent = stream('assigned_units');
		expect(agent).toMatch(/FROM leases WHERE unit_id IN my_units/);
		expect(agent).toMatch(/FROM lease_versions WHERE lease_id IN my_unit_leases/);
		expect(agent).toMatch(/FROM rent_dues WHERE lease_id IN my_unit_leases/);
		expect(agent).toMatch(/FROM tenants WHERE id IN my_unit_tenants/);
		expect(agent).not.toMatch(/\bdeposit_(accounts|movements)\b/);
		const tenantQuery = agent.split('\n').find((line) => /FROM tenants\b/.test(line))!;
		expect(tenantQuery).not.toMatch(/\b(notes|nationality|profession|previous_address)\b/);
		// Les tables du bail ne descendent que par ces deux streams.
		const yaml = readFileSync(CONFIG, 'utf8');
		const others = yaml.replace(agent, '').replace(stream('managed_properties'), '').replace(stream('tenant_identities'), '');
		expect(others).not.toMatch(/FROM (tenants|leases|lease_versions|rent_dues|deposit_accounts|deposit_movements)\b/);
		// Aucune occupation stockée ni synchronisée, et jamais le compte lié d'un locataire.
		expect(yaml).not.toMatch(/\boccupancy\b/);
		const tenants = yaml.split('\n').filter((line) => /FROM tenants\b/.test(line));
		for (const line of tenants) expect(line).not.toMatch(/\buser_id\b/);
	});

	it('lot 10 bis : l’agent de terrain reçoit ses congés et ses états des lieux, jamais rien de la caution', () => {
		const agent = stream('assigned_units');
		expect(agent).toMatch(/FROM lease_notices WHERE lease_id IN my_unit_leases AND status = 'recorded'/);
		expect(agent).toMatch(/FROM inspections WHERE lease_id IN my_unit_leases/);
		expect(agent).toMatch(/FROM inspection_items WHERE inspection_id IN my_unit_inspections/);
		const notice = agent.split('\n').find((line) => /FROM lease_notices\b/.test(line))!;
		expect(notice).not.toMatch(/\b(early_termination_indemnity|proof_document_id|reason|declined_reason)\b/);
		expect(agent).not.toMatch(/\b(deposit_accounts|deposit_movements|deposit_settlements|deposit_settlement_lines|agreements|repairs)\b/);
		// Imputation sur caution (D32) : ni l'encaissement, ni son imputation, ni son reçu.
		expect(agent).toMatch(/FROM payments WHERE .* AND method != 'deposit_offset'/);
		expect(agent).toMatch(/FROM payment_allocations WHERE .* AND source != 'deposit'/);
		expect(agent).toMatch(/FROM receipts WHERE .* AND source != 'deposit'/);
		// Le décompte, les accords et les réparations ne descendent que dans le stream de la gestion.
		const yaml = readFileSync(CONFIG, 'utf8');
		const others = yaml.replace(stream('managed_properties'), '');
		expect(others).not.toMatch(/FROM (deposit_settlements|deposit_settlement_lines|agreements|repairs|management_transfers)\b/);
		expect(stream('managed_properties')).toContain("organization_members.role != 'field_agent'");
	});
});
