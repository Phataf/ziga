import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { loggerParams } from './common/logger.js';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/env.js';
import { DatabaseModule } from './db/database.module.js';
import { JobsModule } from './jobs/jobs.module.js';
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
				JobsModule.register('worker')
			]
		};
	}
}
