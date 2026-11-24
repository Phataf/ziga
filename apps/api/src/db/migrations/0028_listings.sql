-- Lot 12 — vitrine publique, annonces et prospects (module listings). Règles 1, 4, 7, 8, 13 et 15 de CLAUDE.md ;
-- D14, D31, D34. Les règles pures sont dans packages/shared/src/listings.ts ; la base applique les siennes, en dernier
-- rempart.
--
-- - organizations : adresse publique (`public_slug`, mots réservés des routes refusés, unique sur la plateforme, une
--   ancienne adresse redirige en 301 vers la nouvelle et n'est jamais reprise par une autre organisation), présentation,
--   accord du bailleur pour afficher son numéro (Q4).
-- - listings : l'annonce d'une unité (location) ou d'un bien entier (vente, D34) ; état interne, en préparation,
--   publiée, suspendue (avec sa cause), retirée (définitivement) ; une seule annonce non retirée par unité et par bien
--   à vendre. Cloisonnée, jamais supprimée, synchronisée.
-- - listing_photos : photos choisies et leur ordre (15 au plus), prises parmi celles de la cible. Le choix se remplace :
--   ces lignes se suppriment, l'annonce garde l'historique dans le journal.
-- - leads : prospects (formulaire de la vitrine, ou échange WhatsApp et appel notés à la main) ; ils n'appartiennent
--   qu'à l'organisation de l'annonce (règle 15). Synchronisés : direction et gestion, agent de terrain pour ceux qui
--   lui sont affectés, jamais le profil lecture.
-- - showcase_listings : projection publique, la seule table que lit la vitrine. Une ligne par annonce publiée, avec
--   les seules colonnes publiques (Q10 : un test compare ses colonnes à une liste autorisée). Écrite par le module
--   listings dans le contexte de l'organisation ; lisible par tous quand elle est visible. Jamais synchronisée.
-- - showcase_organizations() et showcase_organization_by_slug() : ce que la vitrine montre d'une organisation ; jamais
--   le nom d'un bailleur particulier, son numéro seulement avec son accord.
--> statement-breakpoint
-- ---------------------------------------------------------------- organisations : page publique

ALTER TABLE organizations ADD COLUMN public_slug text
	CHECK (
		char_length(public_slug) BETWEEN 3 AND 60
		AND public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
		AND public_slug <> ALL (ARRAY['app', 'espace', 'admin', 'annonce', 'annonces', 'agence', 'agences', 'louer', 'acheter', 'vendre',
			'recherche', 'api', 'media', 'medias', 'static', 'assets', 'fonts', 'sitemap', 'robots', 'favicon', 'manifest', 'service-worker',
			'hors-ligne', 'maintenance', 'connexion', 'inscription', 'compte', 'mot-de-passe', 'recu', 'releve', 'aide', 'contact',
			'mentions-legales', 'confidentialite', 'conditions', 'cgu', 'ziga', 'www']::text[])
	)
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN public_presentation text CHECK (char_length(public_presentation) BETWEEN 1 AND 1500)
--> statement-breakpoint
-- Bailleur particulier : son numéro n'est affiché sur ses annonces qu'avec son accord (Q4). Une agence affiche toujours
-- le sien (numéro professionnel).
ALTER TABLE organizations ADD COLUMN public_phone_visible boolean NOT NULL DEFAULT false
--> statement-breakpoint
CREATE UNIQUE INDEX organizations_public_slug ON organizations (public_slug) WHERE public_slug IS NOT NULL
--> statement-breakpoint
-- Toutes les adresses qu'une organisation a portées : l'ancienne redirige vers l'actuelle (301), aucune autre
-- organisation ne la reprend. Lisible par tous (une adresse publique n'est pas secrète), écrite par la base seule.
CREATE TABLE organization_public_slugs (
	slug text PRIMARY KEY CHECK (char_length(slug) BETWEEN 3 AND 60),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	created_at timestamptz NOT NULL DEFAULT now()
)
--> statement-breakpoint
CREATE INDEX organization_public_slugs_by_organization ON organization_public_slugs (organization_id)
--> statement-breakpoint
SELECT enable_organization_rls('organization_public_slugs')
--> statement-breakpoint
CREATE POLICY public_read ON organization_public_slugs FOR SELECT TO app_api USING (true)
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON organization_public_slugs FROM app_api, app_admin
--> statement-breakpoint
CREATE FUNCTION organizations_public_slug_history() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	holder uuid;
BEGIN
	IF NEW.public_slug IS NULL OR NEW.public_slug IS NOT DISTINCT FROM OLD.public_slug THEN
		RETURN NEW;
	END IF;
	IF NEW.type <> 'agency' THEN
		RAISE EXCEPTION 'PUBLIC_SLUG_AGENCY_ONLY: seule une agence a une page publique' USING ERRCODE = 'P0001';
	END IF;
	SELECT s.organization_id INTO holder FROM organization_public_slugs s WHERE s.slug = NEW.public_slug;
	IF holder IS NOT NULL AND holder <> NEW.id THEN
		RAISE EXCEPTION 'PUBLIC_SLUG_TAKEN: cette adresse est déjà prise' USING ERRCODE = 'P0001';
	END IF;
	IF holder IS NULL THEN
		-- Écrite par le propriétaire du schéma (SECURITY DEFINER, politique schema_owner_insert), jamais par l'API.
		INSERT INTO organization_public_slugs (slug, organization_id) VALUES (NEW.public_slug, NEW.id);
	END IF;
	RETURN NEW;
END;
$$
--> statement-breakpoint
CREATE TRIGGER organizations_public_slug_history BEFORE UPDATE OF public_slug ON organizations
	FOR EACH ROW EXECUTE FUNCTION organizations_public_slug_history()
--> statement-breakpoint
REVOKE ALL ON FUNCTION organizations_public_slug_history() FROM PUBLIC
--> statement-breakpoint
CREATE POLICY schema_owner_insert ON organization_public_slugs FOR INSERT
	WITH CHECK (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'organization_public_slugs'::regclass))
--> statement-breakpoint
-- ---------------------------------------------------------------- annonces

CREATE TABLE listings (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	operation text NOT NULL CHECK (operation IN ('rent', 'sale')),
	property_id uuid NOT NULL,
	-- Location : l'unité ; vente : vide (le bien entier, D34).
	unit_id uuid,
	-- Référence publique (« ZG-7K4M2P »), unique sur la plateforme, reprise dans le message WhatsApp.
	reference text NOT NULL UNIQUE CHECK (reference ~ '^ZG-[0-9A-HJKMNP-TV-Z]{6}$'),
	title text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 100),
	description text CHECK (char_length(description) BETWEEN 1 AND 4000),
	-- Prix affiché, en FCFA entiers (règle 2) : loyer mensuel ou prix de vente.
	price bigint CHECK (price >= 1),
	location_precision text NOT NULL DEFAULT 'neighborhood' CHECK (location_precision IN ('neighborhood', 'exact')),
	visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'pending_review', 'published', 'suspended', 'archived')),
	suspension_reason text CHECK (suspension_reason IN ('unit_rented', 'unit_unavailable', 'mandate_ended', 'organization_not_eligible', 'photos_missing')),
	suspended_at timestamptz,
	archive_reason text CHECK (archive_reason IN ('withdrawn', 'suspension_expired')),
	archived_at timestamptz,
	publication_requested_at timestamptz,
	-- Dernière mise en ligne (tri de la vitrine) et toute première.
	published_at timestamptz,
	first_published_at timestamptz,
	created_by uuid NOT NULL REFERENCES users (id),
	updated_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT listings_property_fk FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
	CONSTRAINT listings_unit_fk FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
	CONSTRAINT listings_target CHECK ((operation = 'rent') = (unit_id IS NOT NULL)),
	CONSTRAINT listings_suspended CHECK ((visibility = 'suspended') = (suspension_reason IS NOT NULL AND suspended_at IS NOT NULL)),
	CONSTRAINT listings_archived CHECK ((visibility = 'archived') = (archive_reason IS NOT NULL AND archived_at IS NOT NULL)),
	CONSTRAINT listings_priced CHECK (visibility IN ('internal', 'archived') OR price IS NOT NULL),
	CONSTRAINT listings_published_at CHECK (visibility <> 'published' OR published_at IS NOT NULL)
)
--> statement-breakpoint
-- Une seule annonce non retirée par unité (location) et par bien (vente).
CREATE UNIQUE INDEX listings_one_per_unit ON listings (organization_id, unit_id) WHERE unit_id IS NOT NULL AND visibility <> 'archived'
--> statement-breakpoint
CREATE UNIQUE INDEX listings_one_sale_per_property ON listings (organization_id, property_id)
	WHERE operation = 'sale' AND visibility <> 'archived'
