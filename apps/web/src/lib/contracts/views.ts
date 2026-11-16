/**
 * Contrats sur l'appareil (lot 08 bis) : lignes de la base locale → vues des écrans, filtres et alertes. Fonctions pures,
 * testées sans navigateur (views.test.ts).
 *
 * Les alertes se calculent ici avec les mêmes fonctions que le serveur (packages/shared/contracts.ts). Une seule
 * différence : « à régénérer » (le bail a changé depuis la version figée) compare, sur l'appareil, la version du bail
 * figée à la version actuelle ; le serveur compare les conditions elles-mêmes et fait foi (fiche du contrat, en ligne,
 * et refus du figement ou de la signature).
 */
import { CONTRACT_TEMPLATE_KINDS } from '@ziga/shared/contract-fields';
import {
	PLATFORM_TEMPLATES,
	contractAlerts,
	leaseTermAlerts,
	showDefaultTemplateBanner,
	signatureLabel,
	type AmendmentView,
	type ContractAlert,
	type ContractParty,
	type ContractStatus,
	type ContractTemplateView,
	type ContractVersionView,
	type ContractView,
	type TemplatesOverview
} from '@ziga/shared/contracts';
import type { LeaseStatus } from '@ziga/shared/leases';
import { jsonArray } from '../sync/views';

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const int = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';

export function toContractVersion(r: Row): ContractVersionView {
	return {
		id: String(r.id),
		number: int(r.number) ?? 1,
		leaseVersion: int(r.lease_version) ?? 1,
		templateSource: (str(r.template_source) ?? 'platform') as ContractVersionView['templateSource'],
		templateId: str(r.template_id),
		templateVersion: int(r.template_version) ?? 1,
		blankFields: jsonArray(r.blank_fields),
		warnings: jsonArray(r.warnings),
		docxDocumentId: String(r.docx_document_id ?? ''),
		pdfDocumentId: String(r.pdf_document_id ?? ''),
		docxSha256: String(r.docx_sha256 ?? ''),
		pdfSha256: String(r.pdf_sha256 ?? ''),
		pageCount: int(r.page_count),
		createdBy: str(r.created_by),
		createdAt: String(r.created_at ?? '')
	};
}

export function toAmendment(r: Row, contractId: string | null = null): AmendmentView {
	return {
		id: String(r.id),
		leaseId: String(r.lease_id ?? ''),
		number: int(r.number) ?? 1,
		type: (str(r.type) ?? 'other') as AmendmentView['type'],
		effectiveFrom: String(r.effective_from ?? ''),
		newRent: int(r.new_rent),
		newCharges: int(r.new_charges),
		newEndsOn: str(r.new_ends_on),
		openEnded: bool(r.open_ended),
		description: str(r.description),
		expectedLeaseVersion: int(r.expected_lease_version) ?? 1,
		status: (str(r.status) ?? 'draft') as AmendmentView['status'],
		appliedAt: str(r.applied_at),
		appliedLeaseVersion: int(r.applied_lease_version),
		cancelledAt: str(r.cancelled_at),
		cancellationReason: str(r.cancellation_reason),
		contractId,
		createdAt: String(r.created_at ?? '')
	};
}

export function toTemplate(r: Row, previewDocumentId: string | null = null): ContractTemplateView {
	return {
		id: String(r.id),
		kind: (str(r.kind) ?? 'lease') as ContractTemplateView['kind'],
		name: String(r.name ?? ''),
		version: int(r.version) ?? 1,
		replacesId: str(r.replaces_id),
		documentId: String(r.document_id ?? ''),
		status: (str(r.status) ?? 'draft') as ContractTemplateView['status'],
		inspectedAt: str(r.inspected_at),
		inspectionError: str(r.inspection_error),
		detectedFields: jsonArray(r.detected_fields),
		unknownFields: jsonArray(r.unknown_fields),
		unmatchedFonts: jsonArray(r.unmatched_fonts),
		pageCount: int(r.page_count),
		previewDocumentId,
		activatedAt: str(r.activated_at),
		retiredAt: str(r.retired_at),
		createdAt: String(r.created_at ?? '')
	};
}

/** Date de signature retenue pour les rappels : la première partie connue, sinon le jour de l'enregistrement du scan. */
function signedOnOf(r: Row): string | null {
	const at = str(r.signature_recorded_at);
	return str(r.organization_signed_on) ?? str(r.tenant_signed_on) ?? str(r.owner_signed_on) ?? (at ? at.slice(0, 10) : null);
}

export interface ContractContext {
	/** Version actuelle du bail (pour « à régénérer »). */
	leaseVersion: number | null;
	/** Version du bail de la version figée. */
	frozenLeaseVersion: number | null;
	/** Nom de qui a enregistré la signature (membre de l'organisation). */
	recordedByName: string | null;
	today: string;
}

