/**
 * Dépenses réclamées au locataire, vues par le module payments (lot 10, option A du porteur). Le module collections
 * détient la table des dépenses : il inscrit ici son lecteur au démarrage, comme le module leases annonce ses échéances
 * (RentDueEvents). Le module payments ne lit jamais la table d'un autre module (CLAUDE.md §4).
 */
import { Injectable } from '@nestjs/common';
import type { ExpenseCategory } from '@ziga/shared/expenses';
import type { Tx } from '../../db/database.js';

export interface ExpenseClaim {
	id: string;
	leaseId: string | null;
	amount: number;
	recovery: string;
	status: 'recorded' | 'cancelled';
	category: ExpenseCategory;
	description: string;
	spentOn: string;
}

export type ExpenseClaimReader = (tx: Tx, expenseId: string) => Promise<ExpenseClaim | null>;

@Injectable()
export class ExpenseClaims {
	private reader: ExpenseClaimReader | null = null;

	register(reader: ExpenseClaimReader): void {
		this.reader = reader;
	}

	async get(tx: Tx, expenseId: string): Promise<ExpenseClaim | null> {
		if (!this.reader) return null;
		return this.reader(tx, expenseId);
	}
}
