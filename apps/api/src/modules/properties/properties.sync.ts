/**
 * Biens et unités modifiés sur l'appareil (lot 07, docs/SYNC.md §5 à §7). Mêmes permissions, mêmes schémas Zod et
 * même service (audit compris) que les routes HTTP du module.
 * - PUT : création (UUIDv7 de l'appareil), en brouillon ; bloquée par un abonnement échu, comme @Creation().
 * - PATCH : seules les colonnes modifiées ; elles complètent la fiche, revalidée en entier.
 * - Unité : l'agent de terrain n'envoie que l'état technique de ses unités affectées ; les caractéristiques et la
 *   fiche exigent property.manage, l'affectation unit.assign. L'occupation n'a pas de colonne : toute colonne hors liste
 *   est refusée (FIELD_NOT_WRITABLE).
 * - Statut de fiche : jamais repris tel quel ; « active » et « archived » passent par les mêmes règles que la route.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import {
	assignUnitSchema,
	createPropertySchema,
	createUnitSchema,
	recordStatusSchema,
	technicalStatusSchema,
	updatePropertySchema,
	updateUnitSchema
} from '@ziga/shared/properties';
import type { SyncOperation } from '@ziga/shared/sync';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { assertCan } from '../organizations/organization-context.js';
import { organizationOfRow, SyncRegistry } from '../sync/sync-registry.js';
import { PropertiesService } from './properties.service.js';

const PROPERTY_COLUMNS = [
	'owner_id',
	'type',
	'operation',
	'name',
	'commune_id',
	'neighborhood_id',
	'address_hint',
	'gps_lat',
	'gps_lng',
	'gps_accuracy_m',
	'declared_land_documents',
	'notes'
] as const;

const ROOM_COLUMNS = {
	bedrooms: 'bedrooms',
	living_rooms: 'livingRooms',
	kitchens: 'kitchens',
	bathrooms: 'bathrooms',
	terraces: 'terraces',
	laundries: 'laundries'
} as const;

const UNIT_COLUMNS = [
	'type',
	'label',
	...Object.keys(ROOM_COLUMNS),
	'surface_m2',
	'land_area_m2',
	'usage',
	'furnished',
	'amenities',
	'rent',
	'charges',
	'deposit_amount',
	'advance_months'
] as const;
const TECHNICAL_COLUMNS = ['technical_status', 'technical_reason', 'technical_expected_on'] as const;

/** Colonnes de l'opération, refusées si l'une n'est pas dans la liste (FIELD_NOT_WRITABLE). */
function columns(op: SyncOperation, allowed: readonly string[]): Record<string, unknown> {
	const data = { ...(op.data ?? {}) };
	for (const column of Object.keys(data)) {
		if (!allowed.includes(column))
			throw new AppError('FIELD_NOT_WRITABLE', `Ce champ ne se modifie pas depuis l’appareil : ${column}.`, 400, { column });
	}
	return data;
}

const has = (data: Record<string, unknown>, column: string) => Object.hasOwn(data, column);
const text = (value: unknown): unknown => (value === '' ? null : value);
const bool = (value: unknown): unknown => (value === 1 ? true : value === 0 ? false : value);

