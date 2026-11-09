/**
 * Test d'architecture (lot 04, critère d'acceptation) : aucune lecture des tables d'interrupteurs hors du module
 * features ; la connexion app_admin n'est utilisée que par le module admin ; toutes les routes de celui-ci sont sous
 * /admin et protégées par @PlatformCan.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = import.meta.dirname;

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
	});
}

const all = files(src).map((path) => ({ path: relative(src, path).replaceAll('\\', '/'), code: readFileSync(path, 'utf8') }));
const imports = (code: string) => [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

describe('architecture', () => {
	it('seul le module features importe le schéma des tables d’interrupteurs', () => {
		const offenders = all.filter(
			(f) =>
				!f.path.startsWith('modules/features/') &&
				f.path !== 'db/schema/features.ts' &&
				imports(f.code).some((i) => /schema\/features(\.js)?$/.test(i))
		);
		expect(offenders.map((f) => f.path)).toEqual([]);
		// Et le schéma n'est pas réexporté par l'index commun des schémas.
		expect(readFileSync(join(src, 'db/schema/index.ts'), 'utf8')).not.toContain('features');
	});

	it('aucun SQL brut ne lit les tables d’interrupteurs hors du module features', () => {
		const pattern =
			/\b(from|join|update|into)\s+(features|feature_overrides|plan_features|quota_overrides|organization_feature_settings)\b/i;
		const offenders = all.filter((f) => !f.path.startsWith('modules/features/') && pattern.test(f.code));
		expect(offenders.map((f) => f.path)).toEqual([]);
	});

	it('seul le module sync lit et écrit sync_operations (lot 05)', () => {
		const offenders = all.filter(
			(f) =>
				!f.path.startsWith('modules/sync/') &&
				f.path !== 'db/schema/sync.ts' &&
				(imports(f.code).some((i) => /schema\/sync(\.js)?$/.test(i)) || /\b(from|join|update|into)\s+sync_operations\b/i.test(f.code))
		);
		expect(offenders.map((f) => f.path)).toEqual([]);
		expect(readFileSync(join(src, 'db/schema/index.ts'), 'utf8')).not.toContain('sync');
	});

	it('seul le module admin utilise la connexion app_admin', () => {
		const offenders = all.filter((f) => !f.path.startsWith('modules/admin/') && imports(f.code).some((i) => i.includes('admin-database')));
		expect(offenders.map((f) => f.path)).toEqual([]);
		expect(
			all
				.filter(
					(f) =>
						f.code.includes('DATABASE_ADMIN_URL') &&
						!['config/env.ts', 'modules/admin/admin-database.service.ts', 'db/seed.cli.ts', 'db/seed.ts', 'db/migrate.cli.ts'].includes(
							f.path
						)
				)
				.map((f) => f.path)
		).toEqual([]);
	});

	it('les contrôleurs du module admin sont sous /admin et chaque route passe par @PlatformCan', () => {
		const controllers = all.filter((f) => f.path.startsWith('modules/admin/') && f.code.includes('@Controller('));
		expect(controllers.length).toBeGreaterThan(0);
		for (const c of controllers) {
			expect(c.code, c.path).toMatch(/@Controller\('admin(\/[^']*)?'\)/);
			const routes = [...c.code.matchAll(/@(Get|Post|Put|Patch|Delete)\(/g)].length;
			const guarded = [...c.code.matchAll(/@PlatformCan\(/g)].length;
			expect(guarded, c.path).toBe(routes);
		}
	});

	it('aucun contrôleur hors du module admin n’expose de route /admin', () => {
		const offenders = all.filter((f) => !f.path.startsWith('modules/admin/') && /@Controller\('admin/.test(f.code));
		expect(offenders.map((f) => f.path)).toEqual([]);
	});
});
