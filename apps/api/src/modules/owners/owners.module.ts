import { Module, type OnModuleInit } from '@nestjs/common';
import { OrganizationCreationHooks } from '../organizations/organization-hooks.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { PersonLinkRecords } from '../organizations/person-link-records.js';
import { SyncModule } from '../sync/sync.module.js';
import { MandatesController, OwnersController } from './owners.controller.js';
import { OwnersService } from './owners.service.js';
import { OwnersSyncHandlers } from './owners.sync.js';

/**
 * Module owners (lot 06) : propriétaires, mandats et leurs versions, portées (règle 12, remplies au lot 07).
 * Il s'inscrit à la création des organisations : un bailleur particulier naît avec sa fiche et son mandat self_managed.
 */
@Module({
	imports: [OrganizationsModule, SyncModule],
	controllers: [OwnersController, MandatesController],
	providers: [OwnersService, OwnersSyncHandlers],
	exports: [OwnersService]
})
export class OwnersModule implements OnModuleInit {
	constructor(
		private readonly hooks: OrganizationCreationHooks,
		private readonly owners: OwnersService,
		private readonly linkable: PersonLinkRecords
	) {}

	onModuleInit(): void {
		this.hooks.register((tx, event) => this.owners.createLandlordSelfManaged(tx, event));
		// Lot 10 ter : les fiches propriétaire se lient au compte d'une personne (module organizations).
		this.linkable.register('owner', this.owners.linkableRecords);
	}
}
