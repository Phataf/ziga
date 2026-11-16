-- Lot 08 bis — contrats de bail, versions, modèles et avenants (module leases ; fichiers dans le registre documents).
-- Décisions D20 à D25, D29 ; règles 1, 4 et 17 de CLAUDE.md. Les règles pures sont dans packages/shared
-- (contracts.ts, contract-fields.ts).
--
-- - contract_templates : modèle Word de l'organisation (bail ou avenant), inspecté par l'API (balises reconnues et
--   inconnues, polices) ; un seul modèle actif par organisation et par type ; une balise inconnue interdit l'activation.
--   Le modèle par défaut de la plateforme (D25) n'est pas une ligne : c'est un fichier de l'API, cité par sa version.
-- - lease_contracts : le document du bail (ou d'un avenant), avec son cycle propre (brouillon, vérification, prêt à
--   signer, signé ; D20), ses signataires attendus, la signature manuscrite déposée en scan (D21), la légalisation et
--   l'enregistrement (suivis, jamais bloquants). Un contrat d'origine `uploaded_scan` naît signé, sans version.
-- - contract_versions : chaque génération, jamais écrasée (ajout seul) : copie des données et des valeurs résolues
--   (D29), fichiers Word et PDF du registre documents et leur empreinte SHA-256.
-- - lease_amendments : renouvellement, changement de loyer ou autre modification, appliqué au bail à la signature de
--   son contrat par le même mécanisme que la route du lot 08.
-- - leases : un renouvellement (avenant ou reconduction au terme) prolonge le même bail par sa version suivante.
-- - documents : types du contrat, Word (.docx) pour les modèles et les projets, rattachement au contrat ou au modèle.
-- - Reprise : chaque bail qui a déjà un bail signé scanné (lot 08) reçoit un contrat `uploaded_scan` signé, en
--   « signature manuscrite, scan déposé ».
-- Chaque table : organization_id, RLS d'organisation, clés composites, jamais supprimée, publiée vers PowerSync.

-- ---------------------------------------------------------------- documents : types, Word, rattachements

ALTER TABLE documents DROP CONSTRAINT documents_type_check;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN ('title_deed', 'puh', 'allocation_certificate', 'apfr',
	'owner_identity', 'mandate', 'document_photo', 'other', 'signed_lease_scan', 'tenant_identity', 'contract_template', 'contract_draft',
	'signed_amendment_scan', 'contract_legalization', 'contract_registration'));
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT documents_mime_type_check;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_mime_type_check CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png',
	'image/webp', 'image/heic', 'image/heif', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
