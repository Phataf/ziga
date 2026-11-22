/**
 * Routes des espaces personnels (lot 10 ter, étape 2b) : personne connectée, sans organisation active ; lecture seule.
 * Interrupteurs de l'espace vérifiés par le service (pour la personne, puis pour chaque organisation lue).
 */
import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import { z } from 'zod';
import { Auth } from '../identity/auth.guard.js';
import type { AccessClaims } from '../identity/token.service.js';
import { PortalsService } from './portals.service.js';

const cursorSchema = z.object({ cursor: z.string().max(200).nullish() });

@Controller('me/portal')
export class PortalsController {
	constructor(private readonly portals: PortalsService) {}

	/** Espaces ouverts à la personne (choix de l'espace dans le menu du compte). */
	@Get()
	spaces(@Auth() claims: AccessClaims) {
		return this.portals.spaces(claims.sub);
	}

	/** Patrimoine : tous ses biens, groupés par gestionnaire. */
	@Get('owner/assets')
	ownerAssets(@Auth() claims: AccessClaims) {
		return this.portals.ownerAssets(claims.sub);
	}

	/** Historique du locataire, toutes agences confondues (curseur). */
	@Get('tenant/history')
	tenantHistory(@Auth() claims: AccessClaims, @Query() query: unknown) {
		return this.portals.tenantHistory(claims.sub, cursorSchema.parse(query).cursor ?? null);
	}

	/** Reçu d'un loyer (URL signée de 5 minutes), journalisé dans l'organisation. */
	@Post('tenant/receipts/:organizationId/:receiptId/pdf')
	@HttpCode(200)
	receiptPdf(@Auth() claims: AccessClaims, @Param('organizationId') organizationId: string, @Param('receiptId') receiptId: string) {
		return this.portals.tenantReceiptPdf(claims.sub, idSchema.parse(organizationId), idSchema.parse(receiptId));
	}
}
