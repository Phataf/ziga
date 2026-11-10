import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { LogosService } from './logos.service.js';
import { OrganizationCreationHooks } from './organization-hooks.js';
import { OrganizationGuard, OrganizationTransactionInterceptor } from './organization-context.js';
import { MembershipsController, OrganizationController, PublicLogosController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { OrganizationsSyncHandlers } from './organizations.sync.js';

/** Module organizations (lot 03) : organisations, membres, invitations, logos ; contexte d'organisation des routes. */
@Module({
	imports: [IdentityModule, SyncModule],
	controllers: [MembershipsController, OrganizationController, PublicLogosController],
	providers: [
		OrganizationsService,
		LogosService,
		OrganizationGuard,
		OrganizationTransactionInterceptor,
		OrganizationsSyncHandlers,
		OrganizationCreationHooks
	],
	exports: [OrganizationsService, OrganizationGuard, OrganizationTransactionInterceptor, OrganizationCreationHooks]
})
export class OrganizationsModule {}
