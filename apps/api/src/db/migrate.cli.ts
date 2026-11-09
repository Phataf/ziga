/** `pnpm db:migrate` : applique les migrations sur la base décrite par l'environnement. */
import { runMigrations } from './migrate.js';

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		process.stderr.write(`Variable obligatoire manquante : ${name}\n`);
		process.exit(1);
	}
	return value;
}

await runMigrations({
	migrationUrl: required('DATABASE_MIGRATION_URL'),
	roleUrls: [required('DATABASE_URL'), required('DATABASE_ADMIN_URL'), required('DATABASE_SYNC_URL')]
});
process.stdout.write('Migrations appliquées.\n');
