-- Lot 04 — interrupteurs de fonctionnalités (docs/FEATURE-FLAGS.md), formules, abonnements saisis à la main,
-- moyens de paiement acceptés (D18), accès d'assistance motivé, et droits du rôle app_admin (back-office).
-- Les tables d'interrupteurs ne sont pas sous RLS d'organisation (§5) : app_api les lit, seul app_admin les modifie.

-- ---------------------------------------------------------------- formules
CREATE TABLE plans (
	id text PRIMARY KEY CHECK (id IN ('discovery', 'essential', 'pro', 'custom')),
	label text NOT NULL,
	-- Prix du cadrage, hypothèses modifiables par le rôle sales (FCFA entiers ; NULL = fixé à chaque abonnement).
	monthly_price bigint CHECK (monthly_price >= 0),
	yearly_price bigint CHECK (yearly_price >= 0),
	-- Quotas ; NULL = sans limite.
	max_units integer CHECK (max_units > 0),
	max_users integer CHECK (max_users > 0),
	updated_at timestamptz NOT NULL DEFAULT now(),
	updated_by uuid REFERENCES users (id)
);
--> statement-breakpoint
INSERT INTO plans (id, label, monthly_price, yearly_price, max_units, max_users) VALUES
	('discovery', 'Découverte', 0, 0, 10, 1),
	('essential', 'Essentiel', 15000, 150000, 60, 3),
	('pro', 'Pro', 35000, 350000, 250, 10),
	('custom', 'Sur mesure', NULL, NULL, NULL, NULL);
--> statement-breakpoint

-- ---------------------------------------------------------------- catalogue des fonctionnalités
CREATE TABLE features (
	key text PRIMARY KEY CHECK (key ~ '^[a-z_]+(\.[a-z_0-9]+)*$'),
	description text NOT NULL,
	global_mode text NOT NULL CHECK (global_mode IN ('disabled', 'restricted', 'enabled')),
	plan_bound boolean NOT NULL,
	requires text[] NOT NULL DEFAULT '{}',
	updated_at timestamptz NOT NULL DEFAULT now(),
	updated_by uuid REFERENCES users (id)
);
--> statement-breakpoint
INSERT INTO features (key, description, global_mode, plan_bound, requires) VALUES
	('payments.registry', 'Saisie des encaissements et reçus', 'enabled', false, ARRAY[]::text[]),
	('payments.direct', 'Paiement Mobile Money initié depuis la plateforme vers le compte de l’agence (lot 14)', 'disabled', true, ARRAY['payments.registry']::text[]),
	('listings.publication', 'Publier des annonces sur la vitrine', 'enabled', false, ARRAY[]::text[]),
	('listings.featured', 'Mise en avant d’annonces', 'disabled', true, ARRAY['listings.publication']::text[]),
	('listings.public_showcase', 'Vitrine publique accessible (arrêt d’urgence de toute la vitrine)', 'enabled', false, ARRAY[]::text[]),
	('leads.contact_form', 'Formulaire de contact sur les annonces', 'enabled', false, ARRAY[]::text[]),
	('collections.reminders_whatsapp_link', 'Relances par lien WhatsApp pré-rempli', 'enabled', false, ARRAY[]::text[]),
	('collections.owner_statements', 'Relevés propriétaires', 'enabled', true, ARRAY[]::text[]),
	('field_agents', 'Rôle agent de terrain et validation des espèces', 'enabled', true, ARRAY[]::text[]),
	('imports.excel', 'Import Excel', 'enabled', false, ARRAY[]::text[]),
	('exports.csv', 'Exports CSV', 'enabled', true, ARRAY[]::text[]),
	('notifications.whatsapp_api', 'Messages par l’API WhatsApp Business (phase 4)', 'disabled', true, ARRAY[]::text[]),
	('listings.private_sellers', 'Publication par les particuliers (phase 4)', 'disabled', false, ARRAY[]::text[]),
	('media.virtual_tour_360', 'Visites 360° (phase 4)', 'disabled', true, ARRAY[]::text[]),
	('portals.owner_space', 'Espace propriétaire regroupant toutes les organisations (D13, lot 10 ter)', 'enabled', false, ARRAY[]::text[]),
	('portals.tenant_space', 'Espace locataire regroupant tout son historique (D13, lot 10 ter)', 'enabled', false, ARRAY[]::text[]),
	('listings.facebook_publish', 'Publication automatique des annonces sur une page Facebook', 'disabled', true, ARRAY['listings.publication']::text[]);