--> statement-breakpoint
-- Le Word n'existe que pour un modèle ou un projet de contrat (généré par le serveur).
ALTER TABLE documents ADD CONSTRAINT documents_docx_types CHECK (
	mime_type <> 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' OR type IN ('contract_template', 'contract_draft')
);
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN lease_contract_id uuid, ADD COLUMN contract_template_id uuid;
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT documents_subject;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_subject CHECK (
	num_nonnulls(owner_id, mandate_id, property_id, tenant_id, lease_id, lease_contract_id, contract_template_id) >= 1
);
--> statement-breakpoint
-- Un modèle se rattache à son modèle ; un projet, un avenant signé, une preuve de légalisation ou d'enregistrement, à
-- leur contrat (et à leur bail).
ALTER TABLE documents ADD CONSTRAINT documents_contract_types CHECK (
	(type <> 'contract_template' OR contract_template_id IS NOT NULL)
	AND (type NOT IN ('contract_draft', 'signed_amendment_scan', 'contract_legalization', 'contract_registration')
		OR (lease_contract_id IS NOT NULL AND lease_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX documents_by_contract ON documents (organization_id, lease_contract_id) WHERE lease_contract_id IS NOT NULL;
--> statement-breakpoint
-- Même règle de version qu'aux lots 07 et 08, avec les deux nouveaux objets liés.
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
				OR NEW.contract_template_id IS DISTINCT FROM previous.contract_template_id THEN
				RAISE EXCEPTION 'DOCUMENT_VERSION_SUBJECT: une nouvelle version garde le type et les objets liés' USING ERRCODE = 'P0001';
			END IF;
			IF NEW.version <> previous.version + 1 THEN
				RAISE EXCEPTION 'DOCUMENT_VERSION: la nouvelle version est la %', previous.version + 1 USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	IF ROW(NEW.type, NEW.owner_id, NEW.mandate_id, NEW.property_id, NEW.unit_id, NEW.tenant_id, NEW.lease_id, NEW.lease_contract_id,
			NEW.contract_template_id, NEW.version, NEW.replaces_id, NEW.file_name, NEW.mime_type, NEW.byte_size, NEW.storage_key, NEW.uploaded_by,
			NEW.created_at)
		IS DISTINCT FROM ROW(OLD.type, OLD.owner_id, OLD.mandate_id, OLD.property_id, OLD.unit_id, OLD.tenant_id, OLD.lease_id,
			OLD.lease_contract_id, OLD.contract_template_id, OLD.version, OLD.replaces_id, OLD.file_name, OLD.mime_type, OLD.byte_size,
			OLD.storage_key, OLD.uploaded_by, OLD.created_at) THEN
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

-- ---------------------------------------------------------------- baux : renouvellement par version

ALTER TABLE leases ADD COLUMN last_renewed_on date, ADD COLUMN last_renewal_automatic boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE leases ADD CONSTRAINT leases_renewal CHECK (
	(last_renewed_on IS NULL AND NOT last_renewal_automatic) OR (last_renewed_on IS NOT NULL AND status <> 'draft')
);
--> statement-breakpoint
-- Cycle du bail (lot 08), plus le renouvellement (lot 08 bis) : un bail signé ou en vigueur, à durée déterminée, se
-- prolonge par sa version suivante (nouvelle fin postérieure, ou durée indéterminée), par un avenant signé ou par la
-- reconduction de son terme. Un même changement ne prolonge pas et ne change pas le loyer à la fois.
CREATE OR REPLACE FUNCTION leases_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	org_type text;
	renewal boolean;
	rent_change boolean;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.version <> 1 OR NEW.status NOT IN ('draft', 'signed', 'active') THEN
			RAISE EXCEPTION 'LEASE_BORN_DRAFT_OR_VALIDATED: un bail naît brouillon ou validé, en version 1' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.rent_effective_from <> NEW.dues_start_on THEN
			RAISE EXCEPTION 'LEASE_RENT_EFFECTIVE: le premier loyer s''applique dès le début de la facturation' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.last_renewed_on IS NOT NULL THEN
			RAISE EXCEPTION 'LEASE_RENEWAL: un bail naît sans renouvellement' USING ERRCODE = 'P0001';
		END IF;
		SELECT type INTO org_type FROM organizations WHERE id = NEW.organization_id;
		IF org_type = 'landlord' AND NEW.lessor_type <> 'organization' THEN
			RAISE EXCEPTION 'LANDLORD_IS_LESSOR: un bailleur particulier est lui-même le bailleur désigné' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.unit_id <> OLD.unit_id
		OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
		RAISE EXCEPTION 'LEASE_IMMUTABLE: l''unité d''un bail ne change pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status IN ('ended', 'cancelled') THEN
		RAISE EXCEPTION 'LEASE_CLOSED: un bail terminé ou annulé ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status IN ('signed', 'active', 'cancelled'))
		OR (OLD.status = 'signed' AND NEW.status IN ('active', 'cancelled'))
		OR (OLD.status = 'active' AND NEW.status IN ('notice', 'ended'))
		OR (OLD.status = 'notice' AND NEW.status = 'ended')
	) THEN
		RAISE EXCEPTION 'LEASE_STATUS: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'draft' THEN
		-- Brouillon : tout se modifie (assistant), sans version ; le premier loyer suit le début de la facturation.
		IF NEW.version <> 1 THEN
			RAISE EXCEPTION 'LEASE_VERSION: un brouillon reste en version 1' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.rent_effective_from <> NEW.dues_start_on THEN
			RAISE EXCEPTION 'LEASE_RENT_EFFECTIVE: le premier loyer s''applique dès le début de la facturation' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.last_renewed_on IS NOT NULL THEN
			RAISE EXCEPTION 'LEASE_RENEWAL: un brouillon ne se renouvelle pas' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.lessor_type <> OLD.lessor_type THEN
			SELECT type INTO org_type FROM organizations WHERE id = NEW.organization_id;
			IF org_type = 'landlord' AND NEW.lessor_type <> 'organization' THEN
				RAISE EXCEPTION 'LANDLORD_IS_LESSOR: un bailleur particulier est lui-même le bailleur désigné' USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	-- Bail validé : conditions figées, sauf le loyer (version suivante) et la fin (renouvellement, version suivante).
	IF (NEW.tenant_id, NEW.starts_on, NEW.dues_start_on, NEW.periodicity, NEW.due_day, NEW.billing_mode, NEW.advance_months,
		NEW.lessor_type, NEW.payment_terms, NEW.penalty_rate_bp, NEW.penalty_grace_days, NEW.penalty_beneficiary,
		NEW.notice_tenant_fixed_term_months, NEW.notice_tenant_open_ended_months, NEW.notice_lessor_fixed_term_months,
		NEW.notice_lessor_open_ended_months, NEW.reduced_notice_months, NEW.reduced_notice_cases, NEW.early_termination_indemnity_months,
		NEW.renewal_mode, NEW.deposit_refund_days, NEW.activated_on, NEW.activated_at)
		IS DISTINCT FROM (OLD.tenant_id, OLD.starts_on, OLD.dues_start_on, OLD.periodicity, OLD.due_day, OLD.billing_mode,
		OLD.advance_months, OLD.lessor_type, OLD.payment_terms, OLD.penalty_rate_bp, OLD.penalty_grace_days, OLD.penalty_beneficiary,
		OLD.notice_tenant_fixed_term_months, OLD.notice_tenant_open_ended_months, OLD.notice_lessor_fixed_term_months,
		OLD.notice_lessor_open_ended_months, OLD.reduced_notice_months, OLD.reduced_notice_cases, OLD.early_termination_indemnity_months,
		OLD.renewal_mode, OLD.deposit_refund_days, OLD.activated_on, OLD.activated_at) THEN
		RAISE EXCEPTION 'LEASE_TERMS_LOCKED: les conditions d''un bail validé ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	-- Un renouvellement porte une nouvelle date de renouvellement ; sans elle, la fin reste une condition figée (lot 08).
	renewal := NEW.last_renewed_on IS DISTINCT FROM OLD.last_renewed_on;
	IF NOT renewal AND (NEW.ends_on, NEW.duration_months, NEW.last_renewal_automatic)
		IS DISTINCT FROM (OLD.ends_on, OLD.duration_months, OLD.last_renewal_automatic) THEN
		RAISE EXCEPTION 'LEASE_TERMS_LOCKED: les conditions d''un bail validé ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	rent_change := (NEW.rent, NEW.charges, NEW.rent_effective_from) IS DISTINCT FROM (OLD.rent, OLD.charges, OLD.rent_effective_from);
	IF renewal AND rent_change THEN
		RAISE EXCEPTION 'LEASE_VERSION: un renouvellement et un changement de loyer sont deux versions' USING ERRCODE = 'P0001';
	END IF;
	IF renewal THEN
		IF OLD.status NOT IN ('signed', 'active') THEN
			RAISE EXCEPTION 'LEASE_RENEWAL: seul un bail signé ou en vigueur, sans préavis, se renouvelle' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.ends_on IS NULL THEN
			RAISE EXCEPTION 'LEASE_RENEWAL: un bail sans fin ne se renouvelle pas' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.ends_on IS NOT NULL AND NEW.ends_on <= OLD.ends_on THEN
			RAISE EXCEPTION 'LEASE_RENEWAL: la nouvelle fin suit l''ancienne' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.last_renewed_on IS NULL OR (OLD.last_renewed_on IS NOT NULL AND NEW.last_renewed_on <= OLD.last_renewed_on) THEN
			RAISE EXCEPTION 'LEASE_RENEWAL: un renouvellement porte sa date, après le précédent' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.version <> OLD.version + 1 THEN
			RAISE EXCEPTION 'LEASE_VERSION: un renouvellement crée la version %', OLD.version + 1 USING ERRCODE = 'P0001';
		END IF;
	ELSIF rent_change THEN
		IF OLD.status NOT IN ('signed', 'active', 'notice') THEN
			RAISE EXCEPTION 'LEASE_CLOSED: un bail terminé ou annulé ne change plus' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.version <> OLD.version + 1 THEN
			RAISE EXCEPTION 'LEASE_VERSION: un changement de loyer crée la version %', OLD.version + 1 USING ERRCODE = 'P0001';
		END IF;
		IF NEW.rent_effective_from <= OLD.rent_effective_from THEN
			RAISE EXCEPTION 'LEASE_RENT_EFFECTIVE: un nouveau loyer prend effet après le précédent' USING ERRCODE = 'P0001';
		END IF;
	ELSIF NEW.version <> OLD.version THEN
		RAISE EXCEPTION 'LEASE_VERSION: version changée sans changement de loyer ni renouvellement' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- modèles de contrat

CREATE TABLE contract_templates (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	kind text NOT NULL CHECK (kind IN ('lease', 'amendment')),
	name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
	-- Une nouvelle version d'un modèle en remplace une autre (même type), jamais écrasée.
	version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
	replaces_id uuid,
	-- Fichier Word, dans le registre des documents (type contract_template).
	document_id uuid NOT NULL,
	status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
	-- Inspection par l'API : balises reconnues et inconnues, où elles apparaissent (sections), polices, pages.
	inspected_at timestamptz,
	inspection_error text CHECK (char_length(inspection_error) <= 500),
	detected_fields text[] NOT NULL DEFAULT '{}',
	unknown_fields text[] NOT NULL DEFAULT '{}',
	tag_usages jsonb NOT NULL DEFAULT '[]',
	fonts text[] NOT NULL DEFAULT '{}',
	unmatched_fonts text[] NOT NULL DEFAULT '{}',
	page_count integer CHECK (page_count >= 1),
	activated_at timestamptz,
	activated_by uuid REFERENCES users (id),
	retired_at timestamptz,
	created_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT contract_templates_replaces_fk FOREIGN KEY (organization_id, replaces_id) REFERENCES contract_templates (organization_id, id),
	-- Différée : le fichier cite son modèle et le modèle son fichier, créés dans la même transaction.
	CONSTRAINT contract_templates_document_fk FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id)
		DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT contract_templates_version CHECK ((replaces_id IS NULL) = (version = 1)),
	CONSTRAINT contract_templates_active CHECK (status <> 'active' OR (activated_at IS NOT NULL AND inspected_at IS NOT NULL
		AND inspection_error IS NULL AND cardinality(unknown_fields) = 0)),
	CONSTRAINT contract_templates_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
--> statement-breakpoint
-- Un seul modèle actif par organisation et par type : la génération sait toujours lequel utiliser.
CREATE UNIQUE INDEX contract_templates_one_active ON contract_templates (organization_id, kind) WHERE status = 'active';
--> statement-breakpoint
SELECT enable_organization_rls('contract_templates');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON contract_templates FROM app_api, app_admin;
--> statement-breakpoint
CREATE FUNCTION contract_templates_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'draft' OR NEW.inspected_at IS NOT NULL THEN
			RAISE EXCEPTION 'TEMPLATE_BORN_DRAFT: un modèle naît brouillon, avant son inspection' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF (NEW.id, NEW.organization_id, NEW.kind, NEW.version, NEW.replaces_id, NEW.document_id, NEW.created_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.kind, OLD.version, OLD.replaces_id, OLD.document_id, OLD.created_by, OLD.created_at) THEN
		RAISE EXCEPTION 'TEMPLATE_IMMUTABLE: un autre fichier fait une nouvelle version du modèle' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'retired' THEN
		RAISE EXCEPTION 'TEMPLATE_RETIRED: un modèle retiré ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status IN ('active', 'retired')) OR (OLD.status = 'active' AND NEW.status = 'retired')
	) THEN
		RAISE EXCEPTION 'TEMPLATE_STATUS: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
	END IF;
	-- Un modèle activé garde son inspection : c'est elle qui dit quelles balises il remplit.
	IF OLD.status = 'active' AND (NEW.inspected_at, NEW.inspection_error, NEW.detected_fields, NEW.unknown_fields, NEW.tag_usages,
		NEW.fonts, NEW.unmatched_fonts, NEW.page_count, NEW.activated_at, NEW.activated_by)
		IS DISTINCT FROM (OLD.inspected_at, OLD.inspection_error, OLD.detected_fields, OLD.unknown_fields, OLD.tag_usages, OLD.fonts,
		OLD.unmatched_fonts, OLD.page_count, OLD.activated_at, OLD.activated_by) THEN
		RAISE EXCEPTION 'TEMPLATE_IMMUTABLE: un modèle actif ne se réinspecte pas' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER contract_templates_rules BEFORE INSERT OR UPDATE ON contract_templates
	FOR EACH ROW EXECUTE FUNCTION contract_templates_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- avenants

CREATE TABLE lease_amendments (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	lease_id uuid NOT NULL,
	-- Numéro de l'avenant dans le bail : 1, 2, 3…
	number integer NOT NULL CHECK (number >= 1),
	type text NOT NULL CHECK (type IN ('renewal', 'rent_change', 'other')),
	effective_from date NOT NULL,
	-- Changement de loyer (FCFA entiers, règle 2).
	new_rent bigint CHECK (new_rent >= 1),
	new_charges bigint CHECK (new_charges >= 0),
	-- Renouvellement : nouvelle fin, ou durée indéterminée.
	new_ends_on date,
	open_ended boolean NOT NULL DEFAULT false,
	description text CHECK (char_length(description) <= 4000),
	-- Version du bail sur laquelle l'avenant est rédigé ; contrôlée de nouveau à la signature.
	expected_lease_version integer NOT NULL CHECK (expected_lease_version >= 1),
	status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'applied', 'cancelled')),
	applied_at timestamptz,
	applied_lease_version integer,
	cancelled_at timestamptz,
	cancellation_reason text CHECK (char_length(cancellation_reason) BETWEEN 3 AND 500),
	created_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	UNIQUE (organization_id, lease_id, number),
	CONSTRAINT lease_amendments_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT lease_amendments_values CHECK (
		(type = 'rent_change' AND new_rent IS NOT NULL AND new_charges IS NOT NULL AND new_ends_on IS NULL AND NOT open_ended)
		OR (type = 'renewal' AND new_rent IS NULL AND new_charges IS NULL AND ((new_ends_on IS NULL) = open_ended))
		OR (type = 'other' AND new_rent IS NULL AND new_charges IS NULL AND new_ends_on IS NULL AND NOT open_ended AND description IS NOT NULL)
	),
	CONSTRAINT lease_amendments_applied CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
	CONSTRAINT lease_amendments_applied_version CHECK (status <> 'applied' OR type = 'other' OR applied_lease_version IS NOT NULL),
	CONSTRAINT lease_amendments_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL))
);
--> statement-breakpoint
-- Un seul avenant de loyer ou de renouvellement en cours par bail : deux avenants concurrents se contrediraient.
CREATE UNIQUE INDEX lease_amendments_one_pending ON lease_amendments (organization_id, lease_id)
	WHERE status = 'draft' AND type IN ('rent_change', 'renewal');
