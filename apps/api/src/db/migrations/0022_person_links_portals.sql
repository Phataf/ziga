-- Lot 10 ter — espaces propriétaire et locataire : liaison d'une fiche à une personne, et signalements. Règles 1, 4 et
-- 15 de CLAUDE.md ; D13, D17. Les règles pures sont dans packages/shared (person-links.ts) ; la base applique les mêmes,
-- en dernier rempart.
--
-- - person_links : lien entre une fiche (propriétaire ou locataire) d'une organisation et le compte d'une personne.
--   Cloisonné par organisation (RLS, clés composites), jamais supprimé, jamais synchronisé. Actif seulement si le numéro
--   de la fiche, celui du compte et celui vérifié par code SMS sont le même, et si un membre de la direction ou de la
--   gestion l'a accepté. Révoqué : définitif (une nouvelle liaison crée un nouveau lien). Un lien non révoqué au plus
--   par fiche. Les colonnes owners.user_id et tenants.user_id (lots 06 et 08) restent vides : ce lien est la seule source.
-- - my_person_links() : la seule lecture hors organisation, SECURITY DEFINER. Elle ne renvoie que les identifiants des
--   liens actifs de la personne connectée ; le module portals ouvre ensuite chaque organisation dans son propre contexte.
-- - Changement de numéro d'une fiche ou d'un compte : les liens concernés sont révoqués par la base, avec leur motif et
--   une ligne d'audit dans chaque organisation ; la liaison est à refaire (réponse 3 du porteur).
-- - Bailleur particulier : sa propre fiche se lie à son compte sans code ni acceptation, seulement si le numéro vérifié
--   du compte est celui de la fiche et s'il est directeur de l'organisation (réponse 2 du porteur).
-- - Demande par la personne : seulement auprès d'une agence vérifiée (réponse 1 du porteur).
-- - maintenance_requests : signalements d'un locataire depuis son espace (reçu, planifié, fait), enregistrés dans
--   l'organisation du bail ; synchronisés pour la fiche du bail (réponse 4 du porteur, glossaire « Signalement »).
-- - otp_codes : motif `link_record` (code au numéro de la fiche, pour un lien précis) ; audit_log : origine `portal`.

-- ---------------------------------------------------------------- codes SMS et journal

ALTER TABLE otp_codes ADD COLUMN person_link_id uuid;
--> statement-breakpoint
ALTER TABLE otp_codes DROP CONSTRAINT otp_codes_purpose_check;
--> statement-breakpoint
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_purpose_check
	CHECK (purpose IN ('verify_phone', 'reset_password', 'change_phone', 'link_record'));
