/**
 * Modèle de référence (lot 05, étape 3, docs/SYNC.md) : les paramètres de l'organisation, modifiés sur l'appareil.
 * Mêmes permission (organization.update), validation (updateOrganizationSchema) et service (OrganizationsService.update,
 * audit compris) que PATCH /organization. Une opération PATCH ne porte que les champs modifiés : seuls ceux-là sont
 * appliqués, la dernière écriture l'emporte champ par champ.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { updateOrganizationSchema, type Representative } from '@ziga/shared/organizations';
import type { SyncOperation } from '@ziga/shared/sync';
import { AppError } from '../../common/app-error.js';
import { SyncRegistry } from '../sync/sync-registry.js';
import { OrganizationsService } from './organizations.service.js';

/** Colonnes de la table locale `organizations` modifiables depuis l'appareil, et le champ de l'API correspondant. */
const ORGANIZATION_FIELDS = {
	legal_name: 'legalName',
	trade_name: 'tradeName',
	phone: 'phone',
	address: 'address',
	commune: 'commune',
	po_box: 'poBox',
	rccm: 'rccm',
	ifu: 'ifu'
} as const;

/** Colonnes de la table locale `organization_representatives` (directeur seulement), champ du représentant. */
const REPRESENTATIVE_FIELDS = {
	rep_name: 'name',
	rep_title: 'title',
	rep_profession: 'profession',
	rep_address: 'address',
	rep_nationality: 'nationality',
	rep_id_type: 'idType',
	rep_id_type_other: 'idTypeOther',
	rep_id_number: 'idNumber',
	rep_id_issued_on: 'idIssuedOn',
	rep_id_issued_by: 'idIssuedBy'
} as const satisfies Record<string, keyof Representative>;

/** Champs envoyés, traduits ; une colonne non modifiable (formule, statut, logo…) est un refus. */
function fields<T extends Record<string, string>>(op: SyncOperation, map: T): Partial<Record<T[keyof T], unknown>> {
	const out: Partial<Record<T[keyof T], unknown>> = {};
	for (const [column, value] of Object.entries(op.data ?? {})) {
		if (!(column in map))
			throw new AppError('FIELD_NOT_WRITABLE', `Ce champ ne se modifie pas depuis l’appareil : ${column}.`, 400, { column });
		out[map[column as keyof T]] = value === '' ? null : value;
	}
	return out;
}

@Injectable()
export class OrganizationsSyncHandlers implements OnModuleInit {
	constructor(
		private readonly registry: SyncRegistry,
		private readonly organizations: OrganizationsService
	) {}

	onModuleInit(): void {
		this.registry.register({
			table: 'organizations',
			operations: ['PATCH'],
			permission: 'organization.update',
			organizationOf: (op) => op.id,
			apply: async (op) => {
				await this.organizations.update(updateOrganizationSchema.parse(fields(op, ORGANIZATION_FIELDS)));
			}
		});
		this.registry.register({
			table: 'organization_representatives',
			operations: ['PATCH'],
			permission: 'organization.update',
			organizationOf: (op) => op.id,
			apply: async (op) => {
				// Le représentant se valide en entier : les champs reçus complètent ceux du serveur.
				const current = (await this.organizations.view()).representative;
				const representative = { ...current, ...fields(op, REPRESENTATIVE_FIELDS) };
				await this.organizations.update(updateOrganizationSchema.parse({ representative }));
			}
		});
	}
}
