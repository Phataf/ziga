import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { SyncController } from './sync.controller.js';

/** Synchronisation hors ligne (lot 05) : jeton de PowerSync ; l'envoi des modifications arrive à l'étape 3. */
@Module({
	imports: [IdentityModule],
	controllers: [SyncController]
})
export class SyncModule {}
