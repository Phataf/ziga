-- Lot 08 — locataires, baux, échéances et comptes de caution (module leases). Décisions D14, D15, D20, D24 ;
-- règles 1, 2, 4, 8, 13 et 14 de CLAUDE.md. Les règles pures sont dans packages/shared (leases.ts, rent-schedule.ts).
--
-- - organizations.rent_billing_mode : réglage de l'organisation (découpage des périodes), recopié dans chaque bail à sa
--   création et figé ensuite (leases.billing_mode).
-- - tenants : fiche du locataire ; l'état civil et la pièce d'identité y sont, mais ne descendent que chez le
--   directeur et le gestionnaire (Sync Streams, stream à part).
-- - leases : bail validé = signé (début futur) ou en vigueur ; un seul en vigueur et un seul à venir par unité
--   (règle 8, index uniques partiels) ; conditions figées après validation, sauf le loyer, qui change par une
--   nouvelle version (copie dans lease_versions, écrite par la base seule). Aucune colonne d'occupation : elle se
--   calcule à partir des baux (règle 13).
-- - rent_dues : écrites par le serveur seul (validation du bail, tâche quotidienne), une par bail et par période (clé
--   d'idempotence) ; une échéance émise ne change plus de montant.
-- - deposit_accounts, deposit_movements : compte de caution par bail et par type ; mouvements en ajout seul ; le
--   statut et le détenteur du compte ne changent que par un mouvement (trigger), jamais par une modification.
-- - documents : bail scanné et pièce d'identité du locataire, rattachés au bail ou au locataire.
-- Chaque table : organization_id, RLS d'organisation, clés composites, jamais supprimée, publiée vers PowerSync.

-- ---------------------------------------------------------------- réglage de l'organisation

ALTER TABLE organizations ADD COLUMN rent_billing_mode text NOT NULL DEFAULT 'calendar_prorata'
	CHECK (rent_billing_mode IN ('calendar_prorata', 'calendar_full_first', 'anniversary'));
--> statement-breakpoint

-- ---------------------------------------------------------------- locataires

CREATE TABLE tenants (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	civility text CHECK (civility IN ('mr', 'mrs', 'miss')),
	full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
	-- Aucun champ n'est obligatoire pour créer un bail, hormis le nom (D24) ; téléphones en E.164.
	phone text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
	secondary_phone text CHECK (secondary_phone ~ '^\+[1-9][0-9]{7,14}$'),
	nationality text CHECK (char_length(nationality) <= 60),
	profession text CHECK (char_length(profession) <= 80),
	previous_address text CHECK (char_length(previous_address) <= 200),
	emergency_contact_name text CHECK (char_length(emergency_contact_name) <= 120),
	emergency_contact_phone text CHECK (emergency_contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
	notes text CHECK (char_length(notes) <= 2000),
	-- État civil et pièce d'identité : directeur et gestionnaire seulement (API et Sync Streams) ; copie de la pièce
	-- dans le registre des documents (type tenant_identity).
	birth_date date,
	birth_place text CHECK (char_length(birth_place) <= 120),
	id_type text CHECK (id_type IN ('cnib', 'passport', 'consular_card', 'residence_card', 'other')),
	id_type_other text CHECK (char_length(id_type_other) BETWEEN 1 AND 60),
	id_number text CHECK (char_length(id_number) <= 40),
	id_issued_on date,
	id_issued_by text CHECK (char_length(id_issued_by) <= 120),
	-- Compte lié (lot 10 ter) ; jamais écrit dans ce lot, jamais synchronisé.
	user_id uuid REFERENCES users (id),
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
	archived_at timestamptz,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT tenants_id_type_other CHECK ((id_type_other IS NULL OR id_type = 'other') AND (id_type IS DISTINCT FROM 'other' OR id_type_other IS NOT NULL)),
	CONSTRAINT tenants_archived CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX tenants_by_phone ON tenants (organization_id, phone) WHERE phone IS NOT NULL;
--> statement-breakpoint
SELECT enable_organization_rls('tenants');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON tenants FROM app_api, app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- baux

CREATE TABLE leases (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	unit_id uuid NOT NULL,
	tenant_id uuid NOT NULL,
	starts_on date NOT NULL,
	-- Fin facultative (bail sans fin) ; durée en mois, pour information et pour le contrat.
	ends_on date,
	duration_months smallint CHECK (duration_months BETWEEN 1 AND 600),
	-- Première date facturée : l'entrée, ou plus tard pour un bail repris en cours.
	dues_start_on date NOT NULL,
	-- Loyer et charges en vigueur (règle 2, FCFA entiers), à partir de rent_effective_from (version courante).
	rent bigint NOT NULL CHECK (rent > 0),
	charges bigint NOT NULL DEFAULT 0 CHECK (charges >= 0),
	rent_effective_from date NOT NULL,
	periodicity text NOT NULL DEFAULT 'monthly' CHECK (periodicity IN ('monthly', 'quarterly')),
	due_day smallint NOT NULL DEFAULT 5 CHECK (due_day BETWEEN 1 AND 28),
	-- Recopié du réglage de l'organisation à la création, figé à la validation.
	billing_mode text NOT NULL CHECK (billing_mode IN ('calendar_prorata', 'calendar_full_first', 'anniversary')),
	advance_months smallint NOT NULL DEFAULT 0 CHECK (advance_months BETWEEN 0 AND 24),
	-- Bailleur désigné (D24) : le propriétaire représenté par l'organisation, ou l'organisation en son nom.
	lessor_type text NOT NULL CHECK (lessor_type IN ('owner', 'organization')),
	payment_terms text CHECK (char_length(payment_terms) <= 500),
	-- Pénalité de retard (taux mensuel en points de base, délai de grâce, bénéficiaire) : tout ou rien ; aucune par
	-- défaut (D25) ; calcul automatique hors périmètre.
	penalty_rate_bp integer CHECK (penalty_rate_bp BETWEEN 1 AND 10000),
	penalty_grace_days smallint CHECK (penalty_grace_days BETWEEN 0 AND 365),
	penalty_beneficiary text CHECK (penalty_beneficiary IN ('organization', 'owner')),
	-- Préavis (valeurs légales par défaut, à confirmer par le juriste ; utilisés au lot 10 bis).
	notice_tenant_fixed_term_months smallint NOT NULL DEFAULT 2 CHECK (notice_tenant_fixed_term_months BETWEEN 0 AND 12),
	notice_tenant_open_ended_months smallint NOT NULL DEFAULT 3 CHECK (notice_tenant_open_ended_months BETWEEN 0 AND 12),
	notice_lessor_fixed_term_months smallint NOT NULL DEFAULT 3 CHECK (notice_lessor_fixed_term_months BETWEEN 0 AND 12),
	notice_lessor_open_ended_months smallint NOT NULL DEFAULT 3 CHECK (notice_lessor_open_ended_months BETWEEN 0 AND 12),
	reduced_notice_months smallint CHECK (reduced_notice_months BETWEEN 0 AND 12),
	reduced_notice_cases text CHECK (char_length(reduced_notice_cases) <= 500),
	early_termination_indemnity_months smallint CHECK (early_termination_indemnity_months BETWEEN 0 AND 12),
	renewal_mode text NOT NULL DEFAULT 'open_ended' CHECK (renewal_mode IN ('open_ended', 'same_duration')),
	deposit_refund_days smallint NOT NULL DEFAULT 30 CHECK (deposit_refund_days BETWEEN 0 AND 365),
	status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed', 'active', 'notice', 'ended', 'cancelled')),
	-- Date de validation (signature) : échéance des sommes dues à l'entrée (avance, premier mois incomplet).
	activated_on date,
	activated_at timestamptz,
	cancelled_at timestamptz,
	cancellation_reason text CHECK (char_length(cancellation_reason) BETWEEN 3 AND 500),
	-- Remplis au lot 10 bis (préavis, sortie).
	notice_given_on date,
	exit_on date,
	ended_at timestamptz,
	end_reason text CHECK (char_length(end_reason) BETWEEN 3 AND 500),
	version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
	created_by uuid REFERENCES users (id),
	updated_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT leases_unit_fk FOREIGN KEY (organization_id, unit_id) REFERENCES units (organization_id, id),
	CONSTRAINT leases_tenant_fk FOREIGN KEY (organization_id, tenant_id) REFERENCES tenants (organization_id, id),
	CONSTRAINT leases_dates CHECK (ends_on IS NULL OR ends_on >= starts_on),
	CONSTRAINT leases_dues_start CHECK (dues_start_on >= starts_on AND (ends_on IS NULL OR dues_start_on <= ends_on)),
	CONSTRAINT leases_rent_effective CHECK (rent_effective_from >= dues_start_on AND (ends_on IS NULL OR rent_effective_from <= ends_on)),
	CONSTRAINT leases_advance_periods CHECK (periodicity = 'monthly' OR advance_months % 3 = 0),
	CONSTRAINT leases_penalty CHECK (
		(penalty_rate_bp IS NULL AND penalty_grace_days IS NULL AND penalty_beneficiary IS NULL)
		OR (penalty_rate_bp IS NOT NULL AND penalty_grace_days IS NOT NULL AND penalty_beneficiary IS NOT NULL)
	),
	CONSTRAINT leases_activated CHECK ((status = 'draft') = (activated_on IS NULL) OR (status = 'cancelled' AND activated_on IS NULL)),
	CONSTRAINT leases_activated_at CHECK ((activated_on IS NULL) = (activated_at IS NULL)),
	CONSTRAINT leases_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL)),
	CONSTRAINT leases_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
--> statement-breakpoint
-- Règle 8 : un seul bail en vigueur (actif ou en préavis) par unité, et un seul bail signé à venir.
CREATE UNIQUE INDEX leases_one_in_force_per_unit ON leases (organization_id, unit_id) WHERE status IN ('active', 'notice');
--> statement-breakpoint
CREATE UNIQUE INDEX leases_one_reserved_per_unit ON leases (organization_id, unit_id) WHERE status = 'signed';
--> statement-breakpoint
CREATE INDEX leases_by_unit ON leases (organization_id, unit_id);
--> statement-breakpoint
CREATE INDEX leases_by_tenant ON leases (organization_id, tenant_id);
--> statement-breakpoint
CREATE INDEX leases_signed_start ON leases (starts_on) WHERE status = 'signed';
--> statement-breakpoint
SELECT enable_organization_rls('leases');
--> statement-breakpoint
-- Un bail ne se supprime jamais : il s'annule (brouillon ou signé à venir) ou se termine (lot 10 bis).
REVOKE DELETE, TRUNCATE ON leases FROM app_api, app_admin;
--> statement-breakpoint

-- Cycle du bail (packages/shared, LEASE_TRANSITIONS) ; un bail validé garde ses conditions, sauf le loyer, qui change
-- par la version suivante, à une date d'effet postérieure ; un bailleur particulier est toujours le bailleur désigné.
CREATE FUNCTION leases_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	org_type text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.version <> 1 OR NEW.status NOT IN ('draft', 'signed', 'active') THEN
			RAISE EXCEPTION 'LEASE_BORN_DRAFT_OR_VALIDATED: un bail naît brouillon ou validé, en version 1' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.rent_effective_from <> NEW.dues_start_on THEN
			RAISE EXCEPTION 'LEASE_RENT_EFFECTIVE: le premier loyer s''applique dès le début de la facturation' USING ERRCODE = 'P0001';
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
		IF NEW.lessor_type <> OLD.lessor_type THEN
			SELECT type INTO org_type FROM organizations WHERE id = NEW.organization_id;
			IF org_type = 'landlord' AND NEW.lessor_type <> 'organization' THEN
				RAISE EXCEPTION 'LANDLORD_IS_LESSOR: un bailleur particulier est lui-même le bailleur désigné' USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	-- Bail validé : conditions figées (un avenant, au lot 08 bis, passera par la même règle de version).
	IF (NEW.tenant_id, NEW.starts_on, NEW.ends_on, NEW.duration_months, NEW.dues_start_on, NEW.periodicity, NEW.due_day,
		NEW.billing_mode, NEW.advance_months, NEW.lessor_type, NEW.payment_terms, NEW.penalty_rate_bp, NEW.penalty_grace_days,
		NEW.penalty_beneficiary, NEW.notice_tenant_fixed_term_months, NEW.notice_tenant_open_ended_months,
		NEW.notice_lessor_fixed_term_months, NEW.notice_lessor_open_ended_months, NEW.reduced_notice_months,
		NEW.reduced_notice_cases, NEW.early_termination_indemnity_months, NEW.renewal_mode, NEW.deposit_refund_days,
		NEW.activated_on, NEW.activated_at)
		IS DISTINCT FROM (OLD.tenant_id, OLD.starts_on, OLD.ends_on, OLD.duration_months, OLD.dues_start_on, OLD.periodicity,
		OLD.due_day, OLD.billing_mode, OLD.advance_months, OLD.lessor_type, OLD.payment_terms, OLD.penalty_rate_bp,
		OLD.penalty_grace_days, OLD.penalty_beneficiary, OLD.notice_tenant_fixed_term_months, OLD.notice_tenant_open_ended_months,
		OLD.notice_lessor_fixed_term_months, OLD.notice_lessor_open_ended_months, OLD.reduced_notice_months,
		OLD.reduced_notice_cases, OLD.early_termination_indemnity_months, OLD.renewal_mode, OLD.deposit_refund_days,
		OLD.activated_on, OLD.activated_at) THEN
		RAISE EXCEPTION 'LEASE_TERMS_LOCKED: les conditions d''un bail validé ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	IF (NEW.rent, NEW.charges, NEW.rent_effective_from) IS DISTINCT FROM (OLD.rent, OLD.charges, OLD.rent_effective_from) THEN
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
		RAISE EXCEPTION 'LEASE_VERSION: version changée sans changement de loyer' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER leases_rules BEFORE INSERT OR UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION leases_rules();
--> statement-breakpoint

-- Versions du bail : la copie de chaque version validée (validation, puis chaque changement de loyer), écrite par la
-- base seule, jamais modifiée ni supprimée. Elles donnent à l'échéancier ses tarifs successifs.
CREATE TABLE lease_versions (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	lease_id uuid NOT NULL,
	version integer NOT NULL CHECK (version >= 1),
	rent bigint NOT NULL,
	charges bigint NOT NULL,
	rent_effective_from date NOT NULL,
	starts_on date NOT NULL,
	ends_on date,
	dues_start_on date NOT NULL,
	due_day smallint NOT NULL,
	billing_mode text NOT NULL,
	periodicity text NOT NULL,
	advance_months smallint NOT NULL,
	status text NOT NULL,
	-- Auteur de la version (vide : la base ou une tâche).
	changed_by uuid REFERENCES users (id),
	recorded_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	UNIQUE (organization_id, lease_id, version),
	CONSTRAINT lease_versions_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id)
);
--> statement-breakpoint
SELECT enable_organization_rls('lease_versions');
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON lease_versions FROM app_api, app_admin;
--> statement-breakpoint
CREATE FUNCTION ledger_append_only() RETURNS trigger
	LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'APPEND_ONLY: % est en ajout seul (% refusé)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lease_versions_no_update_delete BEFORE UPDATE OR DELETE ON lease_versions
	FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER lease_versions_no_truncate BEFORE TRUNCATE ON lease_versions
	FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- SECURITY DEFINER : l'application n'a aucun droit d'écriture sur lease_versions ; la copie reste dans l'organisation
-- du bail (RLS forcée).
CREATE FUNCTION leases_record_version() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF (TG_OP = 'INSERT' AND NEW.status <> 'draft')
		OR (TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status IN ('signed', 'active'))
		OR (TG_OP = 'UPDATE' AND NEW.version <> OLD.version) THEN
		INSERT INTO lease_versions (id, organization_id, lease_id, version, rent, charges, rent_effective_from, starts_on, ends_on,
			dues_start_on, due_day, billing_mode, periodicity, advance_months, status, changed_by)
		VALUES (uuid_v7(), NEW.organization_id, NEW.id, NEW.version, NEW.rent, NEW.charges, NEW.rent_effective_from, NEW.starts_on,
			NEW.ends_on, NEW.dues_start_on, NEW.due_day, NEW.billing_mode, NEW.periodicity, NEW.advance_months, NEW.status,
			CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE NEW.updated_by END);
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION leases_record_version() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER leases_version_copy AFTER INSERT OR UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION leases_record_version();
--> statement-breakpoint

-- ---------------------------------------------------------------- échéances

CREATE TABLE rent_dues (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	lease_id uuid NOT NULL,
	period_start date NOT NULL,
	period_end date NOT NULL,
	due_on date NOT NULL,
	rent bigint NOT NULL CHECK (rent >= 0),
	charges bigint NOT NULL CHECK (charges >= 0),
	amount_due bigint NOT NULL CHECK (amount_due >= 0),
	-- Somme des imputations (lot 09) ; le solde se calcule (packages/shared, rentDueBalance).
	amount_paid bigint NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
	status text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'due', 'partial', 'paid', 'overdue', 'waived')),
	prorated boolean NOT NULL DEFAULT false,
	is_advance boolean NOT NULL DEFAULT false,
	-- Version du bail dont le tarif a servi.
	lease_version integer NOT NULL CHECK (lease_version >= 1),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	-- Clé d'idempotence : une seule échéance par bail et par période (INSERT … ON CONFLICT DO NOTHING).
	CONSTRAINT rent_dues_once UNIQUE (organization_id, lease_id, period_start),
	CONSTRAINT rent_dues_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT rent_dues_period CHECK (period_end >= period_start AND due_on <= period_end),
	CONSTRAINT rent_dues_amount CHECK (amount_due = rent + charges)
);
--> statement-breakpoint
CREATE INDEX rent_dues_by_due_on ON rent_dues (organization_id, due_on) WHERE status IN ('upcoming', 'due', 'partial');
--> statement-breakpoint
SELECT enable_organization_rls('rent_dues');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON rent_dues FROM app_api, app_admin;
--> statement-breakpoint
-- Une échéance n'existe que pour un bail validé ; sa période et sa nature ne changent jamais ; une échéance émise
-- (plus à venir, ou déjà payée en partie) ne change plus de montant ni de date.
CREATE FUNCTION rent_dues_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease_status text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT status INTO lease_status FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
		-- Bail introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
		IF lease_status IS NOT NULL AND lease_status NOT IN ('signed', 'active', 'notice') THEN
			RAISE EXCEPTION 'RENT_DUE_LEASE_NOT_VALIDATED: pas d''échéance pour un bail brouillon, terminé ou annulé' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
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
	IF OLD.status = 'waived' AND NEW.status <> 'waived' THEN
		RAISE EXCEPTION 'RENT_DUE_WAIVED: une échéance abandonnée le reste' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rent_dues_rules BEFORE INSERT OR UPDATE ON rent_dues FOR EACH ROW EXECUTE FUNCTION rent_dues_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- comptes de caution (D15, règle 14)

