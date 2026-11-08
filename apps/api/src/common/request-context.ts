/**
 * Contexte de la requête en cours (AsyncLocalStorage) : identifiant de requête, adresse IP, origine, et,
 * dans une route @OrganizationScoped(), la transaction ouverte par withOrganization().
 * Les services lisent la transaction par `RequestContext.tx()` : écriture métier et audit partagent la même
 * transaction, qui réussit ou échoue d'un bloc (CLAUDE.md règle 4).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { OrganizationRole, OrganizationType } from '@ziga/shared/permissions';
import { AppError } from './app-error.js';
import type { Tx } from '../db/database.js';

export type AuditOrigin = 'app' | 'api' | 'admin' | 'sync' | 'job';

export interface OrganizationScope {
	organizationId: string;
	organizationType: OrganizationType;
	role: OrganizationRole;
	memberId: string;
}

export interface RequestStore {
	requestId?: string;
	ip?: string;
	origin: AuditOrigin;
	userId?: string;
	organization?: OrganizationScope;
	tx?: Tx;
	/** Tâches à lancer après la validation de la transaction (ex. ajout d'une tâche de fond). */
	afterCommit?: (() => Promise<void> | void)[];
}

const storage = new AsyncLocalStorage<RequestStore>();

export const RequestContext = {
	run<T>(store: RequestStore, fn: () => T): T {
		return storage.run(store, fn);
	},

	get(): RequestStore | undefined {
		return storage.getStore();
	},

	/** Transaction de l'organisation active. Hors d'une route @OrganizationScoped(), c'est une erreur de programmation. */
	tx(): Tx {
		const tx = storage.getStore()?.tx;
		if (!tx) throw new AppError('NO_ORGANIZATION_CONTEXT', 'Contexte d’organisation absent.', 500);
		return tx;
	},

	organization(): OrganizationScope {
		const scope = storage.getStore()?.organization;
		if (!scope) throw new AppError('NO_ORGANIZATION_CONTEXT', 'Contexte d’organisation absent.', 500);
		return scope;
	},

	/** Exécute `fn` après la validation ; immédiatement s'il n'y a pas de transaction de requête. */
	afterCommit(fn: () => Promise<void> | void): void {
		const store = storage.getStore();
		if (store?.afterCommit) store.afterCommit.push(fn);
		else void fn();
	}
};
