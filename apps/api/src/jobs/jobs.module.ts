import { BullModule } from '@nestjs/bullmq';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { bullConnection } from '../redis/redis.module.js';
import { ExampleProcessor } from './example.processor.js';
import { EXAMPLE_QUEUE } from './queues.js';

/**
 * Files de tâches. Le processus HTTP ne fait qu'ajouter des tâches (`producer`) ;
 * le worker les traite (`worker`). Chacun se multiplie séparément.
 */
@Module({})
export class JobsModule {
	static register(role: 'producer' | 'worker'): DynamicModule {
		return {
			module: JobsModule,
			imports: [
				BullModule.forRootAsync({
					inject: [APP_CONFIG],
					useFactory: (config: AppConfig) => ({
						connection: bullConnection(config.REDIS_URL),
						prefix: 'ziga',
						defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: 5_000 }
					})
				}),
				BullModule.registerQueue({ name: EXAMPLE_QUEUE })
			],
			providers: role === 'worker' ? [ExampleProcessor] : [],
			exports: [BullModule]
		};
	}
}
