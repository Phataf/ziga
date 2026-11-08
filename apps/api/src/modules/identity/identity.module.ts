import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { MeController } from './me.controller.js';
import { ThrottleService } from './throttle.service.js';
import { TokenService } from './token.service.js';

/** Module identity (lot 02) : personnes, authentification, sessions. Garde global sur toute l'API. */
@Module({
	controllers: [AuthController, MeController],
	providers: [AuthService, TokenService, ThrottleService, { provide: APP_GUARD, useClass: AuthGuard }],
	exports: [AuthService, TokenService, ThrottleService]
})
export class IdentityModule {}
