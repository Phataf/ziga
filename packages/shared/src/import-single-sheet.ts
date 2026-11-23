/**
 * Import Excel (lot 11, étape 4b) : fichier libre sur une seule feuille. Beaucoup d'agences tiennent leur registre
 * sur une feuille, une ligne par logement, le propriétaire et le bien répétés d'une ligne à l'autre. La personne fait
 * correspondre les colonnes de sa feuille à des champs de plusieurs onglets du modèle à la fois, et donne une valeur
 * commune aux champs absents de son fichier (type de bien, mandat…). La feuille est alors répartie dans les sept
 * onglets du modèle, sans rien inventer :
 * - une fiche par propriétaire, bien, locataire (mêmes nom et téléphone, à la casse et aux accents près) ; une unité
 *   par bien et libellé ; un bail par ligne qui nomme un locataire ; une caution et un solde d'ouverture par ligne qui
 *   en porte un ;
 * - les références entre onglets se déduisent des lignes, jamais demandées ;
 * - les numéros de ligne restent ceux du fichier (une répétition laisse une ligne vide, ignorée sans décalage).
 * Le plan d'import (`planImport`) s'applique ensuite tel quel ; `relabel` récrit ses messages avec le nom de la
 * feuille et des colonnes du fichier (« Ligne 7 de Feuil1, colonne Contact : … »).
 */
import { IMPORT_SHEET_KEYS, IMPORT_SHEET_NAMES, importTemplate, matchImportColumns } from './import-template.js';
import type { ImportField, ImportSheetDefinition, ImportSheetInput, ImportSheetKey } from './import-template.js';
import type { ImportIssue } from './import-rows.js';
import { importText, labelKey, parseImportPhone, type CellValue } from './import-values.js';
import type { OrganizationType } from './permissions.js';

/** Champ cible : `onglet.champ` (« tenants.phone »). */
export type SingleSheetTargetId = string;

export interface SingleSheetMapping {
	/** Nom de la feuille du fichier. */
	sheet: string;
	/** Champ → colonne du fichier (0 = première). Une colonne peut servir plusieurs champs (loyer de l'unité et du bail). */
	columns: Record<SingleSheetTargetId, number>;
	/** Champ → valeur commune à toutes les lignes, pour un champ absent du fichier. */
	constants: Record<SingleSheetTargetId, string>;
}

export interface SingleSheetTarget {
	id: SingleSheetTargetId;
	sheet: ImportSheetKey;
	field: ImportField;
	/** Obligatoire dans le modèle (exigé seulement si son groupe est utilisé). */
	required: boolean;
	/** Une valeur commune est permise : listes, oui ou non, pourcentages, nombres, et quelques champs du bien et du mandat. */
	constantAllowed: boolean;
}

/** Références entre onglets : déduites des lignes, jamais demandées. */
const GENERATED: Record<ImportSheetKey, readonly string[]> = {
	owners: ['ref'],
	properties: ['ref', 'ownerRef'],
	units: ['ref', 'propertyRef'],
	tenants: ['ref'],
	leases: ['ref', 'unitRef', 'tenant'],
	deposits: ['lease'],
	opening_balances: ['lease']
};

/** D'où vient une référence déduite, pour nommer la colonne dans un message. */
const GENERATED_SOURCE: Record<string, SingleSheetTargetId> = {
	'owners.ref': 'owners.name',
	'properties.ref': 'properties.name',
	'properties.ownerRef': 'owners.name',
	'units.ref': 'units.label',
	'units.propertyRef': 'properties.name',
	'tenants.ref': 'tenants.fullName',
	'leases.unitRef': 'units.label',
	'leases.tenant': 'tenants.fullName',
	'deposits.lease': 'units.label',
	'opening_balances.lease': 'units.label'
};

const CONSTANT_KINDS = new Set(['choice', 'boolean', 'percent', 'integer']);
const CONSTANT_FIELDS = new Set([
	'owners.name',
	'owners.phone',
	'properties.name',
	'properties.commune',
	'properties.neighborhood',
	'properties.mandateStartsOn',
	'properties.mandateEndsOn',
	'properties.commissionAmount'
]);

