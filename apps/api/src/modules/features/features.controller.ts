/**
 * Routes du module features (lot 04) :
 * - GET /me/features : état effectif de chaque clé pour la personne et l'organisation active (en-tête facultatif) ;
 * - /organization/features : réglages du directeur (désactiver seulement ce qui est ouvert, jamais activer) ;
 * - /organization/subscription : formule et palier de l'abonnement, en lecture.
 */
import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { organizationFeatureSettingSchema } from '@ziga/shared/organizations';
import { FEATURES_BY_KEY, isFeatureKey, PLAN_LABELS, toStatusView, type PlanId } from '@ziga/shared/features';
import { isUuid } from '@ziga/shared/ids';
import { sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { DatabaseService } from '../../db/database.module.js';
import { organizationFeatureSettings } from '../../db/schema/features.js';
import { AuditService } from '../audit/audit.service.js';
import { Auth } from '../identity/auth.guard.js';
import type { AccessClaims } from '../identity/token.service.js';
import {
	Can,
	loadMembershipScope,
	ORGANIZATION_HEADER,
	OrganizationScoped,
	type OrganizationRequest
} from '../organizations/organization-context.js';
import { FeaturesService } from './features.service.js';
import { SubscriptionsService } from './subscriptions.service.js';

@Controller()
export class MeFeaturesController {
	constructor(
		private readonly features: FeaturesService,
		private readonly database: DatabaseService
	) {}

	@Get('me/features')
	async mine(@Auth() claims: AccessClaims, @Req() req: OrganizationRequest) {
		const header = req.headers[ORGANIZATION_HEADER];
		let org = null;
		if (typeof header === 'string' && header) {
			if (!isUuid(header)) throw new AppError('ORGANIZATION_REQUIRED', 'Organisation invalide.', 400);
			const scope = await loadMembershipScope(this.database, claims.sub, header);
			if (!scope) throw new AppError('NOT_A_MEMBER', 'Vous n’êtes pas membre de cette organisation.', 403);
			org = await this.features.organizationContext(scope.organizationId, scope.planId);
		}
		const all = await this.features.resolveAll(claims.sub, org);
		return {
			organizationId: org?.organizationId ?? null,
			features: Object.fromEntries(Object.entries(all).map(([k, r]) => [k, toStatusView(r)]))
		};
	}
}

@Controller('organization')
@OrganizationScoped()
export class OrganizationFeaturesController {
	constructor(
		private readonly features: FeaturesService,
		private readonly subscriptions: SubscriptionsService,
		private readonly audit: AuditService
	) {}

	/** Chaque clé : état effectif, raison, et si le directeur peut la désactiver (ouverte par la plateforme). */
	@Get('features')
	@Can('organization.read')
	async list(@Auth() claims: AccessClaims) {
		const scope = RequestContext.organization();
		const org = await this.features.organizationContext(scope.organizationId, scope.planId);
		const effective = await this.features.resolveAll(claims.sub, org);
		// Sans les désactivations de l'organisation : ce que la plateforme lui ouvre.
		const open = await this.features.resolveAll(null, { ...org, disabled: [] });
		return Object.keys(effective).map((key) => ({
			key,
			label: FEATURES_BY_KEY[key as keyof typeof FEATURES_BY_KEY]?.label ?? key,
			...toStatusView(effective[key]!),
			openByPlatform: open[key]!.enabled,
			disabledByOrganization: org.disabled.includes(key)
		}));
	}

	@Put('features/:key')
	@Can('settings.update')
	async set(@Auth() claims: AccessClaims, @Param('key') key: string, @Body() body: unknown) {
		if (!isFeatureKey(key)) throw new AppError('NOT_FOUND', 'Fonctionnalité inconnue.', 404);
		const { disabled } = organizationFeatureSettingSchema.parse(body);
		const scope = RequestContext.organization();
		const tx = RequestContext.tx();
		const org = await this.features.organizationContext(scope.organizationId, scope.planId, tx);
		const open = await this.features.resolve(key, null, { ...org, disabled: [] });
		// Le directeur ne fait que désactiver ce qui lui est ouvert ; lever sa propre désactivation reste possible.
		if (disabled && !open.enabled) {
			throw new AppError('FEATURE_NOT_OPEN', `Cette fonctionnalité ne vous est pas ouverte (${open.reason.replace(/^Non — /u, '')}).`, 409);
		}
		const before = org.disabled.includes(key);
		if (before !== disabled) {
			await tx
				.insert(organizationFeatureSettings)
				.values({ organizationId: scope.organizationId, featureKey: key, disabledByOrganization: disabled, updatedBy: claims.sub })
				.onConflictDoUpdate({
					target: [organizationFeatureSettings.organizationId, organizationFeatureSettings.featureKey],
					set: { disabledByOrganization: disabled, updatedBy: claims.sub, updatedAt: sql`now()` }
				});
			await this.audit.record(tx, {
				actor: { type: 'user', userId: claims.sub, role: scope.role },
				organizationId: scope.organizationId,
				action: 'organization.feature_setting',
				objectType: 'organization',
				objectId: scope.organizationId,
				before: { key, disabledByOrganization: before },
				after: { key, disabledByOrganization: disabled }
			});
		}
		return this.list(claims);
	}

	@Get('subscription')
	@Can('organization.read')
	async subscription() {
		const scope = RequestContext.organization();
		const { state, periods } = await this.subscriptions.stateOf(scope.organizationId, scope.planId);
		return {
			planId: scope.planId,
			planLabel: PLAN_LABELS[scope.planId as PlanId] ?? scope.planId,
			...state,
			periods: periods.map((p) => ({
				id: p.id,
				planId: p.planId,
				startsOn: p.startsOn,
				endsOn: p.endsOn,
				amount: p.amount,
				paymentStatus: p.paymentStatus,
				paidOn: p.paidOn
			}))
		};
	}
}
