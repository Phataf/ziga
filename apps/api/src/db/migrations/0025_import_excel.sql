-- Lot 11 — import Excel. Règles 1, 4, 9, 13 et 14 de CLAUDE.md ; D33. Les règles pures sont dans packages/shared
-- (import-*.ts) ; la base applique les siennes, en dernier rempart.
--
-- - import_jobs : une tâche d'import par fichier envoyé (prompt §4) : auteur (direction ou gestion), statut, date de
--   bascule (jamais dans le futur ; le 1er d'un mois quand l'organisation facture le premier mois en entier, réponse du
--   porteur), fichier d'origine conservé 90 jours, correspondance des colonnes, choix, prévisualisation, rapport.
--   Cloisonnée par organisation (RLS), jamais supprimée, jamais synchronisée.
-- - Identifiant de l'import sur chaque ligne créée (prompt §4) : l'exécution pose `app.import_job_id` dans chaque
--   transaction d'onglet ; la base le recopie dans `import_job_id` de chaque ligne créée (fiches, mandats, biens,
--   unités, baux et leurs versions, échéances, cautions, mouvements, journal), jamais depuis la valeur envoyée, et ne le
--   change plus. Seul un import en cours d'exécution (ou annulé dans la transaction même) marque une ligne. Les écritures
--   restent celles des services des modules : déclencheurs, contraintes, RLS et audit s'appliquent.
-- - D33 : un versement de caution sans encaissement est accepté seulement pour un compte créé par l'import en cours, une
--   fois ; il n'a pas de reçu. Hors import, tout versement reste un encaissement (migration 0016). Sa contre-écriture,
--   sans encaissement, n'existe qu'à l'annulation de l'import.
-- - Échéance « Solde antérieur » (`rent_dues.kind = 'opening_balance'`, prompt §3) : seulement pour un bail de l'import,
--   une par bail, du début du bail à la veille de la bascule, exigible à la date de bascule, sans charges.
-- - Date de fin d'origine d'un bail échu importé à durée indéterminée (`leases.original_ends_on`, réponse 3) : seulement
--   à l'import, figée.
-- - Annulation sous 24 heures sans encaissement (prompt §4, réponse 7) : un bail importé en vigueur s'annule seulement
--   dans la transaction qui annule son import ; jamais de suppression.
-- - Journal : origine `import`.
--> statement-breakpoint
-- ---------------------------------------------------------------- journal

ALTER TABLE audit_log DROP CONSTRAINT audit_log_origin_check
--> statement-breakpoint
ALTER TABLE audit_log ADD CONSTRAINT audit_log_origin_check
	CHECK (origin IN ('app', 'api', 'admin', 'sync', 'job', 'migration', 'portal', 'import'))
--> statement-breakpoint
-- ---------------------------------------------------------------- tâches d'import

CREATE TABLE import_jobs (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	created_by uuid NOT NULL REFERENCES users (id),
	status text NOT NULL CHECK (status IN ('uploaded', 'analyzing', 'analyzed', 'analysis_failed', 'running', 'completed', 'failed', 'cancelled')),
	file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
	file_format text NOT NULL CHECK (file_format IN ('xlsx', 'csv')),
	file_size bigint NOT NULL CHECK (file_size > 0),
	file_sha256 text CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
	storage_key text NOT NULL CHECK (char_length(storage_key) BETWEEN 1 AND 512),
	-- Fichier d'origine conservé 90 jours (prompt §4), posé par la base ; effacé du stockage ensuite, la ligne reste.
	file_expires_at timestamptz NOT NULL,
	file_deleted_at timestamptz,
	-- Date de bascule (réponse 1) : les échéances sont générées à partir d'elle ; ce qui était dû avant est le solde d'ouverture.
	switch_on date NOT NULL,
	mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
	choices jsonb NOT NULL DEFAULT '{}'::jsonb,
	preview jsonb,
	report jsonb,
	error text CHECK (char_length(error) <= 2000),
	started_at timestamptz,
	completed_at timestamptz,
	cancelled_at timestamptz,
	cancelled_by uuid REFERENCES users (id),
	cancellation_reason text CHECK (char_length(cancellation_reason) BETWEEN 3 AND 500),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT import_jobs_started CHECK (status NOT IN ('running', 'completed', 'failed', 'cancelled') OR started_at IS NOT NULL),
	CONSTRAINT import_jobs_completed CHECK (status NOT IN ('completed', 'cancelled') OR completed_at IS NOT NULL),
	CONSTRAINT import_jobs_cancelled CHECK (
		(status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL)
	)
)
--> statement-breakpoint
CREATE INDEX import_jobs_by_date ON import_jobs (organization_id, created_at DESC)
--> statement-breakpoint
SELECT enable_organization_rls('import_jobs')
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON import_jobs FROM app_api, app_admin
--> statement-breakpoint
-- Import du contexte de la transaction (`app.import_job_id`, posé par l'exécution de l'import), ou null.
CREATE FUNCTION current_import_job_id() RETURNS uuid
	LANGUAGE sql
	STABLE
	SET search_path = pg_catalog, public
