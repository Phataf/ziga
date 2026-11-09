import { describe, expect, it } from 'vitest';
import { migrationProblem, migrationStatus, readJournal, type JournalEntry } from './migration-status.js';

const journal: JournalEntry[] = [
	{ tag: '0004_features_plans_admin', when: 400 },
	{ tag: '0005_migration_status', when: 500 },
	{ tag: '0006_suite', when: 600 }
];
const returning = (last: string | null) => async () => ({ rows: [{ last }] });
const failing = (code: string) => async () => {
	throw Object.assign(new Error(code), { code });
};

describe('état des migrations au démarrage', () => {
	it('base à jour : on démarre', async () => {
		const status = await migrationStatus(returning('600'), journal);
		expect(status).toEqual({ state: 'up_to_date' });
		expect(migrationProblem(status)).toBeNull();
	});

	it('migrations en retard : la liste et la commande à lancer', async () => {
		const status = await migrationStatus(returning('400'), journal);
		expect(status).toEqual({ state: 'pending', tags: ['0005_migration_status', '0006_suite'], atLeast: false });
		expect(migrationProblem(status)).toBe(
			'La base de données est en retard : 2 migrations à appliquer (0005_migration_status, 0006_suite). Lancez « pnpm db:migrate » à la racine du dépôt, puis relancez.'
		);
	});

	it('sans le droit de lecture (0005 non appliquée) : au moins 0005 et les suivantes', async () => {
		const status = await migrationStatus(failing('42501'), journal);
		expect(status).toEqual({ state: 'pending', tags: ['0005_migration_status', '0006_suite'], atLeast: true });
		expect(migrationProblem(status)).toContain('au moins 2 migrations à appliquer');
	});

	it('base jamais migrée (schéma ou table absents, ou table vide)', async () => {
		for (const query of [failing('3F000'), failing('42P01'), returning(null)]) {
			const status = await migrationStatus(query, journal);
			expect(status).toEqual({ state: 'empty' });
			expect(migrationProblem(status)).toContain('aucune migration');
		}
	});

	it('base en avance sur le code : on démarre (avertissement seulement)', async () => {
		const status = await migrationStatus(returning('700'), journal);
		expect(status).toEqual({ state: 'ahead' });
		expect(migrationProblem(status)).toBeNull();
	});

	it('une autre erreur (base injoignable) remonte telle quelle', async () => {
		await expect(migrationStatus(failing('ECONNREFUSED'), journal)).rejects.toThrow('ECONNREFUSED');
	});

	it('le journal du dépôt est lu dans l’ordre, avec sa dernière migration', () => {
		const tags = readJournal().map((e) => e.tag);
		expect(tags[0]).toBe('0000_socle');
		expect(tags).toContain('0005_migration_status');
	});
});
