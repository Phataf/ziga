/**
 * Contrats de bail et avenants (lot 08 bis, CLAUDE.md règle 17, D20 à D25, D29) : règles pures partagées par l'API,
 * la tâche de génération et l'application.
 *
 * Cycle du contrat, distinct de celui du bail (D20) :
 *
 *   brouillon ──soumettre──▶ en vérification ──figer──▶ prêt à signer (FIGÉ) ──dépôt du scan──▶ signé
 *      ▲  régénérer : version N+1     │ corriger            │ modifier : version N+1, retour en vérification
 *      └──────────────────────────────┘◀────────────────────┘
 *
 * - Toute génération crée une version (numéro suivant), jamais écrasée, avec l'empreinte SHA-256 de ses fichiers.
 * - « Prêt à signer » est figé : le modifier crée la version suivante et le renvoie en vérification.
 * - Signé quand le scan signé est déposé : « Signature manuscrite, scan déposé par … le … », jamais « signé
 *   électroniquement » (D21). Le contrat signé d'un bail en brouillon le valide (même fonction que la validation).
 * - Légalisation et enregistrement : suivis, jamais bloquants.
 * - Un bail peut être en vigueur sans contrat signé, avec l'alerte « Contrat non signé » (D20).
 */
import { z } from 'zod';
import { addDays, addMonths, daysBetween, formatDate, isIsoDate } from './dates.js';
import {
	AMENDMENT_TYPES,
	CONTRACT_TEMPLATE_KINDS as CONTRACT_TEMPLATE_KINDS_LIST,
	leaseDurationMonths,
	type ContractTemplateKind
} from './contract-fields.js';
import { idSchema } from './ids.js';
import { depositAboveLegalCap, isLeaseInForce, type LeaseStatus, type LessorType } from './leases.js';
import { fcfaSchema, type Fcfa } from './money.js';

// ---------------------------------------------------------------- cycle du contrat

export const CONTRACT_STATUSES = ['draft', 'in_review', 'ready_to_sign', 'signed'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/**
 * `generated` : rempli par la plateforme à partir d'un modèle. `uploaded_scan` : contrat signé hors de la plateforme
 * et déposé tel quel (baux repris du lot 08, anciens baux) ; il naît signé, sans version générée.
 */
export const CONTRACT_ORIGINS = ['generated', 'uploaded_scan'] as const;
export type ContractOrigin = (typeof CONTRACT_ORIGINS)[number];

export const CONTRACT_TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
	draft: ['in_review'],
	in_review: ['draft', 'ready_to_sign'],
	// Modifier un contrat figé crée la version suivante et le renvoie en vérification.
	ready_to_sign: ['in_review', 'signed'],
	signed: []
};

export function canTransitionContract(from: ContractStatus, to: ContractStatus): boolean {
	return CONTRACT_TRANSITIONS[from].includes(to);
}

/** Une nouvelle version peut-elle être générée ? Brouillon et vérification : oui ; figé : seulement par « modifier ». */
export function canRegenerate(status: ContractStatus): boolean {
	return status === 'draft' || status === 'in_review';
}

/** Un contrat figé ou signé ne change plus : toute modification d'un contrat figé crée la version suivante. */
export function isFrozen(status: ContractStatus): boolean {
	return status === 'ready_to_sign' || status === 'signed';
}

// ---------------------------------------------------------------- signataires et signature

export const CONTRACT_PARTIES = ['organization', 'owner', 'tenant'] as const;
export type ContractParty = (typeof CONTRACT_PARTIES)[number];

/** Au MVP, une seule façon de signer : à la main, puis le scan est déposé (D21). */
export const SIGNATURE_MODES = ['handwritten_scan'] as const;
export type SignatureMode = (typeof SIGNATURE_MODES)[number];

/**
 * Signataires attendus : le représentant de l'organisation et le locataire, toujours ; le propriétaire aussi s'il est
 * le bailleur désigné et que son mandat ne permet pas à l'organisation de signer pour lui (`can_sign_leases`, D24).
 */
export function expectedSigners(input: { lessorType: LessorType; mandateCanSignLeases: boolean }): ContractParty[] {
	const out: ContractParty[] = ['organization'];
	if (input.lessorType === 'owner' && !input.mandateCanSignLeases) out.push('owner');
	out.push('tenant');
	return out;
}

