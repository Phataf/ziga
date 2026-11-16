/**
 * Contrôle d'un modèle Word déposé par une organisation (lot 08 bis, point 2 du porteur), AVANT toute utilisation :
 *
 * 1. Taille du fichier, puis lecture du zip par ses propres en-têtes : nombre d'entrées, méthode de compression,
 *    chiffrement, noms ; chaque entrée est décompressée avec un plafond réel (`maxOutputLength` de zlib), jamais sur la
 *    foi des tailles déclarées, qui peuvent mentir (bombe de décompression) ; rapport de compression plafonné.
 * 2. Format : un .docx, et rien d'autre (ni .docm, ni .dotx, ni .dotm).
 * 3. Contenu actif refusé : macros (vbaProject.bin, vbaData.xml), contrôles ActiveX, objets OLE intégrés, morceaux
 *    importés (altChunk), champs qui chargent un contenu externe (INCLUDETEXT, INCLUDEPICTURE, LINK, DDE).
 * 4. Relations externes (TargetMode="External") refusées, sauf un lien hypertexte vers http, https ou mailto : ni modèle
 *    attaché, ni image liée, ni objet OLE, ni cadre, ni sous-document ; ni file:, ni chemin réseau \\, ni autre schéma.
 * 5. Balises : lues par docxtemplater (syntaxe), classées reconnues ou inconnues par le catalogue ; chaque valeur avec
 *    les sections qui l'entourent (`blankFields`). Une balise inconnue bloque l'activation (décidé par l'appelant).
 * 6. Polices utilisées, celles qui n'ont pas d'équivalent de même métrique dans le service de conversion, et nombre de
 *    pages inscrit par Word (docProps/app.xml), pour comparer avec le PDF.
 */
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import { CONTRACT_TEMPLATE_LIMITS } from '@ziga/shared/contracts';
import { classifyTemplateTags, type ContractTemplateKind, type TemplateTagUsage } from '@ziga/shared/contract-fields';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';

/** Le module d'inspection exporte une fabrique (CommonJS), alors que ses types annoncent une classe. */
interface InspectModule extends Docxtemplater.DXT.Module {
	getAllStructuredTags(): unknown[];
}
const createInspectModule = createRequire(import.meta.url)('docxtemplater/js/inspect-module.js') as () => InspectModule;

export type TemplateRejection =
	| 'TEMPLATE_TOO_LARGE'
	| 'TEMPLATE_NOT_ZIP'
	| 'TEMPLATE_TOO_MANY_ENTRIES'
	| 'TEMPLATE_UNCOMPRESSED_TOO_LARGE'
	| 'TEMPLATE_COMPRESSION_RATIO'
	| 'TEMPLATE_NOT_DOCX'
	| 'TEMPLATE_MACROS'
	| 'TEMPLATE_ACTIVE_CONTENT'
	| 'TEMPLATE_EXTERNAL_RELATIONSHIP'
	| 'TEMPLATE_EXTERNAL_FIELD'
	| 'TEMPLATE_SYNTAX';

const MESSAGES: Record<TemplateRejection, string> = {
	TEMPLATE_TOO_LARGE: 'Modèle trop lourd : 5 Mo au plus.',
	TEMPLATE_NOT_ZIP: 'Ce fichier n’est pas un document Word (.docx) lisible.',
	TEMPLATE_TOO_MANY_ENTRIES: 'Ce document contient trop d’éléments pour un modèle de contrat.',
	TEMPLATE_UNCOMPRESSED_TOO_LARGE: 'Ce document est trop volumineux une fois décompressé (30 Mo au plus).',
	TEMPLATE_COMPRESSION_RATIO: 'Ce document est anormalement compressé : il est refusé par précaution.',
	TEMPLATE_NOT_DOCX: 'Seul un document Word .docx est accepté (ni .docm, ni modèle .dotx ou .dotm).',
	TEMPLATE_MACROS: 'Ce document contient des macros : enregistrez-le en .docx sans macros.',
	TEMPLATE_ACTIVE_CONTENT: 'Ce document contient un contenu actif (contrôle ActiveX, objet incorporé ou importé) : retirez-le.',
	TEMPLATE_EXTERNAL_RELATIONSHIP:
		'Ce document charge un élément extérieur (modèle attaché, image liée, objet, cadre, sous-document ou lien non autorisé) : retirez-le.',
	TEMPLATE_EXTERNAL_FIELD: 'Ce document contient un champ qui charge un contenu extérieur (INCLUDETEXT, INCLUDEPICTURE, LINK, DDE).',
	TEMPLATE_SYNTAX: 'Une balise du modèle est mal écrite (accolade non fermée, section non terminée…).'
};

