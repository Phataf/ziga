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
	/** Permission du rôle, la même que celle de la route HTTP (403 FORBIDDEN_ACTION). */
	permission: Action;
	/** Fonctionnalité optionnelle exigée (403 FEATURE_DISABLED), comme @RequiresFeature. */
	feature?: FeatureKey;
	/** Création bloquée quand l'abonnement est échu (403 SUBSCRIPTION_EXPIRED), comme @Creation. */
	creation?: boolean;
	/** Organisation visée par l'opération : l'identifiant de la ligne, ou sa colonne organization_id. */
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