/** Préfixe obligatoire de tout scan déposé (docs/UX.md §10). */
export const HANDWRITTEN_SCAN_LABEL = 'Signature manuscrite, scan déposé';

/**
 * Libellé d'un scan déposé, à l'écran comme dans les documents : « Signature manuscrite, scan déposé par Awa O. le
 * 15/11/2026 ». Jamais « signé électroniquement » (D21).
 */
export function signatureLabel(input: { recordedBy: string | null; recordedAt: string | Date }): string {
	const by = input.recordedBy?.trim() ? ` par ${input.recordedBy.trim()}` : '';
	return `${HANDWRITTEN_SCAN_LABEL}${by} le ${formatDate(input.recordedAt)}`;
}

// ---------------------------------------------------------------- contrôles avant génération et figement

export type ContractBlocker =
	| 'NO_MANAGEMENT_MANDATE'
	| 'LEASE_NOT_CONTRACTABLE'
	| 'DATES_INCOHERENT'
	| 'MISSING_FIELDS'
	| 'CONTRACT_OUTDATED'
	| 'TEMPLATE_HAS_UNKNOWN_FIELDS';

export type ContractWarning = 'DEPOSIT_ABOVE_LEGAL_CAP' | 'MISSING_FIELDS';

export interface ContractCheckInput {
	leaseStatus: LeaseStatus;
	startsOn: string;
	endsOn: string | null;
	/** Un mandat de gestion en vigueur de l'organisation couvre l'unité (sinon : pas de contrat). */
	hasManagementMandate: boolean;
	rent: Fcfa;
	security: { amount: Fcfa } | null;
	signingDate: string | null;
	/** Avenant : date d'effet (dans le bail) et nouvelle date de fin d'un renouvellement. */
	amendment?: { effectiveFrom: string; newEndsOn: string | null; type: (typeof AMENDMENT_TYPES)[number] } | null;
	/** Balises qui resteraient en blanc (`blankFields`). */
	blankFields: readonly string[];
	/** Balises du modèle absentes du catalogue. */
	unknownFields: readonly string[];
}

export interface ContractCheckResult {
	blockers: ContractBlocker[];
	warnings: ContractWarning[];
	/** Pour l'écran : les balises en blanc et les dates incohérentes, nommées. */
	blankFields: string[];
	dateIssues: ContractDateIssue[];
}

export type ContractDateIssue = 'END_BEFORE_START' | 'SIGNING_DATE_MISSING' | 'AMENDMENT_OUTSIDE_LEASE' | 'RENEWAL_NOT_AFTER_END';

function dateIssues(i: ContractCheckInput): ContractDateIssue[] {
	const out: ContractDateIssue[] = [];
	if (i.endsOn && i.endsOn < i.startsOn) out.push('END_BEFORE_START');
	if (!i.signingDate || !isIsoDate(i.signingDate)) out.push('SIGNING_DATE_MISSING');
	if (i.amendment) {
		const a = i.amendment;
		if (a.type === 'renewal') {
			if (i.endsOn && a.newEndsOn !== null && a.newEndsOn <= i.endsOn) out.push('RENEWAL_NOT_AFTER_END');
		} else if (a.effectiveFrom < i.startsOn || (i.endsOn && a.effectiveFrom > i.endsOn)) {
			out.push('AMENDMENT_OUTSIDE_LEASE');
		}
	}
	return out;
}

/**
 * Contrôles avant une génération (`stage: 'generate'`) ou avant le figement (`stage: 'freeze'`) :
 * - sans mandat de gestion en vigueur, ou pour un bail annulé ou terminé : refus ;
 * - dates incohérentes : refus ;
 * - balise inconnue dans le modèle : refus (le modèle n'aurait pas dû être activé) ;
 * - balises en blanc : la génération reste possible (le gestionnaire voit où compléter), le figement est refusé ;
 * - caution au-delà de deux mois de loyer : avertissement (journalisé par l'API), jamais un refus.
 */
