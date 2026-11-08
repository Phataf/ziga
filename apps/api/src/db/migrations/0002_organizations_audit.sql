-- Lot 03 — organisations (D12), membres, invitations, logos (D29) et journal d'audit en ajout seul.
-- Règle de contexte : une transaction est soit « organisation » (app.organization_id), soit « personnelle »
-- (app.user_id), jamais les deux. Les politiques personnelles l'exigent aussi (current_organization_id() IS NULL).

-- Gabarit de cloisonnement réutilisable (docs : src/db/README.md). Chaque table métier future l'appelle :
--   SELECT enable_organization_rls('ma_table');
-- RLS activée et forcée (même pour le propriétaire de la table), lecture et écriture limitées à l'organisation
-- de la transaction. Sans app.organization_id, aucune ligne n'est visible ni insérable.
CREATE OR REPLACE FUNCTION enable_organization_rls(target regclass) RETURNS void
	LANGUAGE plpgsql
AS $$
BEGIN
	EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
	EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
	EXECUTE format(
		'CREATE POLICY organization_isolation ON %s USING (organization_id = current_organization_id()) '
			|| 'WITH CHECK (organization_id = current_organization_id())',
		target
	);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enable_organization_rls(regclass) FROM PUBLIC;
--> statement-breakpoint

