/**
 * Contrats de bail, versions, modèles et avenants (lot 08 bis, CLAUDE.md règle 17, D20 à D25, D29) : service public
 * du module leases, appelé par ses routes et par la tâche de génération (worker, dans le contexte de l'organisation et
 * de la personne qui l'a demandée). Toute écriture passe par la transaction de l'organisation et écrit sa ligne
 * d'audit ; la base tient en dernier ressort le cycle, le figement, l'ajout seul des versions et la signature.
 *
 * - Modèle : celui de l'organisation s'il est actif (Word déposé, inspecté, sans balise inconnue), sinon celui de la
 *   plateforme (D25), cité par sa version.
 * - Génération (tâche BullMQ) : copie des données à l'émission (D29), valeurs résolues par le catalogue, contrôles,
 *   Word rempli, PDF par Gotenberg, chaque fichier enregistré sous une clé neuve avec son empreinte SHA-256, puis la
 *   version suivante. Un rejeu ne crée jamais une seconde version (numéro attendu).
 * - Figement : aucun blanc, bail inchangé depuis la version, mandat de gestion en vigueur ; signataires posés.
 * - Signature : manuscrite, scan déposé (SignatureProvider) ; le contrat d'un bail en brouillon le valide par la même
 *   fonction que la route de validation ; le contrat d'un avenant l'applique (loyer : LeasesService.changeRent ;
 *   renouvellement : la version suivante du bail). Un refus annule tout le dépôt.
 * - Un bail signé scanné déposé sans contrat généré (assistant du lot 08, anciens baux) devient un contrat
 *   `uploaded_scan` signé, par le même service.
 */
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
	blankFields,
	EXAMPLE_CONTRACT_DATA,
	resolveContractFields,
	type ContractData,
	type ContractTemplateKind,
	type TemplateTagUsage
} from '@ziga/shared/contract-fields';
import {
	canRegenerate,
	contractAlerts,
	contractChecks,
	expectedSigners,
	PLATFORM_TEMPLATES,
	renewalBlocker,
	showDefaultTemplateBanner,
	signatureDatesIssues,
	signatureLabel,
	templateActivationBlocker,
	type AmendmentView,
	type ContractDetailView,
	type ContractParty,
	type ContractSigningInput,
	type ContractTemplateView,
	type ContractUploadData,
	type ContractVersionFields,
	type ContractVersionView,
	type ContractView,
	type CreateAmendmentData,
	type CreateContractData,
	type CreateTemplateData,
	type LegalizationData,
	type RegistrationData,
	type SignedScanData,
	type TemplatesOverview
} from '@ziga/shared/contracts';
import { toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import type { DocumentDownload, DocumentView } from '@ziga/shared/documents';
import type { Queue } from 'bullmq';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { AppError } from '../../../common/app-error.js';
import { RequestContext } from '../../../common/request-context.js';
import type { Tx } from '../../../db/database.js';
import { contractTemplates, contractVersions, leaseAmendments, leaseContracts } from '../../../db/schema/leases.js';
import {
	CONTRACT_GENERATE_JOB,
	CONTRACTS_QUEUE,
	TEMPLATE_PREVIEW_JOB,
	type ContractGenerateJobData,
	type TemplatePreviewJobData
} from '../../../jobs/queues.js';
import type { PresignedUpload } from '../../../storage/storage.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { DocumentsService } from '../../documents/documents.service.js';
import { OrganizationsService } from '../../organizations/organizations.service.js';
import { OwnersService } from '../../owners/owners.service.js';
import { GeographyService } from '../../properties/geography.service.js';
import { PropertiesService } from '../../properties/properties.service.js';
import { LeasesService } from '../leases.service.js';
import type { LeaseRow } from '../rent-dues.js';
import { fillTemplate } from './contract-renderer.js';
import { defaultTemplate } from './default-templates.js';
import { PDF_CONVERTER, pdfPageCount, type PdfConverter } from './pdf-converter.js';
import { SIGNATURE_PROVIDER, type SignatureProvider } from './signature-provider.js';
import { inspectTemplate, TemplateRejectedError } from './template-inspection.js';

type ContractRow = typeof leaseContracts.$inferSelect;
type VersionRow = typeof contractVersions.$inferSelect;
type TemplateRow = typeof contractTemplates.$inferSelect;
type AmendmentRow = typeof leaseAmendments.$inferSelect;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

const CONTRACT_NOT_FOUND = () => new AppError('CONTRACT_NOT_FOUND', 'Contrat introuvable.', 404);
const TEMPLATE_NOT_FOUND = () => new AppError('TEMPLATE_NOT_FOUND', 'Modèle introuvable.', 404);
const AMENDMENT_NOT_FOUND = () => new AppError('AMENDMENT_NOT_FOUND', 'Avenant introuvable.', 404);

const BLOCKER_MESSAGES: Record<string, string> = {
	NO_MANAGEMENT_MANDATE: 'Aucun mandat de gestion en vigueur ne couvre cette unité : pas de contrat sans mandat.',
	LEASE_NOT_CONTRACTABLE: 'Ce bail est annulé ou terminé : il ne reçoit plus de contrat.',
	DATES_INCOHERENT: 'Les dates du bail ou du contrat sont incohérentes : corrigez-les avant de générer.',
	MISSING_FIELDS: 'Des champs du contrat restent vides : complétez les fiches avant de figer.',
	CONTRACT_OUTDATED: 'Le bail a changé depuis cette version : générez la version suivante avant de figer ou de signer.',
	TEMPLATE_HAS_UNKNOWN_FIELDS: 'Le modèle contient des balises inconnues.'
};

/** Copie des données de l'unité, du bien et du propriétaire (lot 07, lot 06), sans lire leurs tables. */
interface PlaceData {
	unit: ContractData['unit'];
	owner: ContractData['owner'];
}

/** Conditions du bail et cautions convenues, telles que le contrat les cite (comparées pour savoir s'il est à jour). */
function termsSnapshot(
	lease: LeaseRow,
	deposits: { type: string; agreedAmount: number; agreedMonths: number | null; holder: 'organization' | 'owner' }[]
): Pick<ContractData, 'lease' | 'deposits'> {
	const security = deposits.find((d) => d.type === 'security_deposit');
	const utilities = deposits.find((d) => d.type === 'utilities_guarantee');
	return {
		lease: {
			// Référence courte, imprimée en pied de page : la fin de l'identifiant (UUIDv7, aléatoire).
			reference: `B-${lease.id.replace(/-/g, '').slice(-8).toUpperCase()}`,
			startsOn: lease.startsOn,
			endsOn: lease.endsOn,
			durationMonths: lease.durationMonths,
			rent: lease.rent,
			charges: lease.charges,
			dueDay: lease.dueDay,
			paymentTerms: lease.paymentTerms,
			advanceMonths: lease.advanceMonths,
			lessorType: lease.lessorType,
			penaltyRateBp: lease.penaltyRateBp,
			penaltyGraceDays: lease.penaltyGraceDays,
			penaltyBeneficiary: lease.penaltyBeneficiary,
			noticeTenantFixedTermMonths: lease.noticeTenantFixedTermMonths,
			noticeTenantOpenEndedMonths: lease.noticeTenantOpenEndedMonths,
			noticeLessorFixedTermMonths: lease.noticeLessorFixedTermMonths,
			noticeLessorOpenEndedMonths: lease.noticeLessorOpenEndedMonths,
			reducedNoticeMonths: lease.reducedNoticeMonths,
			reducedNoticeCases: lease.reducedNoticeCases,
			earlyTerminationIndemnityMonths: lease.earlyTerminationIndemnityMonths,
			renewalMode: lease.renewalMode,
			depositRefundDays: lease.depositRefundDays,
			billingMode: lease.billingMode,
			periodicity: lease.periodicity,
			duesStartOn: lease.duesStartOn,
			version: lease.version
		},
		deposits: {
			security: security ? { amount: security.agreedAmount, months: security.agreedMonths, holder: security.holder } : null,
			utilities: utilities ? { amount: utilities.agreedAmount } : null
		}
	};
}

/** Le bail ou ses cautions ont-ils changé depuis cette version ? (brouillon compris, qui ne change pas de version). */
function termsChanged(version: { data: ContractData }, current: Pick<ContractData, 'lease' | 'deposits'>): boolean {
	return canonical({ lease: version.data.lease, deposits: version.data.deposits }) !== canonical(current);
}

/** JSON aux clés triées : PostgreSQL range les clés d'un jsonb dans son propre ordre. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value ?? null);
}

interface Context {
	tx: Tx;
	organizationId: string;
	organizationType: 'agency' | 'landlord';
	userId: string;
	actor: AuditActor;
}

@Injectable()
export class ContractsService implements OnModuleInit {
	private platformUsages = new Map<ContractTemplateKind, TemplateTagUsage[]>();

	constructor(
		private readonly audit: AuditService,
		private readonly leases: LeasesService,
		private readonly documents: DocumentsService,
		private readonly organizations: OrganizationsService,
		private readonly owners: OwnersService,
		private readonly properties: PropertiesService,
		private readonly geography: GeographyService,
		@InjectQueue(CONTRACTS_QUEUE) private readonly queue: Queue,
		@Inject(PDF_CONVERTER) private readonly converter: PdfConverter,
		@Inject(SIGNATURE_PROVIDER) private readonly signature: SignatureProvider
	) {}

	/** Un bail signé scanné déposé par la route des documents (assistant du lot 08) passe par ce service. */
	onModuleInit(): void {
		this.documents.onSignedLeaseScan(async (doc) => {
			if (!doc.leaseContractId) await this.recordUploadedScan(doc.leaseId, doc.id);
		});
	}

	private context(): Context {
		const scope = RequestContext.organization();
		const userId = RequestContext.get()!.userId!;
		return {
			tx: RequestContext.tx(),
			organizationId: scope.organizationId,
			organizationType: scope.organizationType,
			userId,
			actor: { type: 'user', userId, role: scope.role }
		};
	}

	// ---------------------------------------------------------------- lectures

	private async contractRow(c: Context, id: string, lock = false): Promise<ContractRow> {
		const q = c.tx
			.select()
			.from(leaseContracts)
			.where(and(eq(leaseContracts.organizationId, c.organizationId), eq(leaseContracts.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw CONTRACT_NOT_FOUND();
		return row;
	}

	private async versionsOf(c: Context, contractIds: readonly string[]): Promise<VersionRow[]> {
		if (!contractIds.length) return [];
		return c.tx
			.select()
			.from(contractVersions)
			.where(and(eq(contractVersions.organizationId, c.organizationId), inArray(contractVersions.contractId, [...contractIds])))
			.orderBy(asc(contractVersions.number));
	}

	private async amendmentRow(c: Context, id: string, lock = false): Promise<AmendmentRow> {
		const q = c.tx
			.select()
			.from(leaseAmendments)
			.where(and(eq(leaseAmendments.organizationId, c.organizationId), eq(leaseAmendments.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw AMENDMENT_NOT_FOUND();
		return row;
	}

	private versionView(v: VersionRow): ContractVersionView {
		return {
			id: v.id,
			number: v.number,
			leaseVersion: v.leaseVersion,
			templateSource: v.templateSource,
			templateId: v.templateId,
			templateVersion: v.templateVersion,
			blankFields: v.blankFields,
			warnings: v.warnings,
			docxDocumentId: v.docxDocumentId,
			pdfDocumentId: v.pdfDocumentId,
			docxSha256: v.docxSha256,
			pdfSha256: v.pdfSha256,
			pageCount: v.pageCount,
			createdBy: v.createdBy,
			createdAt: v.createdAt.toISOString()
		};
	}

	private amendmentView(a: AmendmentRow, contractId: string | null): AmendmentView {
		return {
			id: a.id,
			leaseId: a.leaseId,
			number: a.number,
			type: a.type,
			effectiveFrom: a.effectiveFrom,
			newRent: a.newRent,
			newCharges: a.newCharges,
			newEndsOn: a.newEndsOn,
			openEnded: a.openEnded,
			description: a.description,
			expectedLeaseVersion: a.expectedLeaseVersion,
			status: a.status,
			appliedAt: iso(a.appliedAt),
			appliedLeaseVersion: a.appliedLeaseVersion,
			cancelledAt: iso(a.cancelledAt),
			cancellationReason: a.cancellationReason,
			contractId,
			createdAt: a.createdAt.toISOString()
		};
	}

	/** Vues des contrats : alertes calculées, « à régénérer », libellé de la signature. */
	private async views(c: Context, rows: ContractRow[]): Promise<ContractView[]> {
		const today = toIsoDate();
		const versions = await this.versionsOf(
			c,
			rows.map((r) => r.id)
		);
		// « À régénérer » : seulement pour un contrat figé, en comparant ses conditions à celles du bail aujourd'hui.
		const current = new Map<string, Pick<ContractData, 'lease' | 'deposits'>>();
		for (const leaseId of new Set(rows.filter((r) => r.status === 'ready_to_sign').map((r) => r.leaseId))) {
			const inputs = await this.leases.contractInputs(leaseId);
			current.set(leaseId, termsSnapshot(inputs.lease, inputs.deposits));
		}
		const names = new Map<string, string | null>();
		for (const id of new Set(rows.map((r) => r.signatureRecordedBy).filter((v): v is string => !!v))) {
			names.set(id, await this.organizations.memberName(id, c.tx));
		}
		return rows.map((r) => {
			const frozen = versions.find((v) => v.contractId === r.id && v.number === r.frozenVersion);
			const outdated = r.status === 'ready_to_sign' && !!frozen && termsChanged(frozen, current.get(r.leaseId)!);
			const signedOn =
				r.organizationSignedOn ?? r.tenantSignedOn ?? r.ownerSignedOn ?? (r.signatureRecordedAt ? toIsoDate(r.signatureRecordedAt) : null);
			return {
				id: r.id,
				leaseId: r.leaseId,
				amendmentId: r.amendmentId,
				origin: r.origin,
				templateSource: r.templateSource,
				templateId: r.templateId,
				templateVersion: r.templateVersion,
				status: r.status,
				currentVersion: r.currentVersion,
				frozenVersion: r.frozenVersion,
				frozenAt: iso(r.frozenAt),
				generationStatus: r.generationStatus,
				generationError: r.generationError,
				signingPlace: r.signingPlace,
				signingDate: r.signingDate,
				copies: r.copies,
				expectedSigners: r.expectedSigners,
				signedOn: { organization: r.organizationSignedOn, owner: r.ownerSignedOn, tenant: r.tenantSignedOn },
				signatureMode: r.signatureMode,
				signedDocumentId: r.signedDocumentId,
				signatureLabel: r.signatureRecordedAt
					? signatureLabel({ recordedBy: names.get(r.signatureRecordedBy ?? '') ?? null, recordedAt: r.signatureRecordedAt })
					: null,
				legalizedOn: r.legalizedOn,
				legalizationCommune: r.legalizationCommune,
				legalizationReference: r.legalizationReference,
				legalizationDocumentId: r.legalizationDocumentId,
				registeredOn: r.registeredOn,
				registrationReference: r.registrationReference,
				registrationDocumentId: r.registrationDocumentId,
				legalizationReminder: r.legalizationReminder,
				outdated,
				alerts: contractAlerts(
					{
						status: r.status,
						frozenAt: iso(r.frozenAt),
						signedOn,
						legalizedOn: r.legalizedOn,
						legalizationReminder: r.legalizationReminder,
						outdated,
						isAmendment: r.amendmentId !== null
					},
					today
				),
				defaultTemplateNotice:
					r.templateSource === 'platform' && showDefaultTemplateBanner('platform', r.amendmentId ? 'amendment' : 'lease'),
				createdAt: r.createdAt.toISOString(),
				updatedAt: r.updatedAt.toISOString()
			};
		});
	}

	async list(filter: { leaseId?: string; status?: ContractRow['status'] } = {}): Promise<ContractView[]> {
		const c = this.context();
		const rows = await c.tx
			.select()
			.from(leaseContracts)
			.where(
				and(
					eq(leaseContracts.organizationId, c.organizationId),
					filter.leaseId ? eq(leaseContracts.leaseId, filter.leaseId) : undefined,
					filter.status ? eq(leaseContracts.status, filter.status) : undefined
				)
			)
			.orderBy(desc(leaseContracts.updatedAt), asc(leaseContracts.id));
		return this.views(c, rows);
	}

	async get(id: string): Promise<ContractDetailView> {
		const c = this.context();
		const row = await this.contractRow(c, id);
		const [view] = await this.views(c, [row]);
		const amendment = row.amendmentId ? this.amendmentView(await this.amendmentRow(c, row.amendmentId), row.id) : null;
		return { ...view!, versions: (await this.versionsOf(c, [id])).map((v) => this.versionView(v)), amendment };
	}

	/** Valeurs résolues d'une version (état civil compris) : en ligne, direction et gestion (`contract.read`). */
	async versionFields(contractId: string, number: number): Promise<ContractVersionFields> {
		const c = this.context();
		await this.contractRow(c, contractId);
		const [v] = await c.tx
			.select()
			.from(contractVersions)
			.where(
				and(
					eq(contractVersions.organizationId, c.organizationId),
					eq(contractVersions.contractId, contractId),
					eq(contractVersions.number, number)
				)
			)
			.limit(1);
		if (!v) throw new AppError('CONTRACT_VERSION_NOT_FOUND', 'Version introuvable.', 404);
		return { number: v.number, fields: v.fields, blankFields: v.blankFields };
	}

	/** Lien signé de 5 minutes vers le Word ou le PDF d'une version ; chaque lien délivré est journalisé. */
	async download(contractId: string, number: number, format: 'pdf' | 'docx'): Promise<DocumentDownload & { sha256: string }> {
		const c = this.context();
		await this.contractRow(c, contractId);
		const [v] = await c.tx
			.select()
			.from(contractVersions)
			.where(
				and(
					eq(contractVersions.organizationId, c.organizationId),
					eq(contractVersions.contractId, contractId),
					eq(contractVersions.number, number)
				)
			)
			.limit(1);
		if (!v) throw new AppError('CONTRACT_VERSION_NOT_FOUND', 'Version introuvable.', 404);
		const link = await this.documents.download(format === 'pdf' ? v.pdfDocumentId : v.docxDocumentId);
		return { ...link, sha256: format === 'pdf' ? v.pdfSha256 : v.docxSha256 };
	}

	// ---------------------------------------------------------------- modèles

	private templateView(t: TemplateRow, previews: Map<string, string>): ContractTemplateView {
		return {
			id: t.id,
			kind: t.kind,
			name: t.name,
			version: t.version,
			replacesId: t.replacesId,
			documentId: t.documentId,
			status: t.status,
			inspectedAt: iso(t.inspectedAt),
			inspectionError: t.inspectionError,
			detectedFields: t.detectedFields,
			unknownFields: t.unknownFields,
			unmatchedFonts: t.unmatchedFonts,
			pageCount: t.pageCount,
			previewDocumentId: previews.get(t.id) ?? null,
			activatedAt: iso(t.activatedAt),
			retiredAt: iso(t.retiredAt),
			createdAt: t.createdAt.toISOString()
		};
	}

	private async templateRow(c: Context, id: string, lock = false): Promise<TemplateRow> {
		const q = c.tx
			.select()
			.from(contractTemplates)
			.where(and(eq(contractTemplates.organizationId, c.organizationId), eq(contractTemplates.id, id)))
			.limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw TEMPLATE_NOT_FOUND();
		return row;
	}

	private async activeTemplate(c: Context, kind: ContractTemplateKind): Promise<TemplateRow | null> {
		const [row] = await c.tx
			.select()
			.from(contractTemplates)
			.where(
				and(
					eq(contractTemplates.organizationId, c.organizationId),
					eq(contractTemplates.kind, kind),
					eq(contractTemplates.status, 'active')
				)
			)
			.limit(1);
		return row ?? null;
	}

	async templates(): Promise<TemplatesOverview> {
		const c = this.context();
		const rows = await c.tx
			.select()
			.from(contractTemplates)
			.where(eq(contractTemplates.organizationId, c.organizationId))
			.orderBy(asc(contractTemplates.kind), desc(contractTemplates.version));
		const previews = await this.documents.templatePreviews(rows.map((r) => r.id));
		const inUse = {} as TemplatesOverview['inUse'];
		for (const kind of ['lease', 'amendment'] as const) {
			const active = rows.find((r) => r.kind === kind && r.status === 'active');
			inUse[kind] = active
				? { source: 'organization', templateId: active.id, version: active.version, legalReviewPending: false }
				: {
						source: 'platform',
						templateId: null,
						version: PLATFORM_TEMPLATES[kind].version,
						legalReviewPending: showDefaultTemplateBanner('platform', kind)
					};
		}
		return { templates: rows.map((r) => this.templateView(r, previews)), inUse };
	}

	/** Dépôt d'un modèle Word : le modèle (brouillon) et son fichier, en attente ; URL d'envoi signée. */
	async createTemplate(input: CreateTemplateData): Promise<{ template: ContractTemplateView; upload: PresignedUpload }> {
		const c = this.context();
		const exists = await c.tx
			.select({ id: contractTemplates.id })
			.from(contractTemplates)
			.where(eq(contractTemplates.id, input.id))
			.limit(1);
		if (exists.length) throw new AppError('CONFLICT', 'Ce modèle existe déjà.', 409);
		const [latest] = await c.tx
			.select()
			.from(contractTemplates)
			.where(and(eq(contractTemplates.organizationId, c.organizationId), eq(contractTemplates.kind, input.kind)))
			.orderBy(desc(contractTemplates.version))
			.limit(1);
		const [row] = await c.tx
			.insert(contractTemplates)
			.values({
				id: input.id,
				organizationId: c.organizationId,
				kind: input.kind,
				name: input.name,
				version: latest ? latest.version + 1 : 1,
				replacesId: latest?.id ?? null,
				documentId: input.documentId,
				status: 'draft',
				detectedFields: [],
				unknownFields: [],
				tagUsages: [],
				fonts: [],
				unmatchedFonts: [],
				createdBy: c.userId
			})
			.returning();
		const { upload } = await this.documents.createContractUpload(
			{
				id: input.documentId,
				type: 'contract_template',
				leaseId: null,
				leaseContractId: null,
				contractTemplateId: input.id,
				fileName: input.fileName,
				mimeType: DOCX
			},
			input.byteSize
		);
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'contract_template.create',
			objectType: 'contract_template',
			objectId: input.id,
			after: { kind: input.kind, name: input.name, version: row!.version, documentId: input.documentId, status: 'draft' }
		});
		return { template: this.templateView(row!, new Map()), upload };
	}

	/**
	 * Inspection du modèle reçu (point 2 du porteur) : fichier contrôlé, balises reconnues et inconnues, polices,
	 * pages. Un refus est enregistré avec sa raison ; le modèle reste brouillon, sans jamais être utilisé.
	 */
	async inspectTemplate(id: string): Promise<ContractTemplateView> {
		const c = this.context();
		const row = await this.templateRow(c, id, true);
		if (row.status !== 'draft') throw new AppError('TEMPLATE_NOT_DRAFT', 'Seul un modèle brouillon s’inspecte.', 409);
		const document: DocumentView = await this.documents.uploaded(row.documentId);
		const now = new Date();
		let set: Partial<typeof contractTemplates.$inferInsert>;
		if (document.status !== 'active') {
			set = { inspectionError: 'Ce fichier n’est pas un document Word lisible.', inspectedAt: null };
		} else {
			try {
				const { body } = await this.documents.readFile(row.documentId);
				const r = inspectTemplate(body, row.kind);
				set = {
					inspectedAt: now,
					inspectionError: null,
					detectedFields: r.known,
					unknownFields: r.unknown,
					tagUsages: r.usages,
					fonts: r.fonts,
					unmatchedFonts: r.unmatchedFonts,
					pageCount: r.pageCount
				};
			} catch (error) {
				if (!(error instanceof TemplateRejectedError)) throw error;
				set = { inspectedAt: null, inspectionError: `${error.code} : ${error.message}` };
			}
		}
		const [updated] = await c.tx
			.update(contractTemplates)
			.set({ ...set, updatedAt: now })
			.where(and(eq(contractTemplates.organizationId, c.organizationId), eq(contractTemplates.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'contract_template.inspect',
			objectType: 'contract_template',
			objectId: id,
			after: {
				inspectionError: updated!.inspectionError,
				unknownFields: updated!.unknownFields,
				unmatchedFonts: updated!.unmatchedFonts,
				pageCount: updated!.pageCount
			}
		});
		return this.templateView(updated!, await this.documents.templatePreviews([id]));
	}

	/** Aperçu avec les données d'exemple : PDF généré par la tâche de fond. */
	async previewTemplate(id: string): Promise<ContractTemplateView> {
		const c = this.context();
		const row = await this.templateRow(c, id);
		if (!row.inspectedAt || row.inspectionError) throw new AppError('TEMPLATE_NOT_INSPECTED', 'Le modèle doit d’abord être inspecté.', 409);
		const data: TemplatePreviewJobData = { organizationId: c.organizationId, userId: c.userId, templateId: id };
		RequestContext.afterCommit(async () => {
			await this.queue.add(TEMPLATE_PREVIEW_JOB, data, { jobId: `preview-${id}-${Date.now()}` });
		});
		return this.templateView(row, await this.documents.templatePreviews([id]));
	}

	/** Tâche : l'aperçu PDF du modèle avec les données d'exemple (aucune personne réelle). */
	async renderTemplatePreview(id: string): Promise<string> {
		const c = this.context();
		const row = await this.templateRow(c, id);
		const { body } = await this.documents.readFile(row.documentId);
		const pdf = await this.converter.convertDocx(
			fillTemplate(body, resolveContractFields(EXAMPLE_CONTRACT_DATA, row.kind)),
			`${row.name}.docx`
		);
		const stored = await this.documents.storeGenerated(
			{
				id: newId(),
				type: 'contract_template',
				leaseId: null,
				leaseContractId: null,
				contractTemplateId: id,
				fileName: `Aperçu – ${row.name}.pdf`,
				mimeType: 'application/pdf'
			},
			pdf
		);
		return stored.id;
	}

	/** Activation : inspecté, sans balise inconnue ; l'ancien modèle actif du même type est retiré (un seul actif). */
	async activateTemplate(id: string): Promise<ContractTemplateView> {
		const c = this.context();
		const row = await this.templateRow(c, id, true);
		const blocker = templateActivationBlocker({
			status: row.status,
			inspected: !!row.inspectedAt && !row.inspectionError,
			unknownFields: row.unknownFields
		});
		if (blocker) {
			const messages = {
				TEMPLATE_NOT_INSPECTED: 'Le modèle doit d’abord être inspecté sans erreur.',
				TEMPLATE_HAS_UNKNOWN_FIELDS: 'Le modèle contient des balises inconnues : corrigez-les avant de l’activer.',
				TEMPLATE_RETIRED: 'Ce modèle est retiré.'
			} as const;
			throw new AppError(blocker, messages[blocker], 409, { unknownFields: row.unknownFields });
		}
		if (row.status === 'active') return this.templateView(row, await this.documents.templatePreviews([id]));
		const now = new Date();
		const previous = await this.activeTemplate(c, row.kind);
		if (previous) {
			await c.tx
				.update(contractTemplates)
				.set({ status: 'retired', retiredAt: now, updatedAt: now })
				.where(and(eq(contractTemplates.organizationId, c.organizationId), eq(contractTemplates.id, previous.id)));
		}
		const [updated] = await c.tx
			.update(contractTemplates)
			.set({ status: 'active', activatedAt: now, activatedBy: c.userId, updatedAt: now })
			.where(and(eq(contractTemplates.organizationId, c.organizationId), eq(contractTemplates.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'contract_template.activate',
			objectType: 'contract_template',
			objectId: id,
			before: { status: row.status, previousActive: previous?.id ?? null },
			after: { status: 'active', kind: row.kind, version: row.version }
		});
		return this.templateView(updated!, await this.documents.templatePreviews([id]));
	}

	/** Retrait : le type revient au modèle de la plateforme (D25) ; les contrats déjà générés gardent leurs versions. */
	async retireTemplate(id: string): Promise<ContractTemplateView> {
		const c = this.context();
		const row = await this.templateRow(c, id, true);
		if (row.status === 'retired') return this.templateView(row, new Map());
		const now = new Date();
		const [updated] = await c.tx
			.update(contractTemplates)
			.set({ status: 'retired', retiredAt: now, updatedAt: now })
			.where(and(eq(contractTemplates.organizationId, c.organizationId), eq(contractTemplates.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'contract_template.retire',
			objectType: 'contract_template',
			objectId: id,
			before: { status: row.status },
			after: { status: 'retired' }
		});
		return this.templateView(updated!, new Map());
	}

	/** Modèle à remplir : celui de l'organisation (actif) ou celui de la plateforme, avec l'emplacement de ses balises. */
	private async templateFor(
		c: Context,
		kind: ContractTemplateKind,
		pinned?: { source: 'platform' | 'organization'; id: string | null }
	): Promise<{
		source: 'platform' | 'organization';
		id: string | null;
		version: number;
		body: Buffer;
		usages: TemplateTagUsage[];
		unknown: string[];
	}> {
		const org =
			pinned?.source === 'organization' && pinned.id
				? await this.templateRow(c, pinned.id)
				: pinned
					? null
					: await this.activeTemplate(c, kind);
		if (org) {
			const { body } = await this.documents.readFile(org.documentId);
			return { source: 'organization', id: org.id, version: org.version, body, usages: org.tagUsages, unknown: org.unknownFields };
		}
		let usages = this.platformUsages.get(kind);
		if (!usages) {
			usages = inspectTemplate(defaultTemplate(kind), kind).usages;
			this.platformUsages.set(kind, usages);
		}
		return { source: 'platform', id: null, version: PLATFORM_TEMPLATES[kind].version, body: defaultTemplate(kind), usages, unknown: [] };
	}

	// ---------------------------------------------------------------- copie des données (D29)

	private async place(c: Context, unitId: string, lessorType: LeaseRow['lessorType']): Promise<PlaceData> {
		const unit = await this.properties.getUnit(unitId);
		const property = await this.properties.get(unit.propertyId);
		const communes = await this.geography.communes(c.tx);
		const neighborhoods = await this.geography.neighborhoods(c.tx);
		const owner = c.organizationType === 'landlord' && lessorType === 'organization' ? null : await this.owners.get(property.ownerId);
		return {
			unit: {
				type: unit.type,
				label: unit.label,
				usage: unit.usage,
				furnished: unit.furnished,
				bedrooms: unit.rooms.bedrooms,
				livingRooms: unit.rooms.livingRooms,
				kitchens: unit.rooms.kitchens,
				bathrooms: unit.rooms.bathrooms,
				terraces: unit.rooms.terraces,
				laundries: unit.rooms.laundries,
				surfaceM2: unit.surfaceM2,
				landAreaM2: unit.landAreaM2,
				amenities: unit.amenities,
				propertyName: property.name,
				addressHint: property.addressHint,
				neighborhood: neighborhoods.find((n) => n.id === property.neighborhoodId)?.name ?? null,
				commune: communes.find((x) => x.id === property.communeId)?.name ?? ''
			},
			owner: owner
				? {
						type: owner.type,
						name: owner.name,
						address: owner.address,
						phone: owner.phone,
						representativeName: owner.representative?.name ?? null
					}
				: null
		};
	}

	/** Toutes les données du contrat, copiées maintenant : la version les garde telles quelles (D29). */
	private async contractData(
		c: Context,
		leaseId: string,
		contract: ContractRow,
		amendment: AmendmentRow | null
	): Promise<{ data: ContractData; lease: LeaseRow }> {
		const { lease, tenant, deposits } = await this.leases.contractInputs(leaseId);
		const org = await this.organizations.contractSnapshot(c.tx);
		const place = await this.place(c, lease.unitId, lease.lessorType);
		let baseContractSignedOn: string | null = null;
		if (amendment) {
			const [base] = await c.tx
				.select()
				.from(leaseContracts)
				.where(
					and(eq(leaseContracts.organizationId, c.organizationId), eq(leaseContracts.leaseId, leaseId), isNull(leaseContracts.amendmentId))
				)
				.limit(1);
			baseContractSignedOn = base?.signatureRecordedAt ? (base.tenantSignedOn ?? toIsoDate(base.signatureRecordedAt)) : null;
		}
		const rep = org.view.representative;
		// Mandat de gestion qui couvre l'unité : sa date est citée (propriétaire représenté) ; il décide aussi si le
		// propriétaire signe lui-même, donc combien de parties gardent un exemplaire.
		const mandate = await this.owners.managementMandateFor(lease.unitId, lease.startsOn);
		const signers = expectedSigners({ lessorType: lease.lessorType, mandateCanSignLeases: mandate?.canSignLeases ?? false });
		const data: ContractData = {
			organization: {
				type: org.view.type,
				legalName: org.view.legalName,
				tradeName: org.view.tradeName,
				address: org.view.address,
				commune: org.view.commune,
				poBox: org.view.poBox,
				rccm: org.view.rccm,
				ifu: org.view.ifu,
				phone: org.view.phone,
				logoId: org.logoId,
				representative: {
					name: rep.name,
					title: rep.title,
					profession: rep.profession,
					address: rep.address,
					nationality: rep.nationality,
					identity: {
						type: rep.idType,
						typeOther: rep.idTypeOther,
						number: rep.idNumber,
						issuedOn: rep.idIssuedOn,
						issuedBy: rep.idIssuedBy
					}
				}
			},
			owner: place.owner,
			tenant: {
				civility: tenant.civility,
				fullName: tenant.fullName,
				birthDate: tenant.birthDate,
				birthPlace: tenant.birthPlace,
				nationality: tenant.nationality,
				profession: tenant.profession,
				previousAddress: tenant.previousAddress,
				phone: tenant.phone,
				secondaryPhone: tenant.secondaryPhone,
				identity: {
					type: tenant.idType,
					typeOther: tenant.idTypeOther,
					number: tenant.idNumber,
					issuedOn: tenant.idIssuedOn,
					issuedBy: tenant.idIssuedBy
				}
			},
			unit: place.unit,
			...termsSnapshot(lease, deposits),
			signing: {
				place: contract.signingPlace,
				date: contract.signingDate,
				copies: contract.copies,
				parties: signers.length,
				ownerSigns: signers.includes('owner')
			},
			mandate: mandate ? { startsOn: mandate.startsOn } : null,
			amendment: amendment
				? {
						number: amendment.number,
						type: amendment.type,
						effectiveFrom: amendment.effectiveFrom,
						description: amendment.description,
						newRent: amendment.newRent,
						newCharges: amendment.newCharges,
						newEndsOn: amendment.newEndsOn,
						baseContractSignedOn
					}
				: null
		};
		return { data, lease };
	}

	private checksInput(
		lease: LeaseRow,
		data: ContractData,
		mandate: boolean,
		blank: string[],
		unknown: string[],
		amendment: AmendmentRow | null
	) {
		return {
			leaseStatus: lease.status,
			startsOn: lease.startsOn,
			endsOn: lease.endsOn,
			hasManagementMandate: mandate,
			rent: lease.rent,
			security: data.deposits.security,
			signingDate: data.signing.date,
			amendment: amendment ? { type: amendment.type, effectiveFrom: amendment.effectiveFrom, newEndsOn: amendment.newEndsOn } : null,
			blankFields: blank,
			unknownFields: unknown
		};
	}

	private refuse(blockers: string[], details: Record<string, unknown> = {}): never {
		throw new AppError(blockers[0]!, BLOCKER_MESSAGES[blockers[0]!] ?? 'Contrat refusé.', 409, { blockers, ...details });
	}

	// ---------------------------------------------------------------- création et génération

	private requestGeneration(c: Context, contract: ContractRow): void {
		const data: ContractGenerateJobData = {
			organizationId: c.organizationId,
			userId: c.userId,
			contractId: contract.id,
			number: contract.currentVersion + 1
		};
		RequestContext.afterCommit(async () => {
			// Identifiant de tâche : contrat et numéro attendu (un double clic ne lance pas deux générations).
			await this.queue.add(CONTRACT_GENERATE_JOB, data, { jobId: `${contract.id}-${data.number}` });
		});
	}

	private async insertContract(
		c: Context,
		input: CreateContractData,
		lease: LeaseRow,
		amendment: AmendmentRow | null
	): Promise<ContractRow> {
		const kind: ContractTemplateKind = amendment ? 'amendment' : 'lease';
		const { data } = await this.contractData(
			c,
			lease.id,
			{ signingPlace: input.signingPlace, signingDate: input.signingDate, copies: input.copies } as ContractRow,
			amendment
		);
		const mandate = await this.owners.managementMandateFor(lease.unitId, lease.startsOn);
		const template = await this.templateFor(c, kind);
		const checks = contractChecks(this.checksInput(lease, data, mandate !== null, [], template.unknown, amendment), 'generate');
		if (checks.blockers.length) this.refuse(checks.blockers, { dateIssues: checks.dateIssues });
		const [row] = await c.tx
			.insert(leaseContracts)
			.values({
				id: input.id,
				organizationId: c.organizationId,
				leaseId: lease.id,
				amendmentId: amendment?.id ?? null,
				origin: 'generated',
				templateSource: template.source,
				templateId: template.id,
				templateVersion: template.version,
				status: 'draft',
				currentVersion: 0,
				generationStatus: 'pending',
				signingPlace: input.signingPlace,
				signingDate: input.signingDate,
				copies: input.copies,
				legalizationReminder: true,
				createdBy: c.userId
			})
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'contract.create',
			objectType: 'lease_contract',
			objectId: input.id,
			after: {
				leaseId: lease.id,
				amendmentId: amendment?.id ?? null,
				templateSource: template.source,
				templateId: template.id,
				templateVersion: template.version,
				status: 'draft'
			}
		});
		this.requestGeneration(c, row!);
		return row!;
	}

	/** Contrat d'un bail : brouillon, puis la version 1 générée en tâche de fond. */
	async createContract(leaseId: string, input: CreateContractData): Promise<ContractDetailView> {
		const c = this.context();
		const { lease } = await this.leases.contractInputs(leaseId);
		const [existing] = await c.tx
			.select({ id: leaseContracts.id })
			.from(leaseContracts)
			.where(
				and(eq(leaseContracts.organizationId, c.organizationId), eq(leaseContracts.leaseId, leaseId), isNull(leaseContracts.amendmentId))
			)
			.limit(1);
		if (existing) throw new AppError('CONTRACT_EXISTS', 'Ce bail a déjà un contrat.', 409, { contractId: existing.id });
		await this.insertContract(c, input, lease, null);
		return this.get(input.id);
	}

	/**
	 * Tâche de génération (worker) : la version `number`, dans la transaction de l'organisation. Sans effet si elle
	 * existe déjà (rejeu) ou si le contrat n'est plus modifiable (figé entre-temps).
	 */
	async generateVersion(contractId: string, number: number): Promise<{ status: 'generated' | 'skipped' | 'refused'; blockers?: string[] }> {
		const c = this.context();
		const contract = await this.contractRow(c, contractId, true);
		if (contract.currentVersion >= number || !canRegenerate(contract.status)) {
			if (contract.generationStatus === 'pending') await this.setGeneration(c, contractId, 'idle', null);
			return { status: 'skipped' };
		}
		const amendment = contract.amendmentId ? await this.amendmentRow(c, contract.amendmentId) : null;
		const kind: ContractTemplateKind = amendment ? 'amendment' : 'lease';
		const { data, lease } = await this.contractData(c, contract.leaseId, contract, amendment);
		const template = await this.templateFor(c, kind, { source: contract.templateSource!, id: contract.templateId });
		const values = resolveContractFields(data, kind);
		const blank = blankFields(template.usages, values);
		const mandate = await this.owners.managementMandateFor(lease.unitId, lease.startsOn);
		const checks = contractChecks(this.checksInput(lease, data, mandate !== null, blank, template.unknown, amendment), 'generate');
		if (checks.blockers.length) {
			await this.setGeneration(c, contractId, 'failed', checks.blockers.map((b) => BLOCKER_MESSAGES[b] ?? b).join(' '));
			return { status: 'refused', blockers: checks.blockers };
		}
		const docx = fillTemplate(template.body, values);
		const pdf = await this.converter.convertDocx(docx, `contrat-${number}.docx`);
		const base = amendment ? `Avenant ${amendment.number}` : 'Contrat de bail';
		const docxFile = await this.documents.storeGenerated(
			{
				id: newId(),
				type: 'contract_draft',
				leaseId: lease.id,
				leaseContractId: contractId,
				contractTemplateId: null,
				fileName: `${base} – version ${number}.docx`,
				mimeType: DOCX
			},
			docx
		);
		const pdfFile = await this.documents.storeGenerated(
			{
				id: newId(),
				type: 'contract_draft',
				leaseId: lease.id,
				leaseContractId: contractId,
				contractTemplateId: null,
				fileName: `${base} – version ${number}.pdf`,
				mimeType: 'application/pdf'
			},
			pdf
		);
		await c.tx.insert(contractVersions).values({
			id: newId(),
			organizationId: c.organizationId,
			contractId,
			number,
			leaseVersion: lease.version,
			templateSource: template.source,
			templateId: template.id,
			templateVersion: template.version,
			data,
			fields: values,
			blankFields: blank,
			warnings: checks.warnings,
			docxDocumentId: docxFile.id,
			pdfDocumentId: pdfFile.id,
			docxSha256: docxFile.sha256,
			pdfSha256: pdfFile.sha256,
			pageCount: await pdfPageCount(pdf),
			createdBy: c.userId
		});
		await c.tx
			.update(leaseContracts)
			.set({ currentVersion: number, generationStatus: 'idle', generationError: null, updatedAt: new Date() })
			.where(and(eq(leaseContracts.organizationId, c.organizationId), eq(leaseContracts.id, contractId)));
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'contract.generate',
			objectType: 'lease_contract',
			objectId: contractId,
			after: {
				version: number,
				leaseVersion: lease.version,
				templateSource: template.source,
				templateVersion: template.version,
				docxSha256: docxFile.sha256,
				pdfSha256: pdfFile.sha256,
				blankFields: blank,
				warnings: checks.warnings
			}
		});
		if (checks.warnings.includes('DEPOSIT_ABOVE_LEGAL_CAP')) {
			await this.audit.record(c.tx, {
				actor: c.actor,
				organizationId: c.organizationId,
				action: 'contract.deposit_above_legal_cap',
				objectType: 'lease_contract',
				objectId: contractId,
				after: { leaseId: lease.id, deposit: data.deposits.security?.amount ?? null, rent: lease.rent, capMonths: 2 }
			});
		}
		return { status: 'generated' };
	}

	private async setGeneration(c: Context, contractId: string, status: 'idle' | 'pending' | 'failed', error: string | null): Promise<void> {
		await c.tx
			.update(leaseContracts)
			.set({ generationStatus: status, generationError: error?.slice(0, 500) ?? null, updatedAt: new Date() })
			.where(and(eq(leaseContracts.organizationId, c.organizationId), eq(leaseContracts.id, contractId)));
	}

	/** Échec définitif de la tâche (service de conversion injoignable après les nouvelles tentatives). */
	async generationFailed(contractId: string, message: string): Promise<void> {
		const c = this.context();
		await this.setGeneration(c, contractId, 'failed', `La génération a échoué : ${message}`);
	}

	private assertVersion(row: ContractRow, expected: number): void {
		if (row.generationStatus === 'pending')
			throw new AppError('CONTRACT_GENERATING', 'Une version est en cours de génération : patientez.', 409);
		if (row.currentVersion !== expected) {
			throw new AppError('VERSION_CONFLICT', 'Le contrat a changé entre-temps : rechargez-le.', 409, {
				expected,
				current: row.currentVersion
			});
		}
	}

	private async transition(
		c: Context,
		row: ContractRow,
		set: Partial<typeof leaseContracts.$inferInsert>,
		action: string,
		after: Record<string, unknown> = {}
	): Promise<void> {
		await c.tx
			.update(leaseContracts)
			.set({ ...set, updatedAt: new Date() })
			.where(and(eq(leaseContracts.organizationId, c.organizationId), eq(leaseContracts.id, row.id)));
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action,
			objectType: 'lease_contract',
			objectId: row.id,
			before: { status: row.status, version: row.currentVersion },
			after: { status: set.status ?? row.status, ...after }
		});
	}

	/**
	 * Nouvelle version : directement en brouillon ou en vérification ; un contrat prêt à signer est figé, le modifier le
	 * renvoie en vérification et crée la version suivante (rien n'est écrasé).
	 */
	async regenerate(id: string, input: Partial<ContractSigningInput> & { expectedVersion: number }): Promise<ContractDetailView> {
		const c = this.context();
		const row = await this.contractRow(c, id, true);
		this.assertVersion(row, input.expectedVersion);
		if (row.status === 'signed') throw new AppError('CONTRACT_SIGNED', 'Un contrat signé ne change plus : faites un avenant.', 409);
		const signing = {
			signingPlace: input.signingPlace ?? row.signingPlace,
			signingDate: input.signingDate ?? row.signingDate,
			copies: input.copies ?? row.copies
		};
		if (row.status === 'ready_to_sign') {
			await this.transition(
				c,
				row,
				{ status: 'in_review', frozenVersion: null, frozenAt: null, frozenBy: null, expectedSigners: null },
				'contract.unfreeze',
				{
					reason: 'modification'
				}
			);
		}
		await c.tx
			.update(leaseContracts)
			.set({ ...signing, generationStatus: 'pending', generationError: null, updatedAt: new Date() })
			.where(and(eq(leaseContracts.organizationId, c.organizationId), eq(leaseContracts.id, id)));
		this.requestGeneration(c, row);
		return this.get(id);
	}

	async submitForReview(id: string, expectedVersion: number): Promise<ContractDetailView> {
		const c = this.context();
		const row = await this.contractRow(c, id, true);
		this.assertVersion(row, expectedVersion);
		if (row.status !== 'draft' || row.currentVersion === 0)
			throw new AppError('CONTRACT_STATUS', 'Seul un brouillon généré passe en vérification.', 409);
		await this.transition(c, row, { status: 'in_review' }, 'contract.submit');
		return this.get(id);
	}

	async returnToDraft(id: string): Promise<ContractDetailView> {
		const c = this.context();
		const row = await this.contractRow(c, id, true);
		if (row.status !== 'in_review') throw new AppError('CONTRACT_STATUS', 'Seul un contrat en vérification revient en brouillon.', 409);
		await this.transition(c, row, { status: 'draft' }, 'contract.return_to_draft');
		return this.get(id);
	}

	/** Figement : la version courante, sans blanc, sur le bail tel qu'il est, avec un mandat de gestion en vigueur. */
	async freeze(id: string, expectedVersion: number): Promise<ContractDetailView> {
		const c = this.context();
		const row = await this.contractRow(c, id, true);
		this.assertVersion(row, expectedVersion);
		if (row.status !== 'in_review') throw new AppError('CONTRACT_STATUS', 'Seul un contrat en vérification se fige.', 409);
		const [version] = (await this.versionsOf(c, [id])).filter((v) => v.number === row.currentVersion);
		const { lease } = await this.leases.contractInputs(row.leaseId);
		const amendment = row.amendmentId ? await this.amendmentRow(c, row.amendmentId) : null;
		const mandate = await this.owners.managementMandateFor(lease.unitId, lease.startsOn);
		const checks = contractChecks(this.checksInput(lease, version!.data, mandate !== null, version!.blankFields, [], amendment), 'freeze');
		const { deposits } = await this.leases.contractInputs(row.leaseId);
		if (termsChanged(version!, termsSnapshot(lease, deposits))) checks.blockers.push('CONTRACT_OUTDATED');
		if (checks.blockers.length) this.refuse(checks.blockers, { blankFields: checks.blankFields, dateIssues: checks.dateIssues });
		const signers = expectedSigners({ lessorType: lease.lessorType, mandateCanSignLeases: mandate?.canSignLeases ?? false });
		const now = new Date();
		await this.transition(
			c,
			row,
			{ status: 'ready_to_sign', frozenVersion: row.currentVersion, frozenAt: now, frozenBy: c.userId, expectedSigners: signers },
			'contract.freeze',
			{ frozenVersion: row.currentVersion, expectedSigners: signers, pdfSha256: version!.pdfSha256 }
		);
		return this.get(id);
	}

	// ---------------------------------------------------------------- signature, légalisation, enregistrement

	/** Dépôt d'un scan signé ou d'une preuve : fiche en attente et URL d'envoi signée (le fichier part ensuite). */
	async createUpload(id: string, input: ContractUploadData): Promise<{ document: DocumentView; upload: PresignedUpload }> {
		const c = this.context();
		const row = await this.contractRow(c, id);
		if (input.kind === 'signed_scan' && row.status !== 'ready_to_sign') {
			throw new AppError('CONTRACT_STATUS', 'Le scan signé se dépose sur un contrat prêt à signer.', 409);
		}
		if (input.kind !== 'signed_scan' && row.status !== 'signed')
			throw new AppError('CONTRACT_STATUS', 'Ce contrat n’est pas encore signé.', 409);
		const type =
			input.kind === 'signed_scan'
				? row.amendmentId
					? 'signed_amendment_scan'
					: 'signed_lease_scan'
				: input.kind === 'legalization'
					? 'contract_legalization'
					: 'contract_registration';
		return this.documents.createContractUpload(
			{
				id: input.id,
				type,
				leaseId: row.leaseId,
				leaseContractId: id,
				contractTemplateId: null,
				fileName: input.fileName,
				mimeType: input.mimeType
			},
			input.byteSize
		);
	}

	/**
	 * Signature manuscrite, scan déposé (D21) : version figée et à jour, scan reçu et contrôlé, une date par signataire.
	 * Le bail en brouillon est validé (même fonction que la route) ; l'avenant est appliqué. Tout ou rien.
	 */
	async sign(id: string, input: SignedScanData): Promise<ContractDetailView> {
		const c = this.context();
		const row = await this.contractRow(c, id, true);
		if (row.status !== 'ready_to_sign') throw new AppError('CONTRACT_STATUS', 'Seul un contrat prêt à signer reçoit sa signature.', 409);
		if (row.frozenVersion !== input.expectedVersion) {
			throw new AppError('VERSION_CONFLICT', 'Le contrat a changé entre-temps : rechargez-le.', 409, {
				expected: input.expectedVersion,
				current: row.frozenVersion
			});
		}
		const [view] = await this.views(c, [row]);
		if (view!.outdated) this.refuse(['CONTRACT_OUTDATED']);
		const document = await this.documents.uploaded(input.documentId);
		const expectedType = row.amendmentId ? 'signed_amendment_scan' : 'signed_lease_scan';
		if (document.status !== 'active' || document.type !== expectedType || document.leaseContractId !== id) {
			throw new AppError('CONTRACT_SCAN_INVALID', 'Le scan signé doit être un PDF ou une image reçue, déposée pour ce contrat.', 409, {
				status: document.status
			});
		}
		const today = toIsoDate();
		const signers = row.expectedSigners ?? [];
		const issues = signatureDatesIssues(signers, input.signedOn, { frozenOn: toIsoDate(row.frozenAt!), today });
		if (issues.length) {
			throw new AppError('SIGNATURE_DATES', 'Chaque signataire a une date de signature, entre le figement et aujourd’hui.', 400, {
				parties: issues
			});
		}
		const recordedAt = new Date();
		const record = await this.signature.record({
			contractId: id,
			documentId: input.documentId,
			signedOn: input.signedOn,
			recordedByName: await this.organizations.memberName(c.userId, c.tx),
			recordedAt
		});
		const dateOf = (p: ContractParty) => (signers.includes(p) ? input.signedOn[p] : null);
		await this.transition(
			c,
			row,
			{
				status: 'signed',
				signatureMode: record.mode,
				signedDocumentId: input.documentId,
				signatureRecordedBy: c.userId,
				signatureRecordedAt: recordedAt,
				organizationSignedOn: dateOf('organization'),
				ownerSignedOn: dateOf('owner'),
				tenantSignedOn: dateOf('tenant')
			},
			'contract.sign',
			{ label: record.label, mode: record.mode, documentId: input.documentId, sha256: document.sha256, signedOn: input.signedOn }
		);
		if (row.amendmentId) await this.applyAmendment(c, row.amendmentId);
		else await this.leases.validateDraftForContract(row.leaseId);
		return this.get(id);
	}

	/**
	 * Bail signé scanné, déposé sans contrat généré (assistant du lot 08, anciens baux) : un contrat `uploaded_scan`
	 * signé, « signature manuscrite, scan déposé ». Un bail en brouillon est validé (même fonction). Si le bail a déjà un
	 * contrat, le scan reste un document du bail : il se signe par la route du contrat.
	 */
	async recordUploadedScan(leaseId: string, documentId: string): Promise<void> {
		const c = this.context();
		const [existing] = await c.tx
			.select({ id: leaseContracts.id })
			.from(leaseContracts)
			.where(
				and(eq(leaseContracts.organizationId, c.organizationId), eq(leaseContracts.leaseId, leaseId), isNull(leaseContracts.amendmentId))
			)
			.limit(1);
		if (existing) return;
		const id = newId();
		const now = new Date();
		await c.tx.insert(leaseContracts).values({
			id,
			organizationId: c.organizationId,
			leaseId,
			origin: 'uploaded_scan',
			status: 'signed',
			currentVersion: 0,
			signatureMode: this.signature.mode,
			signedDocumentId: documentId,
			signatureRecordedBy: c.userId,
			signatureRecordedAt: now,
			generationStatus: 'idle',
			legalizationReminder: true,
			createdBy: c.userId
		});
		const record = await this.signature.record({
			contractId: id,
			documentId,
			signedOn: { organization: null, owner: null, tenant: null },
			recordedByName: await this.organizations.memberName(c.userId, c.tx),
			recordedAt: now
		});
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'contract.upload_scan',
			objectType: 'lease_contract',
			objectId: id,
			after: { leaseId, origin: 'uploaded_scan', status: 'signed', mode: record.mode, label: record.label, documentId }
		});
		await this.leases.validateDraftForContract(leaseId);
	}

	async setLegalization(id: string, input: LegalizationData): Promise<ContractDetailView> {
		const c = this.context();
		const row = await this.contractRow(c, id, true);
		if (row.status !== 'signed') throw new AppError('CONTRACT_STATUS', 'Seul un contrat signé se légalise.', 409);
		await this.checkProof(id, input.documentId, 'contract_legalization');
		await this.transition(
			c,
			row,
			{
				legalizedOn: input.legalizedOn,
				legalizationCommune: input.commune,
				legalizationReference: input.reference,
				legalizationDocumentId: input.documentId
			},
			'contract.legalize',
			{ ...input }
		);
		return this.get(id);
	}

	async setRegistration(id: string, input: RegistrationData): Promise<ContractDetailView> {
		const c = this.context();
		const row = await this.contractRow(c, id, true);
		if (row.status !== 'signed') throw new AppError('CONTRACT_STATUS', 'Seul un contrat signé s’enregistre.', 409);
		await this.checkProof(id, input.documentId, 'contract_registration');
		await this.transition(
			c,
			row,
			{ registeredOn: input.registeredOn, registrationReference: input.reference, registrationDocumentId: input.documentId },
			'contract.register',
			{ ...input }
		);
		return this.get(id);
	}

	private async checkProof(contractId: string, documentId: string | null, type: DocumentView['type']): Promise<void> {
		if (!documentId) return;
		const doc = await this.documents.uploaded(documentId);
		if (doc.status !== 'active' || doc.type !== type || doc.leaseContractId !== contractId) {
			throw new AppError('CONTRACT_PROOF_INVALID', 'La preuve doit être un fichier reçu, déposé pour ce contrat.', 409);
		}
	}

	async setLegalizationReminder(id: string, enabled: boolean): Promise<ContractDetailView> {
		const c = this.context();
		const row = await this.contractRow(c, id, true);
		await this.transition(c, row, { legalizationReminder: enabled }, 'contract.legalization_reminder', { enabled });
		return this.get(id);
	}

	// ---------------------------------------------------------------- avenants

	/** Avenant : contrôlé à blanc sur le bail tel qu'il est (version attendue), puis son contrat généré. */
	async createAmendment(leaseId: string, input: CreateAmendmentData, signing: CreateContractData): Promise<ContractDetailView> {
		const c = this.context();
		const { lease } = await this.leases.contractInputs(leaseId);
		if (!['signed', 'active', 'notice'].includes(lease.status)) {
			throw new AppError('LEASE_NOT_VALIDATED', 'Un avenant modifie un bail validé.', 409, { status: lease.status });
		}
		if (input.expectedLeaseVersion !== lease.version) {
			throw new AppError('VERSION_CONFLICT', 'Le bail a changé entre-temps : rechargez-le.', 409, {
				expected: input.expectedLeaseVersion,
				current: lease.version
			});
		}
		if (input.type === 'rent_change') {
			const blocker = await this.leases.rentChangeBlockerFor(leaseId, input.effectiveFrom);
			if (blocker)
				throw new AppError(blocker, 'Ce changement de loyer serait refusé à cette date (échéance déjà émise ou hors période).', 409);
		}
		if (input.type === 'renewal') {
			const blocker = renewalBlocker(
				{ endsOn: lease.endsOn, status: lease.status },
				{ effectiveFrom: input.effectiveFrom, newEndsOn: input.newEndsOn }
			);
			if (blocker)
				throw new AppError(
					blocker,
					'Ce renouvellement n’est pas possible : il prend effet le lendemain de la fin, et prolonge le bail.',
					409
				);
		}
		const existing = await c.tx
			.select({ number: leaseAmendments.number })
			.from(leaseAmendments)
			.where(and(eq(leaseAmendments.organizationId, c.organizationId), eq(leaseAmendments.leaseId, leaseId)))
			.orderBy(desc(leaseAmendments.number))
			.limit(1);
		const [amendment] = await c.tx
			.insert(leaseAmendments)
			.values({
				id: input.id,
				organizationId: c.organizationId,
				leaseId,
				number: (existing[0]?.number ?? 0) + 1,
				type: input.type,
				effectiveFrom: input.effectiveFrom,
				newRent: input.rent,
				newCharges: input.charges,
				newEndsOn: input.newEndsOn,
				openEnded: input.openEnded,
				description: input.description,
				expectedLeaseVersion: input.expectedLeaseVersion,
				status: 'draft',
				createdBy: c.userId
			})
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'amendment.create',
			objectType: 'lease_amendment',
			objectId: input.id,
			after: { ...input, number: amendment!.number, leaseId, status: 'draft' }
		});
		await this.insertContract(c, signing, lease, amendment!);
		return this.get(signing.id);
	}

	async cancelAmendment(id: string, reason: string): Promise<AmendmentView> {
		const c = this.context();
		const row = await this.amendmentRow(c, id, true);
		if (row.status !== 'draft') throw new AppError('AMENDMENT_CLOSED', 'Un avenant appliqué ou annulé ne change plus.', 409);
		const now = new Date();
		const [updated] = await c.tx
			.update(leaseAmendments)
			.set({ status: 'cancelled', cancelledAt: now, cancellationReason: reason, updatedAt: now })
			.where(and(eq(leaseAmendments.organizationId, c.organizationId), eq(leaseAmendments.id, id)))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'amendment.cancel',
			objectType: 'lease_amendment',
			objectId: id,
			before: { status: 'draft' },
			after: { status: 'cancelled', reason }
		});
		const [contract] = await c.tx
			.select({ id: leaseContracts.id })
			.from(leaseContracts)
			.where(and(eq(leaseContracts.organizationId, c.organizationId), eq(leaseContracts.amendmentId, id)))
			.limit(1);
		return this.amendmentView(updated!, contract?.id ?? null);
	}

	/**
	 * Avenant signé : appliqué au bail par le même mécanisme que la route du lot 08 (changement de loyer : mêmes règles
	 * sur les échéances déjà émises ; renouvellement : version suivante, même caution, même historique).
	 */
	private async applyAmendment(c: Context, amendmentId: string): Promise<void> {
		const a = await this.amendmentRow(c, amendmentId, true);
		if (a.status !== 'draft') throw new AppError('AMENDMENT_CLOSED', 'Cet avenant est déjà appliqué ou annulé.', 409);
		let version: number | null = null;
		if (a.type === 'rent_change') {
			const lease = await this.leases.changeRent(
				a.leaseId,
				{ rent: a.newRent!, charges: a.newCharges!, effectiveFrom: a.effectiveFrom, expectedVersion: a.expectedLeaseVersion },
				{ amendmentId: a.id }
			);
			version = lease.version;
		} else if (a.type === 'renewal') {
			version = await this.leases.renewByAmendment(a.leaseId, {
				newEndsOn: a.openEnded ? null : a.newEndsOn,
				renewedOn: a.effectiveFrom,
				expectedVersion: a.expectedLeaseVersion,
				amendmentId: a.id
			});
		}
		const now = new Date();
		await c.tx
			.update(leaseAmendments)
			.set({ status: 'applied', appliedAt: now, appliedLeaseVersion: version, updatedAt: now })
			.where(and(eq(leaseAmendments.organizationId, c.organizationId), eq(leaseAmendments.id, amendmentId)));
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'amendment.apply',
			objectType: 'lease_amendment',
			objectId: amendmentId,
			before: { status: 'draft' },
			after: { status: 'applied', type: a.type, leaseVersion: version }
		});
	}

	async amendments(leaseId: string): Promise<AmendmentView[]> {
		const c = this.context();
		const rows = await c.tx
			.select()
			.from(leaseAmendments)
			.where(and(eq(leaseAmendments.organizationId, c.organizationId), eq(leaseAmendments.leaseId, leaseId)))
			.orderBy(asc(leaseAmendments.number));
		const contracts = rows.length
			? await c.tx
					.select({ id: leaseContracts.id, amendmentId: leaseContracts.amendmentId })
					.from(leaseContracts)
					.where(
						and(
							eq(leaseContracts.organizationId, c.organizationId),
							inArray(
								leaseContracts.amendmentId,
								rows.map((r) => r.id)
							)
						)
					)
			: [];
		return rows.map((r) => this.amendmentView(r, contracts.find((x) => x.amendmentId === r.id)?.id ?? null));
	}
}
