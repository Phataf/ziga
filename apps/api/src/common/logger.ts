/**
 * Journaux pino en JSON (CLAUDE.md §2), avec un identifiant par requête :
 * repris de l'en-tête `x-request-id` s'il est sûr, sinon un UUIDv7, et renvoyé dans la réponse.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { newId } from '@ziga/shared/ids';
import type { DestinationStream } from 'pino';
import type { Params } from 'nestjs-pino';
import type { Options } from 'pino-http';
import type { AppConfig } from '../config/env.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestId(req: IncomingMessage, res: ServerResponse): string {
	const header = req.headers['x-request-id'];
	const id = typeof header === 'string' && SAFE_REQUEST_ID.test(header) ? header : newId();
	res.setHeader('x-request-id', id);
	return id;
}

export function loggerParams(config: AppConfig, name: 'api' | 'worker', stream?: DestinationStream): Params {
	const options: Options = {
		name: `ziga-${name}`,
		level: config.LOG_LEVEL,
		genReqId: requestId,
		// Jamais de secret ni de donnée personnelle dans les journaux.
		redact: {
			paths: [
				'req.headers.authorization',
				'req.headers.cookie',
				'res.headers["set-cookie"]',
				'req.body',
				'req.query.code',
				'req.query.token'
			],
			censor: '[masqué]'
		},
		autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
		...(config.LOG_PRETTY ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {})
	};
	// Un flux explicite (tests) remplace la sortie standard : il permet de vérifier ce qui est journalisé.
	return { pinoHttp: stream ? [options, stream] : options };
}
