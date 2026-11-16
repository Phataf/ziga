/**
 * Échéances émises (lot 09) : le module leases annonce chaque nouvelle échéance d'un bail (validation, changement de
 * loyer, renouvellement, baux sans fin prolongés par la tâche de nuit). Le module payments s'y inscrit pour imputer le
 * crédit du bail (trop-perçu) sur l'échéance suivante, sans lire les tables des baux ni l'inverse (CLAUDE.md §4).
 * Global : la tâche de nuit (worker) l'utilise sans importer le module leases.
 */
import { Global, Injectable, Module } from '@nestjs/common';
import type { Tx } from '../../db/database.js';
import type { AuditActor } from '../audit/audit.service.js';
import type { AuditOrigin } from '../../common/request-context.js';

export interface DuesIssuedEvent {
	tx: Tx;
	organizationId: string;
	leaseId: string;
	today: string;
	actor: AuditActor;
	origin?: AuditOrigin;
}

export type DuesIssuedListener = (event: DuesIssuedEvent) => Promise<void>;

@Injectable()
export class RentDueEvents {
	readonly #listeners: DuesIssuedListener[] = [];

	onIssued(listener: DuesIssuedListener): void {
		this.#listeners.push(listener);
	}

	/** Dans la transaction de l'organisation, après l'insertion des échéances. */
	async issued(event: DuesIssuedEvent): Promise<void> {
		for (const listener of this.#listeners) await listener(event);
	}
}

@Global()
@Module({ providers: [RentDueEvents], exports: [RentDueEvents] })
export class LeaseEventsModule {}