export class TemplateRejectedError extends Error {
	constructor(
		readonly code: TemplateRejection,
		readonly details: Record<string, unknown> = {}
	) {
		super(MESSAGES[code]);
		this.name = 'TemplateRejectedError';
	}
}

export interface TemplateInspection {
	/** Toutes les balises, dans l'ordre de première apparition. */
	tags: string[];
	known: string[];
	unknown: string[];
	usages: TemplateTagUsage[];
	fonts: string[];
	unmatchedFonts: string[];
	/** Nombre de pages inscrit par Word à l'enregistrement (absent si le fichier ne le dit pas). */
	pageCount: number | null;
}

// ---------------------------------------------------------------- lecture du zip, avec plafonds réels

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Ratio vérifié seulement au-delà de cette taille décompressée : un petit XML très répétitif n'est pas une bombe. */
const RATIO_CHECK_FROM_BYTES = 256 * 1024;

/**
 * Lit les entrées du zip et les décompresse, plafond compris. Refuse : zip illisible, zip64 ou chiffré, méthode autre
 * que « stockée » ou « deflate », noms dangereux ou en double, trop d'entrées, trop d'octets décompressés, rapport de
 * compression anormal, taille réelle différente de la taille déclarée.
 */
export function readZipEntries(buffer: Buffer, limits = CONTRACT_TEMPLATE_LIMITS): Map<string, Buffer> {
	if (buffer.length > limits.maxBytes) throw new TemplateRejectedError('TEMPLATE_TOO_LARGE', { bytes: buffer.length });
	const notZip = (reason: string) => new TemplateRejectedError('TEMPLATE_NOT_ZIP', { reason });
	let eocd = -1;
	for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
		if (buffer.readUInt32LE(i) === EOCD) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw notZip('fin du zip introuvable');
	const count = buffer.readUInt16LE(eocd + 10);
	const centralOffset = buffer.readUInt32LE(eocd + 16);
	if (count === 0xffff || centralOffset === 0xffffffff) throw notZip('zip64');
	if (count > limits.maxEntries) throw new TemplateRejectedError('TEMPLATE_TOO_MANY_ENTRIES', { entries: count });
	const entries = new Map<string, Buffer>();
	let total = 0;
	let at = centralOffset;
	for (let n = 0; n < count; n++) {
		if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) throw notZip('répertoire central invalide');
		const flags = buffer.readUInt16LE(at + 8);
		const method = buffer.readUInt16LE(at + 10);
		const compressedSize = buffer.readUInt32LE(at + 20);
		const declaredSize = buffer.readUInt32LE(at + 24);
		const nameLength = buffer.readUInt16LE(at + 28);
		const extraLength = buffer.readUInt16LE(at + 30);
		const commentLength = buffer.readUInt16LE(at + 32);
		const localOffset = buffer.readUInt32LE(at + 42);
		const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
		at += 46 + nameLength + extraLength + commentLength;
		if (flags & 0x1) throw notZip('entrée chiffrée');
		if (compressedSize === 0xffffffff || declaredSize === 0xffffffff || localOffset === 0xffffffff) throw notZip('zip64');
		if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))
			throw notZip(`nom d’entrée refusé : ${name}`);
		if (entries.has(name)) throw notZip(`entrée en double : ${name}`);
		if (name.endsWith('/')) continue;
		if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) throw notZip('en-tête local invalide');
		const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
		const data = buffer.subarray(dataStart, dataStart + compressedSize);
		if (data.length !== compressedSize) throw notZip('entrée tronquée');
		const budget = limits.maxUncompressedBytes - total;
		let content: Buffer;
		if (method === 0) {
			content = data;
		} else if (method === 8) {
			try {
				// Plafond réel : zlib s'arrête au budget restant (+1 pour détecter le dépassement), quoi que dise l'en-tête.
				content = inflateRawSync(data, { maxOutputLength: Math.max(1, budget + 1) });
			} catch (error) {
				if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
					throw new TemplateRejectedError('TEMPLATE_UNCOMPRESSED_TOO_LARGE', { entry: name });
				}
				throw notZip(`entrée illisible : ${name}`);
			}
		} else {
			throw notZip(`méthode de compression ${method}`);
		}
		if (content.length > budget) throw new TemplateRejectedError('TEMPLATE_UNCOMPRESSED_TOO_LARGE', { entry: name });
		if (content.length !== declaredSize) throw notZip(`taille annoncée fausse : ${name}`);
		if (content.length >= RATIO_CHECK_FROM_BYTES && content.length / Math.max(1, compressedSize) > limits.maxCompressionRatio) {
			throw new TemplateRejectedError('TEMPLATE_COMPRESSION_RATIO', { entry: name });
		}
		total += content.length;
		entries.set(name, content);
	}
	return entries;
}