--> statement-breakpoint
CREATE INDEX listings_by_property ON listings (organization_id, property_id)
--> statement-breakpoint
CREATE INDEX listings_live ON listings (organization_id, visibility) WHERE visibility IN ('pending_review', 'published', 'suspended')
--> statement-breakpoint
SELECT enable_organization_rls('listings')
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON listings FROM app_api, app_admin
--> statement-breakpoint
-- Machine d'états (packages/shared, LISTING_TRANSITIONS), cible et référence figées, dates posées par la base.
CREATE FUNCTION listings_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	allowed text[];
	photos integer;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.visibility <> 'internal' OR NEW.published_at IS NOT NULL OR NEW.first_published_at IS NOT NULL
			OR NEW.publication_requested_at IS NOT NULL THEN
			RAISE EXCEPTION 'LISTING_BORN_INTERNAL: une annonce naît interne' USING ERRCODE = 'P0001';
		END IF;
		IF NOT EXISTS (
			SELECT FROM organization_members m
			WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.created_by AND m.status = 'active'
				AND m.role IN ('director', 'manager')
		) THEN
			RAISE EXCEPTION 'LISTING_AUTHOR: seule la direction ou la gestion crée une annonce' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;

	IF (NEW.id, NEW.organization_id, NEW.operation, NEW.property_id, NEW.unit_id, NEW.reference, NEW.created_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.operation, OLD.property_id, OLD.unit_id, OLD.reference, OLD.created_by, OLD.created_at) THEN
		RAISE EXCEPTION 'LISTING_IMMUTABLE: la cible, l''opération et la référence d''une annonce ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.visibility = 'archived' THEN
		RAISE EXCEPTION 'LISTING_ARCHIVED: une annonce retirée ne change plus' USING ERRCODE = 'P0001';
	END IF;

	IF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
		allowed := CASE OLD.visibility
			WHEN 'internal' THEN ARRAY['pending_review', 'archived']
			WHEN 'pending_review' THEN ARRAY['published', 'internal', 'suspended', 'archived']
			WHEN 'published' THEN ARRAY['suspended', 'archived']
			WHEN 'suspended' THEN ARRAY['pending_review', 'archived']
			ELSE ARRAY[]::text[]
		END;
		IF NOT NEW.visibility = ANY (allowed) THEN
			RAISE EXCEPTION 'LISTING_TRANSITION: passage de % à % refusé', OLD.visibility, NEW.visibility USING ERRCODE = 'P0001';
		END IF;
		IF NEW.visibility = 'pending_review' THEN
			NEW.publication_requested_at := now();
		END IF;
		IF NEW.visibility IN ('pending_review', 'published') THEN
			SELECT count(*) INTO photos FROM listing_photos p
				JOIN media m ON m.organization_id = p.organization_id AND m.id = p.media_id AND m.status = 'ready'
			WHERE p.organization_id = NEW.organization_id AND p.listing_id = NEW.id;
			IF photos < 3 THEN
				RAISE EXCEPTION 'LISTING_PHOTOS: 3 photos au moins pour publier' USING ERRCODE = 'P0001';
			END IF;
		END IF;
		IF NEW.visibility = 'published' THEN
			NEW.published_at := now();
			NEW.first_published_at := coalesce(OLD.first_published_at, NEW.published_at);
		ELSE
			NEW.published_at := OLD.published_at;
			NEW.first_published_at := OLD.first_published_at;
		END IF;
		IF NEW.visibility = 'suspended' THEN
			NEW.suspended_at := now();
		ELSE
			NEW.suspension_reason := NULL;
			NEW.suspended_at := NULL;
		END IF;
		IF NEW.visibility = 'archived' THEN
			NEW.archived_at := now();
		END IF;
	ELSE
		-- Sans changement d'état, les dates d'état ne bougent pas.
		IF (NEW.suspension_reason, NEW.suspended_at, NEW.archive_reason, NEW.archived_at, NEW.published_at, NEW.first_published_at,
			NEW.publication_requested_at) IS DISTINCT FROM (OLD.suspension_reason, OLD.suspended_at, OLD.archive_reason, OLD.archived_at,
			OLD.published_at, OLD.first_published_at, OLD.publication_requested_at) THEN
			RAISE EXCEPTION 'LISTING_STATE_FIELDS: l''état d''une annonce ne change que par une transition' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$
