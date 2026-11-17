/**
 * Routes du module collections (lot 10). Une permission par route (@Can), vérifiée par le serveur ; interrupteurs :
 * `collections.owner_statements` pour les relevés et les reversements (avec le quota Découverte à l'émission),
 * `collections.reminders_whatsapp_link` pour une relance par WhatsApp (vérifié par le service, canal par canal).
 * L'application écrit d'abord sur l'appareil (relances et dépenses, docs/SYNC.md) ; ces routes servent les mêmes règles
 * en ligne, avec le même service.
 *
 * Page publique `/public/statements/shared/:token`, sans compte : jeton exact seulement (empreinte), limite de débit par
 * adresse IP, `X-Robots-Tag: noindex`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` ; lien expiré, révoqué
 * ou inconnu : introuvable.
 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ARREARS_BUCKETS } from '@ziga/shared/collections';
import { cancelExpenseSchema, expenseSchema } from '@ziga/shared/expenses';
import { idSchema } from '@ziga/shared/ids';
import { createReminderSchema, reminderSettingsSchema } from '@ziga/shared/reminders';
import {
	cancelPayoutSchema,
	generateStatementSchema,
	issueStatementSchema,
	payoutSchema,
	statementMonthSchema,
	statementTokenSchema
} from '@ziga/shared/statements';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { RequiresFeature } from '../features/feature.guards.js';
import { Public } from '../identity/auth.guard.js';
import { ThrottleService } from '../identity/throttle.service.js';
import { Can, OrganizationScoped } from '../organizations/organization-context.js';
import { ExpensesService } from './expenses.service.js';
import { RemindersService } from './reminders.service.js';
import { StatementsService } from './statements.service.js';

const page = { cursor: idSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) };

const arrearsQuerySchema = z.object({
	neighborhoodId: idSchema.optional(),
	ownerId: idSchema.optional(),
	agentId: idSchema.optional(),
	bucket: z.enum(ARREARS_BUCKETS).optional(),
	...page
});

@Controller('collections/arrears')
@OrganizationScoped()
export class ArrearsController {
	constructor(private readonly reminders: RemindersService) {}

	@Get()
	@Can('reminder.read')
	list(@Query() query: unknown) {
		const q = arrearsQuerySchema.parse(query);
		return this.reminders.arrears({ ...q, cursor: q.cursor ?? null });
	}
}

@Controller('reminders')
@OrganizationScoped()
export class RemindersController {
	constructor(private readonly reminders: RemindersService) {}

	@Get()
	@Can('reminder.read')
	list(@Query() query: unknown) {
		const q = z.object({ tenantId: idSchema.optional(), limit: page.limit }).parse(query);
		return this.reminders.list(q);
	}

	/** La permission la plus large (visite, appel) ; le canal précis est vérifié par le service. */
	@Post()
	@Can('reminder.record_visit')
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.reminders.create(createReminderSchema.parse(body));
	}
}

@Controller('organization/reminder-settings')
@OrganizationScoped()
export class ReminderSettingsController {
	constructor(private readonly reminders: RemindersService) {}

	@Get()
	@Can('reminder.read')
	get() {
		return this.reminders.settings();
	}

	@Put()
	@Can('reminder.templates')
	update(@Body() body: unknown) {
		return this.reminders.updateSettings(reminderSettingsSchema.parse(body));
	}
}

@Controller('expenses')
@OrganizationScoped()
export class ExpensesController {
	constructor(private readonly expenses: ExpensesService) {}

	@Get()
	@Can('expense.read')
	list(@Query() query: unknown) {
		const q = z.object({ propertyId: idSchema.optional(), ...page }).parse(query);
		return this.expenses.list({ propertyId: q.propertyId, cursor: q.cursor ?? null, limit: q.limit });
	}

	@Get(':id')
	@Can('expense.read')
	get(@Param('id') id: string) {
		return this.expenses.get(idSchema.parse(id));
	}

	@Post()
	@Can('expense.record')
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.expenses.create(expenseSchema.parse(body));
	}

	@Post(':id/cancel')
	@Can('expense.cancel')
	@HttpCode(200)
	cancel(@Param('id') id: string, @Body() body: unknown) {
		return this.expenses.cancel(idSchema.parse(id), cancelExpenseSchema.parse(body).reason);
	}
}

// L'interrupteur après le contexte d'organisation : les décorateurs s'appliquent de bas en haut, la garde de
// l'organisation doit passer d'abord pour que le réglage de l'organisation soit lu.
@RequiresFeature('collections.owner_statements')
@Controller('owner-statements')
@OrganizationScoped()
export class StatementsController {
	constructor(private readonly statements: StatementsService) {}

