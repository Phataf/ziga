/**
 * Fiches qu'une personne peut lier à son compte (lot 10 ter). Le module organizations détient les liens, jamais les
 * fiches : les modules owners (propriétaires) et leases (locataires) s'inscrivent ici au démarrage avec leur propre
 * service, comme pour les crochets de création (CLAUDE.md §4). Chaque lecture reçoit la transaction de l'organisation
 * en cours (withOrganization) : une seule organisation à la fois.
 */
import { Injectable } from '@nestjs/common';
import type { PersonLinkRecordType } from '@ziga/shared/person-links';
import { AppError } from '../../common/app-error.js';
import type { Tx } from '../../db/database.js';

export interface LinkableRecord {
	id: string;
	name: string;
	/** Numéro de la fiche (E.164), vide si elle n'en a pas. */
	phone: string | null;
}

export interface LinkableRecordResolver {
	/** Fiche active de l'organisation de la transaction, ou null. */
	byId(tx: Tx, id: string): Promise<LinkableRecord | null>;
	/** Fiches actives de l'organisation de la transaction à ce numéro, la plus récente d'abord. */
	byPhone(tx: Tx, phone: string): Promise<LinkableRecord[]>;
	/** Propriétaires seulement : la propre fiche d'un bailleur particulier (mandat self_managed). */
	selfManaged?(tx: Tx): Promise<LinkableRecord | null>;
}

@Injectable()
export class PersonLinkRecords {
	readonly #resolvers = new Map<PersonLinkRecordType, LinkableRecordResolver>();

	register(type: PersonLinkRecordType, resolver: LinkableRecordResolver): void {
		this.#resolvers.set(type, resolver);
	}

	resolver(type: PersonLinkRecordType): LinkableRecordResolver {
		const r = this.#resolvers.get(type);
		if (!r) throw new AppError('PERSON_LINK_RECORDS_MISSING', `Aucun module n'a inscrit les fiches « ${type} ».`, 500);
		return r;
	}
}