--> statement-breakpoint
CREATE TRIGGER listings_rules BEFORE INSERT OR UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION listings_rules()
--> statement-breakpoint
-- ---------------------------------------------------------------- photos d'une annonce

CREATE TABLE listing_photos (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	listing_id uuid NOT NULL,
	media_id uuid NOT NULL,
	position smallint NOT NULL CHECK (position BETWEEN 0 AND 14),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT listing_photos_listing_fk FOREIGN KEY (organization_id, listing_id) REFERENCES listings (organization_id, id),
	CONSTRAINT listing_photos_media_fk FOREIGN KEY (organization_id, media_id) REFERENCES media (organization_id, id),
	CONSTRAINT listing_photos_once UNIQUE (organization_id, listing_id, media_id),
	CONSTRAINT listing_photos_position UNIQUE (organization_id, listing_id, position) DEFERRABLE INITIALLY DEFERRED
)
--> statement-breakpoint
SELECT enable_organization_rls('listing_photos')
--> statement-breakpoint
REVOKE TRUNCATE ON listing_photos FROM app_api, app_admin
--> statement-breakpoint
-- Une photo d'annonce est une photo prête de sa cible : pour une location, l'unité ou les parties communes du bien ;
-- pour une vente, le bien et ses unités. Le choix d'une annonce retirée ne change plus.
CREATE FUNCTION listing_photos_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	l listings%ROWTYPE;
	m media%ROWTYPE;
