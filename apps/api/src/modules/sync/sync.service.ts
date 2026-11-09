/**
 * Envoi des modifications locales (lot 05, étape 3, docs/SYNC.md). Chaque opération est rejouée seule :
 * 1. table déclarée au registre, organisation visée, appartenance active (sinon refus, non enregistré) ;
 * 2. clé déjà reçue : son premier résultat est renvoyé, rien n'est rejoué ;
 * 3. mêmes contrôles que la route HTTP : organisation non suspendue, permission du rôle, fonctionnalité, création ;
 * 4. dans la transaction de l'organisation : la clé est enregistrée, puis le module applique l'opération (audit
 *    d'origine `sync`). Une clé reçue deux fois en même temps n'est appliquée qu'une fois (clé primaire).
 * Un refus (AppError, ZodError) est enregistré et renvoyé ; toute autre erreur est passagère : la requête échoue
 * (5xx) et l'appareil renverra le lot, sans doublon grâce aux clés.
 */
import { Injectable } from '@nestjs/common';
import { isUuid } from '@ziga/shared/ids';
import type { SyncOperation, SyncOperationResult } from '@ziga/shared/sync';
import { and, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { AppError } from '../../common/app-error.js';
import { RequestContext, type OrganizationScope } from '../../common/request-context.js';
import { DatabaseService } from '../../db/database.module.js';
import { syncOperations } from '../../db/schema/sync.js';
import { FeaturesService } from '../features/features.service.js';
import { SubscriptionsService } from '../features/subscriptions.service.js';
import { assertCan, assertWritable, requireMembership, runInOrganization } from '../organizations/organization-context.js';
import { SyncRegistry, type SyncHandler } from './sync-registry.js';

type Refusal = { code: string; message: string };

function refusalOf(error: unknown): Refusal | null {
	if (error instanceof AppError && error.status < 500) return { code: error.code, message: error.message };
	if (error instanceof ZodError) {
		const first = error.issues[0];
		return { code: 'VALIDATION_ERROR', message: first ? `Données invalides : ${first.message}` : 'Données invalides.' };
	}
	return null;
}

@Injectable()
export class SyncService {
	constructor(
		private readonly database: DatabaseService,
		private readonly registry: SyncRegistry,
		private readonly features: FeaturesService,
		private readonly subscriptions: SubscriptionsService
	) {}

	async upload(userId: string, operations: SyncOperation[]): Promise<SyncOperationResult[]> {
		const results: SyncOperationResult[] = [];
		// Dans l'ordre de la file : une modification suit toujours celle qui la précède sur l'appareil.
		for (const op of operations) results.push(await this.one(userId, op));
		return results;
	}

	private async one(userId: string, op: SyncOperation): Promise<SyncOperationResult> {
		const rejected = (r: Refusal): SyncOperationResult => ({ key: op.key, status: 'rejected', replayed: false, ...r });
		const handler = this.registry.get(op.table);
		if (!handler) return rejected({ code: 'TABLE_NOT_WRITABLE', message: 'Cette donnée ne se modifie pas depuis l’appareil.' });
		const organizationId = handler.organizationOf(op);
		if (!organizationId || !isUuid(organizationId)) {
			return rejected({ code: 'ORGANIZATION_REQUIRED', message: 'Organisation de la modification introuvable.' });
		}
		let scope: OrganizationScope;
		try {
			scope = await requireMembership(this.database, userId, organizationId);
		} catch (error) {
			const refusal = refusalOf(error);
			if (!refusal) throw error;
			// Hors de l'organisation : rien n'est écrit chez elle.
			return rejected(refusal);
		}

		const previous = await this.previous(organizationId, op.key);
		if (previous) return this.replay(op, userId, previous);

		try {
			this.check(handler, op, scope);
			if (handler.feature) {
				await this.features.assertEnabled(handler.feature, userId, await this.features.organizationContext(organizationId, scope.planId));
			}
			if (handler.creation) await this.subscriptions.assertCreationAllowed(scope);
			const applied = await runInOrganization(
				this.database,
				scope,
				userId,
				async () => {
					const recorded = await RequestContext.tx()
						.insert(syncOperations)
						.values(this.row(organizationId, userId, op, 'applied'))
						.onConflictDoNothing()
						.returning({ key: syncOperations.idempotencyKey });
					// Même clé reçue en même temps par une autre requête : elle l'a déjà appliquée.
					if (!recorded.length) return false;
					await handler.apply(op);
					return true;
				},
				'sync'
			);
			if (!applied) return this.replay(op, userId, (await this.previous(organizationId, op.key))!);
			return { key: op.key, status: 'applied', replayed: false };
		} catch (error) {
			const refusal = refusalOf(error);
			if (!refusal) throw error;
			await this.database.withOrganization(organizationId, (tx) =>
				tx
					.insert(syncOperations)
					.values(this.row(organizationId, userId, op, 'rejected', refusal))
					.onConflictDoNothing()
			);
			return rejected(refusal);
		}
	}

	/** Contrôles des routes HTTP, dans le même ordre : opération permise, organisation modifiable, permission du rôle. */
	private check(handler: SyncHandler, op: SyncOperation, scope: OrganizationScope): void {
		if (!handler.operations.includes(op.op)) {
			throw new AppError('OPERATION_NOT_ALLOWED', 'Cette opération n’est pas permise sur cette donnée.', 409, {
				op: op.op,
				table: op.table
			});
		}
		assertWritable(scope);
		assertCan(scope.role, handler.permission);
	}

	private previous(organizationId: string, key: string) {
		return this.database.withOrganization(organizationId, async (tx) => {
			const [row] = await tx
				.select()
				.from(syncOperations)
				.where(and(eq(syncOperations.organizationId, organizationId), eq(syncOperations.idempotencyKey, key)))
				.limit(1);
			return row;
		});
	}

	private replay(op: SyncOperation, userId: string, previous: typeof syncOperations.$inferSelect): SyncOperationResult {
		// Une clé est propre à une base locale : reçue d'une autre personne, c'est une collision, jamais un rejeu.
		if (previous.userId !== userId) {
			return { key: op.key, status: 'rejected', replayed: false, code: 'IDEMPOTENCY_CONFLICT', message: 'Clé d’opération déjà utilisée.' };
		}
		return {
			key: op.key,
			status: previous.status,
			replayed: true,
			...(previous.code ? { code: previous.code, message: previous.message ?? '' } : {})
		};
	}

	private row(organizationId: string, userId: string, op: SyncOperation, status: 'applied' | 'rejected', refusal?: Refusal) {
		return {
			organizationId,
			idempotencyKey: op.key,
			userId,
			operation: op.op,
			tableName: op.table,
			rowId: op.id,
			status,
			code: refusal?.code ?? null,
			message: refusal?.message ?? null
		};
	}
}
