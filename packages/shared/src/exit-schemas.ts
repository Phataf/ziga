/**
 * Entrées et vues de la sortie du locataire (lot 10 bis, étape 3) : schémas Zod des routes et de la synchronisation,
 * réutilisés par les formulaires ; libellé d'une signature d'état des lieux (point 5 du porteur, même principe que D21).
 * Les règles elles-mêmes sont dans `tenant-exit.ts` et `deposit-settlement.ts`.
 */
import { z } from 'zod';
import { formatDate, isIsoDate } from './dates.js';
import { UPLOAD_MIME_TYPES } from './documents.js';
import { DISPUTE_OUTCOMES, INSPECTION_FINDINGS, REPAIR_PERFORMERS } from './deposit-settlement.js';
import { idSchema } from './ids.js';
import { fcfaSchema } from './money.js';
import { MAX_UPLOAD_BYTES } from './properties.js';
import {
	AGREEMENT_PARTIES,
	AGREEMENT_TYPES,
	INSPECTION_TYPES,
	inspectionDescriptionBlocker,
	NOTICE_DELIVERY_MODES,
	NOTICE_ORIGINS
} from './tenant-exit.js';

const isoDate = z.string().refine(isIsoDate, { error: 'Date invalide.' });
const optionalId = idSchema.nullish().transform((v) => v ?? null);
const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, { error: 'Champ trop long.' })
		.nullish()
		.transform((v) => (v ? v : null));

export const INSPECTION_DESCRIPTION_ERRORS = {
	INSPECTION_DESCRIPTION_VAGUE: 'Décrivez l’état : « bon état » seul ne suffit pas (article 9).',
	INSPECTION_DESCRIPTION_TOO_SHORT: 'Décrivez l’état en quelques mots (12 caractères au moins).'
} as const;

const description = z
	.string()
	.trim()
	.max(1000, { error: 'Description trop longue.' })
	.superRefine((v, ctx) => {
		const blocker = inspectionDescriptionBlocker(v);
		if (blocker) ctx.addIssue({ code: 'custom', message: INSPECTION_DESCRIPTION_ERRORS[blocker] });
	});

// ---------------------------------------------------------------- préavis

export const recordNoticeSchema = z.object({
	id: idSchema,
	origin: z.enum(NOTICE_ORIGINS),
	deliveryMode: z.enum(NOTICE_DELIVERY_MODES, { error: 'Choisissez le mode de notification.' }),
	proofDocumentId: optionalId,
	notifiedOn: isoDate,
	plannedExitOn: isoDate,
	reducedNotice: z.boolean().default(false),
	reason: optionalText(500)
});
export type RecordNoticeInput = z.input<typeof recordNoticeSchema>;
export type RecordNoticeData = z.output<typeof recordNoticeSchema>;

// ---------------------------------------------------------------- états des lieux

export const createInspectionSchema = z.object({
	id: idSchema,
	leaseId: idSchema,
	type: z.enum(INSPECTION_TYPES),
	inspectedOn: isoDate,
	furnished: z.boolean().default(false)
});
export type CreateInspectionData = z.output<typeof createInspectionSchema>;

export const inspectionItemSchema = z.object({
	id: idSchema,
	room: z.string().trim().min(1, { error: 'Indiquez la pièce.' }).max(80),
	element: z.string().trim().min(1, { error: 'Indiquez l’élément.' }).max(80),
	position: z.number().int().min(0).max(1000).default(0),
	description,
	finding: z
		.enum(INSPECTION_FINDINGS)
		.nullish()
		.transform((v) => v ?? null),
	entryItemId: optionalId
});
export type InspectionItemInput = z.input<typeof inspectionItemSchema>;
export type InspectionItemData = z.output<typeof inspectionItemSchema>;

export const updateInspectionItemSchema = inspectionItemSchema.omit({ id: true }).partial();
export type UpdateInspectionItemData = z.output<typeof updateInspectionItemSchema>;

/** Signature : un scan déposé, ou la case cochée par une partie sur l'appareil (horodatée, avec l'auteur de la saisie). */
export const signInspectionSchema = z.union([
	z.object({ party: z.enum(['organization', 'tenant']) }),
	z.object({ scanDocumentId: idSchema })
]);
export type SignInspectionData = z.output<typeof signInspectionSchema>;

export const disputeSchema = z.object({
	party: z.enum(['organization', 'tenant', 'owner']),
	observations: z.string().trim().min(5, { error: 'Indiquez les observations (5 caractères au moins).' }).max(2000)
});
export type DisputeData = z.output<typeof disputeSchema>;

export const disputeOutcomeSchema = z.object({ outcome: z.enum(DISPUTE_OUTCOMES), documentId: idSchema });
export type DisputeOutcomeData = z.output<typeof disputeOutcomeSchema>;

/**
 * Libellé d'une case cochée (point 5 du porteur) : jamais présentée comme une signature électronique (même principe que
 * D21). « Case cochée par … le … sur l'appareil de … ».
 */
export function inspectionCheckboxLabel(s: { signerName: string; signedAt: string; deviceOwnerName: string }): string {
	const at = new Date(s.signedAt);
	const time = at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Ouagadougou' });
	return `Case cochée par ${s.signerName} le ${formatDate(at)} à ${time} sur l’appareil de ${s.deviceOwnerName}`;
}

/** Libellé d'un scan d'état des lieux déposé (D21). */
export function inspectionScanLabel(s: { uploaderName: string; uploadedAt: string }): string {
	return `Signature manuscrite, scan déposé par ${s.uploaderName} le ${formatDate(new Date(s.uploadedAt))}`;
}