BEGIN
	SELECT * INTO l FROM listings WHERE organization_id = coalesce(NEW.organization_id, OLD.organization_id)
		AND id = coalesce(NEW.listing_id, OLD.listing_id);
	IF l.visibility = 'archived' THEN
		RAISE EXCEPTION 'LISTING_ARCHIVED: une annonce retirée ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	IF TG_OP = 'UPDATE' AND (NEW.listing_id, NEW.media_id, NEW.organization_id) IS DISTINCT FROM (OLD.listing_id, OLD.media_id, OLD.organization_id) THEN
		RAISE EXCEPTION 'LISTING_PHOTO_IMMUTABLE: seul l''ordre d''une photo change' USING ERRCODE = 'P0001';
	END IF;
	SELECT * INTO m FROM media WHERE organization_id = NEW.organization_id AND id = NEW.media_id;
	IF m.status <> 'ready' THEN
		RAISE EXCEPTION 'LISTING_PHOTO_NOT_READY: seule une photo prête entre dans une annonce' USING ERRCODE = 'P0001';
	END IF;
	IF m.property_id <> l.property_id OR (l.operation = 'rent' AND m.unit_id IS NOT NULL AND m.unit_id <> l.unit_id) THEN
		RAISE EXCEPTION 'LISTING_PHOTO_TARGET: la photo n''est pas celle du logement de l''annonce' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$
--> statement-breakpoint
CREATE TRIGGER listing_photos_rules BEFORE INSERT OR UPDATE OR DELETE ON listing_photos FOR EACH ROW EXECUTE FUNCTION listing_photos_rules()
--> statement-breakpoint
-- ---------------------------------------------------------------- prospects

