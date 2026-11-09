/**
 * Gardes du lot 04, posés sur les routes d'organisation (après @OrganizationScoped, qui fournit la formule) :
 * - @RequiresFeature(key) : 403 FEATURE_DISABLED si la fonctionnalité est fermée pour cette personne et cette organisation ;
 * - @Creation() : 403 SUBSCRIPTION_EXPIRED si l'abonnement est échu au-delà du délai de grâce (créations seulement :
 *   la consultation, les reçus, les relevés, la sortie d'un locataire et l'export restent toujours possibles).
 */
import { applyDecorators, CanActivate, ExecutionContext, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FeatureKey } from '@ziga/shared/features';
import { AppError } from '../../common/app-error.js';
import type { OrganizationRequest } from '../organizations/organization-context.js';
import { FeaturesService } from './features.service.js';
import { SubscriptionsService } from './subscriptions.service.js';

const FEATURE = 'ziga:feature';

@Injectable()
export class FeatureGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly features: FeaturesService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const key = this.reflector.getAllAndOverride<FeatureKey | undefined>(FEATURE, [context.getHandler(), context.getClass()]);
		if (!key) return true;
		const request = context.switchToHttp().getRequest<OrganizationRequest>();
		const scope = request.organization;
		const org = scope ? await this.features.organizationContext(scope.organizationId, scope.planId) : null;
		await this.features.assertEnabled(key, request.auth?.sub ?? null, org);
		return true;
	}
}

/** Fonctionnalité optionnelle exigée par la route, vérifiée côté serveur (CLAUDE.md §8). */
export const RequiresFeature = (key: FeatureKey) => applyDecorators(SetMetadata(FEATURE, key), UseGuards(FeatureGuard));

@Injectable()
export class CreationGuard implements CanActivate {
	constructor(private readonly subscriptions: SubscriptionsService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const scope = context.switchToHttp().getRequest<OrganizationRequest>().organization;
		if (!scope) throw new AppError('NO_ORGANIZATION_CONTEXT', 'Contexte d’organisation absent.', 500);
		await this.subscriptions.assertCreationAllowed(scope);
		return true;
	}
}

/**
 * Route qui crée une donnée bloquée quand l'abonnement est échu : nouveaux biens, unités, baux, propriétaires,
 * membres et publications (réponse du porteur du 08/11/2026). À poser par chaque lot sur ses créations.
 */
export const Creation = () => UseGuards(CreationGuard);