/**
 * Jamais de valeur commune, même pour un nombre (réponse du porteur après l'étape 4b) : un même arriéré, une même
 * caution reçue ou une même avance sur toutes les lignes serait une erreur silencieuse. Une valeur commune envoyée
 * quand même pour un de ces champs est ignorée.
 */
const NEVER_CONSTANT = new Set(['opening_balances.amount', 'deposits.receivedAmount', 'leases.advanceMonths']);

/** Colonnes qui servent deux champs sans ambiguïté (loyer et charges de l'unité et du bail). */
const SHARED_COLUMNS = [new Set(['units.rent', 'leases.rent']), new Set(['units.charges', 'leases.charges'])];

export function singleSheetTargets(type: OrganizationType): SingleSheetTarget[] {
	return importTemplate(type).flatMap((def) =>
		def.fields
			.filter((f) => !GENERATED[def.key].includes(f.key))
			.map((f) => {
				const id = `${def.key}.${f.key}`;
				return {
					id,
					sheet: def.key,
					field: f,
					required: f.required,
					constantAllowed: !NEVER_CONSTANT.has(id) && (CONSTANT_KINDS.has(f.kind) || CONSTANT_FIELDS.has(id))
				};
			})
	);
}

const filled = (v: string | undefined) => v !== undefined && v.trim() !== '';

/** Groupes utilisés par une correspondance : les locataires et les baux viennent du nom du locataire, etc. */
function activeSheets(mapping: Pick<SingleSheetMapping, 'columns'>, type: OrganizationType): Set<ImportSheetKey> {
	const has = (id: string) => mapping.columns[id] !== undefined;
	const active = new Set<ImportSheetKey>(['properties', 'units']);
	if (type === 'agency') active.add('owners');
	if (has('tenants.fullName')) {
		active.add('tenants');
		active.add('leases');
		if (has('deposits.agreedAmount')) active.add('deposits');
		if (has('opening_balances.amount')) active.add('opening_balances');
	}
	return active;
}

/** Champs obligatoires d'un groupe utilisé, ni reliés à une colonne ni donnés en valeur commune. */
export function singleSheetMissing(mapping: SingleSheetMapping, type: OrganizationType): SingleSheetTarget[] {
	const active = activeSheets(mapping, type);
	return singleSheetTargets(type).filter(
		(t) =>
			t.required && active.has(t.sheet) && mapping.columns[t.id] === undefined && !(t.constantAllowed && filled(mapping.constants[t.id]))
	);
}

/** Valeurs communes retenues : seulement pour un champ qui en accepte une ; les autres sont ignorées. */
function allowedConstants(mapping: SingleSheetMapping, type: OrganizationType): Record<SingleSheetTargetId, string> {
	const allowed = new Set(
		singleSheetTargets(type)
			.filter((t) => t.constantAllowed)
			.map((t) => t.id)
	);
	return Object.fromEntries(Object.entries(mapping.constants).filter(([id, v]) => allowed.has(id) && filled(v)));
}

/**
 * Correspondance proposée d'après les en-têtes (mêmes règles que le modèle : sans accents ni casse, en-têtes courants
 * des registres). Une colonne qui pourrait servir deux champs différents (« Contact » : téléphone du propriétaire ou du
 * locataire) n'est pas proposée : la personne choisit. Le loyer et les charges valent pour l'unité et pour le bail.
 */
export function suggestSingleSheetMapping(headers: readonly CellValue[], type: OrganizationType): Record<SingleSheetTargetId, number> {
	const targets = new Set(singleSheetTargets(type).map((t) => t.id));
	const byColumn = new Map<number, string[]>();
	for (const def of importTemplate(type)) {
		for (const [field, col] of Object.entries(matchImportColumns(headers, def).columns)) {
			const id = `${def.key}.${field}`;
			if (targets.has(id)) byColumn.set(col, [...(byColumn.get(col) ?? []), id]);
		}
	}
	const out: Record<SingleSheetTargetId, number> = {};
	for (const [col, ids] of byColumn) {
		if (ids.length === 1 || SHARED_COLUMNS.some((g) => ids.every((id) => g.has(id)))) for (const id of ids) out[id] = col;
	}
	return out;
}

export interface FileSheetPreview {
	name: string;
	headers: string[];
	/** Trois premières lignes remplies, textes courts : pour reconnaître chaque colonne. */
	samples: string[][];
	/** Lignes remplies, en-tête exclu. */
	rows: number;
	suggested: Record<SingleSheetTargetId, number>;
}

