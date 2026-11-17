/** Dépenses (lot 10, règle 16) : combinaisons admises, effet, bail exigé, créance, schéma. */
import { describe, expect, it } from 'vitest';
import {
	allowedExpenseCombinations,
	EXPENSE_BEARERS,
	EXPENSE_PAYERS,
	EXPENSE_RECOVERIES,
	expenseBlockers,
	expenseClaimBalance,
	expenseEffect,
	expenseSchema
} from './expenses.js';

const ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f';

describe('combinaisons', () => {
	it('six combinaisons admises sur 36, chacune avec son effet', () => {
		const admitted = [];
		for (const paidBy of EXPENSE_PAYERS)
			for (const borneBy of EXPENSE_BEARERS)
				for (const recovery of EXPENSE_RECOVERIES) {
					const effect = expenseEffect({ paidBy, borneBy, recovery });
					if (effect) admitted.push(`${paidBy}/${borneBy}/${recovery}:${effect}`);
				}
		expect(admitted).toEqual([
			'organization/owner/owner_statement:statement_deduction',
			'organization/organization/none:organization_cost',
			'organization/tenant/deposit:deposit_retention',
			'organization/tenant/claimed_from_tenant:tenant_claim',
			'owner/owner/none:owner_paid',
			'tenant/tenant/none:tenant_paid'
		]);
	});

	it('un locataire qui avance une dépense pour le propriétaire attend le lot 10 bis', () => {
		expect(expenseEffect({ paidBy: 'tenant', borneBy: 'owner', recovery: 'owner_statement' })).toBeNull();
		expect(
			expenseBlockers(
				{ paidBy: 'tenant', borneBy: 'owner', recovery: 'none', spentOn: '2027-03-01' },
				{ organizationType: 'agency', today: '2027-03-02' }
			)
		).toEqual(['EXPENSE_COMBINATION_UNSUPPORTED']);
	});

	it('un bailleur particulier n’a pas de propriétaire distinct', () => {
		expect(allowedExpenseCombinations('landlord').map((c) => c.effect)).toEqual([
			'organization_cost',
			'tenant_claim',
			'deposit_retention',
			'tenant_paid'
		]);
		expect(expenseEffect({ paidBy: 'organization', borneBy: 'owner', recovery: 'owner_statement' }, 'landlord')).toBeNull();
	});

	it('date future refusée', () => {
		expect(
			expenseBlockers(
				{ paidBy: 'organization', borneBy: 'organization', recovery: 'none', spentOn: '2027-03-03' },
				{ organizationType: 'agency', today: '2027-03-02' }
			)
		).toEqual(['EXPENSE_DATE_IN_FUTURE']);
	});
});

describe('schéma', () => {
	const base = {
		id: ID,
		propertyId: ID,
		spentOn: '2027-03-12',
		category: 'plumbing',
		description: 'Fuite sous l’évier',
		amount: 15_000,
		paidBy: 'organization',
		borneBy: 'owner',
		recovery: 'owner_statement'
	};

	it('montant entier strictement positif, combinaison admise', () => {
		expect(expenseSchema.safeParse(base).success).toBe(true);
		expect(expenseSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
		expect(expenseSchema.safeParse({ ...base, amount: 15_000.5 }).success).toBe(false);
		expect(expenseSchema.safeParse({ ...base, recovery: 'none' }).success).toBe(false);
	});

	it('une dépense qui concerne un locataire désigne son bail', () => {
		const claim = { ...base, borneBy: 'tenant', recovery: 'claimed_from_tenant' };
		expect(expenseSchema.safeParse(claim).success).toBe(false);
		expect(expenseSchema.safeParse({ ...claim, leaseId: ID }).success).toBe(true);
	});
});

describe('créance sur le locataire', () => {
	it('reste dû = montant − imputations ; rien sur une dépense annulée', () => {
		expect(expenseClaimBalance({ amount: 15_000, recovered: 5_000 })).toBe(10_000);
		expect(expenseClaimBalance({ amount: 15_000, recovered: 15_000 })).toBe(0);
		expect(expenseClaimBalance({ amount: 15_000, recovered: 0, cancelled: true })).toBe(0);
	});
});
