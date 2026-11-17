/**
 * Dépenses (lot 10, règle 16) : une dépense est un seul enregistrement — qui a payé, qui la supporte, comment elle est
 * récupérée. Ajout seul : une erreur se corrige par une annulation motivée (directeur). La dépense réclamée au locataire
 * est la créance elle-même : le module payments la lit par le lecteur inscrit ici (ExpenseClaims), jamais par sa table.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { toIsoDate } from '@ziga/shared/dates';
import { expenseBlockers, expenseEffect, type ExpenseData, type ExpenseView } from '@ziga/shared/expenses';
import type { Page } from '@ziga/shared/leases';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import type { AuditOrigin } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import { expenses } from '../../db/schema/collections.js';
import { AuditService } from '../audit/audit.service.js';
import { ExpenseClaims } from '../payments/expense-claims.js';
import { collectionsContext, iso } from './collections-context.js';

export type ExpenseRow = typeof expenses.$inferSelect;

const EXPENSE_NOT_FOUND = () => new AppError('EXPENSE_NOT_FOUND', 'Dépense introuvable.', 404);

export function expenseView(e: ExpenseRow): ExpenseView {
	return {
		id: e.id,
		propertyId: e.propertyId,
		unitId: e.unitId,
		leaseId: e.leaseId,
		spentOn: e.spentOn,
		category: e.category,
		description: e.description,
		supplier: e.supplier,
		amount: e.amount,
		documentId: e.documentId,
		paidBy: e.paidBy,
		borneBy: e.borneBy,
		recovery: e.recovery,
		status: e.status,
		effect: expenseEffect(e)!,
		cancellationReason: e.cancellationReason,
		cancelledAt: iso(e.cancelledAt),
		recordedBy: e.recordedBy,
		createdAt: e.createdAt.toISOString()
	};
}

@Injectable()
export class ExpensesService implements OnModuleInit {
	constructor(
		private readonly audit: AuditService,
		private readonly claims: ExpenseClaims
	) {}

	onModuleInit(): void {
		// Le module payments vérifie une dépense réclamée sans lire cette table (CLAUDE.md §4).
		this.claims.register(async (tx, id) => {
			const [e] = await tx.select().from(expenses).where(eq(expenses.id, id)).limit(1);
			return e
				? {
						id: e.id,
						leaseId: e.leaseId,
						amount: e.amount,
						recovery: e.recovery,
						status: e.status,
						category: e.category,
						description: e.description,
						spentOn: e.spentOn
					}
				: null;
		});
	}

	/** Dépenses de l'organisation, de la plus récente à la plus ancienne, par curseur (UUIDv7). */
	async list(filter: { propertyId?: string; cursor?: string | null; limit: number }): Promise<Page<ExpenseView>> {
		const c = collectionsContext();
		const rows = await c.tx
			.select()
			.from(expenses)
			.where(
				and(
					filter.propertyId ? eq(expenses.propertyId, filter.propertyId) : undefined,
					filter.cursor ? lt(expenses.id, filter.cursor) : undefined
				)
			)
			.orderBy(desc(expenses.id))
			.limit(filter.limit + 1);
		const items = rows.slice(0, filter.limit).map(expenseView);
		return { items, nextCursor: rows.length > filter.limit ? items.at(-1)!.id : null };
	}

	async get(id: string): Promise<ExpenseView> {
		const c = collectionsContext();
		return expenseView(await this.row(c.tx, id));
	}

	private async row(tx: Tx, id: string, lock = false): Promise<ExpenseRow> {
		const q = tx.select().from(expenses).where(eq(expenses.id, id)).limit(1);
		const [row] = lock ? await q.for('update') : await q;
		if (!row) throw EXPENSE_NOT_FOUND();
		return row;
	}

	/** Enregistrement (route ou appareil), idempotent par identifiant ; refus nommés avant la base. */
	async create(input: ExpenseData, origin?: AuditOrigin): Promise<ExpenseView> {
		const c = collectionsContext();
		const [existing] = await c.tx.select().from(expenses).where(eq(expenses.id, input.id)).limit(1);
		if (existing) {
			if (existing.amount !== input.amount || existing.propertyId !== input.propertyId) {
				throw new AppError('EXPENSE_ID_CONFLICT', 'Cet identifiant désigne déjà une autre dépense.', 409);
			}
			return expenseView(existing);
		}
		const [blocker] = expenseBlockers(input, { organizationType: c.organizationType, today: toIsoDate() });
		if (blocker === 'EXPENSE_COMBINATION_UNSUPPORTED') {
			throw new AppError(blocker, 'Cette combinaison (qui a payé, qui supporte, comment c’est récupéré) n’est pas prise en charge.', 400);
		}
		if (blocker === 'EXPENSE_DATE_IN_FUTURE') throw new AppError(blocker, 'La date de la dépense est dans le futur.', 400);
		const [row] = await c.tx
			.insert(expenses)
			.values({ ...input, organizationId: c.organizationId, recordedBy: c.userId })
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'expense.record',
			objectType: 'expense',
			objectId: row!.id,
			after: {
				propertyId: input.propertyId,
				unitId: input.unitId,
				leaseId: input.leaseId,
				spentOn: input.spentOn,
				category: input.category,
				amount: input.amount,
				paidBy: input.paidBy,
				borneBy: input.borneBy,
				recovery: input.recovery
			},
			...(origin ? { origin } : {})
		});
		return expenseView(row!);
	}

	/** Annulation motivée (directeur) : la dépense reste, marquée annulée ; jamais modifiée ni supprimée. */
	async cancel(id: string, reason: string): Promise<ExpenseView> {
		const c = collectionsContext();
		const row = await this.row(c.tx, id, true);
		if (row.status === 'cancelled') throw new AppError('EXPENSE_ALREADY_CANCELLED', 'Cette dépense est déjà annulée.', 409);
		const [updated] = await c.tx
			.update(expenses)
			.set({ status: 'cancelled', cancellationReason: reason, cancelledAt: new Date(), cancelledBy: c.userId })
			.where(eq(expenses.id, id))
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'expense.cancel',
			objectType: 'expense',
			objectId: id,
			before: { status: row.status, amount: row.amount },
			after: { status: 'cancelled', reason }
		});
		return expenseView(updated!);
	}

	/** Dépenses de biens donnés (relevés) ; transaction donnée (worker). */
	async ofProperties(tx: Tx, propertyIds: readonly string[]): Promise<ExpenseRow[]> {
		if (!propertyIds.length) return [];
		return tx
			.select()
			.from(expenses)
			.where(inArray(expenses.propertyId, [...propertyIds]));
	}

	/** Dépenses réclamées aux locataires (impayés). */
	async tenantClaims(tx: Tx): Promise<ExpenseRow[]> {
		return tx.select().from(expenses).where(eq(expenses.recovery, 'claimed_from_tenant'));
	}
}