AS $$
	SELECT nullif(current_setting('app.import_job_id', true), '')::uuid
$$
--> statement-breakpoint
-- Date de bascule refusée (réponses 1 et 3 du porteur), même règle que `switchDateIssue` (packages/shared).
CREATE FUNCTION import_jobs_check_switch(org uuid, switch_on date) RETURNS void
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF switch_on > (now() AT TIME ZONE 'Africa/Ouagadougou')::date THEN
		RAISE EXCEPTION 'IMPORT_SWITCH_FUTURE: la date de bascule ne peut pas être dans le futur' USING ERRCODE = 'P0001';
	END IF;
	IF extract(day FROM switch_on) <> 1 AND (SELECT rent_billing_mode FROM organizations WHERE id = org) = 'calendar_full_first' THEN
		RAISE EXCEPTION 'IMPORT_SWITCH_FIRST_OF_MONTH: l''organisation facture le premier mois en entier : la bascule est le 1er d''un mois'
			USING ERRCODE = 'P0001';
	END IF;
END;
$$
--> statement-breakpoint
CREATE FUNCTION import_jobs_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'uploaded' OR NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.report IS NOT NULL
			OR NEW.file_deleted_at IS NOT NULL THEN
			RAISE EXCEPTION 'IMPORT_BORN_UPLOADED: un import naît « envoyé »' USING ERRCODE = 'P0001';
		END IF;
		IF NOT person_link_manager(NEW.organization_id, NEW.created_by) THEN
			RAISE EXCEPTION 'IMPORT_RUNNER: seule la direction ou la gestion importe un registre' USING ERRCODE = 'P0001';
		END IF;
		PERFORM import_jobs_check_switch(NEW.organization_id, NEW.switch_on);
		NEW.file_expires_at := NEW.created_at + interval '90 days';
		RETURN NEW;
	END IF;

	IF (NEW.id, NEW.organization_id, NEW.created_by, NEW.file_name, NEW.file_format, NEW.file_size, NEW.storage_key, NEW.file_expires_at,
		NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.created_by, OLD.file_name, OLD.file_format, OLD.file_size,
		OLD.storage_key, OLD.file_expires_at, OLD.created_at)
		OR (OLD.file_sha256 IS NOT NULL AND NEW.file_sha256 IS DISTINCT FROM OLD.file_sha256)
		OR (OLD.file_deleted_at IS NOT NULL AND NEW.file_deleted_at IS DISTINCT FROM OLD.file_deleted_at) THEN
		RAISE EXCEPTION 'IMPORT_JOB_IMMUTABLE: le fichier, l''auteur et l''organisation d''un import ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	NEW.updated_at := now();
	-- Fichier effacé du stockage au bout de 90 jours : la prévisualisation (données du fichier) part avec lui.
	IF OLD.file_deleted_at IS NULL AND NEW.file_deleted_at IS NOT NULL THEN
		IF NEW.status <> OLD.status OR NEW.preview IS NOT NULL THEN
			RAISE EXCEPTION 'IMPORT_JOB_IMMUTABLE: l''effacement du fichier efface la prévisualisation, rien d''autre' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'uploaded' AND NEW.status IN ('analyzing', 'analysis_failed'))
		OR (OLD.status = 'analyzing' AND NEW.status IN ('analyzed', 'analysis_failed'))
		OR (OLD.status = 'analyzed' AND NEW.status IN ('analyzing', 'running'))
		OR (OLD.status = 'analysis_failed' AND NEW.status = 'analyzing')
		OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed'))
		OR (OLD.status = 'failed' AND NEW.status = 'running')
		OR (OLD.status = 'completed' AND NEW.status = 'cancelled')
	) THEN
		RAISE EXCEPTION 'IMPORT_STATUS: passage de % à % refusé', OLD.status, NEW.status USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'cancelled' THEN
		RAISE EXCEPTION 'IMPORT_JOB_CLOSED: un import annulé ne change plus' USING ERRCODE = 'P0001';
	END IF;
	-- Avant l'exécution : correspondance, choix, prévisualisation et date de bascule se corrigent ; ensuite, plus rien.
	IF OLD.status IN ('running', 'completed', 'failed') AND (NEW.switch_on, NEW.mapping, NEW.choices, NEW.preview)
		IS DISTINCT FROM (OLD.switch_on, OLD.mapping, OLD.choices, OLD.preview) THEN
		RAISE EXCEPTION 'IMPORT_JOB_IMMUTABLE: ce qui a été validé avant l''exécution ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'running' AND NEW.switch_on IS DISTINCT FROM OLD.switch_on THEN
		RAISE EXCEPTION 'IMPORT_JOB_IMMUTABLE: la date de bascule est figée à l''exécution' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.switch_on IS DISTINCT FROM OLD.switch_on OR (NEW.status = 'running' AND OLD.status = 'analyzed') THEN
		PERFORM import_jobs_check_switch(NEW.organization_id, NEW.switch_on);
	END IF;
	IF OLD.status IN ('completed') AND NEW.report IS DISTINCT FROM OLD.report THEN
		RAISE EXCEPTION 'IMPORT_JOB_IMMUTABLE: le rapport d''un import terminé ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
		RAISE EXCEPTION 'IMPORT_JOB_IMMUTABLE: la fin d''un import ne change plus' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'completed' AND OLD.status = 'running' AND NEW.completed_at > now() THEN
		RAISE EXCEPTION 'IMPORT_JOB_IMMUTABLE: un import ne se termine pas dans le futur' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'cancelled' THEN
		-- Annulation (prompt §4, réponse 7) : par la direction ou la gestion, dans les 24 heures, sans encaissement depuis.
		IF NOT person_link_manager(NEW.organization_id, NEW.cancelled_by) THEN
			RAISE EXCEPTION 'IMPORT_RUNNER: seule la direction ou la gestion annule un import' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.cancelled_at <> now() THEN
			RAISE EXCEPTION 'IMPORT_CANCEL_NOW: une annulation est datée de sa transaction' USING ERRCODE = 'P0001';
		END IF;
		IF now() > OLD.completed_at + interval '24 hours' THEN
			RAISE EXCEPTION 'IMPORT_CANCEL_EXPIRED: un import ne s''annule que dans les 24 heures' USING ERRCODE = 'P0001';
		END IF;
		IF EXISTS (
			SELECT 1 FROM payments p
			JOIN leases l ON l.organization_id = p.organization_id AND l.id = p.lease_id
			WHERE p.organization_id = NEW.organization_id AND l.import_job_id = NEW.id
		) THEN
			RAISE EXCEPTION 'IMPORT_CANCEL_PAYMENTS: un encaissement a été enregistré sur un bail de cet import' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$
