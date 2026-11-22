import { Module } from '@nestjs/common';
import { LeasesModule } from '../leases/leases.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { PortalsController } from './portals.controller.js';
import { PortalsService } from './portals.service.js';

/**
 * Module portals (lot 10 ter) : espaces propriétaire et locataire, le seul à lire dans plusieurs organisations, l'une
 * après l'autre, chacune dans son propre contexte (CLAUDE.md §4). Il ne lit aucune table d'un autre module : il passe
 * par leurs services publics.
 */
@Module({
	imports: [OrganizationsModule, PropertiesModule, LeasesModule, PaymentsModule],
	controllers: [PortalsController],
	providers: [PortalsService]
})
export class PortalsModule {}
