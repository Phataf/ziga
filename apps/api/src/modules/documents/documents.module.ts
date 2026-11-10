import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { OwnersModule } from '../owners/owners.module.js';
import { PropertiesModule } from '../properties/properties.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

/** Module documents (lot 07, D22) : registre des documents privés, matrice de confidentialité par type. */
@Module({
	imports: [OrganizationsModule, OwnersModule, PropertiesModule],
	controllers: [DocumentsController],
	providers: [DocumentsService],
	exports: [DocumentsService]
})
export class DocumentsModule {}
