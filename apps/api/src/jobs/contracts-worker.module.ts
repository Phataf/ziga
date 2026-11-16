import { Module } from '@nestjs/common';
import { LeasesModule } from '../modules/leases/leases.module.js';
import { ContractsProcessor } from './contracts.processor.js';

/**
 * Worker seulement (lot 08 bis) : la génération des contrats utilise le service du module leases, et, par lui, les
 * services publics des modules dont il copie les données (organisations, propriétaires, biens, documents).
 */
@Module({ imports: [LeasesModule], providers: [ContractsProcessor] })
export class ContractsWorkerModule {}
