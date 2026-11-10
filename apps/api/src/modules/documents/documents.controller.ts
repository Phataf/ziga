/**
 * Documents privés (lot 07, D22) : en ligne seulement (l'étape « documents » de l'assistant exige la connexion).
 * Aucune table de documents n'est modifiable depuis l'appareil ; il n'en reçoit que les métadonnées.
 */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { createDocumentSchema, restrictDocumentSchema, withdrawDocumentSchema } from '@ziga/shared/documents';
import { idSchema } from '@ziga/shared/ids';
import { Creation } from '../features/feature.guards.js';
import { Can, OrganizationScoped } from '../organizations/organization-context.js';
import { DocumentsService } from './documents.service.js';

@Controller('documents')
@OrganizationScoped()
export class DocumentsController {
	constructor(private readonly documents: DocumentsService) {}

	@Get()
	@Can('document.read')
	list() {
		return this.documents.list();
	}

	@Get(':id')
	@Can('document.read')
	get(@Param('id') id: string) {
		return this.documents.get(idSchema.parse(id));
	}

	/** Dépôt : fiche en attente et URL d'envoi présignée (10 minutes, type et taille signés). */
	@Post()
	@Can('document.upload')
	@Creation()
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.documents.create(createDocumentSchema.parse(body));
	}

	@Post(':id/upload-url')
	@Can('document.upload')
	@HttpCode(200)
	uploadUrl(@Param('id') id: string) {
		return this.documents.uploadUrl(idSchema.parse(id));
	}

	@Post(':id/uploaded')
	@Can('document.upload')
	@HttpCode(200)
	uploaded(@Param('id') id: string) {
		return this.documents.uploaded(idSchema.parse(id));
	}

	/** URL de lecture signée de 5 minutes, journalisée. */
	@Post(':id/download')
	@Can('document.read')
	@HttpCode(200)
	download(@Param('id') id: string) {
		return this.documents.download(idSchema.parse(id));
	}

	@Post(':id/withdraw')
	@Can('document.withdraw')
	@HttpCode(200)
	withdraw(@Param('id') id: string, @Body() body: unknown) {
		return this.documents.withdraw(idSchema.parse(id), withdrawDocumentSchema.parse(body).reason);
	}

	@Post(':id/restriction')
	@Can('document.restrict')
	@HttpCode(200)
	restrict(@Param('id') id: string, @Body() body: unknown) {
		return this.documents.restrict(idSchema.parse(id), restrictDocumentSchema.parse(body).restriction);
	}
}
