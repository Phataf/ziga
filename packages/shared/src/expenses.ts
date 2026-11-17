/**
 * Dépenses (lot 10, CLAUDE.md règle 16) : une dépense est **un seul enregistrement**. Elle dit qui a payé le
 * prestataire, qui la supporte au final et comment elle est récupérée. Elle n'est jamais copiée : le relevé du
 * propriétaire, la créance sur le locataire et (lot 10 bis) la retenue sur caution renvoient à la même ligne.
 *
 * - Ajout seul : une erreur se corrige par une annulation motivée (directeur), jamais par une modification du montant
 *   ni des trois rôles.
 * - La commission de gestion n'est pas une dépense : elle se calcule au relevé (statements.ts).
 * - Combinaisons admises au lot 10 (réponse du porteur) : voir `EXPENSE_COMBINATIONS`. Les autres (un locataire qui
 *   avance une dépense pour le propriétaire, par exemple) demandent un accord : lot 10 bis.
 */
import { z } from 'zod';
import { isIsoDate } from './dates.js';
import { idSchema } from './ids.js';
import { fcfaSchema, type Fcfa } from './money.js';
import type { OrganizationType } from './permissions.js';

/**
 * Catégories. Le prompt cite deux fois « électricité » : les travaux (`electrical_work`) et la facture
 * (`electricity_bill`) ; l'eau est une facture (`water_bill`).
 */
export const EXPENSE_CATEGORIES = [
	'plumbing',
	'electrical_work',
	'carpentry',
	'painting',
	'maintenance',
	'tax',
	'water_bill',
	'electricity_bill',
	'security_guard',
	'other'
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Libellés des catégories : les mêmes à l'écran, dans le PDF du relevé et sur la page partagée. */
export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
	plumbing: 'Plomberie',
	electrical_work: 'Électricité (travaux)',
	carpentry: 'Menuiserie',
	painting: 'Peinture',
	maintenance: 'Entretien',
	tax: 'Taxe',
	water_bill: 'Eau (facture)',
	electricity_bill: 'Électricité (facture)',
	security_guard: 'Gardiennage',
	other: 'Autre'
};

/** Qui a payé le prestataire. */
export const EXPENSE_PAYERS = ['organization', 'owner', 'tenant'] as const;
export type ExpensePayer = (typeof EXPENSE_PAYERS)[number];

/** Qui supporte la dépense au final. */
export const EXPENSE_BEARERS = ['owner', 'organization', 'tenant'] as const;
export type ExpenseBearer = (typeof EXPENSE_BEARERS)[number];

/** Comment elle est récupérée. */
export const EXPENSE_RECOVERIES = ['owner_statement', 'deposit', 'claimed_from_tenant', 'none'] as const;
export type ExpenseRecovery = (typeof EXPENSE_RECOVERIES)[number];

/** Effet d'une dépense, déduit de ses trois rôles. */
export type ExpenseEffect =
	/** Avancée par l'organisation pour le propriétaire : déduite une seule fois de son relevé. */
	| 'statement_deduction'
	/** Supportée par l'organisation : n'apparaît nulle part ailleurs. */
	| 'organization_cost'
	/** Due par le locataire : elle s'ajoute à ses impayés et se relance ; encaissée par un paiement « dépense ». */
	| 'tenant_claim'
	/** Retenue sur la caution du locataire au décompte de sortie (lot 10 bis). */
	| 'deposit_retention'
	/** Réglée directement par le propriétaire : information sur son relevé, hors du net. */
	| 'owner_paid'
	/** Réparation faite et payée par le locataire : information seulement. */
	| 'tenant_paid';

export interface ExpenseRoles {
	paidBy: ExpensePayer;
	borneBy: ExpenseBearer;
	recovery: ExpenseRecovery;
}

/** Combinaisons admises au lot 10, et leur effet (plan validé par le porteur). */
export const EXPENSE_COMBINATIONS: readonly (ExpenseRoles & { effect: ExpenseEffect })[] = [
	{ paidBy: 'organization', borneBy: 'owner', recovery: 'owner_statement', effect: 'statement_deduction' },
	{ paidBy: 'organization', borneBy: 'organization', recovery: 'none', effect: 'organization_cost' },
	{ paidBy: 'organization', borneBy: 'tenant', recovery: 'claimed_from_tenant', effect: 'tenant_claim' },
	{ paidBy: 'organization', borneBy: 'tenant', recovery: 'deposit', effect: 'deposit_retention' },
	{ paidBy: 'owner', borneBy: 'owner', recovery: 'none', effect: 'owner_paid' },
	{ paidBy: 'tenant', borneBy: 'tenant', recovery: 'none', effect: 'tenant_paid' }
];

/**
 * Un bailleur particulier est à la fois l'organisation et le propriétaire : seules les combinaisons sans
 * propriétaire distinct ont un sens (organisation, locataire).
 */
const LANDLORD_EFFECTS: readonly ExpenseEffect[] = ['organization_cost', 'tenant_claim', 'deposit_retention', 'tenant_paid'];

