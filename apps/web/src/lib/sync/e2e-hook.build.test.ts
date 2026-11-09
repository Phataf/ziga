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

	it('garde-fou : le nom recherché est bien celui que pose l’accès', () => {
		expect(readFileSync(join(import.meta.dirname, 'e2e-hook.ts'), 'utf8')).toContain('[E2E_HOOK_NAME] = async');
		expect(E2E_HOOK_NAME).toBe('__zigaLocalCounts');
	});
});
