/**
 * Crochets de création d'une organisation (lot 06). Un autre module s'y inscrit au démarrage pour ajouter ce qui naît
 * avec l'organisation, dans la même transaction, avec son propre service : le module organizations ne lit ni n'écrit
 * jamais les tables des autres modules (CLAUDE.md §4). Exemple : la fiche propriétaire et le mandat self_managed d'un
 * bailleur particulier (module owners).
 */
import { Injectable } from '@nestjs/common';
import type { OrganizationType } from '@ziga/shared/permissions';
import type { Tx } from '../../db/database.js';

export interface OrganizationCreated {
	organizationId: string;
	type: OrganizationType;
	legalName: string;
	phone: string;
	/** Personne qui crée l'organisation (elle en devient directrice). */
	userId: string;
}

export type OrganizationCreationHook = (tx: Tx, event: OrganizationCreated) => Promise<void>;

@Injectable()
export class OrganizationCreationHooks {
	readonly #hooks: OrganizationCreationHook[] = [];

	register(hook: OrganizationCreationHook): void {
		this.#hooks.push(hook);
	}

	/** Dans la transaction de création : un crochet qui échoue annule toute la création. */
	async run(tx: Tx, event: OrganizationCreated): Promise<void> {
		for (const hook of this.#hooks) await hook(tx, event);
	}
}
