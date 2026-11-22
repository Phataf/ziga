-- Lot 10 ter, étape 2 : invitation d'une personne qui n'a pas encore de compte (diagramme de liaison validé, chemin a),
-- vue de ses liens par la personne, et agences proposées à une demande (réponse 1 du porteur).
--
-- - person_links : une invitation naît sans personne, avec l'empreinte SHA-256 de son jeton (`<organisation>.<secret>`,
--   comme les invitations des membres : aucune recherche hors organisation) et sa date d'expiration ; la personne la
--   réclame une fois, avec son compte au numéro de la fiche (vérifié par la base), puis reçoit le code SMS. La personne
--   d'un lien est posée une fois et ne change plus ; un lien actif a toujours sa personne.
-- - my_person_link_overview() : les liens demandés et actifs de la personne connectée, avec le nom de chaque
--   organisation et l'état de la vérification et de l'acceptation ; SECURITY DEFINER, comme my_person_links()
--   (identifiants et nom seulement ; jamais une donnée de la fiche).
-- - link_request_organizations() : les agences vérifiées (identifiant et nom), proposées à une demande de liaison ;
--   jamais un bailleur particulier.

ALTER TABLE person_links ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE person_links ADD COLUMN invite_token_hash bytea UNIQUE, ADD COLUMN invite_expires_at timestamptz, ADD COLUMN claimed_at timestamptz;
--> statement-breakpoint
-- Sans personne : seulement une invitation pas encore réclamée (jamais un lien actif).
ALTER TABLE person_links ADD CONSTRAINT person_links_user CHECK (user_id IS NOT NULL OR (origin = 'organization_invite' AND status <> 'active'));
--> statement-breakpoint
ALTER TABLE person_links ADD CONSTRAINT person_links_invite_token CHECK (origin = 'organization_invite' OR invite_token_hash IS NULL);
--> statement-breakpoint
ALTER TABLE person_links ADD CONSTRAINT person_links_invite_expiry CHECK ((invite_token_hash IS NULL) = (invite_expires_at IS NULL));
--> statement-breakpoint
ALTER TABLE person_links ADD CONSTRAINT person_links_claimed CHECK (claimed_at IS NULL OR (invite_token_hash IS NOT NULL AND user_id IS NOT NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION person_links_rules() RETURNS trigger
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
		IF (NEW.id, NEW.organization_id, NEW.record_type, NEW.origin, NEW.phone, NEW.requested_by, NEW.created_at)
				IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.record_type, OLD.origin, OLD.phone, OLD.requested_by, OLD.created_at)
			OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
			OR NEW.invite_token_hash IS DISTINCT FROM OLD.invite_token_hash OR NEW.invite_expires_at IS DISTINCT FROM OLD.invite_expires_at THEN
			RAISE EXCEPTION 'PERSON_LINK_IMMUTABLE: la personne, la fiche, l''origine et le numéro d''un lien ne changent pas' USING ERRCODE = 'P0001';
		END IF;
		-- Invitation : la personne est posée une fois, quand elle la réclame (son compte, au numéro de la fiche).
		IF OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
			RAISE EXCEPTION 'PERSON_LINK_IMMUTABLE: la personne d''un lien ne change pas' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.user_id IS NULL AND NEW.user_id IS NOT NULL AND (OLD.status <> 'requested' OR NEW.claimed_at IS NULL OR OLD.invite_expires_at <= now()) THEN
			RAISE EXCEPTION 'PERSON_LINK_INVITE: une invitation se réclame une fois, avant son expiration' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
			RAISE EXCEPTION 'PERSON_LINK_IMMUTABLE: une invitation ne se réclame qu''une fois' USING ERRCODE = 'P0001';
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
			-- Sans personne, avec son jeton (la personne la réclame ensuite) ; ou pour un compte déjà connu.
			IF (NEW.user_id IS NULL AND NEW.invite_token_hash IS NULL) OR NEW.claimed_at IS NOT NULL THEN
				RAISE EXCEPTION 'PERSON_LINK_INVITE: une invitation naît avec son jeton ou sa personne, jamais déjà réclamée' USING ERRCODE = 'P0001';
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
	IF TG_OP = 'INSERT' OR (NEW.status = 'active' AND OLD.status = 'requested') OR (OLD.user_id IS NULL AND NEW.user_id IS NOT NULL) THEN
		IF NEW.owner_id IS NOT NULL THEN
			SELECT phone INTO record_phone FROM owners WHERE organization_id = NEW.organization_id AND id = NEW.owner_id;
		ELSE
			SELECT phone INTO record_phone FROM tenants WHERE organization_id = NEW.organization_id AND id = NEW.tenant_id;
		END IF;
		IF NOT FOUND THEN
			-- Fiche absente de cette organisation : la clé composite refuse le lien (règle 1).
			RETURN NEW;
		END IF;
		IF record_phone IS NULL OR record_phone <> NEW.phone THEN
			RAISE EXCEPTION 'LINK_PHONE_MISMATCH: le numéro de la fiche n''est plus celui de la demande' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.user_id IS NULL THEN
			-- Invitation pas encore réclamée : le compte sera vérifié quand la personne la réclamera.
			RETURN NEW;
		END IF;
		SELECT phone, phone_verified_at INTO account FROM users WHERE id = NEW.user_id;
		IF account.phone <> NEW.phone THEN
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

CREATE FUNCTION my_person_link_overview()
	RETURNS TABLE (link_id uuid, organization_id uuid, organization_name text, record_type text, status text, phone_verified boolean,
		accepted boolean, created_at timestamptz)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT l.id, l.organization_id, coalesce(o.trade_name, o.legal_name), l.record_type, l.status, l.phone_verified_at IS NOT NULL,
		l.accepted_by IS NOT NULL, l.created_at
	FROM person_links l
	JOIN organizations o ON o.id = l.organization_id
	WHERE l.user_id = current_user_id() AND l.status IN ('requested', 'active')
	ORDER BY l.created_at DESC, l.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION my_person_link_overview() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION my_person_link_overview() TO app_api;
--> statement-breakpoint

-- Réponse 1 du porteur : noms seulement, à une personne connectée ; jamais un bailleur particulier, jamais une agence
-- non vérifiée ou suspendue.
CREATE FUNCTION link_request_organizations() RETURNS TABLE (id uuid, name text)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT o.id, coalesce(o.trade_name, o.legal_name) FROM organizations o
	WHERE current_user_id() IS NOT NULL AND o.type = 'agency' AND o.verification_status = 'verified'
	ORDER BY 2, 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION link_request_organizations() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION link_request_organizations() TO app_api;
