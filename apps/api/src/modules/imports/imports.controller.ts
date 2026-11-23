/**
 * Routes de l'import Excel (lot 11) : direction et gestion (`import.run`), fonctionnalité `imports.excel`, dans le
 * contexte de l'organisation. Aucune route ne lit le fichier envoyé : l'analyse, l'exécution et l'annulation sont des
 * tâches de fond, dont l'état se lit par `GET /imports/:id`.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Res, StreamableFile } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import { analyzeImportSchema, cancelImportSchema, createImportSchema, IMPORT_MIME_TYPES } from '@ziga/shared/imports';
import type { Response } from 'express';
import { attachment } from '../../storage/storage.js';
import { Creation, RequiresFeature } from '../features/feature.guards.js';
import { Can, OrganizationScoped } from '../organizations/organization-context.js';
import { ImportsService } from './imports.service.js';

// Ordre des gardes : les décorateurs s'appliquent de bas en haut ; le contexte d'organisation (formule, rôle) est posé
// avant la vérification de la fonctionnalité, qui en a besoin.
@Controller('imports')
@RequiresFeature('imports.excel')
@OrganizationScoped()
export class ImportsController {
	constructor(private readonly imports: ImportsService) {}

	/** Modèle Excel à remplir, aux onglets du type d'organisation. */
	@Get('template')
	@Can('import.run')
	async template(@Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
		const file = await this.imports.template();
		res.setHeader('content-type', IMPORT_MIME_TYPES.xlsx);
		res.setHeader('content-disposition', attachment('modele-import-ziga.xlsx'));
		return new StreamableFile(file);
	}

	@Get()
	@Can('import.run')
	list() {
		return this.imports.list();
	}

	/** Import enregistré, URL signée pour envoyer le fichier directement au stockage. */
	@Post()
	@HttpCode(201)
	@Can('import.run')
	@Creation()
	create(@Body() body: unknown) {
		return this.imports.create(createImportSchema.parse(body));
	}

	@Get(':id')
	@Can('import.run')
	get(@Param('id') id: string) {
		return this.imports.get(idSchema.parse(id));
	}

	/** Analyse (ou nouvelle analyse avec les choix de la prévisualisation), en tâche de fond. */
	@Post(':id/analyze')
	@HttpCode(202)
	@Can('import.run')
	analyze(@Param('id') id: string, @Body() body: unknown) {
		return this.imports.requestAnalysis(idSchema.parse(id), analyzeImportSchema.parse(body ?? {}));
	}

	/** Exécution, en tâche de fond : refusée tant que la prévisualisation a un blocage, ou au-delà du quota d'unités. */
	@Post(':id/execute')
	@HttpCode(202)
	@Can('import.run')
	@Creation()
	execute(@Param('id') id: string) {
		return this.imports.requestExecution(idSchema.parse(id));
	}

	@Get(':id/report')
	@Can('import.run')
	report(@Param('id') id: string) {
		return this.imports.reportUrl(idSchema.parse(id));
	}

	/** Annulation dans les 24 heures, sans encaissement depuis, en tâche de fond. */
	@Post(':id/cancel')
	@HttpCode(202)
	@Can('import.run')
	cancel(@Param('id') id: string, @Body() body: unknown) {
		return this.imports.requestCancellation(idSchema.parse(id), cancelImportSchema.parse(body).reason);
	}
}
