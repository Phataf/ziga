/**
 * Locataires, baux et cautions modifiés sur l'appareil (lot 08, docs/SYNC.md §5 à §7). Mêmes permissions, mêmes
 * schémas Zod et même service (audit compris) que les routes HTTP du module.
 * - PUT : création (UUIDv7 de l'appareil) ; bloquée par un abonnement échu, comme @Creation().
 * - Statut d'un bail : jamais repris tel quel (docs/SYNC.md §6). `draft` crée un brouillon ; `signed` ou `active` est une
 *   demande de validation, et le serveur décide lequel selon la date de début ; `cancelled` est une annulation motivée.
 *   Deux appareils hors ligne qui créent un bail sur la même unité : le second est refusé (UNIT_ALREADY_LEASED, tranché
 *   par la base) et apparaît dans « Modifications non acceptées ».
 * - Loyer d'un bail validé : PATCH de rent, charges, rent_effective_from et version ; la version envoyée est la
 *   suivante, celle d'avant est la version attendue (VERSION_CONFLICT si le bail a changé entre-temps).
 * - Échéances, versions du bail : écrites par le serveur seul, jamais depuis l'appareil (tables absentes du registre).
 * - Caution : création du compte, versement reçu, changement de détenteur ; statut et détenteur du compte jamais écrits.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
	cancelLeaseSchema,
	createDepositAccountSchema,
	createLeaseSchema,
	createTenantSchema,
	depositHolderChangeSchema,
	depositReceiptSchema,
	rentChangeSchema,
	updateDepositAccountSchema,
	updateLeaseDraftSchema,
	updateTenantIdentitySchema,
	updateTenantSchema
} from '@ziga/shared/leases';
import type { SyncOperation } from '@ziga/shared/sync';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { assertCan } from '../organizations/organization-context.js';
import { organizationOfRow, SyncRegistry } from '../sync/sync-registry.js';
import { LeasesService } from './leases.service.js';

/** Colonnes de la base locale → champs des schémas partagés. */
const TENANT_COLUMNS = {
	civility: 'civility',
	full_name: 'fullName',
	phone: 'phone',
	secondary_phone: 'secondaryPhone',
	nationality: 'nationality',
	profession: 'profession',
	previous_address: 'previousAddress',
	emergency_contact_name: 'emergencyContactName',
	emergency_contact_phone: 'emergencyContactPhone',
	notes: 'notes'
} as const;

const IDENTITY_COLUMNS = {
	birth_date: 'birthDate',
	birth_place: 'birthPlace',
	id_type: 'idType',
	id_type_other: 'idTypeOther',
	id_number: 'idNumber',
	id_issued_on: 'idIssuedOn',
	id_issued_by: 'idIssuedBy'
} as const;

const LEASE_TERM_COLUMNS = {
	starts_on: 'startsOn',
	ends_on: 'endsOn',
	duration_months: 'durationMonths',
	dues_start_on: 'duesStartOn',
	rent: 'rent',
	charges: 'charges',
	periodicity: 'periodicity',
	due_day: 'dueDay',
	billing_mode: 'billingMode',
	advance_months: 'advanceMonths',
	lessor_type: 'lessorType',
	payment_terms: 'paymentTerms',
	penalty_rate_bp: 'penaltyRateBp',
	penalty_grace_days: 'penaltyGraceDays',
	penalty_beneficiary: 'penaltyBeneficiary',
	notice_tenant_fixed_term_months: 'noticeTenantFixedTermMonths',
	notice_tenant_open_ended_months: 'noticeTenantOpenEndedMonths',
	notice_lessor_fixed_term_months: 'noticeLessorFixedTermMonths',
	notice_lessor_open_ended_months: 'noticeLessorOpenEndedMonths',
	reduced_notice_months: 'reducedNoticeMonths',
	reduced_notice_cases: 'reducedNoticeCases',
	early_termination_indemnity_months: 'earlyTerminationIndemnityMonths',
	renewal_mode: 'renewalMode',
	deposit_refund_days: 'depositRefundDays'
} as const;

const RENT_CHANGE_COLUMNS = ['rent', 'charges', 'rent_effective_from', 'version'] as const;

/** Colonnes de l'opération, refusées si l'une n'est pas dans la liste (FIELD_NOT_WRITABLE). */
function columns(op: SyncOperation, allowed: readonly string[]): Record<string, unknown> {
	const data = { ...(op.data ?? {}) };
	for (const column of Object.keys(data)) {
		if (!allowed.includes(column))
			throw new AppError('FIELD_NOT_WRITABLE', `Ce champ ne se modifie pas depuis l’appareil : ${column}.`, 400, { column });
	}
	return data;
}

