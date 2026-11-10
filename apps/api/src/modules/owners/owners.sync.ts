/**
 * Propriétaires et mandats modifiés sur l'appareil (lot 06, docs/SYNC.md §5 à §7). Mêmes permissions, mêmes schémas
 * Zod et même service (audit compris) que les routes HTTP du module.
 * - PUT : création (UUIDv7 de l'appareil) ; bloquée par un abonnement échu, comme @Creation().
 * - PATCH : seules les colonnes modifiées ; elles complètent la fiche ou le mandat, revalidés en entier.
 * - Statut : jamais repris tel quel (docs/SYNC.md §6). « archived » sur une fiche est un archivage ; « revoked » sur un
 *   mandat est une révocation (permission mandate.revoke, motif exigé) ; toute autre transition est refusée.
 * - Version, dates de révocation et d'expiration, compte lié : décidés par le serveur, jamais écrits depuis l'appareil.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
	commissionFromColumns,
	createMandateSchema,
	createOwnerSchema,
	revokeMandateSchema,
	updateMandateSchema,
	updateOwnerSchema,
	type CommissionColumns
} from '@ziga/shared/owners';
import type { SyncOperation } from '@ziga/shared/sync';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { assertCan } from '../organizations/organization-context.js';
import { organizationOfRow, SyncRegistry } from '../sync/sync-registry.js';
import { OwnersService } from './owners.service.js';

const OWNER_COLUMNS = [
	'type',
	'name',
	'phone',
	'email',
	'address',
	'country',
	'representative_name',
	'representative_phone',
	'notes'
] as const;
const COMMISSION_COLUMNS = ['commission_basis', 'commission_rate_bp', 'commission_amount'] as const;
const AUTHORIZATION_COLUMNS = {
	can_publish: 'canPublish',
	can_take_photos: 'canTakePhotos',
	can_collect_funds: 'canCollectFunds',
	can_sign_leases: 'canSignLeases'
} as const;
const TERM_COLUMNS = ['starts_on', 'ends_on', ...COMMISSION_COLUMNS, ...Object.keys(AUTHORIZATION_COLUMNS), 'exclusive'] as const;

/** Colonnes de l'opération, refusées si l'une n'est pas dans la liste (FIELD_NOT_WRITABLE). */
function columns(op: SyncOperation, allowed: readonly string[]): Record<string, unknown> {
	const data = { ...(op.data ?? {}) };
	for (const column of Object.keys(data)) {
		if (!allowed.includes(column))
			throw new AppError('FIELD_NOT_WRITABLE', `Ce champ ne se modifie pas depuis l’appareil : ${column}.`, 400, { column });
	}
	return data;
}

/** Booléens de la base locale : 0 ou 1 (SQLite). Toute autre valeur passe telle quelle et sera refusée par Zod. */
function bool(value: unknown): unknown {
	return value === 1 ? true : value === 0 ? false : value;
}

/** Valeur vide de l'appareil : null. */
function text(value: unknown): unknown {
	return value === '' ? null : value;
}

/** La colonne a-t-elle été envoyée ? */
const has = (data: Record<string, unknown>, column: string) => Object.hasOwn(data, column);

function ownerFields(data: Record<string, unknown>, current?: { name: string; phone: string } | null) {
	const out: Record<string, unknown> = {};
	for (const column of ['type', 'name', 'phone', 'email', 'address', 'country', 'notes'] as const) {
		if (has(data, column)) out[column] = text(data[column]);
	}
	if (has(data, 'representative_name') || has(data, 'representative_phone')) {
		const name = has(data, 'representative_name') ? text(data.representative_name) : (current?.name ?? null);
		const phone = has(data, 'representative_phone') ? text(data.representative_phone) : (current?.phone ?? null);
		out.representative = name || phone ? { name, phone } : null;
	}
	return out;
}

function termFields(data: Record<string, unknown>, currentCommission?: CommissionColumns) {
	const out: Record<string, unknown> = {};
	if (has(data, 'starts_on')) out.startsOn = data.starts_on;
	if (has(data, 'ends_on')) out.endsOn = text(data.ends_on);
	if (COMMISSION_COLUMNS.some((c) => has(data, c))) {
		const merged = {
			...currentCommission,
			...Object.fromEntries(COMMISSION_COLUMNS.filter((c) => has(data, c)).map((c) => [c, text(data[c])]))
		};
		out.commission = commissionFromColumns(merged as CommissionColumns);
	}
	for (const [column, field] of Object.entries(AUTHORIZATION_COLUMNS)) if (has(data, column)) out[field] = bool(data[column]);
	if (has(data, 'exclusive')) out.exclusive = bool(data.exclusive);
	return out;
}

