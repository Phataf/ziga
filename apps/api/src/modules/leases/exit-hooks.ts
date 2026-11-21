/**
 * Sortie du locataire (lot 10 bis) : ce que le module leases demande aux modules qui détiennent d'autres tables
 * (CLAUDE.md §4), sans jamais les lire. Le module payments y inscrit l'imputation sur caution (D32), le retour d'un
 * surplus au crédit du bail, le crédit et les encaissements en attente ; le module collections, la dépense d'une
 * réparation et les dépenses réclamées au locataire. Global, comme RentDueEvents : la tâche de nuit s'en sert aussi.
 *
 * Les deux points sont remplis au démarrage de chaque processus, l'API (`main.ts`, `AppModule`) comme le worker
 * (`worker.ts`, `WorkerModule`, où tourne la tâche du jour). Un point vide n'est jamais ignoré : le processus refuse de
 * démarrer (`onApplicationBootstrap`), et une lecture d'un point vide lève `EXIT_HOOKS_NOT_REGISTERED`. Une seconde
 * inscription est refusée aussi (deux modules qui croiraient tenir la même table).
 */
import { Global, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
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

export type ExitHookPoint = 'payments' | 'expenses';

const OWNER: Record<ExitHookPoint, string> = { payments: 'payments', expenses: 'collections' };

/** Point d'inscription vide ou rempli deux fois : une erreur de câblage du processus, jamais ignorée. */
export class ExitHooksNotRegisteredError extends Error {
	readonly code = 'EXIT_HOOKS_NOT_REGISTERED';

	constructor(
		readonly point: ExitHookPoint,
		reason: 'missing' | 'twice' = 'missing'
	) {
		super(
			reason === 'missing'
				? `ExitHooks : le point « ${point} » n’est pas inscrit ; le module ${OWNER[point]} n’est pas chargé dans ce processus.`
				: `ExitHooks : le point « ${point} » est inscrit deux fois ; seul le module ${OWNER[point]} l’inscrit.`
		);
		this.name = 'ExitHooksNotRegisteredError';
	}
}

@Injectable()
export class ExitHooks implements OnApplicationBootstrap {
	#payments: PaymentHooks | null = null;
	#expenses: ExpenseHooks | null = null;

	registerPayments(hooks: PaymentHooks): void {
		if (this.#payments) throw new ExitHooksNotRegisteredError('payments', 'twice');
		this.#payments = hooks;
	}

	registerExpenses(hooks: ExpenseHooks): void {
		if (this.#expenses) throw new ExitHooksNotRegisteredError('expenses', 'twice');
		this.#expenses = hooks;
	}

	get payments(): PaymentHooks {
		if (!this.#payments) throw new ExitHooksNotRegisteredError('payments');
		return this.#payments;
	}

	get expenses(): ExpenseHooks {
		if (!this.#expenses) throw new ExitHooksNotRegisteredError('expenses');
		return this.#expenses;
	}

	/** Points encore vides (vérification au démarrage, et tests). */
	missing(): ExitHookPoint[] {
		return [...(this.#payments ? [] : ['payments' as const]), ...(this.#expenses ? [] : ['expenses' as const])];
	}

	/** Après tous les `onModuleInit` : un processus dont un point est vide ne démarre pas. */
	onApplicationBootstrap(): void {
		const [point] = this.missing();
		if (point) throw new ExitHooksNotRegisteredError(point);
	}
}

@Global()
@Module({ providers: [ExitHooks], exports: [ExitHooks] })
export class ExitHooksModule {}
