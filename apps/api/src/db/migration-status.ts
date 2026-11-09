/**
 * Vérification au démarrage de l'API et du worker : la base a-t-elle reçu toutes les migrations du dépôt ?
 * Sans elle, une base en retard (`pnpm db:migrate` oublié après une mise à jour) répond par une erreur SQL obscure à
 * la première requête (« column … does not exist »). La règle est celle du migrateur de Drizzle : une migration est
 * appliquée si sa date (`when` du journal) n'est pas postérieure à la dernière date enregistrée en base.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { MIGRATIONS_FOLDER } from './migrate.js';

export interface JournalEntry {
	tag: string;
	when: number;
}

export type MigrationStatus =
	| { state: 'up_to_date' }
	/** Aucune migration : base neuve, ou schéma `drizzle` absent. */
	| { state: 'empty' }
	/** Migrations du dépôt pas encore appliquées (au moins la première de la liste quand `atLeast` est vrai). */
	| { state: 'pending'; tags: string[]; atLeast: boolean }
	/** La base a reçu des migrations que ce code ne connaît pas (branche plus ancienne) : on démarre, avec un avertissement. */
	| { state: 'ahead' };

export function readJournal(folder = MIGRATIONS_FOLDER): JournalEntry[] {
	const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
	return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

type Query = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

export async function migrationStatus(query: Query, journal: JournalEntry[]): Promise<MigrationStatus> {
	let last: number | null;
	try {
		const { rows } = await query('select max(created_at)::text as last from drizzle.__drizzle_migrations');
		last = rows[0]?.last == null ? null : Number(rows[0].last);
	} catch (error) {
		const code = (error as { code?: string }).code;
		// 3F000 : schéma absent ; 42P01 : table absente. La base n'a jamais été migrée.
		if (code === '3F000' || code === '42P01') return { state: 'empty' };
		// 42501 : le droit de lecture vient de 0005_migration_status, donc cette migration au moins manque.
		if (code === '42501') {
			const from = journal.findIndex((e) => e.tag === '0005_migration_status');
			return { state: 'pending', tags: journal.slice(Math.max(from, 0)).map((e) => e.tag), atLeast: true };
		}
		throw error;
	}
	if (last === null) return { state: 'empty' };
	const pending = journal.filter((e) => e.when > last).map((e) => e.tag);
	if (pending.length) return { state: 'pending', tags: pending, atLeast: false };
	const newest = Math.max(...journal.map((e) => e.when));
	return last > newest ? { state: 'ahead' } : { state: 'up_to_date' };
}

/** Message pour la personne qui lance l'application, ou null si l'on peut démarrer. */
export function migrationProblem(status: MigrationStatus): string | null {
	switch (status.state) {
		case 'up_to_date':
		case 'ahead':
			return null;
		case 'empty':
			return 'La base de données n’a reçu aucune migration. Lancez « pnpm db:migrate » à la racine du dépôt, puis relancez.';
		case 'pending': {
			const n = status.tags.length;
			const count = `${status.atLeast ? 'au moins ' : ''}${n} migration${n > 1 ? 's' : ''}`;
			return `La base de données est en retard : ${count} à appliquer (${status.tags.join(', ')}). Lancez « pnpm db:migrate » à la racine du dépôt, puis relancez.`;
		}
	}
}

/** Au démarrage : arrêt avec un message clair si la base est en retard ; avertissement si elle est en avance. */
export async function assertMigrationsOrExit(
	url: string,
	log: { warn: (message: string) => void } = { warn: (m) => process.stderr.write(`${m}\n`) },
	exit: (code: number) => never = process.exit
): Promise<void> {
	const client = new pg.Client({ connectionString: url, application_name: 'ziga-migration-check' });
	let status: MigrationStatus;
	try {
		await client.connect();
		status = await migrationStatus((sql) => client.query(sql), readJournal());
	} finally {
		await client.end().catch(() => undefined);
	}
	if (status.state === 'ahead') log.warn('La base a reçu des migrations plus récentes que ce code (branche plus ancienne ?).');
	const problem = migrationProblem(status);
	if (problem) {
		process.stderr.write(`${problem}\n`);
		exit(1);
	}
}