--> statement-breakpoint
ALTER TABLE otp_codes DROP CONSTRAINT otp_codes_change_phone_user;
--> statement-breakpoint
-- Un code de changement de numéro ou de liaison est lié à la personne ; un code de liaison, à son lien.
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_user CHECK ((purpose IN ('change_phone', 'link_record')) = (user_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_person_link CHECK ((purpose = 'link_record') = (person_link_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE audit_log DROP CONSTRAINT audit_log_origin_check;
--> statement-breakpoint
ALTER TABLE audit_log ADD CONSTRAINT audit_log_origin_check
	CHECK (origin IN ('app', 'api', 'admin', 'sync', 'job', 'migration', 'portal'));
--> statement-breakpoint

-- ---------------------------------------------------------------- liens entre une fiche et une personne

CREATE TABLE person_links (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	user_id uuid NOT NULL REFERENCES users (id),
	record_type text NOT NULL CHECK (record_type IN ('owner', 'tenant')),
	owner_id uuid,
	tenant_id uuid,
	status text NOT NULL CHECK (status IN ('requested', 'active', 'revoked')),
	-- Invitation depuis la fiche, demande depuis l'espace de la personne, ou propre fiche d'un bailleur particulier.
	origin text NOT NULL CHECK (origin IN ('organization_invite', 'person_request', 'landlord_self')),
	-- Numéro de la fiche au moment de la demande : c'est aussi celui du compte, et celui qui reçoit le code.
	phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
	phone_verified_at timestamptz,
	-- Le membre qui invite, ou la personne qui demande.
	requested_by uuid NOT NULL REFERENCES users (id),
	accepted_by uuid REFERENCES users (id),
	accepted_at timestamptz,
	revoked_by uuid REFERENCES users (id),
	revoked_by_party text CHECK (revoked_by_party IN ('organization', 'person', 'system')),
	revoked_at timestamptz,
	revocation_reason text CHECK (char_length(revocation_reason) BETWEEN 5 AND 500),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT person_links_owner_fk FOREIGN KEY (organization_id, owner_id) REFERENCES owners (organization_id, id),
	CONSTRAINT person_links_tenant_fk FOREIGN KEY (organization_id, tenant_id) REFERENCES tenants (organization_id, id),
	CONSTRAINT person_links_record CHECK (
		(record_type = 'owner' AND owner_id IS NOT NULL AND tenant_id IS NULL)
		OR (record_type = 'tenant' AND tenant_id IS NOT NULL AND owner_id IS NULL)
	),
	CONSTRAINT person_links_landlord_self CHECK (origin <> 'landlord_self' OR record_type = 'owner'),
	CONSTRAINT person_links_accepted CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
	CONSTRAINT person_links_active CHECK (status <> 'active' OR (phone_verified_at IS NOT NULL AND accepted_by IS NOT NULL)),
	CONSTRAINT person_links_revoked CHECK (
		(status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by_party IS NOT NULL AND revocation_reason IS NOT NULL)
	),
	-- Révoqué par un membre ou par la personne : nommé ; par la base (changement de numéro) : personne.
	CONSTRAINT person_links_revoked_by CHECK (revoked_by_party IS NULL OR ((revoked_by_party = 'system') = (revoked_by IS NULL)))
);
--> statement-breakpoint
-- Un lien non révoqué au plus par fiche : une fiche n'est jamais liée à deux personnes.
CREATE UNIQUE INDEX person_links_one_per_owner ON person_links (organization_id, owner_id) WHERE owner_id IS NOT NULL AND status <> 'revoked';
--> statement-breakpoint
CREATE UNIQUE INDEX person_links_one_per_tenant ON person_links (organization_id, tenant_id) WHERE tenant_id IS NOT NULL AND status <> 'revoked';
--> statement-breakpoint
CREATE INDEX person_links_active_by_user ON person_links (user_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX person_links_by_user ON person_links (user_id) WHERE status <> 'revoked';
--> statement-breakpoint
SELECT enable_organization_rls('person_links');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON person_links FROM app_api, app_admin;
--> statement-breakpoint

-- Membre actif de la direction ou de la gestion (permission person_link.manage, packages/shared/permissions.ts).
CREATE FUNCTION person_link_manager(org uuid, member uuid) RETURNS boolean
	LANGUAGE sql STABLE
	SET search_path = pg_catalog, public
AS $$
	SELECT EXISTS (
		SELECT 1 FROM organization_members
		WHERE organization_id = org AND user_id = member AND status = 'active' AND role IN ('director', 'manager')
	)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION person_link_manager(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION person_link_manager(uuid, uuid) TO app_api;
--> statement-breakpoint

CREATE FUNCTION person_links_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	record_phone text;
	account record;
	org record;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF OLD.status = 'revoked' THEN
			RAISE EXCEPTION 'PERSON_LINK_REVOKED: un lien révoqué ne change plus (une nouvelle liaison crée un nouveau lien)' USING ERRCODE = 'P0001';
		END IF;
		IF (NEW.id, NEW.organization_id, NEW.user_id, NEW.record_type, NEW.origin, NEW.phone, NEW.requested_by, NEW.created_at)
				IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.user_id, OLD.record_type, OLD.origin, OLD.phone, OLD.requested_by, OLD.created_at)
			OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
			RAISE EXCEPTION 'PERSON_LINK_IMMUTABLE: la personne, la fiche, l''origine et le numéro d''un lien ne changent pas' USING ERRCODE = 'P0001';
		END IF;
		IF NOT (
			NEW.status = OLD.status
			OR (OLD.status = 'requested' AND NEW.status IN ('active', 'revoked'))
			OR (OLD.status = 'active' AND NEW.status = 'revoked')
		) THEN
			RAISE EXCEPTION 'PERSON_LINK_STATUS: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
		END IF;
		-- Vérification et acceptation : posées une fois, tant que le lien est demandé.
		IF OLD.phone_verified_at IS NOT NULL AND NEW.phone_verified_at IS DISTINCT FROM OLD.phone_verified_at THEN
			RAISE EXCEPTION 'PERSON_LINK_IMMUTABLE: la vérification du numéro ne change plus' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.accepted_by IS NOT NULL AND (NEW.accepted_by, NEW.accepted_at) IS DISTINCT FROM (OLD.accepted_by, OLD.accepted_at) THEN
			RAISE EXCEPTION 'PERSON_LINK_IMMUTABLE: l''acceptation ne change plus' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.status <> 'requested' AND (NEW.phone_verified_at IS DISTINCT FROM OLD.phone_verified_at OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by) THEN
			RAISE EXCEPTION 'PERSON_LINK_IMMUTABLE: un lien actif n''est plus vérifié ni accepté à nouveau' USING ERRCODE = 'P0001';
		END IF;
		NEW.updated_at := now();
	ELSE
		IF NEW.status = 'revoked' THEN
			RAISE EXCEPTION 'PERSON_LINK_STATUS: un lien naît demandé (ou actif pour la propre fiche d''un bailleur)' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.status = 'active' AND NEW.origin <> 'landlord_self' THEN
			RAISE EXCEPTION 'PERSON_LINK_STATUS: un lien naît demandé ; il devient actif après le code et l''acceptation' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.origin = 'person_request' THEN
			-- Réponse 1 du porteur : une demande ne vise qu'une agence vérifiée ; un bailleur particulier invite.
			SELECT type, verification_status INTO org FROM organizations WHERE id = NEW.organization_id;
			IF org.type IS DISTINCT FROM 'agency' OR org.verification_status IS DISTINCT FROM 'verified' THEN
				RAISE EXCEPTION 'PERSON_LINK_REQUEST_ORGANIZATION: une demande de liaison ne vise qu''une agence vérifiée' USING ERRCODE = 'P0001';
			END IF;
			IF NEW.requested_by <> NEW.user_id OR NEW.accepted_by IS NOT NULL THEN
				RAISE EXCEPTION 'PERSON_LINK_REQUEST: la personne demande elle-même ; l''organisation accepte ensuite' USING ERRCODE = 'P0001';
			END IF;
		ELSIF NEW.origin = 'organization_invite' THEN
			IF NOT person_link_manager(NEW.organization_id, NEW.requested_by) THEN
				RAISE EXCEPTION 'PERSON_LINK_MEMBER: seuls la direction et la gestion invitent une personne' USING ERRCODE = 'P0001';
			END IF;
		ELSE
			-- Réponse 2 du porteur : sa propre fiche de bailleur particulier, s'il en est le directeur, à son numéro vérifié.
			SELECT type INTO org FROM organizations WHERE id = NEW.organization_id;
			IF org.type IS DISTINCT FROM 'landlord'
				OR NOT EXISTS (SELECT 1 FROM mandates WHERE organization_id = NEW.organization_id AND owner_id = NEW.owner_id AND type = 'self_managed')
				OR NOT EXISTS (SELECT 1 FROM organization_members WHERE organization_id = NEW.organization_id AND user_id = NEW.user_id
					AND status = 'active' AND role = 'director')
				OR NEW.requested_by <> NEW.user_id OR NEW.accepted_by IS DISTINCT FROM NEW.user_id THEN
				RAISE EXCEPTION 'PERSON_LINK_LANDLORD_SELF: seule la propre fiche d''un bailleur particulier, par son directeur' USING ERRCODE = 'P0001';
			END IF;
		END IF;
	END IF;

	IF NEW.accepted_by IS NOT NULL AND NEW.accepted_by IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.accepted_by END)
		AND NOT person_link_manager(NEW.organization_id, NEW.accepted_by) THEN
		RAISE EXCEPTION 'PERSON_LINK_MEMBER: seuls la direction et la gestion acceptent un lien' USING ERRCODE = 'P0001';
	END IF;

	-- Le numéro du lien est celui de la fiche et celui du compte, à la demande comme à l'activation (point b du porteur).
	IF TG_OP = 'INSERT' OR (NEW.status = 'active' AND OLD.status = 'requested') THEN
		IF NEW.owner_id IS NOT NULL THEN
			SELECT phone INTO record_phone FROM owners WHERE organization_id = NEW.organization_id AND id = NEW.owner_id;
		ELSE
			SELECT phone INTO record_phone FROM tenants WHERE organization_id = NEW.organization_id AND id = NEW.tenant_id;
		END IF;
		IF NOT FOUND THEN
			-- Fiche absente de cette organisation : la clé composite refuse le lien (règle 1).
			RETURN NEW;
		END IF;
		SELECT phone, phone_verified_at INTO account FROM users WHERE id = NEW.user_id;
		IF record_phone IS NULL OR record_phone <> NEW.phone OR account.phone <> NEW.phone THEN
			RAISE EXCEPTION 'LINK_PHONE_MISMATCH: le numéro du compte n''est pas celui de la fiche' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.status = 'active' AND account.phone_verified_at IS NULL THEN
			RAISE EXCEPTION 'LINK_PHONE_MISMATCH: le numéro du compte n''est pas vérifié' USING ERRCODE = 'P0001';
		END IF;
	END IF;

	IF NEW.status = 'revoked' AND NEW.revoked_by_party = 'person' AND NEW.revoked_by IS DISTINCT FROM NEW.user_id THEN
		RAISE EXCEPTION 'PERSON_LINK_REVOKE: la personne ne révoque que ses propres liens' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' AND NEW.revoked_by_party = 'organization'
		AND NOT person_link_manager(NEW.organization_id, NEW.revoked_by) THEN
		RAISE EXCEPTION 'PERSON_LINK_MEMBER: seuls la direction et la gestion révoquent un lien' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER person_links_rules BEFORE INSERT OR UPDATE ON person_links FOR EACH ROW EXECUTE FUNCTION person_links_rules();
--> statement-breakpoint

-- La seule lecture hors organisation du module portals : identifiants des liens actifs de la personne connectée
-- (organisation, type de fiche, fiche), rien d'autre. SECURITY DEFINER, comme due_lease_organizations ; le module ouvre
-- ensuite chaque organisation dans son propre contexte (withOrganization), sous la RLS. Une organisation suspendue reste
-- lisible par ses propriétaires et ses locataires (réponse du porteur au lot 03).
CREATE FUNCTION my_person_links()
	RETURNS TABLE (link_id uuid, organization_id uuid, record_type text, owner_id uuid, tenant_id uuid)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT l.id, l.organization_id, l.record_type, l.owner_id, l.tenant_id
	FROM person_links l
	WHERE l.user_id = current_user_id() AND l.status = 'active'
	ORDER BY l.organization_id, l.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION my_person_links() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION my_person_links() TO app_api;
--> statement-breakpoint

-- ---------------------------------------------------------------- changement de numéro : révocation (réponse 3)

-- Révoque, dans l'organisation du contexte, les liens non révoqués donnés, avec une ligne d'audit chacun.
CREATE FUNCTION person_links_revoke_for_phone(org uuid, link_ids uuid[], reason text, cause text, subject uuid) RETURNS integer
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	link record;
	done integer := 0;
BEGIN
	FOR link IN
		UPDATE person_links SET status = 'revoked', revoked_at = now(), revoked_by_party = 'system', revocation_reason = reason
		WHERE organization_id = org AND id = ANY (link_ids) AND status <> 'revoked'
		RETURNING id, user_id, record_type, owner_id, tenant_id
	LOOP
		INSERT INTO audit_log (id, actor_type, actor_user_id, organization_id, subject_user_id, action, object_type, object_id, before, after, origin)
		VALUES (uuid_v7(), CASE WHEN current_user_id() IS NULL THEN 'system' ELSE 'user' END, current_user_id(), org,
			coalesce(subject, link.user_id), 'person_link.revoke', 'person_link', link.id, NULL,
			jsonb_build_object('status', 'revoked', 'revokedByParty', 'system', 'cause', cause, 'reason', reason,
				'recordType', link.record_type, 'ownerId', link.owner_id, 'tenantId', link.tenant_id),
			'api');
		done := done + 1;
	END LOOP;
	RETURN done;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION person_links_revoke_for_phone(uuid, uuid[], text, text, uuid) FROM PUBLIC;
--> statement-breakpoint

-- Numéro d'une fiche modifié (modification auditée par l'organisation, point b) : ses liens sont révoqués, dans
-- l'organisation de la fiche seulement. SECURITY DEFINER, comme les autres écritures de la base elle-même (versions de
-- bail, mouvements de caution) : une fonction de déclencheur ne s'appelle jamais directement.
CREATE FUNCTION person_links_record_phone_changed() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	PERFORM person_links_revoke_for_phone(
		NEW.organization_id,
		ARRAY(
			SELECT id FROM person_links
			WHERE organization_id = NEW.organization_id AND status <> 'revoked'
				AND (CASE WHEN TG_TABLE_NAME = 'owners' THEN owner_id ELSE tenant_id END) = NEW.id
		),
		'Numéro de la fiche modifié : la liaison est à refaire.',
		'record_phone_changed',
		NULL
	);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION person_links_record_phone_changed() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER owners_phone_revokes_links AFTER UPDATE OF phone ON owners
	FOR EACH ROW WHEN (NEW.phone IS DISTINCT FROM OLD.phone) EXECUTE FUNCTION person_links_record_phone_changed();
--> statement-breakpoint
CREATE TRIGGER tenants_phone_revokes_links AFTER UPDATE OF phone ON tenants
	FOR EACH ROW WHEN (NEW.phone IS DISTINCT FROM OLD.phone) EXECUTE FUNCTION person_links_record_phone_changed();
--> statement-breakpoint

-- Numéro d'un compte modifié (« Mon compte », lot 03) : ses liens sont révoqués dans chaque organisation, l'une après
-- l'autre, chacune dans son propre contexte, avec une ligne d'audit dans chacune. SECURITY DEFINER : la personne
-- modifie son compte hors de toute organisation ; la fonction ne touche que ses propres liens. Le contexte d'origine
-- est rétabli à la fin.
CREATE FUNCTION person_links_account_phone_changed() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	previous text := current_setting('app.organization_id', true);
	org record;
BEGIN
	FOR org IN SELECT DISTINCT organization_id AS id FROM person_links WHERE user_id = NEW.id AND status <> 'revoked' ORDER BY 1 LOOP
		PERFORM set_config('app.organization_id', org.id::text, true);
		PERFORM person_links_revoke_for_phone(
			org.id,
			ARRAY(SELECT id FROM person_links WHERE organization_id = org.id AND user_id = NEW.id AND status <> 'revoked'),
			'Numéro du compte modifié : la liaison est à refaire.',
			'account_phone_changed',
			NEW.id
		);
	END LOOP;
	PERFORM set_config('app.organization_id', coalesce(previous, ''), true);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION person_links_account_phone_changed() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER users_phone_revokes_links AFTER UPDATE OF phone ON users
	FOR EACH ROW WHEN (NEW.phone IS DISTINCT FROM OLD.phone) EXECUTE FUNCTION person_links_account_phone_changed();
--> statement-breakpoint

-- ---------------------------------------------------------------- signalements (réponse 4)

CREATE TABLE maintenance_requests (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	lease_id uuid NOT NULL,
	-- La personne (locataire lié) qui signale, depuis son espace ; jamais synchronisé.
	reported_by uuid NOT NULL REFERENCES users (id),
	title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
	description text NOT NULL CHECK (char_length(description) BETWEEN 5 AND 2000),
	status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'planned', 'done')),
	planned_on date,
	done_at timestamptz,
	-- Mot de l'organisation, visible du locataire (date de passage, artisan).
	status_note text CHECK (char_length(status_note) <= 500),
	handled_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT maintenance_requests_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT maintenance_requests_planned CHECK (status <> 'planned' OR planned_on IS NOT NULL),
	CONSTRAINT maintenance_requests_done CHECK ((status = 'done') = (done_at IS NOT NULL)),
	CONSTRAINT maintenance_requests_handled CHECK (status = 'received' OR handled_by IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX maintenance_requests_by_lease ON maintenance_requests (organization_id, lease_id, created_at DESC);
--> statement-breakpoint
SELECT enable_organization_rls('maintenance_requests');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON maintenance_requests FROM app_api, app_admin;
--> statement-breakpoint
CREATE FUNCTION maintenance_requests_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease_status text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'received' THEN
			RAISE EXCEPTION 'MAINTENANCE_STATUS: un signalement naît reçu' USING ERRCODE = 'P0001';
		END IF;
		-- Seulement pendant le bail : en vigueur ou en préavis.
		SELECT status INTO lease_status FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
		IF NOT FOUND THEN
			-- Bail absent de cette organisation : la clé composite refuse le signalement (règle 1).
			RETURN NEW;
		END IF;
		IF lease_status NOT IN ('active', 'notice') THEN
			RAISE EXCEPTION 'MAINTENANCE_LEASE: un signalement vise un bail en vigueur ou en préavis' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF (NEW.id, NEW.organization_id, NEW.lease_id, NEW.reported_by, NEW.title, NEW.description, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.lease_id, OLD.reported_by, OLD.title, OLD.description, OLD.created_at) THEN
		RAISE EXCEPTION 'MAINTENANCE_IMMUTABLE: un signalement ne se réécrit pas ; seul son suivi change' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'done' THEN
		RAISE EXCEPTION 'MAINTENANCE_STATUS: un signalement fait ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF NOT (NEW.status = OLD.status OR (OLD.status = 'received' AND NEW.status IN ('planned', 'done')) OR (OLD.status = 'planned' AND NEW.status = 'done')) THEN
		RAISE EXCEPTION 'MAINTENANCE_STATUS: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
	END IF;
	IF NEW.handled_by IS NOT NULL AND NEW.handled_by IS DISTINCT FROM OLD.handled_by AND NOT person_link_manager(NEW.organization_id, NEW.handled_by) THEN
		RAISE EXCEPTION 'MAINTENANCE_MEMBER: seuls la direction et la gestion traitent un signalement' USING ERRCODE = 'P0001';
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER maintenance_requests_rules BEFORE INSERT OR UPDATE ON maintenance_requests
	FOR EACH ROW EXECUTE FUNCTION maintenance_requests_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)

-- Signalements : pour la fiche du bail ; les flux ne sélectionnent jamais la personne qui signale (reported_by), comme
-- owners.user_id. person_links n'est jamais publiée.
GRANT SELECT ON maintenance_requests TO app_sync;
--> statement-breakpoint
CREATE POLICY sync_read ON maintenance_requests FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE maintenance_requests;
