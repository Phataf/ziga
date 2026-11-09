/**
 * Authentification (lot 02) : inscription, vérification du numéro, connexion, rafraîchissement avec rotation,
 * déconnexion, mot de passe oublié.
 *
 * Règles :
 * - aucune réponse ne révèle si un numéro existe (mêmes messages, même durée, mêmes limites) ;
 * - mot de passe en argon2id, jetons en SHA-256, codes en HMAC : rien en clair en base ni dans les journaux ;
 * - sessions et jetons ne se lisent que dans le contexte de leur personne (withUser, RLS par app.user_id) ;
 * - un jeton de rafraîchissement déjà utilisé et présenté de nouveau révoque toutes les sessions de la personne,
 *   sauf réponse perdue dans les 10 secondes de la rotation (D28) : le dernier jeton, jamais servi, est remplacé.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AUTH_MESSAGES, type MeResponse, type OtpPurpose, type PlatformRole, type TokenResponse } from '@ziga/shared/auth';
import { newId } from '@ziga/shared/ids';
import { formatPhone } from '@ziga/shared/phone';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
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
import { AuditService } from '../audit/audit.service.js';

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
	/**
	 * Personnes prévenues d'un changement de nom, après validation (lot 05) : le module organizations recopie le nom
	 * affiché de ses membres. Le module identity ne dépend ainsi d'aucun autre module.
	 */
	private readonly nameListeners: ((userId: string, name: string) => Promise<void>)[] = [];

	constructor(
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly database: DatabaseService,
		private readonly tokens: TokenService,
		private readonly throttle: ThrottleService,
		@Inject(SMS_SENDER) private readonly sms: SmsSender,
		private readonly logger: PinoLogger,
		private readonly audit: AuditService
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

	// ---------------------------------------------------------------- journal

	/** Événement de plateforme (sans organisation), dans la transaction personnelle de la personne concernée. */
	private event(
		tx: Tx,
		user: { id: string; platformRole?: string | null },
		action: string,
		objectId: string | null,
		data: { before?: unknown; after?: unknown; system?: boolean } = {}
	): Promise<void> {
		return this.audit.record(tx, {
			actor: data.system ? { type: 'system' } : { type: 'user', userId: user.id, role: user.platformRole ?? null },
			subjectUserId: user.id,
			action,
			objectType: objectId ? 'session' : 'user',
			objectId: objectId ?? user.id,
			before: data.before,
			after: data.after
		});
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

	private async issueOtp(phone: string, purpose: OtpPurpose, userId?: string): Promise<void> {
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
				// Changement de numéro : le code est lié à la personne qui l'a demandé.
				userId: purpose === 'change_phone' ? userId : null,
				codeHash: hashOtp(this.otpSecret, phone, code),
				expiresAt: new Date(now.getTime() + this.config.OTP_TTL_MINUTES * MINUTE)
			});
		});
		await this.sms.send(phone, AUTH_MESSAGES.codeSms(code));
	}

	/** Vérifie et consomme un code : 5 essais au plus, 10 minutes, usage unique. */
	private async consumeOtp(phone: string, purpose: OtpPurpose, code: string, userId?: string): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			const [otp] = await tx
				.select()
				.from(otpCodes)
				.where(
					and(
						eq(otpCodes.phone, phone),
						eq(otpCodes.purpose, purpose),
						isNull(otpCodes.consumedAt),
						purpose === 'change_phone' ? eq(otpCodes.userId, userId ?? '00000000-0000-0000-0000-000000000000') : undefined
					)
				)
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

	/** Émet un jeton de rafraîchissement ; `parentId` est le jeton qu'il remplace (chaîne de la session, D28). */
	private async insertToken(tx: Tx, userId: string, sessionId: string, parentId: string | null = null): Promise<string> {
		const token = newRefreshToken(userId);
		await tx.insert(refreshTokens).values({ id: newId(), userId, sessionId, parentId, tokenHash: sha256(token) });
		return token;
	}

	/** Ouvre une session (un appareil) pour une personne active ; `before` s'exécute dans la même transaction. */
	private async openSession(
		user: User,
		client: ClientInfo,
		action: 'auth.login' | 'auth.account_created' | 'auth.password_reset',
		before?: (tx: Tx) => Promise<User>
	): Promise<IssuedSession> {
		const sessionId = newId();
		const device = deviceLabel(client.userAgent);
		let current = user;
		const refreshToken = await this.database.withUser(user.id, async (tx) => {
			if (before) current = await before(tx);
			await tx.insert(sessions).values({
				id: sessionId,
				userId: user.id,
				deviceLabel: device,
				expiresAt: new Date(Date.now() + this.refreshTtlMs())
			});
			const token = await this.insertToken(tx, user.id, sessionId);
			await this.event(tx, current, action, sessionId, { after: { device } });
			return token;
		});
		return { body: await this.tokenBody(current, sessionId), refreshToken };
	}

	private async tokenBody(user: User, sessionId: string): Promise<TokenResponse> {
		const accessToken = await this.tokens.sign({ sub: user.id, sid: sessionId, prole: (user.platformRole as PlatformRole | null) ?? null });
		return { accessToken, expiresIn: this.tokens.ttlSeconds, user: toMe(user) };
	}

	/** Révoque les sessions encore ouvertes d'une personne (sauf `keep`), dans la transaction donnée. */
	async revokeAllIn(
		tx: Tx,
		userId: string,
		reason: 'password_reset' | 'password_change' | 'reuse_detected',
		keep?: string
	): Promise<number> {
		const revoked = await tx
			.update(sessions)
			.set({ revokedAt: new Date(), revokedReason: reason })
			.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), keep ? sql`${sessions.id} <> ${keep}` : undefined))
			.returning({ id: sessions.id });
		return revoked.length;
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
		return this.openSession(user, client, 'auth.account_created', async (tx) => {
			const [active] = await tx
				.update(users)
				.set({ status: 'active', phoneVerifiedAt: now, updatedAt: now })
				.where(eq(users.id, user.id))
				.returning();
			return active!;
		});
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
		return this.openSession(user, client, 'auth.login');
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
			const sessionActive = !row.session.revokedAt && row.session.expiresAt.getTime() > now.getTime();
			if (row.token.usedAt) {
				/*
				 * Jeton déjà utilisé. Réponse perdue (le navigateur n'a pas reçu le nouveau cookie) si, et seulement si :
				 * il est le prédécesseur direct du dernier jeton émis pour cette session, ce dernier n'a jamais servi,
				 * la rotation date de moins de 10 s et la session est active. Alors le dernier jeton est invalidé et un
				 * nouveau est émis. Dans tous les autres cas : vol présumé.
				 */
				const [latest] = await tx
					.select()
					.from(refreshTokens)
					.where(eq(refreshTokens.sessionId, row.token.sessionId))
					.orderBy(desc(refreshTokens.issuedAt), desc(refreshTokens.id))
					.limit(1)
					.for('update');
				const lostResponse =
					sessionActive &&
					!!latest &&
					latest.parentId === row.token.id &&
					!latest.usedAt &&
					now.getTime() - latest.issuedAt.getTime() <= graceMs;
				if (!lostResponse) return { kind: 'reuse' as const };
				const invalidated = await tx
					.update(refreshTokens)
					.set({ usedAt: now })
					.where(and(eq(refreshTokens.id, latest.id), isNull(refreshTokens.usedAt)))
					.returning({ id: refreshTokens.id });
				if (!invalidated.length) return { kind: 'reuse' as const };
				const refreshToken = await this.insertToken(tx, userId, row.session.id, row.token.id);
				await this.event(tx, { id: userId }, 'auth.refresh_grace_reissue', row.session.id, {
					system: true,
					after: { reason: 'lost_response' }
				});
				return { kind: 'rotated' as const, sessionId: row.session.id, refreshToken };
			}
			if (!sessionActive) return { kind: 'invalid' as const };
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
			return {
				kind: 'rotated' as const,
				sessionId: row.session.id,
				refreshToken: await this.insertToken(tx, userId, row.session.id, row.token.id)
			};
		});

		// Deux requêtes simultanées avec le même jeton : la seconde est refusée, le client réessaie une fois.
		if (outcome.kind === 'conflict') throw new AppError('REFRESH_CONFLICT', 'Session déjà renouvelée. Réessayez.', 409);
		if (outcome.kind === 'reuse') {
			this.logger.warn({ userId }, 'Jeton de rafraîchissement réutilisé : toutes les sessions sont révoquées');
			await this.database.withUser(userId, async (tx) => {
				const count = await this.revokeAllIn(tx, userId, 'reuse_detected');
				await this.event(tx, { id: userId }, 'auth.refresh_reuse_detected', null, { system: true, after: { revokedSessions: count } });
			});
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
				const revoked = await tx
					.update(sessions)
					.set({ revokedAt: new Date(), revokedReason: 'logout' })
					.where(and(eq(sessions.id, row.sessionId), isNull(sessions.revokedAt)))
					.returning({ id: sessions.id });
				if (revoked.length) await this.event(tx, { id: userId }, 'auth.logout', row.sessionId);
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
		const passwordHash = await hashPassword(input.password);
		// Le code SMS prouve la possession du numéro : les délais d'échec de connexion sont remis à zéro.
		await this.throttle.clear(counterKey('fail-phone', input.phone));
		// Nouveau mot de passe, révocation de toutes les sessions, nouvelle session et journal : une seule transaction.
		return this.openSession(user, client, 'auth.password_reset', async (tx) => {
			const [updated] = await tx
				.update(users)
				.set({ passwordHash, passwordChangedAt: now, updatedAt: now })
				.where(eq(users.id, user.id))
				.returning();
			await this.revokeAllIn(tx, user.id, 'password_reset');
			return updated!;
		});
	}

	// ---------------------------------------------------------------- Mon compte (lot 03)

	private async activeUser(userId: string): Promise<User> {
		const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
		if (!user || user.status !== 'active') throw new AppError('SESSION_INVALID', 'Session expirée. Reconnectez-vous.', 401);
		return user;
	}

	/** Vérifie le mot de passe actuel, avec le même délai progressif qu'à la connexion. */
	private async checkPassword(user: User, password: string, client: ClientInfo): Promise<void> {
		const key = counterKey('fail-phone', user.phone);
		await this.limitIp(client.ip);
		const wait = await this.throttle.waitFor(key);
		if (wait > 0)
			throw new AppError('RETRY_LATER', AUTH_MESSAGES.retryLater(wait), 429, { retryAfter: wait }, { 'Retry-After': String(wait) });
		if (!(await verifyPassword(user.passwordHash, password))) {
			await this.throttle.recordFailure(key, 0, PHONE_FAILURE_WINDOW_MS);
			throw new AppError('WRONG_PASSWORD', 'Mot de passe incorrect.', 403);
		}
		await this.throttle.clear(key);
	}

	onNameChange(listener: (userId: string, name: string) => Promise<void>): void {
		this.nameListeners.push(listener);
	}

	async updateName(userId: string, name: string): Promise<MeResponse> {
		const user = await this.activeUser(userId);
		if (user.name === name) return toMe(user);
		const updated = await this.database.withUser(userId, async (tx) => {
			const [row] = await tx.update(users).set({ name, updatedAt: new Date() }).where(eq(users.id, userId)).returning();
			await this.event(tx, user, 'auth.profile_update', null, { before: { name: user.name }, after: { name } });
			return row!;
		});
		for (const listener of this.nameListeners) await listener(userId, name);
		return toMe(updated);
	}

	/** Nouveau mot de passe : l'ancien est exigé ; les autres appareils sont déconnectés, celui-ci reste connecté. */
	async changePassword(
		userId: string,
		sessionId: string,
		input: { currentPassword: string; newPassword: string },
		client: ClientInfo
	): Promise<void> {
		const user = await this.activeUser(userId);
		await this.checkPassword(user, input.currentPassword, client);
		const passwordHash = await hashPassword(input.newPassword);
		await this.database.withUser(userId, async (tx) => {
			const now = new Date();
			await tx.update(users).set({ passwordHash, passwordChangedAt: now, updatedAt: now }).where(eq(users.id, userId));
			const count = await this.revokeAllIn(tx, userId, 'password_change', sessionId);
			await this.event(tx, user, 'auth.password_change', null, { after: { otherSessionsRevoked: count } });
		});
	}

	/**
	 * Changement de numéro, étape 1 : mot de passe exigé, code envoyé au nouveau numéro. Même réponse si le numéro
	 * appartient déjà à un compte (son titulaire reçoit alors le SMS « Un compte Ziga existe déjà », sans code).
	 */
	async requestPhoneChange(userId: string, input: { phone: string; password: string }, client: ClientInfo): Promise<void> {
		const user = await this.activeUser(userId);
		await this.checkPassword(user, input.password, client);
		if (input.phone === user.phone) throw new AppError('SAME_PHONE', 'C’est déjà le numéro de votre compte.', 400);
		await this.limitSms(input.phone);
		const owner = await this.userByPhone(input.phone);
		if (owner) {
			await this.sms.send(input.phone, AUTH_MESSAGES.accountExistsSms);
			return;
		}
		await this.issueOtp(input.phone, 'change_phone', userId);
	}

	/** Étape 2 : le code reçu au nouveau numéro le confirme ; l'ancien numéro est prévenu par SMS. */
	async confirmPhoneChange(userId: string, input: { phone: string; code: string }, client: ClientInfo): Promise<MeResponse> {
		await this.limitIp(client.ip);
		const user = await this.activeUser(userId);
		if (!(await this.consumeOtp(input.phone, 'change_phone', input.code, userId))) {
			throw new AppError('INVALID_CODE', AUTH_MESSAGES.invalidCode, 400);
		}
		const updated = await this.database
			.withUser(userId, async (tx) => {
				const now = new Date();
				const [row] = await tx
					.update(users)
					.set({ phone: input.phone, phoneVerifiedAt: now, updatedAt: now })
					.where(eq(users.id, userId))
					.returning();
				await this.event(tx, user, 'auth.phone_change', null, { before: { phone: user.phone }, after: { phone: input.phone } });
				return row!;
			})
			.catch((error: unknown) => {
				// Numéro pris entre-temps par une inscription : même réponse qu'un code invalide.
				if ((error as { cause?: { code?: string } }).cause?.code === '23505')
					throw new AppError('INVALID_CODE', AUTH_MESSAGES.invalidCode, 400);
				throw error;
			});
		await this.sms.send(user.phone, AUTH_MESSAGES.phoneChangedSms(formatPhone(input.phone)));
		return toMe(updated);
	}

	// ---------------------------------------------------------------- back-office (transaction app_admin fournie)

	/** Recherche par nom ou par numéro : colonnes du compte seulement (jamais le mot de passe). */
	async searchPeople(tx: Tx, q: string) {
		const term = q.trim();
		const digits = term.replace(/\D/g, '');
		const columns = {
			id: users.id,
			name: users.name,
			phone: users.phone,
			status: users.status,
			platformRole: users.platformRole,
			createdAt: users.createdAt
		};
		const rows = await tx
			.select(columns)
			.from(users)
			.where(
				term
					? sql`${users.name} ilike ${'%' + term + '%'} or (${digits.length >= 4} and ${users.phone} like ${'%' + digits + '%'})`
					: undefined
			)
			.orderBy(desc(users.createdAt))
			.limit(50);
		return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
	}

	async person(tx: Tx, id: string) {
		const [row] = await tx
			.select({
				id: users.id,
				name: users.name,
				phone: users.phone,
				status: users.status,
				platformRole: users.platformRole,
				createdAt: users.createdAt
			})
			.from(users)
			.where(eq(users.id, id))
			.limit(1);
		if (!row) throw new AppError('NOT_FOUND', 'Personne introuvable.', 404);
		return { ...row, createdAt: row.createdAt.toISOString() };
	}

	async namesOf(tx: Tx, ids: string[]): Promise<Map<string, string>> {
		const unique = [...new Set(ids.filter(Boolean))];
		if (!unique.length) return new Map();
		const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
		return new Map(rows.map((r) => [r.id, r.name]));
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
		await this.database.withUser(userId, async (tx) => {
			const revoked = await tx
				.update(sessions)
				.set({ revokedAt: new Date(), revokedReason: 'user' })
				.where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
				.returning({ id: sessions.id, deviceLabel: sessions.deviceLabel });
			if (!revoked.length) throw new AppError('NOT_FOUND', 'Appareil introuvable.', 404);
			await this.event(tx, { id: userId }, 'auth.session_revoked', sessionId, { after: { device: revoked[0]!.deviceLabel } });
		});
	}
}
