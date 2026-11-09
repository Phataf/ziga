import { describe, expect, it } from 'vitest';
import { ORGANIZATION_SCOPED_TABLES } from '@ziga/shared/sync-schema';
import { LOCAL_QUERIES } from './queries';

describe('lectures locales : jamais deux organisations à la fois (lot 05)', () => {
	it('chaque requête qui lit une table d’organisation filtre sur l’organisation passée en paramètre', () => {
		for (const [name, sql] of Object.entries(LOCAL_QUERIES)) {
			const tables = ORGANIZATION_SCOPED_TABLES.filter((t) => new RegExp(`\\bFROM\\s+${t}\\b`, 'i').test(sql));
			for (const table of tables) expect(sql, `${name} : ${table}`).toMatch(/organization_id\s*=\s*\?/);
		}
	});

	it('la fiche de l’organisation est lue par son identifiant', () => {
		expect(LOCAL_QUERIES.organization).toMatch(/WHERE o\.id = \?/);
	});
});
