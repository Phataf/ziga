/**
 * Remplissage d'un modèle Word avec les valeurs résolues d'un contrat (lot 08 bis), par docxtemplater (cœur MIT, D23).
 * Une balise est une clé du catalogue (`flatParser`), jamais une expression : un modèle ne peut rien calculer ni
 * exécuter. Une balise sans valeur s'écrit vide : les blancs sont signalés AVANT (`blankFields`), et un contrat qui en a
 * ne peut pas être figé.
 */
import { createHash } from 'node:crypto';
import type { ContractFieldValue } from '@ziga/shared/contract-fields';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { flatParser } from './template-inspection.js';

export function fillTemplate(template: Buffer, values: Readonly<Record<string, ContractFieldValue>>): Buffer {
	const doc = new Docxtemplater(new PizZip(template), {
		paragraphLoop: true,
		linebreaks: true,
		parser: flatParser,
		nullGetter: () => ''
	});
	doc.render({ ...values });
	return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export function sha256(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Texte d'un Word rempli, caractère pour caractère (tests : ordre des clauses, blancs, espaces insécables), lu dans les
 * nœuds de texte du corps (ou d'une autre partie : `word/footer1.xml`). `getFullText` de docxtemplater remplace les espaces insécables : il n'est pas utilisé.
 */
export function docxText(docx: Buffer, part = 'word/document.xml'): string {
	const xml = new PizZip(docx).file(part)?.asText() ?? '';
	const decode = (v: string) =>
		v
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&amp;/g, '&');
	// Un paragraphe par ligne : le texte versionné des clauses se relit tel quel.
	return xml
		.split('</w:p>')
		.map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => decode(m[1]!)).join(''))
		.filter((line) => line.length > 0)
		.join('\n');
}
