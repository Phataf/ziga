import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { ConsoleSmsSender, FileSmsSender, MemorySmsSender, SMS_SENDER, type SmsSender } from './sms-sender.js';

export function createSmsSender(config: AppConfig): SmsSender {
	switch (config.SMS_DRIVER) {
		case 'file':
			return new FileSmsSender(config.SMS_FILE!);
		case 'memory':
			return new MemorySmsSender();
		default:
			return new ConsoleSmsSender();
	}
}

@Global()
@Module({ providers: [{ provide: SMS_SENDER, inject: [APP_CONFIG], useFactory: createSmsSender }], exports: [SMS_SENDER] })
export class NotificationsModule {}
