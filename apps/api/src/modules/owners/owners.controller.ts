/**
 * Routes des propriétaires et des mandats (lot 06) : @OrganizationScoped (membre actif de l'organisation de l'en-tête
 * X-Organization-Id), une permission @Can par route, @Creation() sur les créations (abonnement échu). L'application
 * écrit d'abord sur l'appareil (docs/SYNC.md) ; ces routes servent les mêmes règles en ligne.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import { createMandateSchema, createOwnerSchema, revokeMandateSchema, updateMandateSchema, updateOwnerSchema } from '@ziga/shared/owners';
import { Creation } from '../features/feature.guards.js';
import { Can, OrganizationScoped } from '../organizations/organization-context.js';
import { OwnersService } from './owners.service.js';

@Controller('owners')
@OrganizationScoped()
export class OwnersController {
	constructor(private readonly owners: OwnersService) {}

	@Get()
	@Can('owner.read')
	list() {
		return this.owners.list();
	}

	@Get(':id')
	@Can('owner.read')
	get(@Param('id') id: string) {
		return this.owners.get(idSchema.parse(id));
	}

	/** Aucune invitation n'est envoyée au propriétaire, en aucun cas. */
	@Post()
	@Can('owner.create')
	@Creation()
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.owners.createOwner(createOwnerSchema.parse(body));
	}

	@Patch(':id')
	@Can('owner.update')
	update(@Param('id') id: string, @Body() body: unknown) {
		return this.owners.updateOwner(idSchema.parse(id), updateOwnerSchema.parse(body));
	}

	@Post(':id/archive')
	@Can('owner.update')
	@HttpCode(200)
	archive(@Param('id') id: string) {
		return this.owners.archiveOwner(idSchema.parse(id));
	}
}

@Controller('mandates')
@OrganizationScoped()
export class MandatesController {
	constructor(private readonly owners: OwnersService) {}

	@Post()
	@Can('mandate.create')
	@Creation()
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.owners.createMandate(createMandateSchema.parse(body));
	}

	/** Modification d'un mandat actif : nouvelle version. */
	@Patch(':id')
	@Can('mandate.update')
	update(@Param('id') id: string, @Body() body: unknown) {
		return this.owners.updateMandate(idSchema.parse(id), updateMandateSchema.parse(body));
	}

	@Post(':id/revoke')
	@Can('mandate.revoke')
	@HttpCode(200)
	revoke(@Param('id') id: string, @Body() body: unknown) {
		return this.owners.revokeMandate(idSchema.parse(id), revokeMandateSchema.parse(body).reason);
	}

	@Get(':id/versions')
	@Can('mandate.read')
	versions(@Param('id') id: string) {
		return this.owners.versions(idSchema.parse(id));
	}
}
