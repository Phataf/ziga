/**
 * Santé, pour le répartiteur de charge :
 * - GET /health/live  : le processus répond (aucune dépendance vérifiée) ;
 * - GET /health/ready : base, Redis et stockage joignables, et pas d'arrêt en cours. 503 sinon.
 */
import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../modules/identity/auth.guard.js';
import { HealthService } from './health.service.js';

@Controller('health')
@Public()
export class HealthController {
	constructor(private readonly health: HealthService) {}

	@Get('live')
	@HttpCode(200)
	live() {
		return { status: 'ok' };
	}

	@Get('ready')
	async ready(@Res({ passthrough: true }) res: Response) {
		const r = await this.health.readiness();
		if (r.ready) return { status: 'ok', checks: r.checks };
		res.status(503);
		return {
			code: 'NOT_READY',
			message: r.shuttingDown ? 'Arrêt en cours.' : 'Une dépendance est injoignable.',
			details: { checks: r.checks }
		};
	}
}
