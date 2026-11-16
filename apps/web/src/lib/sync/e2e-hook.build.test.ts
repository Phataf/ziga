/**
 * L'accès des tests de bout en bout (e2e-hook.ts) ne figure pas dans une version de production construite sans
 * PUBLIC_E2E : la version est construite ici, dans un dossier à part, puis chaque fichier émis est fouillé.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { E2E_HOOK_NAME } from './e2e-hook';

const web = resolve(import.meta.dirname, '../../..');
const out = mkdtempSync(join(tmpdir(), 'ziga-build-'));

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('version de production sans PUBLIC_E2E', () => {
	it('ne contient pas l’accès des tests de bout en bout', { timeout: 240_000 }, () => {
		const env = { ...process.env, PUBLIC_E2E: '', ZIGA_BUILD_OUT: out };
		execFileSync(process.execPath, [join(web, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'error'], {
			cwd: web,
			env,
			stdio: 'pipe'
		});
		const emitted = files(out).filter((f) => /\.(js|mjs|html)$/.test(f));
		expect(emitted.length).toBeGreaterThan(10);
		const leaks = emitted.filter((f) => {
			const text = readFileSync(f, 'utf8');
			return text.includes(E2E_HOOK_NAME) || text.includes('installE2EHook');
		});
		expect(leaks).toEqual([]);
	});

	it('pdf-lib (lot 08 bis) n’est jamais chargé par la vitrine : seulement à la demande, dans l’application', () => {
		// Construite par le test précédent : manifeste des fichiers du navigateur et nœuds des routes générés par SvelteKit.
		const manifest = JSON.parse(readFileSync(join(web, '.svelte-kit/output/client/.vite/manifest.json'), 'utf8')) as Record<
			string,
			{ file: string; src?: string; imports?: string[]; dynamicImports?: string[] }
		>;
		const pdfLib = Object.keys(manifest).filter((k) => /node_modules\/.*pdf-lib/.test(k) || /pdf-lib/.test(manifest[k]!.file));
		expect(pdfLib.length, 'pdf-lib construit en morceau à part').toBeGreaterThan(0);
		// Nœuds de la vitrine : la mise en page racine et les pages publiques (routes/(public)).
		const nodes = Object.keys(manifest).filter((k) => /client-optimized\/nodes\/\d+\.js$/.test(k));
		const vitrine = nodes.filter((k) => {
			const source = readFileSync(join(web, k), 'utf8');
			return source.includes('src/routes/(public)/') || /src\/routes\/\+layout\.svelte/.test(source);
		});
		expect(vitrine.length).toBeGreaterThan(1);
		// Tout ce qu'un nœud de la vitrine charge d'emblée (importations statiques, de proche en proche).
		const reached = new Set<string>();
		const visit = (k: string) => {
			if (reached.has(k)) return;
			reached.add(k);
			for (const i of manifest[k]?.imports ?? []) visit(i);
		};
		vitrine.forEach(visit);
		expect([...reached].filter((k) => pdfLib.includes(k))).toEqual([]);
		for (const k of reached) expect(readFileSync(join(out, 'client', manifest[k]!.file), 'utf8'), k).not.toContain('Hopding/pdf-lib');
	});

	it('garde-fou : le nom recherché est bien celui que pose l’accès', () => {
		expect(readFileSync(join(import.meta.dirname, 'e2e-hook.ts'), 'utf8')).toContain('[E2E_HOOK_NAME] = async');
		expect(E2E_HOOK_NAME).toBe('__zigaLocalCounts');
	});
});
