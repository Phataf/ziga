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

/** Texte brut d'un Word rempli (tests : ordre des clauses, absence de balise restante). */
export function docxText(docx: Buffer): string {
	const doc = new Docxtemplater(new PizZip(docx), { paragraphLoop: true, linebreaks: true, parser: flatParser });
	return doc.getFullText();
}
