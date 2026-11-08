/**
 * Applique les migrations SQL versionnées (drizzle-kit) avec le rôle propriétaire du schéma,
 * puis fixe les mots de passe des rôles applicatifs à partir de leurs URL de connexion.
 * Une migration déjà appliquée n'est jamais modifiée : on en ajoute une nouvelle (CLAUDE.md §6).
 */
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const MIGRATIONS_FOLDER = join(import.meta.dirname, 'migrations');

export interface MigrateOptions {
	/** Rôle propriétaire du schéma (pas `app_api`) : il crée les tables, les rôles et les politiques. */
	migrationUrl: string;
	/** URL de `app_api` et de `app_admin` : leur mot de passe y est lu, jamais écrit dans le code. */
	roleUrls: string[];
}

function roleFromUrl(url: string): { user: string; password: string } {
	const u = new URL(url);
	return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

export async function runMigrations(options: MigrateOptions): Promise<void> {
	const client = new pg.Client({ connectionString: options.migrationUrl, application_name: 'ziga-migrate' });
	await client.connect();
	try {
		await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
		for (const url of options.roleUrls) {
			const { user, password } = roleFromUrl(url);
			if (!['app_api', 'app_admin'].includes(user)) throw new Error(`Rôle inattendu dans l'URL : ${user}`);
			if (!password) throw new Error(`Mot de passe manquant pour ${user}`);
			// ALTER ROLE n'accepte pas de paramètre : on échappe la valeur comme un littéral SQL.
			await client.query(`ALTER ROLE ${client.escapeIdentifier(user)} PASSWORD ${client.escapeLiteral(password)}`);
		}
	} finally {
		await client.end();
	}
}
