/**
 * `pnpm db:seed` : données de démonstration (CLAUDE.md §10), jamais en production.
 * Mot de passe des comptes de démonstration : SEED_DEMO_PASSWORD (8 caractères au moins), jamais écrit dans le code.
 */
import { passwordSchema } from '@ziga/shared/auth';
import { ROLE_LABELS } from '@ziga/shared/organizations';
import { PLATFORM_ROLE_LABELS } from '@ziga/shared/permissions';
import { formatPhone } from '@ziga/shared/phone';
import { parseConfig } from '../config/env.js';
import { createDatabase, createPool } from './database.js';
import { DEMO_OWNER, DEMO_TENANT, seedDemoRecords } from './seed-records.js';
import { DEMO_ORGANIZATIONS, DEMO_PEOPLE, seedDemo } from './seed.js';

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

if (process.env.NODE_ENV === 'production') fail('Refusé : pas de données de démonstration en production.');
const url = process.env.DATABASE_URL;
if (!url) fail('DATABASE_URL manquante (copiez .env.example en .env).');
const password = passwordSchema.safeParse(process.env.SEED_DEMO_PASSWORD ?? '');
if (!password.success) {
	fail(
		'SEED_DEMO_PASSWORD manquant ou trop court (8 caractères au moins).\n' +
			'Ajoutez à la fin du fichier .env, à la racine du dépôt, une ligne comme :\n' +
			'  SEED_DEMO_PASSWORD=demo-ziga-2026\n' +
			'(ce sera le mot de passe de tous les comptes de démonstration), puis relancez pnpm db:seed.'
	);
}

const pool = createPool({ url, max: 2, connectionTimeoutMs: 5_000, applicationName: 'ziga-seed' });
// Formules et abonnements : connexion du back-office (app_admin), seule autorisée à les écrire.
const adminUrl = process.env.DATABASE_ADMIN_URL;
const adminPool = adminUrl ? createPool({ url: adminUrl, max: 1, connectionTimeoutMs: 5_000, applicationName: 'ziga-seed' }) : null;
try {
	const result = await seedDemo(createDatabase(pool), password.data, adminPool ? createDatabase(adminPool) : undefined);
	if (!adminPool) process.stdout.write('DATABASE_ADMIN_URL absente : formules et abonnements de démonstration non créés.\n');
	process.stdout.write(`Démonstration : ${result.people} personne(s) et ${result.organizations} organisation(s) créées.\n`);
	// Fiches, baux, encaissements, relevé, décompte et liens : par l'API elle-même (seed-records.ts), formule Pro de A comprise.
	if (adminPool) {
		const records = await seedDemoRecords(parseConfig(process.env), password.data);
		process.stdout.write(
			records.created.length
				? `Démonstration : ${records.created.length} élément(s) créé(s) (${records.created.join(' ; ')}).\n`
				: 'Démonstration : fiches, baux et liens déjà en place.\n'
		);
	}
	process.stdout.write('Comptes (mot de passe : SEED_DEMO_PASSWORD) :\n');
	for (const p of DEMO_PEOPLE) {
		const roles = DEMO_ORGANIZATIONS.flatMap((o) =>
			o.members
				.filter((m) => m.person === p.key)
				.map((m) =>
					o.type === 'landlord'
						? 'bailleur particulier (ses logements)'
						: `${ROLE_LABELS[m.role].toLowerCase()} chez ${o.tradeName ?? o.legalName}`
				)
		);
		if (p.platformRole) roles.push(`équipe de la plateforme (${PLATFORM_ROLE_LABELS[p.platformRole].toLowerCase()})`);
		if (adminPool && p.key === DEMO_OWNER) roles.push('espace propriétaire : un bien chez chacune des agences et un chez elle');
		if (adminPool && p.key === DEMO_TENANT)
			roles.push('espace locataire : bail terminé chez Faso Immobilier, bail en cours chez Sahel Habitat');
		process.stdout.write(`  ${formatPhone(p.phone)}  ${p.name}${roles.length ? ` — ${roles.join(', ')}` : ' — sans organisation'}\n`);
	}
} finally {
	await pool.end();
	await adminPool?.end();
}
