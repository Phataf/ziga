/**
 * Import Excel (lot 11, module imports) : service public du module, utilisé par ses routes (dans la transaction de la
 * requête, `RequestContext.tx()`) et par sa tâche de fond (`ImportExecutor`, `jobs/imports.processor.ts`).
 *
 * - La requête HTTP ne lit jamais le fichier : elle enregistre l'import, signe l'envoi direct vers le stockage, puis
 *   met la lecture, l'analyse, l'exécution et l'annulation en file (tâche de fond).
 * - Le module n'écrit que dans sa table `import_jobs` ; tout le reste passe par les services publics des modules
 *   (CLAUDE.md §4, test d'architecture), avec leurs règles, leurs déclencheurs et leur audit.
 * - Permission `import.run` (direction et gestion) et interrupteur `imports.excel`, vérifiés par les gardes des routes ;
 *   la tâche de fond revérifie que la personne est toujours membre active.
 */
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { toIsoDate } from '@ziga/shared/dates';
import {
	importCancellable,
	IMPORT_CANCEL_HOURS,
	planImport,
	switchDateIssue,
	type ImportContext,
	type ImportPlan
} from '@ziga/shared/import-plan';
import {
	importSheet,
	IMPORT_SHEET_KEYS,
	workbookImportSheets,
	type ImportSheetInput,
	type ImportSheetKey
} from '@ziga/shared/import-template';
import {
	IMPORT_MIME_TYPES,
	type AnalyzeImportData,
	type CreateImportData,
	type ImportChoices,
	type ImportJobView,
	type ImportPreview,
	type ImportReportView,
	type ImportSheetOutcome
} from '@ziga/shared/imports';
import type { RentBillingMode } from '@ziga/shared/rent-schedule';
import type { Queue } from 'bullmq';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import { importJobs } from '../../db/schema/imports.js';
import { IMPORT_ANALYZE_JOB, IMPORT_CANCEL_JOB, IMPORT_EXECUTE_JOB, IMPORTS_QUEUE, type ImportJobData } from '../../jobs/queues.js';
import { STORAGE, type PresignedUpload, type StorageAdapter } from '../../storage/storage.js';
import { AuditService } from '../audit/audit.service.js';
import { QuotasService } from '../features/quotas.service.js';
import { LeasesService } from '../leases/leases.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { OwnersService } from '../owners/owners.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { GeographyService } from '../properties/geography.service.js';
import { PropertiesService } from '../properties/properties.service.js';
import type { ReadSheet } from './spreadsheet-reader.js';
import { writeImportTemplate } from './workbooks.js';

export type ImportJobRow = typeof importJobs.$inferSelect;

/** Compte rendu d'un onglet exécuté, gardé dans `import_jobs.report` (validé avec l'onglet, dans sa transaction). */
export interface SheetReport {
	status: ImportSheetOutcome;
	created: number;
	message: string | null;
	/** Référence du plan → identifiant (fiche créée ou existante), pour les onglets suivants et un rejeu. */
	ids: Record<string, string>;
	/** Lignes créées par l'import (jamais une fiche existante rattachée) : ce que l'annulation archive. */
	createdIds: string[];
	/** Mandats créés avec les biens. */
	mandateIds?: string[];
	rows: { row: number; label: string }[];
	/** Ligne en cours quand l'onglet a échoué. */
	failedRow?: number | null;
}

export interface StoredReport {
	sheets: Partial<Record<ImportSheetKey, SheetReport>>;
	fileKey: string | null;
}

const NOT_FOUND = () => new AppError('IMPORT_NOT_FOUND', 'Import introuvable.', 404);
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

@Injectable()
export class ImportsService {
	constructor(
		private readonly audit: AuditService,
		private readonly owners: OwnersService,
		private readonly properties: PropertiesService,
		private readonly geography: GeographyService,
		private readonly leases: LeasesService,
		private readonly organizations: OrganizationsService,
		private readonly payments: PaymentsService,
		private readonly quotas: QuotasService,
		@Inject(STORAGE) private readonly storage: StorageAdapter,
		@InjectQueue(IMPORTS_QUEUE) private readonly queue: Queue
	) {}

	private context() {
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		return {
			tx: RequestContext.tx(),
			organizationId: scope.organizationId,
			organizationType: scope.organizationType,
			planId: scope.planId,
			userId,
			actor: { type: 'user' as const, userId, role: scope.role }
		};
	}

