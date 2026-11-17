/**
 * Relances et dépenses saisies sur l'appareil (lot 10, docs/SYNC.md §5 à §7), hors ligne compris : même permission,
 * même schéma Zod et même service (audit compris) que les routes.
 * - PUT seulement : ajout seul ; une dépense s'annule en ligne (directeur).
 * - Relance : la permission la plus large (visite, appel) ; le canal précis (message : `reminder.send`) et l'interrupteur
 *   du lien WhatsApp sont vérifiés par le service. Une colonne non prévue est refusée (FIELD_NOT_WRITABLE).
 * - Rejeu : la clé de l'opération (module sync) puis l'identifiant (service) : jamais de doublon.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { expenseSchema } from '@ziga/shared/expenses';
import { createReminderSchema } from '@ziga/shared/reminders';
import type { SyncOperation } from '@ziga/shared/sync';
import { AppError } from '../../common/app-error.js';
import { organizationOfRow, SyncRegistry } from '../sync/sync-registry.js';
import { ExpensesService } from './expenses.service.js';
import { RemindersService } from './reminders.service.js';

function columns(op: SyncOperation, writable: readonly string[]): Record<string, unknown> {
	const data = { ...(op.data ?? {}) };
	for (const column of Object.keys(data)) {
		if (!writable.includes(column)) {
			throw new AppError('FIELD_NOT_WRITABLE', `Ce champ ne s’écrit pas depuis l’appareil : ${column}.`, 400, { column });
		}
	}
	return data;
}

const text = (v: unknown) => (v === '' || v === undefined ? null : v);
/** Tableau PostgreSQL synchronisé en texte JSON (docs/SYNC.md §3). */
const ids = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : (v ?? []));

const REMINDER_COLUMNS = ['organization_id', 'tenant_id', 'rent_due_ids', 'expense_ids', 'channel', 'template_level', 'note'] as const;
const EXPENSE_COLUMNS = [
	'organization_id',
	'property_id',
	'unit_id',
	'lease_id',
	'spent_on',
	'category',
	'description',
	'supplier',
	'amount',
	'document_id',
	'paid_by',
	'borne_by',
	'recovery'
] as const;

@Injectable()
export class CollectionsSyncHandlers implements OnModuleInit {
	constructor(
		private readonly registry: SyncRegistry,
		private readonly reminders: RemindersService,
		private readonly expenses: ExpensesService
	) {}

	onModuleInit(): void {
		this.registry.register({
			table: 'reminders',
			operations: ['PUT'],
			permission: 'reminder.record_visit',
			organizationOf: organizationOfRow,
			apply: async (op) => {
				const data = columns(op, REMINDER_COLUMNS);
				await this.reminders.create(
					createReminderSchema.parse({
						id: op.id,
						tenantId: data.tenant_id,
						rentDueIds: ids(data.rent_due_ids),
						expenseIds: ids(data.expense_ids),
						channel: data.channel,
						templateLevel: text(data.template_level),
						note: text(data.note)
					}),
					'sync'
				);
			}
		});
		this.registry.register({
			table: 'expenses',
			operations: ['PUT'],
			permission: 'expense.record',
			organizationOf: organizationOfRow,
			apply: async (op) => {
				const data = columns(op, EXPENSE_COLUMNS);
				await this.expenses.create(
					expenseSchema.parse({
						id: op.id,
						propertyId: data.property_id,
						unitId: text(data.unit_id),
						leaseId: text(data.lease_id),
						spentOn: data.spent_on,
						category: data.category,
						description: data.description,
						supplier: text(data.supplier),
						amount: data.amount,
						documentId: text(data.document_id),
						paidBy: data.paid_by,
						borneBy: data.borne_by,
						recovery: data.recovery
					}),
					'sync'
				);
			}
		});
	}
}