/** Tableau de la base locale : texte JSON (SQLite). Toute autre forme est laissée à Zod, qui la refusera. */
function list(value: unknown): unknown {
	if (value === null || value === undefined || value === '') return [];
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function propertyFields(data: Record<string, unknown>, current?: { lat: number; lng: number; accuracyM: number | null } | null) {
	const out: Record<string, unknown> = {};
	const map = {
		owner_id: 'ownerId',
		type: 'type',
		operation: 'operation',
		name: 'name',
		commune_id: 'communeId',
		neighborhood_id: 'neighborhoodId',
		address_hint: 'addressHint',
		notes: 'notes'
	} as const;
	for (const [column, field] of Object.entries(map)) if (has(data, column)) out[field] = text(data[column]);
	if (has(data, 'declared_land_documents')) out.declaredLandDocuments = list(data.declared_land_documents);
	if (has(data, 'gps_lat') || has(data, 'gps_lng') || has(data, 'gps_accuracy_m')) {
		const lat = has(data, 'gps_lat') ? data.gps_lat : (current?.lat ?? null);
		const lng = has(data, 'gps_lng') ? data.gps_lng : (current?.lng ?? null);
		const accuracyM = has(data, 'gps_accuracy_m') ? data.gps_accuracy_m : (current?.accuracyM ?? null);
		out.gps = lat === null && lng === null ? null : { lat, lng, accuracyM };
	}
	return out;
}

function unitFields(data: Record<string, unknown>) {
	const out: Record<string, unknown> = {};
	const map = {
		type: 'type',
		label: 'label',
		surface_m2: 'surfaceM2',
		land_area_m2: 'landAreaM2',
		usage: 'usage',
		rent: 'rent',
		charges: 'charges',
		deposit_amount: 'depositAmount',
		advance_months: 'advanceMonths'
	} as const;
	for (const [column, field] of Object.entries(map)) if (has(data, column)) out[field] = text(data[column]);
	if (has(data, 'furnished')) out.furnished = bool(data.furnished);
	if (has(data, 'amenities')) out.amenities = list(data.amenities);
	const rooms = Object.entries(ROOM_COLUMNS).filter(([column]) => has(data, column));
	if (rooms.length) out.rooms = Object.fromEntries(rooms.map(([column, field]) => [field, data[column]]));
	return out;
}

function statusRefused(): AppError {
	return new AppError('STATUS_NOT_ALLOWED', 'Ce statut ne se choisit pas depuis l’appareil.', 409);
}

@Injectable()
export class PropertiesSyncHandlers implements OnModuleInit {
	constructor(
		private readonly registry: SyncRegistry,
		private readonly properties: PropertiesService
	) {}

	onModuleInit(): void {
		this.registry.register({
			table: 'properties',
			operations: ['PUT', 'PATCH'],
			permission: 'property.manage',
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				if (op.op === 'PUT') {
					const data = columns(op, ['organization_id', ...PROPERTY_COLUMNS, 'record_status']);
					// Le bien naît en brouillon ; l'appareil l'active ensuite par une modification.
					if (has(data, 'record_status') && data.record_status !== 'draft') throw statusRefused();
					await this.properties.createProperty(createPropertySchema.parse({ id: op.id, ...propertyFields(data) }));
					return;
				}
				const { record_status: status, ...rest } = columns(op, [...PROPERTY_COLUMNS, 'record_status']);
				if (Object.keys(rest).length) {
					const current =
						has(rest, 'gps_lat') || has(rest, 'gps_lng') || has(rest, 'gps_accuracy_m') ? (await this.properties.get(op.id)).gps : null;
					await this.properties.updateProperty(op.id, updatePropertySchema.parse(propertyFields(rest, current)));
				}
				if (status !== undefined) await this.properties.setPropertyStatus(op.id, recordStatusSchema.parse({ status }).status);
			}
		});

		this.registry.register({
			table: 'units',
			operations: ['PUT', 'PATCH'],
			// Le minimum commun : l'agent de terrain change l'état technique de ses unités ; le reste est vérifié colonne par
			// colonne ci-dessous, avec la permission de la route équivalente.
			permission: { PUT: 'property.manage', PATCH: 'unit.status' },
			creation: ['PUT'],
			organizationOf: organizationOfRow,
			apply: async (op) => {
				const role = RequestContext.organization().role;
				if (op.op === 'PUT') {
					const data = columns(op, [
						'organization_id',
						'property_id',
						...UNIT_COLUMNS,
						'record_status',
						'technical_status',
						'assigned_agent_id'
					]);
					if (has(data, 'record_status') && data.record_status !== 'draft') throw statusRefused();
					if (has(data, 'technical_status') && data.technical_status !== 'ready') throw statusRefused();
					await this.properties.createUnit(createUnitSchema.parse({ id: op.id, propertyId: data.property_id, ...unitFields(data) }));
					const agent = text(data.assigned_agent_id);
					if (agent !== null && agent !== undefined) {
						assertCan(role, 'unit.assign');
						await this.properties.assign(op.id, idSchema.parse(agent));
					}
					return;
				}
				const data = columns(op, [...UNIT_COLUMNS, ...TECHNICAL_COLUMNS, 'assigned_agent_id', 'record_status']);
				const characteristics = UNIT_COLUMNS.filter((c) => has(data, c));
				if (characteristics.length) {
					assertCan(role, 'property.manage');
					await this.properties.updateUnit(
						op.id,
						updateUnitSchema.parse(unitFields(Object.fromEntries(characteristics.map((c) => [c, data[c]]))))
					);
				}
				if (TECHNICAL_COLUMNS.some((c) => has(data, c))) {
					const current = await this.properties.getUnit(op.id);
					await this.properties.setTechnicalStatus(
						op.id,
						technicalStatusSchema.parse({
							technicalStatus: has(data, 'technical_status') ? data.technical_status : current.technicalStatus,
							reason: has(data, 'technical_reason') ? text(data.technical_reason) : current.technicalReason,
							expectedOn: has(data, 'technical_expected_on') ? text(data.technical_expected_on) : current.technicalExpectedOn
						})
					);
				}
				if (has(data, 'assigned_agent_id')) {
					assertCan(role, 'unit.assign');
					await this.properties.assign(op.id, assignUnitSchema.parse({ agentId: text(data.assigned_agent_id) ?? null }).agentId);
				}
				if (has(data, 'record_status')) {
					assertCan(role, 'property.manage');
					await this.properties.setUnitStatus(op.id, recordStatusSchema.parse({ status: data.record_status }).status);
				}
			}
		});
	}
}
