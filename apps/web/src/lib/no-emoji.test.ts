/**
 * Règle d'interface (CLAUDE.md §6, docs/UX.md §6) : aucune émoji, ni comme icône ni comme décoration,
 * et une seule bibliothèque d'icônes, Lucide.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const roots = [join(import.meta.dirname, '..'), join(import.meta.dirname, '../../../../packages/shared/src')];

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return files(path);
		return /\.(svelte|ts|css|html)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
	});
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}/u;

describe('icônes', () => {
	const sources = roots.flatMap(files);

	it('trouve bien les fichiers de l’interface', () => {
		expect(sources.length).toBeGreaterThan(20);
	});

	it('aucune émoji dans le code de l’interface', () => {
		expect(sources.filter((f) => EMOJI.test(readFileSync(f, 'utf8')))).toEqual([]);
	});

	it('une seule bibliothèque d’icônes : Lucide', () => {
		const others = sources.filter((f) =>
			/from ['"](phosphor-svelte|@iconify|svelte-icons|@heroicons|@tabler|lucide-svelte)/.test(readFileSync(f, 'utf8'))
		);
		expect(others).toEqual([]);
	});
});
