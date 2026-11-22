/**
 * Routes de la liaison des fiches aux comptes (lot 10 ter, étape 2).
 * - Organisation : @OrganizationScoped() et @Can('person_link.manage') (direction et gestion) ; interrupteur de l'espace
 *   vérifié par le service à l'invitation.
 * - Invitation reçue : aperçu public (le jeton suffit, débit limité par adresse), puis réclamée par une personne connectée.
 * - Personne : ses liens, les agences vérifiées, sa demande, son code, sa révocation ; jamais l'organisation active.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import {
	invitePersonLinkSchema,
	PERSON_LINK_RECORD_TYPES,
	personLinkActionSchema,
	personRevokeLinkSchema,
	requestPersonLinkSchema,
	revokePersonLinkSchema,
	verifyPersonLinkSchema
} from '@ziga/shared/person-links';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import { Auth, Public } from '../identity/auth.guard.js';
import { counterKey } from '../identity/secrets.js';
import { ThrottleService } from '../identity/throttle.service.js';
import type { AccessClaims } from '../identity/token.service.js';
import { Can, OrganizationScoped } from './organization-context.js';
import { OrganizationsService } from './organizations.service.js';
import { PersonLinksService } from './person-links.service.js';

const recordQuerySchema = z.object({ recordType: z.enum(PERSON_LINK_RECORD_TYPES), recordId: idSchema });

@Controller('person-links')
@OrganizationScoped()
export class PersonLinksController {
	constructor(private readonly links: PersonLinksService) {}

	/** Liens d'une fiche (section « Compte lié »). */
	@Get()
	@Can('person_link.manage')
	list(@Query() query: unknown) {
		const q = recordQuerySchema.parse(query);
		return this.links.listForRecord(q.recordType, q.recordId);
	}

	/** (a) Invitation depuis la fiche : renvoie le lien à envoyer par WhatsApp (ou l'envoie par SMS). */
	@Post()
	@HttpCode(201)
	@Can('person_link.manage')
	invite(@Body() body: unknown) {
		return this.links.invite(invitePersonLinkSchema.parse(body));
	}

	/** (b) Acceptation d'une demande de la personne. */
	@Post(':id/accept')
	@HttpCode(200)
	@Can('person_link.manage')
	accept(@Param('id') id: string) {
		return this.links.accept(idSchema.parse(id));
	}

	@Post(':id/revoke')
	@HttpCode(200)
	@Can('person_link.manage')
	revoke(@Param('id') id: string, @Body() body: unknown) {
		return this.links.revokeByOrganization(idSchema.parse(id), revokePersonLinkSchema.parse(body).reason);
	}
}

@Controller()
export class PersonLinkInvitationsController {
	constructor(
		private readonly links: PersonLinksService,
		private readonly throttle: ThrottleService
	) {}

	/** Invitation vue avant de se connecter (lien reçu par WhatsApp ou SMS) : publique, le secret du lien suffit. */
	@Public()
	@Get('person-link-invitations/:token')
	async preview(@Param('token') token: string, @Req() req: Request) {
		const r = await this.throttle.hit(counterKey('person-link-invitation-ip', req.ip ?? ''), 60, 60_000);
		if (!r.allowed) throw new AppError('TOO_MANY_REQUESTS', 'Trop de demandes. Réessayez dans un instant.', 429);
		return this.links.previewInvitation(token);
	}

	/** La personne connectée réclame l'invitation (son compte au numéro de la fiche) ; le code part à ce numéro. */
	@Post('person-link-invitations/:token/claim')
	@HttpCode(200)
	claim(@Auth() claims: AccessClaims, @Param('token') token: string) {
		return this.links.claimInvitation(claims.sub, token);
	}
}

@Controller('me/person-links')
export class MyPersonLinksController {
	constructor(
		private readonly links: PersonLinksService,
		private readonly organizations: OrganizationsService
	) {}

	/** Ses liens en cours et actifs ; la propre fiche d'un bailleur particulier se lie d'abord (réponse 2). */
	@Get()
	async mine(@Auth() claims: AccessClaims) {
		const memberships = await this.organizations.listMine(claims.sub);
		const landlordDirectorOf = memberships.filter((m) => m.type === 'landlord' && m.role === 'director').map((m) => m.organizationId);
		return this.links.mine(claims.sub, landlordDirectorOf);
	}

	/** Réponse 1 : agences vérifiées auxquelles demander une liaison (noms seulement). */
	@Get('organizations')
	organizationsForRequest(@Auth() claims: AccessClaims) {
		return this.links.requestOrganizations(claims.sub);
	}

	/** (b) Demande de liaison : même réponse que la fiche existe ou non. */
	@Post('requests')
	@HttpCode(202)
	async request(@Auth() claims: AccessClaims, @Body() body: unknown) {
		await this.links.request(claims.sub, requestPersonLinkSchema.parse(body));
		return { message: 'Si une fiche de cette agence porte votre numéro, un code vient de vous être envoyé par SMS.' };
	}

	@Post(':id/code')
	@HttpCode(202)
	async resend(@Auth() claims: AccessClaims, @Param('id') id: string, @Body() body: unknown) {
		await this.links.resendCode(claims.sub, idSchema.parse(id), personLinkActionSchema.parse(body).organizationId);
		return { message: 'Un nouveau code vient de vous être envoyé par SMS.' };
	}

	@Post(':id/verify')
	@HttpCode(200)
	verify(@Auth() claims: AccessClaims, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
		return this.links.verify(claims.sub, idSchema.parse(id), verifyPersonLinkSchema.parse(body), req.ip ?? '');
	}

	@Post(':id/revoke')
	@HttpCode(204)
	async revoke(@Auth() claims: AccessClaims, @Param('id') id: string, @Body() body: unknown) {
		await this.links.revokeByPerson(claims.sub, idSchema.parse(id), personRevokeLinkSchema.parse(body));
	}
}