export function toContract(r: Row, ctx: ContractContext): ContractView {
	const status = (str(r.status) ?? 'draft') as ContractStatus;
	const isAmendment = !!str(r.amendment_id);
	const outdated =
		status === 'ready_to_sign' && ctx.leaseVersion !== null && ctx.frozenLeaseVersion !== null && ctx.leaseVersion > ctx.frozenLeaseVersion;
	const recordedAt = str(r.signature_recorded_at);
	const templateSource = str(r.template_source) as ContractView['templateSource'];
	const signers = jsonArray(r.expected_signers) as ContractParty[];
	return {
		id: String(r.id),
		leaseId: String(r.lease_id ?? ''),
		amendmentId: str(r.amendment_id),
		origin: (str(r.origin) ?? 'generated') as ContractView['origin'],
		templateSource,
		templateId: str(r.template_id),
		templateVersion: int(r.template_version),
		status,
		currentVersion: int(r.current_version) ?? 0,
		frozenVersion: int(r.frozen_version),
		frozenAt: str(r.frozen_at),
		generationStatus: (str(r.generation_status) ?? 'idle') as ContractView['generationStatus'],
		generationError: str(r.generation_error),
		signingPlace: str(r.signing_place),
		signingDate: str(r.signing_date),
		copies: int(r.copies),
		expectedSigners: signers.length ? signers : null,
		signedOn: { organization: str(r.organization_signed_on), owner: str(r.owner_signed_on), tenant: str(r.tenant_signed_on) },
		signatureMode: str(r.signature_mode) as ContractView['signatureMode'],
		signedDocumentId: str(r.signed_document_id),
		signatureLabel: recordedAt ? signatureLabel({ recordedBy: ctx.recordedByName, recordedAt }) : null,
		legalizedOn: str(r.legalized_on),
		legalizationCommune: str(r.legalization_commune),
		legalizationReference: str(r.legalization_reference),
		legalizationDocumentId: str(r.legalization_document_id),
		registeredOn: str(r.registered_on),
		registrationReference: str(r.registration_reference),
		registrationDocumentId: str(r.registration_document_id),
		legalizationReminder: r.legalization_reminder === undefined || r.legalization_reminder === null ? true : bool(r.legalization_reminder),
		outdated,
		alerts: contractAlerts(
			{
				status,
				frozenAt: str(r.frozen_at),
				signedOn: signedOnOf(r),
				legalizedOn: str(r.legalized_on),
				legalizationReminder:
					r.legalization_reminder === undefined || r.legalization_reminder === null ? true : bool(r.legalization_reminder),
				outdated,
				isAmendment
			},
			ctx.today
		),
		defaultTemplateNotice: templateSource === 'platform' && showDefaultTemplateBanner('platform', isAmendment ? 'amendment' : 'lease'),
		createdAt: String(r.created_at ?? ''),
		updatedAt: String(r.updated_at ?? '')
	};
}

// ---------------------------------------------------------------- liste des contrats

/** Statut du contrat d'un bail, pour la liste : « aucun » quand le bail n'a pas encore de contrat. */
export type LeaseContractState = ContractStatus | 'none';

export interface ContractListItem {
	leaseId: string;
	leaseStatus: LeaseStatus;
	unitLabel: string;
	tenantName: string;
	startsOn: string;
	endsOn: string | null;
	/** Contrat du bail lui-même (pas d'un avenant), le plus récent. */
	contract: ContractView | null;
	state: LeaseContractState;
	/** Avenants en cours (contrat pas encore signé). */
	pendingAmendments: number;
	/** Alertes du contrat et du terme du bail, plus « contrat non signé » pour un bail lié sans contrat signé. */
	alerts: (ContractAlert | 'contract_unsigned')[];
}

export interface ContractFilters {
	leaseStatus: LeaseStatus | 'all';
	contractState: LeaseContractState | 'all';
	alertsOnly: boolean;
}

export const DEFAULT_CONTRACT_FILTERS: ContractFilters = { leaseStatus: 'all', contractState: 'all', alertsOnly: false };

interface LeaseLike {
	id: string;
	status: LeaseStatus;
	startsOn: string;
	endsOn: string | null;
	noticeGivenOn: string | null;
	lastAutomaticRenewalOn: string | null;
	unitLabel: string;
	tenantName: string;
}