	async row(id: string, lock = false, tx: Tx = RequestContext.tx()): Promise<ImportJobRow> {
		const { organizationId } = this.context();
		const q = tx
			.select()
			.from(importJobs)
			.where(and(eq(importJobs.organizationId, organizationId), eq(importJobs.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw NOT_FOUND();
		return row;
	}

	view(row: ImportJobRow): ImportJobView {
		const report = row.report as StoredReport | null;
		const completedAt = iso(row.completedAt);
		return {
			id: row.id,
			status: row.status,
			fileName: row.fileName,
			fileFormat: row.fileFormat,
			switchOn: row.switchOn,
			createdAt: row.createdAt.toISOString(),
			createdBy: row.createdBy,
			startedAt: iso(row.startedAt),
			completedAt,
			cancelledAt: iso(row.cancelledAt),
			cancellationReason: row.cancellationReason,
			error: row.error,
			fileDeletedAt: iso(row.fileDeletedAt),
			cancellableUntil:
				completedAt && importCancellable({ status: row.status, completedAt }, new Date())
					? new Date(Date.parse(completedAt) + IMPORT_CANCEL_HOURS * 3_600_000).toISOString()
					: null,
			choices: (row.choices ?? {}) as ImportChoices,
			preview: (row.preview as unknown as ImportPreview | null) ?? null,
			report: report ? reportView(report) : null
		};
	}

	async list(): Promise<ImportJobView[]> {
		const { tx, organizationId } = this.context();
		const rows = await tx
			.select()
			.from(importJobs)
			.where(eq(importJobs.organizationId, organizationId))
			.orderBy(desc(importJobs.createdAt))
			.limit(50);
		return rows.map((r) => this.view(r));
	}

	async get(id: string): Promise<ImportJobView> {
		return this.view(await this.row(id));
	}

	/** Modèle téléchargeable, aux onglets du type d'organisation, avec les quartiers du référentiel. */
	async template(): Promise<Buffer> {
		const { tx, organizationType } = this.context();
		const [communes, neighborhoods] = await Promise.all([this.geography.communes(tx), this.geography.neighborhoods(tx)]);
		return writeImportTemplate(organizationType, { communes, neighborhoods });
	}

	private async checkSwitchOn(switchOn: string): Promise<void> {
		const issue = switchDateIssue(switchOn, toIsoDate(), (await this.organizations.rentBillingMode()) as RentBillingMode);
		if (issue) throw new AppError(issue.code, issue.message, 400);
	}

	/** Import enregistré « envoyé » ; l'appareil envoie le fichier directement au stockage, par l'URL signée. */
	async create(input: CreateImportData): Promise<{ job: ImportJobView; upload: PresignedUpload }> {
		const c = this.context();
		await this.checkSwitchOn(input.switchOn);
		const exists = await c.tx.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.id, input.id)).limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Cet import existe déjà.', 409);
		const storageKey = `imports/${c.organizationId}/${input.id}/original.${input.fileFormat}`;
		const [row] = await c.tx
			.insert(importJobs)
			.values({
				id: input.id,
				organizationId: c.organizationId,
				createdBy: c.userId,
				status: 'uploaded',
				fileName: input.fileName,
				fileFormat: input.fileFormat,
				fileSize: input.fileSize,
				storageKey,
				// Posée par la base (création + 90 jours) ; valeur provisoire exigée par le schéma.
				fileExpiresAt: new Date(),
				switchOn: input.switchOn
			})
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'import.create',
			objectType: 'import_job',
			objectId: input.id,
			after: { fileName: input.fileName, fileFormat: input.fileFormat, fileSize: input.fileSize, switchOn: input.switchOn }
		});
		const upload = await this.storage.presignPut(storageKey, {
			contentType: IMPORT_MIME_TYPES[input.fileFormat],
			contentLength: input.fileSize,
			expiresInSeconds: 15 * 60
		});
		return { job: this.view(row!), upload };
	}

	private enqueue(name: string, data: ImportJobData): void {
		RequestContext.afterCommit(async () => {
			await this.queue.add(name, data);
		});
	}

	/** Analyse (ou nouvelle analyse après un choix) : en file ; la prévisualisation arrive avec l'état « analysé ». */
	async requestAnalysis(id: string, input: AnalyzeImportData): Promise<ImportJobView> {
		const c = this.context();
		const row = await this.row(id, true);
		if (!['uploaded', 'analyzed', 'analysis_failed'].includes(row.status)) {
			throw new AppError('IMPORT_STATUS', 'Cet import est déjà en cours d’analyse ou d’exécution.', 409, { status: row.status });
		}
		if (row.fileDeletedAt) throw new AppError('IMPORT_FILE_DELETED', 'Le fichier de cet import a été effacé : envoyez-le de nouveau.', 409);
		const stat = await this.storage.stat(row.storageKey);
		if (!stat || stat.size !== row.fileSize) {
			throw new AppError('IMPORT_FILE_MISSING', 'Le fichier n’a pas encore été envoyé en entier : recommencez l’envoi.', 409);
		}
		if (input.switchOn) await this.checkSwitchOn(input.switchOn);
		const choices = input.choices ?? ((row.choices ?? {}) as ImportChoices);
		const mapping = input.mapping ?? row.mapping;
		const [updated] = await c.tx
			.update(importJobs)
			.set({ status: 'analyzing', switchOn: input.switchOn ?? row.switchOn, choices, mapping, error: null })
			.where(and(eq(importJobs.organizationId, c.organizationId), eq(importJobs.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'import.analyze',
			objectType: 'import_job',
			objectId: id,
			after: { switchOn: updated!.switchOn, choices }
		});
		this.enqueue(IMPORT_ANALYZE_JOB, { organizationId: c.organizationId, importJobId: id, userId: c.userId });
		return this.view(updated!);
	}

	/**
	 * Exécution : seulement après une prévisualisation sans blocage (choix faits, date de bascule acceptée), et dans le
	 * quota d'unités de la formule, vérifié avant que rien ne soit créé (prompt §5).
	 */
	async requestExecution(id: string): Promise<ImportJobView> {
		const c = this.context();
		const row = await this.row(id, true);
		if (row.fileDeletedAt) throw new AppError('IMPORT_FILE_DELETED', 'Le fichier de cet import a été effacé : envoyez-le de nouveau.', 409);
		if (row.status !== 'analyzed' || !row.preview) {
			throw new AppError('IMPORT_NOT_ANALYZED', 'Lancez d’abord l’analyse du fichier et vérifiez la prévisualisation.', 409, {
				status: row.status
			});
		}
		const preview = row.preview as unknown as ImportPreview;
		if (preview.blockers.length) {
			throw new AppError('IMPORT_BLOCKED', preview.blockers.map((b) => b.message).join(' '), 409, { blockers: preview.blockers });
		}
		await this.assertUnitQuota(preview.summary.newUnits);
		const [updated] = await c.tx
			.update(importJobs)
			.set({ status: 'running', startedAt: new Date() })
			.where(and(eq(importJobs.organizationId, c.organizationId), eq(importJobs.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'import.execute',
			objectType: 'import_job',
			objectId: id,
			after: { summary: preview.summary }
		});
		this.enqueue(IMPORT_EXECUTE_JOB, { organizationId: c.organizationId, importJobId: id, userId: c.userId });
		return this.view(updated!);
	}

	/** Quota d'unités (prompt §5) : refus clair, avant toute exécution, si l'import le dépasse. */
	async assertUnitQuota(newUnits: number): Promise<void> {
		const c = this.context();
		if (!newUnits) return;
		const used = await this.properties.unitQuotaUsage();
		const { limit } = await this.quotas.check(c.organizationId, c.planId, 'units', used);
		if (limit !== null && used + newUnits > limit) {
			throw new AppError(
				'QUOTA_EXCEEDED',
				`Cet import ajoute ${plural(newUnits, 'unité', 'unités')} ; votre formule en permet ${limit} (${used} déjà ${used > 1 ? 'utilisées' : 'utilisée'}). Passez à une formule supérieure ou contactez Ziga.`,
				403,
				{ quota: 'units', limit, used, newUnits }
			);
		}
	}

	/** Rapport final téléchargeable (classeur neutralisé), par une URL signée de courte durée ; journalisé. */
	async reportUrl(id: string): Promise<{ url: string; expiresInSeconds: number }> {
		const c = this.context();
		const row = await this.row(id);
		const report = row.report as StoredReport | null;
		if (!report?.fileKey) throw new AppError('IMPORT_REPORT_NOT_READY', 'Le rapport sera prêt à la fin de l’import.', 409);
		const expiresInSeconds = 300;
		const url = await this.storage.presignGet(report.fileKey, {
			expiresInSeconds,
			fileName: `rapport-import-${row.createdAt.toISOString().slice(0, 10)}.xlsx`,
			contentType: IMPORT_MIME_TYPES.xlsx
		});
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'import.report_download',
			objectType: 'import_job',
			objectId: id
		});
		return { url, expiresInSeconds };
	}

	/** Annulation dans les 24 heures, sans encaissement depuis (prompt §4) : vérifiée ici, faite en tâche de fond. */
	async requestCancellation(id: string, reason: string): Promise<ImportJobView> {
		const c = this.context();
		const row = await this.row(id, true);
		if (row.status !== 'completed' || !row.completedAt) {
			throw new AppError('IMPORT_NOT_COMPLETED', 'Seul un import terminé s’annule.', 409, { status: row.status });
		}
		if (!importCancellable({ status: row.status, completedAt: row.completedAt.toISOString() }, new Date())) {
			throw new AppError('IMPORT_CANCEL_EXPIRED', 'Un import ne s’annule que dans les 24 heures.', 409);
		}
		const leaseIds = (row.report as StoredReport | null)?.sheets.leases?.createdIds ?? [];
		if (await this.payments.anyPaymentOn(c.tx, leaseIds)) {
			throw new AppError(
				'IMPORT_CANCEL_PAYMENTS',
				'Un encaissement a été enregistré sur un bail de cet import : il ne s’annule plus.',
				409
			);
		}
		this.enqueue(IMPORT_CANCEL_JOB, { organizationId: c.organizationId, importJobId: id, userId: c.userId, reason });
		return this.view(row);
	}

	// ---------------------------------------------------------------- tâche de fond (dans le contexte de l'organisation)

	/** Ce qui existe déjà dans l'organisation : fiches à rapprocher, référentiel des quartiers, découpage des loyers. */
	async planContext(switchOn: string, choices: ImportChoices): Promise<ImportContext> {
		const { tx, organizationType } = this.context();
		const [owners, tenants, communes, neighborhoods, billingMode] = await Promise.all([
			organizationType === 'agency' ? this.owners.list() : Promise.resolve([]),
			this.leases.tenantsForImport(),
			this.geography.communes(tx),
			this.geography.neighborhoods(tx),
			this.organizations.rentBillingMode()
		]);
		return {
			organizationType,
			switchOn,
			today: toIsoDate(),
			billingMode: billingMode as RentBillingMode,
			existing: {
				owners: owners.map((o) => ({ id: o.id, name: o.name, phone: o.phone })),
				tenants,
				communes,
				neighborhoods
			},
			choices: { places: choices.places ?? {}, matches: choices.matches ?? {}, depositReceived: choices.depositReceived }
		};
	}

	/** Onglets lus → onglets à importer (correspondance automatique, sauf correspondance choisie à la main) et plan. */
	async plan(row: ImportJobRow, book: ReadSheet[]): Promise<{ plan: ImportPlan; read: ReturnType<typeof workbookImportSheets> }> {
		const { organizationType } = this.context();
		const read = workbookImportSheets(book, organizationType);
		const mapping = (row.mapping ?? {}) as Partial<Record<ImportSheetKey, Record<string, number>>>;
		for (const key of IMPORT_SHEET_KEYS) {
			const sheet = read.sheets[key];
			if (sheet && mapping[key]) read.sheets[key] = { ...sheet, columns: mapping[key] } satisfies ImportSheetInput;
		}
		const plan = planImport(read.sheets, await this.planContext(row.switchOn, (row.choices ?? {}) as ImportChoices));
		return { plan, read };
	}

	async finishAnalysis(id: string, book: ReadSheet[]): Promise<void> {
		const c = this.context();
		const row = await this.row(id, true);
		if (row.status !== 'analyzing') return;
		const { plan, read } = await this.plan(row, book);
		const preview = previewOf(plan, read, c.organizationType);
		await c.tx
			.update(importJobs)
			.set({ status: 'analyzed', preview: preview as unknown as Record<string, unknown>, error: null })
			.where(and(eq(importJobs.organizationId, c.organizationId), eq(importJobs.id, id)));
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'import.analyzed',
			objectType: 'import_job',
			objectId: id,
			after: {
				summary: plan.summary,
				blockers: plan.blockers.map((b) => b.code),
				errors: plan.issues.filter((i) => i.severity === 'error').length
			}
		});
	}

	async failAnalysis(id: string, message: string): Promise<void> {
		const c = this.context();
		const row = await this.row(id, true);
		if (row.status !== 'analyzing') return;
		await c.tx
			.update(importJobs)
			.set({ status: 'analysis_failed', preview: null, error: message })
			.where(and(eq(importJobs.organizationId, c.organizationId), eq(importJobs.id, id)));
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'import.analysis_failed',
			objectType: 'import_job',
			objectId: id,
			after: { error: message }
		});
	}

	/** Compte rendu de l'exécution, enregistré dans la transaction de l'onglet (rejeu : onglets validés sautés). */
	async saveReport(id: string, report: StoredReport): Promise<void> {
		const { tx, organizationId } = this.context();
		await tx
			.update(importJobs)
			.set({ report: report as unknown as Record<string, unknown> })
			.where(and(eq(importJobs.organizationId, organizationId), eq(importJobs.id, id)));
	}

	async complete(id: string, report: StoredReport): Promise<void> {
		const c = this.context();
		await c.tx
			.update(importJobs)
			.set({ status: 'completed', completedAt: sql`now()` as unknown as Date, report: report as unknown as Record<string, unknown> })
			.where(and(eq(importJobs.organizationId, c.organizationId), eq(importJobs.id, id)));
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'import.complete',
			objectType: 'import_job',
			objectId: id,
			after: Object.fromEntries(Object.entries(report.sheets).map(([k, s]) => [k, { status: s!.status, created: s!.created }]))
		});
	}

	async fail(id: string, message: string): Promise<void> {
		const c = this.context();
		const row = await this.row(id, true);
		if (row.status !== 'running') return;
		await c.tx
			.update(importJobs)
			.set({ status: 'failed', error: message })
			.where(and(eq(importJobs.organizationId, c.organizationId), eq(importJobs.id, id)));
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'import.failed',
			objectType: 'import_job',
			objectId: id,
			after: { error: message }
		});
	}

	/** Annulation : l'import passe « annulé » dans la transaction même qui archive et contre-passe ce qu'il a créé. */
	async markCancelled(id: string, reason: string): Promise<ImportJobRow | null> {
		const c = this.context();
		const row = await this.row(id, true);
		if (row.status !== 'completed') return null;
		const [updated] = await c.tx
			.update(importJobs)
			.set({
				status: 'cancelled',
				cancelledAt: sql`now()` as unknown as Date,
				cancelledBy: c.userId,
				cancellationReason: reason
			})
			.where(and(eq(importJobs.organizationId, c.organizationId), eq(importJobs.id, id)))
			.returning();
		return updated!;
	}

	async recordCancelled(id: string, reason: string, counts: Record<string, number>): Promise<void> {
		const c = this.context();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'import.cancel',
			objectType: 'import_job',
			objectId: id,
			after: { reason, ...counts }
		});
	}

	/** Contexte d'import de la transaction : la base marque chaque ligne créée de l'identifiant de l'import. */
	async enterImport(id: string): Promise<void> {
		await RequestContext.tx().execute(sql`select set_config('app.import_job_id', ${id}, true)`);
	}
}