--> statement-breakpoint
REVOKE ALL ON FUNCTION import_jobs_rules() FROM PUBLIC
--> statement-breakpoint
CREATE TRIGGER import_jobs_rules BEFORE INSERT OR UPDATE ON import_jobs FOR EACH ROW EXECUTE FUNCTION import_jobs_rules()
--> statement-breakpoint
-- ---------------------------------------------------------------- identifiant de l'import sur chaque ligne créée

CREATE FUNCTION import_job_tag() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	job uuid;
	job_status text;
	job_cancelled_at timestamptz;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW.import_job_id IS DISTINCT FROM OLD.import_job_id THEN
			RAISE EXCEPTION 'IMPORT_JOB_IMMUTABLE: l''import d''une ligne ne change pas' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	job := current_import_job_id();
	-- Jamais la valeur envoyée : seule l'exécution de l'import marque une ligne.
	NEW.import_job_id := NULL;
	IF job IS NULL THEN
		RETURN NEW;
	END IF;
	SELECT status, cancelled_at INTO job_status, job_cancelled_at FROM import_jobs WHERE organization_id = NEW.organization_id AND id = job;
	IF job_status IS NULL THEN
		RAISE EXCEPTION 'IMPORT_JOB_UNKNOWN: import introuvable dans cette organisation' USING ERRCODE = 'P0001';
	END IF;
	IF NOT (job_status = 'running' OR (job_status = 'cancelled' AND job_cancelled_at = now())) THEN
		RAISE EXCEPTION 'IMPORT_JOB_NOT_RUNNING: seul un import en cours d''exécution crée des lignes' USING ERRCODE = 'P0001';
	END IF;
	NEW.import_job_id := job;
	RETURN NEW;
