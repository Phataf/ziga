import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** Module audit : service partagé par tous les modules (écriture dans la transaction de l'action). */
@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