-- Organisations : une agence ou un bailleur particulier (D12). Sa propre clé fait office d'organization_id.
CREATE TABLE organizations (
	id uuid PRIMARY KEY,
	type text NOT NULL CHECK (type IN ('agency', 'landlord')),
	legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 2 AND 120),
	trade_name text CHECK (char_length(trade_name) <= 120),
	phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
	address text CHECK (char_length(address) <= 200),
	commune text NOT NULL CHECK (char_length(commune) BETWEEN 2 AND 80),
	po_box text CHECK (char_length(po_box) <= 60),
	rccm text CHECK (char_length(rccm) <= 40),
	ifu text CHECK (char_length(ifu) <= 20),
	-- Représentant légal (D24) : alimentera les contrats du lot 08 bis.
	rep_name text CHECK (char_length(rep_name) <= 120),
	rep_title text CHECK (char_length(rep_title) <= 80),
	rep_profession text CHECK (char_length(rep_profession) <= 80),
	rep_address text CHECK (char_length(rep_address) <= 200),
	rep_nationality text CHECK (char_length(rep_nationality) <= 60),
	rep_id_type text CHECK (rep_id_type IN ('cnib', 'passport', 'consular_card', 'residence_card', 'other')),
	rep_id_type_other text CHECK (char_length(rep_id_type_other) <= 60),
	rep_id_number text CHECK (char_length(rep_id_number) <= 40),
	rep_id_issued_on date,
	rep_id_issued_by text CHECK (char_length(rep_id_issued_by) <= 120),
	verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'suspended')),
	-- Formule : la table des formules arrive au lot 04.
	plan_id uuid,
	-- Logo en cours (versions gardées dans organization_logos, D29) ; clé composite ajoutée plus bas.
	logo_id uuid,
	created_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CHECK (rep_id_type = 'other' OR rep_id_type_other IS NULL),
	-- Une agence n'est vérifiée qu'avec son RCCM et son IFU ; facultatifs pour un bailleur.
	CHECK (type <> 'agency' OR verification_status <> 'verified' OR (rccm IS NOT NULL AND ifu IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Contexte d'organisation : sa propre fiche seulement. La création se fait dans le contexte de la nouvelle
-- organisation (id = current_organization_id()), sans aucune exception au cloisonnement.
CREATE POLICY organization_isolation ON organizations
	USING (id = current_organization_id())
	WITH CHECK (id = current_organization_id());
--> statement-breakpoint
-- Une organisation n'est jamais supprimée (son historique reste consultable).
REVOKE DELETE, TRUNCATE ON organizations FROM app_api, app_admin;
--> statement-breakpoint

-- Membres : une personne peut appartenir à plusieurs organisations, une seule ligne par couple.
CREATE TABLE organization_members (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	user_id uuid NOT NULL REFERENCES users (id),
	role text NOT NULL CHECK (role IN ('director', 'manager', 'field_agent', 'viewer')),
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
	invited_by uuid REFERENCES users (id),
	joined_at timestamptz NOT NULL DEFAULT now(),
	removed_at timestamptz,
	removed_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, user_id),
	UNIQUE (organization_id, id),
	CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX organization_members_user ON organization_members (user_id) WHERE status = 'active';
--> statement-breakpoint
SELECT enable_organization_rls('organization_members');
--> statement-breakpoint
-- Contexte personnel : une personne voit ses propres appartenances (choix de l'espace), jamais celles des autres.
CREATE POLICY own_memberships ON organization_members
	FOR SELECT TO app_api
	USING (current_organization_id() IS NULL AND user_id = current_user_id());
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON organization_members FROM app_api, app_admin;
--> statement-breakpoint
-- Contexte personnel : une personne voit les organisations dont elle est membre active (nom, type).
CREATE POLICY own_organizations ON organizations
	FOR SELECT TO app_api
	USING (
		current_organization_id() IS NULL
		AND EXISTS (
			SELECT 1 FROM organization_members m
			WHERE m.organization_id = organizations.id AND m.user_id = current_user_id() AND m.status = 'active'
		)
	);
--> statement-breakpoint

-- Règles des membres, vérifiées par la base en plus de l'API :
-- - une organisation « landlord » a un seul membre actif, directeur (D12, MVP) ;
-- - le dernier directeur actif ne peut être ni retiré ni rétrogradé.
-- Le verrou sur la fiche de l'organisation sérialise les changements concurrents de son équipe.
CREATE OR REPLACE FUNCTION organization_members_rules() RETURNS trigger
	LANGUAGE plpgsql
AS $$
DECLARE
	org_type text;
BEGIN
	SELECT type INTO org_type FROM organizations WHERE id = NEW.organization_id FOR UPDATE;
	IF NEW.status = 'active' AND org_type = 'landlord' THEN
		IF NEW.role <> 'director' OR EXISTS (
			SELECT 1 FROM organization_members
			WHERE organization_id = NEW.organization_id AND status = 'active' AND id <> NEW.id
		) THEN
			RAISE EXCEPTION 'LANDLORD_SINGLE_MEMBER' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND OLD.role = 'director'
		AND (NEW.status <> 'active' OR NEW.role <> 'director') THEN
		IF NOT EXISTS (
			SELECT 1 FROM organization_members
			WHERE organization_id = NEW.organization_id AND status = 'active' AND role = 'director' AND id <> NEW.id
		) THEN
			RAISE EXCEPTION 'LAST_DIRECTOR' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF TG_OP = 'UPDATE' AND (NEW.organization_id <> OLD.organization_id OR NEW.user_id <> OLD.user_id) THEN
		RAISE EXCEPTION 'MEMBER_IMMUTABLE' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_members_rules BEFORE INSERT OR UPDATE ON organization_members
	FOR EACH ROW EXECUTE FUNCTION organization_members_rules();
--> statement-breakpoint

-- Invitations : par téléphone, lien à envoyer par WhatsApp. Le lien porte « <organization_id>.<secret> » ;
-- seule l'empreinte SHA-256 du secret est gardée. Valables 7 jours, usage unique.
CREATE TABLE organization_invitations (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
	role text NOT NULL CHECK (role IN ('director', 'manager', 'field_agent', 'viewer')),
	token_hash bytea NOT NULL UNIQUE,
	invited_by uuid NOT NULL REFERENCES users (id),
	expires_at timestamptz NOT NULL,
	accepted_at timestamptz,
	accepted_by uuid REFERENCES users (id),
	revoked_at timestamptz,
	revoked_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
--> statement-breakpoint
CREATE INDEX organization_invitations_pending ON organization_invitations (organization_id, created_at DESC)
	WHERE accepted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint
SELECT enable_organization_rls('organization_invitations');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON organization_invitations FROM app_api, app_admin;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION organization_invitations_rules() RETURNS trigger
	LANGUAGE plpgsql
AS $$
BEGIN
	IF (SELECT type FROM organizations WHERE id = NEW.organization_id) = 'landlord' THEN
		RAISE EXCEPTION 'LANDLORD_SINGLE_MEMBER' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_invitations_rules BEFORE INSERT ON organization_invitations
	FOR EACH ROW EXECUTE FUNCTION organization_invitations_rules();
--> statement-breakpoint

-- Logos (D29) : chaque envoi est une nouvelle version, jamais écrasée ; un document émis garde la sienne.
-- Fichiers : logos/<organization_id>/<id>/original (privé), web.webp et print.png (publics).
CREATE TABLE organization_logos (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	original_key text NOT NULL,
	original_mime text NOT NULL CHECK (original_mime IN ('image/png', 'image/jpeg', 'image/webp')),
	original_bytes integer NOT NULL CHECK (original_bytes BETWEEN 1 AND 2097152),
	status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
	web_key text,
	print_key text,
	width integer,
	height integer,
	error text,
	created_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	processed_at timestamptz,
	UNIQUE (organization_id, id),
	CHECK (status <> 'ready' OR (web_key IS NOT NULL AND print_key IS NOT NULL))
);
--> statement-breakpoint
SELECT enable_organization_rls('organization_logos');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON organization_logos FROM app_api, app_admin;
--> statement-breakpoint
-- Seul le traitement (tâche de fond) complète une version ; le fichier d'origine ne change jamais.
GRANT UPDATE (status, web_key, print_key, width, height, error, processed_at) ON organization_logos TO app_api;
--> statement-breakpoint
-- Clé composite : une organisation ne peut pas prendre le logo d'une autre.
ALTER TABLE organizations
	ADD CONSTRAINT organizations_logo_fk FOREIGN KEY (id, logo_id) REFERENCES organization_logos (organization_id, id);
--> statement-breakpoint

-- Journal d'audit en ajout seul (CLAUDE.md règle 4). Deux portées, séparées par la base :
-- - événements d'une organisation (organization_id renseigné) : visibles seulement dans son contexte ;
-- - événements de plateforme (organization_id vide : connexion, mot de passe, numéro…) : visibles seulement
--   par la personne concernée (subject_user_id), en contexte personnel, et par le back-office.
CREATE TABLE audit_log (
	id uuid PRIMARY KEY,
	occurred_at timestamptz NOT NULL DEFAULT now(),
	actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
	actor_user_id uuid REFERENCES users (id),
	actor_role text,
	organization_id uuid REFERENCES organizations (id),
	subject_user_id uuid REFERENCES users (id),
	action text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
	object_type text NOT NULL,
	object_id uuid,
	before jsonb,
	after jsonb,
	origin text NOT NULL CHECK (origin IN ('app', 'api', 'admin', 'sync', 'job')),
	ip inet,
	request_id text CHECK (char_length(request_id) <= 128),
	CHECK (organization_id IS NOT NULL OR subject_user_id IS NOT NULL),
	CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL))
);
--> statement-breakpoint
-- Identifiants UUIDv7 : leur ordre suit le temps, la pagination se fait par identifiant.
CREATE INDEX audit_log_organization ON audit_log (organization_id, id DESC) WHERE organization_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX audit_log_subject ON audit_log (subject_user_id, id DESC) WHERE organization_id IS NULL;
--> statement-breakpoint
SELECT enable_organization_rls('audit_log');
--> statement-breakpoint
CREATE POLICY own_platform_events ON audit_log
	TO app_api
	USING (organization_id IS NULL AND current_organization_id() IS NULL AND subject_user_id = current_user_id())
	WITH CHECK (organization_id IS NULL AND current_organization_id() IS NULL AND subject_user_id = current_user_id());
--> statement-breakpoint
-- Back-office : les événements de plateforme ; ceux d'une organisation seulement dans son contexte, ouvert
-- par un accès d'assistance motivé et journalisé (lot 04).
CREATE POLICY platform_events_admin ON audit_log
	TO app_admin
	USING (organization_id IS NULL)
	WITH CHECK (organization_id IS NULL);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_api, app_admin;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
	LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'AUDIT_APPEND_ONLY: le journal d''audit est en ajout seul (% refusé)', TG_OP USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
	FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
	FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint

-- Lot 03, « Mon compte » : changement de numéro par code SMS envoyé au nouveau numéro, lié à la personne.
ALTER TABLE otp_codes ADD COLUMN user_id uuid REFERENCES users (id);
--> statement-breakpoint
ALTER TABLE otp_codes DROP CONSTRAINT otp_codes_purpose_check;
--> statement-breakpoint
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_purpose_check
	CHECK (purpose IN ('verify_phone', 'reset_password', 'change_phone'));
--> statement-breakpoint
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_change_phone_user CHECK ((purpose = 'change_phone') = (user_id IS NOT NULL));
--> statement-breakpoint
-- Changement de mot de passe depuis « Mon compte » : les autres appareils sont déconnectés.
ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
--> statement-breakpoint
ALTER TABLE sessions ADD CONSTRAINT sessions_revoked_reason_check
	CHECK (revoked_reason IN ('logout', 'user', 'password_reset', 'password_change', 'reuse_detected'));
