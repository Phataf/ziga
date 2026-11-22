/**
 * Routes des espaces personnels (lot 10 ter, étape 2b) : personne connectée, sans organisation active ; lecture seule.
 * Interrupteurs de l'espace vérifiés par le service (pour la personne, puis pour chaque organisation lue).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { idSchema } from '@ziga/shared/ids';
import { z } from 'zod';
import { Auth } from '../identity/auth.guard.js';
import type { AccessClaims } from '../identity/token.service.js';
import { PortalsService } from './portals.service.js';

const cursorSchema = z.object({ cursor: z.string().max(200).nullish() });
const spaceSchema = z.object({ space: z.enum(['owner', 'tenant']) });

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

	/** Revenus par mois et par bien, rendement net ÷ encaissé. */
	@Get('owner/income')
	ownerIncome(@Auth() claims: AccessClaims) {
		return this.portals.ownerIncome(claims.sub);
	}

	/** Relevés émis de chaque organisation, avec reversé et reste. */
	@Get('owner/statements')
	ownerStatements(@Auth() claims: AccessClaims) {
		return this.portals.ownerStatements(claims.sub);
	}

	/** PDF d'un relevé émis (URL signée de 5 minutes), journalisé dans l'organisation. */
	@Post('owner/statements/:organizationId/:statementId/pdf')
	@HttpCode(200)
	ownerStatementPdf(
		@Auth() claims: AccessClaims,
		@Param('organizationId') organizationId: string,
		@Param('statementId') statementId: string
	) {
		return this.portals.ownerStatementPdf(claims.sub, idSchema.parse(organizationId), idSchema.parse(statementId));
	}

	/** Documents de ses biens et de leurs baux que la matrice ouvre au propriétaire (D22). */
	@Get('owner/documents')
	ownerDocuments(@Auth() claims: AccessClaims) {
		return this.portals.ownerDocuments(claims.sub);
	}

	/** Téléchargement d'un document permis (URL signée de courte durée), journalisé dans l'organisation. */
	@Post('documents/:organizationId/:documentId/download')
	@HttpCode(200)
	download(
		@Auth() claims: AccessClaims,
		@Param('organizationId') organizationId: string,
		@Param('documentId') documentId: string,
		@Body() body: unknown
	) {
		return this.portals.downloadDocument(
			claims.sub,
			spaceSchema.parse(body).space,
			idSchema.parse(organizationId),
			idSchema.parse(documentId)
		);
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
