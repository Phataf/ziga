import { describe, expect, it } from 'vitest';
import { AUTH_MESSAGES, loginSchema, registerSchema, resetPasswordSchema, verifyPhoneSchema } from './auth.js';

describe('schémas d’authentification', () => {
	it('normalise le téléphone et nettoie le nom à l’inscription', () => {
		expect(registerSchema.parse({ phone: '70 12 34 56', name: '  Awa Ouédraogo ', password: 'motdepasse' })).toEqual({
			phone: '+22670123456',
			name: 'Awa Ouédraogo',
			password: 'motdepasse'
		});
	});

	it('exige 8 caractères au moins pour un nouveau mot de passe', () => {
		const r = registerSchema.safeParse({ phone: '70123456', name: 'Awa', password: 'court' });
		expect(r.error?.issues[0]?.message).toBe('Le mot de passe doit contenir au moins 8 caractères.');
		expect(resetPasswordSchema.safeParse({ phone: '70123456', code: '123456', password: 'court' }).success).toBe(false);
	});

	it('n’impose pas les règles du mot de passe à la connexion (rien à révéler)', () => {
		expect(loginSchema.safeParse({ phone: '70123456', password: 'x' }).success).toBe(true);
	});

	it('n’accepte qu’un code à 6 chiffres', () => {
		expect(verifyPhoneSchema.safeParse({ phone: '70123456', code: '12345' }).success).toBe(false);
		expect(verifyPhoneSchema.safeParse({ phone: '70123456', code: '12a456' }).success).toBe(false);
		expect(verifyPhoneSchema.safeParse({ phone: '70123456', code: '123456' }).success).toBe(true);
	});

	it('le SMS pour un numéro déjà inscrit renvoie vers « Mot de passe oublié »', () => {
		expect(AUTH_MESSAGES.accountExistsSms).toBe('Un compte Ziga existe déjà pour ce numéro. Utilisez « Mot de passe oublié ».');
	});
});
