import { Module, type OnModuleInit } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { OwnersModule } from '../owners/owners.module.js';
import { UnitOccupancy } from '../properties/occupancy.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { DepositAccountsController, LeasesController, TenantsController } from './leases.controller.js';
import { LeasesService } from './leases.service.js';
import { LeasesSyncHandlers } from './leases.sync.js';
import { occupancySignals } from './rent-dues.js';

/**
 * Module leases (lot 08) : locataires, baux et leurs versions, échéances (écrites par le serveur seul), comptes de
 * caution et leurs mouvements. Il inscrit auprès du module properties la lecture de l'occupation des unités, calculée
 * à partir de ses baux (règle 13) : le module properties ne lit jamais les tables des baux.
 */
@Module({
	imports: [OrganizationsModule, SyncModule, PropertiesModule, OwnersModule, DocumentsModule],
	controllers: [TenantsController, LeasesController, DepositAccountsController],
	providers: [LeasesService, LeasesSyncHandlers],
	exports: [LeasesService]
})
export class LeasesModule implements OnModuleInit {
	constructor(private readonly occupancy: UnitOccupancy) {}

	onModuleInit(): void {
		this.occupancy.register(occupancySignals);
	}
}
