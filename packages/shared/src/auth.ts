/**
 * Schémas d'authentification (lot 02), partagés par l'API et les formulaires (CLAUDE.md §6).
 */
import { z } from 'zod';
import { phoneSchema } from './phone.js';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export const passwordSchema = z
	.string()
	.min(PASSWORD_MIN, { error: `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.` })
	.max(PASSWORD_MAX, { error: `Le mot de passe doit contenir au plus ${PASSWORD_MAX} caractères.` });

export const personNameSchema = z
	.string()
	.trim()
	.min(2, { error: 'Indiquez votre nom.' })
	.max(80, { error: 'Nom trop long (80 caractères au plus).' });

export const otpCodeSchema = z.string().regex(/^\d{6}$/, { error: 'Le code contient 6 chiffres.' });

export const registerSchema = z.object({ phone: phoneSchema, name: personNameSchema, password: passwordSchema });
export const verifyPhoneSchema = z.object({ phone: phoneSchema, code: otpCodeSchema });
/** À la connexion, on ne révèle rien sur les règles du mot de passe : seulement qu'il est requis. */
export const loginSchema = z.object({ phone: phoneSchema, password: z.string().min(1).max(PASSWORD_MAX) });
export const forgotPasswordSchema = z.object({ phone: phoneSchema });
export const resetPasswordSchema = z.object({ phone: phoneSchema, code: otpCodeSchema, password: passwordSchema });

export type RegisterInput = z.input<typeof registerSchema>;
export type LoginInput = z.input<typeof loginSchema>;

export const PLATFORM_ROLES = ['super_admin', 'support', 'sales', 'finance'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const OTP_PURPOSES = ['verify_phone', 'reset_password', 'change_phone'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/** Messages identiques quel que soit le cas, pour ne jamais révéler si un numéro existe. */
export const AUTH_MESSAGES = {
	invalidCredentials: 'Numéro ou mot de passe incorrect.',
	codeSent: 'Si ce numéro peut recevoir un code, un SMS vient d’être envoyé.',
	invalidCode: 'Code incorrect ou expiré.',
	tooManyRequests: 'Trop de demandes. Réessayez dans un instant.',
	retryLater: (seconds: number) => `Trop d’essais. Réessayez dans ${seconds} seconde${seconds > 1 ? 's' : ''}.`,
	accountExistsSms: 'Un compte Ziga existe déjà pour ce numéro. Utilisez « Mot de passe oublié ».',
	codeSms: (code: string) => `Votre code Ziga : ${code}. Il est valable 10 minutes. Ne le communiquez à personne.`,
	/** Envoyé à l'ancien numéro après un changement de numéro (lot 03, « Mon compte »). */
	phoneChangedSms: (newPhone: string) =>
		`Le numéro de votre compte Ziga a été remplacé par ${newPhone}. Si vous n’êtes pas à l’origine de ce changement, contactez sans attendre l’assistance Ziga.`
} as const;

/** Vue publique d'une personne connectée (réponse de GET /me). */
export interface MeResponse {
	id: string;
	name: string;
	phone: string;
	platformRole: PlatformRole | null;
}

export interface SessionView {
	id: string;
	deviceLabel: string;
	createdAt: string;
	lastUsedAt: string;
	current: boolean;
}

export interface TokenResponse {
	accessToken: string;
	expiresIn: number;
	user: MeResponse;
}
