/**
 * Routes des locataires, des baux et des comptes de caution (lot 08) : @OrganizationScoped (membre actif de
 * l'organisation de l'en-tête X-Organization-Id), une permission @Can par route, @Creation() sur les créations
 * (abonnement échu). L'application écrit d'abord sur l'appareil (docs/SYNC.md) ; ces routes servent les mêmes règles
 * en ligne, avec le même service.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import {
	cancelLeaseSchema,
	createDepositAccountSchema,
	createLeaseSchema,
	createTenantWithIdentitySchema,
	depositHolderChangeSchema,
	depositReceiptSchema,
	pageQuerySchema,
	rentChangeSchema,
	updateDepositAccountSchema,
	updateLeaseDraftSchema,
	updateTenantIdentitySchema,
	updateTenantSchema
} from '@ziga/shared/leases';
import { z } from 'zod';
import { Creation } from '../features/feature.guards.js';
import { Can, OrganizationScoped } from '../organizations/organization-context.js';
import { LeasesService } from './leases.service.js';

const optionalId = idSchema.optional();

@Controller('tenants')
@OrganizationScoped()
export class TenantsController {
	constructor(private readonly leases: LeasesService) {}

	@Get()
	@Can('tenant.read')
	list(@Query() query: unknown) {
		const { cursor, limit } = pageQuerySchema.parse(query);
		return this.leases.listTenants(cursor, limit);
	}

	@Get(':id')
	@Can('tenant.read')
	get(@Param('id') id: string) {
		return this.leases.getTenant(idSchema.parse(id));
	}

	/** Création en ligne, avec l'état civil facultatif. Aucun champ n'est obligatoire hormis le nom (D24). */
	@Post()
	@Can('tenant.create')
	@Creation()
	@HttpCode(201)
	create(@Body() body: unknown) {
		const { identity, ...tenant } = createTenantWithIdentitySchema.parse(body);
		return this.leases.createTenant(tenant, identity);
	}

	@Patch(':id')
	@Can('tenant.update')
	update(@Param('id') id: string, @Body() body: unknown) {
		return this.leases.updateTenant(idSchema.parse(id), updateTenantSchema.parse(body));
	}

	/** État civil et pièce d'identité : directeur et gestionnaire seulement. */
	@Get(':id/identity')
	@Can('tenant.read_identity')
	identity(@Param('id') id: string) {
		return this.leases.identityOf(idSchema.parse(id));
	}

	@Put(':id/identity')
	@Can('tenant.read_identity')
	updateIdentity(@Param('id') id: string, @Body() body: unknown) {
		return this.leases.updateTenantIdentity(idSchema.parse(id), updateTenantIdentitySchema.parse(body));
	}

	@Post(':id/archive')
	@Can('tenant.update')
	@HttpCode(200)
	archive(@Param('id') id: string) {
		return this.leases.archiveTenant(idSchema.parse(id));
	}
}

@Controller('leases')
@OrganizationScoped()
export class LeasesController {
	constructor(private readonly leases: LeasesService) {}

	@Get()
	@Can('lease.read')
	list(@Query() query: Record<string, unknown>) {
		const filter = z.object({ unitId: optionalId, tenantId: optionalId }).parse(query);
		return this.leases.listLeases(filter);
	}

	@Get(':id')
	@Can('lease.read')
	get(@Param('id') id: string) {
		return this.leases.getLease(idSchema.parse(id));
	}

	@Get(':id/rent-dues')
	@Can('lease.read')
	rentDues(@Param('id') id: string) {
		return this.leases.rentDuesOf(idSchema.parse(id));
	}

	/** Détenteur de caution proposé : l'organisation si le mandat l'autorise à encaisser, le propriétaire sinon. */
	@Get(':id/proposed-holder')
	@Can('lease.read')
	async proposedHolder(@Param('id') id: string) {
		return { holder: await this.leases.proposedHolder(idSchema.parse(id)) };
	}

	/** Brouillon, ou bail validé tout de suite (`validate`), avec ses échéances générées par le serveur. */
	@Post()
	@Can('lease.create')
	@Creation()
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.leases.createLease(createLeaseSchema.parse(body));
	}

	/** Modification d'un brouillon ; un bail validé ne change que par un changement de loyer. */
	@Patch(':id')
	@Can('lease.update')
	update(@Param('id') id: string, @Body() body: unknown) {
		return this.leases.updateDraft(idSchema.parse(id), updateLeaseDraftSchema.parse(body));
	}

	@Post(':id/validate')
	@Can('lease.update')
	@HttpCode(200)
	validate(@Param('id') id: string) {
		return this.leases.validateLease(idSchema.parse(id));
	}

	@Post(':id/cancel')
	@Can('lease.update')
	@HttpCode(200)
	cancel(@Param('id') id: string, @Body() body: unknown) {
		return this.leases.cancelLease(idSchema.parse(id), cancelLeaseSchema.parse(body).reason);
	}

	/** Nouvelle version du bail, à une date d'effet ; `expectedVersion` évite d'écraser un changement fait ailleurs. */
	@Post(':id/rent-changes')
	@Can('lease.update')
	@HttpCode(200)
	changeRent(@Param('id') id: string, @Body() body: unknown) {
		return this.leases.changeRent(idSchema.parse(id), rentChangeSchema.parse(body));
	}
}

@Controller('deposit-accounts')
@OrganizationScoped()
export class DepositAccountsController {
	constructor(private readonly leases: LeasesService) {}

	/** Compte de caution ou de garantie des factures : détenteur obligatoire ; au-delà de deux mois, un avertissement. */
	@Post()
	@Can('lease.create')
	@Creation()
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.leases.createDepositAccount(createDepositAccountSchema.parse(body));
	}

	@Patch(':id')
	@Can('lease.update')
	update(@Param('id') id: string, @Body() body: unknown) {
		return this.leases.updateDepositAgreed(idSchema.parse(id), updateDepositAccountSchema.parse(body));
	}

	/** Versement reçu, éventuellement en plusieurs fois. */
	@Post(':id/receipts')
	@Can('deposit.receive')
	@HttpCode(201)
	receive(@Param('id') id: string, @Body() body: unknown) {
		return this.leases.receiveDeposit(depositReceiptSchema.parse({ ...(body as object), accountId: idSchema.parse(id) }));
	}

	/** Changement de détenteur : un mouvement motivé, jamais une modification du compte. */
	@Post(':id/holder-changes')
	@Can('lease.update')
	@HttpCode(201)
	changeHolder(@Param('id') id: string, @Body() body: unknown) {
		return this.leases.changeDepositHolder(depositHolderChangeSchema.parse({ ...(body as object), accountId: idSchema.parse(id) }));
	}
}
