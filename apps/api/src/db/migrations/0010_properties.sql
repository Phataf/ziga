-- Lot 07 — biens, unités, photos (module properties) et registre des documents privés (module documents).
-- Décisions D14, D16, D22 ; règles 1, 11, 12 et 13 de CLAUDE.md.
--
-- - properties : le bien, son propriétaire, sa localisation (commune et quartier du référentiel, repère, point GPS pris
--   sur place, jamais publié), ses documents fonciers déclarés ; fiche brouillon, active ou archivée.
-- - units : statut en quatre dimensions (D14). Seuls la fiche et l'état technique sont stockés ; l'occupation est
--   calculée à partir des baux (packages/shared, occupancyOf), elle n'a pas de colonne. Agent de terrain affecté
--   facultatif : un membre actif de l'organisation, au rôle agent de terrain.
-- - media : photos d'un bien ou d'une unité, 15 au plus par objet (trigger, verrou de l'objet).
-- - documents : pièces privées, versions jamais écrasées (une version remplace la précédente, avec son empreinte),
--   restriction facultative qui ne fait que réduire la matrice par type.
-- - mandate_scopes (lot 06) : clés composites vers les biens et les unités ; règle 12 tenue dans les deux sens : une
--   unité créée dans un bien couvert reçoit sa portée, un mandat posé sur un bien couvre ses unités existantes.
-- Chaque table : organization_id, RLS d'organisation, clés composites, jamais supprimée, publiée vers PowerSync.

-- ---------------------------------------------------------------- biens

CREATE TABLE properties (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	owner_id uuid NOT NULL,
	type text NOT NULL CHECK (type IN ('house', 'apartment_building', 'shared_compound', 'commercial', 'land')),
	operation text NOT NULL DEFAULT 'rent' CHECK (operation IN ('rent', 'sale', 'both')),
	-- Nom interne (« Villa Ouédraogo, Tampouy ») : jamais publié.
	name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
	-- Localisation : facultative en brouillon (l'assistant enregistre chaque étape), exigée ensuite.
	commune_id text REFERENCES communes (id),
	neighborhood_id uuid,
	-- Adresse ou repère (« derrière la pharmacie… »).
	address_hint text CHECK (char_length(address_hint) <= 300),
	-- Point GPS pris sur place : facultatif, jamais publié tel quel (publicLocation).
	gps_lat double precision CHECK (gps_lat BETWEEN -90 AND 90),
	gps_lng double precision CHECK (gps_lng BETWEEN -180 AND 180),
	gps_accuracy_m integer CHECK (gps_accuracy_m BETWEEN 0 AND 100000),
	-- Documents fonciers déclarés ; vide : non renseigné ; « none » (aucun) exclut les autres.
	declared_land_documents text[] NOT NULL DEFAULT '{}',
	notes text CHECK (char_length(notes) <= 2000),
	record_status text NOT NULL DEFAULT 'draft' CHECK (record_status IN ('draft', 'active', 'archived')),
	archived_at timestamptz,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	-- Clé composite : un bien ne peut pas viser le propriétaire d'une autre organisation.
	CONSTRAINT properties_owner_fk FOREIGN KEY (organization_id, owner_id) REFERENCES owners (organization_id, id),
	-- Le quartier appartient à la commune du bien.
	CONSTRAINT properties_neighborhood_fk FOREIGN KEY (commune_id, neighborhood_id) REFERENCES neighborhoods (commune_id, id),
	CONSTRAINT properties_neighborhood_commune CHECK (neighborhood_id IS NULL OR commune_id IS NOT NULL),
	CONSTRAINT properties_located CHECK (record_status = 'draft' OR (commune_id IS NOT NULL AND neighborhood_id IS NOT NULL)),
	CONSTRAINT properties_gps CHECK ((gps_lat IS NULL) = (gps_lng IS NULL) AND (gps_accuracy_m IS NULL OR gps_lat IS NOT NULL)),
	CONSTRAINT properties_land_documents CHECK (
		declared_land_documents <@ ARRAY['apfr', 'allocation_certificate', 'puh', 'title_deed', 'none']::text[]
		AND (NOT ('none' = ANY (declared_land_documents)) OR declared_land_documents = ARRAY['none']::text[])
	),
	CONSTRAINT properties_archived CHECK ((record_status = 'archived') = (archived_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX properties_by_owner ON properties (organization_id, owner_id);
--> statement-breakpoint
CREATE INDEX properties_by_neighborhood ON properties (organization_id, neighborhood_id);
--> statement-breakpoint
SELECT enable_organization_rls('properties');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON properties FROM app_api, app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- unités

CREATE TABLE units (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	property_id uuid NOT NULL,
	type text NOT NULL CHECK (type IN ('room_lounge', 'single_room', 'celibatorium', 'studio', 'apartment', 'mini_villa', 'villa', 'duplex',
		'shop', 'office', 'store', 'warehouse', 'other')),
	label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80 AND label = btrim(label)),
	-- Pièces détaillées. La clôture et le garage sont des équipements (amenities), saisis une seule fois.
	bedrooms smallint NOT NULL DEFAULT 0 CHECK (bedrooms BETWEEN 0 AND 50),
	living_rooms smallint NOT NULL DEFAULT 0 CHECK (living_rooms BETWEEN 0 AND 50),
	kitchens smallint NOT NULL DEFAULT 0 CHECK (kitchens BETWEEN 0 AND 50),
	bathrooms smallint NOT NULL DEFAULT 0 CHECK (bathrooms BETWEEN 0 AND 50),
	terraces smallint NOT NULL DEFAULT 0 CHECK (terraces BETWEEN 0 AND 50),
	laundries smallint NOT NULL DEFAULT 0 CHECK (laundries BETWEEN 0 AND 50),
	surface_m2 integer CHECK (surface_m2 BETWEEN 1 AND 100000),
	land_area_m2 integer CHECK (land_area_m2 BETWEEN 1 AND 10000000),
	usage text NOT NULL DEFAULT 'residential' CHECK (usage IN ('residential', 'professional', 'mixed')),
	-- Meublé : une caractéristique, pas un type (inventaire dans l'état des lieux, lot 10 bis).
	furnished boolean NOT NULL DEFAULT false,
	amenities text[] NOT NULL DEFAULT '{}' CHECK (amenities <@ ARRAY['fence', 'guard', 'separate_water_meter', 'separate_electricity_meter',
		'air_conditioning', 'fans', 'garage', 'running_water', 'borehole', 'water_tower', 'equipped_kitchen', 'generator', 'indoor_shower',
		'indoor_toilet', 'paved_road_access', 'yard_or_parking']::text[]),
	-- Montants proposés, en FCFA entiers (règle 2) ; l'avance en nombre de mois de loyer.
	rent bigint CHECK (rent >= 0),
	charges bigint CHECK (charges >= 0),
	deposit_amount bigint CHECK (deposit_amount >= 0),
	advance_months smallint CHECK (advance_months BETWEEN 0 AND 24),
	-- Agent de terrain affecté (facultatif) : membre de la même organisation (clé composite), rôle vérifié par trigger.
	assigned_agent_id uuid,
	-- Dimensions saisies du statut (D14) ; l'occupation n'est pas une colonne : elle se calcule à partir des baux.
	record_status text NOT NULL DEFAULT 'draft' CHECK (record_status IN ('draft', 'active', 'archived')),
	archived_at timestamptz,
	technical_status text NOT NULL DEFAULT 'ready' CHECK (technical_status IN ('ready', 'to_refurbish', 'under_works', 'unavailable')),
	technical_reason text CHECK (char_length(technical_reason) BETWEEN 3 AND 500),
	technical_expected_on date,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	-- Cible des clés (bien, unité) : une portée, une photo ou un document ne peut viser l'unité d'un autre bien.
	UNIQUE (organization_id, property_id, id),
	CONSTRAINT units_property_fk FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
	CONSTRAINT units_agent_fk FOREIGN KEY (organization_id, assigned_agent_id) REFERENCES organization_members (organization_id, user_id),
	-- Motif obligatoire hors « prête » ; date prévue facultative, seulement hors « prête ».
	CONSTRAINT units_technical_reason CHECK ((technical_status = 'ready') = (technical_reason IS NULL)),
	CONSTRAINT units_technical_expected CHECK (technical_status <> 'ready' OR technical_expected_on IS NULL),
	CONSTRAINT units_archived CHECK ((record_status = 'archived') = (archived_at IS NOT NULL))
);
--> statement-breakpoint
-- Un libellé par bien (« Appartement A2 »), casse et accents confondus.
CREATE UNIQUE INDEX units_label_per_property ON units (organization_id, property_id, geo_name_key(label));
--> statement-breakpoint
CREATE INDEX units_by_agent ON units (organization_id, assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
--> statement-breakpoint
SELECT enable_organization_rls('units');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON units FROM app_api, app_admin;
--> statement-breakpoint

-- Une unité ne change pas de bien ; l'agent affecté est un membre actif au rôle agent de terrain.
CREATE FUNCTION units_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.property_id IS DISTINCT FROM OLD.property_id THEN
		RAISE EXCEPTION 'UNIT_PROPERTY_IMMUTABLE: une unité ne change pas de bien' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.assigned_agent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id) THEN
		IF NOT EXISTS (
			SELECT FROM organization_members m
			WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.assigned_agent_id
				AND m.status = 'active' AND m.role = 'field_agent'
		) THEN
			RAISE EXCEPTION 'UNIT_AGENT_NOT_FIELD_AGENT: seule une personne active au rôle agent de terrain peut être affectée'
				USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER units_rules BEFORE INSERT OR UPDATE ON units FOR EACH ROW EXECUTE FUNCTION units_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- portées des mandats (règle 12, D16)

-- Clés composites (laissées en attente au lot 06) : une portée vise un bien de l'organisation, et une unité de ce bien.
ALTER TABLE mandate_scopes ADD CONSTRAINT mandate_scopes_property_fk
	FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id);
--> statement-breakpoint
ALTER TABLE mandate_scopes ADD CONSTRAINT mandate_scopes_unit_fk
	FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id);
--> statement-breakpoint
-- Calcul de management_active (lot 06), et désormais : le mandat est celui du propriétaire du bien.
CREATE OR REPLACE FUNCTION mandate_scopes_compute() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	mandate_owner uuid;
	property_owner uuid;
BEGIN
	SELECT m.type IN ('rental_management', 'self_managed') AND m.status = 'active', m.owner_id INTO NEW.management_active, mandate_owner
	FROM mandates m WHERE m.organization_id = NEW.organization_id AND m.id = NEW.mandate_id;
	NEW.management_active := coalesce(NEW.management_active, false);
	IF TG_OP = 'INSERT' THEN
		SELECT p.owner_id INTO property_owner FROM properties p WHERE p.organization_id = NEW.organization_id AND p.id = NEW.property_id;
		-- Bien introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
		IF property_owner IS NOT NULL AND mandate_owner IS DISTINCT FROM property_owner THEN
			RAISE EXCEPTION 'MANDATE_SCOPE_OWNER: un mandat ne couvre que les biens de son propriétaire' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Les deux triggers de portée sont SECURITY DEFINER (comme mandates_record_version, lot 06) : ils n'écrivent que des
-- identifiants tirés de la ligne déclenchante, l'application n'a pas besoin d'exécuter uuid_v7(), et la RLS forcée
-- s'applique au propriétaire de la table : l'organisation de la transaction reste la seule visible.
-- Sens 1 : un mandat posé sur un bien entier couvre chacune de ses unités existantes (lignes via_property). Une unité
-- déjà couverte par un autre mandat de gestion actif fait échouer l'insertion (index du lot 06) : rien n'est posé.
CREATE FUNCTION mandate_scopes_cover_units() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	INSERT INTO mandate_scopes (id, organization_id, mandate_id, property_id, unit_id, via_property)
	SELECT uuid_v7(), NEW.organization_id, NEW.mandate_id, NEW.property_id, u.id, true
	FROM units u
	WHERE u.organization_id = NEW.organization_id AND u.property_id = NEW.property_id
	ORDER BY u.id;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION mandate_scopes_cover_units() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER mandate_scopes_cover_units AFTER INSERT ON mandate_scopes
	FOR EACH ROW WHEN (NEW.unit_id IS NULL) EXECUTE FUNCTION mandate_scopes_cover_units();
--> statement-breakpoint
-- Sens 2 : une unité créée dans un bien couvert par un mandat actif reçoit sa portée, dans la même transaction. Une
-- unité visée directement par un autre mandat ne peut pas exister avant elle : l'insertion reste cohérente.
CREATE FUNCTION units_inherit_scopes() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	INSERT INTO mandate_scopes (id, organization_id, mandate_id, property_id, unit_id, via_property)
	SELECT uuid_v7(), s.organization_id, s.mandate_id, s.property_id, NEW.id, true
	FROM mandate_scopes s
	JOIN mandates m ON m.organization_id = s.organization_id AND m.id = s.mandate_id
	WHERE s.organization_id = NEW.organization_id AND s.property_id = NEW.property_id AND s.unit_id IS NULL AND m.status = 'active'
	ORDER BY s.id;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION units_inherit_scopes() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER units_inherit_scopes AFTER INSERT ON units FOR EACH ROW EXECUTE FUNCTION units_inherit_scopes();
--> statement-breakpoint
-- Changer le propriétaire d'un bien couvert par un mandat de gestion actif romprait la règle 12 : refusé.
CREATE FUNCTION properties_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF NEW.owner_id IS DISTINCT FROM OLD.owner_id AND EXISTS (
		SELECT FROM mandate_scopes s WHERE s.organization_id = NEW.organization_id AND s.property_id = NEW.id AND s.management_active
	) THEN
		RAISE EXCEPTION 'PROPERTY_OWNER_LOCKED: le propriétaire d''un bien sous mandat de gestion actif ne change pas' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER properties_rules BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION properties_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- photos

CREATE TABLE media (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	property_id uuid NOT NULL,
	-- Vide : photo du bien ; sinon, photo de l'unité.
	unit_id uuid,
	kind text NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo')),
	-- Type et taille annoncés par l'appareil (10 Mo au plus) ; la tâche vérifie le fichier réel.
	mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
	byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
	position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
	caption text CHECK (char_length(caption) <= 200),
	-- Original : clé décidée par le serveur, jamais servie publiquement, effacée après traitement.
	storage_key text UNIQUE CHECK (char_length(storage_key) BETWEEN 10 AND 300),
	-- Variantes WebP : servies sous une clé aléatoire d'au moins 128 bits, distincte de l'identifiant.
	variants_key text UNIQUE CHECK (variants_key ~ '^[A-Za-z0-9_-]{22,64}$'),
	width integer CHECK (width > 0),
	height integer CHECK (height > 0),
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'rejected', 'removed')),
	error text CHECK (char_length(error) <= 500),
	uploaded_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	uploaded_at timestamptz,
	processed_at timestamptz,
	removed_at timestamptz,
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT media_property_fk FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
	CONSTRAINT media_unit_fk FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
	CONSTRAINT media_ready CHECK (status <> 'ready' OR (variants_key IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL)),
	CONSTRAINT media_rejected CHECK (status <> 'rejected' OR error IS NOT NULL),
	CONSTRAINT media_removed CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX media_by_object ON media (organization_id, property_id, unit_id, position);
--> statement-breakpoint
SELECT enable_organization_rls('media');
--> statement-breakpoint
-- Une photo retirée garde sa ligne (status removed) ; ses fichiers sont effacés par la tâche (lot 07, étape 3).
REVOKE DELETE, TRUNCATE ON media FROM app_api, app_admin;
--> statement-breakpoint
-- Quota : 15 photos au plus par unité (et par bien), hors photos refusées ou retirées. Le verrou de l'objet sérialise
-- deux envois simultanés : le quota ne peut pas être dépassé par une course.
CREATE FUNCTION media_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	kept integer;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW.property_id IS DISTINCT FROM OLD.property_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
			RAISE EXCEPTION 'MEDIA_OBJECT_IMMUTABLE: une photo ne change pas d''objet' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.storage_key IS NOT NULL AND NEW.storage_key IS DISTINCT FROM OLD.storage_key THEN
			RAISE EXCEPTION 'MEDIA_STORAGE_KEY_IMMUTABLE: la clé de stockage d''une photo est fixée une fois' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.status IN ('rejected', 'removed') AND NEW.status IS DISTINCT FROM OLD.status THEN
			RAISE EXCEPTION 'MEDIA_FINAL: une photo refusée ou retirée le reste' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.status IN ('rejected', 'removed') THEN
		RETURN NEW;
	END IF;
	IF NEW.unit_id IS NOT NULL THEN
		PERFORM 1 FROM units WHERE organization_id = NEW.organization_id AND id = NEW.unit_id FOR UPDATE;
	ELSE
		PERFORM 1 FROM properties WHERE organization_id = NEW.organization_id AND id = NEW.property_id FOR UPDATE;
	END IF;
	SELECT count(*) INTO kept FROM media
	WHERE organization_id = NEW.organization_id AND property_id = NEW.property_id AND unit_id IS NOT DISTINCT FROM NEW.unit_id
		AND status NOT IN ('rejected', 'removed');
	IF kept >= 15 THEN
		RAISE EXCEPTION 'MEDIA_QUOTA: 15 photos au plus par unité' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER media_rules BEFORE INSERT OR UPDATE ON media FOR EACH ROW EXECUTE FUNCTION media_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- documents privés (D22, règle 11)

CREATE TABLE documents (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	type text NOT NULL CHECK (type IN ('title_deed', 'puh', 'allocation_certificate', 'apfr', 'owner_identity', 'mandate', 'document_photo',
		'other')),
	-- Objets liés (au moins un) ; bail, contrat et locataire au lot 08 bis.
	owner_id uuid,
	mandate_id uuid,
	property_id uuid,
	unit_id uuid,
	version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
	-- Version précédente, remplacée par celle-ci (jamais écrasée).
	replaces_id uuid,
	file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
	mime_type text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
	byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
	-- Empreinte SHA-256 du fichier reçu, calculée par le serveur.
	sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	-- Clé décidée par le serveur ; jamais servie publiquement : lecture par URL signée de 5 minutes seulement.
	storage_key text NOT NULL UNIQUE CHECK (char_length(storage_key) BETWEEN 10 AND 300),
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'replaced', 'withdrawn', 'rejected')),
	-- Restriction de l'organisation : ne fait que réduire la matrice par type (packages/shared, canReadDocument).
	restriction text CHECK (restriction IN ('director_only')),
	error text CHECK (char_length(error) <= 500),
	uploaded_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	activated_at timestamptz,
	replaced_at timestamptz,
	withdrawn_at timestamptz,
	withdrawn_by uuid REFERENCES users (id),
	withdrawal_reason text CHECK (char_length(withdrawal_reason) BETWEEN 5 AND 500),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT documents_owner_fk FOREIGN KEY (organization_id, owner_id) REFERENCES owners (organization_id, id),
	CONSTRAINT documents_mandate_fk FOREIGN KEY (organization_id, mandate_id) REFERENCES mandates (organization_id, id),
	CONSTRAINT documents_property_fk FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
	CONSTRAINT documents_unit_fk FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
	CONSTRAINT documents_replaces_fk FOREIGN KEY (organization_id, replaces_id) REFERENCES documents (organization_id, id),
	CONSTRAINT documents_subject CHECK (num_nonnulls(owner_id, mandate_id, property_id) >= 1),
	CONSTRAINT documents_unit_property CHECK (unit_id IS NULL OR property_id IS NOT NULL),
	CONSTRAINT documents_version CHECK ((replaces_id IS NULL) = (version = 1)),
	CONSTRAINT documents_fingerprint CHECK (status IN ('pending', 'rejected') OR sha256 IS NOT NULL),
	CONSTRAINT documents_activated CHECK (status IN ('pending', 'rejected') OR activated_at IS NOT NULL),
	CONSTRAINT documents_replaced CHECK ((status = 'replaced') = (replaced_at IS NOT NULL)),
	CONSTRAINT documents_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdrawal_reason IS NOT NULL)),
	CONSTRAINT documents_rejected CHECK (status <> 'rejected' OR error IS NOT NULL)
);
--> statement-breakpoint
-- Une version n'est remplacée qu'une fois : l'historique est une chaîne.
CREATE UNIQUE INDEX documents_replaced_once ON documents (organization_id, replaces_id) WHERE replaces_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX documents_by_property ON documents (organization_id, property_id) WHERE property_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX documents_by_owner ON documents (organization_id, owner_id) WHERE owner_id IS NOT NULL;
--> statement-breakpoint
SELECT enable_organization_rls('documents');
--> statement-breakpoint
-- Rien n'est supprimé automatiquement (durée de conservation : question ouverte) ; un document se retire.
REVOKE DELETE, TRUNCATE ON documents FROM app_api, app_admin;
--> statement-breakpoint
-- Une version est figée : son fichier, son empreinte, son type et ses liens ne changent plus ; son statut avance
-- seulement (en attente, puis active ou refusée ; active, puis remplacée ou retirée ; remplacée, puis retirée).
CREATE FUNCTION documents_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	previous documents%ROWTYPE;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'pending' THEN
			RAISE EXCEPTION 'DOCUMENT_BORN_PENDING: un document naît en attente de son fichier' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.replaces_id IS NOT NULL THEN
			SELECT * INTO previous FROM documents WHERE organization_id = NEW.organization_id AND id = NEW.replaces_id;
			IF previous.status IS DISTINCT FROM 'active' THEN
				RAISE EXCEPTION 'DOCUMENT_REPLACES_ACTIVE: seule la version en vigueur peut être remplacée' USING ERRCODE = 'P0001';
			END IF;
			IF NEW.type IS DISTINCT FROM previous.type OR NEW.owner_id IS DISTINCT FROM previous.owner_id
				OR NEW.mandate_id IS DISTINCT FROM previous.mandate_id OR NEW.property_id IS DISTINCT FROM previous.property_id
				OR NEW.unit_id IS DISTINCT FROM previous.unit_id THEN
				RAISE EXCEPTION 'DOCUMENT_VERSION_SUBJECT: une nouvelle version garde le type et les objets liés' USING ERRCODE = 'P0001';
			END IF;
			IF NEW.version <> previous.version + 1 THEN
				RAISE EXCEPTION 'DOCUMENT_VERSION: la nouvelle version est la %', previous.version + 1 USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	IF ROW(NEW.type, NEW.owner_id, NEW.mandate_id, NEW.property_id, NEW.unit_id, NEW.version, NEW.replaces_id, NEW.file_name, NEW.mime_type,
			NEW.byte_size, NEW.storage_key, NEW.uploaded_by, NEW.created_at)
		IS DISTINCT FROM ROW(OLD.type, OLD.owner_id, OLD.mandate_id, OLD.property_id, OLD.unit_id, OLD.version, OLD.replaces_id, OLD.file_name,
			OLD.mime_type, OLD.byte_size, OLD.storage_key, OLD.uploaded_by, OLD.created_at) THEN
		RAISE EXCEPTION 'DOCUMENT_IMMUTABLE: une version de document est figée ; une modification crée une nouvelle version' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
		RAISE EXCEPTION 'DOCUMENT_IMMUTABLE: l''empreinte d''une version ne change pas' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'pending' AND NEW.status IN ('active', 'rejected'))
		OR (OLD.status = 'active' AND NEW.status IN ('replaced', 'withdrawn'))
		OR (OLD.status = 'replaced' AND NEW.status = 'withdrawn')
	) THEN
		RAISE EXCEPTION 'DOCUMENT_STATUS: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER documents_rules BEFORE INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION documents_rules();
--> statement-breakpoint
-- Une nouvelle version entre en vigueur : la précédente devient « remplacée », dans la même transaction.
CREATE FUNCTION documents_supersede() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	UPDATE documents SET status = 'replaced', replaced_at = now(), updated_at = now()
	WHERE organization_id = NEW.organization_id AND id = NEW.replaces_id AND status = 'active';
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER documents_supersede AFTER UPDATE OF status ON documents
	FOR EACH ROW WHEN (NEW.status = 'active' AND OLD.status = 'pending' AND NEW.replaces_id IS NOT NULL)
	EXECUTE FUNCTION documents_supersede();
--> statement-breakpoint

-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)
-- Documents : métadonnées seulement (jamais la clé de stockage, le fichier n'est pas synchronisé).

GRANT SELECT ON properties, units, media, documents TO app_sync;
--> statement-breakpoint
CREATE POLICY sync_read ON properties FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON units FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON media FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON documents FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE properties, units, media, documents;