const MAX_COLUMNS = 60;
const SAMPLE_LENGTH = 40;
const isBlank = (v: CellValue | undefined) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export function fileSheetPreview(
	sheet: { sheet: string; data: readonly (readonly CellValue[])[] },
	type: OrganizationType
): FileSheetPreview {
	const headerRow = (sheet.data[0] ?? []).slice(0, MAX_COLUMNS);
	const width = Math.min(MAX_COLUMNS, Math.max(headerRow.length, ...sheet.data.slice(1, 50).map((r) => r.length)));
	const headers = Array.from({ length: width }, (_, i) => (importText(headerRow[i]) ?? '').slice(0, 80));
	const filledRows = sheet.data.slice(1).filter((r) => !r.every(isBlank));
	return {
		name: sheet.sheet,
		headers,
		samples: filledRows.slice(0, 3).map((r) => Array.from({ length: width }, (_, i) => (importText(r[i]) ?? '').slice(0, SAMPLE_LENGTH))),
		rows: filledRows.length,
		suggested: suggestSingleSheetMapping(headerRow, type)
	};
}

/** Nom de colonne d'Excel (A, B… AA) pour une colonne sans en-tête. */
function columnLetter(index: number): string {
	let n = index + 1;
	let out = '';
	while (n > 0) {
		const r = (n - 1) % 26;
		out = String.fromCharCode(65 + r) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}

const REF_LENGTH = 34;

/** La feuille répartie dans les onglets du modèle, et la réécriture des messages du plan. */
export function singleSheetImport(
	sheet: { sheet: string; data: readonly (readonly CellValue[])[] },
	mapping: SingleSheetMapping,
	type: OrganizationType
): { sheets: Partial<Record<ImportSheetKey, ImportSheetInput>>; relabel: (issues: readonly ImportIssue[]) => ImportIssue[] } {
	const defs = new Map<ImportSheetKey, ImportSheetDefinition>(importTemplate(type).map((d) => [d.key, d]));
	const active = activeSheets(mapping, type);
	const data = sheet.data;
	const constants = allowedConstants(mapping, type);
	const get = (row: readonly CellValue[], id: string): CellValue => {
		const col = mapping.columns[id];
		if (col !== undefined) return row[col] ?? null;
		const constant = constants[id];
		return constant === undefined ? null : constant.trim();
	};
	const text = (row: readonly CellValue[], id: string) => importText(get(row, id)) ?? '';
	const phoneKey = (row: readonly CellValue[], id: string) => {
		const cell = get(row, id);
		const p = parseImportPhone(cell);
		return 'value' in p && p.value ? p.value : String(importText(cell) ?? '').replace(/\D/g, '');
	};

	const out = new Map<ImportSheetKey, CellValue[][]>();
	for (const key of IMPORT_SHEET_KEYS) {
		const def = defs.get(key);
		if (!def || !active.has(key)) continue;
		out.set(key, [def.fields.map((f) => f.header), ...data.slice(1).map(() => [] as CellValue[])]);
	}
	const put = (key: ImportSheetKey, index: number, row: readonly CellValue[], generated: Record<string, string>) => {
		const def = defs.get(key)!;
		out.get(key)![index] = def.fields.map((f) => (f.key in generated ? generated[f.key]! : get(row, `${key}.${f.key}`)));
	};

	// Références lisibles (le nom, raccourci), uniques par onglet.
	const used = new Map<ImportSheetKey, Set<string>>();
	const makeRef = (key: ImportSheetKey, base: string, index: number) => {
		const set = used.get(key) ?? new Set<string>();
		used.set(key, set);
		const stem = (base || `ligne ${index + 1}`).slice(0, REF_LENGTH);
		let ref = stem;
		for (let n = 2; set.has(labelKey(ref)); n++) ref = `${stem} (${n})`;
		set.add(labelKey(ref));
		return ref;
	};
	const owners = new Map<string, string>();
	const properties = new Map<string, string>();
	const units = new Map<string, string>();
	const tenants = new Map<string, string>();

	data.forEach((row, index) => {
		if (index === 0 || row.every(isBlank)) return;
		// Propriétaire (agence) : même nom et même téléphone.
		let ownerKey = '';
		let ownerRef = '';
		if (active.has('owners')) {
			const name = text(row, 'owners.name');
			if (name) {
				ownerKey = `${labelKey(name)}|${phoneKey(row, 'owners.phone')}`;
				if (!owners.has(ownerKey)) {
					owners.set(ownerKey, makeRef('owners', name, index));
					put('owners', index, row, { ref: owners.get(ownerKey)! });
				}
				ownerRef = owners.get(ownerKey)!;
			}
		}
		// Bien : même propriétaire et même nom.
		const propertyName = text(row, 'properties.name');
		const propertyKey = propertyName ? `${ownerKey}|${labelKey(propertyName)}` : `ligne:${index}`;
		if (!properties.has(propertyKey)) {
			properties.set(propertyKey, propertyName ? makeRef('properties', propertyName, index) : '');
			put('properties', index, row, { ref: properties.get(propertyKey)!, ownerRef });
		}
		const propertyRef = properties.get(propertyKey)!;
		// Unité : même bien et même libellé.
		const label = text(row, 'units.label');
		const unitKey = label && propertyRef ? `${propertyKey}|${labelKey(label)}` : `ligne:${index}`;
		if (!units.has(unitKey)) {
			units.set(unitKey, label ? makeRef('units', label, index) : '');
			put('units', index, row, { ref: units.get(unitKey)!, propertyRef });
		}
		const unitRef = units.get(unitKey)!;
		// Locataire, bail, caution, solde : seulement sur une ligne qui nomme un locataire.
		if (!active.has('tenants')) return;
		const tenantName = text(row, 'tenants.fullName');
		if (!tenantName) return;
		const tenantKey = `${labelKey(tenantName)}|${phoneKey(row, 'tenants.phone')}`;
		if (!tenants.has(tenantKey)) {
			tenants.set(tenantKey, makeRef('tenants', tenantName, index));
			put('tenants', index, row, { ref: tenants.get(tenantKey)! });
		}
		put('leases', index, row, { ref: '', unitRef, tenant: tenants.get(tenantKey)! });
		if (active.has('deposits') && !isBlank(get(row, 'deposits.agreedAmount'))) put('deposits', index, row, { lease: unitRef });
		if (active.has('opening_balances') && !isBlank(get(row, 'opening_balances.amount')))
			put('opening_balances', index, row, { lease: unitRef });
	});

	const sheets: Partial<Record<ImportSheetKey, ImportSheetInput>> = {};
	for (const [key, rows] of out) {
		sheets[key] = { key, rows, columns: Object.fromEntries(defs.get(key)!.fields.map((f, i) => [f.key, i])) };
	}

	// Messages : la feuille et la colonne du fichier, ou la valeur commune.
	const headerRow = data[0] ?? [];
	const sourceOf = (id: string): string | null => {
		const target = GENERATED_SOURCE[id] ?? id;
		const col = mapping.columns[target];
		if (col !== undefined) return importText(headerRow[col]) ?? columnLetter(col);
		if (constants[target] !== undefined) {
			const [k, f] = target.split('.') as [ImportSheetKey, string];
			return `valeur commune « ${defs.get(k)?.fields.find((x) => x.key === f)?.header ?? f} »`;
		}
		return null;
	};
	const sheetNames = new Set(Object.values(IMPORT_SHEET_NAMES));
	const relabel = (issues: readonly ImportIssue[]): ImportIssue[] =>
		issues.map((i) => {
			let message = i.message;
			const head = `Ligne ${i.row} de ${IMPORT_SHEET_NAMES[i.sheet]}`;
			if (message.startsWith(head)) message = `Ligne ${i.row} de ${sheet.sheet}${message.slice(head.length)}`;
			let column = i.column;
			const source = i.field ? sourceOf(`${i.sheet}.${i.field}`) : null;
			const old = i.column ? `, colonne ${i.column} :` : null;
			if (source && old && message.includes(old)) {
				message = message.replace(old, source.startsWith('valeur commune') ? `, ${source} :` : `, colonne ${source} :`);
				column = source;
			}
			message = message.replace(/\(([^(),]+), ligne (\d+)\)/g, (all, name: string, n: string) =>
				sheetNames.has(name) ? `(ligne ${n})` : all
			);
			return { ...i, message, column };
		});
	return { sheets, relabel };
}
