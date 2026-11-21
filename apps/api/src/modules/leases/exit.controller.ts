/**
 * Sortie du locataire (lot 10 bis, étape 3) : routes du module leases. Permissions vérifiées à chaque route (garde @Can) ;
 * l'agent de terrain n'atteint que les baux de ses unités affectées (service). Mêmes schémas Zod que les formulaires et
 * la synchronisation (packages/shared, exit-schemas.ts).
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
	closeSettlementSchema,
	createAgreementSchema,
	createInspectionSchema,
	createRepairSchema,
	decideAgreementSchema,
	disputeOutcomeSchema,
	disputeSchema,
	inspectionItemSchema,
	managementTransferSchema,
	recordNoticeSchema,
	refundSchema,
	repairDoneSchema,
	repairVerifySchema,
	signInspectionSchema,
	updateInspectionItemSchema
} from '@ziga/shared/exit-schemas';
import { idSchema } from '@ziga/shared/ids';
import { Can, OrganizationScoped } from '../organizations/organization-context.js';
import { ExitService } from './exit.service.js';

@Controller()
@OrganizationScoped()
export class ExitController {
	constructor(private readonly exit: ExitService) {}

	@Post('leases/:id/notice')
	@Can('lease.notice')
	@HttpCode(201)
	notice(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.recordNotice(idSchema.parse(id), recordNoticeSchema.parse(body));
	}

	@Get('leases/:id/exit')
	@Can('lease.read')
	exitOf(@Param('id') id: string) {
		return this.exit.exitOf(idSchema.parse(id));
	}

	@Post('inspections')
	@Can('inspection.create')
	@HttpCode(201)
	createInspection(@Body() body: unknown) {
		return this.exit.createInspection(createInspectionSchema.parse(body));
	}

	@Post('inspections/:id/items')
	@Can('inspection.create')
	@HttpCode(201)
	addItem(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.addItem(idSchema.parse(id), inspectionItemSchema.parse(body));
	}

	@Patch('inspection-items/:id')
	@Can('inspection.create')
	updateItem(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.updateItem(idSchema.parse(id), updateInspectionItemSchema.parse(body));
	}

	@Delete('inspection-items/:id')
	@Can('inspection.create')
	@HttpCode(204)
	async deleteItem(@Param('id') id: string) {
		await this.exit.deleteItem(idSchema.parse(id));
	}

	@Post('inspections/:id/sign')
	@Can('inspection.sign')
	@HttpCode(200)
	sign(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.sign(idSchema.parse(id), signInspectionSchema.parse(body));
	}

	@Post('inspections/:id/dispute')
	@Can('inspection.sign')
	@HttpCode(200)
	disputeInspection(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.disputeInspection(idSchema.parse(id), disputeSchema.parse(body));
	}

	@Post('inspections/:id/resolve')
	@Can('deposit.settle')
	@HttpCode(200)
	resolveInspection(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.resolveInspection(idSchema.parse(id), disputeOutcomeSchema.parse(body));
	}

	@Post('repairs')
	@Can('deposit.settle')
	@HttpCode(201)
	createRepair(@Body() body: unknown) {
		return this.exit.createRepair(createRepairSchema.parse(body));
	}

	@Post('repairs/:id/done')
	@Can('deposit.settle')
	@HttpCode(200)
	repairDone(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.repairDone(idSchema.parse(id), repairDoneSchema.parse(body));
	}

	@Post('repairs/:id/verify')
	@Can('deposit.settle')
	@HttpCode(200)
	repairVerify(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.repairVerify(idSchema.parse(id), repairVerifySchema.parse(body).verifiedOn);
	}

	@Post('agreements')
	@Can('deposit.settle')
	@HttpCode(201)
	createAgreement(@Body() body: unknown) {
		return this.exit.createAgreement(createAgreementSchema.parse(body));
	}

	@Post('agreements/:id/decision')
	@Can('agreement.decide')
	@HttpCode(200)
	decideAgreement(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.decideAgreement(idSchema.parse(id), decideAgreementSchema.parse(body));
	}

	@Post('deposit-accounts/:id/settlement')
	@Can('deposit.settle')
	@HttpCode(200)
	prepareSettlement(@Param('id') id: string) {
		return this.exit.prepareSettlement(idSchema.parse(id));
	}

	@Post('deposit-settlements/:id/propose')
	@Can('deposit.settle')
	@HttpCode(200)
	propose(@Param('id') id: string) {
		return this.exit.proposeSettlement(idSchema.parse(id));
	}

	@Post('deposit-settlements/:id/accept')
	@Can('deposit.settle')
	@HttpCode(200)
	accept(@Param('id') id: string) {
		return this.exit.acceptSettlement(idSchema.parse(id));
	}

	@Post('deposit-settlements/:id/dispute')
	@Can('deposit.settle')
	@HttpCode(200)
	disputeSettlement(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.disputeSettlement(idSchema.parse(id), disputeSchema.parse(body));
	}

	@Post('deposit-settlements/:id/refunds')
	@Can('deposit.settle')
	@HttpCode(200)
	refund(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.refund(idSchema.parse(id), refundSchema.parse(body));
	}

	@Post('deposit-settlements/:id/close')
	@Can('deposit.settle')
	@HttpCode(200)
	close(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.closeSettlement(idSchema.parse(id), closeSettlementSchema.parse(body));
	}

	@Post('mandates/:id/transfer')
	@Can('management.transfer')
	@HttpCode(201)
	transfer(@Param('id') id: string, @Body() body: unknown) {
		return this.exit.transfer(idSchema.parse(id), managementTransferSchema.parse(body));
	}
}