export function contractChecks(input: ContractCheckInput, stage: 'generate' | 'freeze'): ContractCheckResult {
	const blockers: ContractBlocker[] = [];
	const warnings: ContractWarning[] = [];
	if (!input.hasManagementMandate) blockers.push('NO_MANAGEMENT_MANDATE');
	if (input.leaseStatus === 'cancelled' || input.leaseStatus === 'ended') blockers.push('LEASE_NOT_CONTRACTABLE');
	const issues = dateIssues(input);
	if (issues.length) blockers.push('DATES_INCOHERENT');
	if (input.unknownFields.length) blockers.push('TEMPLATE_HAS_UNKNOWN_FIELDS');
	if (input.blankFields.length) {
		if (stage === 'freeze') blockers.push('MISSING_FIELDS');
		else warnings.push('MISSING_FIELDS');
	}
	if (input.security && depositAboveLegalCap('security_deposit', input.security.amount, input.rent))
		warnings.push('DEPOSIT_ABOVE_LEGAL_CAP');
	return { blockers, warnings, blankFields: [...input.blankFields], dateIssues: issues };
}

// ---------------------------------------------------------------- alertes (calculées, jamais stockées)

export type ContractAlert =
	| 'lease_ends_in_4_months'
	| 'lease_ends_in_3_months'
	| 'term_reached_without_notice'
	| 'renewed_automatically'
	| 'signature_pending'
	| 'not_legalized'
	| 'contract_outdated'
	| 'amendment_pending';

/** Délai après lequel un contrat prêt à signer est signalé « en attente de signature ». */
export const SIGNATURE_PENDING_DAYS = 7;
/** Durée d'affichage du rappel mensuel de légalisation, et de l'avis de reconduction automatique. */
export const REMINDER_VISIBLE_DAYS = 7;
export const RENEWAL_NOTICE_VISIBLE_DAYS = 30;

/**
 * Alertes du terme d'un bail : fin à 4 mois, puis à 3 mois (le temps du préavis) ; terme dépassé sans congé (avant que
 * la tâche de nuit applique la reconduction) ; reconduction appliquée (30 jours).
 */
export function leaseTermAlerts(
	lease: { status: LeaseStatus; endsOn: string | null; noticeGivenOn: string | null; lastAutomaticRenewalOn: string | null },
	today: string
): ContractAlert[] {
	const out: ContractAlert[] = [];
	if (lease.lastAutomaticRenewalOn && daysBetween(lease.lastAutomaticRenewalOn, today) < RENEWAL_NOTICE_VISIBLE_DAYS) {
		out.push('renewed_automatically');
	}
	if (lease.status !== 'active' || !lease.endsOn || lease.noticeGivenOn) return out;
	if (today > lease.endsOn) out.push('term_reached_without_notice');
	else if (today >= addMonths(lease.endsOn, -3)) out.push('lease_ends_in_3_months');
	else if (today >= addMonths(lease.endsOn, -4)) out.push('lease_ends_in_4_months');
	return out;
}

export interface ContractForAlerts {
	status: ContractStatus;
	frozenAt: string | null;
	signedOn: string | null;
	legalizedOn: string | null;
	legalizationReminder: boolean;
	/** Le bail a changé depuis la version figée : le contrat doit être régénéré avant sa signature. */
	outdated: boolean;
	/** Contrat d'un avenant. */
	isAmendment: boolean;
}

/**
 * Alertes d'un contrat :
 * - prêt à signer depuis 7 jours ou plus : en attente de signature ;
 * - signé, non légalisé, rappel actif : visible 7 jours après chaque mois écoulé depuis la signature ;
 * - figé, mais le bail a changé : à régénérer ;
 * - avenant pas encore signé : à valider ou à signer.
 */
export function contractAlerts(c: ContractForAlerts, today: string): ContractAlert[] {
	const out: ContractAlert[] = [];
	if (c.status === 'ready_to_sign' && c.frozenAt && daysBetween(c.frozenAt.slice(0, 10), today) >= SIGNATURE_PENDING_DAYS) {
		out.push('signature_pending');
	}
	if (c.status === 'ready_to_sign' && c.outdated) out.push('contract_outdated');
	if (c.status === 'signed' && c.signedOn && !c.legalizedOn && c.legalizationReminder && monthlyReminderDue(c.signedOn, today)) {
		out.push('not_legalized');
	}
	if (c.isAmendment && c.status !== 'signed') out.push('amendment_pending');
	return out;
}

