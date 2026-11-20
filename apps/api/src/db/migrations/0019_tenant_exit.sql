-- Lot 10 bis — sortie du locataire : préavis, états des lieux, réparations, accords, décompte de caution, fin de bail
-- et remise en état, transfert de gestion. Règles 1, 2, 3, 4, 12, 13, 14, 15 et 16 de CLAUDE.md ; D14, D15, D16, D32.
-- Les règles pures sont dans packages/shared (deposit-settlement.ts, tenant-exit.ts) ; la base applique les mêmes, en
-- dernier rempart.
--
-- - lease_notices : congés (locataire ou bailleur) avec mode de notification et preuve ; une demande du locataire
--   (lot 10 ter) n'est qu'une demande. Un seul congé enregistré par bail ; le bail ne passe en préavis qu'avec lui.
-- - inspections, inspection_items : états des lieux d'entrée et de sortie, pièce par pièce, élément par élément ;
--   « bon état » seul refusé (article 9) ; constat obligatoire à la sortie ; signé des deux parties, puis figé.
-- - inspection_catalog_entries : pièces, éléments et réparations à la charge du locataire, propres à l'organisation
--   (les listes par défaut sont dans packages/shared) ; une entrée se désactive, jamais ne se supprime.
-- - agreements : circuit d'accord (imputation sur loyer, réparation par le locataire, issue d'une contestation).
-- - repairs : réparations des éléments imputables au locataire ; devis, puis facture ; contre-visite.
-- - deposit_settlements, deposit_settlement_lines : décompte de sortie et ses lignes, en ajout seul (une révision du
--   brouillon ajoute ses lignes, les précédentes restent) ; les totaux suivent computeSettlement.
-- - management_transfers : transferts de gestion, en ajout seul ; rien n'est copié vers une autre organisation.
-- - deposit_movements : `applied_to_debt` (D32), liens vers le décompte, l'échéance, la dépense et l'encaissement ;
--   restitution enregistrée (qui, moyen, référence) ; changement de détenteur vers le nouveau gestionnaire, nommé en texte.
-- - payments : moyen interne `deposit_offset` (imputation sur caution, D32), confirmé par la base seule et toujours
--   adossé à un mouvement de caution ; payment_allocations et receipts portent leur provenance (`source`).
-- - rent_dues : dernière période ramenée au dernier jour facturé à la sortie, une fois (D32).
-- - leases : nature de la fin ; préavis seulement avec un congé enregistré ; fin de bail → unité « à remettre en état ».
-- - mandate_scopes : fin d'une portée par un transfert de gestion.
-- - documents : types et rattachements du lot (preuve du congé, photos et scan de l'état des lieux, devis, accord,
--   issue d'une contestation).

-- ---------------------------------------------------------------- documents : types et rattachements

ALTER TABLE documents DROP CONSTRAINT documents_type_check;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN ('title_deed', 'puh', 'allocation_certificate', 'apfr',
	'owner_identity', 'mandate', 'document_photo', 'other', 'signed_lease_scan', 'tenant_identity', 'contract_template', 'contract_draft',
	'signed_amendment_scan', 'contract_legalization', 'contract_registration', 'expense_receipt', 'notice_proof', 'inspection_photo',
	'inspection_scan', 'repair_quote', 'agreement_document', 'settlement_outcome'));
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN inspection_id uuid, ADD COLUMN inspection_item_id uuid;
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT documents_subject;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_subject CHECK (
	num_nonnulls(owner_id, mandate_id, property_id, tenant_id, lease_id, lease_contract_id, contract_template_id, inspection_id) >= 1
);
--> statement-breakpoint
-- Les pièces de la sortie se rattachent à leur bail ; une photo, à sa ligne d'état des lieux ; un scan, à son état des lieux.
ALTER TABLE documents ADD CONSTRAINT documents_exit_types CHECK (
	(type NOT IN ('notice_proof', 'repair_quote', 'agreement_document', 'settlement_outcome', 'inspection_photo', 'inspection_scan')
		OR lease_id IS NOT NULL)
	AND (type NOT IN ('inspection_photo', 'inspection_scan') OR inspection_id IS NOT NULL)
	AND (type <> 'inspection_photo' OR inspection_item_id IS NOT NULL)
	AND (inspection_item_id IS NULL OR inspection_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX documents_by_inspection ON documents (organization_id, inspection_id) WHERE inspection_id IS NOT NULL;
--> statement-breakpoint
-- Même règle de version qu'aux lots 07, 08 et 08 bis, avec l'état des lieux et sa ligne.
CREATE OR REPLACE FUNCTION documents_rules() RETURNS trigger
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
				OR NEW.unit_id IS DISTINCT FROM previous.unit_id OR NEW.tenant_id IS DISTINCT FROM previous.tenant_id
				OR NEW.lease_id IS DISTINCT FROM previous.lease_id OR NEW.lease_contract_id IS DISTINCT FROM previous.lease_contract_id
				OR NEW.contract_template_id IS DISTINCT FROM previous.contract_template_id
				OR NEW.inspection_id IS DISTINCT FROM previous.inspection_id
				OR NEW.inspection_item_id IS DISTINCT FROM previous.inspection_item_id THEN
				RAISE EXCEPTION 'DOCUMENT_VERSION_SUBJECT: une nouvelle version garde le type et les objets liés' USING ERRCODE = 'P0001';
			END IF;
			IF NEW.version <> previous.version + 1 THEN
				RAISE EXCEPTION 'DOCUMENT_VERSION: la nouvelle version est la %', previous.version + 1 USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	IF ROW(NEW.type, NEW.owner_id, NEW.mandate_id, NEW.property_id, NEW.unit_id, NEW.tenant_id, NEW.lease_id, NEW.lease_contract_id,
			NEW.contract_template_id, NEW.inspection_id, NEW.inspection_item_id, NEW.version, NEW.replaces_id, NEW.file_name, NEW.mime_type,
			NEW.byte_size, NEW.storage_key, NEW.uploaded_by, NEW.created_at)
		IS DISTINCT FROM ROW(OLD.type, OLD.owner_id, OLD.mandate_id, OLD.property_id, OLD.unit_id, OLD.tenant_id, OLD.lease_id,
			OLD.lease_contract_id, OLD.contract_template_id, OLD.inspection_id, OLD.inspection_item_id, OLD.version, OLD.replaces_id,
			OLD.file_name, OLD.mime_type, OLD.byte_size, OLD.storage_key, OLD.uploaded_by, OLD.created_at) THEN
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
-- Un justificatif (document) de la sortie : de l'organisation, d'un des types attendus, et du même bail.
CREATE FUNCTION exit_document_ok(p_organization uuid, p_document uuid, p_lease uuid, p_types text[]) RETURNS boolean
	LANGUAGE sql STABLE
	SET search_path = pg_catalog, public
AS $$
	SELECT EXISTS (
		SELECT FROM documents d
		WHERE d.organization_id = p_organization AND d.id = p_document AND d.type = ANY (p_types)
			AND d.status IN ('pending', 'active') AND (d.lease_id IS NULL OR d.lease_id = p_lease)
	)
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- préavis

CREATE TABLE lease_notices (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	lease_id uuid NOT NULL,
	origin text NOT NULL CHECK (origin IN ('tenant', 'lessor')),
	-- `requested` : demande du locataire (lot 10 ter), à traiter ; `recorded` : congé enregistré ; `declined` : demande non suivie.
	status text NOT NULL CHECK (status IN ('requested', 'recorded', 'declined')),
	delivery_mode text CHECK (delivery_mode IN ('registered_letter', 'bailiff', 'hand_delivery', 'other')),
	proof_document_id uuid,
	notified_on date,
	planned_exit_on date,
	reduced_notice boolean NOT NULL DEFAULT false,
	reason text CHECK (char_length(reason) <= 500),
	-- Calculés par noticeTerms (packages/shared) à l'enregistrement, avec les paramètres du bail (D24, D32).
	notice_months smallint CHECK (notice_months BETWEEN 0 AND 12),
	notice_ends_on date,
	rent_ends_on date,
	early_termination_indemnity bigint NOT NULL DEFAULT 0 CHECK (early_termination_indemnity >= 0),
	declined_reason text CHECK (char_length(declined_reason) BETWEEN 5 AND 500),
	recorded_at timestamptz,
	recorded_by uuid REFERENCES users (id),
	declined_at timestamptz,
	declined_by uuid REFERENCES users (id),
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT lease_notices_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT lease_notices_proof_fk FOREIGN KEY (organization_id, proof_document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT lease_notices_recorded CHECK (status <> 'recorded' OR (delivery_mode IS NOT NULL AND notified_on IS NOT NULL
		AND planned_exit_on IS NOT NULL AND notice_months IS NOT NULL AND notice_ends_on IS NOT NULL AND rent_ends_on IS NOT NULL
		AND recorded_at IS NOT NULL)),
	CONSTRAINT lease_notices_declined CHECK ((status = 'declined') = (declined_reason IS NOT NULL AND declined_at IS NOT NULL)),
	CONSTRAINT lease_notices_dates CHECK (
		(planned_exit_on IS NULL OR notified_on IS NULL OR planned_exit_on >= notified_on)
		AND (rent_ends_on IS NULL OR planned_exit_on IS NULL OR rent_ends_on >= planned_exit_on)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX lease_notices_one_recorded ON lease_notices (organization_id, lease_id) WHERE status = 'recorded';
--> statement-breakpoint
CREATE INDEX lease_notices_by_lease ON lease_notices (organization_id, lease_id);
--> statement-breakpoint
SELECT enable_organization_rls('lease_notices');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON lease_notices FROM app_api, app_admin;
--> statement-breakpoint
-- Un congé s'enregistre sur un bail en vigueur ; une demande se traite une fois ; un congé enregistré ne change plus.
CREATE FUNCTION lease_notices_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease_status text;
BEGIN
	IF TG_OP = 'INSERT' AND NEW.status = 'declined' THEN
		RAISE EXCEPTION 'NOTICE_STATUS: un congé naît demandé ou enregistré' USING ERRCODE = 'P0001';
	END IF;
	IF TG_OP = 'UPDATE' THEN
		IF OLD.status <> 'requested' THEN
			RAISE EXCEPTION 'NOTICE_LOCKED: un congé enregistré ou une demande refusée ne change plus' USING ERRCODE = 'P0001';
		END IF;
		IF (NEW.id, NEW.organization_id, NEW.lease_id, NEW.origin, NEW.created_by, NEW.created_at)
			IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.lease_id, OLD.origin, OLD.created_by, OLD.created_at) THEN
			RAISE EXCEPTION 'NOTICE_LOCKED: le bail et l''origine d''un congé ne changent pas' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.status = 'recorded' AND (TG_OP = 'INSERT' OR OLD.status <> 'recorded') THEN
		SELECT status INTO lease_status FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
		-- Bail introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
		IF lease_status IS NOT NULL AND lease_status <> 'active' THEN
			RAISE EXCEPTION 'NOTICE_LEASE_NOT_IN_FORCE: un congé s''enregistre sur un bail en vigueur' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.proof_document_id IS NOT NULL
			AND NOT exit_document_ok(NEW.organization_id, NEW.proof_document_id, NEW.lease_id, ARRAY['notice_proof']) THEN
			RAISE EXCEPTION 'NOTICE_PROOF_INVALID: la preuve est un document « preuve du congé » de ce bail' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lease_notices_rules BEFORE INSERT OR UPDATE ON lease_notices FOR EACH ROW EXECUTE FUNCTION lease_notices_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- états des lieux

CREATE TABLE inspections (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	lease_id uuid NOT NULL,
	type text NOT NULL CHECK (type IN ('entry', 'exit')),
	status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed_both', 'disputed')),
	inspected_on date NOT NULL,
	performed_by uuid NOT NULL REFERENCES users (id),
	-- Meublé : l'inventaire des meubles fait partie de l'état des lieux.
	furnished boolean NOT NULL DEFAULT false,
	-- Signature des deux parties : case cochée par chacune (horodatée), ou scan déposé (« signature manuscrite », D21).
	organization_signed_at timestamptz,
	organization_signed_by uuid REFERENCES users (id),
	tenant_signed_at timestamptz,
	scan_document_id uuid,
	-- Contestation simple : observations libres des deux côtés ; issue enregistrée, jamais arbitrée.
	organization_observations text CHECK (char_length(organization_observations) <= 2000),
	tenant_observations text CHECK (char_length(tenant_observations) <= 2000),
	disputed_at timestamptz,
	dispute_outcome text CHECK (dispute_outcome IN ('amicable_agreement', 'court_decision')),
	dispute_outcome_document_id uuid,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT inspections_once UNIQUE (organization_id, lease_id, type),
	CONSTRAINT inspections_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT inspections_scan_fk FOREIGN KEY (organization_id, scan_document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT inspections_outcome_fk FOREIGN KEY (organization_id, dispute_outcome_document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT inspections_signed CHECK (status <> 'signed_both' OR scan_document_id IS NOT NULL
		OR (organization_signed_at IS NOT NULL AND tenant_signed_at IS NOT NULL)),
	CONSTRAINT inspections_disputed CHECK (status <> 'disputed' OR disputed_at IS NOT NULL),
	CONSTRAINT inspections_outcome CHECK ((dispute_outcome IS NULL) = (dispute_outcome_document_id IS NULL))
);
--> statement-breakpoint
SELECT enable_organization_rls('inspections');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON inspections FROM app_api, app_admin;
--> statement-breakpoint
CREATE TABLE inspection_items (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	inspection_id uuid NOT NULL,
	room text NOT NULL CHECK (char_length(room) BETWEEN 1 AND 80),
	element text NOT NULL CHECK (char_length(element) BETWEEN 1 AND 80),
	position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
	-- Texte obligatoire, jamais une formule vague seule (article 9) ; douze caractères au moins (packages/shared).
	description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 12 AND 1000),
	-- Constat à la sortie (article 20).
	finding text CHECK (finding IN ('normal_wear', 'tenant_damage', 'landlord_defect')),
	-- Ligne correspondante de l'état des lieux d'entrée (comparaison).
	entry_item_id uuid,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT inspection_items_inspection_fk FOREIGN KEY (organization_id, inspection_id) REFERENCES inspections (organization_id, id),
	CONSTRAINT inspection_items_entry_fk FOREIGN KEY (organization_id, entry_item_id) REFERENCES inspection_items (organization_id, id)
);
--> statement-breakpoint
CREATE INDEX inspection_items_by_inspection ON inspection_items (organization_id, inspection_id, position);
--> statement-breakpoint
SELECT enable_organization_rls('inspection_items');
--> statement-breakpoint
REVOKE TRUNCATE ON inspection_items FROM app_api, app_admin;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_inspection_fk FOREIGN KEY (organization_id, inspection_id) REFERENCES inspections (organization_id, id);
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_inspection_item_fk
	FOREIGN KEY (organization_id, inspection_item_id) REFERENCES inspection_items (organization_id, id);
--> statement-breakpoint
-- Formule vague (packages/shared, VAGUE_WORDS) : une description faite uniquement de ces mots, sans accents, sans
-- ponctuation ni casse. Liste comparée à celle de packages/shared par un test.
CREATE FUNCTION inspection_vague_words() RETURNS text[]
	LANGUAGE sql IMMUTABLE
AS $$
	SELECT ARRAY['bon', 'etat', 'en', 'tres', 'general', 'correct', 'bien', 'ok', 'ras', 'rien', 'a', 'signaler', 'neuf', 'comme', 'be',
		'tbe', 'normal', 'mauvais', 'usage', 'et', 'globalement']
$$;
--> statement-breakpoint
CREATE FUNCTION inspection_description_vague(p text) RETURNS boolean
	LANGUAGE sql IMMUTABLE
	SET search_path = pg_catalog, public
AS $$
	SELECT coalesce(bool_and(w = ANY (inspection_vague_words())), true)
	FROM regexp_split_to_table(
		btrim(regexp_replace(lower(translate(p, 'àâäáãéèêëíìîïóòôöõúùûüçñÀÂÄÁÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN')),
			'[^a-z0-9]+', ' ', 'g')),
		' '
	) AS w
	WHERE w <> ''
$$;
--> statement-breakpoint
-- États des lieux : d'entrée sur un bail validé, de sortie sur un bail en vigueur ou terminé ; signé des deux parties
-- (ou issue d'une contestation enregistrée), puis figé.
CREATE FUNCTION inspections_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease_status text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'draft' THEN
			RAISE EXCEPTION 'INSPECTION_BORN_DRAFT: un état des lieux naît brouillon' USING ERRCODE = 'P0001';
		END IF;
		SELECT status INTO lease_status FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
		-- Bail introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
		IF lease_status IS NOT NULL AND lease_status IN ('draft', 'cancelled') THEN
			RAISE EXCEPTION 'INSPECTION_LEASE: pas d''état des lieux sur un bail brouillon ou annulé' USING ERRCODE = 'P0001';
		END IF;
		IF lease_status IS NOT NULL AND NEW.type = 'exit' AND lease_status = 'signed' THEN
			RAISE EXCEPTION 'INSPECTION_LEASE: pas d''état des lieux de sortie avant l''entrée' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF (NEW.id, NEW.organization_id, NEW.lease_id, NEW.type, NEW.created_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.lease_id, OLD.type, OLD.created_by, OLD.created_at) THEN
		RAISE EXCEPTION 'INSPECTION_IMMUTABLE: le bail et le type d''un état des lieux ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'signed_both' THEN
		RAISE EXCEPTION 'INSPECTION_LOCKED: un état des lieux signé des deux parties ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status IN ('signed_both', 'disputed'))
		OR (OLD.status = 'disputed' AND NEW.status = 'signed_both')
	) THEN
		RAISE EXCEPTION 'INSPECTION_STATUS: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'disputed' AND NEW.status = 'signed_both' AND NEW.dispute_outcome IS NULL THEN
		RAISE EXCEPTION 'INSPECTION_DISPUTE_OUTCOME: l''issue d''une contestation s''enregistre avec son document' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.scan_document_id IS NOT NULL AND NEW.scan_document_id IS DISTINCT FROM OLD.scan_document_id
		AND NOT EXISTS (SELECT FROM documents d WHERE d.organization_id = NEW.organization_id AND d.id = NEW.scan_document_id
			AND d.type = 'inspection_scan' AND d.inspection_id = NEW.id) THEN
		RAISE EXCEPTION 'INSPECTION_SCAN_INVALID: le scan est un document « état des lieux scanné » de cet état des lieux' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.dispute_outcome_document_id IS NOT NULL AND NEW.dispute_outcome_document_id IS DISTINCT FROM OLD.dispute_outcome_document_id
		AND NOT exit_document_ok(NEW.organization_id, NEW.dispute_outcome_document_id, NEW.lease_id, ARRAY['settlement_outcome']) THEN
		RAISE EXCEPTION 'INSPECTION_DISPUTE_OUTCOME: l''issue est un document « issue d''une contestation » de ce bail' USING ERRCODE = 'P0001';
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inspections_rules BEFORE INSERT OR UPDATE ON inspections FOR EACH ROW EXECUTE FUNCTION inspections_rules();
--> statement-breakpoint
-- Lignes : seulement dans un état des lieux brouillon ; description jamais vague ; constat à la sortie, jamais à
-- l'entrée ; la ligne d'entrée comparée est celle de l'entrée du même bail.
CREATE FUNCTION inspection_items_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	insp inspections%ROWTYPE;
	entry_lease uuid;
	entry_type text;
	target inspection_items%ROWTYPE;
BEGIN
	IF TG_OP = 'DELETE' THEN
		target := OLD;
	ELSE
		target := NEW;
	END IF;
	SELECT * INTO insp FROM inspections WHERE organization_id = target.organization_id AND id = target.inspection_id;
	-- État des lieux introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
	IF insp.id IS NULL THEN
		RETURN target;
	END IF;
	IF insp.status <> 'draft' THEN
		RAISE EXCEPTION 'INSPECTION_LOCKED: un état des lieux signé ou contesté ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	IF TG_OP = 'UPDATE' AND (NEW.id, NEW.organization_id, NEW.inspection_id, NEW.created_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.inspection_id, OLD.created_by, OLD.created_at) THEN
		RAISE EXCEPTION 'INSPECTION_IMMUTABLE: une ligne reste dans son état des lieux' USING ERRCODE = 'P0001';
	END IF;
	IF inspection_description_vague(NEW.description) THEN
		RAISE EXCEPTION 'INSPECTION_DESCRIPTION_VAGUE: décrivez l''état (« bon état » seul ne suffit pas, article 9)' USING ERRCODE = 'P0001';
	END IF;
	IF insp.type = 'exit' AND NEW.finding IS NULL THEN
		RAISE EXCEPTION 'INSPECTION_FINDING_REQUIRED: à la sortie, chaque élément a son constat' USING ERRCODE = 'P0001';
	END IF;
	IF insp.type = 'entry' AND NEW.finding IS NOT NULL THEN
		RAISE EXCEPTION 'INSPECTION_FINDING_ON_ENTRY: l''état des lieux d''entrée n''a pas de constat' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.entry_item_id IS NOT NULL THEN
		SELECT i.lease_id, i.type INTO entry_lease, entry_type
		FROM inspection_items it JOIN inspections i ON i.organization_id = it.organization_id AND i.id = it.inspection_id
		WHERE it.organization_id = NEW.organization_id AND it.id = NEW.entry_item_id;
		IF entry_lease IS NOT NULL AND (entry_type <> 'entry' OR entry_lease <> insp.lease_id OR insp.type <> 'exit') THEN
			RAISE EXCEPTION 'INSPECTION_COMPARISON: une ligne de sortie se compare à une ligne d''entrée du même bail' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inspection_items_rules BEFORE INSERT OR UPDATE OR DELETE ON inspection_items
	FOR EACH ROW EXECUTE FUNCTION inspection_items_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- catalogue de l'organisation

CREATE TABLE inspection_catalog_entries (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	-- `tenant_repair` : réparation à la charge du locataire (liste à valider par le juriste) ; elle guide le constat,
	-- jamais ne le décide (réponse du porteur).
	kind text NOT NULL CHECK (kind IN ('room', 'element', 'tenant_repair')),
	key text NOT NULL CHECK (key ~ '^[a-z0-9_]{1,60}$'),
	label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
	-- Réparation : éléments qu'elle concerne (clés du catalogue).
	elements text[] NOT NULL DEFAULT '{}',
	position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
	active boolean NOT NULL DEFAULT true,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT inspection_catalog_once UNIQUE (organization_id, kind, key),
	CONSTRAINT inspection_catalog_elements CHECK (kind = 'tenant_repair' OR cardinality(elements) = 0)
);
--> statement-breakpoint
SELECT enable_organization_rls('inspection_catalog_entries');
--> statement-breakpoint
-- Une entrée se désactive, jamais ne se supprime (les états des lieux passés gardent leur libellé).
REVOKE DELETE, TRUNCATE ON inspection_catalog_entries FROM app_api, app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- accords (circuit d'accord, docs/UX.md §10)

CREATE TABLE agreements (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	lease_id uuid NOT NULL,
	type text NOT NULL CHECK (type IN ('deposit_applied_to_rent', 'tenant_self_repair', 'settlement_dispute')),
	status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'refused')),
	proposed_by text NOT NULL CHECK (proposed_by IN ('organization', 'tenant', 'owner')),
	proposed_on date NOT NULL,
	description text CHECK (char_length(description) <= 1000),
	-- Imputation sur loyer : les mois couverts (débuts de période) et la part gardée pour d'éventuels dégâts.
	months date[] NOT NULL DEFAULT '{}',
	kept_amount bigint NOT NULL DEFAULT 0 CHECK (kept_amount >= 0),
	-- Contestation d'un décompte : le décompte visé.
	settlement_id uuid,
	decided_by_party text CHECK (decided_by_party IN ('organization', 'tenant', 'owner')),
	decided_on date,
	decided_at timestamptz,
	decided_by uuid REFERENCES users (id),
	refusal_reason text CHECK (char_length(refusal_reason) BETWEEN 5 AND 500),
	-- Accord écrit (imputation sur loyer) ou issue (contestation).
	document_id uuid,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT agreements_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT agreements_document_fk FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT agreements_months CHECK ((type = 'deposit_applied_to_rent') = (cardinality(months) > 0)),
	CONSTRAINT agreements_settlement CHECK ((type = 'settlement_dispute') = (settlement_id IS NOT NULL)),
	CONSTRAINT agreements_decision CHECK ((status = 'proposed') = (decided_on IS NULL AND decided_by_party IS NULL AND decided_at IS NULL)),
	CONSTRAINT agreements_refusal CHECK ((status = 'refused') = (refusal_reason IS NOT NULL)),
	CONSTRAINT agreements_other_party CHECK (decided_by_party IS NULL OR decided_by_party <> proposed_by),
	CONSTRAINT agreements_written CHECK (status <> 'accepted' OR type = 'tenant_self_repair' OR document_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX agreements_by_lease ON agreements (organization_id, lease_id);
--> statement-breakpoint
SELECT enable_organization_rls('agreements');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON agreements FROM app_api, app_admin;
--> statement-breakpoint
-- Une proposition se décide une fois ; l'imputation sur loyer nomme des mois à venir et s'accepte avant eux.
CREATE FUNCTION agreements_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'proposed' THEN
			RAISE EXCEPTION 'AGREEMENT_BORN_PROPOSED: un accord naît proposé' USING ERRCODE = 'P0001';
		END IF;
		IF EXISTS (SELECT FROM unnest(NEW.months) AS m (d) WHERE m.d <= NEW.proposed_on) THEN
			RAISE EXCEPTION 'AGREEMENT_MONTH_STARTED: les mois imputés sont à venir' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF OLD.status <> 'proposed' THEN
		RAISE EXCEPTION 'AGREEMENT_ALREADY_DECIDED: un accord décidé ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF (NEW.id, NEW.organization_id, NEW.lease_id, NEW.type, NEW.proposed_by, NEW.proposed_on, NEW.months, NEW.kept_amount,
		NEW.settlement_id, NEW.created_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.lease_id, OLD.type, OLD.proposed_by, OLD.proposed_on, OLD.months,
		OLD.kept_amount, OLD.settlement_id, OLD.created_by, OLD.created_at) THEN
		RAISE EXCEPTION 'AGREEMENT_IMMUTABLE: une proposition ne change pas ; elle s''accepte ou se refuse' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'accepted' AND NEW.type = 'deposit_applied_to_rent'
		AND EXISTS (SELECT FROM unnest(NEW.months) AS m (d) WHERE m.d <= NEW.decided_on) THEN
		RAISE EXCEPTION 'AGREEMENT_MONTH_STARTED: l''accord est accepté avant les mois concernés' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.document_id IS NOT NULL AND NOT exit_document_ok(NEW.organization_id, NEW.document_id, NEW.lease_id,
		ARRAY['agreement_document', 'settlement_outcome']) THEN
		RAISE EXCEPTION 'AGREEMENT_DOCUMENT_INVALID: l''accord écrit est un document de ce bail' USING ERRCODE = 'P0001';
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agreements_rules BEFORE INSERT OR UPDATE ON agreements FOR EACH ROW EXECUTE FUNCTION agreements_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- réparations

CREATE TABLE repairs (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	inspection_item_id uuid NOT NULL,
	-- Bail de l'état des lieux, recopié par la base.
	lease_id uuid NOT NULL,
	description text NOT NULL CHECK (char_length(description) BETWEEN 2 AND 500),
	performed_by text NOT NULL CHECK (performed_by IN ('organization', 'tenant')),
	status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'verified')),
	-- Devis puis facture (FCFA entiers) et leurs justificatifs.
	estimated_amount bigint CHECK (estimated_amount > 0),
	quote_document_id uuid,
	actual_amount bigint CHECK (actual_amount > 0),
	invoice_document_id uuid,
	-- Réparation par le locataire : l'accord `tenant_self_repair` accepté.
	agreement_id uuid,
	-- Réparation faite par l'organisation : la dépense créée (supportée par le locataire, récupérée sur la caution).
	expense_id uuid,
	done_on date,
	verified_on date,
	verified_by uuid REFERENCES users (id),
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT repairs_once UNIQUE (organization_id, inspection_item_id),
	CONSTRAINT repairs_item_fk FOREIGN KEY (organization_id, inspection_item_id) REFERENCES inspection_items (organization_id, id),
	CONSTRAINT repairs_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT repairs_quote_fk FOREIGN KEY (organization_id, quote_document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT repairs_invoice_fk FOREIGN KEY (organization_id, invoice_document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT repairs_agreement_fk FOREIGN KEY (organization_id, agreement_id) REFERENCES agreements (organization_id, id),
	CONSTRAINT repairs_expense_fk FOREIGN KEY (organization_id, expense_id) REFERENCES expenses (organization_id, id),
	CONSTRAINT repairs_done CHECK (status = 'planned' OR done_on IS NOT NULL),
	CONSTRAINT repairs_verified CHECK ((status = 'verified') = (verified_on IS NOT NULL)),
	CONSTRAINT repairs_invoice CHECK (performed_by <> 'organization' OR status = 'planned'
		OR (actual_amount IS NOT NULL AND invoice_document_id IS NOT NULL)),
	CONSTRAINT repairs_self_repair CHECK (performed_by <> 'tenant' OR status = 'planned' OR agreement_id IS NOT NULL),
	CONSTRAINT repairs_expense_by_organization CHECK (expense_id IS NULL OR performed_by = 'organization')
);
--> statement-breakpoint
CREATE INDEX repairs_by_lease ON repairs (organization_id, lease_id);
--> statement-breakpoint
SELECT enable_organization_rls('repairs');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON repairs FROM app_api, app_admin;
--> statement-breakpoint
-- Une réparation n'existe que sur une ligne de sortie imputable au locataire ; chaque étape a sa preuve ; le montant
-- et la facture s'écrivent une fois la réparation faite, puis ne changent plus.
CREATE FUNCTION repairs_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	item_finding text;
	item_lease uuid;
	item_type text;
	agr agreements%ROWTYPE;
	exp expenses%ROWTYPE;
BEGIN
	SELECT it.finding, i.lease_id, i.type INTO item_finding, item_lease, item_type
	FROM inspection_items it JOIN inspections i ON i.organization_id = it.organization_id AND i.id = it.inspection_id
	WHERE it.organization_id = NEW.organization_id AND it.id = NEW.inspection_item_id;
	IF TG_OP = 'INSERT' THEN
		-- Ligne introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
		IF item_lease IS NOT NULL THEN
			IF item_type <> 'exit' OR item_finding IS DISTINCT FROM 'tenant_damage' THEN
				RAISE EXCEPTION 'REPAIR_NOT_TENANT_DAMAGE: une réparation vise une ligne de sortie imputable au locataire' USING ERRCODE = 'P0001';
			END IF;
			NEW.lease_id := item_lease;
		END IF;
		IF NEW.status <> 'planned' THEN
			RAISE EXCEPTION 'REPAIR_BORN_PLANNED: une réparation naît prévue' USING ERRCODE = 'P0001';
		END IF;
	ELSE
		IF (NEW.id, NEW.organization_id, NEW.inspection_item_id, NEW.lease_id, NEW.performed_by, NEW.created_by, NEW.created_at)
			IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.inspection_item_id, OLD.lease_id, OLD.performed_by, OLD.created_by,
			OLD.created_at) THEN
			RAISE EXCEPTION 'REPAIR_IMMUTABLE: la ligne et l''auteur d''une réparation ne changent pas' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
			(OLD.status = 'planned' AND NEW.status = 'done') OR (OLD.status = 'done' AND NEW.status = 'verified')
		) THEN
			RAISE EXCEPTION 'REPAIR_TRANSITION_FORBIDDEN: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
		END IF;
		IF OLD.status <> 'planned' AND (NEW.estimated_amount, NEW.quote_document_id, NEW.actual_amount, NEW.invoice_document_id,
			NEW.agreement_id, NEW.done_on, NEW.description)
			IS DISTINCT FROM (OLD.estimated_amount, OLD.quote_document_id, OLD.actual_amount, OLD.invoice_document_id, OLD.agreement_id,
			OLD.done_on, OLD.description) THEN
			RAISE EXCEPTION 'REPAIR_LOCKED: une réparation faite ne change plus' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.expense_id IS NOT NULL AND NEW.expense_id IS DISTINCT FROM OLD.expense_id THEN
			RAISE EXCEPTION 'REPAIR_LOCKED: la dépense d''une réparation ne change pas' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.quote_document_id IS NOT NULL
		AND NOT exit_document_ok(NEW.organization_id, NEW.quote_document_id, NEW.lease_id, ARRAY['repair_quote']) THEN
		RAISE EXCEPTION 'REPAIR_PROOF_INVALID: le devis est un document « devis de réparation » de ce bail' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.invoice_document_id IS NOT NULL
		AND NOT exit_document_ok(NEW.organization_id, NEW.invoice_document_id, NEW.lease_id, ARRAY['expense_receipt']) THEN
		RAISE EXCEPTION 'REPAIR_PROOF_INVALID: la facture est un justificatif de dépense de ce bail' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.agreement_id IS NOT NULL THEN
		SELECT * INTO agr FROM agreements WHERE organization_id = NEW.organization_id AND id = NEW.agreement_id;
		IF agr.id IS NOT NULL AND (agr.type <> 'tenant_self_repair' OR agr.lease_id <> NEW.lease_id) THEN
			RAISE EXCEPTION 'REPAIR_SELF_REPAIR_NOT_AGREED: l''accord est une réparation par le locataire de ce bail' USING ERRCODE = 'P0001';
		END IF;
		IF agr.id IS NOT NULL AND NEW.status <> 'planned' AND agr.status <> 'accepted' THEN
			RAISE EXCEPTION 'REPAIR_SELF_REPAIR_NOT_AGREED: le locataire ne répare qu''avec un accord accepté' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.expense_id IS NOT NULL THEN
		SELECT * INTO exp FROM expenses WHERE organization_id = NEW.organization_id AND id = NEW.expense_id;
		IF exp.id IS NOT NULL AND (exp.paid_by <> 'organization' OR exp.borne_by <> 'tenant' OR exp.recovery <> 'deposit'
			OR exp.lease_id IS DISTINCT FROM NEW.lease_id) THEN
			RAISE EXCEPTION 'REPAIR_EXPENSE_INVALID: la dépense est avancée par l''organisation, supportée par le locataire de ce bail et récupérée sur la caution'
				USING ERRCODE = 'P0001';
		END IF;
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER repairs_rules BEFORE INSERT OR UPDATE ON repairs FOR EACH ROW EXECUTE FUNCTION repairs_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- décompte de sortie

CREATE TABLE deposit_settlements (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	deposit_account_id uuid NOT NULL,
	-- Bail du compte, recopié par la base.
	lease_id uuid NOT NULL,
	status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'proposed', 'accepted', 'disputed', 'closed')),
	-- Chaque révision du brouillon ajoute ses lignes ; les précédentes restent (ajout seul).
	revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
	exit_on date NOT NULL,
	refund_deadline date NOT NULL,
	-- Totaux de computeSettlement (packages/shared), FCFA entiers.
	received bigint NOT NULL DEFAULT 0 CHECK (received >= 0),
	credit bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
	deductions bigint NOT NULL DEFAULT 0 CHECK (deductions >= 0),
	covered_by_deposit bigint NOT NULL DEFAULT 0 CHECK (covered_by_deposit >= 0),
	credit_used bigint NOT NULL DEFAULT 0 CHECK (credit_used >= 0),
	refund bigint NOT NULL DEFAULT 0 CHECK (refund >= 0),
	refund_from_deposit bigint NOT NULL DEFAULT 0 CHECK (refund_from_deposit >= 0),
	refund_from_credit bigint NOT NULL DEFAULT 0 CHECK (refund_from_credit >= 0),
	claim bigint NOT NULL DEFAULT 0 CHECK (claim >= 0),
	outcome text NOT NULL DEFAULT 'zero' CHECK (outcome IN ('refund', 'claim', 'zero')),
	organization_observations text CHECK (char_length(organization_observations) <= 2000),
	tenant_observations text CHECK (char_length(tenant_observations) <= 2000),
	owner_observations text CHECK (char_length(owner_observations) <= 2000),
	proposed_at timestamptz,
	accepted_at timestamptz,
	disputed_at timestamptz,
	dispute_outcome text CHECK (dispute_outcome IN ('amicable_agreement', 'court_decision')),
	dispute_document_id uuid,
	closed_at timestamptz,
	closed_by uuid REFERENCES users (id),
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT deposit_settlements_once UNIQUE (organization_id, deposit_account_id),
	CONSTRAINT deposit_settlements_account_fk FOREIGN KEY (organization_id, deposit_account_id) REFERENCES deposit_accounts (organization_id, id),
	CONSTRAINT deposit_settlements_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT deposit_settlements_dispute_document_fk FOREIGN KEY (organization_id, dispute_document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT deposit_settlements_totals CHECK (
		covered_by_deposit + refund_from_deposit = received
		AND refund = refund_from_deposit + refund_from_credit
		AND claim + credit_used = deductions - covered_by_deposit
		AND credit_used + refund_from_credit = credit
	),
	CONSTRAINT deposit_settlements_outcome CHECK (
		(outcome = 'claim') = (claim > 0) AND (outcome = 'refund') = (claim = 0 AND refund > 0)
	),
	CONSTRAINT deposit_settlements_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
	CONSTRAINT deposit_settlements_disputed CHECK (status <> 'disputed' OR disputed_at IS NOT NULL),
	CONSTRAINT deposit_settlements_dispute_outcome CHECK ((dispute_outcome IS NULL) = (dispute_document_id IS NULL)),
	CONSTRAINT deposit_settlements_dispute_closed CHECK (status <> 'closed' OR disputed_at IS NULL OR dispute_outcome IS NOT NULL)
);
--> statement-breakpoint
SELECT enable_organization_rls('deposit_settlements');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON deposit_settlements FROM app_api, app_admin;
--> statement-breakpoint
ALTER TABLE agreements ADD CONSTRAINT agreements_settlement_fk
	FOREIGN KEY (organization_id, settlement_id) REFERENCES deposit_settlements (organization_id, id);
--> statement-breakpoint
CREATE TABLE deposit_settlement_lines (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	settlement_id uuid NOT NULL,
	revision integer NOT NULL CHECK (revision >= 1),
	position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
	kind text NOT NULL CHECK (kind IN ('rent_by_agreement', 'repair', 'expense_claim', 'utility_bill', 'unpaid_rent')),
	-- Montant demandé (0 pour une ligne refusée), part couverte par la caution, part qui reste due.
	amount bigint NOT NULL CHECK (amount >= 0),
	covered bigint NOT NULL CHECK (covered >= 0),
	uncovered bigint NOT NULL CHECK (uncovered >= 0),
	-- Ligne refusée : son motif (settlementLineBlocker), affichée, jamais comptée.
	blocker text CHECK (blocker ~ '^[A-Z_]{3,60}$'),
	inspection_item_id uuid,
	repair_id uuid,
	rent_due_id uuid,
	expense_id uuid,
	agreement_id uuid,
	-- Justificatif (règle 14) : devis ou facture d'une réparation, justificatif d'une dépense.
	document_id uuid,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT deposit_settlement_lines_settlement_fk FOREIGN KEY (organization_id, settlement_id) REFERENCES deposit_settlements (organization_id, id),
	CONSTRAINT deposit_settlement_lines_item_fk FOREIGN KEY (organization_id, inspection_item_id) REFERENCES inspection_items (organization_id, id),
	CONSTRAINT deposit_settlement_lines_repair_fk FOREIGN KEY (organization_id, repair_id) REFERENCES repairs (organization_id, id),
	CONSTRAINT deposit_settlement_lines_due_fk FOREIGN KEY (organization_id, rent_due_id) REFERENCES rent_dues (organization_id, id),
	CONSTRAINT deposit_settlement_lines_expense_fk FOREIGN KEY (organization_id, expense_id) REFERENCES expenses (organization_id, id),
	CONSTRAINT deposit_settlement_lines_agreement_fk FOREIGN KEY (organization_id, agreement_id) REFERENCES agreements (organization_id, id),
	CONSTRAINT deposit_settlement_lines_document_fk FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT deposit_settlement_lines_split CHECK (covered + uncovered = amount),
	CONSTRAINT deposit_settlement_lines_refused CHECK (blocker IS NULL OR amount = 0),
	-- Règle 14 : une retenue pointe vers sa ligne d'état des lieux et sa réparation, avec un justificatif.
	CONSTRAINT deposit_settlement_lines_repair CHECK (kind <> 'repair'
		OR (inspection_item_id IS NOT NULL AND repair_id IS NOT NULL AND (blocker IS NOT NULL OR amount = 0 OR document_id IS NOT NULL))),
	-- D32 : une somme due pointe vers la dépense elle-même (avec son justificatif) ou vers l'échéance.
	CONSTRAINT deposit_settlement_lines_expense CHECK (kind NOT IN ('expense_claim', 'utility_bill')
		OR (expense_id IS NOT NULL AND (blocker IS NOT NULL OR document_id IS NOT NULL))),
	CONSTRAINT deposit_settlement_lines_due CHECK (kind NOT IN ('unpaid_rent', 'rent_by_agreement') OR rent_due_id IS NOT NULL),
	CONSTRAINT deposit_settlement_lines_agreement CHECK (kind <> 'rent_by_agreement' OR blocker IS NOT NULL OR agreement_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX deposit_settlement_lines_by_settlement ON deposit_settlement_lines (organization_id, settlement_id, revision, position);
--> statement-breakpoint
SELECT enable_organization_rls('deposit_settlement_lines');
--> statement-breakpoint
-- Ajout seul (règle 14) : aucune ligne ne se modifie ni ne se supprime ; une correction est une révision.
REVOKE UPDATE, DELETE, TRUNCATE ON deposit_settlement_lines FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER deposit_settlement_lines_no_update_delete BEFORE UPDATE OR DELETE ON deposit_settlement_lines
	FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER deposit_settlement_lines_no_truncate BEFORE TRUNCATE ON deposit_settlement_lines
	FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Décompte : sur un compte de caution d'un bail terminé ou en préavis ; transitions de packages/shared ; totaux
-- modifiables en brouillon seulement ; clos, il ne change plus et le compte est soldé.
CREATE FUNCTION deposit_settlements_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	account deposit_accounts%ROWTYPE;
	lease_status text;
	outflows bigint;
	net_received bigint;
	claimed bigint;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'draft' OR NEW.revision <> 1 THEN
			RAISE EXCEPTION 'SETTLEMENT_BORN_DRAFT: un décompte naît brouillon, en révision 1' USING ERRCODE = 'P0001';
		END IF;
		SELECT * INTO account FROM deposit_accounts WHERE organization_id = NEW.organization_id AND id = NEW.deposit_account_id;
		-- Compte introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
		IF account.id IS NOT NULL THEN
			IF account.status = 'closed' THEN
				RAISE EXCEPTION 'DEPOSIT_ACCOUNT_CLOSED: un compte de caution soldé n''a plus de décompte' USING ERRCODE = 'P0001';
			END IF;
			NEW.lease_id := account.lease_id;
			SELECT status INTO lease_status FROM leases WHERE organization_id = NEW.organization_id AND id = account.lease_id;
			IF lease_status NOT IN ('notice', 'ended') THEN
				RAISE EXCEPTION 'SETTLEMENT_LEASE_NOT_ENDING: le décompte suit un préavis ou une fin de bail' USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	IF (NEW.id, NEW.organization_id, NEW.deposit_account_id, NEW.lease_id, NEW.created_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.deposit_account_id, OLD.lease_id, OLD.created_by, OLD.created_at) THEN
		RAISE EXCEPTION 'SETTLEMENT_IMMUTABLE: le compte d''un décompte ne change pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'closed' THEN
		RAISE EXCEPTION 'SETTLEMENT_CLOSED: un décompte clos ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status = 'proposed')
		OR (OLD.status = 'proposed' AND NEW.status IN ('draft', 'accepted', 'disputed'))
		OR (OLD.status IN ('accepted', 'disputed') AND NEW.status = 'closed')
	) THEN
		RAISE EXCEPTION 'SETTLEMENT_TRANSITION_FORBIDDEN: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
	END IF;
	-- Révision : seulement en brouillon (ou en y revenant), une à la fois.
	IF NEW.revision <> OLD.revision AND (NEW.revision <> OLD.revision + 1 OR NEW.status <> 'draft') THEN
		RAISE EXCEPTION 'SETTLEMENT_REVISION: une nouvelle révision se fait en brouillon, une à la fois' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status <> 'draft' AND (NEW.received, NEW.credit, NEW.deductions, NEW.covered_by_deposit, NEW.credit_used, NEW.refund,
		NEW.refund_from_deposit, NEW.refund_from_credit, NEW.claim, NEW.outcome, NEW.exit_on, NEW.refund_deadline)
		IS DISTINCT FROM (OLD.received, OLD.credit, OLD.deductions, OLD.covered_by_deposit, OLD.credit_used, OLD.refund,
		OLD.refund_from_deposit, OLD.refund_from_credit, OLD.claim, OLD.outcome, OLD.exit_on, OLD.refund_deadline) THEN
		RAISE EXCEPTION 'SETTLEMENT_LOCKED: les totaux d''un décompte proposé ne changent pas ; revenez au brouillon' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.dispute_document_id IS NOT NULL AND NEW.dispute_document_id IS DISTINCT FROM OLD.dispute_document_id
		AND NOT exit_document_ok(NEW.organization_id, NEW.dispute_document_id, NEW.lease_id, ARRAY['settlement_outcome']) THEN
		RAISE EXCEPTION 'SETTLEMENT_DISPUTE_OUTCOME: l''issue est un document « issue d''une contestation » de ce bail' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'closed' THEN
		-- À la clôture, la caution reçue est entièrement sortie (retenues, imputations, sommes dues, restitution) et le
		-- complément réclamé est écrit (règle 14) ; le compte n'a plus rien à recevoir.
		SELECT coalesce(sum(amount) FILTER (WHERE type = 'received'), 0) - coalesce(sum(amount) FILTER (WHERE type = 'received_cancelled'), 0),
			coalesce(sum(amount) FILTER (WHERE type IN ('retained', 'applied_to_rent', 'applied_to_debt', 'refunded')), 0),
			coalesce(sum(amount) FILTER (WHERE type = 'additional_claimed' AND settlement_id = NEW.id), 0)
		INTO net_received, outflows, claimed
		FROM deposit_movements WHERE organization_id = NEW.organization_id AND account_id = NEW.deposit_account_id;
		IF net_received <> NEW.received OR outflows <> NEW.received OR claimed <> NEW.claim THEN
			RAISE EXCEPTION 'SETTLEMENT_MOVEMENTS_MISSING: les mouvements du décompte ne sont pas tous écrits (reçu %, sorties %, complément %)',
				net_received, outflows, claimed USING ERRCODE = 'P0001';
		END IF;
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposit_settlements_rules BEFORE INSERT OR UPDATE ON deposit_settlements
	FOR EACH ROW EXECUTE FUNCTION deposit_settlements_rules();
--> statement-breakpoint
-- Le compte suit son décompte : « en cours de décompte » à l'ouverture, « soldé » à la clôture. SECURITY DEFINER :
-- l'application n'écrit jamais le statut d'un compte ; la mise à jour reste dans l'organisation (RLS forcée).
CREATE FUNCTION deposit_settlements_apply() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'INSERT' OR NEW.status = 'closed' THEN
		UPDATE deposit_accounts SET status = CASE WHEN NEW.status = 'closed' THEN 'closed' ELSE 'settling' END, updated_at = now()
		WHERE organization_id = NEW.organization_id AND id = NEW.deposit_account_id;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION deposit_settlements_apply() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER deposit_settlements_apply AFTER INSERT OR UPDATE OF status ON deposit_settlements
	FOR EACH ROW EXECUTE FUNCTION deposit_settlements_apply();
--> statement-breakpoint
-- Lignes : ajoutées au brouillon, à sa révision courante ; chaque objet visé est du bail du décompte ; une retenue
-- vise une ligne `tenant_damage` (règle 14) ; une somme due, une dépense réclamée avec son justificatif ou une échéance ;
-- une imputation sur loyer, un accord accepté avant le mois (D32).
CREATE FUNCTION deposit_settlement_lines_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	s deposit_settlements%ROWTYPE;
	item_finding text;
	item_lease uuid;
	repair_item uuid;
	due_lease uuid;
	due_start date;
	exp expenses%ROWTYPE;
	agr agreements%ROWTYPE;
BEGIN
	SELECT * INTO s FROM deposit_settlements WHERE organization_id = NEW.organization_id AND id = NEW.settlement_id FOR UPDATE;
	-- Décompte introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
	IF s.id IS NULL THEN
		RETURN NEW;
	END IF;
	IF s.status <> 'draft' OR NEW.revision <> s.revision THEN
		RAISE EXCEPTION 'SETTLEMENT_LOCKED: les lignes s''ajoutent au brouillon, à sa révision %', s.revision USING ERRCODE = 'P0001';
	END IF;
	IF NEW.blocker IS NOT NULL THEN
		RETURN NEW;
	END IF;
	IF NEW.inspection_item_id IS NOT NULL THEN
		SELECT it.finding, i.lease_id INTO item_finding, item_lease
		FROM inspection_items it JOIN inspections i ON i.organization_id = it.organization_id AND i.id = it.inspection_id
		WHERE it.organization_id = NEW.organization_id AND it.id = NEW.inspection_item_id;
		IF item_lease IS NOT NULL AND (item_lease <> s.lease_id OR item_finding IS DISTINCT FROM 'tenant_damage') THEN
			RAISE EXCEPTION 'RETENTION_NOT_TENANT_DAMAGE: une retenue vise une ligne d''état des lieux de ce bail, imputable au locataire'
				USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.repair_id IS NOT NULL THEN
		SELECT inspection_item_id INTO repair_item FROM repairs WHERE organization_id = NEW.organization_id AND id = NEW.repair_id;
		IF repair_item IS NOT NULL AND repair_item IS DISTINCT FROM NEW.inspection_item_id THEN
			RAISE EXCEPTION 'RETENTION_NOT_TENANT_DAMAGE: la réparation est celle de cette ligne d''état des lieux' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.kind = 'repair' AND NEW.amount > 0
		AND NOT exit_document_ok(NEW.organization_id, NEW.document_id, s.lease_id, ARRAY['repair_quote', 'expense_receipt']) THEN
		RAISE EXCEPTION 'RETENTION_PROOF_MISSING: une retenue a son devis ou sa facture' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.rent_due_id IS NOT NULL THEN
		SELECT lease_id, period_start INTO due_lease, due_start FROM rent_dues WHERE organization_id = NEW.organization_id AND id = NEW.rent_due_id;
		IF due_lease IS NOT NULL AND due_lease <> s.lease_id THEN
			RAISE EXCEPTION 'DEBT_NOT_THIS_LEASE: l''échéance est celle du bail du décompte' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.expense_id IS NOT NULL AND NEW.kind IN ('expense_claim', 'utility_bill') THEN
		SELECT * INTO exp FROM expenses WHERE organization_id = NEW.organization_id AND id = NEW.expense_id;
		IF exp.id IS NOT NULL THEN
			IF exp.recovery <> 'claimed_from_tenant' OR exp.status <> 'recorded' OR exp.lease_id IS DISTINCT FROM s.lease_id THEN
				RAISE EXCEPTION 'DEBT_NOT_CLAIMED: la dépense est réclamée au locataire de ce bail' USING ERRCODE = 'P0001';
			END IF;
			IF exp.document_id IS NULL OR exp.document_id <> NEW.document_id THEN
				RAISE EXCEPTION 'DEBT_PROOF_MISSING: la ligne renvoie au justificatif de la dépense elle-même' USING ERRCODE = 'P0001';
			END IF;
			IF NEW.kind = 'utility_bill' AND exp.category NOT IN ('water_bill', 'electricity_bill') THEN
				RAISE EXCEPTION 'DEBT_NOT_UTILITY_BILL: la garantie des factures ne couvre que l''eau et l''électricité' USING ERRCODE = 'P0001';
			END IF;
		END IF;
	END IF;
	IF NEW.agreement_id IS NOT NULL AND NEW.kind = 'rent_by_agreement' THEN
		SELECT * INTO agr FROM agreements WHERE organization_id = NEW.organization_id AND id = NEW.agreement_id;
		IF agr.id IS NOT NULL THEN
			IF agr.type <> 'deposit_applied_to_rent' OR agr.lease_id <> s.lease_id THEN
				RAISE EXCEPTION 'AGREEMENT_MISSING: l''accord est une imputation sur loyer de ce bail' USING ERRCODE = 'P0001';
			END IF;
			IF agr.status <> 'accepted' THEN
				RAISE EXCEPTION 'AGREEMENT_NOT_ACCEPTED: l''accord n''est pas accepté' USING ERRCODE = 'P0001';
			END IF;
			IF due_start IS NOT NULL AND (agr.decided_on >= due_start OR NOT (due_start = ANY (agr.months))) THEN
				RAISE EXCEPTION 'AGREEMENT_AFTER_PERIOD: l''accord est accepté avant le mois, et le couvre' USING ERRCODE = 'P0001';
			END IF;
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposit_settlement_lines_rules BEFORE INSERT ON deposit_settlement_lines
	FOR EACH ROW EXECUTE FUNCTION deposit_settlement_lines_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- transferts de gestion (module owners, D16)

CREATE TABLE management_transfers (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	mandate_id uuid NOT NULL,
	property_id uuid NOT NULL,
	-- Une unité, ou le bien entier.
	unit_id uuid,
	transfer_on date NOT NULL,
	-- Nouveau gestionnaire : un nom seulement, jamais un lien vers une autre organisation (règle 15).
	new_manager_name text NOT NULL CHECK (char_length(btrim(new_manager_name)) BETWEEN 2 AND 120),
	handed_over_on date NOT NULL,
	handed_over_items text[] NOT NULL CHECK (cardinality(handed_over_items) BETWEEN 1 AND 50),
	mandate_action text NOT NULL CHECK (mandate_action IN ('end_mandate', 'end_scopes')),
	note text CHECK (char_length(note) <= 1000),
	recorded_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT management_transfers_mandate_fk FOREIGN KEY (organization_id, mandate_id) REFERENCES mandates (organization_id, id),
	CONSTRAINT management_transfers_property_fk FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
	CONSTRAINT management_transfers_unit_fk FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id)
);
--> statement-breakpoint
SELECT enable_organization_rls('management_transfers');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON management_transfers FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER management_transfers_no_update_delete BEFORE UPDATE OR DELETE ON management_transfers
	FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER management_transfers_no_truncate BEFORE TRUNCATE ON management_transfers
	FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Fin d'une portée de gestion par un transfert : écrite une fois ; la portée n'est plus active (règle 12).
ALTER TABLE mandate_scopes ADD COLUMN ended_on date, ADD COLUMN management_transfer_id uuid;
--> statement-breakpoint
ALTER TABLE mandate_scopes ADD CONSTRAINT mandate_scopes_transfer_fk
	FOREIGN KEY (organization_id, management_transfer_id) REFERENCES management_transfers (organization_id, id);
--> statement-breakpoint
ALTER TABLE mandate_scopes ADD CONSTRAINT mandate_scopes_ended CHECK ((ended_on IS NULL) = (management_transfer_id IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mandate_scopes_compute() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	mandate_owner uuid;
	property_owner uuid;
BEGIN
	IF TG_OP = 'UPDATE' AND OLD.ended_on IS NOT NULL AND (NEW.ended_on, NEW.management_transfer_id)
		IS DISTINCT FROM (OLD.ended_on, OLD.management_transfer_id) THEN
		RAISE EXCEPTION 'MANDATE_SCOPE_ENDED: la fin d''une portée ne se réécrit pas' USING ERRCODE = 'P0001';
	END IF;
	SELECT m.type IN ('rental_management', 'self_managed') AND m.status = 'active', m.owner_id INTO NEW.management_active, mandate_owner
	FROM mandates m WHERE m.organization_id = NEW.organization_id AND m.id = NEW.mandate_id;
	NEW.management_active := coalesce(NEW.management_active, false) AND NEW.ended_on IS NULL;
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

-- ---------------------------------------------------------------- caution : comptes et mouvements (D32)

ALTER TABLE deposit_accounts DROP CONSTRAINT deposit_accounts_holder_check;
--> statement-breakpoint
-- `third_party` : après un transfert de gestion, le nouveau gestionnaire, nommé en texte (règle 15).
ALTER TABLE deposit_accounts ADD CONSTRAINT deposit_accounts_holder_check CHECK (holder IN ('organization', 'owner', 'third_party'));
--> statement-breakpoint
ALTER TABLE deposit_accounts ADD COLUMN holder_name text CHECK (char_length(holder_name) BETWEEN 2 AND 120);
--> statement-breakpoint
ALTER TABLE deposit_accounts ADD CONSTRAINT deposit_accounts_third_party CHECK ((holder = 'third_party') = (holder_name IS NOT NULL));
--> statement-breakpoint
ALTER TABLE deposit_movements DROP CONSTRAINT deposit_movements_type_check;
--> statement-breakpoint
ALTER TABLE deposit_movements ADD CONSTRAINT deposit_movements_type_check CHECK (
	type IN ('received', 'received_cancelled', 'retained', 'applied_to_rent', 'applied_to_debt', 'refunded', 'additional_claimed',
		'holder_changed')
);
--> statement-breakpoint
ALTER TABLE deposit_movements DROP CONSTRAINT deposit_movements_new_holder_check;
--> statement-breakpoint
ALTER TABLE deposit_movements ADD CONSTRAINT deposit_movements_new_holder_check CHECK (new_holder IN ('organization', 'owner', 'third_party'));
--> statement-breakpoint
ALTER TABLE deposit_movements
	ADD COLUMN settlement_id uuid,
	ADD COLUMN settlement_line_id uuid,
	ADD COLUMN rent_due_id uuid,
	ADD COLUMN expense_id uuid,
	ADD COLUMN repair_id uuid,
	ADD COLUMN management_transfer_id uuid,
	-- Restitution enregistrée, jamais exécutée par la plateforme (réponse 1 du porteur) : qui, moyen, référence.
	ADD COLUMN refunded_by text CHECK (refunded_by IN ('organization', 'owner')),
	ADD COLUMN refund_method text CHECK (refund_method IN ('cash', 'mobile_money', 'bank_transfer', 'cheque', 'other')),
	ADD COLUMN refund_reference text CHECK (char_length(refund_reference) BETWEEN 1 AND 60),
	ADD COLUMN new_holder_name text CHECK (char_length(new_holder_name) BETWEEN 2 AND 120);
--> statement-breakpoint
ALTER TABLE deposit_movements
	ADD CONSTRAINT deposit_movements_settlement_fk FOREIGN KEY (organization_id, settlement_id) REFERENCES deposit_settlements (organization_id, id),
	ADD CONSTRAINT deposit_movements_line_fk FOREIGN KEY (organization_id, settlement_line_id) REFERENCES deposit_settlement_lines (organization_id, id),
	ADD CONSTRAINT deposit_movements_due_fk FOREIGN KEY (organization_id, rent_due_id) REFERENCES rent_dues (organization_id, id),
	ADD CONSTRAINT deposit_movements_expense_fk FOREIGN KEY (organization_id, expense_id) REFERENCES expenses (organization_id, id),
	ADD CONSTRAINT deposit_movements_repair_fk FOREIGN KEY (organization_id, repair_id) REFERENCES repairs (organization_id, id),
	ADD CONSTRAINT deposit_movements_item_fk FOREIGN KEY (organization_id, inspection_item_id) REFERENCES inspection_items (organization_id, id),
	ADD CONSTRAINT deposit_movements_agreement_fk FOREIGN KEY (organization_id, agreement_id) REFERENCES agreements (organization_id, id),
	ADD CONSTRAINT deposit_movements_transfer_fk FOREIGN KEY (organization_id, management_transfer_id) REFERENCES management_transfers (organization_id, id),
	-- Retenue, somme due et complément réclamé n'existent qu'au décompte de sortie (D32).
	ADD CONSTRAINT deposit_movements_retained_settlement CHECK (type NOT IN ('retained', 'applied_to_debt', 'additional_claimed')
		OR settlement_id IS NOT NULL),
	-- Somme due et justifiée : l'échéance ou la dépense visée (jamais une copie), payée par un encaissement interne.
	ADD CONSTRAINT deposit_movements_debt CHECK (type <> 'applied_to_debt'
		OR (num_nonnulls(rent_due_id, expense_id) = 1 AND payment_id IS NOT NULL)),
	-- Imputation sur loyer : l'échéance du mois, payée par un encaissement interne.
	ADD CONSTRAINT deposit_movements_applied_target CHECK (type <> 'applied_to_rent' OR (rent_due_id IS NOT NULL AND payment_id IS NOT NULL)),
	ADD CONSTRAINT deposit_movements_refund CHECK (type <> 'refunded' OR (refunded_by IS NOT NULL AND refund_method IS NOT NULL)),
	ADD CONSTRAINT deposit_movements_third_party CHECK ((new_holder IS NOT DISTINCT FROM 'third_party')
		= (new_holder_name IS NOT NULL AND management_transfer_id IS NOT NULL));
--> statement-breakpoint
CREATE INDEX deposit_movements_by_settlement ON deposit_movements (organization_id, settlement_id) WHERE settlement_id IS NOT NULL;
--> statement-breakpoint
-- Règles des lots 08 et 09, plus (lot 10 bis) : `applied_to_debt` est une sortie ; une retenue vise une ligne de sortie
-- imputable au locataire avec son justificatif (règle 14) ; une imputation sur loyer, un accord accepté avant le mois
-- (D32) ; une somme due, une échéance du bail ou une dépense qui lui est réclamée, avec son justificatif ; l'encaissement
-- interne lié est une imputation sur caution de ce bail, du même montant ; un mouvement du décompte appartient au
-- décompte de ce compte ; le détenteur ne passe au nouveau gestionnaire que depuis l'organisation.
CREATE OR REPLACE FUNCTION deposit_movements_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	account deposit_accounts%ROWTYPE;
	received bigint;
	outflows bigint;
	paid_by_payment bigint;
	settlement_account uuid;
	settlement_status text;
	item_finding text;
	item_lease uuid;
	item_type text;
	due_lease uuid;
	due_start date;
	agr agreements%ROWTYPE;
	exp expenses%ROWTYPE;
	p payments%ROWTYPE;
BEGIN
	SELECT * INTO account FROM deposit_accounts WHERE organization_id = NEW.organization_id AND id = NEW.account_id FOR UPDATE;
	-- Compte introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
	IF account.id IS NULL THEN
		RETURN NEW;
	END IF;
	IF account.status = 'closed' THEN
		RAISE EXCEPTION 'DEPOSIT_ACCOUNT_CLOSED: un compte de caution soldé ne reçoit plus de mouvement' USING ERRCODE = 'P0001';
	END IF;
	SELECT coalesce(sum(amount) FILTER (WHERE type = 'received'), 0) - coalesce(sum(amount) FILTER (WHERE type = 'received_cancelled'), 0),
		coalesce(sum(amount) FILTER (WHERE type IN ('retained', 'applied_to_rent', 'applied_to_debt', 'refunded')), 0)
	INTO received, outflows
	FROM deposit_movements WHERE organization_id = NEW.organization_id AND account_id = NEW.account_id;
	IF NEW.type = 'received' AND received + NEW.amount > account.agreed_amount THEN
		RAISE EXCEPTION 'DEPOSIT_OVERPAID: versement au-delà du montant convenu' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.type IN ('retained', 'applied_to_rent', 'applied_to_debt', 'refunded') AND outflows + NEW.amount > received THEN
		RAISE EXCEPTION 'DEPOSIT_OUTFLOW_EXCEEDS_RECEIVED: les sorties ne dépassent jamais la caution reçue' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.type = 'received_cancelled' THEN
		IF received - NEW.amount < outflows THEN
			RAISE EXCEPTION 'DEPOSIT_CANCELLATION_BELOW_OUTFLOWS: annuler ce versement ferait passer la caution reçue sous les sorties déjà faites'
				USING ERRCODE = 'P0001';
		END IF;
		SELECT coalesce(sum(amount) FILTER (WHERE type = 'received'), 0) - coalesce(sum(amount) FILTER (WHERE type = 'received_cancelled'), 0)
		INTO paid_by_payment
		FROM deposit_movements WHERE organization_id = NEW.organization_id AND account_id = NEW.account_id AND payment_id = NEW.payment_id;
		IF NEW.amount > paid_by_payment THEN
			RAISE EXCEPTION 'DEPOSIT_CANCELLATION_UNMATCHED: on n''annule que ce que cet encaissement a versé' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.type = 'holder_changed' AND NEW.previous_holder IS DISTINCT FROM account.holder THEN
		RAISE EXCEPTION 'DEPOSIT_HOLDER_MISMATCH: le changement part du détenteur actuel (%)', account.holder USING ERRCODE = 'P0001';
	END IF;
	IF NEW.type = 'holder_changed' AND NEW.new_holder = 'owner'
		AND (SELECT type FROM organizations WHERE id = NEW.organization_id) = 'landlord' THEN
		RAISE EXCEPTION 'LANDLORD_IS_HOLDER: un bailleur particulier détient lui-même la caution' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.type = 'holder_changed' AND NEW.new_holder = 'third_party' AND NEW.previous_holder <> 'organization' THEN
		RAISE EXCEPTION 'DEPOSIT_HOLDER_MISMATCH: seule une caution détenue par l''organisation passe au nouveau gestionnaire' USING ERRCODE = 'P0001';
	END IF;
	-- Mouvement du décompte : celui de ce compte, pas encore clos.
	IF NEW.settlement_id IS NOT NULL THEN
		SELECT deposit_account_id, status INTO settlement_account, settlement_status
		FROM deposit_settlements WHERE organization_id = NEW.organization_id AND id = NEW.settlement_id;
		IF settlement_account IS NOT NULL AND settlement_account <> NEW.account_id THEN
			RAISE EXCEPTION 'SETTLEMENT_ACCOUNT_MISMATCH: le décompte est celui de ce compte de caution' USING ERRCODE = 'P0001';
		END IF;
		IF settlement_status = 'draft' THEN
			RAISE EXCEPTION 'SETTLEMENT_LOCKED: un brouillon n''écrit aucun mouvement' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	-- Retenue (règle 14) : ligne de sortie de ce bail, imputable au locataire, avec son devis ou sa facture.
	IF NEW.type = 'retained' AND NEW.inspection_item_id IS NOT NULL THEN
		SELECT it.finding, i.lease_id, i.type INTO item_finding, item_lease, item_type
		FROM inspection_items it JOIN inspections i ON i.organization_id = it.organization_id AND i.id = it.inspection_id
		WHERE it.organization_id = NEW.organization_id AND it.id = NEW.inspection_item_id;
		IF item_lease IS NOT NULL AND (item_lease <> account.lease_id OR item_type <> 'exit' OR item_finding IS DISTINCT FROM 'tenant_damage') THEN
			RAISE EXCEPTION 'RETENTION_NOT_TENANT_DAMAGE: une retenue vise une ligne de sortie de ce bail, imputable au locataire'
				USING ERRCODE = 'P0001';
		END IF;
		IF NEW.document_id IS NOT NULL
			AND NOT exit_document_ok(NEW.organization_id, NEW.document_id, account.lease_id, ARRAY['repair_quote', 'expense_receipt']) THEN
			RAISE EXCEPTION 'RETENTION_PROOF_MISSING: une retenue a son devis ou sa facture' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.rent_due_id IS NOT NULL THEN
		SELECT lease_id, period_start INTO due_lease, due_start FROM rent_dues WHERE organization_id = NEW.organization_id AND id = NEW.rent_due_id;
		IF due_lease IS NOT NULL AND due_lease <> account.lease_id THEN
			RAISE EXCEPTION 'DEBT_NOT_THIS_LEASE: l''échéance est celle du bail de la caution' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	-- Imputation sur loyer (D32) : accord écrit, accepté avant le mois, qui le couvre.
	IF NEW.type = 'applied_to_rent' AND NEW.agreement_id IS NOT NULL THEN
		SELECT * INTO agr FROM agreements WHERE organization_id = NEW.organization_id AND id = NEW.agreement_id;
		IF agr.id IS NOT NULL THEN
			IF agr.type <> 'deposit_applied_to_rent' OR agr.lease_id <> account.lease_id THEN
				RAISE EXCEPTION 'AGREEMENT_MISSING: l''accord est une imputation sur loyer de ce bail' USING ERRCODE = 'P0001';
			END IF;
			IF agr.status <> 'accepted' THEN
				RAISE EXCEPTION 'AGREEMENT_NOT_ACCEPTED: l''accord n''est pas accepté' USING ERRCODE = 'P0001';
			END IF;
			IF due_start IS NOT NULL AND (agr.decided_on >= due_start OR NOT (due_start = ANY (agr.months))) THEN
				RAISE EXCEPTION 'AGREEMENT_AFTER_PERIOD: l''accord est accepté avant le mois, et le couvre' USING ERRCODE = 'P0001';
			END IF;
		END IF;
	END IF;
	-- Somme due : une dépense réclamée au locataire de ce bail, avec son justificatif (D32).
	IF NEW.type = 'applied_to_debt' AND NEW.expense_id IS NOT NULL THEN
		SELECT * INTO exp FROM expenses WHERE organization_id = NEW.organization_id AND id = NEW.expense_id;
		IF exp.id IS NOT NULL AND (exp.recovery <> 'claimed_from_tenant' OR exp.status <> 'recorded' OR exp.lease_id IS DISTINCT FROM account.lease_id) THEN
			RAISE EXCEPTION 'DEBT_NOT_CLAIMED: la dépense est réclamée au locataire de ce bail' USING ERRCODE = 'P0001';
		END IF;
		IF exp.id IS NOT NULL AND exp.document_id IS NULL THEN
			RAISE EXCEPTION 'DEBT_PROOF_MISSING: une dépense retenue sur la caution a son justificatif' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	-- Encaissement interne : une imputation sur caution de ce bail, du même montant, visant la même échéance ou dépense.
	IF NEW.type IN ('applied_to_rent', 'applied_to_debt') AND NEW.payment_id IS NOT NULL THEN
		SELECT * INTO p FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.payment_id;
		IF p.id IS NOT NULL AND (p.method <> 'deposit_offset' OR p.kind <> 'payment' OR p.lease_id <> account.lease_id OR p.amount <> NEW.amount
			OR (NEW.expense_id IS NOT NULL AND p.expense_id IS DISTINCT FROM NEW.expense_id)
			OR (NEW.rent_due_id IS NOT NULL AND p.purpose <> 'rent')) THEN
			RAISE EXCEPTION 'DEPOSIT_OFFSET_MISMATCH: l''encaissement lié est une imputation sur caution de ce bail, du même montant'
				USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Détenteur suivi (avec le nom du nouveau gestionnaire) ; un transfert de gestion solde le compte chez l'organisation.
CREATE OR REPLACE FUNCTION deposit_movements_apply() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	received bigint;
BEGIN
	SELECT coalesce(sum(amount) FILTER (WHERE type = 'received'), 0) - coalesce(sum(amount) FILTER (WHERE type = 'received_cancelled'), 0)
	INTO received FROM deposit_movements
	WHERE organization_id = NEW.organization_id AND account_id = NEW.account_id;
	UPDATE deposit_accounts SET
		holder = CASE WHEN NEW.type = 'holder_changed' THEN NEW.new_holder ELSE holder END,
		holder_name = CASE WHEN NEW.type = 'holder_changed' THEN NEW.new_holder_name ELSE holder_name END,
		status = CASE
			WHEN NEW.type = 'holder_changed' AND NEW.new_holder = 'third_party' THEN 'closed'
			WHEN status IN ('settling', 'closed') THEN status
			WHEN received = 0 THEN 'pending'
			WHEN received < agreed_amount THEN 'partially_received'
			ELSE 'held'
		END,
		updated_at = now()
	WHERE organization_id = NEW.organization_id AND id = NEW.account_id;
	RETURN NULL;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- encaissement interne : imputation sur caution (D32)

ALTER TABLE payments DROP CONSTRAINT payments_method_check;
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_method_check
	CHECK (method IN ('cash', 'mobile_money_manual', 'bank_transfer', 'mobile_money_direct', 'deposit_offset'));
--> statement-breakpoint
-- Une imputation sur caution couvre un loyer ou une dépense, jamais une caution ; sans opérateur ni référence.
ALTER TABLE payments ADD CONSTRAINT payments_deposit_offset CHECK (method <> 'deposit_offset'
	OR (purpose IN ('rent', 'expense') AND operator IS NULL AND transaction_reference IS NULL));
--> statement-breakpoint
-- Règles du lot 10, plus : `deposit_offset` naît confirmé, avec son auteur (le serveur, au nom de la personne qui clôt
-- le décompte ou applique l'accord) ; il n'est jamais saisi (packages/shared refuse le moyen à la saisie).
CREATE OR REPLACE FUNCTION payments_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease leases%ROWTYPE;
	account_lease uuid;
	original payments%ROWTYPE;
	claim expenses%ROWTYPE;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT * INTO lease FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
		-- Bail introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
		IF lease.id IS NOT NULL THEN
			IF lease.status NOT IN ('signed', 'active', 'notice', 'ended') THEN
				RAISE EXCEPTION 'PAYMENT_LEASE_NOT_VALIDATED: pas d''encaissement sur un bail brouillon ou annulé' USING ERRCODE = 'P0001';
			END IF;
			NEW.tenant_id := lease.tenant_id;
		END IF;
		IF NEW.deposit_account_id IS NOT NULL THEN
			SELECT lease_id INTO account_lease FROM deposit_accounts WHERE organization_id = NEW.organization_id AND id = NEW.deposit_account_id;
			IF account_lease IS NOT NULL AND account_lease <> NEW.lease_id THEN
				RAISE EXCEPTION 'PAYMENT_DEPOSIT_ACCOUNT_LEASE: le compte de caution appartient à un autre bail' USING ERRCODE = 'P0001';
			END IF;
		END IF;
		IF NEW.expense_id IS NOT NULL AND NEW.kind = 'payment' THEN
			SELECT * INTO claim FROM expenses WHERE organization_id = NEW.organization_id AND id = NEW.expense_id;
			-- Dépense introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
			IF claim.id IS NOT NULL THEN
				IF claim.recovery <> 'claimed_from_tenant' OR claim.lease_id IS DISTINCT FROM NEW.lease_id THEN
					RAISE EXCEPTION 'PAYMENT_EXPENSE_NOT_CLAIMED: la dépense n''est pas réclamée au locataire de ce bail' USING ERRCODE = 'P0001';
				END IF;
				IF claim.status = 'cancelled' THEN
					RAISE EXCEPTION 'PAYMENT_EXPENSE_CANCELLED: la dépense est annulée' USING ERRCODE = 'P0001';
				END IF;
			END IF;
		END IF;
		IF NEW.kind = 'payment' THEN
			-- Statut à la saisie (règle 6, initialPaymentStatus) : jamais `confirmed` sur preuve absente.
			IF NOT (
				(NEW.method = 'cash' AND NEW.status IN ('to_validate', 'confirmed'))
				OR (NEW.method IN ('mobile_money_manual', 'bank_transfer') AND NEW.status = 'to_reconcile')
				OR (NEW.method = 'mobile_money_direct' AND NEW.status = 'initiated')
				OR (NEW.method = 'deposit_offset' AND NEW.status = 'confirmed')
			) THEN
				RAISE EXCEPTION 'PAYMENT_INITIAL_STATUS: statut % impossible à la saisie d''un paiement %', NEW.status, NEW.method USING ERRCODE = 'P0001';
			END IF;
			IF NEW.status = 'confirmed' AND NEW.confirmed_by IS NULL THEN
				RAISE EXCEPTION 'PAYMENT_CONFIRMED_BY: une confirmation a son auteur' USING ERRCODE = 'P0001';
			END IF;
		ELSE
			-- Contre-écriture : d'un encaissement confirmé puis annulé, même bail, même objet, même montant.
			SELECT * INTO original FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.reverses_payment_id FOR UPDATE;
			IF original.id IS NOT NULL AND (
				original.kind <> 'payment' OR original.status <> 'cancelled' OR original.confirmed_at IS NULL
				OR original.lease_id <> NEW.lease_id OR original.purpose <> NEW.purpose
				OR original.deposit_account_id IS DISTINCT FROM NEW.deposit_account_id
				OR original.expense_id IS DISTINCT FROM NEW.expense_id OR original.amount <> NEW.amount
			) THEN
				RAISE EXCEPTION 'PAYMENT_REVERSAL_INVALID: une contre-écriture compense un encaissement confirmé puis annulé, à l''identique'
					USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;

	-- Modification : le montant et tout ce qui décrit l'encaissement sont figés (règle 3).
	IF NEW.amount IS DISTINCT FROM OLD.amount THEN
		RAISE EXCEPTION 'PAYMENT_AMOUNT_IMMUTABLE: le montant d''un encaissement ne change jamais ; corrigez par une annulation'
			USING ERRCODE = 'P0001';
	END IF;
	IF (NEW.id, NEW.organization_id, NEW.kind, NEW.reverses_payment_id, NEW.lease_id, NEW.tenant_id, NEW.purpose,
		NEW.deposit_account_id, NEW.expense_id, NEW.method, NEW.operator, NEW.transaction_reference, NEW.paid_on, NEW.provider,
		NEW.idempotency_key, NEW.note, NEW.recorded_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.kind, OLD.reverses_payment_id, OLD.lease_id, OLD.tenant_id, OLD.purpose,
		OLD.deposit_account_id, OLD.expense_id, OLD.method, OLD.operator, OLD.transaction_reference, OLD.paid_on, OLD.provider,
		OLD.idempotency_key, OLD.note, OLD.recorded_by, OLD.created_at) THEN
		RAISE EXCEPTION 'PAYMENT_IMMUTABLE: un encaissement enregistré ne se modifie pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.kind = 'reversal' THEN
		RAISE EXCEPTION 'PAYMENT_IMMUTABLE: une contre-écriture ne se modifie pas' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT payment_transition_allowed(OLD.status, NEW.status) THEN
		RAISE EXCEPTION 'PAYMENT_TRANSITION_FORBIDDEN: transition % → % refusée', OLD.status, NEW.status USING ERRCODE = 'P0001';
	END IF;
	-- Chaque champ du cycle s'écrit une seule fois.
	IF OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_at, NEW.confirmed_by) IS DISTINCT FROM (OLD.confirmed_at, OLD.confirmed_by) THEN
		RAISE EXCEPTION 'PAYMENT_IMMUTABLE: la confirmation ne se réécrit pas' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'confirmed' AND OLD.status <> 'confirmed' AND (NEW.confirmed_at IS NULL OR NEW.confirmed_by IS NULL) AND OLD.method <> 'mobile_money_direct' THEN
		RAISE EXCEPTION 'PAYMENT_CONFIRMED_BY: une validation a son auteur et sa date' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL AND NEW.status <> 'confirmed' THEN
		RAISE EXCEPTION 'PAYMENT_IMMUTABLE: une date de confirmation sans confirmation' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at, NEW.cancelled_by, NEW.cancellation_reason)
		IS DISTINCT FROM (OLD.cancelled_at, OLD.cancelled_by, OLD.cancellation_reason) THEN
		RAISE EXCEPTION 'PAYMENT_IMMUTABLE: l''annulation ne se réécrit pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
		RAISE EXCEPTION 'PAYMENT_IMMUTABLE: la référence du prestataire ne se réécrit pas' USING ERRCODE = 'P0001';
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Une imputation sur caution n'existe jamais seule : à la validation de la transaction, un mouvement de caution
-- (`applied_to_rent` ou `applied_to_debt`) la porte, du même montant (règle 14, D32).
CREATE FUNCTION payments_deposit_offset_backed() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF NEW.method = 'deposit_offset' AND NEW.kind = 'payment' AND NOT EXISTS (
		SELECT FROM deposit_movements m
		WHERE m.organization_id = NEW.organization_id AND m.payment_id = NEW.id AND m.type IN ('applied_to_rent', 'applied_to_debt')
			AND m.amount = NEW.amount
	) THEN
		RAISE EXCEPTION 'DEPOSIT_OFFSET_UNBACKED: une imputation sur caution est portée par un mouvement de caution' USING ERRCODE = 'P0001';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payments_deposit_offset_backed AFTER INSERT ON payments
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments_deposit_offset_backed();
--> statement-breakpoint
-- Provenance d'une imputation et d'un reçu, recopiée de l'encaissement par la base : `deposit` pour une imputation sur
-- caution. Les streams de l'agent de terrain s'en servent : il ne reçoit jamais rien de la caution.
ALTER TABLE payment_allocations ADD COLUMN source text NOT NULL DEFAULT 'tenant' CHECK (source IN ('tenant', 'deposit'));
--> statement-breakpoint
ALTER TABLE receipts ADD COLUMN source text NOT NULL DEFAULT 'tenant' CHECK (source IN ('tenant', 'deposit'));
--> statement-breakpoint
CREATE FUNCTION payment_source_copy() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	m text;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		NEW.source := OLD.source;
		RETURN NEW;
	END IF;
	SELECT method INTO m FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.payment_id;
	NEW.source := CASE WHEN m = 'deposit_offset' THEN 'deposit' ELSE 'tenant' END;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_source BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION payment_source_copy();
--> statement-breakpoint
CREATE TRIGGER receipts_source BEFORE INSERT OR UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION payment_source_copy();
--> statement-breakpoint

-- ---------------------------------------------------------------- échéances : dernière période à la sortie (D32)

ALTER TABLE rent_dues ADD COLUMN exit_adjusted_at timestamptz;
--> statement-breakpoint
-- Règles du lot 09, plus : à la sortie (bail en préavis ou terminé), la dernière période se ramène une fois au dernier
-- jour facturé, à un montant inférieur (exitDueAdjustments, même mode de découpage) ; le surplus déjà payé est d'abord
-- rendu au crédit du bail (le montant payé ne dépasse jamais le montant dû).
CREATE OR REPLACE FUNCTION rent_dues_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease_status text;
	allocated bigint;
	exit_adjustment boolean;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT status INTO lease_status FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
		-- Bail introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
		IF lease_status IS NOT NULL AND lease_status NOT IN ('signed', 'active', 'notice') THEN
			RAISE EXCEPTION 'RENT_DUE_LEASE_NOT_VALIDATED: pas d''échéance pour un bail brouillon, terminé ou annulé' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.amount_paid <> 0 THEN
			RAISE EXCEPTION 'RENT_DUE_PAID_BY_ALLOCATIONS: une échéance naît sans paiement' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.exit_adjusted_at IS NOT NULL THEN
			RAISE EXCEPTION 'RENT_DUE_EXIT_ADJUSTMENT: une échéance naît sans ajustement de sortie' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	exit_adjustment := OLD.exit_adjusted_at IS NULL AND NEW.exit_adjusted_at IS NOT NULL;
	IF OLD.exit_adjusted_at IS NOT NULL AND NEW.exit_adjusted_at IS DISTINCT FROM OLD.exit_adjusted_at THEN
		RAISE EXCEPTION 'RENT_DUE_EXIT_ADJUSTMENT: l''ajustement de sortie ne se fait qu''une fois' USING ERRCODE = 'P0001';
	END IF;
	IF exit_adjustment THEN
		SELECT status INTO lease_status FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
		IF lease_status NOT IN ('notice', 'ended') THEN
			RAISE EXCEPTION 'RENT_DUE_EXIT_ADJUSTMENT: seulement à la sortie (bail en préavis ou terminé)' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.amount_due > OLD.amount_due OR NEW.period_end > OLD.period_end OR NEW.period_end < NEW.period_start
			OR (NEW.id, NEW.organization_id, NEW.lease_id, NEW.period_start, NEW.is_advance, NEW.created_at, NEW.due_on, NEW.lease_version)
			IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.lease_id, OLD.period_start, OLD.is_advance, OLD.created_at, OLD.due_on,
			OLD.lease_version) THEN
			RAISE EXCEPTION 'RENT_DUE_EXIT_ADJUSTMENT: la dernière période se raccourcit et son montant baisse, rien d''autre' USING ERRCODE = 'P0001';
		END IF;
	ELSE
		IF (NEW.id, NEW.organization_id, NEW.lease_id, NEW.period_start, NEW.period_end, NEW.prorated, NEW.is_advance, NEW.created_at)
			IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.lease_id, OLD.period_start, OLD.period_end, OLD.prorated, OLD.is_advance,
			OLD.created_at) THEN
			RAISE EXCEPTION 'RENT_DUE_IMMUTABLE: la période d''une échéance ne change pas' USING ERRCODE = 'P0001';
		END IF;
		IF (NEW.rent, NEW.charges, NEW.amount_due, NEW.due_on, NEW.lease_version)
			IS DISTINCT FROM (OLD.rent, OLD.charges, OLD.amount_due, OLD.due_on, OLD.lease_version)
			AND (OLD.status <> 'upcoming' OR OLD.amount_paid > 0) THEN
			RAISE EXCEPTION 'RENT_DUE_ISSUED: une échéance émise ne change plus de montant' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF OLD.status = 'waived' AND NEW.status <> 'waived' THEN
		RAISE EXCEPTION 'RENT_DUE_WAIVED: une échéance abandonnée le reste' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid THEN
		SELECT coalesce(sum(CASE direction WHEN 'allocate' THEN amount ELSE -amount END), 0) INTO allocated
		FROM payment_allocations WHERE organization_id = NEW.organization_id AND rent_due_id = NEW.id;
		IF NEW.amount_paid <> allocated THEN
			RAISE EXCEPTION 'RENT_DUE_PAID_BY_ALLOCATIONS: le montant payé est la somme des imputations (%)', allocated USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- baux : préavis et fin (D14)

-- Nature de la fin : départ du locataire, congé du bailleur, transfert de gestion (le locataire reste, chez un autre
-- gestionnaire : l'unité n'est pas à remettre en état), autre.
ALTER TABLE leases ADD COLUMN end_kind text CHECK (end_kind IN ('tenant_exit', 'lessor_notice', 'management_transfer', 'other'));
--> statement-breakpoint
ALTER TABLE leases ADD CONSTRAINT leases_end_kind CHECK (status <> 'ended' OR (end_kind IS NOT NULL AND exit_on IS NOT NULL));
--> statement-breakpoint
ALTER TABLE leases ADD CONSTRAINT leases_notice_dates CHECK (status <> 'notice' OR (notice_given_on IS NOT NULL AND exit_on IS NOT NULL));
--> statement-breakpoint
-- Un bail ne passe en préavis qu'avec un congé enregistré (une demande n'en est pas un) ; une fois en préavis ou
-- terminé, ses dates de sortie ne changent plus.
CREATE FUNCTION leases_exit_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF NEW.status = 'notice' AND OLD.status <> 'notice' AND NOT EXISTS (
		SELECT FROM lease_notices n WHERE n.organization_id = NEW.organization_id AND n.lease_id = NEW.id AND n.status = 'recorded'
			AND n.notified_on = NEW.notice_given_on AND n.planned_exit_on = NEW.exit_on
	) THEN
		RAISE EXCEPTION 'LEASE_NOTICE_REQUIRED: le préavis suit un congé enregistré (dates du congé)' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'notice' AND (NEW.notice_given_on, NEW.exit_on) IS DISTINCT FROM (OLD.notice_given_on, OLD.exit_on) THEN
		RAISE EXCEPTION 'LEASE_NOTICE_LOCKED: les dates du préavis ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status IN ('signed', 'active') AND NEW.status = OLD.status
		AND (NEW.notice_given_on, NEW.exit_on, NEW.end_kind) IS DISTINCT FROM (OLD.notice_given_on, OLD.exit_on, OLD.end_kind) THEN
		RAISE EXCEPTION 'LEASE_NOTICE_REQUIRED: les dates de sortie s''écrivent avec le préavis ou la fin du bail' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER leases_exit_rules BEFORE UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION leases_exit_rules();
