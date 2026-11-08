import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { LocalStorage } from './local-storage.js';
import { S3Storage } from './s3-storage.js';
import { STORAGE, type StorageAdapter } from './storage.js';

export function createStorage(config: AppConfig): StorageAdapter {
	if (config.STORAGE_DRIVER === 'local') return new LocalStorage(config.STORAGE_LOCAL_DIR!);
	return new S3Storage({
		endpoint: config.S3_ENDPOINT!,
		region: config.S3_REGION!,
		bucket: config.S3_BUCKET!,
		accessKeyId: config.S3_ACCESS_KEY_ID!,
		secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
		forcePathStyle: config.S3_FORCE_PATH_STYLE,
		timeoutMs: config.HEALTH_CHECK_TIMEOUT_MS
	});
}

@Global()
@Module({ providers: [{ provide: STORAGE, inject: [APP_CONFIG], useFactory: createStorage }], exports: [STORAGE] })
export class StorageModule {}
