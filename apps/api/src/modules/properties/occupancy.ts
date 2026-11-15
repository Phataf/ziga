/**
 * Occupation des unités (règle 13, D14) : calculée à partir des baux, jamais stockée ni saisie. Le module properties ne
 * lit pas les baux (CLAUDE.md §4) : le module leases inscrit ici, au démarrage, la fonction qui traduit les baux d'une
 * unité en signaux (packages/shared, leaseOccupancySignal). Même modèle que les crochets de création d'organisation.
 * Sans lecteur inscrit (tests du lot 07), toute unité est libre.
 */
import { Injectable } from '@nestjs/common';
import type { OccupancySignal } from '@ziga/shared/properties';
import type { Tx } from '../../db/database.js';

export type OccupancyReader = (
	tx: Tx,
	organizationId: string,
	unitIds: readonly string[],
	today: string
) => Promise<Map<string, OccupancySignal[]>>;

@Injectable()
export class UnitOccupancy {
	#reader: OccupancyReader | null = null;

	register(reader: OccupancyReader): void {
		if (this.#reader) throw new Error('Lecteur d’occupation déjà inscrit.');
		this.#reader = reader;
	}

	async signals(tx: Tx, organizationId: string, unitIds: readonly string[], today: string): Promise<Map<string, OccupancySignal[]>> {
		if (!this.#reader || !unitIds.length) return new Map();
		return this.#reader(tx, organizationId, unitIds, today);
	}
}
