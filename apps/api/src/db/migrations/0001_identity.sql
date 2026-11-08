-- Lot 02 — identité : personnes, sessions, jetons de rafraîchissement, codes à usage unique.
-- Tables de la plateforme (pas d'organisation) : une personne existe hors de toute organisation (D13).
-- Aucune donnée sensible en clair : mot de passe en argon2id, jetons en SHA-256, codes en HMAC-SHA256.

CREATE TABLE users (
	id uuid PRIMARY KEY,
	phone text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
	name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
	password_hash text NOT NULL,
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
	phone_verified_at timestamptz,
	platform_role text CHECK (platform_role IN ('super_admin', 'support', 'sales', 'finance')),
	password_changed_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Une session = un appareil connecté.
CREATE TABLE sessions (
	id uuid PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	device_label text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_used_at timestamptz NOT NULL DEFAULT now(),
	-- 30 jours glissants : repoussée à chaque rafraîchissement.
	expires_at timestamptz NOT NULL,
	revoked_at timestamptz,
	revoked_reason text CHECK (revoked_reason IN ('logout', 'user', 'password_reset', 'reuse_detected')),
	UNIQUE (id, user_id)
);
--> statement-breakpoint
CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
-- Chaque jeton de rafraîchissement émis, en ajout seul : un jeton déjà utilisé et présenté à nouveau
-- révèle un vol (toutes les sessions de la personne sont alors révoquées).
CREATE TABLE refresh_tokens (
	id uuid PRIMARY KEY,
	user_id uuid NOT NULL,
	session_id uuid NOT NULL,
	token_hash bytea NOT NULL UNIQUE,
	issued_at timestamptz NOT NULL DEFAULT now(),
	used_at timestamptz,
	-- Clé composite : un jeton ne peut pas pointer vers la session d'une autre personne.
	FOREIGN KEY (session_id, user_id) REFERENCES sessions (id, user_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX refresh_tokens_session ON refresh_tokens (session_id);
--> statement-breakpoint
CREATE TABLE otp_codes (
	id uuid PRIMARY KEY,
	phone text NOT NULL,
	purpose text NOT NULL CHECK (purpose IN ('verify_phone', 'reset_password')),
	code_hash bytea NOT NULL,
	expires_at timestamptz NOT NULL,
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	consumed_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX otp_codes_active ON otp_codes (phone, purpose, created_at DESC) WHERE consumed_at IS NULL;
--> statement-breakpoint
-- Personne de la transaction en cours, fixée par withUser() avec SET LOCAL app.user_id.
CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
	LANGUAGE sql
	STABLE
	PARALLEL SAFE
AS $$
	SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION current_user_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION current_user_id() TO app_api, app_admin;
--> statement-breakpoint
-- Règle d'accès en base, en plus du contrôle de l'API : une personne ne voit et ne modifie que ses sessions
-- et ses jetons. Hors d'une transaction withUser(), aucune ligne n'est visible.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sessions_owner ON sessions USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());
--> statement-breakpoint
CREATE POLICY refresh_tokens_owner ON refresh_tokens USING (user_id = current_user_id()) WITH CHECK (user_id = current_user_id());
--> statement-breakpoint
-- Les jetons émis ne se modifient que pour noter leur usage, et ne se suppriment jamais (sauf avec la session).
REVOKE UPDATE, DELETE ON refresh_tokens FROM app_api, app_admin;
--> statement-breakpoint
GRANT UPDATE (used_at) ON refresh_tokens TO app_api;