function reportView(report: StoredReport): ImportReportView {
	const sheets: ImportReportView['sheets'] = {};
	for (const key of IMPORT_SHEET_KEYS) {
		const s = report.sheets[key];
		if (s) sheets[key] = { status: s.status, created: s.created, message: s.message };
	}
	return { sheets, file: !!report.fileKey };
}

function plannedCount(plan: ImportPlan, key: ImportSheetKey): number {
	return {
		owners: plan.owners.length,
		properties: plan.properties.length,
		units: plan.units.length,
		tenants: plan.tenants.length,
		leases: plan.leases.length,
		deposits: plan.deposits.length,
		opening_balances: plan.openingBalances.length
	}[key];
}

export function previewOf(plan: ImportPlan, read: ReturnType<typeof workbookImportSheets>, type: 'agency' | 'landlord'): ImportPreview {
	return {
		sheets: IMPORT_SHEET_KEYS.flatMap((key) => {
			const sheet = read.sheets[key];
			if (!sheet) return [];
			const def = importSheet(key, type);
			const issues = plan.issues.filter((i) => i.sheet === key);
			return [
				{
					key,
					name: def.name,
					rows: sheet.rows.slice(1).filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== '')).length,
					columns: Object.entries(sheet.columns).map(([field, index]) => ({
						field,
						header: def.fields.find((f) => f.key === field)?.header ?? field,
						index
					})),
					planned: plannedCount(plan, key),
					errors: issues.filter((i) => i.severity === 'error').length,
					skipped: issues.filter((i) => i.severity === 'skipped').length,
					warnings: issues.filter((i) => i.severity === 'warning').length
				}
			];
		}),
		unknownSheets: read.unknownSheets,
		columnIssues: read.columnIssues,
		issues: plan.issues,
		blockers: plan.blockers,
		pending: plan.pending,
		places: plan.places,
		matches: plan.matches,
		summary: plan.summary
	};
}
