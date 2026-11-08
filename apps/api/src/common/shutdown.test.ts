import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGracefulShutdown } from './shutdown.js';

const logger = { info: vi.fn(), error: vi.fn() };

describe('arrêt propre', () => {
	afterEach(() => {
		process.removeAllListeners('SIGTERM');
		process.removeAllListeners('SIGINT');
		vi.useRealTimers();
	});

	it('marque l’arrêt, attend la fin des traitements en cours, puis quitte avec le code 0', async () => {
		const order: string[] = [];
		let finish!: () => void;
		const app = { close: () => new Promise<void>((r) => (finish = () => (order.push('fermé'), r()))) };
		const exit = vi.fn((code: number) => order.push(`exit ${code}`));
		const shutdown = registerGracefulShutdown(app, { timeoutMs: 5_000, logger, exit, beforeClose: () => order.push('plus prêt') });
		const done = shutdown('SIGTERM');
		await Promise.resolve();
		expect(order).toEqual(['plus prêt']);
		finish();
		await done;
		expect(order).toEqual(['plus prêt', 'fermé', 'exit 0']);
	});

	it('ignore un second signal pendant l’arrêt', async () => {
		const close = vi.fn(async () => undefined);
		const shutdown = registerGracefulShutdown({ close }, { timeoutMs: 5_000, logger, exit: vi.fn() });
		await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('force l’arrêt avec le code 1 si le délai est dépassé', async () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		const shutdown = registerGracefulShutdown({ close: () => new Promise(() => undefined) }, { timeoutMs: 1_000, logger, exit });
		void shutdown('SIGTERM');
		await vi.advanceTimersByTimeAsync(1_000);
		expect(exit).toHaveBeenCalledWith(1);
	});
});