/** Valeur vide de l'appareil : null. */
function text(value: unknown): unknown {
	return value === '' ? null : value;
}

const has = (data: Record<string, unknown>, column: string) => Object.hasOwn(data, column);

/** Champs du schéma à partir des colonnes envoyées (seulement celles reçues). */
function fields(data: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [column, field] of Object.entries(map)) if (has(data, column)) out[field] = text(data[column]);
	return out;
}

function statusRefused(status: unknown): AppError {
	return new AppError(
		'LEASE_TRANSITION_NOT_ALLOWED',
		'Ce statut ne se choisit pas depuis l’appareil : il est décidé par le serveur.',
		409,
		{
			status
		}
	);
}

@Injectable()
export class LeasesSyncHandlers implements OnModuleInit {
	constructor(
		private readonly registry: SyncRegistry,
		private readonly leases: LeasesService
	) {}

	onModuleInit(): void {
		this.registry.register({
			table: 'tenants',
			operations: ['PUT', 'PATCH'],
			permission: { PUT: 'tenant.create', PATCH: 'tenant.update' },
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				const allowed = [...Object.keys(TENANT_COLUMNS), 'status'];
				if (op.op === 'PUT') {
					const data = columns(op, ['organization_id', ...allowed]);
					if (has(data, 'status') && data.status !== 'active') throw statusRefused(data.status);
					await this.leases.createTenant(createTenantSchema.parse({ id: op.id, ...fields(data, TENANT_COLUMNS) }));
					return;
				}
				const { status, ...rest } = columns(op, allowed);
				if (Object.keys(rest).length) await this.leases.updateTenant(op.id, updateTenantSchema.parse(fields(rest, TENANT_COLUMNS)));
				if (status !== undefined) {
					if (status !== 'archived') throw statusRefused(status);
					await this.leases.archiveTenant(op.id);
				}
			}
		});

		// État civil et pièce d'identité (stream à part, même identifiant que la fiche) : directeur et gestionnaire.
		this.registry.register({
			table: 'tenant_identities',
			operations: ['PUT', 'PATCH'],
			permission: 'tenant.read_identity',
			organizationOf: organizationOfRow,
			apply: async (op) => {
				const data = columns(op, [...(op.op === 'PUT' ? ['organization_id'] : []), ...Object.keys(IDENTITY_COLUMNS)]);
				await this.leases.updateTenantIdentity(op.id, updateTenantIdentitySchema.parse(fields(data, IDENTITY_COLUMNS)));
			}
		});