CREATE TABLE leads (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	listing_id uuid,
	source text NOT NULL CHECK (source IN ('form', 'whatsapp', 'call')),
	name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
	phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
	-- Messages du visiteur ; un nouvel envoi du même numéro sur la même annonce en moins de 24 heures s'y ajoute.
	message text CHECK (char_length(message) BETWEEN 1 AND 4000),
	status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'visit_planned', 'no_follow_up', 'converted')),
	assigned_member_id uuid,
	notes text CHECK (char_length(notes) BETWEEN 1 AND 2000),
	-- Vide pour un envoi de la vitrine ; sinon, le membre qui a noté le prospect.
	created_by uuid REFERENCES users (id),
	last_contact_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT leads_listing_fk FOREIGN KEY (organization_id, listing_id) REFERENCES listings (organization_id, id),
	CONSTRAINT leads_assigned_fk FOREIGN KEY (organization_id, assigned_member_id) REFERENCES organization_members (organization_id, user_id),
	CONSTRAINT leads_form CHECK ((source = 'form') = (created_by IS NULL)),
	CONSTRAINT leads_form_listing CHECK (source <> 'form' OR listing_id IS NOT NULL)
)
--> statement-breakpoint
CREATE INDEX leads_by_date ON leads (organization_id, created_at DESC)
--> statement-breakpoint
CREATE INDEX leads_duplicates ON leads (organization_id, listing_id, phone, created_at DESC) WHERE listing_id IS NOT NULL
--> statement-breakpoint
CREATE INDEX leads_by_agent ON leads (organization_id, assigned_member_id) WHERE assigned_member_id IS NOT NULL
--> statement-breakpoint
SELECT enable_organization_rls('leads')
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON leads FROM app_api, app_admin
--> statement-breakpoint
-- Statuts (packages/shared, LEAD_TRANSITIONS) ; affecté à un membre actif ; source, annonce et auteur figés.
CREATE FUNCTION leads_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	allowed text[];
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'new' THEN
			RAISE EXCEPTION 'LEAD_BORN_NEW: un prospect naît « nouveau »' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.created_by IS NOT NULL AND NOT EXISTS (
			SELECT FROM organization_members m
			WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.created_by AND m.status = 'active'
				AND m.role IN ('director', 'manager', 'field_agent')
		) THEN
			RAISE EXCEPTION 'LEAD_AUTHOR: seul un membre qui suit les prospects en note un' USING ERRCODE = 'P0001';
		END IF;
	ELSE
		IF (NEW.id, NEW.organization_id, NEW.listing_id, NEW.source, NEW.created_by, NEW.created_at)
			IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.listing_id, OLD.source, OLD.created_by, OLD.created_at) THEN
			RAISE EXCEPTION 'LEAD_IMMUTABLE: l''annonce, la source et l''auteur d''un prospect ne changent pas' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.status IS DISTINCT FROM OLD.status THEN
			allowed := CASE OLD.status
				WHEN 'new' THEN ARRAY['contacted', 'visit_planned', 'no_follow_up', 'converted']
				WHEN 'contacted' THEN ARRAY['visit_planned', 'no_follow_up', 'converted']
				WHEN 'visit_planned' THEN ARRAY['contacted', 'no_follow_up', 'converted']
				WHEN 'no_follow_up' THEN ARRAY['contacted']
				WHEN 'converted' THEN ARRAY['contacted']
				ELSE ARRAY[]::text[]
			END;
			IF NOT NEW.status = ANY (allowed) THEN
				RAISE EXCEPTION 'LEAD_TRANSITION: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
			END IF;
		END IF;
		NEW.updated_at := now();
	END IF;
	IF NEW.assigned_member_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.assigned_member_id IS DISTINCT FROM OLD.assigned_member_id)
		AND NOT EXISTS (
			SELECT FROM organization_members m
			WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.assigned_member_id AND m.status = 'active'
				AND m.role IN ('director', 'manager', 'field_agent')
		) THEN
		RAISE EXCEPTION 'LEAD_ASSIGNEE: un prospect s''affecte à un membre actif qui suit les prospects' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$