CREATE TABLE deposit_accounts (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	lease_id uuid NOT NULL,
	-- Caution, ou garantie des factures d'eau et d'électricité (D24) : chacune son montant et ses mouvements.
	type text NOT NULL CHECK (type IN ('security_deposit', 'utilities_guarantee')),
	agreed_amount bigint NOT NULL CHECK (agreed_amount > 0),
	-- Montant saisi en mois de loyer : nombre de mois, pour information (le montant reste en FCFA).
	agreed_months smallint CHECK (agreed_months BETWEEN 1 AND 24),
	-- Détenteur obligatoire ; ne change que par un mouvement holder_changed (trigger).
	holder text NOT NULL CHECK (holder IN ('organization', 'owner')),
	-- Calculé par la base à chaque mouvement ; settling et closed viendront du décompte (lot 10 bis).
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partially_received', 'held', 'settling', 'closed')),
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT deposit_accounts_once UNIQUE (organization_id, lease_id, type),
	CONSTRAINT deposit_accounts_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id)
);
--> statement-breakpoint
SELECT enable_organization_rls('deposit_accounts');
--> statement-breakpoint
-- L'application ne modifie que le montant convenu, tant que le bail est un brouillon ; le statut et le détenteur sont
-- écrits par la base seule, à partir des mouvements.
REVOKE UPDATE, DELETE, TRUNCATE ON deposit_accounts FROM app_api, app_admin;
--> statement-breakpoint
GRANT UPDATE (agreed_amount, agreed_months, updated_at) ON deposit_accounts TO app_api;
--> statement-breakpoint
CREATE FUNCTION deposit_accounts_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease_status text;
	org_type text;
	received bigint;