--> statement-breakpoint
SELECT enable_organization_rls('lease_amendments');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON lease_amendments FROM app_api, app_admin;
--> statement-breakpoint
CREATE FUNCTION lease_amendments_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'draft' THEN
			RAISE EXCEPTION 'AMENDMENT_BORN_DRAFT: un avenant naît brouillon' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF (NEW.id, NEW.organization_id, NEW.lease_id, NEW.number, NEW.type, NEW.created_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.lease_id, OLD.number, OLD.type, OLD.created_by, OLD.created_at) THEN
		RAISE EXCEPTION 'AMENDMENT_IMMUTABLE: le bail, le numéro et le type d''un avenant ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status <> 'draft' THEN
		RAISE EXCEPTION 'AMENDMENT_CLOSED: un avenant appliqué ou annulé ne change plus' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lease_amendments_rules BEFORE INSERT OR UPDATE ON lease_amendments
	FOR EACH ROW EXECUTE FUNCTION lease_amendments_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- contrats

CREATE TABLE lease_contracts (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	lease_id uuid NOT NULL,
	-- Contrat d'un avenant (même cycle) ; vide pour le contrat du bail.
	amendment_id uuid,
	origin text NOT NULL CHECK (origin IN ('generated', 'uploaded_scan')),
	-- Modèle utilisé : celui de la plateforme (D25, par sa version) ou celui de l'organisation.
	template_source text CHECK (template_source IN ('platform', 'organization')),
	template_id uuid,
	template_version integer CHECK (template_version >= 1),
	status text NOT NULL CHECK (status IN ('draft', 'in_review', 'ready_to_sign', 'signed')),
	-- Dernière version générée (0 : aucune encore) ; version figée à « prêt à signer ».
	current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
	frozen_version integer CHECK (frozen_version >= 1),
	frozen_at timestamptz,
	frozen_by uuid REFERENCES users (id),
	-- Génération en tâche de fond (BullMQ) : `pending` tant que la version suivante n'est pas prête.
	generation_status text NOT NULL DEFAULT 'idle' CHECK (generation_status IN ('idle', 'pending', 'failed')),
	generation_error text CHECK (char_length(generation_error) <= 500),
	-- Saisis à la génération.
	signing_place text CHECK (char_length(signing_place) BETWEEN 2 AND 120),
	signing_date date,
	copies smallint CHECK (copies BETWEEN 1 AND 10),
	-- Signataires attendus, posés au figement (packages/shared, expectedSigners).
	expected_signers text[] CHECK (expected_signers <@ ARRAY['organization', 'owner', 'tenant']::text[]),
	organization_signed_on date,
	owner_signed_on date,
	tenant_signed_on date,
	-- Signature manuscrite, scan déposé (D21) : jamais une signature électronique.
	signature_mode text CHECK (signature_mode IN ('handwritten_scan')),
	signed_document_id uuid,
	signature_recorded_by uuid REFERENCES users (id),
	signature_recorded_at timestamptz,
	-- Légalisation à la commune et enregistrement aux impôts : suivis, jamais bloquants.
	legalized_on date,
	legalization_commune text CHECK (char_length(legalization_commune) BETWEEN 2 AND 120),
	legalization_reference text CHECK (char_length(legalization_reference) <= 120),
	legalization_document_id uuid,
	registered_on date,
	registration_reference text CHECK (char_length(registration_reference) <= 120),
	registration_document_id uuid,
	legalization_reminder boolean NOT NULL DEFAULT true,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT lease_contracts_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT lease_contracts_amendment_fk FOREIGN KEY (organization_id, amendment_id) REFERENCES lease_amendments (organization_id, id),
	CONSTRAINT lease_contracts_template_fk FOREIGN KEY (organization_id, template_id) REFERENCES contract_templates (organization_id, id),
	CONSTRAINT lease_contracts_signed_document_fk FOREIGN KEY (organization_id, signed_document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT lease_contracts_legalization_document_fk FOREIGN KEY (organization_id, legalization_document_id)
		REFERENCES documents (organization_id, id),
	CONSTRAINT lease_contracts_registration_document_fk FOREIGN KEY (organization_id, registration_document_id)
		REFERENCES documents (organization_id, id),
	-- Un contrat généré cite son modèle ; un scan déposé hors plateforme naît signé, sans modèle ni version.
	CONSTRAINT lease_contracts_origin CHECK (
		(origin = 'generated' AND template_source IS NOT NULL AND template_version IS NOT NULL
			AND ((template_source = 'organization') = (template_id IS NOT NULL)))
		OR (origin = 'uploaded_scan' AND status = 'signed' AND template_source IS NULL AND template_id IS NULL
			AND current_version = 0 AND amendment_id IS NULL)
	),
	CONSTRAINT lease_contracts_frozen CHECK (
		origin = 'uploaded_scan'
		OR (status IN ('ready_to_sign', 'signed')) = (frozen_version IS NOT NULL AND frozen_at IS NOT NULL AND expected_signers IS NOT NULL)
	),
	CONSTRAINT lease_contracts_signed CHECK (
		(status = 'signed') = (signature_mode IS NOT NULL AND signed_document_id IS NOT NULL AND signature_recorded_at IS NOT NULL)
	),
	CONSTRAINT lease_contracts_signers_dates CHECK (
		origin = 'uploaded_scan' OR status <> 'signed' OR (
			('organization' <> ALL (expected_signers) OR organization_signed_on IS NOT NULL)
			AND ('owner' <> ALL (expected_signers) OR owner_signed_on IS NOT NULL)
			AND ('tenant' <> ALL (expected_signers) OR tenant_signed_on IS NOT NULL)
		)
	),
	CONSTRAINT lease_contracts_legalization CHECK ((legalized_on IS NULL) = (legalization_commune IS NULL)),
	CONSTRAINT lease_contracts_tracking CHECK (status = 'signed' OR (legalized_on IS NULL AND registered_on IS NULL))
);
--> statement-breakpoint
-- Un contrat par bail, et un par avenant.
CREATE UNIQUE INDEX lease_contracts_one_per_lease ON lease_contracts (organization_id, lease_id) WHERE amendment_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX lease_contracts_one_per_amendment ON lease_contracts (organization_id, amendment_id) WHERE amendment_id IS NOT NULL;
--> statement-breakpoint
SELECT enable_organization_rls('lease_contracts');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON lease_contracts FROM app_api, app_admin;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_contract_fk FOREIGN KEY (organization_id, lease_contract_id)
	REFERENCES lease_contracts (organization_id, id);
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_template_fk FOREIGN KEY (organization_id, contract_template_id)
	REFERENCES contract_templates (organization_id, id);
--> statement-breakpoint

-- ---------------------------------------------------------------- versions des contrats (ajout seul)

CREATE TABLE contract_versions (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	contract_id uuid NOT NULL,
	number integer NOT NULL CHECK (number >= 1),
	-- Version du bail utilisée (un bail modifié depuis le figement rend le contrat « à régénérer »).
	lease_version integer NOT NULL CHECK (lease_version >= 1),
	template_source text NOT NULL CHECK (template_source IN ('platform', 'organization')),
	template_id uuid,
	template_version integer NOT NULL CHECK (template_version >= 1),
	-- Copie des données (organisation, représentant, logo, bailleur, propriétaire, locataire, logement, conditions) et
	-- valeurs résolues de chaque balise, à la génération (D29).
	data jsonb NOT NULL,
	fields jsonb NOT NULL,
	blank_fields text[] NOT NULL DEFAULT '{}',
	warnings text[] NOT NULL DEFAULT '{}',
	docx_document_id uuid NOT NULL,
	pdf_document_id uuid NOT NULL,
	docx_sha256 text NOT NULL CHECK (docx_sha256 ~ '^[0-9a-f]{64}$'),
	pdf_sha256 text NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
	page_count integer CHECK (page_count >= 1),
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	UNIQUE (organization_id, contract_id, number),
	CONSTRAINT contract_versions_contract_fk FOREIGN KEY (organization_id, contract_id) REFERENCES lease_contracts (organization_id, id),
	CONSTRAINT contract_versions_template_fk FOREIGN KEY (organization_id, template_id) REFERENCES contract_templates (organization_id, id),
	CONSTRAINT contract_versions_docx_fk FOREIGN KEY (organization_id, docx_document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT contract_versions_pdf_fk FOREIGN KEY (organization_id, pdf_document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT contract_versions_template CHECK ((template_source = 'organization') = (template_id IS NOT NULL))
);
--> statement-breakpoint
SELECT enable_organization_rls('contract_versions');
--> statement-breakpoint
-- Ajout seul (règle 17) : jamais modifiée ni supprimée, même par le propriétaire du schéma.
REVOKE UPDATE, DELETE, TRUNCATE ON contract_versions FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER contract_versions_no_update_delete BEFORE UPDATE OR DELETE ON contract_versions
	FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER contract_versions_no_truncate BEFORE TRUNCATE ON contract_versions
	FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Une version suit la précédente ; ses fichiers sont des projets du même contrat, actifs, dont l'empreinte est celle
-- qu'elle garde ; un contrat figé n'en reçoit plus (« modifier » le renvoie d'abord en vérification).
CREATE FUNCTION contract_versions_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	contract lease_contracts%ROWTYPE;
	doc documents%ROWTYPE;
	last_number integer;
	expected_sha text;
	found integer := 0;
BEGIN
	SELECT * INTO contract FROM lease_contracts WHERE organization_id = NEW.organization_id AND id = NEW.contract_id FOR UPDATE;
	IF contract.id IS NULL OR contract.origin <> 'generated' OR contract.status NOT IN ('draft', 'in_review') THEN
		RAISE EXCEPTION 'CONTRACT_FROZEN: un contrat figé ou déposé signé ne reçoit plus de version' USING ERRCODE = 'P0001';
	END IF;
	SELECT coalesce(max(number), 0) INTO last_number FROM contract_versions WHERE organization_id = NEW.organization_id AND contract_id = NEW.contract_id;
	IF NEW.number <> last_number + 1 THEN
		RAISE EXCEPTION 'CONTRACT_VERSION: la version suivante est la %', last_number + 1 USING ERRCODE = 'P0001';
	END IF;
	FOR doc IN SELECT * FROM documents WHERE organization_id = NEW.organization_id AND id IN (NEW.docx_document_id, NEW.pdf_document_id) LOOP
		IF doc.type <> 'contract_draft' OR doc.lease_contract_id IS DISTINCT FROM NEW.contract_id OR doc.status <> 'active' THEN
			RAISE EXCEPTION 'CONTRACT_VERSION_FILES: les fichiers d''une version sont les projets actifs de son contrat' USING ERRCODE = 'P0001';
		END IF;
		expected_sha := CASE WHEN doc.id = NEW.docx_document_id THEN NEW.docx_sha256 ELSE NEW.pdf_sha256 END;
		IF doc.sha256 IS DISTINCT FROM expected_sha THEN
			RAISE EXCEPTION 'CONTRACT_VERSION_FINGERPRINT: l''empreinte de la version est celle de son fichier' USING ERRCODE = 'P0001';
		END IF;
		found := found + 1;
	END LOOP;
	-- Les deux fichiers doivent être lus ici : un fichier d'une autre organisation est invisible (RLS), donc refusé.
	IF NEW.docx_document_id = NEW.pdf_document_id OR found <> 2 THEN
		RAISE EXCEPTION 'CONTRACT_VERSION_FILES: le Word et le PDF sont deux projets actifs de ce contrat' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER contract_versions_rules BEFORE INSERT ON contract_versions FOR EACH ROW EXECUTE FUNCTION contract_versions_rules();
--> statement-breakpoint

-- Cycle du contrat (packages/shared, CONTRACT_TRANSITIONS) ; figement ; signature écrite une seule fois.
CREATE FUNCTION lease_contracts_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	last_number integer;
	doc documents%ROWTYPE;
	scan_type text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.origin = 'generated' AND (NEW.status <> 'draft' OR NEW.current_version <> 0) THEN
			RAISE EXCEPTION 'CONTRACT_BORN_DRAFT: un contrat généré naît brouillon, sans version' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.origin = 'uploaded_scan' THEN
			SELECT * INTO doc FROM documents WHERE organization_id = NEW.organization_id AND id = NEW.signed_document_id;
			IF doc.type IS DISTINCT FROM 'signed_lease_scan' OR doc.lease_id IS DISTINCT FROM NEW.lease_id OR doc.status IS DISTINCT FROM 'active' THEN
				RAISE EXCEPTION 'CONTRACT_SCAN: un contrat déposé cite le bail signé scanné, actif, de son bail' USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	IF (NEW.id, NEW.organization_id, NEW.lease_id, NEW.amendment_id, NEW.origin, NEW.template_source, NEW.template_id,
		NEW.template_version, NEW.created_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.lease_id, OLD.amendment_id, OLD.origin, OLD.template_source, OLD.template_id,
		OLD.template_version, OLD.created_by, OLD.created_at) THEN
		RAISE EXCEPTION 'CONTRACT_IMMUTABLE: le bail, l''origine et le modèle d''un contrat ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status = 'in_review')
		OR (OLD.status = 'in_review' AND NEW.status IN ('draft', 'ready_to_sign'))
		OR (OLD.status = 'ready_to_sign' AND NEW.status IN ('in_review', 'signed'))
	) THEN
		RAISE EXCEPTION 'CONTRACT_STATUS: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
	END IF;
	-- Versions : une à la fois, seulement avant le figement, et toujours une version qui existe.
	IF NEW.current_version <> OLD.current_version THEN
		IF NEW.current_version <> OLD.current_version + 1 OR OLD.status NOT IN ('draft', 'in_review') THEN
			RAISE EXCEPTION 'CONTRACT_VERSION: une version à la fois, avant le figement' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.current_version > 0 THEN
		SELECT coalesce(max(number), 0) INTO last_number FROM contract_versions WHERE organization_id = NEW.organization_id AND contract_id = NEW.id;
		IF last_number <> NEW.current_version THEN
			RAISE EXCEPTION 'CONTRACT_VERSION: la version % n''existe pas', NEW.current_version USING ERRCODE = 'P0001';
		END IF;
	END IF;
	-- Figement : la version courante, avec ses signataires ; « modifier » le lève en renvoyant en vérification.
	IF NEW.status = 'ready_to_sign' AND OLD.status = 'in_review' THEN
		IF NEW.frozen_version IS DISTINCT FROM NEW.current_version OR NEW.current_version = 0 THEN
			RAISE EXCEPTION 'CONTRACT_FREEZE: le contrat figé est sa dernière version' USING ERRCODE = 'P0001';
		END IF;
	ELSIF OLD.status IN ('ready_to_sign', 'signed') AND NEW.status IN ('ready_to_sign', 'signed')
		AND (NEW.frozen_version, NEW.frozen_at, NEW.frozen_by, NEW.expected_signers, NEW.signing_place, NEW.signing_date, NEW.copies)
		IS DISTINCT FROM (OLD.frozen_version, OLD.frozen_at, OLD.frozen_by, OLD.expected_signers, OLD.signing_place, OLD.signing_date, OLD.copies) THEN
		RAISE EXCEPTION 'CONTRACT_FROZEN: un contrat prêt à signer est figé ; une modification crée la version suivante' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'in_review' AND OLD.status = 'ready_to_sign' AND (NEW.frozen_version IS NOT NULL OR NEW.expected_signers IS NOT NULL) THEN
		RAISE EXCEPTION 'CONTRACT_FREEZE: un contrat renvoyé en vérification n''est plus figé' USING ERRCODE = 'P0001';
	END IF;
	-- Signature : écrite une seule fois, au passage à « signé », sur le scan déposé pour ce contrat.
	IF OLD.status = 'signed' AND (NEW.signature_mode, NEW.signed_document_id, NEW.signature_recorded_by, NEW.signature_recorded_at,
		NEW.organization_signed_on, NEW.owner_signed_on, NEW.tenant_signed_on)
		IS DISTINCT FROM (OLD.signature_mode, OLD.signed_document_id, OLD.signature_recorded_by, OLD.signature_recorded_at,
		OLD.organization_signed_on, OLD.owner_signed_on, OLD.tenant_signed_on) THEN
		RAISE EXCEPTION 'CONTRACT_SIGNED: la signature d''un contrat ne se réécrit pas' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'signed' AND OLD.status = 'ready_to_sign' THEN
		SELECT * INTO doc FROM documents WHERE organization_id = NEW.organization_id AND id = NEW.signed_document_id;
		scan_type := CASE WHEN NEW.amendment_id IS NULL THEN 'signed_lease_scan' ELSE 'signed_amendment_scan' END;
		IF doc.status IS DISTINCT FROM 'active' OR doc.lease_id IS DISTINCT FROM NEW.lease_id OR doc.type IS DISTINCT FROM scan_type THEN
			RAISE EXCEPTION 'CONTRACT_SCAN: le scan signé est un document actif du bail, du bon type' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lease_contracts_rules BEFORE INSERT OR UPDATE ON lease_contracts FOR EACH ROW EXECUTE FUNCTION lease_contracts_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- tâche quotidienne : reconduction

-- Lot 08, plus les baux en vigueur arrivés à leur terme sans préavis (reconduction selon le bail, D24).
CREATE OR REPLACE FUNCTION due_lease_organizations(as_of date) RETURNS SETOF uuid
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT organization_id FROM leases WHERE status = 'signed' AND starts_on <= as_of
	UNION
	SELECT organization_id FROM leases WHERE status IN ('active', 'notice') AND ends_on IS NULL
	UNION
	SELECT organization_id FROM leases WHERE status = 'active' AND ends_on < as_of AND notice_given_on IS NULL
	UNION
	SELECT organization_id FROM rent_dues
	WHERE (status = 'upcoming' AND due_on <= as_of) OR (status IN ('due', 'partial') AND due_on < as_of)
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------- reprise des baux scannés du lot 08

-- Chaque bail qui a un bail signé scanné actif reçoit un contrat `uploaded_scan` signé : « signature manuscrite, scan
-- déposé par … le … » (D21), avec la personne qui l'a déposé et la date du dépôt. Les dates de signature par partie
-- ne sont pas connues : elles restent vides. Le statut du bail ne change pas. Une ligne d'audit par contrat.
CREATE FUNCTION backfill_uploaded_scan_contracts() RETURNS integer
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	org record;
	scan record;
	new_contract uuid;
	done integer := 0;
BEGIN
	FOR org IN SELECT DISTINCT organization_id AS id FROM documents WHERE type = 'signed_lease_scan' AND status = 'active' LOOP
		-- Contexte de l'organisation : la RLS s'applique aussi au propriétaire des tables (FORCE).
		PERFORM set_config('app.organization_id', org.id::text, true);
		FOR scan IN
			SELECT DISTINCT ON (d.lease_id) d.id, d.lease_id, d.uploaded_by, d.activated_at
			FROM documents d
			WHERE d.organization_id = org.id AND d.type = 'signed_lease_scan' AND d.status = 'active'
				AND NOT EXISTS (SELECT 1 FROM lease_contracts c WHERE c.organization_id = org.id AND c.lease_id = d.lease_id AND c.amendment_id IS NULL)
			ORDER BY d.lease_id, d.activated_at DESC, d.id DESC
		LOOP
			new_contract := uuid_v7();
			INSERT INTO lease_contracts (id, organization_id, lease_id, origin, status, signature_mode, signed_document_id,
				signature_recorded_by, signature_recorded_at, created_by)
			VALUES (new_contract, org.id, scan.lease_id, 'uploaded_scan', 'signed', 'handwritten_scan', scan.id, scan.uploaded_by,
				scan.activated_at, scan.uploaded_by);
			INSERT INTO audit_log (id, actor_type, organization_id, action, object_type, object_id, after, origin)
			VALUES (uuid_v7(), 'system', org.id, 'contract.import_scan', 'lease_contract', new_contract,
				jsonb_build_object('leaseId', scan.lease_id, 'origin', 'uploaded_scan', 'status', 'signed', 'signatureMode', 'handwritten_scan',
					'signedDocumentId', scan.id, 'recordedBy', scan.uploaded_by, 'recordedAt', scan.activated_at),
				'migration');
			done := done + 1;
		END LOOP;
	END LOOP;
	PERFORM set_config('app.organization_id', '', true);
	RETURN done;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION backfill_uploaded_scan_contracts() FROM PUBLIC;
--> statement-breakpoint
SELECT backfill_uploaded_scan_contracts();
--> statement-breakpoint

-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)

GRANT SELECT ON contract_templates, lease_contracts, contract_versions, lease_amendments TO app_sync;
--> statement-breakpoint
CREATE POLICY sync_read ON contract_templates FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON lease_contracts FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON contract_versions FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON lease_amendments FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE contract_templates, lease_contracts, contract_versions, lease_amendments;
