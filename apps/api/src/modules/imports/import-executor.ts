/**
 * Import Excel (lot 11) : la partie « tâche de fond », appelée par `jobs/imports.processor.ts`, dans le contexte de
 * l'organisation et de la personne qui a lancé l'action (membre actif revérifié ; journal d'origine `import`).
 *
 * - Lecture : le fichier est lu hors de toute transaction, dans un fil à part et sous limites (`spreadsheet-reader`).
 * - Exécution : une transaction par onglet (prompt §2.4), dans l'ordre des dépendances. Chaque transaction pose le
 *   contexte d'import (`app.import_job_id`) : la base marque chaque ligne créée et son journal. Les écritures passent
 *   par les services publics des modules (CLAUDE.md §4), avec leurs règles, déclencheurs et audit ; jamais de SQL sur
 *   leurs tables. Le compte rendu de l'onglet est enregistré dans la même transaction : rejouée par BullMQ, la tâche
 *   saute les onglets déjà validés (aucun doublon).
 * - Les lignes en erreur ont été écartées par le plan, avec ce qui en dépend. Un refus imprévu d'un service (règle
 *   métier, déclencheur) annule tout l'onglet (rien de lui), et les onglets qui en dépendent ne s'exécutent pas ; une
 *   panne (base injoignable…) remonte, et la tâche est rejouée.
 * - Annulation : une seule transaction, qui passe l'import « annulé » puis annule, archive et contre-passe ce qu'il a
 *   créé (jamais une suppression).
 */
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@ziga/shared/ids';
import type { ImportPlan } from '@ziga/shared/import-plan';
import { IMPORT_SHEET_NAMES, type ImportSheetKey } from '@ziga/shared/import-template';
import type { ImportIssue } from '@ziga/shared/import-rows';
import { createDepositAccountSchema, createLeaseSchema, createTenantSchema } from '@ziga/shared/leases';
import { createMandateSchema, createOwnerSchema } from '@ziga/shared/owners';
import { createPropertySchema, createUnitSchema } from '@ziga/shared/properties';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { fromDatabaseError } from '../../common/db-errors.js';
import { RequestContext } from '../../common/request-context.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../db/database.module.js';
import { importJobs } from '../../db/schema/imports.js';
import { STORAGE, type StorageAdapter } from '../../storage/storage.js';
import { AuditService } from '../audit/audit.service.js';
import { LeasesService } from '../leases/leases.service.js';
import { requireMembership, runInOrganization } from '../organizations/organization-context.js';
import { OwnersService } from '../owners/owners.service.js';
import { PropertiesService } from '../properties/properties.service.js';
import { ImportsService, type ImportJobRow, type SheetReport, type StoredReport } from './imports.service.js';
import { DEFAULT_IMPORT_LIMITS, ImportFileError, readSpreadsheet, type ImportLimits, type ReadSheet } from './spreadsheet-reader.js';
import { writeImportReport } from './workbooks.js';

/** Onglets dans l'ordre d'exécution, et ceux dont ils dépendent. */
const ORDER: ImportSheetKey[] = ['owners', 'properties', 'units', 'tenants', 'leases', 'deposits', 'opening_balances'];
const DEPENDS: Record<ImportSheetKey, ImportSheetKey[]> = {
	owners: [],
	properties: ['owners'],
	units: ['properties'],
	tenants: [],
	leases: ['units', 'tenants'],
	deposits: ['leases'],
	opening_balances: ['leases']
};

/** Refus métier (service, règle de la base) : l'onglet échoue ; toute autre erreur est une panne, rejouée. */
function businessError(error: unknown): AppError | null {
	if (error instanceof AppError) return error;
	const mapped = fromDatabaseError(error);
	if (mapped && mapped.code !== 'FORBIDDEN') return mapped;
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current; depth += 1) {
		const code = (current as { code?: string }).code;
		if (code === 'P0001' || (typeof code === 'string' && code.startsWith('23'))) {
			return new AppError('IMPORT_ROW_REFUSED', (current as Error).message.replace(/^[A-Z_]+: /, ''), 409);
		}
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}

