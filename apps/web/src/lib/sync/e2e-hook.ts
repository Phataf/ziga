/**
 * Accès des tests de bout en bout seulement (lot 05) : nombre de lignes par table de la base locale, jamais leur
 * contenu, pour vérifier qu'elle se vide (déconnexion, membre retiré).
 *
 * Ce module n'est chargé que si la version a été construite avec PUBLIC_E2E=1 (constante `__ZIGA_E2E__`, fixée au
 * build par vite.config.ts) : sinon, l'assembleur l'élimine, et il ne figure pas dans la version de production
 * (vérifié par e2e-hook.build.test.ts).
 */
import type { PowerSyncDatabase } from '@powersync/web';
import { SYNCED_TABLES } from '@ziga/shared/sync-schema';

export const E2E_HOOK_NAME = '__zigaLocalCounts';

export function installE2EHook(current: () => PowerSyncDatabase | null, dbFilename: string): void {
	(window as unknown as Record<string, unknown>)[E2E_HOOK_NAME] = async (): Promise<Record<string, number>> => {
		let db = current();
		const opened = !db;
		if (!db) {
			const [{ PowerSyncDatabase }, { AppSchema }] = await Promise.all([import('@powersync/web'), import('./schema')]);
			db = new PowerSyncDatabase({ schema: AppSchema, database: { dbFilename } });
		}
		const counts: Record<string, number> = {};
		for (const table of [...Object.keys(SYNCED_TABLES), 'ps_crud']) {
			counts[table] = Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)).n);
		}
		if (opened) await db.close();
		return counts;
	};
}
