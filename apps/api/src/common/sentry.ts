/**
 * Sentry, désactivable : sans SENTRY_DSN, rien n'est initialisé ni envoyé.
 * Appelé avant le chargement des modules NestJS, pour que l'instrumentation automatique fonctionne.
 */
import * as Sentry from '@sentry/nestjs';
import type { AppConfig } from '../config/env.js';

export function initSentry(config: AppConfig, service: 'api' | 'worker'): boolean {
	if (!config.SENTRY_DSN) return false;
	Sentry.init({
		dsn: config.SENTRY_DSN,
		environment: config.SENTRY_ENVIRONMENT,
		serverName: `ziga-${service}`,
		// Données personnelles (loi de 2026 sur les données, ARCOD) : rien sur l'utilisateur, ni cookies, ni corps.
		dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
		tracesSampleRate: 0
	});
	return true;
}