--> statement-breakpoint
CREATE TRIGGER leads_rules BEFORE INSERT OR UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION leads_rules()
--> statement-breakpoint
-- ---------------------------------------------------------------- projection publique de la vitrine

CREATE TABLE showcase_listings (
	listing_id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	organization_type text NOT NULL CHECK (organization_type IN ('agency', 'landlord')),
	reference text NOT NULL UNIQUE,
	path_segment text NOT NULL CHECK (path_segment ~ '^([a-z0-9]+(-[a-z0-9]+)*-)?zg-[0-9a-hjkmnp-tv-z]{6}$'),
	operation text NOT NULL CHECK (operation IN ('rent', 'sale')),
	title text NOT NULL,
	description text,
	price bigint NOT NULL CHECK (price >= 1),
	commune_id text NOT NULL REFERENCES communes (id),
	neighborhood_id uuid,
	-- Point publié : centre du quartier (ou de la commune), le point du bien seulement en précision « exacte ».
	point_lat double precision NOT NULL CHECK (point_lat BETWEEN -90 AND 90),
	point_lng double precision NOT NULL CHECK (point_lng BETWEEN -180 AND 180),
	point_precision text NOT NULL CHECK (point_precision IN ('exact', 'neighborhood', 'commune')),
	-- Location : type d'unité ; vente : type de bien.
	unit_type text,
	property_type text NOT NULL,
	bedrooms smallint,
	living_rooms smallint,
	bathrooms smallint,
	surface_m2 integer,
	land_area_m2 integer,
	furnished boolean,
	amenities text[] NOT NULL DEFAULT '{}',
	charges bigint CHECK (charges >= 0),
	deposit_amount bigint CHECK (deposit_amount >= 0),
	advance_months smallint CHECK (advance_months BETWEEN 0 AND 24),
	-- Location en préavis : « Libre le » (lendemain de la fin du bail).
	available_from date,
	-- Vente d'un bien dont une unité a un bail : « Vente occupée », sans autre détail (D34).
	sale_occupied boolean,
	declared_land_documents text[] NOT NULL DEFAULT '{}',
	-- Photos publiées, dans l'ordre : [{ "key": variants_key, "width": …, "height": … }]. Ni légende, ni original.
	photos jsonb NOT NULL CHECK (jsonb_typeof(photos) = 'array' AND jsonb_array_length(photos) BETWEEN 3 AND 15),
	og_image_key text CHECK (og_image_key ~ '^[A-Za-z0-9_-]{22,64}$'),
	published_at timestamptz NOT NULL,
	-- Masquée sans être retirée : interrupteur `listings.publication` coupé, organisation suspendue.
	visible boolean NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT showcase_listings_listing_fk FOREIGN KEY (organization_id, listing_id) REFERENCES listings (organization_id, id),
	CONSTRAINT showcase_listings_neighborhood_fk FOREIGN KEY (commune_id, neighborhood_id) REFERENCES neighborhoods (commune_id, id),
	CONSTRAINT showcase_listings_rent CHECK (operation <> 'rent' OR (unit_type IS NOT NULL AND sale_occupied IS NULL)),
	CONSTRAINT showcase_listings_sale CHECK (operation <> 'sale' OR (unit_type IS NULL AND available_from IS NULL AND sale_occupied IS NOT NULL))
)
--> statement-breakpoint
CREATE INDEX showcase_recent ON showcase_listings (operation, published_at DESC, listing_id DESC) WHERE visible
--> statement-breakpoint
CREATE INDEX showcase_by_place ON showcase_listings (operation, commune_id, neighborhood_id, published_at DESC, listing_id DESC) WHERE visible
--> statement-breakpoint
CREATE INDEX showcase_by_price ON showcase_listings (operation, price) WHERE visible
--> statement-breakpoint
CREATE INDEX showcase_by_type ON showcase_listings (operation, unit_type, property_type) WHERE visible
--> statement-breakpoint
CREATE INDEX showcase_by_organization ON showcase_listings (organization_id, published_at DESC) WHERE visible
--> statement-breakpoint
-- Écriture et lecture complète dans le contexte de l'organisation ; lecture publique des seules lignes visibles.
SELECT enable_organization_rls('showcase_listings')
--> statement-breakpoint
CREATE POLICY public_read ON showcase_listings FOR SELECT TO app_api USING (visible)
--> statement-breakpoint
REVOKE TRUNCATE ON showcase_listings FROM app_api, app_admin
--> statement-breakpoint
REVOKE ALL ON showcase_listings FROM app_admin
--> statement-breakpoint
-- Ce que la vitrine montre des organisations : jamais le nom, l'adresse ni la page d'un bailleur particulier ; son
-- numéro seulement avec son accord (Q4) ; jamais le représentant légal ni les identifiants.
CREATE FUNCTION showcase_organizations(ids uuid[])
	RETURNS TABLE (
		id uuid, type text, display_name text, public_slug text, public_presentation text, verified boolean, suspended boolean,
		phone text, logo_id uuid
	)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT o.id, o.type,
		CASE WHEN o.type = 'agency' THEN coalesce(o.trade_name, o.legal_name) END,
		CASE WHEN o.type = 'agency' THEN o.public_slug END,
		CASE WHEN o.type = 'agency' THEN o.public_presentation END,
		o.type = 'agency' AND o.verification_status = 'verified',
		o.verification_status = 'suspended',
		CASE WHEN o.type = 'agency' OR o.public_phone_visible THEN o.phone END,
		CASE WHEN o.type = 'agency' THEN o.logo_id END
	FROM organizations o
	WHERE o.id = ANY (ids)