/** Une ligne par bail (hors annulés) : son contrat, ses avenants en cours, ses alertes. */
export function contractList(leases: readonly LeaseLike[], contracts: readonly ContractView[], today: string): ContractListItem[] {
	const byLease = new Map<string, ContractView[]>();
	for (const c of contracts) byLease.set(c.leaseId, [...(byLease.get(c.leaseId) ?? []), c]);
	return leases
		.filter((l) => l.status !== 'cancelled')
		.map((l) => {
			const all = byLease.get(l.id) ?? [];
			const own = all.filter((c) => !c.amendmentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			const signed = own.find((c) => c.status === 'signed');
			const contract = signed ?? own[0] ?? null;
			const amendments = all.filter((c) => c.amendmentId && c.status !== 'signed');
			const alerts: ContractListItem['alerts'] = [
				...(contract?.alerts ?? []),
				...amendments.flatMap((c) => c.alerts.filter((a) => a !== 'amendment_pending')),
				...(amendments.length ? (['amendment_pending'] as const) : []),
				...leaseTermAlerts(l, today)
			];
			if (!signed && ['signed', 'active', 'notice'].includes(l.status)) alerts.unshift('contract_unsigned');
			return {
				leaseId: l.id,
				leaseStatus: l.status,
				unitLabel: l.unitLabel,
				tenantName: l.tenantName,
				startsOn: l.startsOn,
				endsOn: l.endsOn,
				contract,
				state: contract?.status ?? 'none',
				pendingAmendments: amendments.length,
				alerts: [...new Set(alerts)]
			};
		});
}

export function filterContracts(items: readonly ContractListItem[], f: ContractFilters): ContractListItem[] {
	return items.filter(
		(i) =>
			(f.leaseStatus === 'all' || i.leaseStatus === f.leaseStatus) &&
			(f.contractState === 'all' || i.state === f.contractState) &&
			(!f.alertsOnly || i.alerts.length > 0)
	);
}

// ---------------------------------------------------------------- modèles

/** Modèle utilisé pour chaque type : l'actif de l'organisation, sinon celui de la plateforme (D25), comme le serveur. */
export function templatesInUse(templates: readonly ContractTemplateView[]): TemplatesOverview['inUse'] {
	const out = {} as TemplatesOverview['inUse'];
	for (const kind of CONTRACT_TEMPLATE_KINDS) {
		const active = templates.find((t) => t.kind === kind && t.status === 'active');
		out[kind] = active
			? { source: 'organization', templateId: active.id, version: active.version, legalReviewPending: false }
			: {
					source: 'platform',
					templateId: null,
					version: PLATFORM_TEMPLATES[kind].version,
					legalReviewPending: showDefaultTemplateBanner('platform', kind)
				};
	}
	return out;
}

// ---------------------------------------------------------------- chronologie

export type ContractEvent =
	| { kind: 'created'; at: string }
	| { kind: 'version'; at: string; number: number }
	| { kind: 'frozen'; at: string; number: number }
	| { kind: 'signed'; at: string }
	| { kind: 'legalized'; at: string }
	| { kind: 'registered'; at: string }
	| { kind: 'amendmentApplied'; at: string }
	| { kind: 'amendmentCancelled'; at: string };

/** Chronologie d'un contrat, la plus récente d'abord ; les dates d'instant gardent leur jour. */
export function contractTimeline(
	c: ContractView,
	versions: readonly ContractVersionView[],
	amendment: AmendmentView | null = null
): ContractEvent[] {
	const events: ContractEvent[] = [{ kind: 'created', at: c.createdAt }];
	for (const v of versions) events.push({ kind: 'version', at: v.createdAt, number: v.number });
	if (c.frozenAt && c.frozenVersion) events.push({ kind: 'frozen', at: c.frozenAt, number: c.frozenVersion });
	const signedOn = c.signedOn.organization ?? c.signedOn.tenant ?? c.signedOn.owner;
	if (c.status === 'signed' && signedOn) events.push({ kind: 'signed', at: signedOn });
	if (c.legalizedOn) events.push({ kind: 'legalized', at: c.legalizedOn });
	if (c.registeredOn) events.push({ kind: 'registered', at: c.registeredOn });
	if (amendment?.appliedAt) events.push({ kind: 'amendmentApplied', at: amendment.appliedAt });
	if (amendment?.cancelledAt) events.push({ kind: 'amendmentCancelled', at: amendment.cancelledAt });
	const order = (e: ContractEvent) =>
		['created', 'version', 'frozen', 'signed', 'amendmentApplied', 'amendmentCancelled', 'legalized', 'registered'].indexOf(e.kind);
	return events.sort((a, b) => b.at.slice(0, 10).localeCompare(a.at.slice(0, 10)) || order(b) - order(a));
}

/** Parties attendues et leur date, dans l'ordre du contrat. */
export function signerDates(c: ContractView): { party: ContractParty; date: string | null }[] {
	return (c.expectedSigners ?? []).map((party) => ({ party, date: c.signedOn[party] }));
}
