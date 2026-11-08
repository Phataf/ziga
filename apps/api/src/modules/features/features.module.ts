import { Global, Module } from '@nestjs/common';
import { FeatureAdminService } from './feature-admin.service.js';
import { CreationGuard, FeatureGuard } from './feature.guards.js';
import { MeFeaturesController, OrganizationFeaturesController } from './features.controller.js';
import { FeaturesService } from './features.service.js';
import { QuotasService } from './quotas.service.js';
import { SubscriptionsService } from './subscriptions.service.js';

/**
 * Module features (lot 04) : interrupteurs, formules, quotas et abonnements. Seul à lire leurs tables ; les autres
 * modules passent par ses services (CLAUDE.md §4 et §8). Global : chaque module peut poser @RequiresFeature et @Creation.
 */
@Global()
@Module({
	controllers: [MeFeaturesController, OrganizationFeaturesController],
	providers: [FeaturesService, QuotasService, SubscriptionsService, FeatureAdminService, FeatureGuard, CreationGuard],
	exports: [FeaturesService, QuotasService, SubscriptionsService, FeatureAdminService, FeatureGuard, CreationGuard]
})
export class FeaturesModule {}
