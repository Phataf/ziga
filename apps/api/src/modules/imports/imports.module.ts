import { Module } from '@nestjs/common';
import { FeaturesModule } from '../features/features.module.js';
import { LeasesModule } from '../leases/leases.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { OwnersModule } from '../owners/owners.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { ImportExecutor } from './import-executor.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

/**
 * Import Excel (lot 11). Le module n'écrit que dans `import_jobs` ; tout le reste passe par les services publics des
 * modules qu'il importe (CLAUDE.md §4, test d'architecture).
 */
@Module({
	imports: [OrganizationsModule, FeaturesModule, OwnersModule, PropertiesModule, LeasesModule, PaymentsModule],
	controllers: [ImportsController],
	providers: [ImportsService, ImportExecutor],
	exports: [ImportsService, ImportExecutor]
})
export class ImportsModule {}