$$
--> statement-breakpoint
-- Page d'une agence par son adresse, actuelle ou ancienne (`canonical_slug` : l'actuelle, pour la redirection 301).
CREATE FUNCTION showcase_organization_by_slug(slug text)
	RETURNS TABLE (
		id uuid, type text, display_name text, public_slug text, public_presentation text, verified boolean, suspended boolean,
		phone text, logo_id uuid
	)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT so.*
	FROM organization_public_slugs s
	CROSS JOIN LATERAL showcase_organizations(ARRAY[s.organization_id]) so
	WHERE s.slug = showcase_organization_by_slug.slug AND so.type = 'agency' AND so.public_slug IS NOT NULL
$$
--> statement-breakpoint
REVOKE ALL ON FUNCTION showcase_organizations(uuid[]) FROM PUBLIC
--> statement-breakpoint
REVOKE ALL ON FUNCTION showcase_organization_by_slug(text) FROM PUBLIC
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION showcase_organizations(uuid[]) TO app_api
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION showcase_organization_by_slug(text) TO app_api
--> statement-breakpoint
-- Tâche de nuit (retrait au bout de 30 jours, rattrapage) : les organisations qui ont une annonce vivante, sans rien
-- d'autre (même modèle que due_mandate_organizations).
CREATE FUNCTION listing_organizations()
	RETURNS TABLE (organization_id uuid)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT DISTINCT l.organization_id FROM listings l WHERE l.visibility IN ('pending_review', 'published', 'suspended')
$$
--> statement-breakpoint
REVOKE ALL ON FUNCTION listing_organizations() FROM PUBLIC
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION listing_organizations() TO app_api
--> statement-breakpoint
-- La fonction lit toutes les organisations : seulement dans la fonction, propriétaire du schéma (RLS forcée).
CREATE POLICY schema_owner_listings ON listings FOR SELECT
	USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'listings'::regclass))
--> statement-breakpoint
CREATE POLICY schema_owner_directory ON organization_public_slugs FOR SELECT
	USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'organization_public_slugs'::regclass))
--> statement-breakpoint
-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)

GRANT SELECT ON listings, listing_photos, leads TO app_sync
--> statement-breakpoint
CREATE POLICY sync_read ON listings FOR SELECT TO app_sync USING (true)
--> statement-breakpoint
CREATE POLICY sync_read ON listing_photos FOR SELECT TO app_sync USING (true)
--> statement-breakpoint
CREATE POLICY sync_read ON leads FOR SELECT TO app_sync USING (true)
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE listings, listing_photos, leads