BEGIN
	SELECT status INTO lease_status FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'pending' THEN
			RAISE EXCEPTION 'DEPOSIT_BORN_PENDING: un compte de caution naît en attente de versement' USING ERRCODE = 'P0001';
		END IF;
		IF lease_status IN ('ended', 'cancelled') THEN
			RAISE EXCEPTION 'LEASE_CLOSED: un bail terminé ou annulé ne reçoit plus de compte de caution' USING ERRCODE = 'P0001';
		END IF;
		SELECT type INTO org_type FROM organizations WHERE id = NEW.organization_id;
		IF org_type = 'landlord' AND NEW.holder <> 'organization' THEN
			RAISE EXCEPTION 'LANDLORD_IS_HOLDER: un bailleur particulier détient lui-même la caution' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF (NEW.id, NEW.organization_id, NEW.lease_id, NEW.type, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.lease_id,
		OLD.type, OLD.created_at) THEN
		RAISE EXCEPTION 'DEPOSIT_IMMUTABLE: le bail et le type d''un compte de caution ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	IF (NEW.agreed_amount, NEW.agreed_months) IS DISTINCT FROM (OLD.agreed_amount, OLD.agreed_months) THEN
		IF lease_status IS DISTINCT FROM 'draft' THEN
			RAISE EXCEPTION 'DEPOSIT_TERMS_LOCKED: le montant convenu ne change plus après la validation du bail' USING ERRCODE = 'P0001';
		END IF;
		SELECT coalesce(sum(amount), 0) INTO received FROM deposit_movements
		WHERE organization_id = NEW.organization_id AND account_id = NEW.id AND type = 'received';
		IF NEW.agreed_amount < received THEN
			RAISE EXCEPTION 'DEPOSIT_OVERPAID: le montant convenu ne peut pas être inférieur au montant reçu' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposit_accounts_rules BEFORE INSERT OR UPDATE ON deposit_accounts FOR EACH ROW EXECUTE FUNCTION deposit_accounts_rules();