/** Vrai pendant les 7 jours qui suivent chaque mois écoulé depuis `from` (le premier rappel, un mois après). */
export function monthlyReminderDue(from: string, today: string): boolean {
	if (today <= from) return false;
	for (let n = 1; n <= 1200; n++) {
		const at = addMonths(from, n);
		if (at > today) return false;
		if (today < addDays(at, REMINDER_VISIBLE_DAYS)) return true;
	}
	return false;
}

/** Le bail est lié (signé à venir ou en vigueur) sans contrat signé : l'alerte « Contrat non signé » (D20). */
export function leaseNeedsSignedContract(status: LeaseStatus): boolean {
	return status === 'signed' || isLeaseInForce(status);
}

// ---------------------------------------------------------------- modèles

export const CONTRACT_TEMPLATE_STATUSES = ['draft', 'active', 'retired'] as const;
export type ContractTemplateStatus = (typeof CONTRACT_TEMPLATE_STATUSES)[number];

/** Modèle de la plateforme (D25) ou de l'organisation. */
export const CONTRACT_TEMPLATE_SOURCES = ['platform', 'organization'] as const;
export type ContractTemplateSource = (typeof CONTRACT_TEMPLATE_SOURCES)[number];

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Limites d'un modèle Word déposé (contrôlées par l'API, avant toute lecture ; l'écran prévient avant l'envoi). */
export const CONTRACT_TEMPLATE_LIMITS = {
	maxBytes: 5 * 1024 * 1024,
	maxUncompressedBytes: 30 * 1024 * 1024,
	maxEntries: 1000,
	/** Rapport de compression d'une entrée : un XML ordinaire reste loin en dessous ; une bombe le dépasse de loin. */
	maxCompressionRatio: 200
} as const;

/**
 * Modèle par défaut de la plateforme (D25). Tant qu'un juriste ne l'a pas relu, l'application l'indique à
 * l'organisation par un bandeau (jamais dans le document), et la première signature réelle est reportée.
 */
export const PLATFORM_TEMPLATES = {
	// Version 2 (étape 4) : corrections du porteur (signatures d'un seul tenant, pied de page, accords, dates en
	// lettres, premier mois au prorata, détenteur du dépôt, mandat du …). Les contrats déjà générés gardent la leur.
	// Bail, version 3 (lot 09, réponse du porteur) : article 4, « Un reçu de paiement est remis au Locataire à chaque
	// paiement » (le document s'appelle toujours « Reçu de paiement », jamais « quittance »).
	lease: { version: 3, legalReview: 'pending' },
	amendment: { version: 2, legalReview: 'pending' }
} as const satisfies Record<ContractTemplateKind, { version: number; legalReview: 'pending' | 'approved' }>;

/** Bandeau « modèle par défaut non relu » : seulement pour un contrat ou un réglage qui utilise ce modèle. */
export function showDefaultTemplateBanner(source: ContractTemplateSource, kind: ContractTemplateKind): boolean {
	return source === 'platform' && PLATFORM_TEMPLATES[kind].legalReview === 'pending';
}

/** Un modèle ne s'active que sans balise inconnue, et après une inspection réussie. */
export function templateActivationBlocker(t: {
	status: ContractTemplateStatus;
	inspected: boolean;
	unknownFields: readonly string[];
}): 'TEMPLATE_NOT_INSPECTED' | 'TEMPLATE_HAS_UNKNOWN_FIELDS' | 'TEMPLATE_RETIRED' | null {
	if (t.status === 'retired') return 'TEMPLATE_RETIRED';
	if (!t.inspected) return 'TEMPLATE_NOT_INSPECTED';
	if (t.unknownFields.length) return 'TEMPLATE_HAS_UNKNOWN_FIELDS';
	return null;
}

// ---------------------------------------------------------------- schémas

const isoDate = z.string().refine(isIsoDate, { error: 'Date invalide.' });
const optionalIsoDate = isoDate.nullish().transform((v) => v ?? null);
const reason = z.string().trim().min(3, { error: 'Indiquez le motif.' }).max(500, { error: 'Motif trop long.' });
const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, { error: 'Champ trop long.' })
		.nullish()
		.transform((v) => (v ? v : null));

/** Lieu, date et nombre d'exemplaires : saisis à la génération. */
export const contractSigningSchema = z.object({
	signingPlace: z.string().trim().min(2, { error: 'Indiquez le lieu de signature.' }).max(120, { error: 'Lieu trop long.' }),
	signingDate: isoDate,
	copies: z
		.number({ error: 'Nombre d’exemplaires : un nombre entier.' })
		.int({ error: 'Nombre d’exemplaires : un nombre entier.' })
		.min(1, { error: 'Au moins un exemplaire.' })
		.max(10, { error: 'Dix exemplaires au plus.' })
});
export type ContractSigningInput = z.output<typeof contractSigningSchema>;