	@Get()
	@Can('statement.read')
	list(@Query() query: unknown) {
		const q = z.object({ ownerId: idSchema.optional(), month: statementMonthSchema.optional(), ...page }).parse(query);
		return this.statements.list({ ownerId: q.ownerId, month: q.month, cursor: q.cursor ?? null, limit: q.limit });
	}

	@Get(':id')
	@Can('statement.read')
	get(@Param('id') id: string) {
		return this.statements.get(idSchema.parse(id));
	}

	/** Brouillon du mois, recalculé à la demande. */
	@Post('generate')
	@Can('statement.issue')
	@HttpCode(200)
	generate(@Body() body: unknown) {
		const b = generateStatementSchema.parse(body);
		return this.statements.generate(b.ownerId, b.month);
	}

	@Post(':id/issue')
	@Can('statement.issue')
	@HttpCode(200)
	issue(@Param('id') id: string, @Body() body: unknown) {
		return this.statements.issue(idSchema.parse(id), issueStatementSchema.parse(body).revision);
	}

	@Post(':id/rectify')
	@Can('statement.issue')
	@HttpCode(201)
	rectify(@Param('id') id: string) {
		return this.statements.rectify(idSchema.parse(id));
	}

	@Get(':id/pdf')
	@Can('statement.read')
	pdf(@Param('id') id: string) {
		return this.statements.pdfUrl(idSchema.parse(id));
	}

	@Get(':id/payouts')
	@Can('statement.read')
	payouts(@Param('id') id: string) {
		return this.statements.payouts(idSchema.parse(id));
	}

	@Post(':id/share-token')
	@Can('statement.share')
	@HttpCode(201)
	share(@Param('id') id: string) {
		return this.statements.shareLink(idSchema.parse(id));
	}

	@Post(':id/share-token/revoke')
	@Can('statement.share')
	@HttpCode(200)
	revoke(@Param('id') id: string) {
		return this.statements.revokeLinks(idSchema.parse(id));
	}
}

@RequiresFeature('collections.owner_statements')
@Controller('owner-payouts')
@OrganizationScoped()
export class PayoutsController {
	constructor(private readonly statements: StatementsService) {}

	@Post()
	@Can('payout.record')
	@HttpCode(201)
	record(@Body() body: unknown) {
		return this.statements.recordPayout(payoutSchema.parse(body));
	}

	@Post(':id/cancel')
	@Can('payout.cancel')
	@HttpCode(200)
	cancel(@Param('id') id: string, @Body() body: unknown) {
		return this.statements.cancelPayout(idSchema.parse(id), cancelPayoutSchema.parse(body).reason);
	}
}

@Public()
@Controller('public/statements')
export class PublicStatementsController {
	constructor(
		private readonly statements: StatementsService,
		private readonly throttle: ThrottleService,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {}

	/** En-têtes et limite de débit par adresse IP ; jeton mal formé : introuvable, sans requête. */
	private async guard(req: Request, res: Response, token: string): Promise<string> {
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('X-Robots-Tag', 'noindex, nofollow');
		res.setHeader('Referrer-Policy', 'no-referrer');
		const r = await this.throttle.hit(`statement-public:${req.ip ?? 'unknown'}`, this.config.STATEMENT_PUBLIC_RATE_PER_MINUTE, 60_000);
		if (!r.allowed) {
			res.setHeader('Retry-After', String(r.retryAfterSeconds));
			throw new AppError('RATE_LIMITED', 'Trop de demandes : réessayez dans un instant.', 429, { retryAfterSeconds: r.retryAfterSeconds });
		}
		const parsed = statementTokenSchema.safeParse(token);
		if (!parsed.success) throw notFound();
		return parsed.data;
	}

	@Get('shared/:token')
	async shared(@Param('token') token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
		const view = await this.statements.shared(await this.guard(req, res, token));
		if (!view) throw notFound();
		return view;
	}

	@Get('shared/:token/pdf')
	async sharedPdf(@Param('token') token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
		const url = await this.statements.sharedPdfUrl(await this.guard(req, res, token));
		if (!url) throw new AppError('STATEMENT_PDF_PENDING', 'Le PDF de ce relevé n’est pas encore prêt, ou le lien n’est plus valable.', 404);
		return { url, expiresInSeconds: 300 };
	}
}

function notFound(): AppError {
	return new AppError(
		'STATEMENT_LINK_INVALID',
		'Ce lien de relevé est expiré, révoqué ou inconnu. Demandez un nouveau lien à votre agence.',
		404
	);
}