// ---------------------------------------------------------------- format et contenu actif

const MAIN_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function attributes(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/([A-Za-z:]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!] = decodeXml(m[3] ?? m[4] ?? '');
	return out;
}

function decodeXml(v: string): string {
	return v
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&amp;/g, '&');
}

function checkFormat(entries: Map<string, Buffer>): void {
	const types = entries.get('[Content_Types].xml')?.toString('utf8');
	if (!types || !entries.has('word/document.xml'))
		throw new TemplateRejectedError('TEMPLATE_NOT_DOCX', { reason: 'parties Word absentes' });
	if (/macroEnabled/i.test(types)) throw new TemplateRejectedError('TEMPLATE_MACROS', { reason: 'type de contenu à macros' });
	const main = [...types.matchAll(/<Override\b[^>]*>/g)].map((m) => attributes(m[0])).find((a) => a.PartName === '/word/document.xml');
	if (main?.ContentType !== MAIN_DOCX) throw new TemplateRejectedError('TEMPLATE_NOT_DOCX', { contentType: main?.ContentType ?? null });
}

function checkActiveContent(entries: Map<string, Buffer>): void {
	for (const name of entries.keys()) {
		const lower = name.toLowerCase();
		const base = lower.split('/').pop() ?? '';
		if (base === 'vbaproject.bin' || base === 'vbadata.xml' || base.startsWith('vbaproject')) {
			throw new TemplateRejectedError('TEMPLATE_MACROS', { entry: name });
		}
		if (lower.includes('/activex/') || (lower.includes('/embeddings/') && !/\.(png|jpe?g|gif|bmp|emf|wmf)$/.test(lower))) {
			throw new TemplateRejectedError('TEMPLATE_ACTIVE_CONTENT', { entry: name });
		}
	}
}

const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:'];

/** Un lien hypertexte externe n'est accepté que vers http, https ou mailto : jamais file:, \\serveur, //hôte… */
export function allowedHyperlinkTarget(target: string): boolean {
	const t = target.trim();
	if (!t || t.startsWith('\\') || t.startsWith('//') || t.startsWith('/')) return false;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t)?.[1]?.toLowerCase();
	return !!scheme && ALLOWED_LINK_SCHEMES.includes(`${scheme}:`);
}

