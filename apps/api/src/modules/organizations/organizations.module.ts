import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { LogosService } from './logos.service.js';
import { OrganizationGuard, OrganizationTransactionInterceptor } from './organization-context.js';
import { MembershipsController, OrganizationController, PublicLogosController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';

/** Module organizations (lot 03) : organisations, membres, invitations, logos ; contexte d'organisation des routes. */
@Module({
	imports: [IdentityModule],
	controllers: [MembershipsController, OrganizationController, PublicLogosController],
	providers: [OrganizationsService, LogosService, OrganizationGuard, OrganizationTransactionInterceptor],
	exports: [OrganizationsService, OrganizationGuard, OrganizationTransactionInterceptor]
})
export class OrganizationsModule {}