--> statement-breakpoint
CREATE TABLE plan_features (
	plan_id text NOT NULL REFERENCES plans (id),
	feature_key text NOT NULL REFERENCES features (key),
	-- Quota facultatif (ex. 2 relevés par mois en Découverte).
	quota integer CHECK (quota > 0),
	PRIMARY KEY (plan_id, feature_key)
);
--> statement-breakpoint
INSERT INTO plan_features (plan_id, feature_key, quota) VALUES
	('pro', 'payments.direct', NULL),
	('custom', 'payments.direct', NULL),
	('pro', 'listings.featured', NULL),
	('custom', 'listings.featured', NULL),
	('discovery', 'collections.owner_statements', 2),
	('essential', 'collections.owner_statements', NULL),
	('pro', 'collections.owner_statements', NULL),
	('custom', 'collections.owner_statements', NULL),
	('essential', 'field_agents', NULL),
	('pro', 'field_agents', NULL),
	('custom', 'field_agents', NULL),
	('essential', 'exports.csv', NULL),
	('pro', 'exports.csv', NULL),
	('custom', 'exports.csv', NULL),
	('pro', 'notifications.whatsapp_api', NULL),
	('custom', 'notifications.whatsapp_api', NULL),
	('pro', 'media.virtual_tour_360', NULL),
	('custom', 'media.virtual_tour_360', NULL),
	('pro', 'listings.facebook_publish', NULL),
	('custom', 'listings.facebook_publish', NULL);
--> statement-breakpoint

