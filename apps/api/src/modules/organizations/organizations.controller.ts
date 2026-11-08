/**
 * Routes des organisations (lot 03). Hors création et appartenances, chacune est @OrganizationScoped()
 * (membre actif de l'organisation de l'en-tête X-Organization-Id) et protégée par sa permission @Can().
 */
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { idSchema, isUuid } from '@ziga/shared/ids';
import {
	LOGO_MAX_BYTES,
	changeRoleSchema,
	createOrganizationSchema,
	inviteMemberSchema,
	paymentMethodsSchema,
	updateOrganizationSchema
} from '@ziga/shared/organizations';
import type { Request, Response } from 'express';
import { AppError } from '../../common/app-error.js';
import { STORAGE, type StorageAdapter } from '../../storage/storage.js';
import { Creation } from '../features/feature.guards.js';
import { Auth, Public } from '../identity/auth.guard.js';
import { counterKey } from '../identity/secrets.js';
import { ThrottleService } from '../identity/throttle.service.js';
import type { AccessClaims } from '../identity/token.service.js';
import { logoKey, LOGO_VARIANTS, type LogoVariant } from './logo-files.js';
import { LogosService } from './logos.service.js';
import { Can, OrganizationScoped } from './organization-context.js';
import { OrganizationsService } from './organizations.service.js';

/** Lit le corps brut d'une requête, en s'arrêtant au-delà de `max` octets. */
async function readBody(req: Request, max: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > max) throw new AppError('LOGO_TOO_LARGE', 'Le logo dépasse 2 Mo.', 413);
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

@Controller()
export class MembershipsController {
	constructor(
		private readonly organizations: OrganizationsService,
		private readonly throttle: ThrottleService
	) {}

	/** Organisations dont la personne est membre active (choix de l'espace). */
	@Get('me/organizations')
	mine(@Auth() claims: AccessClaims) {
		return this.organizations.listMine(claims.sub);
	}

	@Post('organizations')
	@HttpCode(201)
	async create(@Auth() claims: AccessClaims, @Body() body: unknown) {
		const r = await this.throttle.hit(counterKey('org-create', claims.sub), 10, 60 * 60_000);
		if (!r.allowed) throw new AppError('TOO_MANY_REQUESTS', 'Trop de créations. Réessayez plus tard.', 429);
		return this.organizations.create(claims.sub, createOrganizationSchema.parse(body));
	}

	/** Invitation vue avant acceptation (lien reçu par WhatsApp) : publique, le secret du lien suffit. */
	@Public()
	@Get('invitations/:token')
	async preview(@Param('token') token: string, @Req() req: Request) {
		const r = await this.throttle.hit(counterKey('invitation-ip', req.ip ?? ''), 60, 60_000);
		if (!r.allowed) throw new AppError('TOO_MANY_REQUESTS', 'Trop de demandes. Réessayez dans un instant.', 429);
		return this.organizations.previewInvitation(token);
	}

	@Post('invitations/:token/accept')
	@HttpCode(200)
	accept(@Auth() claims: AccessClaims, @Param('token') token: string) {
		return this.organizations.acceptInvitation(token, claims.sub);
	}
}

@Controller('organization')
@OrganizationScoped()
export class OrganizationController {
	constructor(
		private readonly organizations: OrganizationsService,
		private readonly logos: LogosService,
		private readonly throttle: ThrottleService
	) {}

	@Get()
	@Can('organization.read')
	view() {
		return this.organizations.view();
	}

	@Patch()
	@Can('organization.update')
	update(@Body() body: unknown) {
		return this.organizations.update(updateOrganizationSchema.parse(body));
	}

	/** Corps brut (image/png, image/jpeg ou image/webp), 2 Mo au plus. */
	@Put('logo')
	@Can('organization.update')
	async logo(@Req() req: Request) {
		return this.logos.upload(req.headers['content-type'], await readBody(req, LOGO_MAX_BYTES));
	}

	/** Moyens de paiement acceptés (D18) : un réglage, pas un interrupteur ; au moins un reste actif. */
	@Put('payment-methods')
	@Can('settings.update')
	paymentMethods(@Body() body: unknown) {
		return this.organizations.setPaymentMethods(paymentMethodsSchema.parse(body).methods);
	}

	@Get('members')
	@Can('member.read')
	members() {
		return this.organizations.members();
	}

	@Patch('members/:id')
	@Can('member.change_role')
	changeRole(@Param('id') id: string, @Body() body: unknown) {
		return this.organizations.changeRole(idSchema.parse(id), changeRoleSchema.parse(body).role);
	}

	@Delete('members/:id')
	@Can('member.remove')
	@HttpCode(204)
	async remove(@Param('id') id: string) {
		await this.organizations.remove(idSchema.parse(id));
	}

	@Get('invitations')
	@Can('member.invite')
	invitations() {
		return this.organizations.invitations();
	}

	@Post('invitations')
	@Can('member.invite')
	@Creation()
	@HttpCode(201)
	async invite(@Auth() claims: AccessClaims, @Body() body: unknown) {
		const input = inviteMemberSchema.parse(body);
		const r = await this.throttle.hit(counterKey('invite', claims.sub), 30, 60 * 60_000);
		if (!r.allowed) throw new AppError('TOO_MANY_REQUESTS', 'Trop d’invitations. Réessayez plus tard.', 429);
		return this.organizations.invite(input.phone, input.role);
	}

	@Delete('invitations/:id')
	@Can('invitation.revoke')
	@HttpCode(204)
	async revokeInvitation(@Param('id') id: string) {
		await this.organizations.revokeInvitation(idSchema.parse(id));
	}

	@Get('audit')
	@Can('audit.read')
	audit(@Query('avant') before?: string) {
		return this.organizations.auditPage(before || undefined);
	}
}

/**
 * Logos publics (liens de reçus, vitrine) : seules les versions traitées sont servies, jamais l'original.
 * Aucune lecture en base : la clé se déduit de l'adresse, et un fichier n'est jamais réécrit (cache permanent).
 */
@Controller('logos')
export class PublicLogosController {
	constructor(@Inject(STORAGE) private readonly storage: StorageAdapter) {}

	@Public()
	@Get(':organizationId/:logoId/:variant')
	async file(
		@Param('organizationId') organizationId: string,
		@Param('logoId') logoId: string,
		@Param('variant') variant: string,
		@Res() res: Response
	) {
		if (!isUuid(organizationId) || !isUuid(logoId) || !(variant in LOGO_VARIANTS))
			throw new AppError('NOT_FOUND', 'Logo introuvable.', 404);
		let body: Buffer;
		try {
			body = await this.storage.get(logoKey(organizationId, logoId, variant as LogoVariant));
		} catch {
			throw new AppError('NOT_FOUND', 'Logo introuvable.', 404);
		}
		res.setHeader('Content-Type', LOGO_VARIANTS[variant as LogoVariant]);
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
		res.send(body);
	}
}