--> statement-breakpoint

CREATE TABLE deposit_movements (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	account_id uuid NOT NULL,
	-- Au lot 08 : received (saisi à la main) et holder_changed ; les autres au lot 10 bis.
	type text NOT NULL CHECK (type IN ('received', 'retained', 'applied_to_rent', 'refunded', 'additional_claimed', 'holder_changed')),
	-- FCFA entiers ; un changement de détenteur ne déplace pas d'argent (montant nul).
	amount bigint NOT NULL CHECK (amount >= 0),
	previous_holder text CHECK (previous_holder IN ('organization', 'owner')),
	new_holder text CHECK (new_holder IN ('organization', 'owner')),
	reason text CHECK (char_length(reason) BETWEEN 1 AND 500),
	occurred_on date NOT NULL,
	-- Justificatif (registre des documents) ; accord, ligne d'état des lieux et paiement liés : tables des lots 10 bis
	-- et 09, leurs clés y seront ajoutées.
	document_id uuid,
	agreement_id uuid,
	inspection_item_id uuid,
	payment_id uuid,
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT deposit_movements_account_fk FOREIGN KEY (organization_id, account_id) REFERENCES deposit_accounts (organization_id, id),
	CONSTRAINT deposit_movements_document_fk FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id),
	CONSTRAINT deposit_movements_amount CHECK ((type = 'holder_changed') = (amount = 0)),
	CONSTRAINT deposit_movements_holder CHECK (
		(type = 'holder_changed') = (previous_holder IS NOT NULL AND new_holder IS NOT NULL AND reason IS NOT NULL)
		AND (type = 'holder_changed' OR (previous_holder IS NULL AND new_holder IS NULL))
		AND (previous_holder IS DISTINCT FROM new_holder OR previous_holder IS NULL)
	),
	-- Règle 14 : aucune retenue sans ligne d'état des lieux imputable et justificatif ; aucune imputation sur loyer sans
	-- accord écrit (lot 10 bis).
	CONSTRAINT deposit_movements_retained CHECK (type <> 'retained' OR (inspection_item_id IS NOT NULL AND document_id IS NOT NULL)),
	CONSTRAINT deposit_movements_applied CHECK (type <> 'applied_to_rent' OR agreement_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX deposit_movements_by_account ON deposit_movements (organization_id, account_id);
--> statement-breakpoint
SELECT enable_organization_rls('deposit_movements');
--> statement-breakpoint
-- Ajout seul (règle 14) : aucun rôle ne modifie ni ne supprime un mouvement.
REVOKE UPDATE, DELETE, TRUNCATE ON deposit_movements FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER deposit_movements_no_update_delete BEFORE UPDATE OR DELETE ON deposit_movements
	FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER deposit_movements_no_truncate BEFORE TRUNCATE ON deposit_movements
	FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Avant chaque mouvement, sous le verrou du compte (deux versements simultanés ne dépassent jamais le convenu) :
-- compte fermé refusé ; versements plafonnés au montant convenu ; sorties plafonnées au reçu (règle 14) ; un changement
-- de détenteur part du détenteur actuel.
CREATE FUNCTION deposit_movements_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	account deposit_accounts%ROWTYPE;
	received bigint;
	outflows bigint;
BEGIN
	SELECT * INTO account FROM deposit_accounts WHERE organization_id = NEW.organization_id AND id = NEW.account_id FOR UPDATE;
	-- Compte introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
	IF account.id IS NULL THEN
		RETURN NEW;
	END IF;
	IF account.status = 'closed' THEN
		RAISE EXCEPTION 'DEPOSIT_ACCOUNT_CLOSED: un compte de caution soldé ne reçoit plus de mouvement' USING ERRCODE = 'P0001';
	END IF;
	SELECT coalesce(sum(amount) FILTER (WHERE type = 'received'), 0),
		coalesce(sum(amount) FILTER (WHERE type IN ('retained', 'applied_to_rent', 'refunded')), 0)
	INTO received, outflows
	FROM deposit_movements WHERE organization_id = NEW.organization_id AND account_id = NEW.account_id;
	IF NEW.type = 'received' AND received + NEW.amount > account.agreed_amount THEN
		RAISE EXCEPTION 'DEPOSIT_OVERPAID: versement au-delà du montant convenu' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.type IN ('retained', 'applied_to_rent', 'refunded') AND outflows + NEW.amount > received THEN
		RAISE EXCEPTION 'DEPOSIT_OUTFLOW_EXCEEDS_RECEIVED: les sorties ne dépassent jamais la caution reçue' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.type = 'holder_changed' AND NEW.previous_holder IS DISTINCT FROM account.holder THEN
		RAISE EXCEPTION 'DEPOSIT_HOLDER_MISMATCH: le changement part du détenteur actuel (%)', account.holder USING ERRCODE = 'P0001';
	END IF;
	IF NEW.type = 'holder_changed' AND NEW.new_holder = 'owner'
		AND (SELECT type FROM organizations WHERE id = NEW.organization_id) = 'landlord' THEN
		RAISE EXCEPTION 'LANDLORD_IS_HOLDER: un bailleur particulier détient lui-même la caution' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposit_movements_rules BEFORE INSERT ON deposit_movements FOR EACH ROW EXECUTE FUNCTION deposit_movements_rules();
--> statement-breakpoint
-- Après chaque mouvement : statut du compte recalculé et détenteur suivi. SECURITY DEFINER : l'application n'a pas le
-- droit d'écrire ces colonnes ; la mise à jour reste dans l'organisation du mouvement (RLS forcée).
CREATE FUNCTION deposit_movements_apply() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	received bigint;
BEGIN
	SELECT coalesce(sum(amount), 0) INTO received FROM deposit_movements
	WHERE organization_id = NEW.organization_id AND account_id = NEW.account_id AND type = 'received';
	UPDATE deposit_accounts SET
		holder = CASE WHEN NEW.type = 'holder_changed' THEN NEW.new_holder ELSE holder END,
		status = CASE
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
REVOKE ALL ON FUNCTION deposit_movements_apply() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER deposit_movements_apply AFTER INSERT ON deposit_movements FOR EACH ROW EXECUTE FUNCTION deposit_movements_apply();
--> statement-breakpoint
-- Un montant convenu modifié (brouillon) recalcule aussi le statut.
CREATE FUNCTION deposit_accounts_refresh_status() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	received bigint;
BEGIN
	SELECT coalesce(sum(amount), 0) INTO received FROM deposit_movements
	WHERE organization_id = NEW.organization_id AND account_id = NEW.id AND type = 'received';
	UPDATE deposit_accounts SET status = CASE
			WHEN status IN ('settling', 'closed') THEN status
			WHEN received = 0 THEN 'pending'
			WHEN received < agreed_amount THEN 'partially_received'
			ELSE 'held'
		END
	WHERE organization_id = NEW.organization_id AND id = NEW.id;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION deposit_accounts_refresh_status() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER deposit_accounts_refresh_status AFTER UPDATE OF agreed_amount ON deposit_accounts
	FOR EACH ROW WHEN (NEW.agreed_amount IS DISTINCT FROM OLD.agreed_amount) EXECUTE FUNCTION deposit_accounts_refresh_status();
--> statement-breakpoint

-- ---------------------------------------------------------------- documents : bail scanné, pièce du locataire

ALTER TABLE documents DROP CONSTRAINT documents_type_check;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN ('title_deed', 'puh', 'allocation_certificate', 'apfr',
	'owner_identity', 'mandate', 'document_photo', 'other', 'signed_lease_scan', 'tenant_identity'));
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN tenant_id uuid, ADD COLUMN lease_id uuid;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_tenant_fk FOREIGN KEY (organization_id, tenant_id) REFERENCES tenants (organization_id, id);
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id);
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT documents_subject;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_subject CHECK (num_nonnulls(owner_id, mandate_id, property_id, tenant_id, lease_id) >= 1);
--> statement-breakpoint
-- Le bail scanné se rattache à un bail ; la pièce d'identité du locataire, à un locataire.
ALTER TABLE documents ADD CONSTRAINT documents_lease_types CHECK (
	(type <> 'signed_lease_scan' OR lease_id IS NOT NULL) AND (type <> 'tenant_identity' OR tenant_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX documents_by_lease ON documents (organization_id, lease_id) WHERE lease_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX documents_by_tenant ON documents (organization_id, tenant_id) WHERE tenant_id IS NOT NULL;
--> statement-breakpoint
-- Même règle de version qu'au lot 07, avec les deux nouveaux objets liés.
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
				OR NEW.lease_id IS DISTINCT FROM previous.lease_id THEN
				RAISE EXCEPTION 'DOCUMENT_VERSION_SUBJECT: une nouvelle version garde le type et les objets liés' USING ERRCODE = 'P0001';
			END IF;
			IF NEW.version <> previous.version + 1 THEN
				RAISE EXCEPTION 'DOCUMENT_VERSION: la nouvelle version est la %', previous.version + 1 USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;
	IF ROW(NEW.type, NEW.owner_id, NEW.mandate_id, NEW.property_id, NEW.unit_id, NEW.tenant_id, NEW.lease_id, NEW.version, NEW.replaces_id,
			NEW.file_name, NEW.mime_type, NEW.byte_size, NEW.storage_key, NEW.uploaded_by, NEW.created_at)
		IS DISTINCT FROM ROW(OLD.type, OLD.owner_id, OLD.mandate_id, OLD.property_id, OLD.unit_id, OLD.tenant_id, OLD.lease_id, OLD.version,
			OLD.replaces_id, OLD.file_name, OLD.mime_type, OLD.byte_size, OLD.storage_key, OLD.uploaded_by, OLD.created_at) THEN
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

-- ---------------------------------------------------------------- tâche quotidienne

-- Organisations qui ont, à la date donnée, un bail signé dont le début est arrivé, un bail en vigueur sans fin (à
-- prolonger sur 12 mois glissants), ou une échéance à faire avancer (due à sa date, en retard le lendemain).
-- SECURITY DEFINER : ne renvoie QUE des identifiants d'organisation ; la tâche ouvre ensuite chacune dans son propre
-- contexte (withOrganization), sous la RLS. Même modèle que due_mandate_organizations (lot 06).
CREATE FUNCTION due_lease_organizations(as_of date) RETURNS SETOF uuid
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT organization_id FROM leases WHERE status = 'signed' AND starts_on <= as_of
	UNION
	SELECT organization_id FROM leases WHERE status IN ('active', 'notice') AND ends_on IS NULL
	UNION
	SELECT organization_id FROM rent_dues
	WHERE (status = 'upcoming' AND due_on <= as_of) OR (status IN ('due', 'partial') AND due_on < as_of)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION due_lease_organizations(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION due_lease_organizations(date) TO app_api;
--> statement-breakpoint

-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)

GRANT SELECT ON tenants, leases, lease_versions, rent_dues, deposit_accounts, deposit_movements TO app_sync;
--> statement-breakpoint
CREATE POLICY sync_read ON tenants FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON leases FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON lease_versions FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON rent_dues FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON deposit_accounts FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON deposit_movements FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE tenants, leases, lease_versions, rent_dues, deposit_accounts, deposit_movements;
