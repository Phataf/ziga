/**
 * Petit générateur de fichiers Word (.docx) sans dépendance de plus que pizzip (lot 08 bis) : le modèle par défaut de
 * la plateforme (D25) et les fichiers d'essai des tests (modèle synthétique de même structure que celui de l'agence
 * pilote, fichiers piégés pour chaque refus). Sortie déterministe : mêmes entrées, mêmes octets (date fixe des entrées
 * du zip et des propriétés du document).
 */
import PizZip from 'pizzip';

export interface DocxRun {
	text?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	/** Police (ascii et hAnsi) : Calibri, Cambria, Times New Roman, Arial… */
	font?: string;
	/** Taille en points. */
	size?: number;
	/** Case à cocher dessinée par la police Wingdings (vide : F0A8, cochée : F0FE). */
	checkbox?: boolean | 'checked';
	/** Saut de ligne dans le paragraphe. */
	lineBreak?: boolean;
	/** Champ calculé par le traitement de texte : numéro de la page, ou nombre de pages. */
	field?: 'PAGE' | 'NUMPAGES';
}

export interface DocxParagraph {
	kind?: 'paragraph';
	runs: (DocxRun | string)[];
	style?: 'Title' | 'Heading1' | 'Normal';
	align?: 'left' | 'center' | 'right' | 'both';
	/** Saut de page avant le paragraphe. */
	pageBreakBefore?: boolean;
	/** Garder ce paragraphe sur la même page que le suivant. */
	keepNext?: boolean;
	/** Espace après, en points. */
	spacingAfter?: number;
}

export interface DocxTable {
	kind: 'table';
	/** Largeurs des colonnes, en vingtièmes de point (dxa) ; 9 000 dxa ≈ largeur utile d'une page A4. */
	widths: number[];
	rows: DocxParagraph[][];
	/** Garder le tableau d'un seul tenant (bloc des signatures) : lignes insécables, chacune liée à la suivante. */
	keepTogether?: boolean;
	/** La dernière ligne reste aussi liée à ce qui suit (un second tableau de signatures). */
	keepWithNext?: boolean;
}

export type DocxBlock = DocxParagraph | DocxTable;

export interface DocxOptions {
	blocks: DocxBlock[];
	/** Police par défaut du document (styles). */
	defaultFont?: string;
	/** Taille par défaut en points. */
	defaultSize?: number;
	/** Nombre de pages inscrit dans docProps/app.xml, comme Word le fait à l'enregistrement. */
	pages?: number;
	title?: string;
	/** Parties supplémentaires, ou remplacées (tests : macros, relations externes…). */
	extraFiles?: Record<string, string | Uint8Array>;
	/** Relations supplémentaires de word/document.xml (`<Relationship …/>` complètes). */
	extraDocumentRelationships?: string[];
	/** Pied de page de chaque page (référence, « Page X sur Y », paraphes). */
	footer?: DocxParagraph[];
	/** Entrées supplémentaires de [Content_Types].xml. */
	extraContentTypes?: string[];
	/** Type de contenu de la partie principale (tests : .docm, .dotx). */
	mainContentType?: string;
}

export const DOCX_MAIN_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

/** Date fixe des entrées : un même modèle donne toujours les mêmes octets. */
const FIXED_DATE = new Date(Date.UTC(2026, 10, 15, 0, 0, 0));

export function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function runXml(input: DocxRun | string): string {
	const run: DocxRun = typeof input === 'string' ? { text: input } : input;
	if (run.field) {
		const size = run.size ? `<w:rPr><w:sz w:val="${run.size * 2}"/></w:rPr>` : '';
		return `<w:fldSimple w:instr=" ${run.field} \\* MERGEFORMAT "><w:r>${size}<w:t>1</w:t></w:r></w:fldSimple>`;
	}
	const props: string[] = [];
	if (run.font) props.push(`<w:rFonts w:ascii="${escapeXml(run.font)}" w:hAnsi="${escapeXml(run.font)}" w:cs="${escapeXml(run.font)}"/>`);
	if (run.bold) props.push('<w:b/>');
	if (run.italic) props.push('<w:i/>');
	if (run.underline) props.push('<w:u w:val="single"/>');
	if (run.size) props.push(`<w:sz w:val="${run.size * 2}"/><w:szCs w:val="${run.size * 2}"/>`);
	const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
	const parts: string[] = [];
	if (run.checkbox !== undefined) parts.push(`<w:sym w:font="Wingdings" w:char="${run.checkbox === 'checked' ? 'F0FE' : 'F0A8'}"/>`);
	if (run.text !== undefined) parts.push(`<w:t xml:space="preserve">${escapeXml(run.text)}</w:t>`);
	if (run.lineBreak) parts.push('<w:br/>');
	return `<w:r>${rPr}${parts.join('')}</w:r>`;
}