END;
$$
--> statement-breakpoint
REVOKE ALL ON FUNCTION import_job_tag() FROM PUBLIC
--> statement-breakpoint
ALTER TABLE owners ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE owners ADD CONSTRAINT owners_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX owners_by_import_job ON owners (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON owners FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE mandates ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE mandates ADD CONSTRAINT mandates_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX mandates_by_import_job ON mandates (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON mandates FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE mandate_versions ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE mandate_versions ADD CONSTRAINT mandate_versions_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX mandate_versions_by_import_job ON mandate_versions (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON mandate_versions FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE mandate_scopes ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE mandate_scopes ADD CONSTRAINT mandate_scopes_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX mandate_scopes_by_import_job ON mandate_scopes (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON mandate_scopes FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE properties ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE properties ADD CONSTRAINT properties_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX properties_by_import_job ON properties (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE units ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE units ADD CONSTRAINT units_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX units_by_import_job ON units (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON units FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE tenants ADD CONSTRAINT tenants_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX tenants_by_import_job ON tenants (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE leases ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE leases ADD CONSTRAINT leases_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX leases_by_import_job ON leases (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE lease_versions ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE lease_versions ADD CONSTRAINT lease_versions_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX lease_versions_by_import_job ON lease_versions (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON lease_versions FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE rent_dues ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE rent_dues ADD CONSTRAINT rent_dues_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX rent_dues_by_import_job ON rent_dues (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON rent_dues FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE deposit_accounts ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE deposit_accounts ADD CONSTRAINT deposit_accounts_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX deposit_accounts_by_import_job ON deposit_accounts (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON deposit_accounts FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
ALTER TABLE deposit_movements ADD COLUMN import_job_id uuid
--> statement-breakpoint
ALTER TABLE deposit_movements ADD CONSTRAINT deposit_movements_import_job_fk FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id)
--> statement-breakpoint
CREATE INDEX deposit_movements_by_import_job ON deposit_movements (organization_id, import_job_id) WHERE import_job_id IS NOT NULL
--> statement-breakpoint
CREATE TRIGGER import_job_tag BEFORE INSERT OR UPDATE ON deposit_movements FOR EACH ROW EXECUTE FUNCTION import_job_tag()
--> statement-breakpoint
-- Journal : l'import y est noté aussi (sans clé étrangère : le journal ne dépend d'aucune table métier).
ALTER TABLE audit_log ADD COLUMN import_job_id uuid
--> statement-breakpoint
CREATE FUNCTION audit_log_import_tag() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	job uuid := current_import_job_id();
BEGIN
	NEW.import_job_id := NULL;
	IF job IS NOT NULL AND NEW.organization_id IS NOT NULL
		AND EXISTS (SELECT 1 FROM import_jobs WHERE organization_id = NEW.organization_id AND id = job) THEN
		NEW.import_job_id := job;
	END IF;
	RETURN NEW;
END;
$$
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_log_import_tag() FROM PUBLIC
--> statement-breakpoint
CREATE TRIGGER audit_log_import_tag BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_import_tag()
--> statement-breakpoint
-- ---------------------------------------------------------------- D33 : versement de caution repris par l'import

CREATE OR REPLACE FUNCTION deposit_movements_received_needs_payment() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	job uuid;
	account_job uuid;
BEGIN
	IF NEW.type = 'received' AND NEW.payment_id IS NULL THEN
		job := current_import_job_id();
		IF job IS NULL OR NOT EXISTS (SELECT 1 FROM import_jobs WHERE organization_id = NEW.organization_id AND id = job AND status = 'running') THEN
			RAISE EXCEPTION 'DEPOSIT_RECEIPT_VIA_PAYMENT: un versement de caution passe par un encaissement' USING ERRCODE = 'P0001';
		END IF;
		SELECT import_job_id INTO account_job FROM deposit_accounts WHERE organization_id = NEW.organization_id AND id = NEW.account_id;
		IF account_job IS DISTINCT FROM job THEN
			RAISE EXCEPTION 'DEPOSIT_IMPORT_ACCOUNT: seul un compte de caution créé par cet import reçoit un versement repris (D33)'
				USING ERRCODE = 'P0001';
		END IF;
		IF EXISTS (SELECT 1 FROM deposit_movements WHERE organization_id = NEW.organization_id AND account_id = NEW.account_id AND type = 'received') THEN
			RAISE EXCEPTION 'DEPOSIT_IMPORT_FIRST: le versement repris par l''import est le premier et le seul de ce compte' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$
--> statement-breakpoint
ALTER TABLE deposit_movements DROP CONSTRAINT deposit_movements_cancelled_payment
--> statement-breakpoint
ALTER TABLE deposit_movements ADD CONSTRAINT deposit_movements_cancelled_payment
	CHECK (type <> 'received_cancelled' OR payment_id IS NOT NULL OR import_job_id IS NOT NULL)
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.deposit_movements_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
		IF NEW.payment_id IS NULL THEN
			-- D33 (lot 11) : contre-écriture d'un versement repris par l'import, seulement à l'annulation de cet import.
			IF account.import_job_id IS NULL OR current_import_job_id() IS DISTINCT FROM account.import_job_id
				OR NOT EXISTS (SELECT 1 FROM import_jobs j WHERE j.organization_id = NEW.organization_id AND j.id = account.import_job_id
					AND j.status = 'cancelled' AND j.cancelled_at = now()) THEN
				RAISE EXCEPTION 'DEPOSIT_IMPORT_CANCELLATION: un versement repris par l''import ne s''annule qu''avec l''annulation de cet import'
					USING ERRCODE = 'P0001';
			END IF;
			SELECT coalesce(sum(amount) FILTER (WHERE type = 'received'), 0) - coalesce(sum(amount) FILTER (WHERE type = 'received_cancelled'), 0)
			INTO paid_by_payment
			FROM deposit_movements WHERE organization_id = NEW.organization_id AND account_id = NEW.account_id AND payment_id IS NULL
				AND import_job_id = account.import_job_id;
		ELSE
			SELECT coalesce(sum(amount) FILTER (WHERE type = 'received'), 0) - coalesce(sum(amount) FILTER (WHERE type = 'received_cancelled'), 0)
			INTO paid_by_payment
			FROM deposit_movements WHERE organization_id = NEW.organization_id AND account_id = NEW.account_id AND payment_id = NEW.payment_id;
		END IF;
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
$function$
--> statement-breakpoint
-- ---------------------------------------------------------------- échéance « Solde antérieur »

ALTER TABLE rent_dues ADD COLUMN kind text NOT NULL DEFAULT 'rent' CHECK (kind IN ('rent', 'opening_balance'))
--> statement-breakpoint
ALTER TABLE rent_dues DROP CONSTRAINT rent_dues_period
--> statement-breakpoint
-- Le solde d'ouverture couvre la période d'avant la bascule et devient exigible le lendemain de sa fin (la bascule).
ALTER TABLE rent_dues ADD CONSTRAINT rent_dues_period CHECK (
	period_end >= period_start AND (due_on <= period_end OR (kind = 'opening_balance' AND due_on = period_end + 1))
)
--> statement-breakpoint
CREATE UNIQUE INDEX rent_dues_one_opening_balance ON rent_dues (organization_id, lease_id) WHERE kind = 'opening_balance'
--> statement-breakpoint
CREATE FUNCTION rent_dues_opening_balance() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	job uuid;
	job_switch date;
	lease_job uuid;
	lease_starts date;
	lease_dues_start date;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW.kind IS DISTINCT FROM OLD.kind THEN
			RAISE EXCEPTION 'RENT_DUE_IMMUTABLE: la nature d''une échéance ne change pas' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.kind <> 'opening_balance' THEN
		RETURN NEW;
	END IF;
	job := current_import_job_id();
	SELECT import_job_id, starts_on, dues_start_on INTO lease_job, lease_starts, lease_dues_start
	FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
	SELECT switch_on INTO job_switch FROM import_jobs WHERE organization_id = NEW.organization_id AND id = job AND status = 'running';
	IF job IS NULL OR job_switch IS NULL OR lease_job IS DISTINCT FROM job THEN
		RAISE EXCEPTION 'RENT_DUE_OPENING_IMPORT: un solde d''ouverture n''existe que pour un bail de l''import en cours' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.due_on <> job_switch OR NEW.period_end <> job_switch - 1 OR NEW.period_start <> lease_starts OR NEW.period_end >= lease_dues_start THEN
		RAISE EXCEPTION 'RENT_DUE_OPENING_DATES: un solde d''ouverture va du début du bail à la veille de la bascule, exigible à la bascule'
			USING ERRCODE = 'P0001';
	END IF;
	IF NEW.charges <> 0 OR NEW.is_advance OR NEW.prorated THEN
		RAISE EXCEPTION 'RENT_DUE_OPENING_AMOUNT: un solde d''ouverture est un seul montant, sans charges ni avance' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$
--> statement-breakpoint
REVOKE ALL ON FUNCTION rent_dues_opening_balance() FROM PUBLIC
--> statement-breakpoint
CREATE TRIGGER rent_dues_opening_balance BEFORE INSERT OR UPDATE ON rent_dues FOR EACH ROW EXECUTE FUNCTION rent_dues_opening_balance()
--> statement-breakpoint
-- ---------------------------------------------------------------- baux : date de fin d'origine, annulation avec l'import

ALTER TABLE leases ADD COLUMN original_ends_on date
--> statement-breakpoint
ALTER TABLE leases ADD CONSTRAINT leases_original_ends_on CHECK (original_ends_on IS NULL OR original_ends_on >= starts_on)
--> statement-breakpoint
CREATE FUNCTION leases_import() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.original_ends_on IS NOT NULL AND current_import_job_id() IS NULL THEN
			RAISE EXCEPTION 'LEASE_ORIGINAL_END_IMPORT: la date de fin d''origine n''existe que pour un bail importé' USING ERRCODE = 'P0001';
		END IF;
	ELSIF NEW.original_ends_on IS DISTINCT FROM OLD.original_ends_on THEN
		RAISE EXCEPTION 'LEASE_ORIGINAL_END_IMMUTABLE: la date de fin d''origine d''un bail importé ne change pas' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$
--> statement-breakpoint
REVOKE ALL ON FUNCTION leases_import() FROM PUBLIC
--> statement-breakpoint
CREATE TRIGGER leases_import BEFORE INSERT OR UPDATE ON leases FOR EACH ROW EXECUTE FUNCTION leases_import()
--> statement-breakpoint
-- Un bail importé en vigueur s'annule seulement dans la transaction qui annule son import, sans encaissement sur lui.
CREATE FUNCTION lease_import_cancellable(org uuid, lease uuid, job uuid) RETURNS boolean
	LANGUAGE sql
	STABLE
	SET search_path = pg_catalog, public
AS $$
	SELECT job IS NOT NULL
		AND EXISTS (SELECT 1 FROM import_jobs WHERE organization_id = org AND id = job AND status = 'cancelled' AND cancelled_at = now())
		AND NOT EXISTS (SELECT 1 FROM payments WHERE organization_id = org AND lease_id = lease)
$$
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.leases_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
		-- Lot 11 : un bail importé en vigueur s'annule seulement avec son import (sous 24 heures, sans encaissement).
		OR (OLD.status = 'active' AND NEW.status = 'cancelled' AND lease_import_cancellable(OLD.organization_id, OLD.id, OLD.import_job_id))
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
$function$