-- Exceptions : par organisation ou par personne, motif obligatoire, date de fin facultative.
-- Une seule exception non révoquée par (clé, portée, cible) : en poser une nouvelle révoque la précédente.
CREATE TABLE feature_overrides (
	id uuid PRIMARY KEY,
	feature_key text NOT NULL REFERENCES features (key),
	scope text NOT NULL CHECK (scope IN ('organization', 'user')),
	organization_id uuid REFERENCES organizations (id),
	user_id uuid REFERENCES users (id),
	value boolean NOT NULL,
	reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
	starts_at timestamptz NOT NULL DEFAULT now(),
	ends_at timestamptz,
	created_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz,
	revoked_by uuid REFERENCES users (id),
	CHECK ((scope = 'organization') = (organization_id IS NOT NULL)),
	CHECK ((scope = 'user') = (user_id IS NOT NULL)),
	CHECK (ends_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX feature_overrides_one_active ON feature_overrides (feature_key, scope, coalesce(organization_id, user_id))
	WHERE revoked_at IS NULL;
--> statement-breakpoint
-- Exceptions de quota (ex. un 2e utilisateur en Découverte, geste commercial).
CREATE TABLE quota_overrides (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	quota text NOT NULL CHECK (quota IN ('users', 'units', 'owner_statements')),
	value integer NOT NULL CHECK (value > 0),
	reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
	starts_at timestamptz NOT NULL DEFAULT now(),
	ends_at timestamptz,
	created_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz,
	revoked_by uuid REFERENCES users (id),
	CHECK (ends_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX quota_overrides_one_active ON quota_overrides (organization_id, quota) WHERE revoked_at IS NULL;
--> statement-breakpoint
-- Lecture par le module features (app_api) ; modification par le back-office seulement (app_admin).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON plans, features, plan_features, feature_overrides, quota_overrides FROM app_api;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON plans, features, feature_overrides, quota_overrides FROM app_admin;
--> statement-breakpoint

-- Réglage de l'organisation : le directeur ne peut que désactiver ce qui lui est ouvert.
CREATE TABLE organization_feature_settings (
	organization_id uuid NOT NULL REFERENCES organizations (id),
	feature_key text NOT NULL REFERENCES features (key),
	disabled_by_organization boolean NOT NULL,
	updated_by uuid NOT NULL REFERENCES users (id),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (organization_id, feature_key)
);
--> statement-breakpoint
SELECT enable_organization_rls('organization_feature_settings');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON organization_feature_settings FROM app_api, app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- organisations : formule, moyens de paiement, statut
ALTER TABLE organizations ALTER COLUMN plan_id TYPE text USING 'discovery';
--> statement-breakpoint
ALTER TABLE organizations ALTER COLUMN plan_id SET DEFAULT 'discovery';
--> statement-breakpoint
UPDATE organizations SET plan_id = 'discovery' WHERE plan_id IS NULL;
--> statement-breakpoint
ALTER TABLE organizations ALTER COLUMN plan_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE organizations ADD CONSTRAINT organizations_plan_fk FOREIGN KEY (plan_id) REFERENCES plans (id);
--> statement-breakpoint
-- D18 : réglage de l'organisation (pas un interrupteur), au moins un moyen actif.
ALTER TABLE organizations ADD COLUMN accepted_payment_methods text[] NOT NULL DEFAULT ARRAY['cash', 'mobile_money_manual', 'bank_transfer'];
--> statement-breakpoint
ALTER TABLE organizations ADD CONSTRAINT organizations_payment_methods_check CHECK (
	cardinality(accepted_payment_methods) >= 1
	AND accepted_payment_methods <@ ARRAY['cash', 'mobile_money_manual', 'bank_transfer']
);
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN verified_at timestamptz;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN suspended_at timestamptz;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN suspended_reason text CHECK (char_length(suspended_reason) <= 500);
--> statement-breakpoint
ALTER TABLE organizations ADD CONSTRAINT organizations_suspension_check
	CHECK ((verification_status = 'suspended') = (suspended_at IS NOT NULL AND suspended_reason IS NOT NULL));
--> statement-breakpoint

-- ---------------------------------------------------------------- abonnements (saisis à la main)
-- Encaissés sur le compte de la plateforme : ce ne sont jamais des loyers (CLAUDE.md règle 5).
CREATE TABLE subscriptions (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	plan_id text NOT NULL REFERENCES plans (id),
	starts_on date NOT NULL,
	ends_on date NOT NULL,
	amount bigint NOT NULL CHECK (amount >= 0),
	payment_status text NOT NULL CHECK (payment_status IN ('pending', 'paid', 'waived')),
	payment_reference text CHECK (char_length(payment_reference) <= 120),
	paid_on date,
	recorded_by uuid NOT NULL REFERENCES users (id),
	payment_recorded_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CHECK (ends_on >= starts_on),
	CHECK (payment_status <> 'paid' OR (payment_reference IS NOT NULL AND paid_on IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX subscriptions_organization ON subscriptions (organization_id, ends_on DESC);
--> statement-breakpoint
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- L'organisation lit les siens (son contexte seulement) ; le back-office gère ceux de toutes (donnée de la plateforme).
CREATE POLICY own_subscriptions ON subscriptions FOR SELECT TO app_api USING (organization_id = current_organization_id());
--> statement-breakpoint
CREATE POLICY platform_subscriptions ON subscriptions TO app_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON subscriptions FROM app_api;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON subscriptions FROM app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- accès d'assistance motivé
-- Lecture seule, motif obligatoire, 24 heures au plus ; jamais de connexion « en tant que » un utilisateur.
CREATE TABLE support_accesses (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	agent_id uuid NOT NULL REFERENCES users (id),
	reason text NOT NULL CHECK (char_length(reason) BETWEEN 15 AND 500),
	starts_at timestamptz NOT NULL DEFAULT now(),
	ends_at timestamptz NOT NULL,
	closed_at timestamptz,
	closed_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE support_accesses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE support_accesses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_support_accesses ON support_accesses FOR SELECT TO app_api USING (organization_id = current_organization_id());
--> statement-breakpoint
CREATE POLICY platform_support_accesses ON support_accesses TO app_admin USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON support_accesses FROM app_api;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON support_accesses FROM app_admin;
--> statement-breakpoint
GRANT UPDATE (closed_at, closed_by) ON support_accesses TO app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- journal : configuration de la plateforme
-- Une ligne de configuration (mode global, formule…) n'a ni organisation ni personne concernée : origine admin.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_check;
--> statement-breakpoint
ALTER TABLE audit_log ADD CONSTRAINT audit_log_scope_check
	CHECK (organization_id IS NOT NULL OR subject_user_id IS NOT NULL OR origin = 'admin');
--> statement-breakpoint
-- Le back-office relit aussi ses propres actions sur les organisations (pas les autres événements de celles-ci).
CREATE POLICY admin_actions ON audit_log FOR SELECT TO app_admin USING (origin = 'admin');
--> statement-breakpoint

-- ---------------------------------------------------------------- droits de app_admin (durcissement)
-- Le lot 01 lui donnait par défaut l'écriture sur toutes les tables : désormais, rien par défaut, droits table par table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE ON TABLES FROM app_admin;
--> statement-breakpoint
REVOKE ALL ON sessions, refresh_tokens, otp_codes FROM app_admin;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON users, organization_members, organization_invitations, organization_logos FROM app_admin;
--> statement-breakpoint
-- Jamais le mot de passe.
REVOKE SELECT ON users FROM app_admin;
--> statement-breakpoint
GRANT SELECT (id, phone, name, status, platform_role, phone_verified_at, created_at, updated_at) ON users TO app_admin;
--> statement-breakpoint
-- Sur une organisation, seulement la validation, la suspension et la formule (dans le contexte de l'organisation).
REVOKE INSERT, UPDATE, DELETE ON organizations FROM app_admin;
--> statement-breakpoint
GRANT UPDATE (verification_status, verified_at, suspended_at, suspended_reason, plan_id, updated_at) ON organizations TO app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- annuaire du back-office
-- Hors d'un accès d'assistance, le back-office ne voit que le compte des organisations et des personnes : ces fonctions
-- (propriétaire du schéma) le lui donnent, sans le représentant légal ni aucune donnée métier. La politique ne s'ouvre
-- qu'au propriétaire du schéma, c'est-à-dire à l'intérieur de ces fonctions.
CREATE POLICY schema_owner_directory ON organizations FOR SELECT
	USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'organizations'::regclass));
--> statement-breakpoint
CREATE POLICY schema_owner_directory ON organization_members FOR SELECT
	USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'organization_members'::regclass));
--> statement-breakpoint
CREATE POLICY schema_owner_directory ON organization_feature_settings FOR SELECT
	USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'organization_feature_settings'::regclass));
--> statement-breakpoint
CREATE FUNCTION platform_organization_directory()
	RETURNS TABLE (
		id uuid, type text, legal_name text, trade_name text, phone text, commune text, verification_status text,
		suspended_reason text, plan_id text, members bigint, created_at timestamptz
	)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
	SELECT o.id, o.type, o.legal_name, o.trade_name, o.phone, o.commune, o.verification_status, o.suspended_reason, o.plan_id,
		(SELECT count(*) FROM organization_members m WHERE m.organization_id = o.id AND m.status = 'active'), o.created_at
	FROM organizations o
$$;
--> statement-breakpoint
CREATE FUNCTION platform_organization_members(org uuid)
	RETURNS TABLE (user_id uuid, name text, phone text, role text, joined_at timestamptz)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
	SELECT m.user_id, u.name, u.phone, m.role, m.joined_at FROM organization_members m JOIN users u ON u.id = m.user_id
	WHERE m.organization_id = org AND m.status = 'active' ORDER BY m.joined_at
$$;
--> statement-breakpoint
CREATE FUNCTION platform_user_memberships(person uuid)
	RETURNS TABLE (organization_id uuid, name text, type text, role text, plan_id text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
	SELECT o.id, coalesce(o.trade_name, o.legal_name), o.type, m.role, o.plan_id FROM organization_members m
	JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = person AND m.status = 'active' ORDER BY 2
$$;
--> statement-breakpoint
CREATE FUNCTION platform_disabled_features(org uuid)
	RETURNS SETOF text
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
	SELECT feature_key FROM organization_feature_settings WHERE organization_id = org AND disabled_by_organization
$$;
--> statement-breakpoint
-- Toutes les désactivations faites par les organisations (impact d'une coupure, simulateur) : une seule requête.
CREATE FUNCTION platform_all_disabled_features()
	RETURNS TABLE (organization_id uuid, feature_key text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
	SELECT organization_id, feature_key FROM organization_feature_settings WHERE disabled_by_organization
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_organization_directory(), platform_organization_members(uuid), platform_user_memberships(uuid),
	platform_disabled_features(uuid), platform_all_disabled_features() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_organization_directory(), platform_organization_members(uuid), platform_user_memberships(uuid),
	platform_disabled_features(uuid), platform_all_disabled_features() TO app_admin;
