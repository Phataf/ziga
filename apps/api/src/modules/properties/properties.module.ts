import { Module } from '@nestjs/common';
import { FeaturesModule } from '../features/features.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { OwnersModule } from '../owners/owners.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { GeographyService } from './geography.service.js';
import { PropertiesController, UnitsController } from './properties.controller.js';
import { PropertiesService } from './properties.service.js';
import { PropertiesSyncHandlers } from './properties.sync.js';
import { MediaController, PublicMediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { MediaSyncHandlers } from './media.sync.js';

/**
 * Module properties (lot 07) : biens, unités (statut en quatre dimensions), affectation aux agents de terrain, et
 * référentiel géographique (lu par tous, complété par le back-office avec la connexion app_admin, qui lui passe sa
 * transaction). Les portées de mandat restent au module owners, appelé par son service public.
 */
@Module({
	imports: [OrganizationsModule, SyncModule, FeaturesModule, OwnersModule],
	controllers: [PropertiesController, UnitsController, MediaController, PublicMediaController],
	providers: [PropertiesService, PropertiesSyncHandlers, GeographyService, MediaService, MediaSyncHandlers],
	exports: [PropertiesService, GeographyService, MediaService]
})
export class PropertiesModule {}
