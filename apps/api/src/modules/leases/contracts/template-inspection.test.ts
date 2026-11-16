/**
 * Contrôle d'un modèle Word déposé (lot 08 bis, point 2 du porteur) : chaque refus, sur un fichier piégé construit
 * pour lui. Aucun fichier réel : tout est fabriqué ici.
 */
import { deflateRawSync } from 'node:zlib';
import PizZip from 'pizzip';
import { describe, expect, it } from 'vitest';
import { buildDocx, p, type DocxOptions } from './docx-builder.js';
import {
	allowedHyperlinkTarget,
	fontReplacement,
	inspectTemplate,
	readZipEntries,
	TemplateRejectedError,
	type TemplateRejection
} from './template-inspection.js';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function docx(extra: Partial<DocxOptions> = {}, text = 'Le locataire {locataire.nom} paie {loyer.montant}.'): Buffer {
	return buildDocx({ blocks: [p(text)], ...extra });
}

function rejection(buffer: Buffer, kind: 'lease' | 'amendment' = 'lease'): TemplateRejection | null {
	try {
		inspectTemplate(buffer, kind);
		return null;
	} catch (error) {
		if (error instanceof TemplateRejectedError) return error.code;
		throw error;
	}
}

/** Un zip d'une seule entrée, écrit à la main (pour mentir sur les tailles ou les drapeaux). */
function rawZip(name: string, content: Buffer, patch: { declaredSize?: number; flags?: number; method?: number } = {}): Buffer {
	const data = deflateRawSync(content);
	const nameBuf = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(patch.flags ?? 0, 6);
	local.writeUInt16LE(patch.method ?? 8, 8);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(patch.declaredSize ?? content.length, 22);
	local.writeUInt16LE(nameBuf.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(patch.flags ?? 0, 8);
	central.writeUInt16LE(patch.method ?? 8, 10);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(patch.declaredSize ?? content.length, 24);
	central.writeUInt16LE(nameBuf.length, 28);
	central.writeUInt32LE(0, 42);
	const centralOffset = local.length + nameBuf.length + data.length;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8);
	eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(central.length + nameBuf.length, 12);
	eocd.writeUInt32LE(centralOffset, 16);
	return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

describe('modèle valide', () => {
	it('balises reconnues, inconnues, emplacements dans les sections, polices, pages', () => {
		const buffer = buildDocx({
			pages: 5,
			defaultFont: 'Calibri',
			blocks: [
				p([{ text: 'Bailleur : {bailleur.nom}', font: 'Cambria' }]),
				p([{ text: '{#penalite}Pénalité de {penalite.taux}{/penalite}', font: 'Times New Roman' }]),
				p([{ text: '{^bail.duree_indeterminee}Durée : {bail.duree}{/bail.duree_indeterminee}', font: 'Arial' }]),
				p([{ checkbox: true }, ' Meublé {client.nom}'])
			]
		});
		const r = inspectTemplate(buffer, 'lease');
		expect(r.known).toEqual(['bailleur.nom', 'penalite', 'penalite.taux', 'bail.duree_indeterminee', 'bail.duree']);
		expect(r.unknown).toEqual(['client.nom']);
		expect(r.usages).toContainEqual({ tag: 'penalite.taux', role: 'value', sections: [{ tag: 'penalite', inverted: false }] });
		expect(r.usages).toContainEqual({ tag: 'bail.duree', role: 'value', sections: [{ tag: 'bail.duree_indeterminee', inverted: true }] });
		expect(r.fonts).toEqual(['Arial', 'Calibri', 'Cambria', 'Times New Roman', 'Wingdings']);
		expect(r.unmatchedFonts).toEqual([]);
		expect(r.pageCount).toBe(5);
	});

	it('champs d’avenant : inconnus dans un modèle de bail, reconnus dans un modèle d’avenant', () => {
		const buffer = docx({}, 'Avenant n° {avenant.numero}');
		expect(inspectTemplate(buffer, 'lease').unknown).toEqual(['avenant.numero']);
		expect(inspectTemplate(buffer, 'amendment').unknown).toEqual([]);
	});

	it('polices sans équivalent de même métrique : signalées ; Calibri, Cambria, Times et Arial ont le leur', () => {
		const buffer = buildDocx({ blocks: [p([{ text: 'Titre', font: 'Century Gothic' }])], defaultFont: 'Calibri' });
		expect(inspectTemplate(buffer, 'lease').unmatchedFonts).toEqual(['Century Gothic']);
		expect(fontReplacement('Calibri')).toBe('Carlito');
		expect(fontReplacement('Cambria')).toBe('Caladea');
		expect(fontReplacement('Times New Roman')).toBe('Liberation Serif');
		expect(fontReplacement('Arial')).toBe('Liberation Sans');
	});

	it('lien hypertexte externe vers http, https ou mailto : accepté', () => {
		for (const target of ['https://ziga.com', 'http://exemple.bf/page', 'mailto:contact@exemple.bf', 'HTTPS://EXEMPLE.BF']) {
			const buffer = docx({
				extraDocumentRelationships: [`<Relationship Id="rIdL" Type="${R}/hyperlink" Target="${target}" TargetMode="External"/>`]
			});
			expect(rejection(buffer), target).toBeNull();
		}
	});
});

describe('refus, chacun testé', () => {
	it('fichier trop lourd (plus de 5 Mo)', () => {
		expect(rejection(Buffer.alloc(5 * 1024 * 1024 + 1))).toBe('TEMPLATE_TOO_LARGE');
	});

	it('pas un zip ; zip chiffré ; méthode de compression inconnue ; nom d’entrée dangereux', () => {
		expect(rejection(Buffer.from('ceci n’est pas un document Word'))).toBe('TEMPLATE_NOT_ZIP');
		expect(rejection(rawZip('word/document.xml', Buffer.from('<x/>'), { flags: 1 }))).toBe('TEMPLATE_NOT_ZIP');
		expect(rejection(rawZip('word/document.xml', Buffer.from('<x/>'), { method: 12 }))).toBe('TEMPLATE_NOT_ZIP');
		expect(rejection(rawZip('../evil.xml', Buffer.from('<x/>')))).toBe('TEMPLATE_NOT_ZIP');
	});

	it('bombe de décompression : taille déclarée fausse, plafond réel de 30 Mo atteint', () => {
		const bomb = rawZip('word/document.xml', Buffer.alloc(31 * 1024 * 1024), { declaredSize: 100 });
		expect(bomb.length).toBeLessThan(100 * 1024);
		expect(rejection(bomb)).toBe('TEMPLATE_UNCOMPRESSED_TOO_LARGE');
	});

	it('rapport de compression anormal (1 Mo de zéros)', () => {
		expect(rejection(rawZip('word/media/image1.bin', Buffer.alloc(1024 * 1024)))).toBe('TEMPLATE_COMPRESSION_RATIO');
	});

	it('taille réelle différente de la taille déclarée', () => {
		expect(rejection(rawZip('word/document.xml', Buffer.from('<w:document/>'), { declaredSize: 5 }))).toBe('TEMPLATE_NOT_ZIP');
	});

	it('trop d’entrées (plus de 1 000)', () => {
		const extraFiles = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`word/media/f${i}.txt`, 'x']));
		expect(rejection(docx({ extraFiles }))).toBe('TEMPLATE_TOO_MANY_ENTRIES');
	});

	it('pas un .docx : modèle .dotx, document sans partie Word', () => {
		const dotx = docx({ mainContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml' });
		expect(rejection(dotx)).toBe('TEMPLATE_NOT_DOCX');
		const zip = new PizZip();
		zip.file('[Content_Types].xml', '<Types/>');
		expect(rejection(zip.generate({ type: 'nodebuffer' }))).toBe('TEMPLATE_NOT_DOCX');
	});

	it('macros : .docm, vbaProject.bin, vbaData.xml', () => {
		expect(rejection(docx({ mainContentType: 'application/vnd.ms-word.document.macroEnabled.main+xml' }))).toBe('TEMPLATE_MACROS');
		expect(rejection(docx({ extraFiles: { 'word/vbaProject.bin': new Uint8Array([1, 2, 3]) } }))).toBe('TEMPLATE_MACROS');
		expect(rejection(docx({ extraFiles: { 'word/vbaData.xml': '<wne:vbaSuppData/>' } }))).toBe('TEMPLATE_MACROS');
	});

	it('contenu actif : ActiveX, objet OLE incorporé, morceau importé (altChunk)', () => {
		expect(rejection(docx({ extraFiles: { 'word/activeX/activeX1.xml': '<ax/>' } }))).toBe('TEMPLATE_ACTIVE_CONTENT');
		expect(rejection(docx({ extraFiles: { 'word/embeddings/oleObject1.bin': new Uint8Array([1]) } }))).toBe('TEMPLATE_ACTIVE_CONTENT');
		const ole = docx({ extraDocumentRelationships: [`<Relationship Id="rIdO" Type="${R}/oleObject" Target="embeddings/x.bin"/>`] });
		expect(rejection(ole)).toBe('TEMPLATE_ACTIVE_CONTENT');
		const chunk = docx({ extraDocumentRelationships: [`<Relationship Id="rIdA" Type="${R}/aFChunk" Target="afchunk.htm"/>`] });
		expect(rejection(chunk)).toBe('TEMPLATE_ACTIVE_CONTENT');
	});

	it('relations externes refusées : modèle attaché, image liée, objet OLE, cadre, sous-document', () => {
		const cases: [string, string, string][] = [
			['word/_rels/settings.xml.rels', 'attachedTemplate', 'https://exemple.bf/modele.dotm'],
			['word/_rels/document.xml.rels', 'image', 'https://exemple.bf/logo.png'],
			['word/_rels/document.xml.rels', 'oleObject', 'https://exemple.bf/objet.bin'],
			['word/_rels/webSettings.xml.rels', 'frame', 'https://exemple.bf/cadre.html'],
			['word/_rels/document.xml.rels', 'subDocument', 'https://exemple.bf/annexe.docx']
		];
		for (const [part, type, target] of cases) {
			const rel = `<Relationship Id="rIdX" Type="${R}/${type}" Target="${target}" TargetMode="External"/>`;
			const buffer =
				part === 'word/_rels/document.xml.rels'
					? docx({ extraDocumentRelationships: [rel] })
					: docx({
							extraFiles: {
								[part]: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`
							}
						});
			const code = rejection(buffer);
			expect(
				code === 'TEMPLATE_EXTERNAL_RELATIONSHIP' || (type === 'oleObject' && code === 'TEMPLATE_ACTIVE_CONTENT'),
				`${type} : ${code}`
			).toBe(true);
		}
	});

	it('liens hypertextes refusés : file:, chemin réseau \\\\, //hôte, chemin absolu, javascript:, ftp:, smb:', () => {
		for (const target of [
			'file:///C:/secret.txt',
			'\\\\serveur\\partage\\x.docx',
			'//serveur/partage',
			'/etc/passwd',
			'javascript:alert(1)',
			'ftp://exemple.bf',
			'smb://serveur/x',
			''
		]) {
			expect(allowedHyperlinkTarget(target), target).toBe(false);
			const buffer = docx({
				extraDocumentRelationships: [
					`<Relationship Id="rIdL" Type="${R}/hyperlink" Target="${target.replace(/&/g, '&amp;')}" TargetMode="External"/>`
				]
			});
			expect(rejection(buffer), target).toBe('TEMPLATE_EXTERNAL_RELATIONSHIP');
		}
	});

	it('champs qui chargent un contenu extérieur : INCLUDETEXT, INCLUDEPICTURE, LINK, DDEAUTO', () => {
		for (const field of [
			'INCLUDETEXT "C:\\\\x.docx"',
			'INCLUDEPICTURE "https://exemple.bf/x.png"',
			'LINK Excel.Sheet "x.xlsx"',
			'DDEAUTO c:\\\\cmd.exe'
		]) {
			const buffer = buildDocx({
				blocks: [p('Texte')],
				extraFiles: {
					'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${field} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body></w:document>`
				}
			});
			expect(rejection(buffer), field).toBe('TEMPLATE_EXTERNAL_FIELD');
		}
	});

	it('balises mal écrites : accolade non fermée, section non terminée', () => {
		expect(rejection(docx({}, 'Locataire : {locataire.nom'))).toBe('TEMPLATE_SYNTAX');
		expect(rejection(docx({}, '{#penalite}Pénalité sans fin de section'))).toBe('TEMPLATE_SYNTAX');
	});
});

describe('lecture du zip', () => {
	it('un document généré se relit entrée par entrée, sans dépasser les plafonds', () => {
		const entries = readZipEntries(docx());
		expect([...entries.keys()]).toContain('word/document.xml');
		expect(entries.get('word/document.xml')!.toString('utf8')).toContain('{locataire.nom}');
	});
});
