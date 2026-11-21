import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { loggerParams } from './common/logger.js';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/env.js';
import { DatabaseModule } from './db/database.module.js';
import { ContractsWorkerModule } from './jobs/contracts-worker.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { PaymentsWorkerModule } from './jobs/receipts.processor.js';
import { StatementsWorkerModule } from './jobs/statements.processor.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { ExitHooksModule } from './modules/leases/exit-hooks.js';
import { LeaseEventsModule } from './modules/leases/rent-due-events.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { RedisModule } from './redis/redis.module.js';
import { StorageModule } from './storage/storage.module.js';

/** Processus worker : traite les files BullMQ, sans serveur HTTP. */
@Module({})
export class WorkerModule {
	static forRoot(config: AppConfig): DynamicModule {
		return {
			module: WorkerModule,
			imports: [
				ConfigModule.forRoot(config),
				LoggerModule.forRoot(loggerParams(config, 'worker')),
				DatabaseModule,
				RedisModule,
				StorageModule,
				AuditModule,
				// Lot 08 bis : la génération des contrats charge le module leases et ses dépendances (identité comprise).
				NotificationsModule,
				LeaseEventsModule,
				ExitHooksModule,
				JobsModule.register('worker'),
				ContractsWorkerModule,
				// Lot 09 : PDF des reçus et crédit du bail imputé sur les échéances émises la nuit.
				PaymentsWorkerModule,
				StatementsWorkerModule
			]
		};
	}
}