--> statement-breakpoint
-- D14, règle 13 : la fin d'un bail fait passer une unité prête « à remettre en état », jamais directement disponible ;
-- un autre état technique est gardé (il n'est pas disponible non plus). Un transfert de gestion ne libère pas le
-- logement. SECURITY DEFINER : l'agent qui fait la tâche du jour n'a pas à modifier l'unité lui-même ; la mise à jour
-- reste dans l'organisation du bail (RLS forcée).
CREATE FUNCTION leases_end_refurbish() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF NEW.end_kind IS DISTINCT FROM 'management_transfer' THEN
		UPDATE units SET technical_status = 'to_refurbish', technical_reason = 'Fin de bail : à remettre en état', technical_expected_on = NULL,
			updated_at = now()
		WHERE organization_id = NEW.organization_id AND id = NEW.unit_id AND technical_status = 'ready';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION leases_end_refurbish() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER leases_end_refurbish AFTER UPDATE OF status ON leases
	FOR EACH ROW WHEN (NEW.status = 'ended' AND OLD.status IS DISTINCT FROM 'ended') EXECUTE FUNCTION leases_end_refurbish();
--> statement-breakpoint

-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)

GRANT SELECT ON lease_notices, inspections, inspection_items, inspection_catalog_entries, agreements, repairs, deposit_settlements,
	deposit_settlement_lines, management_transfers TO app_sync;
--> statement-breakpoint
CREATE POLICY sync_read ON lease_notices FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON inspections FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON inspection_items FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON inspection_catalog_entries FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON agreements FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON repairs FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON deposit_settlements FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON deposit_settlement_lines FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON management_transfers FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE lease_notices, inspections, inspection_items, inspection_catalog_entries, agreements, repairs,
	deposit_settlements, deposit_settlement_lines, management_transfers;
