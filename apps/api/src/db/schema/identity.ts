/**
 * Schéma Drizzle du module identity (lot 02). La migration SQL (0001_identity) fait foi : contraintes,
 * clé composite et règles d'accès (RLS) par `app.user_id` n'y sont décrites que pour les requêtes typées.
 */
import { customType, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
	id: uuid('id').primaryKey(),
	phone: text('phone').notNull().unique(),
	name: text('name').notNull(),
	passwordHash: text('password_hash').notNull(),
	status: text('status', { enum: ['pending', 'active', 'disabled'] }).notNull(),
	phoneVerifiedAt: tstz('phone_verified_at'),
	platformRole: text('platform_role', { enum: ['super_admin', 'support', 'sales', 'finance'] }),
	passwordChangedAt: tstz('password_changed_at').notNull().defaultNow(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

export const sessions = pgTable('sessions', {
	id: uuid('id').primaryKey(),
	userId: uuid('user_id').notNull(),
	deviceLabel: text('device_label').notNull(),
	createdAt: tstz('created_at').notNull().defaultNow(),
	lastUsedAt: tstz('last_used_at').notNull().defaultNow(),
	expiresAt: tstz('expires_at').notNull(),
	revokedAt: tstz('revoked_at'),
	revokedReason: text('revoked_reason', { enum: ['logout', 'user', 'password_reset', 'reuse_detected'] })
});

export const refreshTokens = pgTable('refresh_tokens', {
	id: uuid('id').primaryKey(),
	userId: uuid('user_id').notNull(),
	sessionId: uuid('session_id').notNull(),
	tokenHash: bytea('token_hash').notNull().unique(),
	issuedAt: tstz('issued_at').notNull().defaultNow(),
	usedAt: tstz('used_at')
});

export const otpCodes = pgTable('otp_codes', {
	id: uuid('id').primaryKey(),
	phone: text('phone').notNull(),
	purpose: text('purpose', { enum: ['verify_phone', 'reset_password'] }).notNull(),
	codeHash: bytea('code_hash').notNull(),
	expiresAt: tstz('expires_at').notNull(),
	attempts: integer('attempts').notNull().default(0),
	consumedAt: tstz('consumed_at'),
	createdAt: tstz('created_at').notNull().defaultNow()
});
