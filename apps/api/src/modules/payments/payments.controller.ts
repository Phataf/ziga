/**
 * Routes des encaissements et des reçus (lot 09). Toutes sous l'interrupteur `payments.registry` (CLAUDE.md §8) et
 * une permission par route (@Can). Pas de @Creation : un abonnement échu laisse les reçus possibles (prompt du lot 04).
 * L'application écrit d'abord sur l'appareil (docs/SYNC.md) ; ces routes servent les mêmes règles en ligne, avec le
 * même service. Validation, rapprochement et annulation : en ligne seulement (réponse du porteur, point 7).
 *
 * Pages publiques (`/public/receipts/…`), sans compte : jeton exact seulement, limite de débit par adresse IP,
 * `X-Robots-Tag: noindex` et `Cache-Control: no-store` (aucun cache Cloudflare), réponse du porteur au point 5.
 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import {
	cancelPaymentSchema,
	PAYMENT_STATUSES,
	paymentEntriesSchema,
	receiptTokenSchema,
	validatePaymentsSchema
} from '@ziga/shared/payments';
import { RECEIPT_FORMATS, receiptSettingsSchema } from '@ziga/shared/receipts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import { RequiresFeature } from '../features/feature.guards.js';
import { Public } from '../identity/auth.guard.js';
import { ThrottleService } from '../identity/throttle.service.js';
import { Can, OrganizationScoped } from '../organizations/organization-context.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { PaymentsService } from './payments.service.js';

const listQuerySchema = z.object({
	status: z.enum(PAYMENT_STATUSES).optional(),
	leaseId: idSchema.optional(),
	cursor: idSchema.optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50)
});
const formatSchema = z.object({ format: z.enum(RECEIPT_FORMATS).default('a6') });

// L'interrupteur après le contexte d'organisation : les décorateurs s'appliquent de bas en haut, la garde de
// l'organisation doit passer d'abord pour que le réglage de l'organisation soit lu.
@RequiresFeature('payments.registry')
@Controller('payments')
@OrganizationScoped()
export class PaymentsController {
	constructor(private readonly payments: PaymentsService) {}

	@Get()
	@Can('payment.read')
	list(@Query() query: unknown) {
		const q = listQuerySchema.parse(query);
		return this.payments.list({ status: q.status, leaseId: q.leaseId, cursor: q.cursor ?? null, limit: q.limit });
	}

	@Get(':id')
	@Can('payment.read')
	get(@Param('id') id: string) {
		return this.payments.get(idSchema.parse(id));
	}

	/**
	 * Une saisie, ou deux (« Caution et avance ») dans une même transaction. La permission dépend du moyen : l'agent de
	 * terrain n'encaisse que des espèces (vérifié par le service, par la même règle que l'écran).
	 */
	@Post()
	@Can('payment.record_cash')
	@HttpCode(201)
	record(@Body() body: unknown) {
		return this.payments.record(paymentEntriesSchema.parse(body).payments);
	}

	@Post('validate')
	@Can('payment.validate')
	@HttpCode(200)
	validate(@Body() body: unknown) {
		return this.payments.validate(validatePaymentsSchema.parse(body).paymentIds);
	}

	@Post(':id/cancel')
	@Can('payment.cancel')
	@HttpCode(200)
	cancel(@Param('id') id: string, @Body() body: unknown) {
		return this.payments.cancel(idSchema.parse(id), cancelPaymentSchema.parse(body).reason);
	}
}

// L'interrupteur après le contexte d'organisation : les décorateurs s'appliquent de bas en haut, la garde de
// l'organisation doit passer d'abord pour que le réglage de l'organisation soit lu.
@RequiresFeature('payments.registry')
@Controller('receipts')
@OrganizationScoped()
export class ReceiptsController {
	constructor(private readonly payments: PaymentsService) {}

	@Get(':id/pdf')
	@Can('payment.read')
	pdf(@Param('id') id: string, @Query() query: unknown) {
		return this.payments.receiptPdfUrl(idSchema.parse(id), formatSchema.parse(query).format);
	}

