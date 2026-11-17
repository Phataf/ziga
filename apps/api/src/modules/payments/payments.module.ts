import { Module } from '@nestjs/common';
import { FeaturesModule } from '../features/features.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LeasesModule } from '../leases/leases.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { ExpenseClaims } from './expense-claims.js';
import { PaymentProviders } from './payment-provider.js';
import { PaymentsController, PublicReceiptsController, ReceiptSettingsController, ReceiptsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PaymentsSyncHandlers } from './payments.sync.js';

/**
 * Module payments (lot 09) : encaissements, imputations, reçus, adaptateurs de paiement (registre des prestataires,
 * `manual` au lot 09). Il lit les baux par le service public du module leases, et s'inscrit à ses échéances émises
 * pour imputer le crédit du bail. Seul à lire et écrire ses tables (règle ESLint et test d'architecture).
 */
@Module({
	imports: [OrganizationsModule, SyncModule, LeasesModule, PropertiesModule, FeaturesModule, IdentityModule],
	controllers: [PaymentsController, ReceiptsController, ReceiptSettingsController, PublicReceiptsController],
	providers: [PaymentsService, PaymentsSyncHandlers, PaymentProviders, ExpenseClaims],
	exports: [PaymentsService, PaymentProviders, ExpenseClaims]
})
export class PaymentsModule {}