function checkRelationships(entries: Map<string, Buffer>): void {
	for (const [name, content] of entries) {
		if (!name.endsWith('.rels')) continue;
		for (const m of content.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
			const rel = attributes(m[0]);
			const type = (rel.Type ?? '').split('/').pop() ?? '';
			// Contenu importé dans le document (HTML, autre document) : refusé même interne.
			if (type === 'aFChunk' || type === 'oleObject' || type === 'control' || type === 'subDocument') {
				throw new TemplateRejectedError(type === 'subDocument' ? 'TEMPLATE_EXTERNAL_RELATIONSHIP' : 'TEMPLATE_ACTIVE_CONTENT', {
					part: name,
					type
				});
			}
			if ((rel.TargetMode ?? '').toLowerCase() !== 'external') continue;
			if (type === 'hyperlink' && allowedHyperlinkTarget(rel.Target ?? '')) continue;
			throw new TemplateRejectedError('TEMPLATE_EXTERNAL_RELATIONSHIP', { part: name, type, target: rel.Target ?? null });
		}
	}
}

const EXTERNAL_FIELDS = /\b(INCLUDETEXT|INCLUDEPICTURE|INCLUDE|LINK|DDEAUTO|DDE|IMPORT)\b/i;

function checkFields(entries: Map<string, Buffer>): void {
	for (const [name, content] of entries) {
		if (!/^word\/.*\.xml$/.test(name)) continue;
		const xml = content.toString('utf8');
		const instructions = [
			...[...xml.matchAll(/<w:instrText\b[^>]*>([^<]*)<\/w:instrText>/g)].map((m) => decodeXml(m[1]!)),
			...[...xml.matchAll(/<w:fldSimple\b[^>]*>/g)].map((m) => attributes(m[0])['w:instr'] ?? '')
		];
		// Un champ peut être coupé en plusieurs morceaux : on lit leur suite.
		const joined = instructions.join(' ');
		const found = EXTERNAL_FIELDS.exec(joined);
		if (found) throw new TemplateRejectedError('TEMPLATE_EXTERNAL_FIELD', { part: name, field: found[1]!.toUpperCase() });
		if (/<w:altChunk\b/.test(xml)) throw new TemplateRejectedError('TEMPLATE_ACTIVE_CONTENT', { part: name, type: 'altChunk' });
	}
}

// ---------------------------------------------------------------- polices

/**
 * Polices disponibles dans l'image Gotenberg 8.40 (fonts-crosextra-carlito, -caladea, fonts-liberation, -liberation2,
 * fonts-dejavu, fonts-noto…) ou remplacées par LibreOffice par une police de même métrique.
 */
const METRIC_COMPATIBLE: Record<string, string> = {
	calibri: 'Carlito',
	cambria: 'Caladea',
	'times new roman': 'Liberation Serif',
	times: 'Liberation Serif',
	arial: 'Liberation Sans',
	helvetica: 'Liberation Sans',
	'courier new': 'Liberation Mono',
	courier: 'Liberation Mono',
	'arial narrow': 'Liberation Sans Narrow'
};
const AVAILABLE = /^(liberation |carlito|caladea|dejavu|noto |opensymbol|symbol$|wingdings$)/i;

export function fontReplacement(font: string): string | null {
	const f = font.trim().toLowerCase();
	if (METRIC_COMPATIBLE[f]) return METRIC_COMPATIBLE[f];
	return AVAILABLE.test(font.trim()) ? font.trim() : null;
}

function readFonts(entries: Map<string, Buffer>): string[] {
	const theme = entries.get('word/theme/theme1.xml')?.toString('utf8') ?? '';
	const themeFont = (kind: 'major' | 'minor') =>
		new RegExp(`<a:${kind}Font>\\s*<a:latin\\b[^>]*typeface="([^"]+)"`).exec(theme)?.[1] ?? null;
	const fonts = new Set<string>();
	for (const name of [
		'word/document.xml',
		'word/styles.xml',
		...[...entries.keys()].filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))
	]) {
		const xml = entries.get(name)?.toString('utf8');
		if (!xml) continue;
		for (const m of xml.matchAll(/<w:rFonts\b[^>]*>/g)) {
			const a = attributes(m[0]);
			for (const key of ['w:ascii', 'w:hAnsi']) if (a[key]) fonts.add(a[key]);
			for (const key of ['w:asciiTheme', 'w:hAnsiTheme']) {
				const v = a[key];
				const resolved = v?.startsWith('major') ? themeFont('major') : v?.startsWith('minor') ? themeFont('minor') : null;
				if (resolved) fonts.add(resolved);
			}
		}
		for (const m of xml.matchAll(/<w:sym\b[^>]*>/g)) {
			const font = attributes(m[0])['w:font'];
			if (font) fonts.add(font);
		}
	}
	return [...fonts].sort((x, y) => x.localeCompare(y));
}

