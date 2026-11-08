/**
 * Authentification (lot 02) : inscription, vérification du numéro, connexion, rafraîchissement avec rotation,
 * déconnexion, mot de passe oublié.
 *
 * Règles :
 * - aucune réponse ne révèle si un numéro existe (mêmes messages, même durée, mêmes limites) ;
 * - mot de passe en argon2id, jetons en SHA-256, codes en HMAC : rien en clair en base ni dans les journaux ;
 * - sessions et jetons ne se lisent que dans le contexte de leur personne (withUser, RLS par app.user_id) ;
 * - un jeton de rafraîchissement déjà utilisé et présenté de nouveau révoque toutes les sessions de la personne,
 *   sauf dans les 10 secondes qui suivent sa rotation (connexion lente, onglets) : simple refus.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AUTH_MESSAGES, type MeResponse, type OtpPurpose, type PlatformRole, type TokenResponse } from '@ziga/shared/auth';
import { newId } from '@ziga/shared/ids';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { AppError } from '../../common/app-error.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { otpCodes, refreshTokens, sessions, users } from '../../db/schema/identity.js';
import { SMS_SENDER, type SmsSender } from '../notifications/sms-sender.js';
import { deviceLabel } from './device-label.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './passwords.js';
import { counterKey, hashOtp, newOtpCode, newRefreshToken, refreshTokenUser, sameHash, sha256 } from './secrets.js';
import { ThrottleService } from './throttle.service.js';
import { TokenService } from './token.service.js';

type User = typeof users.$inferSelect;

export interface ClientInfo {
	ip: string;
	userAgent: string | undefined;
}

/** Résultat d'une ouverture de session : la réponse JSON et le jeton à poser en cookie. */
export interface IssuedSession {
	body: TokenResponse;
	refreshToken: string;
}

const MINUTE = 60_000;
const IP_FAILURE_WINDOW_MS = 15 * MINUTE;
const PHONE_FAILURE_WINDOW_MS = 60 * MINUTE;

export function toMe(user: User): MeResponse {
	return { id: user.id, name: user.name, phone: user.phone, platformRole: (user.platformRole as PlatformRole | null) ?? null };
}