/** Effet d'une combinaison, ou `null` si elle n'est pas admise pour ce type d'organisation. */
export function expenseEffect(roles: ExpenseRoles, organizationType: OrganizationType = 'agency'): ExpenseEffect | null {
	const found = EXPENSE_COMBINATIONS.find((c) => c.paidBy === roles.paidBy && c.borneBy === roles.borneBy && c.recovery === roles.recovery);
	if (!found) return null;
	if (organizationType === 'landlord' && !LANDLORD_EFFECTS.includes(found.effect)) return null;
	return found.effect;
}

/** Combinaisons proposées par le formulaire, selon le type d'organisation. */
export function allowedExpenseCombinations(organizationType: OrganizationType): (ExpenseRoles & { effect: ExpenseEffect })[] {
	return EXPENSE_COMBINATIONS.filter((c) => expenseEffect(c, organizationType) !== null);
}

/** Une dépense qui concerne un locataire (créance, caution, réparation faite par lui) désigne son bail. */
export function expenseNeedsLease(roles: Pick<ExpenseRoles, 'paidBy' | 'borneBy'>): boolean {
	return roles.borneBy === 'tenant' || roles.paidBy === 'tenant';
}

export const EXPENSE_STATUSES = ['recorded', 'cancelled'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

// ---------------------------------------------------------------- créance sur le locataire

/**
 * Reste dû par le locataire sur une dépense réclamée : le montant moins les imputations nettes des encaissements
 * « dépense » (lot 10, option A du porteur). La dépense n'est jamais copiée : c'est la créance elle-même.
 */
export function expenseClaimBalance(claim: { amount: Fcfa; recovered: Fcfa; cancelled?: boolean }): Fcfa {
	if (claim.cancelled) return 0;
	return Math.max(0, claim.amount - claim.recovered);
}

// ---------------------------------------------------------------- schémas

const isoDate = z.string().refine(isIsoDate, { error: 'Date invalide.' });
const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, { error: 'Champ trop long.' })
		.nullish()
		.transform((v) => (v ? v : null));

export class ExpenseRuleError extends Error {
	constructor(
		readonly code: 'EXPENSE_COMBINATION_UNSUPPORTED' | 'EXPENSE_LEASE_REQUIRED' | 'EXPENSE_DATE_IN_FUTURE',
		message: string
	) {
		super(message);
		this.name = 'ExpenseRuleError';
	}
}

export const expenseSchema = z
	.object({
		id: idSchema,
		propertyId: idSchema,
		unitId: idSchema.nullish().transform((v) => v ?? null),
		leaseId: idSchema.nullish().transform((v) => v ?? null),
		spentOn: isoDate,
		category: z.enum(EXPENSE_CATEGORIES, { error: 'Choisissez une catégorie.' }),
		description: z.string().trim().min(2, { error: 'Décrivez la dépense.' }).max(500, { error: 'Description trop longue.' }),
		supplier: optionalText(120),
		amount: fcfaSchema.refine((v) => v > 0, { error: 'Le montant doit être supérieur à zéro.' }),
		documentId: idSchema.nullish().transform((v) => v ?? null),
		paidBy: z.enum(EXPENSE_PAYERS),
		borneBy: z.enum(EXPENSE_BEARERS),
		recovery: z.enum(EXPENSE_RECOVERIES)
	})
	.superRefine((e, ctx) => {
		if (!EXPENSE_COMBINATIONS.some((c) => c.paidBy === e.paidBy && c.borneBy === e.borneBy && c.recovery === e.recovery)) {
			ctx.addIssue({ code: 'custom', path: ['recovery'], message: 'Cette combinaison n’est pas prise en charge.' });
		}
		if (expenseNeedsLease(e) && !e.leaseId) {
			ctx.addIssue({ code: 'custom', path: ['leaseId'], message: 'Choisissez le bail du locataire concerné.' });
		}
	});
export type ExpenseInput = z.input<typeof expenseSchema>;
export type ExpenseData = z.output<typeof expenseSchema>;

export const cancelExpenseSchema = z.object({
	reason: z.string().trim().min(5, { error: 'Indiquez le motif (5 caractères au moins).' }).max(500, { error: 'Motif trop long.' })
});
export type CancelExpenseData = z.output<typeof cancelExpenseSchema>;

/** Contrôles qui dépendent du contexte (type d'organisation, date du jour), en plus du schéma. */
export function expenseBlockers(e: ExpenseRoles & { spentOn: string }, ctx: { organizationType: OrganizationType; today: string }) {
	const out: ExpenseRuleError['code'][] = [];
	if (!expenseEffect(e, ctx.organizationType)) out.push('EXPENSE_COMBINATION_UNSUPPORTED');
	if (e.spentOn > ctx.today) out.push('EXPENSE_DATE_IN_FUTURE');
	return out;
}

// ---------------------------------------------------------------- vues

export interface ExpenseView extends ExpenseRoles {
	id: string;
	propertyId: string;
	unitId: string | null;
	leaseId: string | null;
	spentOn: string;
	category: ExpenseCategory;
	description: string;
	supplier: string | null;
	amount: Fcfa;
	documentId: string | null;
	status: ExpenseStatus;
	effect: ExpenseEffect;
	cancellationReason: string | null;
	cancelledAt: string | null;
	recordedBy: string | null;
	createdAt: string;
}