function readPageCount(entries: Map<string, Buffer>): number | null {
	const app = entries.get('docProps/app.xml')?.toString('utf8');
	const n = app ? Number(/<Pages>(\d+)<\/Pages>/.exec(app)?.[1]) : NaN;
	return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------- balises

interface StructuredTag {
	type: string;
	value: string;
	module?: string;
	inverted?: boolean;
	subparsed?: StructuredTag[];
}

function walk(tags: readonly StructuredTag[], sections: TemplateTagUsage['sections'], out: TemplateTagUsage[]): void {
	for (const t of tags) {
		if (t.module === 'loop') {
			out.push({ tag: t.value, role: 'section', sections });
			walk(t.subparsed ?? [], [...sections, { tag: t.value, inverted: t.inverted === true }], out);
		} else if (t.type === 'placeholder') {
			out.push({ tag: t.value, role: 'value', sections });
		}
	}
}

/** Lecteur de balises : une balise est une clé du catalogue, jamais une expression. */
export function flatParser(tag: string): { get: (scope: unknown, context: { scopeList: unknown[] }) => unknown } {
	return {
		get: (scope, context) => {
			if (tag === '.') return scope;
			const root = context.scopeList[0] as Record<string, unknown>;
			return root[tag];
		}
	};
}

/** Erreurs de syntaxe de docxtemplater, lisibles : « Balise non fermée : {locataire.nom ». */
function syntaxDetails(error: unknown): { messages: string[] } {
	const errors =
		(error as { properties?: { errors?: { properties?: { explanation?: string; xtag?: string } }[] } }).properties?.errors ?? [];
	const messages = errors.map((e) => [e.properties?.explanation, e.properties?.xtag].filter(Boolean).join(' : '));
	return { messages: messages.length ? messages : [String((error as Error).message)] };
}

function readTags(buffer: Buffer): TemplateTagUsage[] {
	const inspect = createInspectModule();
	try {
		new Docxtemplater(new PizZip(buffer), { modules: [inspect], paragraphLoop: true, linebreaks: true, parser: flatParser });
	} catch (error) {
		throw new TemplateRejectedError('TEMPLATE_SYNTAX', syntaxDetails(error));
	}
	const usages: TemplateTagUsage[] = [];
	walk(inspect.getAllStructuredTags() as StructuredTag[], [], usages);
	return usages;
}

/**
 * Contrôle complet d'un modèle déposé. Lève `TemplateRejectedError` au premier refus ; sinon renvoie les balises
 * (reconnues, inconnues, emplacements), les polices et le nombre de pages.
 */
export function inspectTemplate(buffer: Buffer, kind: ContractTemplateKind): TemplateInspection {
	const entries = readZipEntries(buffer);
	checkFormat(entries);
	checkActiveContent(entries);
	checkRelationships(entries);
	checkFields(entries);
	const usages = readTags(buffer);
	const tags: string[] = [];
	for (const u of usages) if (!tags.includes(u.tag)) tags.push(u.tag);
	const { known, unknown } = classifyTemplateTags(tags, kind);
	const fonts = readFonts(entries);
	return {
		tags,
		known,
		unknown,
		usages,
		fonts,
		unmatchedFonts: fonts.filter((f) => !fontReplacement(f)),
		pageCount: readPageCount(entries)
	};
}
