import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { loggerParams } from './common/logger.js';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/env.js';
import { DatabaseModule } from './db/database.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { RedisModule } from './redis/redis.module.js';
import { StorageModule } from './storage/storage.module.js';

/** Processus HTTP. Sans état : aucune session ni donnée métier en mémoire, tout est en base ou dans Redis. */
@Module({})
export class AppModule {
	static forRoot(config: AppConfig): DynamicModule {
		return {
			module: AppModule,
			imports: [
				ConfigModule.forRoot(config),
				LoggerModule.forRoot(loggerParams(config, 'api')),
				DatabaseModule,
				RedisModule,
				StorageModule,
				JobsModule.register('producer'),
				HealthModule
			],
			providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }]
		};
	}
}
