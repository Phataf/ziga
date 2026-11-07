/**
 * Règle d'interface (docs/UX.md §6) : aucune émoji comme icône ou décoration.
 * Les icônes viennent d'une seule bibliothèque, Lucide, pour un trait et des proportions homogènes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return files(path);
		return /\.(svelte|ts|css|html)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
	});
}

// Pictogrammes émoji (y compris drapeaux, symboles et sélecteur de variante émoji).
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

describe('icônes', () => {
	const sources = files(root);

	it('aucune émoji dans le code de l’interface', () => {
		const offenders = sources.filter((f) => EMOJI.test(readFileSync(f, 'utf8')));
		expect(offenders).toEqual([]);
	});

	it('une seule bibliothèque d’icônes : Lucide', () => {
		const others = sources.filter((f) => /from ['"](phosphor-svelte|@iconify|svelte-icons|@heroicons|@tabler)/.test(readFileSync(f, 'utf8')));
		expect(others).toEqual([]);
	});
});
