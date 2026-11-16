/**
 * Routes des contrats, des modèles et des avenants (lot 08 bis) : @OrganizationScoped, une permission @Can par route
 * (packages/shared/permissions.ts) ; @Creation() sur les créations (abonnement échu). Direction et gestion créent,
 * figent et déposent les signatures ; la direction seule gère les modèles ; l'agent de terrain et le profil lecture
 * n'ont accès à aucune donnée de contrat. La génération se fait en tâche de fond : la route rend le contrat avec
 * `generationStatus: 'pending'`, la synchronisation ramène la version prête.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
	cancelAmendmentSchema,
	contractUploadSchema,
	createAmendmentSchema,
	createContractSchema,
	createTemplateSchema,
	freezeContractSchema,
	legalizationReminderSchema,
	legalizationSchema,
	regenerateContractSchema,
	registrationSchema,
	signedScanSchema,
	CONTRACT_STATUSES
} from '@ziga/shared/contracts';
import { idSchema } from '@ziga/shared/ids';
import { z } from 'zod';
import { Creation } from '../../features/feature.guards.js';
import { Can, OrganizationScoped } from '../../organizations/organization-context.js';
import { ContractsService } from './contracts.service.js';

const versionNumber = z.coerce.number().int().min(1);
const expected = z.object({ expectedVersion: z.number().int().min(0) });

@Controller('contract-templates')
@OrganizationScoped()
export class ContractTemplatesController {
	constructor(private readonly contracts: ContractsService) {}

	/** Modèles de l'organisation, et modèle en usage pour chaque type (le sien, ou celui de la plateforme, D25). */
	@Get()
	@Can('contract_template.read')
	list() {
		return this.contracts.templates();
	}

	/** Dépôt d'un modèle Word (.docx, 5 Mo au plus) : brouillon et URL d'envoi signée. */
	@Post()
	@Can('contract_template.manage')
	@HttpCode(201)
	create(@Body() body: unknown) {
		return this.contracts.createTemplate(createTemplateSchema.parse(body));
	}

	/** Contrôle du fichier reçu (point 2) : refus motivé, ou balises reconnues et inconnues, polices, pages. */
	@Post(':id/inspect')
	@Can('contract_template.manage')
	@HttpCode(200)
	inspect(@Param('id') id: string) {
		return this.contracts.inspectTemplate(idSchema.parse(id));
	}

	/** Aperçu PDF avec les données d'exemple (tâche de fond). */
	@Post(':id/preview')
	@Can('contract_template.manage')
	@HttpCode(202)
	preview(@Param('id') id: string) {
		return this.contracts.previewTemplate(idSchema.parse(id));
	}

	/** Activation : une balise inconnue la bloque. */
	@Post(':id/activate')
	@Can('contract_template.manage')
	@HttpCode(200)
	activate(@Param('id') id: string) {
		return this.contracts.activateTemplate(idSchema.parse(id));
	}

	@Post(':id/retire')
	@Can('contract_template.manage')
	@HttpCode(200)
	retire(@Param('id') id: string) {
		return this.contracts.retireTemplate(idSchema.parse(id));
	}
}

@Controller('contracts')
@OrganizationScoped()
export class ContractsController {
	constructor(private readonly contracts: ContractsService) {}

	@Get()
	@Can('contract.read')
	list(@Query() query: unknown) {
		const { leaseId, status } = z.object({ leaseId: idSchema.optional(), status: z.enum(CONTRACT_STATUSES).optional() }).parse(query ?? {});
		return this.contracts.list({ leaseId, status });
	}

	@Get(':id')
	@Can('contract.read')
	get(@Param('id') id: string) {
		return this.contracts.get(idSchema.parse(id));
	}

	/** Valeurs résolues d'une version (état civil compris) : lues en ligne, jamais synchronisées. */
	@Get(':id/versions/:number/fields')
	@Can('contract.read')
	fields(@Param('id') id: string, @Param('number') number: string) {
		return this.contracts.versionFields(idSchema.parse(id), versionNumber.parse(number));
	}

	/** Lien signé de 5 minutes (Word ou PDF), avec l'empreinte de la version ; chaque lien délivré est journalisé. */
	@Get(':id/versions/:number/download')
	@Can('contract.read')
	download(@Param('id') id: string, @Param('number') number: string, @Query('format') format: unknown) {
		return this.contracts.download(idSchema.parse(id), versionNumber.parse(number), z.enum(['pdf', 'docx']).default('pdf').parse(format));
	}