/** Création du contrat d'un bail : génère la version 1. */
export const createContractSchema = contractSigningSchema.extend({ id: idSchema });
export type CreateContractData = z.output<typeof createContractSchema>;

/** Nouvelle version (brouillon, vérification, ou « modifier » un contrat figé). */
export const regenerateContractSchema = contractSigningSchema.partial().extend({
	/** Version courante attendue : jamais « dernière écriture gagnante » sur un document figé. */
	expectedVersion: z.number().int().min(1)
});

export const freezeContractSchema = z.object({ expectedVersion: z.number().int().min(1) });

/** Dépôt du scan signé : le document déposé, et la date de signature de chaque partie attendue. */
export const signedScanSchema = z.object({
	documentId: idSchema,
	expectedVersion: z.number().int().min(1),
	signedOn: z.object({
		organization: optionalIsoDate,
		owner: optionalIsoDate,
		tenant: optionalIsoDate
	})
});
export type SignedScanData = z.output<typeof signedScanSchema>;

/** Les dates de signature : chaque partie attendue en a une, aucune n'est dans le futur ni avant le figement. */
export function signatureDatesIssues(
	signers: readonly ContractParty[],
	signedOn: Readonly<Record<ContractParty, string | null>>,
	bounds: { frozenOn: string; today: string }
): ContractParty[] {
	return signers.filter((p) => {
		const d = signedOn[p];
		return !d || d > bounds.today || d < bounds.frozenOn;
	});
}

/** Contrat signé hors plateforme, déposé tel quel (anciens baux) : il naît signé, sans version générée. */
export const uploadedScanSchema = z.object({ id: idSchema, documentId: idSchema });

export const legalizationSchema = z.object({
	legalizedOn: isoDate,
	commune: z.string().trim().min(2, { error: 'Indiquez la commune.' }).max(120),
	reference: optionalText(120),
	documentId: idSchema.nullish().transform((v) => v ?? null)
});
export type LegalizationData = z.output<typeof legalizationSchema>;

export const registrationSchema = z.object({
	registeredOn: isoDate,
	reference: optionalText(120),
	documentId: idSchema.nullish().transform((v) => v ?? null)
});
export type RegistrationData = z.output<typeof registrationSchema>;

export const legalizationReminderSchema = z.object({ enabled: z.boolean() });

// ---------------------------------------------------------------- avenants

export const AMENDMENT_STATUSES = ['draft', 'applied', 'cancelled'] as const;
export type AmendmentStatus = (typeof AMENDMENT_STATUSES)[number];

export const createAmendmentSchema = z
	.object({
		id: idSchema,
		type: z.enum(AMENDMENT_TYPES),
		effectiveFrom: isoDate,
		/** Changement de loyer : nouveaux loyer et charges. */
		rent: fcfaSchema
			.min(1, { error: 'Indiquez le loyer.' })
			.nullish()
			.transform((v) => v ?? null),
		charges: fcfaSchema.nullish().transform((v) => v ?? null),
		/** Renouvellement : nouvelle date de fin, ou durée indéterminée. */
		newEndsOn: optionalIsoDate,
		openEnded: z.boolean().default(false),
		description: optionalText(4000),
		/** Version du bail sur laquelle l'avenant est rédigé (contrôlée encore à la signature). */
		expectedLeaseVersion: z.number().int().min(1)
	})
	.superRefine((a, ctx) => {
		if (a.type === 'rent_change' && (a.rent === null || a.charges === null)) {
			ctx.addIssue({ code: 'custom', path: ['rent'], message: 'Indiquez le nouveau loyer et les charges.' });
		}
		if (a.type === 'renewal' && !a.openEnded && !a.newEndsOn) {
			ctx.addIssue({ code: 'custom', path: ['newEndsOn'], message: 'Indiquez la nouvelle date de fin, ou une durée indéterminée.' });
		}
		if (a.type === 'renewal' && a.openEnded && a.newEndsOn) {
			ctx.addIssue({ code: 'custom', path: ['newEndsOn'], message: 'Une durée indéterminée n’a pas de date de fin.' });
		}
		if (a.type === 'other' && !a.description) {
			ctx.addIssue({ code: 'custom', path: ['description'], message: 'Décrivez la modification.' });
		}
		if (a.type !== 'rent_change' && (a.rent !== null || a.charges !== null)) {
			ctx.addIssue({ code: 'custom', path: ['rent'], message: 'Seul un avenant de loyer change le loyer.' });
		}
	});
