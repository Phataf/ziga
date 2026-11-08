/** Routes d'authentification : publiques (exceptions explicites au garde global), validées par Zod. */
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
	AUTH_MESSAGES,
	forgotPasswordSchema,
	loginSchema,
	registerSchema,
	resetPasswordSchema,
	verifyPhoneSchema
} from '@ziga/shared/auth';
import type { Request, Response } from 'express';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { Public } from './auth.guard.js';
import { AuthService, type ClientInfo, type IssuedSession } from './auth.service.js';
import { clearRefreshCookie, readCookie, refreshCookie } from './cookies.js';
import { assertTrustedOrigin } from './origin.js';
import { TokenService } from './token.service.js';

function client(request: Request): ClientInfo {
	return { ip: request.ip ?? 'inconnue', userAgent: request.headers['user-agent'] };
}

@Controller()
@Public()
export class AuthController {
	constructor(
		private readonly auth: AuthService,
		private readonly tokens: TokenService,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {}

	private send(res: Response, issued: IssuedSession) {
		res.setHeader(
			'Set-Cookie',
			refreshCookie(this.config.AUTH_REFRESH_COOKIE, issued.refreshToken, this.config.AUTH_REFRESH_TTL_DAYS * 86_400)
		);
		res.setHeader('Cache-Control', 'no-store');
		return issued.body;
	}

	@Post('auth/register')
	@HttpCode(202)
	async register(@Body() body: unknown, @Req() req: Request) {
		await this.auth.register(registerSchema.parse(body), client(req));
		return { message: AUTH_MESSAGES.codeSent };
	}

	@Post('auth/verify-phone')
	@HttpCode(200)
	async verifyPhone(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
		return this.send(res, await this.auth.verifyPhone(verifyPhoneSchema.parse(body), client(req)));
	}

	@Post('auth/login')
	@HttpCode(200)
	async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
		return this.send(res, await this.auth.login(loginSchema.parse(body), client(req)));
	}

	@Post('auth/refresh')
	@HttpCode(200)
	async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
		assertTrustedOrigin(req, this.config.CORS_ORIGINS);
		try {
			return this.send(res, await this.auth.refresh(readCookie(req.headers.cookie, this.config.AUTH_REFRESH_COOKIE)));
		} catch (error) {
			// Session refusée : le cookie est effacé. Un conflit (409) le garde : la rotation voisine l'a déjà remplacé.
			if ((error as { status?: number }).status === 401) res.setHeader('Set-Cookie', clearRefreshCookie(this.config.AUTH_REFRESH_COOKIE));
			throw error;
		}
	}

	@Post('auth/logout')
	@HttpCode(204)
	async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
		assertTrustedOrigin(req, this.config.CORS_ORIGINS);
		await this.auth.logout(readCookie(req.headers.cookie, this.config.AUTH_REFRESH_COOKIE));
		res.setHeader('Set-Cookie', clearRefreshCookie(this.config.AUTH_REFRESH_COOKIE));
	}

	@Post('auth/password/forgot')
	@HttpCode(202)
	async forgot(@Body() body: unknown, @Req() req: Request) {
		await this.auth.forgotPassword(forgotPasswordSchema.parse(body), client(req));
		return { message: AUTH_MESSAGES.codeSent };
	}

	@Post('auth/password/reset')
	@HttpCode(200)
	async reset(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
		return this.send(res, await this.auth.resetPassword(resetPasswordSchema.parse(body), client(req)));
	}

	/** Clés publiques des jetons d'accès (JWKS), avec leur identifiant : PowerSync (lot 05) les lira ici. */
	@Get('.well-known/jwks.json')
	async jwks(@Res({ passthrough: true }) res: Response) {
		res.setHeader('Cache-Control', 'public, max-age=300');
		return this.tokens.ring.jwks();
	}
}
