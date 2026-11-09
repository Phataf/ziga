import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { SyncController } from './sync.controller.js';
import { SyncRegistry } from './sync-registry.js';
import { SyncService } from './sync.service.js';

/**
 * Synchronisation hors ligne (lot 05) : jeton de PowerSync, envoi des modifications. Les modules déclarent leurs
 * tables modifiables au registre (SyncRegistry), qu'ils importent d'ici.
 */
@Module({
	imports: [IdentityModule],
	controllers: [SyncController],
	providers: [SyncRegistry, SyncService],
	exports: [SyncRegistry]
})
export class SyncModule {}
