import { Module } from '@nestjs/common';
import { FeaturesModule } from '../features/features.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LeasesModule } from '../leases/leases.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { OwnersModule } from '../owners/owners.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { SyncModule } from '../sync/sync.module.js';
import {
	ArrearsController,
	ExpensesController,
	PayoutsController,
	PublicStatementsController,
	ReminderSettingsController,
	RemindersController,
	StatementsController
} from './collections.controller.js';
import { CollectionsSyncHandlers } from './collections.sync.js';
import { ExpensesService } from './expenses.service.js';
import { RemindersService } from './reminders.service.js';
import { StatementsService } from './statements.service.js';

/**
 * Module collections (lot 10) : impayés, relances, dépenses, relevés propriétaires, reversements. Il lit les autres
 * modules par leurs services publics (owners, properties, leases, payments) et inscrit son lecteur de dépenses auprès du
 * module payments. Seul à lire et écrire ses tables (règle ESLint et test d'architecture).
 */
@Module({
	imports: [OrganizationsModule, SyncModule, OwnersModule, PropertiesModule, LeasesModule, PaymentsModule, FeaturesModule, IdentityModule],
	controllers: [
		ArrearsController,
		RemindersController,
		ReminderSettingsController,
		ExpensesController,
		StatementsController,
		PayoutsController,
		PublicStatementsController
	],
	providers: [ExpensesService, RemindersService, StatementsService, CollectionsSyncHandlers],
	exports: [StatementsService, ExpensesService]
})
export class CollectionsModule {}
