/**
 * Encaissements saisis sur l'appareil (lot 09, docs/SYNC.md §5 à §7), hors ligne compris : même permission, même
 * interrupteur, même schéma Zod et même service (audit compris) que POST /payments.
 * - PUT seulement : un encaissement ne se modifie ni ne se supprime depuis l'appareil (règle 3). Validation,
 *   rapprochement et annulation se font en ligne (réponse du porteur, point 7).
 * - Ni statut, ni locataire, ni numéro : décidés par le serveur (règles 6 et 9) ; une colonne non prévue est refusée
 *   (FIELD_NOT_WRITABLE).
 * - Le reçu (identifiant, numéro provisoire, jetons) est joint à l'opération par le connecteur (`op.receipt`).
 * - Rejeu : la clé de l'opération (module sync) puis l'identifiant de l'encaissement (service) : jamais de doublon.
 * - Doublon Mobile Money (point b) : refus nommé MOBILE_MONEY_REFERENCE_DUPLICATE, rangé dans « Modifications non
 *   acceptées ».
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { paymentEntrySchema } from '@ziga/shared/payments';
import type { SyncOperation } from '@ziga/shared/sync';
import { AppError } from '../../common/app-error.js';
import { organizationOfRow, SyncRegistry } from '../sync/sync-registry.js';
import { PaymentsService } from './payments.service.js';

const WRITABLE = [
	'organization_id',
	'lease_id',
	'purpose',
	'deposit_account_id',
	'expense_id',
	'amount',
	'method',
	'operator',
	'transaction_reference',
	'paid_on',
	'note'
] as const;

function columns(op: SyncOperation): Record<string, unknown> {
	const data = { ...(op.data ?? {}) };
	for (const column of Object.keys(data)) {
		if (!(WRITABLE as readonly string[]).includes(column)) {
			throw new AppError('FIELD_NOT_WRITABLE', `Ce champ ne s’écrit pas depuis l’appareil : ${column}.`, 400, { column });
		}
	}
	return data;
}

const text = (v: unknown) => (v === '' || v === undefined ? null : v);

@Injectable()
export class PaymentsSyncHandlers implements OnModuleInit {
	constructor(
		private readonly registry: SyncRegistry,
		private readonly payments: PaymentsService
	) {}

	onModuleInit(): void {
		this.registry.register({
			table: 'payments',
			operations: ['PUT'],
			// La permission la plus large ; le moyen précis est vérifié par le service (espèces seulement pour l'agent).
			permission: 'payment.record_cash',
			feature: 'payments.registry',
			organizationOf: organizationOfRow,
			apply: async (op) => {
				const data = columns(op);
				const entry = paymentEntrySchema.parse({
					id: op.id,
					leaseId: data.lease_id,
					purpose: data.purpose,
					depositAccountId: text(data.deposit_account_id),
					expenseId: text(data.expense_id),
					amount: data.amount,
					method: data.method,
					operator: text(data.operator),
					transactionReference: text(data.transaction_reference),
					paidOn: data.paid_on,
					note: text(data.note),
					receiptId: op.receipt?.id,
					provisionalNumber: op.receipt?.provisionalNumber,
					verificationToken: op.receipt?.verificationToken,
					shareToken: op.receipt?.shareToken
				});
				await this.payments.record([entry]);
			}
		});
	}
}
