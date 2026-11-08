/**
 * Journaux sans secret (lot 02). Fichier à part : nestjs-pino garde un seul journal racine par processus,
 * et Vitest isole chaque fichier ; l'application de ce test est donc la seule à écrire dans le flux capturé.
 */
import { describe, expect, it } from 'vitest';
import { Client, newPhone, signedUp, startApp } from './http.js';

describe('journaux', () => {
	it('ne contiennent jamais de mot de passe, de code ni de jeton', async () => {
		const logged = await startApp();
		try {
			const password = 'secret-tres-reconnaissable-42';
			const { client, phone } = await signedUp(logged, newPhone(), password);
			const code = logged.sms.lastCode(phone)!;
			await new Client(logged.url, '198.51.100.110').call('POST', '/auth/login', { phone, password: 'autre-secret-reconnaissable' });
			await client.call('POST', '/auth/refresh');
			await client.call('GET', '/sessions');
			const forgot = new Client(logged.url, '198.51.100.111');
			await forgot.call('POST', '/auth/password/forgot', { phone });
			const resetCode = logged.sms.lastCode(phone)!;
			await forgot.call('POST', '/auth/password/reset', { phone, code: resetCode, password: 'encore-un-secret-reconnaissable' });

			const all = logged.logs.join('');
			expect(all.length).toBeGreaterThan(0);
			for (const secret of [
				password,
				'autre-secret-reconnaissable',
				'encore-un-secret-reconnaissable',
				code,
				resetCode,
				client.accessToken!,
				client.cookie!.split('=')[1]!
			]) {
				expect(all).not.toContain(secret);
			}
		} finally {
			await logged.close();
		}
	});
});
