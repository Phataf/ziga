/**
 * Registre des opérations modifiables depuis l'appareil (lot 05, étape 3). Chaque module déclare ses tables, au
 * démarrage, avec la permission, l'interrupteur et la règle de création qui gardent sa route HTTP équivalente ; il
 * applique l'opération avec son propre service public (CLAUDE.md §4). Une table absente du registre n'est jamais
 * modifiable depuis l'appareil.
 */
import { Injectable } from '@nestjs/common';
import type { FeatureKey } from '@ziga/shared/features';
import type { Action } from '@ziga/shared/permissions';
import type { SyncOperation, SyncOperationType } from '@ziga/shared/sync';

export interface SyncHandler {
	table: string;
	operations: readonly SyncOperationType[];
	/**
	 * Permission du rôle, la même que celle de la route HTTP (403 FORBIDDEN_ACTION) : une seule pour toutes les
	 * opérations, ou une par opération (création et modification n'ont pas toujours la même).
	 */
	permission: Action | Partial<Record<SyncOperationType, Action>>;
	/** Fonctionnalité optionnelle exigée (403 FEATURE_DISABLED), comme @RequiresFeature. */
	feature?: FeatureKey;
	/**
	 * Création bloquée quand l'abonnement est échu (403 SUBSCRIPTION_EXPIRED), comme @Creation : pour toutes les
	 * opérations (`true`), ou pour celles listées (une création, PUT, mais pas une modification).
	 */
	creation?: boolean | readonly SyncOperationType[];
	/**
	 * Organisation visée par l'opération : l'identifiant de la ligne, sa colonne organization_id, ou l'organisation
	 * jointe par le connecteur (`organizationOfRow`).
	 */
	organizationOf(op: SyncOperation): string | null;
	/**
	 * Applique l'opération dans la transaction de l'organisation (RequestContext, origine `sync`), avec la même
	 * validation Zod et le même service que la route HTTP. Une AppError ou une ZodError est un refus.
	 */
	apply(op: SyncOperation): Promise<void>;
}

@Injectable()
export class SyncRegistry {
	readonly #handlers = new Map<string, SyncHandler>();

	register(handler: SyncHandler): void {
		if (this.#handlers.has(handler.table)) throw new Error(`Table déjà déclarée pour la synchronisation : ${handler.table}`);
		this.#handlers.set(handler.table, handler);
	}

	get(table: string): SyncHandler | undefined {
		return this.#handlers.get(table);
	}

	tables(): string[] {
		return [...this.#handlers.keys()].sort();
	}
}

/** Organisation d'une ligne de table d'organisation : colonne envoyée (PUT) ou organisation jointe par le connecteur (PATCH). */
export function organizationOfRow(op: SyncOperation): string | null {
	const column = op.data?.organization_id;
	return typeof column === 'string' ? column : (op.organizationId ?? null);
}

/** Permission exigée pour cette opération ; une opération sans permission déclarée n'est pas permise. */
export function permissionFor(handler: SyncHandler, op: SyncOperationType): Action | null {
	return typeof handler.permission === 'string' ? handler.permission : (handler.permission[op] ?? null);
}

/** L'opération est-elle une création, bloquée par un abonnement échu ? */
export function isCreation(handler: SyncHandler, op: SyncOperationType): boolean {
	return Array.isArray(handler.creation) ? handler.creation.includes(op) : handler.creation === true;
}
