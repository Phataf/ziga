-- Lot 10 — impayés, relances, dépenses, relevés propriétaires et reversements (module collections). Règles 1, 2, 3,
-- 4, 5, 14, 15 et 16 de CLAUDE.md ; D29. Les règles pures sont dans packages/shared (statements.ts, expenses.ts,
-- reminders.ts, collections.ts) ; la base applique les mêmes, en dernier rempart.
--
-- - reminders : relances en ajout seul (locataire, échéances et dépenses visées, canal, modèle, note, auteur).
-- - reminder_settings : les trois modèles et les trois seuils (J+5, J+15, J+30 par défaut) de l'organisation.
-- - expenses : une dépense est un seul enregistrement (règle 16) ; qui a payé, qui la supporte, comment elle est
--   récupérée, parmi les six combinaisons admises ; ajout seul, annulation motivée écrite une fois.
-- - payments, payment_allocations, receipts : objet `expense` (option A du porteur) — l'encaissement d'une dépense
--   réclamée au locataire s'impute exactement sur cette dépense, jamais en crédit, jamais au-delà de son montant.
-- - owner_statements : relevé d'un propriétaire pour un mois ; brouillon recalculé, puis émis et figé (copie D29).
--   Un rectificatif est une version suivante du même mois. Les relevés s'émettent dans l'ordre des mois.
-- - owner_statement_lines : éléments consommés par un relevé émis (imputation, commission fixe, dépense, annulation de
--   dépense, solde reporté), écrits à l'émission seulement ; un élément n'entre qu'une fois (index unique sur sa clé,
--   la même que statementItemKey de packages/shared).
-- - owner_statement_tokens : empreintes SHA-256 des liens /s/<jeton> ; 90 jours ; révocables. Lecture publique par
--   une fonction qui ne renvoie que l'organisation et le relevé.
-- - owner_payouts : reversements enregistrés (jamais exécutés par la plateforme, règle 5), en ajout seul ; une erreur
--   se corrige par une contre-écriture ; le total reversé ne dépasse jamais le net du relevé.

-- ---------------------------------------------------------------- relances