export type CreateAmendmentInput = z.input<typeof createAmendmentSchema>;
export type CreateAmendmentData = z.output<typeof createAmendmentSchema>;

export const cancelAmendmentSchema = z.object({ reason });

/**
 * Renouvellement : la date d'effet est le lendemain de la fin actuelle ; la nouvelle fin la suit (ou durée
 * indéterminée). Un bail déjà sans fin ne se renouvelle pas.
 */
export function renewalBlocker(
	lease: { endsOn: string | null; status: LeaseStatus },
	amendment: { effectiveFrom: string; newEndsOn: string | null }
): 'LEASE_OPEN_ENDED' | 'LEASE_NOT_IN_FORCE' | 'RENEWAL_EFFECTIVE_DATE' | 'RENEWAL_NOT_AFTER_END' | null {
	if (!isLeaseInForce(lease.status) && lease.status !== 'signed') return 'LEASE_NOT_IN_FORCE';
	if (!lease.endsOn) return 'LEASE_OPEN_ENDED';
	if (amendment.effectiveFrom !== addDays(lease.endsOn, 1)) return 'RENEWAL_EFFECTIVE_DATE';
	if (amendment.newEndsOn !== null && amendment.newEndsOn <= lease.endsOn) return 'RENEWAL_NOT_AFTER_END';
	return null;
}

/**
 * Nouvelle fin d'un bail reconduit à son terme sans congé, selon son paramètre (D24) ; `null` : durée indéterminée.
 * « Même durée » : le même nombre de mois entiers, ou, si la durée initiale n'en est pas un, le même nombre de jours.
 */
export function automaticRenewalEnd(lease: {
	endsOn: string;
	startsOn: string;
	durationMonths: number | null;
	renewalMode: 'open_ended' | 'same_duration';
}): string | null {
	if (lease.renewalMode === 'open_ended') return null;
	const next = addDays(lease.endsOn, 1);
	const months = leaseDurationMonths(lease);
	if (months) return addDays(addMonths(next, months), -1);
	return addDays(lease.endsOn, daysBetween(lease.startsOn, lease.endsOn) + 1);
}

// ---------------------------------------------------------------- dépôts et vues (API et appareil)

/** Dépôt d'un fichier du contrat (modèle Word, scan signé, preuve) : la fiche naît en attente, l'URL signe le fichier. */
export const contractFileSchema = z.object({
	id: idSchema,
	fileName: z
		.string()
		.trim()
		.min(1, { error: 'Nom du fichier manquant.' })
		.max(200, { error: 'Nom du fichier trop long.' })
		.refine((v) => !v.includes('/') && !v.includes('\\') && ![...v].some((c) => c.charCodeAt(0) < 32), {
			error: 'Nom du fichier invalide.'
		}),
	byteSize: z.number().int().min(1, { error: 'Fichier vide.' })
});

/** Modèle Word : un .docx de 5 Mo au plus. */
export const createTemplateSchema = contractFileSchema.extend({
	documentId: idSchema,
	kind: z.enum(CONTRACT_TEMPLATE_KINDS_LIST),
	name: z.string().trim().min(2, { error: 'Indiquez le nom du modèle.' }).max(120, { error: 'Nom trop long.' }),
	byteSize: z
		.number()
		.int()
		.min(1, { error: 'Fichier vide.' })
		.max(CONTRACT_TEMPLATE_LIMITS.maxBytes, { error: 'Modèle trop lourd : 5 Mo au plus.' }),
	fileName: contractFileSchema.shape.fileName.refine((v) => v.toLowerCase().endsWith('.docx'), {
		error: 'Seul un document Word .docx est accepté.'
	})
});
export type CreateTemplateData = z.output<typeof createTemplateSchema>;

