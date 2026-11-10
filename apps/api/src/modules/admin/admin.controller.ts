/**
 * Routes du back-office (lot 04), toutes sous /admin et protégées par @PlatformCan : chaque rôle n'accède qu'à sa
 * partie (support : consulter, valider, assistance ; sales : formules et abonnements ; finance : paiements ;
 * seul super_admin modifie les interrupteurs). Connexion app_admin uniquement.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
	changePlanSchema,
	createOverrideSchema,
	createQuotaOverrideSchema,
	createSubscriptionSchema,
	openSupportAccessSchema,
	recordPaymentSchema,
	setFeatureModeSchema,
	setPlanFeatureSchema,
	suspendSchema,
	updatePlanSchema
} from '@ziga/shared/admin';
import { createNeighborhoodSchema, updateNeighborhoodSchema } from '@ziga/shared/geography';
import { FEATURES_BY_KEY, GLOBAL_MODES, isFeatureKey, type GlobalMode } from '@ziga/shared/features';
import { idSchema, isUuid } from '@ziga/shared/ids';
import { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import { FeatureAdminService } from '../features/feature-admin.service.js';
import { FeaturesService } from '../features/features.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { GeographyService } from '../properties/geography.service.js';
import { AdminDatabase } from './admin-database.service.js';
import { actorOf, AdminService } from './admin.service.js';
import { Platform, PlatformCan, type PlatformActor } from './platform.guard.js';

const optionalUuid = (v: string | undefined) => (v && isUuid(v) ? v : undefined);
const revokeSchema = z.object({ reason: z.string().trim().min(5, { error: 'Indiquez le motif (5 caractères au moins).' }).max(500) });

@Controller('admin')
export class AdminController {
	constructor(
		private readonly service: AdminService,
		private readonly admin: AdminDatabase,
		private readonly organizations: OrganizationsService,
		private readonly features: FeaturesService,
		private readonly featureAdmin: FeatureAdminService,
		private readonly geography: GeographyService
	) {}

	/** Rôle de la personne connectée et ses permissions (écrans du back-office). */
	@Get('me')
	@PlatformCan('platform.read')
	me(@Platform() p: PlatformActor) {
		return { userId: p.userId, role: p.role };
	}

	// ------------------------------------------------------------ organisations

	@Get('organizations')
	@PlatformCan('platform.read')
	organizationsList(
		@Query('type') type?: string,
		@Query('statut') status?: string,
		@Query('formule') plan?: string,
		@Query('q') q?: string
	) {
		return this.service.listOrganizations({ type, status, plan, q });
	}

	@Get('organizations/:id')
	@PlatformCan('platform.read')
	organization(@Param('id') id: string) {
		return this.service.organization(idSchema.parse(id));
	}

	@Post('organizations/:id/verify')
	@PlatformCan('organization.verify')
	@HttpCode(204)
	async verify(@Platform() p: PlatformActor, @Param('id') id: string) {
		const orgId = idSchema.parse(id);
		await this.admin.withOrganization(orgId, (tx) => this.organizations.setVerification(tx, actorOf(p), orgId, 'verified', null));
	}

	@Post('organizations/:id/suspend')
	@PlatformCan('organization.suspend')
	@HttpCode(204)
	async suspend(@Platform() p: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
		const orgId = idSchema.parse(id);
		const { reason } = suspendSchema.parse(body);
		await this.admin.withOrganization(orgId, (tx) => this.organizations.setVerification(tx, actorOf(p), orgId, 'suspended', reason));
	}

	@Post('organizations/:id/reinstate')
	@PlatformCan('organization.suspend')
	@HttpCode(204)
	async reinstate(@Platform() p: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
		const orgId = idSchema.parse(id);
		const { reason } = suspendSchema.parse(body);
		await this.admin.withOrganization(orgId, (tx) => this.organizations.setVerification(tx, actorOf(p), orgId, 'reinstated', reason));
	}

	/** Changement de formule ; une formule payante sans abonnement en cours reçoit un abonnement « à payer ». */
	@Put('organizations/:id/plan')
	@PlatformCan('organization.change_plan')
	@HttpCode(204)
	async changePlan(@Platform() p: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
		const orgId = idSchema.parse(id);
		const { planId, reason } = changePlanSchema.parse(body);
		await this.admin.withOrganization(orgId, async (tx) => {
			const changed = await this.organizations.setPlan(tx, actorOf(p), orgId, planId, reason);
			if (changed && planId !== 'discovery') await this.featureAdmin.ensurePendingSubscription(tx, actorOf(p), orgId, planId);
		});
	}

	// ------------------------------------------------------------ personnes

	@Get('users')
	@PlatformCan('platform.read')
	users(@Query('q') q?: string) {
		return this.service.searchPeople(q ?? '');
	}

	@Get('users/:id')
	@PlatformCan('platform.read')
	user(@Param('id') id: string) {
		return this.service.person(idSchema.parse(id));
	}

	// ------------------------------------------------------------ fonctionnalités

	@Get('features')
	@PlatformCan('platform.read')
	featureList() {
		return this.admin.transaction((tx) => this.featureAdmin.listFeatures(tx), { readOnly: true });
	}

	@Get('features/:key')
	@PlatformCan('platform.read')
	feature(@Param('key') key: string) {
		if (!isFeatureKey(key)) throw new AppError('NOT_FOUND', 'Fonctionnalité inconnue.', 404);
		return this.admin.transaction(
			async (tx) => {
				const row = (await this.featureAdmin.listFeatures(tx)).find((f) => f.key === key)!;
				const overrides = await this.service.overridesWithNames(tx, await this.featureAdmin.overrides(tx, { featureKey: key }));
				const plans = (await this.featureAdmin.plans(tx)).map((pl) => ({
					id: pl.id,
					label: pl.label,
					included: pl.features.some((f) => f.key === key),
					quota: pl.features.find((f) => f.key === key)?.quota ?? null
				}));
				return { ...row, description: FEATURES_BY_KEY[key].label, overrides, plans };
			},
			{ readOnly: true }
		);
	}

	@Get('features/:key/impact')
	@PlatformCan('platform.read')
	impact(@Param('key') key: string, @Query('mode') mode: string) {
		return this.service.impact(key, mode as GlobalMode);
	}

	/** Mode global : couper pour tous, ouvrir sur liste, ouvrir à tous (motif obligatoire, journalisé). */
	@Put('features/:key/mode')
	@PlatformCan('feature.manage')
	@HttpCode(204)
	async setMode(@Platform() p: PlatformActor, @Param('key') key: string, @Body() body: unknown) {
		const { mode, reason } = setFeatureModeSchema.parse(body);
		if (!(GLOBAL_MODES as readonly string[]).includes(mode)) throw new AppError('BAD_REQUEST', 'Mode inconnu.', 400);
		await this.admin.transaction((tx) => this.featureAdmin.setMode(tx, actorOf(p), key, mode, reason));
		await this.features.invalidate();
	}

	@Post('overrides')
	@PlatformCan('feature.manage')
	@HttpCode(201)
	async addOverride(@Platform() p: PlatformActor, @Body() body: unknown) {
		const input = createOverrideSchema.parse(body);
		const run = (tx: Parameters<Parameters<AdminDatabase['transaction']>[0]>[0]) => this.featureAdmin.addOverride(tx, actorOf(p), input);
		const id = input.scope === 'organization' ? await this.admin.withOrganization(input.targetId, run) : await this.admin.transaction(run);
		await this.features.invalidate();
		return { id };
	}

	@Delete('overrides/:id')
	@PlatformCan('feature.manage')
	@HttpCode(204)
	async revokeOverride(@Platform() p: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
		const overrideId = idSchema.parse(id);
		const { reason } = revokeSchema.parse(body ?? {});
		const row = await this.admin.transaction((tx) => this.featureAdmin.findOverride(tx, overrideId), { readOnly: true });
		const run = (tx: Parameters<Parameters<AdminDatabase['transaction']>[0]>[0]) =>
			this.featureAdmin.revokeOverride(tx, actorOf(p), overrideId, reason);
		if (row.organizationId) await this.admin.withOrganization(row.organizationId, run);
		else await this.admin.transaction(run);
		await this.features.invalidate();
	}

	@Get('simulator')
	@PlatformCan('platform.read')
	simulate(@Query('organizationId') organizationId?: string, @Query('userId') userId?: string) {
		return this.service.simulate(optionalUuid(organizationId) ?? null, optionalUuid(userId) ?? null);
	}

	// ------------------------------------------------------------ formules, quotas, abonnements

	@Get('plans')
	@PlatformCan('platform.read')
	plans() {
		return this.admin.transaction((tx) => this.featureAdmin.plans(tx), { readOnly: true });
	}

	/** Prix et quotas : hypothèses du cadrage, modifiables par sales. */
	@Patch('plans/:id')
	@PlatformCan('plan.manage')
	@HttpCode(204)
	async updatePlan(@Platform() p: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
		const input = updatePlanSchema.parse(body);
		await this.admin.transaction((tx) => this.featureAdmin.updatePlan(tx, actorOf(p), id, input));
		await this.features.invalidate();
	}

	/** Inclure ou exclure une fonctionnalité d'une formule : réservé à super_admin (interrupteurs). */
	@Put('plans/:planId/features/:key')
	@PlatformCan('feature.manage')
	@HttpCode(204)
	async setPlanFeature(@Platform() p: PlatformActor, @Param('planId') planId: string, @Param('key') key: string, @Body() body: unknown) {
		const input = setPlanFeatureSchema.parse({ ...(body as object), planId, featureKey: key });
		await this.admin.transaction((tx) => this.featureAdmin.setPlanFeature(tx, actorOf(p), input));
		await this.features.invalidate();
	}

	@Post('quota-overrides')
	@PlatformCan('feature.manage')
	@HttpCode(201)
	async addQuotaOverride(@Platform() p: PlatformActor, @Body() body: unknown) {
		const input = createQuotaOverrideSchema.parse(body);
		const id = await this.admin.withOrganization(input.organizationId, (tx) => this.featureAdmin.addQuotaOverride(tx, actorOf(p), input));
		await this.features.invalidate();
		return { id };
	}

	@Get('subscriptions')
	@PlatformCan('platform.read')
	subscriptions(@Query('organizationId') organizationId?: string) {
		return this.admin.transaction(
			async (tx) => {
				const rows = await this.featureAdmin.subscriptions(tx, optionalUuid(organizationId));
				const orgs = new Map((await this.organizations.directory(tx)).map((o) => [o.id, o.name]));
				return rows.map((s) => ({ ...s, organizationName: orgs.get(s.organizationId) ?? '—', createdAt: s.createdAt.toISOString() }));
			},
			{ readOnly: true }
		);
	}

	@Post('subscriptions')
	@PlatformCan('subscription.manage')
	@HttpCode(201)
	async createSubscription(@Platform() p: PlatformActor, @Body() body: unknown) {
		const input = createSubscriptionSchema.parse(body);
		// Saisir « payé » d'emblée suppose la permission d'enregistrer un paiement (finances ou super_admin).
		if (input.paymentStatus === 'paid' && p.role !== 'super_admin' && p.role !== 'finance') {
			throw new AppError('FORBIDDEN_ACTION', 'L’enregistrement d’un paiement revient aux finances.', 403, {
				action: 'subscription.record_payment'
			});
		}
		const id = await this.admin.withOrganization(input.organizationId, (tx) => this.featureAdmin.createSubscription(tx, actorOf(p), input));
		return { id };
	}

	/** Paiement reçu sur le compte de la plateforme (jamais un loyer, règle 5). */
	@Post('subscriptions/:id/payment')
	@PlatformCan('subscription.record_payment')
	@HttpCode(204)
	async recordPayment(@Platform() p: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
		const subscriptionId = idSchema.parse(id);
		const input = recordPaymentSchema.parse(body);
		const row = await this.admin.transaction((tx) => this.featureAdmin.findSubscription(tx, subscriptionId), { readOnly: true });
		await this.admin.withOrganization(row.organizationId, (tx) => this.featureAdmin.recordPayment(tx, actorOf(p), subscriptionId, input));
	}

	// ------------------------------------------------------------ accès d'assistance

	@Get('support-accesses')
	@PlatformCan('support.access')
	accesses() {
		return this.service.listAccesses();
	}

	@Post('support-accesses')
	@PlatformCan('support.access')
	@HttpCode(201)
	openAccess(@Platform() p: PlatformActor, @Body() body: unknown) {
		return this.service.openAccess(p, openSupportAccessSchema.parse(body));
	}

	@Post('support-accesses/:id/close')
	@PlatformCan('support.access')
	@HttpCode(204)
	async closeAccess(@Platform() p: PlatformActor, @Param('id') id: string) {
		await this.service.closeAccess(p, idSchema.parse(id));
	}

	@Get('support-accesses/:id/organization')
	@PlatformCan('support.access')
	readOrganization(@Platform() p: PlatformActor, @Param('id') id: string) {
		return this.service.readOrganization(p, idSchema.parse(id));
	}

	@Get('support-accesses/:id/journal')
	@PlatformCan('support.access')
	readJournal(@Platform() p: PlatformActor, @Param('id') id: string, @Query('avant') before?: string) {
		return this.service.readJournal(p, idSchema.parse(id), before || undefined);
	}

	// ------------------------------------------------------------ référentiel géographique (lot 07)

	/** Communes et quartiers, avec la référence OSM et la vérification sur place. */
	@Get('geography')
	@PlatformCan('platform.read')
	geographyList() {
		return this.admin.transaction(
			async (tx) => ({ communes: await this.geography.communes(tx), neighborhoods: await this.geography.neighborhoods(tx) }),
			{ readOnly: true }
		);
	}

	@Post('neighborhoods')
	@PlatformCan('geography.manage')
	@HttpCode(201)
	createNeighborhood(@Platform() p: PlatformActor, @Body() body: unknown) {
		return this.admin.transaction((tx) => this.geography.create(tx, actorOf(p), createNeighborhoodSchema.parse(body)));
	}

	@Patch('neighborhoods/:id')
	@PlatformCan('geography.manage')
	updateNeighborhood(@Platform() p: PlatformActor, @Param('id') id: string, @Body() body: unknown) {
		return this.admin.transaction((tx) => this.geography.update(tx, actorOf(p), idSchema.parse(id), updateNeighborhoodSchema.parse(body)));
	}

	// ------------------------------------------------------------ journal de la plateforme

	@Get('audit')
	@PlatformCan('platform.read')
	journal(@Query('avant') before?: string, @Query('userId') userId?: string, @Query('action') action?: string) {
		return this.service.journal({ before: before || undefined, userId: optionalUuid(userId), action: action || undefined });
	}
}