function paragraphXml(p: DocxParagraph, keepNext = false): string {
	const props: string[] = [];
	if (keepNext || p.keepNext) props.push('<w:keepNext/>');
	if (p.style && p.style !== 'Normal') props.push(`<w:pStyle w:val="${p.style}"/>`);
	if (p.pageBreakBefore) props.push('<w:pageBreakBefore/>');
	if (p.spacingAfter !== undefined) props.push(`<w:spacing w:after="${p.spacingAfter * 20}"/>`);
	if (p.align) props.push(`<w:jc w:val="${p.align}"/>`);
	const pPr = props.length ? `<w:pPr>${props.join('')}</w:pPr>` : '';
	return `<w:p>${pPr}${p.runs.map(runXml).join('')}</w:p>`;
}

function tableXml(t: DocxTable): string {
	const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
		.map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
		.join('');
	const grid = t.widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
	const rows = t.rows
		.map((cells, r) => {
			const keep = !!t.keepTogether && (r < t.rows.length - 1 || !!t.keepWithNext);
			const trPr = t.keepTogether ? '<w:trPr><w:cantSplit/></w:trPr>' : '';
			return `<w:tr>${trPr}${cells
				.map(
					(cell, i) => `<w:tc><w:tcPr><w:tcW w:w="${t.widths[i] ?? t.widths[0]}" w:type="dxa"/></w:tcPr>${paragraphXml(cell, keep)}</w:tc>`
				)
				.join('')}</w:tr>`;
		})
		.join('');
	return `<w:tbl><w:tblPr><w:tblW w:w="${t.widths.reduce((s, w) => s + w, 0)}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

const W_NS =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function documentXml(blocks: readonly DocxBlock[], withFooter: boolean): string {
	const body = blocks.map((b) => (b.kind === 'table' ? tableXml(b) : paragraphXml(b))).join('');
	// Page A4, marges de 2 cm.
	const footer = withFooter ? '<w:footerReference w:type="default" r:id="rIdFooter"/>' : '';
	const section = `<w:sectPr>${footer}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${body}${section}</w:body></w:document>`;
}

function stylesXml(font: string, size: number): string {
	const f = escapeXml(font);
	const style = (id: string, name: string, extra: string) =>
		`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>${extra}</w:style>`;
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}" w:eastAsia="${f}"/><w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${style(
		'Title',
		'Title',
		'<w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>'
	)}${style('Heading1', 'heading 1', '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr>')}</w:styles>`;
}

/** Construit un .docx à partir de blocs (paragraphes et tableaux). */
export function buildDocx(options: DocxOptions): Buffer {
	const zip = new PizZip();
	const add = (name: string, content: string | Uint8Array) => zip.file(name, content, { date: FIXED_DATE, createFolders: false });
	add(
		'[Content_Types].xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${escapeXml(options.mainContentType ?? DOCX_MAIN_CONTENT_TYPE)}"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${options.footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${(options.extraContentTypes ?? []).join('')}</Types>`
	);
	add(
		'_rels/.rels',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`
	);
	add(
		'word/_rels/document.xml.rels',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${options.footer ? '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}${(options.extraDocumentRelationships ?? []).join('')}</Relationships>`
	);
	add('word/document.xml', documentXml(options.blocks, !!options.footer));
	if (options.footer) {
		add(
			'word/footer1.xml',
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${W_NS}>${options.footer.map((p) => paragraphXml(p)).join('')}</w:ftr>`
		);
	}
	add('word/styles.xml', stylesXml(options.defaultFont ?? 'Times New Roman', options.defaultSize ?? 11));
	add(
		'docProps/app.xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Ziga</Application>${options.pages ? `<Pages>${options.pages}</Pages>` : ''}</Properties>`
	);
	add(
		'docProps/core.xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(options.title ?? 'Contrat de bail')}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">2026-11-15T00:00:00Z</dcterms:created></cp:coreProperties>`
	);
	for (const [name, content] of Object.entries(options.extraFiles ?? {})) add(name, content);
	return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Raccourcis d'écriture des blocs. */
export const p = (text: string | (DocxRun | string)[], extra: Omit<DocxParagraph, 'runs'> = {}): DocxParagraph => ({
	runs: typeof text === 'string' ? [text] : text,
	...extra
});
export const h = (text: string): DocxParagraph => ({ runs: [text], style: 'Heading1' });