/**
 * Photo d'une ligne, ou scan signé d'un état des lieux (étape 4) : déposé par la route de l'état des lieux, ouverte à
 * l'agent de terrain sur ses unités (`inspection.create`), jamais par celle des documents. Une photo pointe vers sa
 * ligne ; le scan, vers l'état des lieux seul.
 */
export const INSPECTION_DOCUMENT_TYPES = ['inspection_photo', 'inspection_scan'] as const;
export const inspectionDocumentSchema = z
	.object({
		id: idSchema,
		type: z.enum(INSPECTION_DOCUMENT_TYPES),
		inspectionItemId: optionalId,
		fileName: z
			.string()
			.trim()
			.min(1, { error: 'Nom du fichier manquant.' })
			.max(200, { error: 'Nom du fichier trop long.' })
			.refine((v) => !v.includes('/') && !v.includes('\\') && ![...v].some((ch) => ch.charCodeAt(0) < 32), {
				error: 'Nom du fichier invalide.'
			}),
		mimeType: z.enum(UPLOAD_MIME_TYPES, { error: 'Format refusé : PDF, JPEG, PNG, WebP ou HEIC.' }),
		byteSize: z.number().int().min(1, { error: 'Fichier vide.' }).max(MAX_UPLOAD_BYTES, { error: 'Document trop lourd : 10 Mo au plus.' })
	})
	.refine((d) => (d.type === 'inspection_photo') === (d.inspectionItemId !== null), {
		error: 'Une photo se rattache à une ligne ; le scan, à l’état des lieux.',
		path: ['inspectionItemId']
	});
export type InspectionDocumentData = z.output<typeof inspectionDocumentSchema>;

// ---------------------------------------------------------------- réparations

export const createRepairSchema = z.object({
	id: idSchema,
	inspectionItemId: idSchema,
	description: z.string().trim().min(2, { error: 'Décrivez la réparation.' }).max(500),
	performedBy: z.enum(REPAIR_PERFORMERS),
	estimatedAmount: fcfaSchema
		.min(1)
		.nullish()
		.transform((v) => v ?? null),
	quoteDocumentId: optionalId,
	agreementId: optionalId
});
export type CreateRepairData = z.output<typeof createRepairSchema>;

export const repairDoneSchema = z.object({
	doneOn: isoDate,
	actualAmount: fcfaSchema
		.min(1)
		.nullish()
		.transform((v) => v ?? null),
	invoiceDocumentId: optionalId,
	/** Réparation faite par l'organisation : identifiant de la dépense créée (UUIDv7 de l'appareil ou du serveur). */
	expenseId: optionalId
});
export type RepairDoneData = z.output<typeof repairDoneSchema>;

export const repairVerifySchema = z.object({ verifiedOn: isoDate });

// ---------------------------------------------------------------- accords

export const createAgreementSchema = z.object({
	id: idSchema,
	leaseId: idSchema,
	type: z.enum(AGREEMENT_TYPES),
	proposedBy: z.enum(AGREEMENT_PARTIES),
	proposedOn: isoDate,
	description: optionalText(1000),
	months: z.array(isoDate).max(24).default([]),
	keptAmount: fcfaSchema.default(0),
	settlementId: optionalId
});
export type CreateAgreementData = z.output<typeof createAgreementSchema>;

export const decideAgreementSchema = z.object({
	decision: z.enum(['accepted', 'refused']),
	decidedByParty: z.enum(AGREEMENT_PARTIES),
	decidedOn: isoDate,
	reason: optionalText(500),
	documentId: optionalId
});
export type DecideAgreementData = z.output<typeof decideAgreementSchema>;

// ---------------------------------------------------------------- décompte

/** Ligne proposée depuis l'appareil (brouillon) : le serveur en calcule le montant et la refuse si elle n'est pas justifiée. */
export const settlementLineInputSchema = z.object({
	id: idSchema,
	settlementId: idSchema,
	kind: z.enum(['repair', 'rent_by_agreement']),
	repairId: optionalId,
	rentDueId: optionalId,
	agreementId: optionalId
});
export type SettlementLineInputData = z.output<typeof settlementLineInputSchema>;

export const REFUND_METHODS = ['cash', 'mobile_money', 'bank_transfer', 'cheque', 'other'] as const;

export const refundSchema = z.object({
	id: idSchema,
	amount: fcfaSchema.min(1, { error: 'Indiquez le montant restitué.' }),
	refundedOn: isoDate,
	/** Détenteur qui restitue : l'organisation, ou le propriétaire (« restituée par le propriétaire »). */
	refundedBy: z.enum(['organization', 'owner']),
	method: z.enum(REFUND_METHODS),
	reference: optionalText(60)
});
export type RefundData = z.output<typeof refundSchema>;

export const closeSettlementSchema = z.object({
	/** Restitution du reste (sans montant : le serveur le calcule). */
	refund: refundSchema
		.omit({ amount: true })
		.nullish()
		.transform((v) => v ?? null),
	/** Contestation : l'issue enregistrée (accord amiable ou décision de justice) avec son document. */
	disputeOutcome: z
		.enum(DISPUTE_OUTCOMES)
		.nullish()
		.transform((v) => v ?? null),
	documentId: optionalId
});
export type CloseSettlementData = z.output<typeof closeSettlementSchema>;

// ---------------------------------------------------------------- transfert de gestion

export const managementTransferSchema = z.object({
	id: idSchema,
	propertyId: idSchema,
	unitId: optionalId,
	transferOn: isoDate,
	newManagerName: z.string().trim().min(2, { error: 'Nommez le nouveau gestionnaire.' }).max(120),
	handedOverOn: isoDate,
	handedOverItems: z.array(z.string().trim().min(1).max(200)).min(1, { error: 'Indiquez les pièces remises.' }).max(50),
	note: optionalText(1000)
});
export type ManagementTransferData = z.output<typeof managementTransferSchema>;