CREATE TABLE reminders (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	tenant_id uuid NOT NULL,
	-- Échéances et dépenses réclamées visées : contrôlées par le trigger (même locataire, même organisation).
	rent_due_ids uuid[] NOT NULL DEFAULT '{}',
	expense_ids uuid[] NOT NULL DEFAULT '{}',
	channel text NOT NULL CHECK (channel IN ('whatsapp_link', 'sms', 'call', 'visit')),
	-- Modèle utilisé pour un message ; aucun pour un appel ou une visite.
	template_level smallint CHECK (template_level BETWEEN 1 AND 3),
	note text CHECK (char_length(note) <= 500),
	sent_at timestamptz NOT NULL DEFAULT now(),
	sent_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT reminders_tenant_fk FOREIGN KEY (organization_id, tenant_id) REFERENCES tenants (organization_id, id),
	CONSTRAINT reminders_template CHECK ((channel IN ('whatsapp_link', 'sms')) = (template_level IS NOT NULL)),
	CONSTRAINT reminders_subject CHECK (cardinality(rent_due_ids) + cardinality(expense_ids) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE INDEX reminders_by_tenant ON reminders (organization_id, tenant_id, sent_at DESC);
--> statement-breakpoint
SELECT enable_organization_rls('reminders');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON reminders FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER reminders_no_update_delete BEFORE UPDATE OR DELETE ON reminders FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER reminders_no_truncate BEFORE TRUNCATE ON reminders FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Chaque échéance visée est celle d'un bail du locataire ; chaque dépense, une créance sur ce locataire. Sous la RLS,
-- une échéance d'une autre organisation est introuvable : refusée.
CREATE FUNCTION reminders_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	-- Locataire introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
	IF NOT EXISTS (SELECT FROM tenants WHERE organization_id = NEW.organization_id AND id = NEW.tenant_id) THEN
		RETURN NEW;
	END IF;
	IF EXISTS (
		SELECT FROM unnest(NEW.rent_due_ids) AS d (id)
		WHERE NOT EXISTS (
			SELECT FROM rent_dues r JOIN leases l ON l.organization_id = r.organization_id AND l.id = r.lease_id
			WHERE r.organization_id = NEW.organization_id AND r.id = d.id AND l.tenant_id = NEW.tenant_id
		)
	) THEN
		RAISE EXCEPTION 'REMINDER_SUBJECT_INVALID: une échéance visée n''est pas celle de ce locataire' USING ERRCODE = 'P0001';
	END IF;
	IF EXISTS (
		SELECT FROM unnest(NEW.expense_ids) AS x (id)
		WHERE NOT EXISTS (
			SELECT FROM expenses e JOIN leases l ON l.organization_id = e.organization_id AND l.id = e.lease_id
			WHERE e.organization_id = NEW.organization_id AND e.id = x.id AND l.tenant_id = NEW.tenant_id
				AND e.recovery = 'claimed_from_tenant'
		)
	) THEN
		RAISE EXCEPTION 'REMINDER_SUBJECT_INVALID: une dépense visée n''est pas réclamée à ce locataire' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TABLE reminder_settings (
	organization_id uuid PRIMARY KEY REFERENCES organizations (id),
	template_1 text NOT NULL CHECK (char_length(template_1) BETWEEN 10 AND 1000),
	template_2 text NOT NULL CHECK (char_length(template_2) BETWEEN 10 AND 1000),
	template_3 text NOT NULL CHECK (char_length(template_3) BETWEEN 10 AND 1000),
	offset_1 smallint NOT NULL DEFAULT 5,
	offset_2 smallint NOT NULL DEFAULT 15,
	offset_3 smallint NOT NULL DEFAULT 30,
	updated_by uuid REFERENCES users (id),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT reminder_settings_offsets CHECK (offset_1 >= 1 AND offset_1 < offset_2 AND offset_2 < offset_3 AND offset_3 <= 365)
);
--> statement-breakpoint
SELECT enable_organization_rls('reminder_settings');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON reminder_settings FROM app_api, app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- documents : justificatif d'une dépense

ALTER TABLE documents DROP CONSTRAINT documents_type_check;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN ('title_deed', 'puh', 'allocation_certificate', 'apfr',
	'owner_identity', 'mandate', 'document_photo', 'other', 'signed_lease_scan', 'tenant_identity', 'contract_template', 'contract_draft',
	'signed_amendment_scan', 'contract_legalization', 'contract_registration', 'expense_receipt'));
--> statement-breakpoint

-- ---------------------------------------------------------------- dépenses (règle 16)

CREATE TABLE expenses (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	property_id uuid NOT NULL,
	unit_id uuid,
	-- Bail du locataire concerné : exigé quand il supporte ou a payé la dépense.
	lease_id uuid,
	spent_on date NOT NULL,
	category text NOT NULL CHECK (category IN ('plumbing', 'electrical_work', 'carpentry', 'painting', 'maintenance', 'tax',
		'water_bill', 'electricity_bill', 'security_guard', 'other')),
	description text NOT NULL CHECK (char_length(description) BETWEEN 2 AND 500),
	supplier text CHECK (char_length(supplier) <= 120),
	-- FCFA entiers, strictement positifs (règle 2).
	amount bigint NOT NULL CHECK (amount > 0),
	-- Justificatif (registre des documents) ; peut s'ajouter une fois après coup.
	document_id uuid,
	paid_by text NOT NULL CHECK (paid_by IN ('organization', 'owner', 'tenant')),
	borne_by text NOT NULL CHECK (borne_by IN ('owner', 'organization', 'tenant')),
	recovery text NOT NULL CHECK (recovery IN ('owner_statement', 'deposit', 'claimed_from_tenant', 'none')),
	status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'cancelled')),
	cancellation_reason text CHECK (char_length(cancellation_reason) BETWEEN 5 AND 500),
	cancelled_at timestamptz,
	cancelled_by uuid REFERENCES users (id),
	recorded_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT expenses_property_fk FOREIGN KEY (organization_id, property_id) REFERENCES properties (organization_id, id),
	CONSTRAINT expenses_unit_fk FOREIGN KEY (organization_id, property_id, unit_id) REFERENCES units (organization_id, property_id, id),
	CONSTRAINT expenses_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT expenses_document_fk FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id),
	-- Les six combinaisons admises au lot 10 (packages/shared, EXPENSE_COMBINATIONS ; comparées par un test).
	CONSTRAINT expenses_combination CHECK ((paid_by, borne_by, recovery) IN (
		('organization', 'owner', 'owner_statement'),
		('organization', 'organization', 'none'),
		('organization', 'tenant', 'claimed_from_tenant'),
		('organization', 'tenant', 'deposit'),
		('owner', 'owner', 'none'),
		('tenant', 'tenant', 'none')
	)),
	CONSTRAINT expenses_lease_required CHECK ((borne_by <> 'tenant' AND paid_by <> 'tenant') OR lease_id IS NOT NULL),
	CONSTRAINT expenses_cancelled CHECK (
		(status = 'cancelled') = (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND cancelled_by IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE INDEX expenses_by_property ON expenses (organization_id, property_id, spent_on);
--> statement-breakpoint
CREATE INDEX expenses_claims ON expenses (organization_id, lease_id) WHERE recovery = 'claimed_from_tenant';
--> statement-breakpoint
SELECT enable_organization_rls('expenses');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON expenses FROM app_api, app_admin;
--> statement-breakpoint
GRANT UPDATE (status, cancellation_reason, cancelled_at, cancelled_by, document_id, updated_at) ON expenses TO app_api;
--> statement-breakpoint
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER expenses_no_truncate BEFORE TRUNCATE ON expenses FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE FUNCTION expenses_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease_unit uuid;
	unit_property uuid;
	org_type text;
	recovered bigint;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'recorded' OR NEW.cancelled_at IS NOT NULL THEN
			RAISE EXCEPTION 'EXPENSE_IMMUTABLE: une dépense naît enregistrée' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.spent_on > (now() AT TIME ZONE 'Africa/Ouagadougou')::date THEN
			RAISE EXCEPTION 'EXPENSE_DATE_IN_FUTURE: la date de la dépense est dans le futur' USING ERRCODE = 'P0001';
		END IF;
		-- Un bailleur particulier est aussi le propriétaire : pas de combinaison avec un propriétaire distinct.
		SELECT type INTO org_type FROM organizations WHERE id = NEW.organization_id;
		IF org_type = 'landlord' AND (NEW.paid_by = 'owner' OR NEW.borne_by = 'owner') THEN
			RAISE EXCEPTION 'EXPENSE_COMBINATION_UNSUPPORTED: un bailleur particulier n''a pas de propriétaire distinct' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.lease_id IS NOT NULL THEN
			SELECT unit_id INTO lease_unit FROM leases WHERE organization_id = NEW.organization_id AND id = NEW.lease_id;
			SELECT property_id INTO unit_property FROM units WHERE organization_id = NEW.organization_id AND id = lease_unit;
			-- Bail introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
			IF lease_unit IS NOT NULL AND (unit_property <> NEW.property_id OR (NEW.unit_id IS NOT NULL AND NEW.unit_id <> lease_unit)) THEN
				RAISE EXCEPTION 'EXPENSE_LEASE_MISMATCH: le bail n''est pas celui de ce bien ou de cette unité' USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;

	IF (NEW.id, NEW.organization_id, NEW.property_id, NEW.unit_id, NEW.lease_id, NEW.spent_on, NEW.category, NEW.description,
		NEW.supplier, NEW.amount, NEW.paid_by, NEW.borne_by, NEW.recovery, NEW.recorded_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.property_id, OLD.unit_id, OLD.lease_id, OLD.spent_on, OLD.category, OLD.description,
		OLD.supplier, OLD.amount, OLD.paid_by, OLD.borne_by, OLD.recovery, OLD.recorded_by, OLD.created_at) THEN
		RAISE EXCEPTION 'EXPENSE_IMMUTABLE: une dépense enregistrée ne se modifie pas ; corrigez par une annulation' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
		RAISE EXCEPTION 'EXPENSE_IMMUTABLE: le justificatif ne se remplace pas' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'cancelled' AND (NEW.status, NEW.cancelled_at, NEW.cancelled_by, NEW.cancellation_reason)
		IS DISTINCT FROM (OLD.status, OLD.cancelled_at, OLD.cancelled_by, OLD.cancellation_reason) THEN
		RAISE EXCEPTION 'EXPENSE_IMMUTABLE: l''annulation ne se réécrit pas' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.status = 'cancelled' AND OLD.status = 'recorded' AND OLD.recovery = 'claimed_from_tenant' THEN
		-- Une créance déjà en partie encaissée ne s'annule pas : annulez d'abord les encaissements.
		SELECT coalesce(sum(CASE direction WHEN 'allocate' THEN amount ELSE -amount END), 0) INTO recovered
		FROM payment_allocations WHERE organization_id = NEW.organization_id AND expense_id = NEW.id;
		IF recovered > 0 THEN
			RAISE EXCEPTION 'EXPENSE_CLAIM_RECOVERED: une dépense déjà remboursée en partie ne s''annule pas' USING ERRCODE = 'P0001';
		END IF;
		IF EXISTS (SELECT FROM payments WHERE organization_id = NEW.organization_id AND expense_id = NEW.id AND kind = 'payment'
			AND status IN ('to_validate', 'to_reconcile', 'initiated', 'pending')) THEN
			RAISE EXCEPTION 'EXPENSE_CLAIM_PENDING: un encaissement de cette dépense attend sa validation' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expenses_rules BEFORE INSERT OR UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_rules();
--> statement-breakpoint
-- Créé après expenses : le trigger des relances lit les dépenses réclamées.
CREATE TRIGGER reminders_rules BEFORE INSERT ON reminders FOR EACH ROW EXECUTE FUNCTION reminders_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- encaissement d'une dépense réclamée (option A)

ALTER TABLE payments ADD COLUMN expense_id uuid;
--> statement-breakpoint
ALTER TABLE payments DROP CONSTRAINT payments_purpose_check;
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check CHECK (purpose IN ('rent', 'deposit', 'expense'));
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_expense_fk FOREIGN KEY (organization_id, expense_id) REFERENCES expenses (organization_id, id);
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_purpose_expense CHECK ((purpose = 'expense') = (expense_id IS NOT NULL));
--> statement-breakpoint
CREATE INDEX payments_by_expense ON payments (organization_id, expense_id) WHERE expense_id IS NOT NULL;
--> statement-breakpoint
-- Règles du lot 09, plus : un encaissement « dépense » vise une dépense réclamée au locataire de ce bail, non annulée ;
-- la contre-écriture vise la même dépense ; la dépense visée ne change jamais.
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
ALTER TABLE payment_allocations ADD COLUMN expense_id uuid;
--> statement-breakpoint
ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations_target_check;
--> statement-breakpoint
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_target_check CHECK (target IN ('rent_due', 'deposit_account', 'credit', 'expense'));
--> statement-breakpoint
ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations_target;
--> statement-breakpoint
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_target CHECK (
	(target = 'rent_due') = (rent_due_id IS NOT NULL) AND (target = 'deposit_account') = (deposit_account_id IS NOT NULL)
	AND (target = 'expense') = (expense_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_expense_fk
	FOREIGN KEY (organization_id, expense_id) REFERENCES expenses (organization_id, id);
--> statement-breakpoint
CREATE INDEX payment_allocations_by_expense ON payment_allocations (organization_id, expense_id) WHERE expense_id IS NOT NULL;
--> statement-breakpoint
-- Règles du lot 09, plus : un encaissement « dépense » s'impute sur sa dépense, et seulement elle (jamais en crédit).
CREATE OR REPLACE FUNCTION payment_allocations_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	p payments%ROWTYPE;
	due_lease uuid;
	due_status text;
BEGIN
	SELECT * INTO p FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.payment_id FOR UPDATE;
	-- Encaissement introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
	IF p.id IS NULL THEN
		RETURN NEW;
	END IF;
	IF p.kind <> 'payment' THEN
		RAISE EXCEPTION 'ALLOCATION_ON_REVERSAL: une contre-écriture n''est jamais imputée' USING ERRCODE = 'P0001';
	END IF;
	IF p.lease_id <> NEW.lease_id THEN
		RAISE EXCEPTION 'ALLOCATION_LEASE: une imputation reste sur le bail de son encaissement' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.direction = 'allocate' AND p.status <> 'confirmed' THEN
		RAISE EXCEPTION 'ALLOCATION_NOT_CONFIRMED: seul un encaissement confirmé est imputé' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.direction = 'reverse' AND p.status NOT IN ('confirmed', 'cancelled') THEN
		RAISE EXCEPTION 'ALLOCATION_NOT_CONFIRMED: rien à contrepasser sur un encaissement en attente' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.target IN ('rent_due', 'credit') AND p.purpose <> 'rent' THEN
		RAISE EXCEPTION 'ALLOCATION_PURPOSE: seul un encaissement de loyer s''impute sur les échéances ou en crédit' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.target = 'deposit_account' AND (p.purpose <> 'deposit' OR p.deposit_account_id <> NEW.deposit_account_id) THEN
		RAISE EXCEPTION 'ALLOCATION_PURPOSE: un encaissement de loyer ne s''impute pas sur une caution' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.target = 'expense' AND (p.purpose <> 'expense' OR p.expense_id <> NEW.expense_id) THEN
		RAISE EXCEPTION 'ALLOCATION_PURPOSE: un encaissement « dépense » s''impute sur sa dépense, et seulement elle' USING ERRCODE = 'P0001';
	END IF;
	IF p.purpose = 'expense' AND NEW.target <> 'expense' THEN
		RAISE EXCEPTION 'ALLOCATION_PURPOSE: un encaissement « dépense » s''impute sur sa dépense, jamais en crédit' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.target = 'rent_due' THEN
		SELECT lease_id, status INTO due_lease, due_status FROM rent_dues WHERE organization_id = NEW.organization_id AND id = NEW.rent_due_id;
		IF due_lease IS NOT NULL AND due_lease <> NEW.lease_id THEN
			RAISE EXCEPTION 'ALLOCATION_LEASE: l''échéance appartient à un autre bail' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.direction = 'allocate' AND due_status = 'waived' THEN
			RAISE EXCEPTION 'ALLOCATION_DUE_WAIVED: une échéance abandonnée ne reçoit rien' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Règles du lot 09, plus : une dépense ne reçoit jamais plus que son montant (somme nette de tous ses encaissements).
CREATE OR REPLACE FUNCTION payment_allocations_apply() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	net bigint;
	paid_on date;
	claimed bigint;
BEGIN
	SELECT coalesce(sum(CASE direction WHEN 'allocate' THEN amount ELSE -amount END), 0) INTO net
	FROM payment_allocations
	WHERE organization_id = NEW.organization_id AND payment_id = NEW.payment_id AND target = NEW.target
		AND rent_due_id IS NOT DISTINCT FROM NEW.rent_due_id AND deposit_account_id IS NOT DISTINCT FROM NEW.deposit_account_id
		AND expense_id IS NOT DISTINCT FROM NEW.expense_id;
	IF net < 0 THEN
		RAISE EXCEPTION 'ALLOCATION_NEGATIVE: on ne contrepasse pas plus que ce qui a été imputé (%)', NEW.target USING ERRCODE = 'P0001';
	END IF;
	IF NEW.target = 'rent_due' THEN
		UPDATE rent_dues SET amount_paid = (
			SELECT coalesce(sum(CASE direction WHEN 'allocate' THEN amount ELSE -amount END), 0) FROM payment_allocations
			WHERE organization_id = NEW.organization_id AND rent_due_id = NEW.rent_due_id
		), updated_at = now()
		WHERE organization_id = NEW.organization_id AND id = NEW.rent_due_id;
	ELSIF NEW.target = 'deposit_account' THEN
		SELECT p.paid_on INTO paid_on FROM payments p WHERE p.organization_id = NEW.organization_id AND p.id = NEW.payment_id;
		INSERT INTO deposit_movements (id, organization_id, account_id, type, amount, occurred_on, payment_id, created_by)
		VALUES (uuid_v7(), NEW.organization_id, NEW.deposit_account_id,
			CASE NEW.direction WHEN 'allocate' THEN 'received' ELSE 'received_cancelled' END, NEW.amount,
			CASE NEW.direction WHEN 'allocate' THEN paid_on ELSE (now() AT TIME ZONE 'Africa/Ouagadougou')::date END,
			NEW.payment_id, NEW.created_by);
	ELSIF NEW.target = 'expense' AND NEW.direction = 'allocate' THEN
		PERFORM 1 FROM expenses WHERE organization_id = NEW.organization_id AND id = NEW.expense_id FOR UPDATE;
		SELECT coalesce(sum(CASE a.direction WHEN 'allocate' THEN a.amount ELSE -a.amount END), 0) INTO net
		FROM payment_allocations a WHERE a.organization_id = NEW.organization_id AND a.expense_id = NEW.expense_id;
		SELECT amount INTO claimed FROM expenses WHERE organization_id = NEW.organization_id AND id = NEW.expense_id;
		IF net > claimed THEN
			RAISE EXCEPTION 'EXPENSE_OVERPAID: le remboursement dépasse le montant de la dépense (%)', claimed USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER TABLE receipts DROP CONSTRAINT receipts_purpose_check;
--> statement-breakpoint
ALTER TABLE receipts ADD CONSTRAINT receipts_purpose_check CHECK (purpose IN ('rent', 'deposit', 'expense'));
--> statement-breakpoint

-- ---------------------------------------------------------------- relevés propriétaires

CREATE TABLE owner_statements (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	owner_id uuid NOT NULL,
	-- Mois du relevé, « aaaa-mm ».
	month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	-- 1 : relevé du mois ; 2 et plus : rectificatif, qui référence la version qu'il complète.
	version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
	corrects_statement_id uuid,
	status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued')),
	-- Empreinte du calcul (statements.ts, `revision`) : l'émission refuse un brouillon changé entre-temps.
	revision text NOT NULL CHECK (revision ~ '^[0-9a-f]{8}$'),
	-- Totaux signés (FCFA entiers) : un relevé est un état calculé, pas un registre ; le net peut être négatif
	-- (mandat sans encaissement, annulation), et il est alors reporté sur le relevé suivant.
	rent_collected bigint NOT NULL,
	charges_collected bigint NOT NULL,
	collected bigint NOT NULL,
	rent_collected_by_owner bigint NOT NULL,
	charges_collected_by_owner bigint NOT NULL,
	commission bigint NOT NULL,
	expenses bigint NOT NULL,
	carried_balance bigint NOT NULL CHECK (carried_balance <= 0),
	net bigint NOT NULL,
	-- Contenu du relevé (organisation, propriétaire, lignes, sections d'information), figé à l'émission (D29).
	snapshot jsonb NOT NULL,
	logo_id uuid,
	generated_at timestamptz NOT NULL DEFAULT now(),
	generated_by uuid REFERENCES users (id),
	issued_on date,
	issued_at timestamptz,
	issued_by uuid REFERENCES users (id),
	-- PDF, écrit une fois par la tâche ; jamais servi publiquement ni mis en cache (règle 11).
	pdf_key text,
	pdf_generated_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT owner_statements_version_unique UNIQUE (organization_id, owner_id, month, version),
	CONSTRAINT owner_statements_owner_fk FOREIGN KEY (organization_id, owner_id) REFERENCES owners (organization_id, id),
	CONSTRAINT owner_statements_corrects_fk FOREIGN KEY (organization_id, corrects_statement_id) REFERENCES owner_statements (organization_id, id),
	CONSTRAINT owner_statements_logo_fk FOREIGN KEY (organization_id, logo_id) REFERENCES organization_logos (organization_id, id),
	CONSTRAINT owner_statements_rectification CHECK ((version = 1) = (corrects_statement_id IS NULL)),
	CONSTRAINT owner_statements_totals CHECK (
		collected = rent_collected + charges_collected AND net = collected - commission + expenses + carried_balance
	),
	CONSTRAINT owner_statements_issued CHECK (
		(status = 'issued') = (issued_at IS NOT NULL AND issued_on IS NOT NULL AND issued_by IS NOT NULL)
	),
	CONSTRAINT owner_statements_pdf CHECK ((pdf_key IS NULL) = (pdf_generated_at IS NULL) AND (pdf_key IS NULL OR status = 'issued'))
);
--> statement-breakpoint
CREATE INDEX owner_statements_by_owner ON owner_statements (organization_id, owner_id, month DESC, version DESC);
--> statement-breakpoint
CREATE INDEX owner_statements_issued ON owner_statements (organization_id, issued_on) WHERE status = 'issued';
--> statement-breakpoint
SELECT enable_organization_rls('owner_statements');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON owner_statements FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER owner_statements_no_delete BEFORE DELETE ON owner_statements FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER owner_statements_no_truncate BEFORE TRUNCATE ON owner_statements FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Brouillon recalculé librement ; émission dans l'ordre des mois, sous le verrou du propriétaire ; un relevé émis est
-- figé, sauf son PDF, écrit une fois.
CREATE FUNCTION owner_statements_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	today date := (now() AT TIME ZONE 'Africa/Ouagadougou')::date;
	corrected owner_statements%ROWTYPE;
	last_month text;
	last_version integer;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'draft' OR NEW.issued_at IS NOT NULL OR NEW.pdf_key IS NOT NULL THEN
			RAISE EXCEPTION 'STATEMENT_IMMUTABLE: un relevé naît brouillon' USING ERRCODE = 'P0001';
		END IF;
		IF (SELECT type FROM organizations WHERE id = NEW.organization_id) = 'landlord' THEN
			RAISE EXCEPTION 'STATEMENT_LANDLORD: un bailleur particulier n''a pas de relevé propriétaire' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.corrects_statement_id IS NOT NULL THEN
			SELECT * INTO corrected FROM owner_statements WHERE organization_id = NEW.organization_id AND id = NEW.corrects_statement_id;
			IF corrected.id IS NOT NULL AND (corrected.status <> 'issued' OR corrected.owner_id <> NEW.owner_id
				OR corrected.month <> NEW.month OR NEW.version <> corrected.version + 1) THEN
				RAISE EXCEPTION 'STATEMENT_RECTIFICATION_INVALID: un rectificatif suit la dernière version émise du même mois' USING ERRCODE = 'P0001';
			END IF;
		END IF;
		RETURN NEW;
	END IF;

	IF (NEW.id, NEW.organization_id, NEW.owner_id, NEW.month, NEW.version, NEW.corrects_statement_id, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.owner_id, OLD.month, OLD.version, OLD.corrects_statement_id, OLD.created_at) THEN
		RAISE EXCEPTION 'STATEMENT_IMMUTABLE: un relevé garde son propriétaire, son mois et sa version' USING ERRCODE = 'P0001';
	END IF;
	IF OLD.status = 'issued' THEN
		IF NEW.status <> 'issued' THEN
			RAISE EXCEPTION 'STATEMENT_IMMUTABLE: un relevé émis le reste' USING ERRCODE = 'P0001';
		END IF;
		IF (NEW.revision, NEW.rent_collected, NEW.charges_collected, NEW.collected, NEW.rent_collected_by_owner, NEW.charges_collected_by_owner,
			NEW.commission, NEW.expenses, NEW.carried_balance, NEW.net, NEW.snapshot, NEW.logo_id, NEW.generated_at, NEW.generated_by,
			NEW.issued_on, NEW.issued_at, NEW.issued_by)
			IS DISTINCT FROM (OLD.revision, OLD.rent_collected, OLD.charges_collected, OLD.collected, OLD.rent_collected_by_owner,
			OLD.charges_collected_by_owner, OLD.commission, OLD.expenses, OLD.carried_balance, OLD.net, OLD.snapshot, OLD.logo_id,
			OLD.generated_at, OLD.generated_by, OLD.issued_on, OLD.issued_at, OLD.issued_by) THEN
			RAISE EXCEPTION 'STATEMENT_IMMUTABLE: un relevé émis est figé ; corrigez par un rectificatif' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.pdf_key IS NOT NULL AND (NEW.pdf_key, NEW.pdf_generated_at) IS DISTINCT FROM (OLD.pdf_key, OLD.pdf_generated_at) THEN
			RAISE EXCEPTION 'STATEMENT_IMMUTABLE: le PDF d''un relevé émis ne se remplace pas' USING ERRCODE = 'P0001';
		END IF;
		NEW.updated_at := now();
		RETURN NEW;
	END IF;

	IF NEW.status = 'issued' THEN
		-- Émission : sous le verrou du propriétaire, les relevés de ce propriétaire s'émettent un par un, dans l'ordre.
		PERFORM 1 FROM owners WHERE organization_id = NEW.organization_id AND id = NEW.owner_id FOR UPDATE;
		SELECT month, version INTO last_month, last_version FROM owner_statements
		WHERE organization_id = NEW.organization_id AND owner_id = NEW.owner_id AND status = 'issued'
		ORDER BY month DESC, version DESC LIMIT 1;
		IF NEW.version = 1 THEN
			IF (to_date(NEW.month || '-01', 'YYYY-MM-DD') + interval '1 month')::date > today THEN
				RAISE EXCEPTION 'STATEMENT_PERIOD_NOT_ENDED: le mois n''est pas terminé' USING ERRCODE = 'P0001';
			END IF;
			IF last_month = NEW.month THEN
				RAISE EXCEPTION 'STATEMENT_ALREADY_ISSUED: le relevé de ce mois est déjà émis ; faites un rectificatif' USING ERRCODE = 'P0001';
			END IF;
			IF last_month > NEW.month THEN
				RAISE EXCEPTION 'STATEMENT_OUT_OF_ORDER: un relevé plus récent est déjà émis' USING ERRCODE = 'P0001';
			END IF;
		ELSIF last_month IS DISTINCT FROM NEW.month OR last_version IS DISTINCT FROM NEW.version - 1 THEN
			RAISE EXCEPTION 'STATEMENT_RECTIFICATION_NOT_LATEST: un rectificatif ne vise que le dernier relevé émis' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.issued_by IS NULL THEN
			RAISE EXCEPTION 'STATEMENT_ISSUED_BY: une émission a son auteur' USING ERRCODE = 'P0001';
		END IF;
		NEW.issued_at := now();
		NEW.issued_on := today;
	ELSIF NEW.issued_at IS NOT NULL OR NEW.pdf_key IS NOT NULL THEN
		RAISE EXCEPTION 'STATEMENT_IMMUTABLE: un brouillon n''a ni date d''émission ni PDF' USING ERRCODE = 'P0001';
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER owner_statements_rules BEFORE INSERT OR UPDATE ON owner_statements FOR EACH ROW EXECUTE FUNCTION owner_statements_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- éléments consommés par un relevé émis

CREATE TABLE owner_statement_lines (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	statement_id uuid NOT NULL,
	kind text NOT NULL CHECK (kind IN ('allocation', 'monthly_fee', 'operation_fee', 'expense', 'expense_cancellation', 'carried_balance')),
	-- `line` : figure sur le relevé ; `neutralized` : annulé avec sa contre-écriture avant d'avoir été repris.
	role text NOT NULL CHECK (role IN ('line', 'neutralized')),
	allocation_id uuid,
	expense_id uuid,
	mandate_id uuid,
	fee_month text CHECK (fee_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	lease_id uuid,
	carried_statement_id uuid,
	-- Clé de l'élément, la même que statementItemKey (packages/shared) : un élément n'entre qu'une fois.
	item_key text GENERATED ALWAYS AS (
		CASE kind
			WHEN 'allocation' THEN 'allocation:' || allocation_id::text
			WHEN 'monthly_fee' THEN 'monthly_fee:' || mandate_id::text || ':' || fee_month
			WHEN 'operation_fee' THEN 'operation_fee:' || lease_id::text
			WHEN 'expense' THEN 'expense:' || expense_id::text
			WHEN 'expense_cancellation' THEN 'expense_cancellation:' || expense_id::text
			WHEN 'carried_balance' THEN 'carried_balance:' || carried_statement_id::text
		END
	) STORED,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT owner_statement_lines_once UNIQUE (organization_id, item_key),
	CONSTRAINT owner_statement_lines_statement_fk FOREIGN KEY (organization_id, statement_id) REFERENCES owner_statements (organization_id, id),
	CONSTRAINT owner_statement_lines_allocation_fk FOREIGN KEY (organization_id, allocation_id) REFERENCES payment_allocations (organization_id, id),
	CONSTRAINT owner_statement_lines_expense_fk FOREIGN KEY (organization_id, expense_id) REFERENCES expenses (organization_id, id),
	CONSTRAINT owner_statement_lines_mandate_fk FOREIGN KEY (organization_id, mandate_id) REFERENCES mandates (organization_id, id),
	CONSTRAINT owner_statement_lines_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT owner_statement_lines_carried_fk FOREIGN KEY (organization_id, carried_statement_id) REFERENCES owner_statements (organization_id, id),
	-- Chaque sorte d'élément porte exactement sa référence.
	CONSTRAINT owner_statement_lines_reference CHECK (
		(kind = 'allocation') = (allocation_id IS NOT NULL)
		AND (kind IN ('expense', 'expense_cancellation')) = (expense_id IS NOT NULL)
		AND (kind = 'monthly_fee') = (mandate_id IS NOT NULL AND fee_month IS NOT NULL)
		AND (kind = 'monthly_fee' OR fee_month IS NULL)
		AND (kind = 'operation_fee') = (lease_id IS NOT NULL)
		AND (kind = 'carried_balance') = (carried_statement_id IS NOT NULL)
	),
	CONSTRAINT owner_statement_lines_neutralized CHECK (role = 'line' OR kind IN ('allocation', 'expense', 'expense_cancellation'))
);
--> statement-breakpoint
CREATE INDEX owner_statement_lines_by_statement ON owner_statement_lines (organization_id, statement_id);
--> statement-breakpoint
SELECT enable_organization_rls('owner_statement_lines');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON owner_statement_lines FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER owner_statement_lines_no_update_delete BEFORE UPDATE OR DELETE ON owner_statement_lines
	FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER owner_statement_lines_no_truncate BEFORE TRUNCATE ON owner_statement_lines
	FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Les éléments s'écrivent dans la transaction de l'émission, jamais après ; chacun est du bon genre (imputation sur
-- échéance, dépense avancée pour le propriétaire, solde négatif d'un relevé émis du même propriétaire…).
CREATE FUNCTION owner_statement_lines_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	st owner_statements%ROWTYPE;
	other owner_statements%ROWTYPE;
	e expenses%ROWTYPE;
BEGIN
	SELECT * INTO st FROM owner_statements WHERE organization_id = NEW.organization_id AND id = NEW.statement_id;
	-- Relevé introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
	IF st.id IS NULL THEN
		RETURN NEW;
	END IF;
	IF st.status <> 'issued' OR st.issued_at <> now() THEN
		RAISE EXCEPTION 'STATEMENT_LINES_AT_ISSUE: les éléments d''un relevé s''écrivent à son émission, jamais après' USING ERRCODE = 'P0001';
	END IF;
	-- Référence introuvable (autre organisation, sous la RLS) : la clé composite la refuse ensuite (23503).
	IF NEW.kind = 'allocation' AND EXISTS (
		SELECT FROM payment_allocations WHERE organization_id = NEW.organization_id AND id = NEW.allocation_id AND target <> 'rent_due'
	) THEN
		RAISE EXCEPTION 'STATEMENT_LINE_INVALID: un relevé ne reprend que des imputations sur échéance' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.kind IN ('expense', 'expense_cancellation') THEN
		SELECT * INTO e FROM expenses WHERE organization_id = NEW.organization_id AND id = NEW.expense_id;
		IF e.id IS NOT NULL AND (e.paid_by, e.borne_by, e.recovery) IS DISTINCT FROM ('organization', 'owner', 'owner_statement') THEN
			RAISE EXCEPTION 'STATEMENT_LINE_INVALID: seule une dépense avancée pour le propriétaire entre dans son relevé' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.kind = 'expense_cancellation' AND e.status <> 'cancelled' THEN
			RAISE EXCEPTION 'STATEMENT_LINE_INVALID: la dépense n''est pas annulée' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	IF NEW.kind = 'monthly_fee' AND EXISTS (
		SELECT FROM mandates WHERE organization_id = NEW.organization_id AND id = NEW.mandate_id AND owner_id <> st.owner_id
	) THEN
		RAISE EXCEPTION 'STATEMENT_LINE_INVALID: le mandat n''est pas celui de ce propriétaire' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.kind = 'carried_balance' THEN
		SELECT * INTO other FROM owner_statements WHERE organization_id = NEW.organization_id AND id = NEW.carried_statement_id;
		IF other.id IS NOT NULL AND (other.owner_id <> st.owner_id OR other.status <> 'issued' OR other.net >= 0 OR other.id = st.id) THEN
			RAISE EXCEPTION 'STATEMENT_LINE_INVALID: seul le solde négatif d''un relevé émis du même propriétaire se reporte' USING ERRCODE = 'P0001';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER owner_statement_lines_rules BEFORE INSERT ON owner_statement_lines FOR EACH ROW EXECUTE FUNCTION owner_statement_lines_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- liens /s/<jeton>

CREATE TABLE owner_statement_tokens (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	statement_id uuid NOT NULL,
	-- Empreinte SHA-256 du jeton ; le jeton n'est jamais gardé.
	token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	-- 90 jours (STATEMENT_LINK_TTL_DAYS), jamais plus.
	expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days',
	revoked_at timestamptz,
	revoked_by uuid REFERENCES users (id),
	UNIQUE (organization_id, id),
	CONSTRAINT owner_statement_tokens_statement_fk FOREIGN KEY (organization_id, statement_id) REFERENCES owner_statements (organization_id, id),
	CONSTRAINT owner_statement_tokens_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),
	CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
--> statement-breakpoint
CREATE INDEX owner_statement_tokens_by_statement ON owner_statement_tokens (organization_id, statement_id);
--> statement-breakpoint
SELECT enable_organization_rls('owner_statement_tokens');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON owner_statement_tokens FROM app_api, app_admin;
--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_by) ON owner_statement_tokens TO app_api;
--> statement-breakpoint
CREATE TRIGGER owner_statement_tokens_no_delete BEFORE DELETE ON owner_statement_tokens FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER owner_statement_tokens_no_truncate BEFORE TRUNCATE ON owner_statement_tokens
	FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE FUNCTION owner_statement_tokens_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NOT EXISTS (
			SELECT FROM owner_statements WHERE organization_id = NEW.organization_id AND id = NEW.statement_id AND status = 'issued'
		) AND EXISTS (SELECT FROM owner_statements WHERE organization_id = NEW.organization_id AND id = NEW.statement_id) THEN
			RAISE EXCEPTION 'STATEMENT_NOT_ISSUED: un brouillon ne se partage pas' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.revoked_at IS NOT NULL THEN
			RAISE EXCEPTION 'STATEMENT_TOKEN_REVOKED: un lien naît actif' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF OLD.revoked_at IS NOT NULL THEN
		RAISE EXCEPTION 'STATEMENT_TOKEN_REVOKED: un lien révoqué le reste' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER owner_statement_tokens_rules BEFORE INSERT OR UPDATE ON owner_statement_tokens
	FOR EACH ROW EXECUTE FUNCTION owner_statement_tokens_rules();
--> statement-breakpoint
-- Lien partagé (/s/<jeton>) : pour l'empreinte exacte d'un jeton actif et non expiré, seulement l'organisation et le
-- relevé ; l'API lit ensuite le relevé dans le contexte de cette organisation (sous la RLS), en lecture seule.
-- SECURITY DEFINER : hors de tout contexte d'organisation, par l'empreinte seule.
CREATE FUNCTION statement_share_target(p_hash bytea) RETURNS TABLE (organization_id uuid, statement_id uuid)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT t.organization_id, t.statement_id FROM owner_statement_tokens t
	WHERE t.token_hash = p_hash AND t.revoked_at IS NULL AND t.expires_at > now()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION statement_share_target(bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION statement_share_target(bytea) TO app_api;
--> statement-breakpoint

-- ---------------------------------------------------------------- reversements (règle 5 : enregistrés, jamais exécutés)

CREATE TABLE owner_payouts (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	kind text NOT NULL DEFAULT 'payout' CHECK (kind IN ('payout', 'reversal')),
	-- Contre-écriture : le reversement annulé qu'elle compense.
	reverses_payout_id uuid,
	owner_id uuid NOT NULL,
	statement_id uuid NOT NULL,
	amount bigint NOT NULL CHECK (amount > 0),
	paid_on date NOT NULL,
	method text NOT NULL CHECK (method IN ('cash', 'mobile_money', 'bank_transfer', 'cheque')),
	reference text CHECK (char_length(reference) BETWEEN 1 AND 60),
	note text CHECK (char_length(note) <= 500),
	-- Motif d'une contre-écriture.
	reason text CHECK (char_length(reason) BETWEEN 5 AND 500),
	recorded_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT owner_payouts_owner_fk FOREIGN KEY (organization_id, owner_id) REFERENCES owners (organization_id, id),
	CONSTRAINT owner_payouts_statement_fk FOREIGN KEY (organization_id, statement_id) REFERENCES owner_statements (organization_id, id),
	CONSTRAINT owner_payouts_reverses_fk FOREIGN KEY (organization_id, reverses_payout_id) REFERENCES owner_payouts (organization_id, id),
	CONSTRAINT owner_payouts_reversal CHECK ((kind = 'reversal') = (reverses_payout_id IS NOT NULL) AND (kind = 'reversal') = (reason IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX owner_payouts_by_statement ON owner_payouts (organization_id, statement_id);
--> statement-breakpoint
-- Une seule contre-écriture par reversement.
CREATE UNIQUE INDEX owner_payouts_reversed_once ON owner_payouts (organization_id, reverses_payout_id) WHERE reverses_payout_id IS NOT NULL;
--> statement-breakpoint
SELECT enable_organization_rls('owner_payouts');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON owner_payouts FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER owner_payouts_no_update_delete BEFORE UPDATE OR DELETE ON owner_payouts FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER owner_payouts_no_truncate BEFORE TRUNCATE ON owner_payouts FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Sous le verrou du relevé : relevé émis du même propriétaire, net positif, total reversé jamais au-delà du net ; une
-- contre-écriture compense à l'identique un reversement du même relevé.
CREATE FUNCTION owner_payouts_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	st owner_statements%ROWTYPE;
	original owner_payouts%ROWTYPE;
	paid bigint;
BEGIN
	SELECT * INTO st FROM owner_statements WHERE organization_id = NEW.organization_id AND id = NEW.statement_id FOR UPDATE;
	-- Relevé introuvable (autre organisation, sous la RLS) : la clé composite le refuse ensuite (23503).
	IF st.id IS NULL THEN
		RETURN NEW;
	END IF;
	IF st.owner_id <> NEW.owner_id THEN
		RAISE EXCEPTION 'PAYOUT_OWNER_MISMATCH: le reversement va au propriétaire du relevé' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.kind = 'reversal' THEN
		SELECT * INTO original FROM owner_payouts WHERE organization_id = NEW.organization_id AND id = NEW.reverses_payout_id;
		IF original.id IS NOT NULL AND (original.kind <> 'payout' OR original.statement_id <> NEW.statement_id
			OR original.amount <> NEW.amount) THEN
			RAISE EXCEPTION 'PAYOUT_REVERSAL_INVALID: une contre-écriture compense un reversement à l''identique' USING ERRCODE = 'P0001';
		END IF;
		RETURN NEW;
	END IF;
	IF st.status <> 'issued' THEN
		RAISE EXCEPTION 'STATEMENT_NOT_ISSUED: on ne reverse que sur un relevé émis' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.paid_on > (now() AT TIME ZONE 'Africa/Ouagadougou')::date THEN
		RAISE EXCEPTION 'PAYOUT_DATE_IN_FUTURE: la date du reversement est dans le futur' USING ERRCODE = 'P0001';
	END IF;
	IF st.net <= 0 THEN
		RAISE EXCEPTION 'PAYOUT_NOTHING_DUE: rien à reverser sur ce relevé' USING ERRCODE = 'P0001';
	END IF;
	SELECT coalesce(sum(CASE kind WHEN 'payout' THEN amount ELSE -amount END), 0) INTO paid
	FROM owner_payouts WHERE organization_id = NEW.organization_id AND statement_id = NEW.statement_id;
	IF paid + NEW.amount > st.net THEN
		RAISE EXCEPTION 'PAYOUT_EXCEEDS_NET: le total reversé dépasserait le net du relevé (%)', st.net USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER owner_payouts_rules BEFORE INSERT ON owner_payouts FOR EACH ROW EXECUTE FUNCTION owner_payouts_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)

-- Ni les jetons des liens, ni les clés des PDF : ils restent sur le serveur (colonnes choisies par les streams).
GRANT SELECT ON reminders, reminder_settings, expenses, owner_statements, owner_statement_lines, owner_payouts TO app_sync;
--> statement-breakpoint
CREATE POLICY sync_read ON reminders FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON reminder_settings FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON expenses FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON owner_statements FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON owner_statement_lines FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON owner_payouts FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE reminders, reminder_settings, expenses, owner_statements, owner_statement_lines, owner_payouts;