	/** Nouveaux jetons (vérification et partage) d'un reçu saisi sur un autre appareil : quiconque lit le reçu. */
	@Post(':id/tokens')
	@Can('payment.read')
	@HttpCode(201)
	tokens(@Param('id') id: string) {
		return this.payments.newReceiptTokens(idSchema.parse(id));
	}

	@Post(':id/share-token')
	@Can('receipt.share')
	@HttpCode(201)
	share(@Param('id') id: string) {
		return this.payments.newShareToken(idSchema.parse(id));
	}

	@Post(':id/share-token/revoke')
	@Can('receipt.share')
	@HttpCode(200)
	revoke(@Param('id') id: string) {
		return this.payments.revokeShareTokens(idSchema.parse(id));
	}
}

/** Réglages des reçus : lecture par la direction et la gestion, modification par le directeur (journalisée). */
// L'interrupteur après le contexte d'organisation : les décorateurs s'appliquent de bas en haut, la garde de
// l'organisation doit passer d'abord pour que le réglage de l'organisation soit lu.
@RequiresFeature('payments.registry')
@Controller('organization/receipt-settings')
@OrganizationScoped()
export class ReceiptSettingsController {
	constructor(private readonly payments: PaymentsService) {}

	@Get()
	@Can('payment.read')
	get() {
		return this.payments.settings();
	}

	@Put()
	@Can('receipt.settings')
	update(@Body() body: unknown) {
		return this.payments.updateSettings(receiptSettingsSchema.parse(body));
	}
}

@Public()
@Controller('public/receipts')
export class PublicReceiptsController {
	constructor(
		private readonly payments: PaymentsService,
		private readonly throttle: ThrottleService,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {}

	/** En-têtes des pages publiques et limite de débit par adresse IP ; jeton mal formé : introuvable, sans requête. */
	private async guard(req: Request, res: Response, token: string): Promise<string> {
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('X-Robots-Tag', 'noindex, nofollow');
		res.setHeader('Referrer-Policy', 'no-referrer');
		const r = await this.throttle.hit(`receipt-public:${req.ip ?? 'unknown'}`, this.config.RECEIPT_PUBLIC_RATE_PER_MINUTE, 60_000);
		if (!r.allowed) {
			res.setHeader('Retry-After', String(r.retryAfterSeconds));
			throw new AppError('RATE_LIMITED', 'Trop de demandes : réessayez dans un instant.', 429, { retryAfterSeconds: r.retryAfterSeconds });
		}
		const parsed = receiptTokenSchema.safeParse(token);
		if (!parsed.success) throw new AppError('RECEIPT_NOT_FOUND', 'Reçu introuvable.', 404);
		return parsed.data;
	}

	/** Page de vérification (QR code) : organisation, numéro, date, montant, statut ; rien d'autre. */
	@Get('verify/:token')
	async verify(@Param('token') token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
		const view = await this.payments.verify(await this.guard(req, res, token));
		if (!view) throw new AppError('RECEIPT_NOT_FOUND', 'Reçu introuvable, ou en cours d’enregistrement.', 404);
		return view;
	}

	/** Lien partagé : le reçu en lecture seule ; « en cours d'enregistrement » tant qu'il n'est pas synchronisé. */
	@Get('shared/:token')
	async shared(@Param('token') token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
		return this.payments.shared(await this.guard(req, res, token));
	}

	/** PDF du lien partagé : URL signée de 5 minutes. */
	@Get('shared/:token/pdf')
	async sharedPdf(@Param('token') token: string, @Query() query: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
		const url = await this.payments.sharedPdfUrl(await this.guard(req, res, token), formatSchema.parse(query).format);
		if (!url) throw new AppError('RECEIPT_PDF_PENDING', 'Le PDF de ce reçu n’est pas encore prêt.', 404);
		return { url, expiresInSeconds: 300 };
	}
}
