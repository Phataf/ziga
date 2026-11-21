/**
 * Sortie du locataire depuis l'appareil (lot 10 bis, étape 3 ; docs/SYNC.md §5 à §7). Mêmes permissions, mêmes schémas
 * Zod et même service (audit compris) que les routes :
 * - `inspections` : création (hors ligne, agent de terrain compris, sur ses unités) ; PATCH des colonnes de signature,
 *   lu comme la case cochée par une partie, sur l'appareil de la personne connectée, à l'heure de l'appareil ;
 * - `inspection_items` : création, modification, suppression, tant que l'état des lieux est un brouillon ;
 * - `deposit_settlement_lines` : ligne proposée au brouillon d'un décompte ; une retenue sans ligne `tenant_damage`, sans
 *   montant ou sans justificatif, ou une imputation sur loyer sans accord accepté avant le mois, est refusée avec son
 *   code (règle 14, D32) et rangée dans « Modifications non acceptées ».
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
	createInspectionSchema,
	inspectionItemSchema,
	settlementLineInputSchema,
	updateInspectionItemSchema
} from '@ziga/shared/exit-schemas';
import type { SyncOperation } from '@ziga/shared/sync';
import { AppError } from '../../common/app-error.js';
import { organizationOfRow, SyncRegistry } from '../sync/sync-registry.js';
import { ExitService } from './exit.service.js';

function columns(op: SyncOperation, allowed: readonly string[]): Record<string, unknown> {
	const data = { ...(op.data ?? {}) };
	for (const column of Object.keys(data)) {
		if (!allowed.includes(column)) {
			throw new AppError('FIELD_NOT_WRITABLE', `Ce champ ne se modifie pas depuis l’appareil : ${column}.`, 400, { column });
		}
	}
	return data;
}

const empty = (v: unknown) => (v === '' || v === undefined ? null : v);
const bool = (v: unknown) => v === true || v === 1 || v === '1';

const ITEM_COLUMNS = {
	room: 'room',
	element: 'element',
	position: 'position',
	description: 'description',
	finding: 'finding',
	entry_item_id: 'entryItemId'
} as const;

function itemFields(data: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [column, field] of Object.entries(ITEM_COLUMNS)) if (Object.hasOwn(data, column)) out[field] = empty(data[column]);
	return out;
}

@Injectable()
export class ExitSyncHandlers implements OnModuleInit {
	constructor(
		private readonly registry: SyncRegistry,
		private readonly exit: ExitService
	) {}

	onModuleInit(): void {
		this.registry.register({
			table: 'inspections',
			operations: ['PUT', 'PATCH'],
			permission: { PUT: 'inspection.create', PATCH: 'inspection.sign' },
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				if (op.op === 'PUT') {
					const data = columns(op, ['organization_id', 'lease_id', 'type', 'inspected_on', 'furnished']);
					await this.exit.createInspection(
						createInspectionSchema.parse({
							id: op.id,
							leaseId: data.lease_id,
							type: data.type,
							inspectedOn: data.inspected_on,
							furnished: bool(data.furnished)
						}),
						'sync'
					);
					return;
				}
				const data = columns(op, ['organization_signed_at', 'tenant_signed_at']);
				for (const [column, party] of [
					['organization_signed_at', 'organization'],
					['tenant_signed_at', 'tenant']
				] as const) {
					const at = data[column];
					if (typeof at !== 'string' || !at) continue;
					const when = new Date(at);
					await this.exit.sign(op.id, { party }, 'sync', Number.isNaN(when.getTime()) ? undefined : when);
				}
			}
		});
		this.registry.register({
			table: 'inspection_items',
			operations: ['PUT', 'PATCH', 'DELETE'],
			permission: 'inspection.create',
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				if (op.op === 'DELETE') {
					await this.exit.deleteItem(op.id, 'sync');
					return;
				}
				if (op.op === 'PUT') {
					const data = columns(op, ['organization_id', 'inspection_id', ...Object.keys(ITEM_COLUMNS)]);
					await this.exit.addItem(String(data.inspection_id), inspectionItemSchema.parse({ id: op.id, ...itemFields(data) }), 'sync');
					return;
				}
				const data = columns(op, Object.keys(ITEM_COLUMNS));
				await this.exit.updateItem(op.id, updateInspectionItemSchema.parse(itemFields(data)), 'sync');
			}
		});
		this.registry.register({
			table: 'deposit_settlement_lines',
			operations: ['PUT'],
			permission: 'deposit.settle',
			organizationOf: organizationOfRow,
			apply: async (op) => {
				const data = columns(op, ['organization_id', 'settlement_id', 'kind', 'repair_id', 'rent_due_id', 'agreement_id']);
				await this.exit.proposeLine(
					settlementLineInputSchema.parse({
						id: op.id,
						settlementId: data.settlement_id,
						kind: data.kind,
						repairId: empty(data.repair_id),
						rentDueId: empty(data.rent_due_id),
						agreementId: empty(data.agreement_id)
					}),
					'sync'
				);
			}
		});
	}
}