/** Scan signé (PDF ou images assemblées en PDF sur l'appareil), preuve de légalisation ou d'enregistrement. */
export const CONTRACT_PROOF_KINDS = ['signed_scan', 'legalization', 'registration'] as const;
export const contractUploadSchema = contractFileSchema.extend({
	kind: z.enum(CONTRACT_PROOF_KINDS),
	mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png'], { error: 'Format refusé : PDF, JPEG ou PNG.' }),
	byteSize: z
		.number()
		.int()
		.min(1, { error: 'Fichier vide.' })
		.max(10 * 1024 * 1024, { error: 'Fichier trop lourd : 10 Mo au plus.' })
});
export type ContractUploadData = z.output<typeof contractUploadSchema>;

export interface ContractTemplateView {
	id: string;
	kind: ContractTemplateKind;
	name: string;
	version: number;
	replacesId: string | null;
	documentId: string;
	status: ContractTemplateStatus;
	inspectedAt: string | null;
	inspectionError: string | null;
	detectedFields: string[];
	unknownFields: string[];
	unmatchedFonts: string[];
	pageCount: number | null;
	/** Dernier aperçu PDF généré avec les données d'exemple (document du registre). */
	previewDocumentId: string | null;
	activatedAt: string | null;
	retiredAt: string | null;
	createdAt: string;
}

/** Modèle utilisé pour un type : celui de l'organisation s'il est actif, sinon celui de la plateforme (D25). */
export interface TemplatesOverview {
	templates: ContractTemplateView[];
	inUse: Record<
		ContractTemplateKind,
		{ source: ContractTemplateSource; templateId: string | null; version: number; legalReviewPending: boolean }
	>;
}

export interface ContractVersionView {
	id: string;
	number: number;
	leaseVersion: number;
	templateSource: ContractTemplateSource;
	templateId: string | null;
	templateVersion: number;
	blankFields: string[];
	warnings: string[];
	docxDocumentId: string;
	pdfDocumentId: string;
	docxSha256: string;
	pdfSha256: string;
	pageCount: number | null;
	createdBy: string | null;
	createdAt: string;
}

export interface AmendmentView {
	id: string;
	leaseId: string;
	number: number;
	type: (typeof AMENDMENT_TYPES)[number];
	effectiveFrom: string;
	newRent: Fcfa | null;
	newCharges: Fcfa | null;
	newEndsOn: string | null;
	openEnded: boolean;
	description: string | null;
	expectedLeaseVersion: number;
	status: AmendmentStatus;
	appliedAt: string | null;
	appliedLeaseVersion: number | null;
	cancelledAt: string | null;
	cancellationReason: string | null;
	contractId: string | null;
	createdAt: string;
}

export interface ContractView {
	id: string;
	leaseId: string;
	amendmentId: string | null;
	origin: ContractOrigin;
	templateSource: ContractTemplateSource | null;
	templateId: string | null;
	templateVersion: number | null;
	status: ContractStatus;
	currentVersion: number;
	frozenVersion: number | null;
	frozenAt: string | null;
	generationStatus: 'idle' | 'pending' | 'failed';
	generationError: string | null;
	signingPlace: string | null;
	signingDate: string | null;
	copies: number | null;
	expectedSigners: ContractParty[] | null;
	signedOn: Record<ContractParty, string | null>;
	signatureMode: SignatureMode | null;
	signedDocumentId: string | null;
	/** « Signature manuscrite, scan déposé par … le … » ; jamais « signé électroniquement » (D21). */
	signatureLabel: string | null;
	legalizedOn: string | null;
	legalizationCommune: string | null;
	legalizationReference: string | null;
	legalizationDocumentId: string | null;
	registeredOn: string | null;
	registrationReference: string | null;
	registrationDocumentId: string | null;
	legalizationReminder: boolean;
	/** Le bail a changé depuis la version figée : à régénérer avant la signature. */
	outdated: boolean;
	alerts: ContractAlert[];
	/** Modèle par défaut non encore relu par un juriste (D25) : bandeau dans l'application, jamais dans le document. */
	defaultTemplateNotice: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ContractDetailView extends ContractView {
	versions: ContractVersionView[];
	amendment: AmendmentView | null;
}

/** Valeurs résolues d'une version (lues en ligne : elles contiennent l'état civil). */
export interface ContractVersionFields {
	number: number;
	fields: Record<string, string | boolean | null>;
	blankFields: string[];
}
