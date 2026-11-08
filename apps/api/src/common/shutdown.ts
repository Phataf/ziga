/**
 * Arrêt propre (montée en charge) : au premier SIGTERM ou SIGINT, on cesse d'accepter du travail nouveau,
 * on laisse finir les requêtes HTTP et les tâches en cours, puis on quitte. Passé le délai, arrêt forcé.
 */
export interface Closable {
	close(): Promise<void>;
}

export interface ShutdownLogger {
	info(msg: string): void;
	error(obj: unknown, msg: string): void;
}

export function registerGracefulShutdown(
	app: Closable,
	options: { timeoutMs: number; logger: ShutdownLogger; beforeClose?: () => void; exit?: (code: number) => void }
): (signal: NodeJS.Signals) => Promise<void> {
	const exit = options.exit ?? ((code: number) => process.exit(code));
	let stopping = false;
	const shutdown = async (signal: NodeJS.Signals) => {
		if (stopping) return;
		stopping = true;
		options.logger.info(`Signal ${signal} reçu : fin des traitements en cours avant l'arrêt`);
		options.beforeClose?.();
		const timer = setTimeout(() => {
			options.logger.error({ timeoutMs: options.timeoutMs }, 'Arrêt forcé : délai dépassé');
			exit(1);
		}, options.timeoutMs);
		timer.unref();
		try {
			await app.close();
			clearTimeout(timer);
			options.logger.info('Arrêt terminé');
			exit(0);
		} catch (error) {
			clearTimeout(timer);
			options.logger.error({ err: error }, 'Erreur pendant l’arrêt');
			exit(1);
		}
	};
	process.once('SIGTERM', shutdown);
	process.once('SIGINT', shutdown);
	return shutdown;
}
