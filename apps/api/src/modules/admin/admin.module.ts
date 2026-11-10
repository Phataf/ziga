import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { AdminDatabase } from './admin-database.service.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { PlatformGuard } from './platform.guard.js';

/**
 * Module admin (lot 04) : back-office de la plateforme, seul détenteur de la connexion app_admin (AdminDatabase,
 * non exportée). Toutes ses routes sont sous /admin et passent par @PlatformCan.
 */
@Module({
	imports: [IdentityModule, OrganizationsModule, PropertiesModule],
	controllers: [AdminController],
	providers: [AdminDatabase, AdminService, PlatformGuard]
})
export class AdminModule {}