@Injectable()
export class ImportExecutor {
	constructor(
		private readonly database: DatabaseService,
		private readonly imports: ImportsService,
		private readonly owners: OwnersService,
		private readonly properties: PropertiesService,
		private readonly leases: LeasesService,
		private readonly audit: AuditService,
		@Inject(STORAGE) private readonly storage: StorageAdapter,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {}

	private get limits(): ImportLimits {
		return {
			...DEFAULT_IMPORT_LIMITS,
			maxUncompressedBytes: this.config.IMPORT_MAX_UNCOMPRESSED_BYTES,
			maxSheets: this.config.IMPORT_MAX_SHEETS,
			maxRows: this.config.IMPORT_MAX_ROWS,
			maxCells: this.config.IMPORT_MAX_CELLS,
			timeoutMs: this.config.IMPORT_ANALYSIS_TIMEOUT_MS
		};
	}

	private async inContext<T>(organizationId: string, userId: string, fn: () => Promise<T>): Promise<T> {
		const scope = await requireMembership(this.database, userId, organizationId);
		return runInOrganization(this.database, scope, userId, fn, 'import');
	}

	private async read(row: ImportJobRow): Promise<ReadSheet[]> {
		const buffer = await this.storage.get(row.storageKey);
		return (await readSpreadsheet(buffer, { format: row.fileFormat, fileName: row.fileName }, this.limits)).sheets;
	}

	/** Lecture et analyse : la prévisualisation, ou l'échec de lecture avec son message. */
	async analyze(organizationId: string, id: string, userId: string): Promise<void> {
		const row = await this.inContext(organizationId, userId, () => this.imports.row(id));
		if (row.status !== 'analyzing') return;
		let book: ReadSheet[];
		try {
			book = await this.read(row);
		} catch (error) {
			if (!(error instanceof ImportFileError)) throw error;
			await this.inContext(organizationId, userId, () => this.imports.failAnalysis(id, error.message));
			return;
		}
		await this.inContext(organizationId, userId, () => this.imports.finishAnalysis(id, book));
	}

	/** Exécution, onglet par onglet ; rejouée, elle reprend après le dernier onglet validé. */
	async execute(organizationId: string, id: string, userId: string): Promise<void> {
		const row = await this.inContext(organizationId, userId, () => this.imports.row(id));
		if (row.status !== 'running') return;
		const book = await this.read(row);
		const { plan, type } = await this.inContext(organizationId, userId, async () => ({
			plan: (await this.imports.plan(row, book)).plan,
			type: RequestContext.organization().organizationType
		}));
		if (plan.blockers.length) {
			await this.inContext(organizationId, userId, () => this.imports.fail(id, plan.blockers.map((b) => b.message).join(' ')));
			return;
		}
		const report: StoredReport = (row.report as StoredReport | null) ?? { sheets: {}, fileKey: null };
		for (const key of ORDER) {
			if (key === 'owners' && type === 'landlord') continue;
			if (report.sheets[key]?.status === 'done') continue;
			const blocked = DEPENDS[key].find((d) => !(d === 'owners' && type === 'landlord') && report.sheets[d]?.status !== 'done');
			if (blocked) {
				report.sheets[key] = {
					status: 'not_run',
					created: 0,
					message: `Onglet ${IMPORT_SHEET_NAMES[key]} non exécuté : l’onglet ${IMPORT_SHEET_NAMES[blocked]} n’a pas été importé.`,
					ids: {},
					createdIds: [],
					rows: []
				};
				await this.inContext(organizationId, userId, () => this.imports.saveReport(id, report));
				continue;
			}
			const progress = { row: null as number | null };
			try {
				const result = await this.inContext(organizationId, userId, async () => {
					await this.imports.enterImport(id);
					// Quota revérifié juste avant de créer les unités (une autre création a pu passer depuis la demande).
					if (key === 'units') await this.imports.assertUnitQuota(plan.units.length);
					const sheet = await this.runSheet(key, plan, report, row, progress, type);
					await this.imports.saveReport(id, { ...report, sheets: { ...report.sheets, [key]: sheet } });
					return sheet;
				});
				report.sheets[key] = result;
			} catch (error) {
				const refusal = businessError(error);
				if (!refusal) throw error;
				report.sheets[key] = {
					status: 'failed',
					created: 0,
					message: `Onglet ${IMPORT_SHEET_NAMES[key]} non importé : ${refusal.message}${progress.row ? ` (ligne ${progress.row})` : ''}`,
					ids: {},
					createdIds: [],
					rows: [],
					failedRow: progress.row
				};
				await this.inContext(organizationId, userId, () => this.imports.saveReport(id, report));
			}
		}
		report.fileKey = await this.writeReport(row, plan, report);
		await this.inContext(organizationId, userId, () => this.imports.complete(id, report));
	}

	/** Dernière tentative en échec (panne persistante) : l'import passe « échoué », avec le message. */
	async failExecution(organizationId: string, id: string, userId: string, message: string): Promise<void> {
		await this.inContext(organizationId, userId, () => this.imports.fail(id, message));
	}

	private async writeReport(row: ImportJobRow, plan: ImportPlan, report: StoredReport): Promise<string> {
		const imported = ORDER.flatMap((key) =>
			report.sheets[key]?.status === 'done' ? report.sheets[key]!.rows.map((r) => ({ sheet: key, ...r })) : []
		);
		const failures: ImportIssue[] = ORDER.flatMap((key) => {
			const s = report.sheets[key];
			if (!s || s.status === 'done') return [];
			return [
				{
					sheet: key,
					row: s.failedRow ?? 1,
					field: null,
					column: null,
					severity: s.status === 'failed' ? ('error' as const) : ('skipped' as const),
					code: s.status === 'failed' ? 'SHEET_FAILED' : 'SHEET_NOT_RUN',
					message: s.message ?? '',
					value: null
				}
			];
		});
		const file = await writeImportReport({ imported, issues: [...plan.issues, ...failures] });
		const key = `imports/${row.organizationId}/${row.id}/rapport.xlsx`;
		await this.storage.put(key, file, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
		return key;
	}

	/** Un onglet, dans sa transaction ; `progress.row` dit la ligne en cours, pour le rapport d'un échec. */
	private async runSheet(
		key: ImportSheetKey,
		plan: ImportPlan,
		report: StoredReport,
		row: ImportJobRow,
		progress: { row: number | null },
		type: 'agency' | 'landlord'
	): Promise<SheetReport> {
		const ids: Record<string, string> = {};
		const createdIds: string[] = [];
		const rows: SheetReport['rows'] = [];
		const idsOf = (k: ImportSheetKey) => report.sheets[k]?.ids ?? {};
		const created = (id: string, line: number, label: string) => {
			createdIds.push(id);
			rows.push({ row: line, label });
		};
		const mandateIds: string[] = [];
		switch (key) {
			case 'owners':
				for (const o of plan.owners) {
					progress.row = o.row;
					if (o.existingId) {
						ids[o.ref] = o.existingId;
						continue;
					}
					const id = newId();
					await this.owners.createOwner(createOwnerSchema.parse({ id, ...o.data, country: 'BF' }));
					ids[o.ref] = id;
					created(id, o.row, o.data.name);
				}
				break;
			case 'properties': {
				const owners = idsOf('owners');
				const landlordOwner = type === 'landlord' ? await this.owners.landlordOwnerId() : null;
				for (const p of plan.properties) {
					progress.row = p.row;
					const id = newId();
					await this.properties.createProperty(
						createPropertySchema.parse({ id, ownerId: landlordOwner ?? owners[p.ownerRef!], operation: 'rent', ...p.data })
					);
					if (p.activate) await this.properties.setPropertyStatus(id, 'active');
					ids[p.ref] = id;
					created(id, p.row, p.data.name);
				}
				for (const m of plan.mandates) {
					progress.row = m.rows[0] ?? null;
					const id = newId();
					await this.owners.createMandate(createMandateSchema.parse({ id, ownerId: owners[m.ownerRef], type: m.type, ...m.terms }));
					for (const ref of m.propertyRefs) await this.owners.addScope(id, { id: newId(), propertyId: ids[ref]!, unitId: null });
					mandateIds.push(id);
				}
				break;
			}
			case 'units': {
				const properties = idsOf('properties');
				for (const u of plan.units) {
					progress.row = u.row;
					const id = newId();
					await this.properties.createUnit(
						createUnitSchema.parse({
							id,
							propertyId: properties[u.propertyRef],
							type: u.data.type,
							label: u.data.label,
							rooms: u.data.rooms,
							rent: u.data.rent,
							charges: u.data.charges
						})
					);
					if (u.activate) await this.properties.setUnitStatus(id, 'active');
					if (u.technicalStatus !== 'ready') {
						await this.properties.setTechnicalStatus(id, {
							technicalStatus: u.technicalStatus,
							reason: u.technicalReason,
							expectedOn: null
						});
					}
					ids[u.ref] = id;
					created(id, u.row, u.data.label);
				}
				break;
			}
			case 'tenants':
				for (const t of plan.tenants) {
					progress.row = t.row;
					if (t.existingId) {
						ids[t.key] = t.existingId;
						continue;
					}
					const id = newId();
					await this.leases.createTenant(createTenantSchema.parse({ id, ...t.data }));
					ids[t.key] = id;
					created(id, t.row, t.data.fullName);
				}
				break;
			case 'leases': {
				const units = idsOf('units');
				const tenants = idsOf('tenants');
				for (const l of plan.leases) {
					progress.row = l.row;
					const id = newId();
					await this.leases.createLease(
						createLeaseSchema.parse({ id, unitId: units[l.unitRef], tenantId: tenants[l.tenantKey], validate: true, ...l.terms }),
						{ originalEndsOn: l.originalEndsOn }
					);
					ids[l.ref] = id;
					created(id, l.row, l.ref);
				}
				break;
			}
			case 'deposits': {
				const leases = idsOf('leases');
				for (const d of plan.deposits) {
					progress.row = d.row;
					const id = newId();
					await this.leases.createDepositAccount(
						createDepositAccountSchema.parse({
							id,
							leaseId: leases[d.leaseRef],
							type: d.type,
							agreedAmount: d.agreedAmount,
							agreedMonths: null,
							holder: d.holder
						})
					);
					if (d.receivedAmount && d.receivedOn) {
						await this.leases.importDepositReceipt({ id: newId(), accountId: id, amount: d.receivedAmount, receivedOn: d.receivedOn });
					}
					created(id, d.row, d.leaseRef);
				}
				break;
			}
			case 'opening_balances': {
				const leases = idsOf('leases');
				for (const b of plan.openingBalances) {
					progress.row = b.row;
					const id = newId();
					await this.leases.importOpeningBalance({ id, leaseId: leases[b.leaseRef]!, amount: b.amount, switchOn: row.switchOn });
					created(id, b.row, b.leaseRef);
				}
				break;
			}
		}
		progress.row = null;
		return {
			status: 'done',
			created: createdIds.length,
			message: null,
			ids,
			createdIds,
			rows,
			...(mandateIds.length ? { mandateIds } : {})
		};
	}

	/**
	 * Annulation (prompt §4, réponse 7) : dans une seule transaction, l'import passe « annulé » (la base vérifie les 24
	 * heures et l'absence d'encaissement), puis ses baux sont annulés (échéances abandonnées, cautions contre-passées),
	 * ses unités, biens, locataires et propriétaires archivés, ses mandats révoqués. Les fiches existantes rattachées
	 * par l'import ne sont pas touchées. Rien n'est supprimé.
	 */
	async cancel(organizationId: string, id: string, userId: string, reason: string): Promise<void> {
		await this.inContext(organizationId, userId, async () => {
			const row = await this.imports.markCancelled(id, reason);
			if (!row) return;
			await this.imports.enterImport(id);
			const report = (row.report as StoredReport | null) ?? { sheets: {}, fileKey: null };
			const createdOf = (k: ImportSheetKey) => report.sheets[k]?.createdIds ?? [];
			const motive = `Import annulé : ${reason}`.slice(0, 500);
			for (const leaseId of createdOf('leases')) await this.leases.cancelImportedLease(leaseId, motive);
			for (const unitId of createdOf('units')) await this.properties.setUnitStatus(unitId, 'archived');
			for (const propertyId of createdOf('properties')) await this.properties.setPropertyStatus(propertyId, 'archived');
			for (const mandateId of report.sheets.properties?.mandateIds ?? []) await this.owners.revokeMandate(mandateId, motive);
			for (const tenantId of createdOf('tenants')) await this.leases.archiveTenant(tenantId);
			for (const ownerId of createdOf('owners')) await this.owners.archiveOwner(ownerId);
			await this.imports.recordCancelled(id, reason, {
				leases: createdOf('leases').length,
				units: createdOf('units').length,
				properties: createdOf('properties').length,
				tenants: createdOf('tenants').length,
				owners: createdOf('owners').length
			});
		});
	}

	/**
	 * Fichiers d'origine conservés 90 jours (prompt §4) : effacés du stockage à leur échéance, organisation par
	 * organisation (RLS) ; la ligne de l'import reste, sans sa prévisualisation. Tâche de la plateforme (acteur système).
	 */
	async purgeFiles(now: Date): Promise<number> {
		const due = await this.database.db.execute<{ organization_id: string; id: string }>(
			sql`select organization_id, id from expired_import_files(${now.toISOString()}::timestamptz)`
		);
		let purged = 0;
		for (const { organization_id: organizationId, id } of due.rows) {
			await this.database.withOrganization(organizationId, async (tx) => {
				const [row] = await tx
					.select()
					.from(importJobs)
					.where(and(eq(importJobs.organizationId, organizationId), eq(importJobs.id, id)))
					.for('update');
				if (!row || row.fileDeletedAt) return;
				await this.storage.delete(row.storageKey);
				await tx
					.update(importJobs)
					.set({ fileDeletedAt: new Date(), preview: null })
					.where(and(eq(importJobs.organizationId, organizationId), eq(importJobs.id, id)));
				await this.audit.record(tx, {
					actor: { type: 'system' },
					organizationId,
					action: 'import.file_deleted',
					objectType: 'import_job',
					objectId: id,
					origin: 'job'
				});
				purged += 1;
			});
		}
		return purged;
	}
}