@Injectable()
export class AuthService {
	private readonly otpSecret: string;

	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly database: DatabaseService,
		private readonly tokens: TokenService,
		private readonly throttle: ThrottleService,
		@Inject(SMS_SENDER) private readonly sms: SmsSender,
		private readonly logger: PinoLogger
	) {
		logger.setContext(AuthService.name);
		// Sans secret configuré (développement, tests) : secret éphémère ; les codes en cours expirent au redémarrage.
		this.otpSecret = config.AUTH_OTP_SECRET ?? randomBytes(32).toString('base64url');
	}

	private get db() {
		return this.database.db;
	}

	private refreshTtlMs(): number {
		return this.config.AUTH_REFRESH_TTL_DAYS * 24 * 60 * MINUTE;
	}

	// ---------------------------------------------------------------- limites

	private tooMany(retryAfterSeconds: number): AppError {
		return new AppError(
			'TOO_MANY_REQUESTS',
			AUTH_MESSAGES.tooManyRequests,
			429,
			{ retryAfter: retryAfterSeconds },
			{ 'Retry-After': String(retryAfterSeconds) }
		);
	}

	/** Plafond large par adresse IP, commun à toutes les routes d'authentification. */
	private async limitIp(ip: string): Promise<void> {
		const r = await this.throttle.hit(counterKey('ip', ip), this.config.RATE_LIMIT_PER_IP_PER_MINUTE, MINUTE);
		if (!r.allowed) throw this.tooMany(r.retryAfterSeconds);
	}

	/** Envoi de SMS : un par intervalle et N par heure pour un numéro, qu'il ait un compte ou non. */
	private async limitSms(phone: string): Promise<void> {
		const c = this.config;
		if (c.OTP_SEND_INTERVAL_SECONDS > 0) {
			const r = await this.throttle.hit(counterKey('sms-interval', phone), 1, c.OTP_SEND_INTERVAL_SECONDS * 1000);
			if (!r.allowed) throw this.tooMany(r.retryAfterSeconds);
		}
		const h = await this.throttle.hit(counterKey('sms-hour', phone), c.OTP_SEND_PER_PHONE_PER_HOUR, 60 * MINUTE);
		if (!h.allowed) throw this.tooMany(h.retryAfterSeconds);
	}

	// ---------------------------------------------------------------- codes SMS

	private async issueOtp(phone: string, purpose: OtpPurpose): Promise<void> {
		const code = newOtpCode();
		const now = new Date();
		await this.db.transaction(async (tx) => {
			// Un nouveau code remplace les précédents encore valables.
			await tx
				.update(otpCodes)
				.set({ consumedAt: now })
				.where(and(eq(otpCodes.phone, phone), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt)));
			await tx.insert(otpCodes).values({
				id: newId(),
				phone,
				purpose,
				codeHash: hashOtp(this.otpSecret, phone, code),
				expiresAt: new Date(now.getTime() + this.config.OTP_TTL_MINUTES * MINUTE)
			});
		});
		await this.sms.send(phone, AUTH_MESSAGES.codeSms(code));
	}

	/** Vérifie et consomme un code : 5 essais au plus, 10 minutes, usage unique. */
	private async consumeOtp(phone: string, purpose: OtpPurpose, code: string): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			const [otp] = await tx
				.select()
				.from(otpCodes)
				.where(and(eq(otpCodes.phone, phone), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt)))
				.orderBy(desc(otpCodes.createdAt))
				.limit(1)
				.for('update');
			if (!otp || otp.expiresAt.getTime() <= Date.now() || otp.attempts >= this.config.OTP_MAX_ATTEMPTS) return false;
			if (!sameHash(otp.codeHash, hashOtp(this.otpSecret, phone, code))) {
				await tx
					.update(otpCodes)
					.set({ attempts: sql`${otpCodes.attempts} + 1` })
					.where(eq(otpCodes.id, otp.id));
				return false;
			}
			await tx.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, otp.id));
			return true;
		});
	}

	// ---------------------------------------------------------------- sessions

	private async userByPhone(phone: string): Promise<User | undefined> {
		const [user] = await this.db.select().from(users).where(eq(users.phone, phone)).limit(1);
		return user;
	}

	private async insertToken(tx: Tx, userId: string, sessionId: string): Promise<string> {
		const token = newRefreshToken(userId);
		await tx.insert(refreshTokens).values({ id: newId(), userId, sessionId, tokenHash: sha256(token) });
		return token;
	}

	/** Ouvre une session (un appareil) pour une personne active. */
	private async openSession(user: User, client: ClientInfo): Promise<IssuedSession> {
		const sessionId = newId();
		const refreshToken = await this.database.withUser(user.id, async (tx) => {
			await tx.insert(sessions).values({
				id: sessionId,
				userId: user.id,
				deviceLabel: deviceLabel(client.userAgent),
				expiresAt: new Date(Date.now() + this.refreshTtlMs())
			});
			return this.insertToken(tx, user.id, sessionId);
		});
		return { body: await this.tokenBody(user, sessionId), refreshToken };
	}

	private async tokenBody(user: User, sessionId: string): Promise<TokenResponse> {
		const accessToken = await this.tokens.sign({ sub: user.id, sid: sessionId, prole: (user.platformRole as PlatformRole | null) ?? null });
		return { accessToken, expiresIn: this.tokens.ttlSeconds, user: toMe(user) };
	}

	/** Révoque toutes les sessions encore ouvertes d'une personne. */
	private async revokeAll(userId: string, reason: 'password_reset' | 'reuse_detected'): Promise<void> {
		await this.database.withUser(userId, (tx) =>
			tx
				.update(sessions)
				.set({ revokedAt: new Date(), revokedReason: reason })
				.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
		);
	}

	// ---------------------------------------------------------------- inscription

	/**
	 * Inscription. Même réponse dans tous les cas. Numéro déjà vérifié : un SMS l'invite à « Mot de passe oublié ».
	 * Numéro en attente de vérification : nom et mot de passe sont remplacés, un nouveau code part.
	 */
	async register(input: { phone: string; name: string; password: string }, client: ClientInfo): Promise<void> {
		await this.limitIp(client.ip);
		await this.limitSms(input.phone);
		const existing = await this.userByPhone(input.phone);
		const passwordHash = await hashPassword(input.password);
		if (existing?.status === 'active' || existing?.status === 'disabled') {
			await this.sms.send(input.phone, AUTH_MESSAGES.accountExistsSms);
			return;
		}
		if (existing) {
			await this.db
				.update(users)
				.set({ name: input.name, passwordHash, passwordChangedAt: new Date(), updatedAt: new Date() })
				.where(eq(users.id, existing.id));
		} else {
			await this.db
				.insert(users)
				.values({ id: newId(), phone: input.phone, name: input.name, passwordHash, status: 'pending' })
				.onConflictDoNothing({ target: users.phone });
		}
		await this.issueOtp(input.phone, 'verify_phone');
	}

	/** Vérification du numéro : la personne devient active et sa première session s'ouvre. */
	async verifyPhone(input: { phone: string; code: string }, client: ClientInfo): Promise<IssuedSession> {
		await this.limitIp(client.ip);
		const user = await this.userByPhone(input.phone);
		const ok = await this.consumeOtp(input.phone, 'verify_phone', input.code);
		if (!ok || !user || user.status !== 'pending') throw new AppError('INVALID_CODE', AUTH_MESSAGES.invalidCode, 400);
		const now = new Date();
		const [active] = await this.db
			.update(users)
			.set({ status: 'active', phoneVerifiedAt: now, updatedAt: now })
			.where(eq(users.id, user.id))
			.returning();
		return this.openSession(active!, client);
	}

	// ---------------------------------------------------------------- connexion

	async login(input: { phone: string; password: string }, client: ClientInfo): Promise<IssuedSession> {
		const phoneKey = counterKey('fail-phone', input.phone);
		const ipKey = counterKey('fail-ip', client.ip);
		await this.limitIp(client.ip);
		const r = await this.throttle.hit(counterKey('login', input.phone), this.config.RATE_LIMIT_LOGIN_PER_PHONE_PER_MINUTE, MINUTE);
		if (!r.allowed) throw this.tooMany(r.retryAfterSeconds);
		// Délai progressif après des échecs, par numéro et par adresse IP.
		const wait = Math.max(await this.throttle.waitFor(phoneKey), await this.throttle.waitFor(ipKey));
		if (wait > 0)
			throw new AppError('RETRY_LATER', AUTH_MESSAGES.retryLater(wait), 429, { retryAfter: wait }, { 'Retry-After': String(wait) });

		const user = await this.userByPhone(input.phone);
		const ok = await verifyPassword(user?.passwordHash ?? (await dummyPasswordHash()), input.password);
		if (!user || !ok || user.status === 'disabled') {
			await this.throttle.recordFailure(phoneKey, 0, PHONE_FAILURE_WINDOW_MS);
			await this.throttle.recordFailure(ipKey, this.config.AUTH_IP_FAILURE_ALLOWANCE, IP_FAILURE_WINDOW_MS);
			throw new AppError('INVALID_CREDENTIALS', AUTH_MESSAGES.invalidCredentials, 401);
		}
		await this.throttle.clear(phoneKey);
		if (user.status === 'pending') {
			// Le bon mot de passe prouve la possession du compte : on peut dire qu'il reste à vérifier le numéro.
			await this.limitSms(user.phone).then(
				() => this.issueOtp(user.phone, 'verify_phone'),
				() => undefined
			);
			throw new AppError('PHONE_NOT_VERIFIED', 'Vérifiez d’abord votre numéro avec le code reçu par SMS.', 403);
		}
		return this.openSession(user, client);
	}

	// ---------------------------------------------------------------- rafraîchissement

	/**
	 * Rotation : le jeton présenté est marqué utilisé et un nouveau est émis. Un jeton déjà utilisé :
	 * dans le délai de grâce, simple refus (409) ; au-delà, vol présumé et révocation de toutes les sessions.
	 */
	async refresh(token: string | undefined): Promise<IssuedSession> {
		const invalid = () => new AppError('SESSION_INVALID', 'Session expirée. Reconnectez-vous.', 401);
		const userId = token ? refreshTokenUser(token) : null;
		if (!token || !userId) throw invalid();
		const graceMs = this.config.AUTH_REFRESH_REUSE_GRACE_SECONDS * 1000;

		const outcome = await this.database.withUser(userId, async (tx) => {
			const [row] = await tx
				.select({ token: refreshTokens, session: sessions })
				.from(refreshTokens)
				.innerJoin(sessions, and(eq(sessions.id, refreshTokens.sessionId), eq(sessions.userId, refreshTokens.userId)))
				.where(eq(refreshTokens.tokenHash, sha256(token)))
				.limit(1);
			if (!row) return { kind: 'invalid' as const };
			const now = new Date();
			if (row.token.usedAt) {
				return now.getTime() - row.token.usedAt.getTime() <= graceMs ? { kind: 'conflict' as const } : { kind: 'reuse' as const };
			}
			if (row.session.revokedAt || row.session.expiresAt.getTime() <= now.getTime()) return { kind: 'invalid' as const };
			// Marque le jeton utilisé ; si une autre requête l'a fait entre-temps, c'est elle qui l'emporte.
			const marked = await tx
				.update(refreshTokens)
				.set({ usedAt: now })
				.where(and(eq(refreshTokens.id, row.token.id), isNull(refreshTokens.usedAt)))
				.returning({ id: refreshTokens.id });
			if (!marked.length) return { kind: 'conflict' as const };
			// 30 jours glissants à partir de ce rafraîchissement.
			await tx
				.update(sessions)
				.set({ lastUsedAt: now, expiresAt: new Date(now.getTime() + this.refreshTtlMs()) })
				.where(eq(sessions.id, row.session.id));
			return { kind: 'rotated' as const, sessionId: row.session.id, refreshToken: await this.insertToken(tx, userId, row.session.id) };
		});

		if (outcome.kind === 'conflict') throw new AppError('REFRESH_CONFLICT', 'Session déjà renouvelée. Réessayez.', 409);
		if (outcome.kind === 'reuse') {
			this.logger.warn({ userId }, 'Jeton de rafraîchissement réutilisé : toutes les sessions sont révoquées');
			await this.revokeAll(userId, 'reuse_detected');
			throw invalid();
		}
		if (outcome.kind === 'invalid') throw invalid();
		const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
		if (!user || user.status !== 'active') throw invalid();
		return { body: await this.tokenBody(user, outcome.sessionId), refreshToken: outcome.refreshToken };
	}

	/** Déconnexion de cet appareil : sa session est révoquée. Ne lève jamais. */
	async logout(token: string | undefined): Promise<void> {
		const userId = token ? refreshTokenUser(token) : null;
		if (!token || !userId) return;
		await this.database.withUser(userId, async (tx) => {
			const [row] = await tx
				.select({ sessionId: refreshTokens.sessionId })
				.from(refreshTokens)
				.where(eq(refreshTokens.tokenHash, sha256(token)))
				.limit(1);
			if (row) {
				await tx
					.update(sessions)
					.set({ revokedAt: new Date(), revokedReason: 'logout' })
					.where(and(eq(sessions.id, row.sessionId), isNull(sessions.revokedAt)));
			}
		});
	}

	// ---------------------------------------------------------------- mot de passe oublié

	/** Même réponse que le numéro existe ou non ; un code ne part que pour un compte actif. */
	async forgotPassword(input: { phone: string }, client: ClientInfo): Promise<void> {
		await this.limitIp(client.ip);
		await this.limitSms(input.phone);
		const user = await this.userByPhone(input.phone);
		if (user?.status === 'active') await this.issueOtp(input.phone, 'reset_password');
	}

	/** Nouveau mot de passe : toutes les sessions sont révoquées, puis une nouvelle s'ouvre sur cet appareil. */
	async resetPassword(input: { phone: string; code: string; password: string }, client: ClientInfo): Promise<IssuedSession> {
		await this.limitIp(client.ip);
		const user = await this.userByPhone(input.phone);
		const ok = await this.consumeOtp(input.phone, 'reset_password', input.code);
		if (!ok || !user || user.status !== 'active') throw new AppError('INVALID_CODE', AUTH_MESSAGES.invalidCode, 400);
		const now = new Date();
		const [updated] = await this.db
			.update(users)
			.set({ passwordHash: await hashPassword(input.password), passwordChangedAt: now, updatedAt: now })
			.where(eq(users.id, user.id))
			.returning();
		await this.revokeAll(user.id, 'password_reset');
		// Le code SMS prouve la possession du numéro : les délais d'échec de connexion sont remis à zéro.
		await this.throttle.clear(counterKey('fail-phone', input.phone));
		return this.openSession(updated!, client);
	}

	// ---------------------------------------------------------------- personne et appareils

	async me(userId: string): Promise<MeResponse> {
		const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
		if (!user || user.status !== 'active') throw new AppError('SESSION_INVALID', 'Session expirée. Reconnectez-vous.', 401);
		return toMe(user);
	}

	async listSessions(userId: string, currentSessionId: string) {
		const rows = await this.database.withUser(userId, (tx) =>
			tx
				.select()
				.from(sessions)
				.where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
				.orderBy(desc(sessions.lastUsedAt))
		);
		return rows.map((s) => ({
			id: s.id,
			deviceLabel: s.deviceLabel,
			createdAt: s.createdAt.toISOString(),
			lastUsedAt: s.lastUsedAt.toISOString(),
			current: s.id === currentSessionId
		}));
	}

	/** Déconnecte un appareil. Celui d'une autre personne est invisible (RLS) : 404. */
	async revokeSession(userId: string, sessionId: string): Promise<void> {
		const revoked = await this.database.withUser(userId, (tx) =>
			tx
				.update(sessions)
				.set({ revokedAt: new Date(), revokedReason: 'user' })
				.where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
				.returning({ id: sessions.id })
		);
		if (!revoked.length) throw new AppError('NOT_FOUND', 'Appareil introuvable.', 404);
	}
}