@Injectable()
export class OwnersSyncHandlers implements OnModuleInit {
	constructor(
		private readonly registry: SyncRegistry,
		private readonly owners: OwnersService
	) {}

	onModuleInit(): void {
		this.registry.register({
			table: 'owners',
			operations: ['PUT', 'PATCH'],
			permission: { PUT: 'owner.create', PATCH: 'owner.update' },
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				if (op.op === 'PUT') {
					const data = columns(op, ['organization_id', ...OWNER_COLUMNS, 'status']);
					if (has(data, 'status') && data.status !== 'active') throw statusRefused();
					await this.owners.createOwner(createOwnerSchema.parse({ id: op.id, ...ownerFields(data) }));
					return;
				}
				const data = columns(op, [...OWNER_COLUMNS, 'status']);
				const { status, ...rest } = data;
				if (Object.keys(rest).length) {
					const current =
						has(rest, 'representative_name') || has(rest, 'representative_phone') ? (await this.owners.get(op.id)).representative : null;
					await this.owners.updateOwner(op.id, updateOwnerSchema.parse(ownerFields(rest, current)));
				}
				if (status !== undefined) {
					if (status !== 'archived') throw statusRefused();
					await this.owners.archiveOwner(op.id);
				}
			}
		});

		this.registry.register({
			table: 'mandates',
			operations: ['PUT', 'PATCH'],
			permission: { PUT: 'mandate.create', PATCH: 'mandate.update' },
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				if (op.op === 'PUT') {
					const data = columns(op, ['organization_id', 'owner_id', 'type', ...TERM_COLUMNS, 'status', 'version']);
					// L'appareil montre le mandat tel qu'il naîtra : actif, en version 1 ; il ne choisit rien d'autre.
					if (has(data, 'status') && data.status !== 'active') throw statusRefused();
					if (has(data, 'version') && Number(data.version) !== 1)
						throw new AppError('FIELD_NOT_WRITABLE', 'La version est décidée par le serveur.', 400, { column: 'version' });
					await this.owners.createMandate(
						createMandateSchema.parse({ id: op.id, ownerId: data.owner_id, type: data.type, ...termFields(data) })
					);
					return;
				}
				const data = columns(op, [...TERM_COLUMNS, 'status', 'revocation_reason']);
				if (has(data, 'status')) {
					if (data.status !== 'revoked') {
						throw new AppError('MANDATE_TRANSITION_NOT_ALLOWED', 'Un mandat ne passe à ce statut que par le serveur.', 409, {
							status: data.status
						});
					}
					// Révocation : ses seules colonnes, autorisations à faux comprises (l'appareil les a déjà retirées).
					for (const column of Object.keys(data)) {
						const allowed =
							column === 'status' || column === 'revocation_reason' || (column in AUTHORIZATION_COLUMNS && !bool(data[column]));
						if (!allowed) throw new AppError('FIELD_NOT_WRITABLE', `Une révocation ne modifie pas ce champ : ${column}.`, 400, { column });
					}
					assertCan(RequestContext.organization().role, 'mandate.revoke');
					await this.owners.revokeMandate(op.id, revokeMandateSchema.parse({ reason: data.revocation_reason ?? '' }).reason);
					return;
				}
				if (has(data, 'revocation_reason')) {
					throw new AppError('FIELD_NOT_WRITABLE', 'Le motif accompagne une révocation.', 400, { column: 'revocation_reason' });
				}
				const current = COMMISSION_COLUMNS.some((c) => has(data, c)) ? await this.owners.commissionColumnsOf(op.id) : undefined;
				await this.owners.updateMandate(op.id, updateMandateSchema.parse(termFields(data, current)));
			}
		});
	}
}

function statusRefused(): AppError {
	return new AppError('STATUS_NOT_ALLOWED', 'Ce statut ne se choisit pas depuis l’appareil.', 409);
}
