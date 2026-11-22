import { Module, type OnModuleInit } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { PersonLinkRecords } from '../organizations/person-link-records.js';
import { OwnersModule } from '../owners/owners.module.js';
import { UnitOccupancy } from '../properties/occupancy.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import {
	AmendmentsController,
	ContractsController,
	ContractTemplatesController,
	LeaseContractsController
} from './contracts/contracts.controller.js';
import { ExitController } from './exit.controller.js';
import { ExitService } from './exit.service.js';
import { ExitSyncHandlers } from './exit.sync.js';
import { ContractsService } from './contracts/contracts.service.js';
import { createPdfConverter, PDF_CONVERTER } from './contracts/pdf-converter.js';
import { HandwrittenScanProvider, SIGNATURE_PROVIDER } from './contracts/signature-provider.js';
import { DepositAccountsController, LeasesController, TenantsController } from './leases.controller.js';
import { LeasesService } from './leases.service.js';
import { LeasesSyncHandlers } from './leases.sync.js';
import { occupancySignals } from './rent-dues.js';

/**
 * Module leases (lot 08) : locataires, baux et leurs versions, échéances (écrites par le serveur seul), comptes de
 * caution et leurs mouvements. Il inscrit auprès du module properties la lecture de l'occupation des unités, calculée
 * à partir de ses baux (règle 13) : le module properties ne lit jamais les tables des baux.
 * Lot 08 bis : contrats, versions, modèles et avenants (contracts/), génération en tâche de fond (worker).
 */
@Module({
	imports: [OrganizationsModule, SyncModule, PropertiesModule, OwnersModule, DocumentsModule],
	controllers: [
		ExitController,
		TenantsController,
		LeasesController,
		DepositAccountsController,
		ContractTemplatesController,
		ContractsController,
		LeaseContractsController,
		AmendmentsController
	],
	providers: [
		ExitService,
		ExitSyncHandlers,
		LeasesService,
		LeasesSyncHandlers,
		ContractsService,
		// Lot 08 bis : conversion en PDF (Gotenberg) et signature (manuscrite, scan déposé), derrière leurs interfaces.
		{ provide: PDF_CONVERTER, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createPdfConverter(config) },
		{ provide: SIGNATURE_PROVIDER, useClass: HandwrittenScanProvider }
	],
	exports: [LeasesService, ContractsService, ExitService]
})
export class LeasesModule implements OnModuleInit {
	constructor(
		private readonly occupancy: UnitOccupancy,
		private readonly leases: LeasesService,
		private readonly linkable: PersonLinkRecords
	) {}

	onModuleInit(): void {
		this.occupancy.register(occupancySignals);
		// Lot 10 ter : les fiches locataire se lient au compte d'une personne (module organizations).
		this.linkable.register('tenant', this.leases.linkableRecords);
	}
}