		this.registry.register({
			table: 'leases',
			operations: ['PUT', 'PATCH'],
			permission: { PUT: 'lease.create', PATCH: 'lease.update' },
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				if (op.op === 'PUT') {
					const data = columns(op, ['organization_id', 'unit_id', 'tenant_id', ...Object.keys(LEASE_TERM_COLUMNS), 'status', 'version']);
					if (has(data, 'version') && Number(data.version) !== 1)
						throw new AppError('FIELD_NOT_WRITABLE', 'La version est décidée par le serveur.', 400, { column: 'version' });
					const status = data.status ?? 'draft';
					if (!['draft', 'signed', 'active'].includes(String(status))) throw statusRefused(status);
					await this.leases.createLease(
						createLeaseSchema.parse({
							id: op.id,
							unitId: data.unit_id,
							tenantId: data.tenant_id,
							validate: status !== 'draft',
							...fields(data, LEASE_TERM_COLUMNS)
						})
					);
					return;
				}
				const current = await this.leases.leaseState(op.id);
				const {
					status,
					cancellation_reason: reason,
					...rest
				} = columns(op, [
					'tenant_id',
					...Object.keys(LEASE_TERM_COLUMNS),
					'rent_effective_from',
					'version',
					'status',
					'cancellation_reason'
				]);
				if (reason !== undefined && status !== 'cancelled') {
					throw new AppError('FIELD_NOT_WRITABLE', 'Le motif accompagne une annulation.', 400, { column: 'cancellation_reason' });
				}
				if (current.status === 'draft') {
					if (has(rest, 'rent_effective_from') || has(rest, 'version')) {
						throw new AppError('FIELD_NOT_WRITABLE', 'Le loyer d’un brouillon se modifie directement.', 400, { column: 'version' });
					}
					if (Object.keys(rest).length) {
						const patch = { ...(has(rest, 'tenant_id') ? { tenantId: rest.tenant_id } : {}), ...fields(rest, LEASE_TERM_COLUMNS) };
						await this.leases.updateDraft(op.id, updateLeaseDraftSchema.parse(patch));
					}
				} else if (Object.keys(rest).length) {
					// Bail validé : seul le loyer change, par la version suivante.
					for (const column of Object.keys(rest)) {
						if (!(RENT_CHANGE_COLUMNS as readonly string[]).includes(column)) {
							throw new AppError('LEASE_TERMS_LOCKED', 'Les conditions d’un bail validé ne changent pas ; seul le loyer change.', 409, {
								column
							});
						}
					}
					if (!has(rest, 'version') || !has(rest, 'rent_effective_from')) {
						throw new AppError('VERSION_CONFLICT', 'Un changement de loyer porte sa date d’effet et la version suivante.', 409);
					}
					await this.leases.changeRent(
						op.id,
						rentChangeSchema.parse({
							rent: has(rest, 'rent') ? rest.rent : current.rent,
							charges: has(rest, 'charges') ? rest.charges : current.charges,
							effectiveFrom: rest.rent_effective_from,
							expectedVersion: Number(rest.version) - 1
						})
					);
				}
				if (status === undefined || status === current.status) return;
				if (status === 'cancelled') {
					await this.leases.cancelLease(op.id, cancelLeaseSchema.parse({ reason: reason ?? '' }).reason);
				} else if ((status === 'signed' || status === 'active') && current.status === 'draft') {
					await this.leases.validateLease(op.id);
				} else {
					throw statusRefused(status);
				}
			}
		});

		this.registry.register({
			table: 'deposit_accounts',
			operations: ['PUT', 'PATCH'],
			permission: { PUT: 'lease.create', PATCH: 'lease.update' },
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				if (op.op === 'PUT') {
					const data = columns(op, ['organization_id', 'lease_id', 'type', 'agreed_amount', 'agreed_months', 'holder', 'status']);
					if (has(data, 'status') && data.status !== 'pending') {
						throw new AppError('FIELD_NOT_WRITABLE', 'Le statut d’un compte de caution est calculé par le serveur.', 400, {
							column: 'status'
						});
					}
					await this.leases.createDepositAccount(
						createDepositAccountSchema.parse({
							id: op.id,
							leaseId: data.lease_id,
							type: data.type,
							agreedAmount: data.agreed_amount,
							agreedMonths: text(data.agreed_months),
							holder: data.holder
						})
					);
					return;
				}
				// Détenteur et statut : jamais par une modification (un mouvement holder_changed ; calculé par la base).
				const data = columns(op, ['agreed_amount', 'agreed_months']);
				await this.leases.updateDepositAgreed(
					op.id,
					updateDepositAccountSchema.parse({
						...(has(data, 'agreed_amount') ? { agreedAmount: data.agreed_amount } : {}),
						...(has(data, 'agreed_months') ? { agreedMonths: text(data.agreed_months) } : {})
					})
				);
			}
		});

		// Mouvements : ajout seul. Au lot 08, versement reçu et changement de détenteur ; les autres au lot 10 bis.
		this.registry.register({
			table: 'deposit_movements',
			operations: ['PUT'],
			permission: 'deposit.receive',
			organizationOf: organizationOfRow,
			apply: async (op) => {
				const data = columns(op, [
					'organization_id',
					'account_id',
					'type',
					'amount',
					'previous_holder',
					'new_holder',
					'reason',
					'occurred_on'
				]);
				if (data.type === 'received') {
					await this.leases.receiveDeposit(
						depositReceiptSchema.parse({
							id: op.id,
							accountId: data.account_id,
							amount: data.amount,
							occurredOn: data.occurred_on,
							reason: text(data.reason)
						})
					);
					return;
				}
				if (data.type === 'holder_changed') {
					assertCan(RequestContext.organization().role, 'lease.update');
					await this.leases.changeDepositHolder(
						depositHolderChangeSchema.parse({
							id: op.id,
							accountId: data.account_id,
							newHolder: data.new_holder,
							occurredOn: data.occurred_on,
							reason: data.reason
						})
					);
					return;
				}
				throw new AppError('DEPOSIT_MOVEMENT_NOT_ALLOWED', 'Ce mouvement de caution ne se saisit pas encore (lot 10 bis).', 409, {
					type: data.type
				});
			}
		});
	}
}
