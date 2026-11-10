-- Lot 06 — propriétaires et mandats (module `owners`), décisions D16 et D24, règles 1, 2, 4 et 12 de CLAUDE.md.
--
-- - owners : la fiche d'un propriétaire, gérée par l'organisation ; jamais d'invitation, jamais de compte exigé.
-- - mandates : naît actif ; il ne fait que se fermer (révoqué ou expiré). Modifier un mandat actif crée une nouvelle
--   version : la base l'exige (trigger) et en garde la copie dans mandate_versions, en ajout seul.
-- - mandate_scopes : les biens et unités couverts par un mandat (remplie au lot 07). L'index « un seul mandat de
--   gestion actif par unité » (règle 12) est posé dès maintenant.
-- - bailleur particulier : une fiche propriétaire et un mandat self_managed permanent, créés avec l'organisation ;
--   ceux qui existent déjà les reçoivent ici (backfill_landlord_self_managed, idempotente).
-- Chaque table : organization_id, RLS d'organisation, clés composites, publiée vers PowerSync (docs/SYNC.md).

-- UUIDv7 en SQL (PostgreSQL 16 n'en fournit pas) : 48 bits d'horodatage en millisecondes, version 7, variante RFC
-- 9562, le reste aléatoire. Sert aux lignes créées par la base elle-même (versions de mandat, backfill).
CREATE FUNCTION uuid_v7() RETURNS uuid
	LANGUAGE plpgsql VOLATILE
	SET search_path = pg_catalog, public
AS $$
DECLARE
	b bytea := uuid_send(gen_random_uuid());
	ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
BEGIN
	b := overlay(b PLACING substring(int8send(ms) FROM 3) FROM 1 FOR 6);
	b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);
	b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);
	RETURN encode(b, 'hex')::uuid;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION uuid_v7() FROM PUBLIC;
--> statement-breakpoint

-- Journal : les lignes écrites par une migration (backfill des bailleurs) portent leur vraie origine.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_origin_check;
--> statement-breakpoint
ALTER TABLE audit_log ADD CONSTRAINT audit_log_origin_check CHECK (origin IN ('app', 'api', 'admin', 'sync', 'job', 'migration'));
--> statement-breakpoint

-- ---------------------------------------------------------------- propriétaires

