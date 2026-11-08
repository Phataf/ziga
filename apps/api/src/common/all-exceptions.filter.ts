/**
 * Gestion d'erreurs uniforme : toute erreur sort en `{ code, message, details }`.
 * Les erreurs inattendues (5xx) sont journalisées avec la pile et envoyées à Sentry s'il est actif ;
 * le client ne reçoit jamais la pile ni le message interne.
 */
import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';
import { AppError, type ErrorBody } from './app-error.js';

const HTTP_CODES: Record<number, string> = {
	400: 'BAD_REQUEST',
	401: 'UNAUTHORIZED',
	403: 'FORBIDDEN',
	404: 'NOT_FOUND',
	405: 'METHOD_NOT_ALLOWED',
	409: 'CONFLICT',
	413: 'PAYLOAD_TOO_LARGE',
	422: 'UNPROCESSABLE_ENTITY',
	429: 'TOO_MANY_REQUESTS',
	503: 'SERVICE_UNAVAILABLE'
};

const HTTP_MESSAGES: Record<number, string> = {
	400: 'Requête invalide.',
	401: 'Authentification requise.',
	403: 'Accès refusé.',
	404: 'Ressource introuvable.',
	405: 'Méthode non autorisée.',
	409: 'Conflit avec l’état actuel de la ressource.',
	413: 'Requête trop volumineuse.',
	422: 'Données invalides.',
	429: 'Trop de requêtes, réessayez dans un instant.',
	503: 'Service momentanément indisponible.'
};

/** Convertit n'importe quelle erreur en statut HTTP et corps uniforme. */
export function toErrorResponse(error: unknown): { status: number; body: ErrorBody } {
	if (error instanceof AppError) {
		return {
			status: error.status,
			body: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) }
		};
	}
	if (error instanceof ZodError) {
		return {
			status: HttpStatus.BAD_REQUEST,
			body: {
				code: 'VALIDATION_ERROR',
				message: 'Données invalides.',
				details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
			}
		};
	}
	if (error instanceof HttpException) {
		const status = error.getStatus();
		return { status, body: { code: HTTP_CODES[status] ?? `HTTP_${status}`, message: HTTP_MESSAGES[status] ?? 'Erreur.' } };
	}
	return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { code: 'INTERNAL_ERROR', message: 'Une erreur inattendue est survenue.' } };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
	constructor(private readonly logger: PinoLogger) {
		logger.setContext(AllExceptionsFilter.name);
	}

	catch(error: unknown, host: ArgumentsHost): void {
		const ctx = host.switchToHttp();
		const response = ctx.getResponse<Response>();
		const request = ctx.getRequest<Request>();
		const { status, body } = toErrorResponse(error);
		if (status >= 500) {
			this.logger.error({ err: error, path: request.url }, 'Erreur inattendue');
			Sentry.captureException(error);
		}
		response.status(status).json(body);
	}
}
