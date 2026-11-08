import { HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from './app-error.js';
import { toErrorResponse } from './all-exceptions.filter.js';

describe('erreurs uniformes { code, message, details }', () => {
	it('garde le code, le message et les détails d’une AppError', () => {
		expect(toErrorResponse(new AppError('INVALID_ORGANIZATION', 'Organisation invalide.', 400, { id: 'x' }))).toEqual({
			status: 400,
			body: { code: 'INVALID_ORGANIZATION', message: 'Organisation invalide.', details: { id: 'x' } }
		});
	});

	it('traduit une erreur de validation Zod en liste de champs', () => {
		const r = z.object({ amount: z.number().int() }).safeParse({ amount: 1.5 });
		const { status, body } = toErrorResponse(r.error);
		expect(status).toBe(400);
		expect(body.code).toBe('VALIDATION_ERROR');
		expect(body.details).toEqual([{ path: 'amount', message: expect.any(String) }]);
	});

	it('donne un code stable aux erreurs HTTP de NestJS', () => {
		expect(toErrorResponse(new NotFoundException())).toEqual({
			status: 404,
			body: { code: 'NOT_FOUND', message: 'Ressource introuvable.' }
		});
		expect(toErrorResponse(new HttpException('x', 418)).body.code).toBe('HTTP_418');
	});

	it('ne révèle jamais le message d’une erreur inattendue', () => {
		const { status, body } = toErrorResponse(new Error('mot de passe de la base : secret'));
		expect(status).toBe(500);
		expect(body).toEqual({ code: 'INTERNAL_ERROR', message: 'Une erreur inattendue est survenue.' });
	});
});