CREATE TABLE owners (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	type text NOT NULL CHECK (type IN ('person', 'company', 'group')),
	name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
	phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
	email text CHECK (char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	address text CHECK (char_length(address) <= 200),
	-- Pays de résidence (ISO 3166-1 alpha-2) : beaucoup vivent dans la diaspora.
	country text NOT NULL DEFAULT 'BF' CHECK (country ~ '^[A-Z]{2}$'),
	-- Groupe d'indivisaires : représentant désigné (nom et téléphone) ; aucun pour une personne ou une société.
	representative_name text CHECK (char_length(representative_name) BETWEEN 2 AND 120),
	representative_phone text CHECK (representative_phone ~ '^\+[1-9][0-9]{7,14}$'),
	notes text CHECK (char_length(notes) <= 2000),
	-- Compte lié (lot 10 ter, après vérification du téléphone et accord de l'organisation) ; jamais obligatoire,
	-- jamais écrit dans ce lot, jamais synchronisé.
	user_id uuid REFERENCES users (id),
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
	archived_at timestamptz,
	-- Vide pour une fiche créée par la base (backfill d'un bailleur).
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT owners_representative CHECK (
		(type = 'group' AND representative_name IS NOT NULL AND representative_phone IS NOT NULL)
		OR (type <> 'group' AND representative_name IS NULL AND representative_phone IS NULL)
	),
	CONSTRAINT owners_archived CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX owners_by_name ON owners (organization_id, name);
--> statement-breakpoint
SELECT enable_organization_rls('owners');
--> statement-breakpoint
-- Une fiche ne se supprime jamais : elle s'archive.
REVOKE DELETE, TRUNCATE ON owners FROM app_api, app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- mandats

CREATE TABLE mandates (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	owner_id uuid NOT NULL,
	type text NOT NULL CHECK (type IN ('rental_management', 'letting', 'sale', 'self_managed', 'other')),
	starts_on date NOT NULL,
	ends_on date,
	-- Commission (règle 2) : base stockée, jamais déduite du type ; un taux en points de base (1000 = 10 %, appliqué
	-- aux loyers encaissés) ou un montant entier en FCFA, jamais les deux, jamais de flottant.
	commission_basis text CHECK (commission_basis IN ('percent_of_collected', 'fixed_per_month', 'fixed_per_operation')),
	commission_rate_bp integer CHECK (commission_rate_bp BETWEEN 0 AND 10000),
	commission_amount bigint CHECK (commission_amount >= 0),
	can_publish boolean NOT NULL DEFAULT false,
	can_take_photos boolean NOT NULL DEFAULT false,
	can_collect_funds boolean NOT NULL DEFAULT false,
	-- L'organisation signe les baux au nom du propriétaire (D24).
	can_sign_leases boolean NOT NULL DEFAULT false,
	-- Exclusivité : information seulement.
	exclusive boolean NOT NULL DEFAULT false,
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
	revoked_at timestamptz,
	revocation_reason text CHECK (char_length(revocation_reason) BETWEEN 5 AND 500),
	expired_at timestamptz,
	version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
	created_by uuid REFERENCES users (id),
	-- Auteur de la dernière version (vide : la base ou la tâche d'expiration).
	updated_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	-- Clé composite : un mandat ne peut pas viser le propriétaire d'une autre organisation.
	CONSTRAINT mandates_owner_fk FOREIGN KEY (organization_id, owner_id) REFERENCES owners (organization_id, id),
	CONSTRAINT mandates_dates CHECK (ends_on IS NULL OR ends_on >= starts_on),
	CONSTRAINT mandates_commission CHECK (
		(commission_basis IS NULL AND commission_rate_bp IS NULL AND commission_amount IS NULL)
		OR (commission_basis = 'percent_of_collected' AND commission_rate_bp IS NOT NULL AND commission_amount IS NULL)
		OR (commission_basis IN ('fixed_per_month', 'fixed_per_operation') AND commission_amount IS NOT NULL AND commission_rate_bp IS NULL)
	),
	CONSTRAINT mandates_commission_required CHECK (type NOT IN ('rental_management', 'letting', 'sale') OR commission_basis IS NOT NULL),
	-- Bailleur qui gère lui-même : sans commission, permanent, jamais révoqué ni expiré.
	CONSTRAINT mandates_self_managed CHECK (type <> 'self_managed' OR (commission_basis IS NULL AND ends_on IS NULL AND status = 'active')),
	CONSTRAINT mandates_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)),
	CONSTRAINT mandates_expired CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
	-- Un mandat fermé n'autorise plus rien.
	CONSTRAINT mandates_closed_authorizations CHECK (
		status = 'active' OR NOT (can_publish OR can_take_photos OR can_collect_funds OR can_sign_leases)
	)
);
--> statement-breakpoint
CREATE INDEX mandates_by_owner ON mandates (organization_id, owner_id);
--> statement-breakpoint
CREATE INDEX mandates_active_end ON mandates (ends_on) WHERE status = 'active' AND ends_on IS NOT NULL;
--> statement-breakpoint
-- Un seul mandat self_managed par organisation (créé une fois, avec le bailleur).
CREATE UNIQUE INDEX mandates_one_self_managed ON mandates (organization_id) WHERE type = 'self_managed';
--> statement-breakpoint
SELECT enable_organization_rls('mandates');
--> statement-breakpoint
-- Un mandat ne se supprime jamais : il se révoque ou expire.
REVOKE DELETE, TRUNCATE ON mandates FROM app_api, app_admin;
--> statement-breakpoint

-- Bailleur particulier (D12) : une seule fiche propriétaire (lui-même) et le seul mandat self_managed ; une agence
-- n'a jamais de mandat self_managed.
CREATE FUNCTION owners_landlord_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	org_type text;
BEGIN
	SELECT type INTO org_type FROM organizations WHERE id = NEW.organization_id;
	IF TG_TABLE_NAME = 'owners' THEN
		IF org_type = 'landlord' AND EXISTS (SELECT 1 FROM owners WHERE organization_id = NEW.organization_id) THEN
			RAISE EXCEPTION 'LANDLORD_SELF_MANAGED: un bailleur n''a que sa propre fiche propriétaire' USING ERRCODE = 'P0001';
		END IF;
	ELSIF org_type = 'landlord' AND NEW.type <> 'self_managed' THEN
		RAISE EXCEPTION 'LANDLORD_SELF_MANAGED: un bailleur gère lui-même, sans autre mandat' USING ERRCODE = 'P0001';
	ELSIF org_type IS DISTINCT FROM 'landlord' AND NEW.type = 'self_managed' THEN
		RAISE EXCEPTION 'SELF_MANAGED_LANDLORD_ONLY: seul un bailleur particulier gère lui-même' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER owners_landlord BEFORE INSERT ON owners FOR EACH ROW EXECUTE FUNCTION owners_landlord_rules();
--> statement-breakpoint
CREATE TRIGGER mandates_landlord BEFORE INSERT ON mandates FOR EACH ROW EXECUTE FUNCTION owners_landlord_rules();
--> statement-breakpoint

-- Versionnage (point 5 du lot) : un mandat naît actif en version 1 ; un mandat fermé ne change plus ; une
-- modification d'un mandat actif (conditions, autorisations, statut) passe à la version suivante, exactement.
-- Propriétaire et type ne changent jamais : un autre propriétaire ou un autre type, c'est un autre mandat.
CREATE FUNCTION mandates_versioning_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'active' OR NEW.version <> 1 THEN
			RAISE EXCEPTION 'MANDATE_BORN_ACTIVE: un mandat naît actif, en version 1' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.owner_id <> OLD.owner_id OR NEW.type <> OLD.type
		OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
		RAISE EXCEPTION 'MANDATE_IMMUTABLE: propriétaire et type d''un mandat ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status <> 'active' THEN
		RAISE EXCEPTION 'MANDATE_CLOSED: un mandat révoqué ou expiré ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF (NEW.starts_on, NEW.ends_on, NEW.commission_basis, NEW.commission_rate_bp, NEW.commission_amount, NEW.can_publish,
		NEW.can_take_photos, NEW.can_collect_funds, NEW.can_sign_leases, NEW.exclusive, NEW.status, NEW.revoked_at,
		NEW.revocation_reason, NEW.expired_at)
		IS DISTINCT FROM (OLD.starts_on, OLD.ends_on, OLD.commission_basis, OLD.commission_rate_bp, OLD.commission_amount,
		OLD.can_publish, OLD.can_take_photos, OLD.can_collect_funds, OLD.can_sign_leases, OLD.exclusive, OLD.status,
		OLD.revoked_at, OLD.revocation_reason, OLD.expired_at) THEN
		IF NEW.version <> OLD.version + 1 THEN
			RAISE EXCEPTION 'MANDATE_VERSION: une modification d''un mandat actif crée la version %', OLD.version + 1 USING ERRCODE = 'P0001';
		END IF;
	ELSIF NEW.version <> OLD.version THEN
		RAISE EXCEPTION 'MANDATE_VERSION: version changée sans modification' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mandates_versioning BEFORE INSERT OR UPDATE ON mandates FOR EACH ROW EXECUTE FUNCTION mandates_versioning_rules();
--> statement-breakpoint

-- Versions : la copie de chaque version, écrite par la base seule (trigger), jamais modifiée ni supprimée.
CREATE TABLE mandate_versions (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	mandate_id uuid NOT NULL,
	version integer NOT NULL CHECK (version >= 1),
	starts_on date NOT NULL,
	ends_on date,
	commission_basis text,
	commission_rate_bp integer,
	commission_amount bigint,
	can_publish boolean NOT NULL,
	can_take_photos boolean NOT NULL,
	can_collect_funds boolean NOT NULL,
	can_sign_leases boolean NOT NULL,
	exclusive boolean NOT NULL,
	status text NOT NULL,
	revoked_at timestamptz,
	revocation_reason text,
	expired_at timestamptz,
	-- Auteur de la version (vide : la base ou la tâche d'expiration).
	changed_by uuid REFERENCES users (id),
	recorded_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	UNIQUE (organization_id, mandate_id, version),
	CONSTRAINT mandate_versions_mandate_fk FOREIGN KEY (organization_id, mandate_id) REFERENCES mandates (organization_id, id)
);
--> statement-breakpoint
SELECT enable_organization_rls('mandate_versions');
--> statement-breakpoint
-- Écrites seulement par le trigger : aucun rôle de l'application ne les écrit ni ne les modifie.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON mandate_versions FROM app_api, app_admin;
--> statement-breakpoint
CREATE FUNCTION mandate_versions_append_only() RETURNS trigger
	LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'MANDATE_VERSIONS_APPEND_ONLY: une version de mandat ne se modifie ni ne s''efface (% refusé)', TG_OP USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mandate_versions_no_update_delete BEFORE UPDATE OR DELETE ON mandate_versions
	FOR EACH ROW EXECUTE FUNCTION mandate_versions_append_only();
--> statement-breakpoint
CREATE TRIGGER mandate_versions_no_truncate BEFORE TRUNCATE ON mandate_versions
	FOR EACH STATEMENT EXECUTE FUNCTION mandate_versions_append_only();
--> statement-breakpoint
-- Copie d'une nouvelle version (création, ou modification d'un mandat actif). SECURITY DEFINER : l'application
-- n'a aucun droit d'écriture sur mandate_versions ; la copie reste dans l'organisation du mandat.
CREATE FUNCTION mandates_record_version() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'INSERT' OR NEW.version <> OLD.version THEN
		INSERT INTO mandate_versions (id, organization_id, mandate_id, version, starts_on, ends_on, commission_basis,
			commission_rate_bp, commission_amount, can_publish, can_take_photos, can_collect_funds, can_sign_leases, exclusive,
			status, revoked_at, revocation_reason, expired_at, changed_by)
		VALUES (uuid_v7(), NEW.organization_id, NEW.id, NEW.version, NEW.starts_on, NEW.ends_on, NEW.commission_basis,
			NEW.commission_rate_bp, NEW.commission_amount, NEW.can_publish, NEW.can_take_photos, NEW.can_collect_funds,
			NEW.can_sign_leases, NEW.exclusive, NEW.status, NEW.revoked_at, NEW.revocation_reason, NEW.expired_at,
			CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE NEW.updated_by END);
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION mandates_record_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER mandates_version_copy AFTER INSERT OR UPDATE ON mandates FOR EACH ROW EXECUTE FUNCTION mandates_record_version();
--> statement-breakpoint

-- ---------------------------------------------------------------- portées des mandats (règle 12)

-- Biens et unités couverts par un mandat : remplie au lot 07 (les clés composites vers properties et units y seront
-- ajoutées). Un mandat sur un bien entier a une ligne « bien » (unit_id vide), plus une ligne par unité du bien
-- (via_property) ; une unité créée plus tard dans le bien recevra la sienne (trigger du lot 07).
CREATE TABLE mandate_scopes (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	mandate_id uuid NOT NULL,
	property_id uuid NOT NULL,
	unit_id uuid,
	via_property boolean NOT NULL DEFAULT false,
	-- Calculé par la base, jamais saisi : mandat de gestion (rental_management, self_managed) et actif.
	management_active boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT mandate_scopes_mandate_fk FOREIGN KEY (organization_id, mandate_id) REFERENCES mandates (organization_id, id),
	CONSTRAINT mandate_scopes_once UNIQUE NULLS NOT DISTINCT (organization_id, mandate_id, property_id, unit_id),
	CONSTRAINT mandate_scopes_via_property CHECK (NOT via_property OR unit_id IS NOT NULL)
);
--> statement-breakpoint
-- Règle 12 (D16) : une unité n'a jamais deux mandats de gestion actifs ; un bien entier non plus. Un mandat sur un
-- bien couvre chacune de ses unités (lignes via_property) : il entre donc en conflit avec un mandat sur l'une d'elles.
CREATE UNIQUE INDEX mandate_scopes_one_manager_per_unit ON mandate_scopes (organization_id, unit_id)
	WHERE management_active AND unit_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX mandate_scopes_one_manager_per_property ON mandate_scopes (organization_id, property_id)
	WHERE management_active AND unit_id IS NULL;
--> statement-breakpoint
CREATE INDEX mandate_scopes_by_mandate ON mandate_scopes (organization_id, mandate_id);
--> statement-breakpoint
SELECT enable_organization_rls('mandate_scopes');
--> statement-breakpoint
CREATE FUNCTION mandate_scopes_compute() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	SELECT m.type IN ('rental_management', 'self_managed') AND m.status = 'active' INTO NEW.management_active
	FROM mandates m WHERE m.organization_id = NEW.organization_id AND m.id = NEW.mandate_id;
	NEW.management_active := coalesce(NEW.management_active, false);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mandate_scopes_management BEFORE INSERT OR UPDATE ON mandate_scopes
	FOR EACH ROW EXECUTE FUNCTION mandate_scopes_compute();
--> statement-breakpoint
-- Un mandat qui se ferme libère ses unités, dans la même transaction. SECURITY DEFINER : la mise à jour du champ
-- calculé ne demande à l'application aucun droit d'écriture sur les portées.
CREATE FUNCTION mandates_refresh_scopes() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF NEW.status IS DISTINCT FROM OLD.status THEN
		UPDATE mandate_scopes SET management_active = false
		WHERE organization_id = NEW.organization_id AND mandate_id = NEW.id;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION mandates_refresh_scopes() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER mandates_scopes_refresh AFTER UPDATE OF status ON mandates FOR EACH ROW EXECUTE FUNCTION mandates_refresh_scopes();
--> statement-breakpoint

-- ---------------------------------------------------------------- expiration (tâche quotidienne)

-- Organisations qui ont un mandat actif dont la date de fin est passée à la date donnée. SECURITY DEFINER : la tâche
-- de nuit ne connaît pas les organisations à l'avance ; la fonction ne renvoie QUE des identifiants d'organisation,
-- puis la tâche ouvre chacune dans son propre contexte (withOrganization), sous la RLS.
CREATE FUNCTION due_mandate_organizations(as_of date) RETURNS SETOF uuid
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT DISTINCT organization_id FROM mandates WHERE status = 'active' AND ends_on < as_of
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION due_mandate_organizations(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION due_mandate_organizations(date) TO app_api;
--> statement-breakpoint

-- ---------------------------------------------------------------- bailleurs déjà créés

-- Fiche propriétaire (raison sociale et téléphone de l'organisation) et mandat self_managed permanent, toutes
-- autorisations, pour chaque bailleur qui n'en a pas encore ; deux lignes d'audit d'origine « migration ».
-- Idempotente : un bailleur qui a déjà son mandat n'est pas touché (et l'index unique interdit un second).
CREATE FUNCTION backfill_landlord_self_managed() RETURNS integer
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	org record;
	new_owner uuid;
	new_mandate uuid;
	audit_owner uuid;
	audit_mandate uuid;
	swap uuid;
	done integer := 0;
BEGIN
	FOR org IN
		SELECT o.id, o.legal_name, o.phone, o.created_at::date AS since FROM organizations o
		WHERE o.type = 'landlord'
			AND NOT EXISTS (SELECT 1 FROM mandates m WHERE m.organization_id = o.id AND m.type = 'self_managed')
		ORDER BY o.created_at
	LOOP
		-- Contexte de l'organisation : la RLS s'applique aussi à un rôle propriétaire des tables (FORCE).
		PERFORM set_config('app.organization_id', org.id::text, true);
		new_owner := uuid_v7();
		new_mandate := uuid_v7();
		-- Le journal se lit par identifiant : la fiche avant le mandat, même créés dans la même milliseconde.
		audit_owner := uuid_v7();
		audit_mandate := uuid_v7();
		IF audit_mandate < audit_owner THEN
			swap := audit_owner;
			audit_owner := audit_mandate;
			audit_mandate := swap;
		END IF;
		INSERT INTO owners (id, organization_id, type, name, phone)
		VALUES (new_owner, org.id, 'person', org.legal_name, org.phone);
		INSERT INTO mandates (id, organization_id, owner_id, type, starts_on, can_publish, can_take_photos, can_collect_funds,
			can_sign_leases)
		VALUES (new_mandate, org.id, new_owner, 'self_managed', org.since, true, true, true, true);
		INSERT INTO audit_log (id, actor_type, organization_id, action, object_type, object_id, after, origin)
		VALUES (audit_owner, 'system', org.id, 'owner.create', 'owner', new_owner,
			jsonb_build_object('type', 'person', 'name', org.legal_name, 'phone', org.phone, 'country', 'BF', 'status', 'active'),
			'migration');
		INSERT INTO audit_log (id, actor_type, organization_id, action, object_type, object_id, after, origin)
		VALUES (audit_mandate, 'system', org.id, 'mandate.create', 'mandate', new_mandate,
			jsonb_build_object('ownerId', new_owner, 'type', 'self_managed', 'startsOn', org.since, 'status', 'active',
				'canPublish', true, 'canTakePhotos', true, 'canCollectFunds', true, 'canSignLeases', true, 'version', 1),
			'migration');
		done := done + 1;
	END LOOP;
	PERFORM set_config('app.organization_id', '', true);
	RETURN done;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION backfill_landlord_self_managed() FROM PUBLIC;
--> statement-breakpoint
SELECT backfill_landlord_self_managed();
--> statement-breakpoint

-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)

GRANT SELECT ON owners, mandates, mandate_versions, mandate_scopes TO app_sync;
--> statement-breakpoint
CREATE POLICY sync_read ON owners FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON mandates FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON mandate_versions FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON mandate_scopes FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE owners, mandates, mandate_versions, mandate_scopes;