	/** Version suivante : en brouillon ou en vérification ; sur un contrat prêt à signer, le renvoie en vérification. */
	@Post(':id/versions')
	@Can('contract.create')
	@HttpCode(202)
	regenerate(@Param('id') id: string, @Body() body: unknown) {
		return this.contracts.regenerate(idSchema.parse(id), regenerateContractSchema.parse(body));
	}

	@Post(':id/submit')
	@Can('contract.create')
	@HttpCode(200)
	submit(@Param('id') id: string, @Body() body: unknown) {
		return this.contracts.submitForReview(idSchema.parse(id), expected.parse(body).expectedVersion);
	}

	@Post(':id/return-to-draft')
	@Can('contract.create')
	@HttpCode(200)
	returnToDraft(@Param('id') id: string) {
		return this.contracts.returnToDraft(idSchema.parse(id));
	}

	/** Prêt à signer : figé ; aucun blanc, bail inchangé, mandat de gestion en vigueur. */
	@Post(':id/freeze')
	@Can('contract.freeze')
	@HttpCode(200)
	freeze(@Param('id') id: string, @Body() body: unknown) {
		return this.contracts.freeze(idSchema.parse(id), freezeContractSchema.parse(body).expectedVersion);
	}

	/** Dépôt d'un scan signé ou d'une preuve de légalisation ou d'enregistrement : fiche en attente et URL d'envoi. */
	@Post(':id/uploads')
	@Can('contract.upload_signed')
	@HttpCode(201)
	upload(@Param('id') id: string, @Body() body: unknown) {
		return this.contracts.createUpload(idSchema.parse(id), contractUploadSchema.parse(body));
	}

	/** Signature manuscrite, scan déposé (D21) : le bail en brouillon est validé, l'avenant appliqué. */
	@Post(':id/signature')
	@Can('contract.upload_signed')
	@HttpCode(200)
	sign(@Param('id') id: string, @Body() body: unknown) {
		return this.contracts.sign(idSchema.parse(id), signedScanSchema.parse(body));
	}

	@Put(':id/legalization')
	@Can('contract.upload_signed')
	legalize(@Param('id') id: string, @Body() body: unknown) {
		return this.contracts.setLegalization(idSchema.parse(id), legalizationSchema.parse(body));
	}

	@Put(':id/registration')
	@Can('contract.upload_signed')
	register(@Param('id') id: string, @Body() body: unknown) {
		return this.contracts.setRegistration(idSchema.parse(id), registrationSchema.parse(body));
	}

	@Put(':id/legalization-reminder')
	@Can('contract.upload_signed')
	reminder(@Param('id') id: string, @Body() body: unknown) {
		return this.contracts.setLegalizationReminder(idSchema.parse(id), legalizationReminderSchema.parse(body).enabled);
	}
}

@Controller('leases')
@OrganizationScoped()
export class LeaseContractsController {
	constructor(private readonly contracts: ContractsService) {}

	/** Contrat du bail : brouillon, puis la version 1 générée en tâche de fond. */
	@Post(':leaseId/contract')
	@Can('contract.create')
	@Creation()
	@HttpCode(202)
	create(@Param('leaseId') leaseId: string, @Body() body: unknown) {
		return this.contracts.createContract(idSchema.parse(leaseId), createContractSchema.parse(body));
	}

	@Get(':leaseId/amendments')
	@Can('contract.read')
	amendments(@Param('leaseId') leaseId: string) {
		return this.contracts.amendments(idSchema.parse(leaseId));
	}

	/** Avenant (renouvellement, loyer, autre) et son contrat : appliqué au bail à sa signature. */
	@Post(':leaseId/amendments')
	@Can('contract.create')
	@Creation()
	@HttpCode(202)
	createAmendment(@Param('leaseId') leaseId: string, @Body() body: unknown) {
		const parsed = z.object({ amendment: z.unknown(), contract: z.unknown() }).parse(body);
		return this.contracts.createAmendment(
			idSchema.parse(leaseId),
			createAmendmentSchema.parse(parsed.amendment),
			createContractSchema.parse(parsed.contract)
		);
	}
}

@Controller('amendments')
@OrganizationScoped()
export class AmendmentsController {
	constructor(private readonly contracts: ContractsService) {}

	@Post(':id/cancel')
	@Can('contract.create')
	@HttpCode(200)
	cancel(@Param('id') id: string, @Body() body: unknown) {
		return this.contracts.cancelAmendment(idSchema.parse(id), cancelAmendmentSchema.parse(body).reason);
	}
}
