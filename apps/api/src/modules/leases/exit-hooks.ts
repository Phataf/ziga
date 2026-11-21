/**
 * Sortie du locataire (lot 10 bis) : ce que le module leases demande aux modules qui détiennent d'autres tables
 * (CLAUDE.md §4), sans jamais les lire. Le module payments y inscrit l'imputation sur caution (D32), le retour d'un
 * surplus au crédit du bail, le crédit et les encaissements en attente ; le module collections, la dépense d'une
 * réparation et les dépenses réclamées au locataire. Global, comme RentDueEvents : la tâche de nuit s'en sert aussi.
 */
import { Global, Injectable, Module } from '@nestjs/common';
import type { Tx } from '../../db/database.js';
import type { AuditActor } from '../audit/audit.service.js';

export interface DepositOffsetInput {
	tx: Tx;
	organizationId: string;
	userId: string;
	actor: AuditActor;
	leaseId: string;
	purpose: 'rent' | 'expense';
	rentDueId: string | null;
	expenseId: string | null;
	amount: number;
	paidOn: string;
	/** Clé d'idempotence : une ligne du décompte n'est imputée qu'une fois. */
	idempotencyKey: string;
}

export interface CreditReleaseInput {
	tx: Tx;
	organizationId: string;
	leaseId: string;
	rentDueId: string;
	amount: number;
	actor: AuditActor;
	today: string;
}

export interface RepairExpenseInput {
	id: string;
	propertyId: string;
	unitId: string | null;
	leaseId: string;
	spentOn: string;
	amount: number;
	description: string;
	documentId: string;
}

export interface TenantClaim {
	expenseId: string;
	category: string;
	recovery: string;
	status: 'recorded' | 'cancelled';
	documentId: string | null;
	/** Reste dû : montant − remboursé − encaissements en attente. */
	outstanding: number;
}

interface PaymentHooks {
	depositOffset(input: DepositOffsetInput): Promise<{ paymentId: string; receiptNumber: string | null }>;
	releaseToCredit(input: CreditReleaseInput): Promise<void>;
	/** Crédit du bail (trop-perçu non imputé). */
	credit(tx: Tx, leaseId: string): Promise<number>;
	/** Encaissements de loyer en attente (à valider, à rapprocher) : jamais retenus sur la caution. */
	pendingRent(tx: Tx, leaseId: string): Promise<number>;
}

interface ExpenseHooks {
	repairExpense(input: RepairExpenseInput): Promise<void>;
	claimsOf(tx: Tx, leaseId: string): Promise<TenantClaim[]>;
}

@Injectable()
export class ExitHooks {
	#payments: PaymentHooks | null = null;
	#expenses: ExpenseHooks | null = null;

	registerPayments(hooks: PaymentHooks): void {
		this.#payments = hooks;
	}

	registerExpenses(hooks: ExpenseHooks): void {
		this.#expenses = hooks;
	}

	get payments(): PaymentHooks {
		if (!this.#payments) throw new Error('ExitHooks : le module payments ne s’est pas inscrit.');
		return this.#payments;
	}

	get expenses(): ExpenseHooks {
		if (!this.#expenses) throw new Error('ExitHooks : le module collections ne s’est pas inscrit.');
		return this.#expenses;
	}
}

@Global()
@Module({ providers: [ExitHooks], exports: [ExitHooks] })
export class ExitHooksModule {}
