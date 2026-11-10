/**
 * Routes des biens et des unités (lot 07) : @OrganizationScoped (membre actif de l'organisation de l'en-tête
 * X-Organization-Id), une permission @Can par route, @Creation() sur les créations (abonnement échu). L'application
 * écrit d'abord sur l'appareil (docs/SYNC.md) ; ces routes servent les mêmes règles en ligne.
 * Aucune route n'écrit l'occupation d'une unité : elle se calcule.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import {
	assignUnitSchema,
	createPropertySchema,
	createUnitSchema,
	recordStatusSchema,
	technicalStatusSchema,
	updatePropertySchema,
	updateUnitSchema
} from '@ziga/shared/properties';
import { Creation } from '../features/feature.guards.js';
import { Can, OrganizationScoped } from '../organizations/organization-context.js';
import { PropertiesService } from './properties.service.js';

@Controller('properties')
@OrganizationScoped()
export class PropertiesController {
	constructor(private readonly properties: PropertiesService) {}

	/** Biens et leurs unités ; l'agent de terrain ne reçoit que ses unités affectées et leur bien. */
	@Get()
	@Can('property.read')
	list() {
		return this.properties.list();
	}

	@Get(':id')
	@Can('property.read')
	get(@Param('id') id: string) {
		return this.properties.get(idSchema.parse(id));
	}

	/** Enregistrer n'est jamais publier : le bien naît en brouillon. */
	@Post()
	@Can('property.manage')
	@Creation()
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.properties.createProperty(createPropertySchema.parse(body));
	}

	@Patch(':id')
	@Can('property.manage')
	update(@Param('id') id: string, @Body() body: unknown) {
		return this.properties.updateProperty(idSchema.parse(id), updatePropertySchema.strict().parse(body));
	}

	@Post(':id/status')
	@Can('property.manage')
	@HttpCode(200)
	status(@Param('id') id: string, @Body() body: unknown) {
		return this.properties.setPropertyStatus(idSchema.parse(id), recordStatusSchema.parse(body).status);
	}
}

@Controller('units')
@OrganizationScoped()
export class UnitsController {
	constructor(private readonly properties: PropertiesService) {}

	@Get(':id')
	@Can('property.read')
	get(@Param('id') id: string) {
		return this.properties.getUnit(idSchema.parse(id));
	}

	/** Quota d'unités de la formule vérifié ici (quotas.check). */
	@Post()
	@Can('property.manage')
	@Creation()
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.properties.createUnit(createUnitSchema.parse(body));
	}

	/** Caractéristiques de l'unité. Un champ inconnu (l'occupation, par exemple) est refusé. */
	@Patch(':id')
	@Can('property.manage')
	update(@Param('id') id: string, @Body() body: unknown) {
		return this.properties.updateUnit(idSchema.parse(id), updateUnitSchema.strict().parse(body));
	}

	/** État technique : ouvert à l'agent de terrain, sur ses unités affectées. */
	@Post(':id/technical-status')
	@Can('unit.status')
	@HttpCode(200)
	technicalStatus(@Param('id') id: string, @Body() body: unknown) {
		return this.properties.setTechnicalStatus(idSchema.parse(id), technicalStatusSchema.parse(body));
	}

	@Post(':id/status')
	@Can('property.manage')
	@HttpCode(200)
	status(@Param('id') id: string, @Body() body: unknown) {
		return this.properties.setUnitStatus(idSchema.parse(id), recordStatusSchema.parse(body).status);
	}

	@Post(':id/assign')
	@Can('unit.assign')
	@HttpCode(200)
	assign(@Param('id') id: string, @Body() body: unknown) {
		return this.properties.assign(idSchema.parse(id), assignUnitSchema.parse(body).agentId);
	}
}
