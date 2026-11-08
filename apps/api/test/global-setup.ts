/** Recrée la base de test, vide, puis applique toutes les migrations : les tests partent toujours de zéro. */
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { integrationEnv } from './env.js';

export default async function setup(): Promise<void> {
	const env = integrationEnv();
	const name = env.TEST_DATABASE_NAME!;
	if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`Nom de base de test refusé (doit finir par _test) : ${name}`);
	const server = new URL(env.DATABASE_MIGRATION_URL!);
	server.pathname = '/postgres';
	const client = new pg.Client({ connectionString: server.toString() });
	await client.connect();
	try {
		await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`);
		await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
	} finally {
		await client.end();
	}
	await runMigrations({ migrationUrl: env.DATABASE_MIGRATION_URL!, roleUrls: [env.DATABASE_URL!, env.DATABASE_ADMIN_URL!] });
}
