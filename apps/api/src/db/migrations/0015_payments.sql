-- Lot 09 — encaissements, imputations et reçus (module payments). Règles 1, 2, 3, 4, 6, 9 et 14 de CLAUDE.md ; D18,
-- D29. Les règles pures sont dans packages/shared (payments.ts, allocation.ts, receipts.ts) ; la base applique les
-- mêmes, en dernier rempart.
--
-- - payments : un encaissement (loyer ou caution, un seul objet) ; sa contre-écriture (`reversal`) quand il est annulé.
--   Ajout seul : jamais supprimé, montant jamais modifié ; seuls le statut (machine d'états de packages/shared) et les
--   champs de validation et d'annulation changent, une fois chacun (règle 3). Doublon Mobile Money refusé : même
--   opérateur, même référence normalisée, hors paiements annulés (index unique partiel).
-- - payment_allocations : imputations en ajout seul, montants positifs, sens `allocate` ou `reverse`. Elles tiennent
--   `rent_dues.amount_paid` (somme nette, jamais saisie) et créent les mouvements de caution (`received`, et
--   `received_cancelled` pour la contre-écriture). À la validation de la transaction : un encaissement confirmé impute
--   exactement son montant, un encaissement en attente ou annulé n'impute rien (trigger différé).
-- - receipts : un reçu par encaissement ; numéro attribué par la base à la validation (`provisional` → `valid`),
--   continu, sans trou ni doublon, par organisation et par année (règle 9), sous le verrou de l'organisation ; copie
--   figée des données à l'émission (D29).
-- - receipt_counters : compteur par organisation et par année ; premier numéro fixé une seule fois, avant le premier
--   reçu (fonction set_receipt_first_number).
-- - receipt_tokens : empreintes SHA-256 des jetons de vérification et de partage ; le jeton lui-même n'est jamais
--   gardé (réponse du porteur). Lecture publique par deux fonctions qui ne renvoient que le strict nécessaire.
-- - organizations : préfixe des reçus (figé après le premier reçu, sauf back-office), largeur du ticket.
-- - deposit_movements : `received_cancelled`, clé composite vers payments.

-- ---------------------------------------------------------------- réglages de l'organisation

ALTER TABLE organizations
	ADD COLUMN receipt_prefix text CHECK (receipt_prefix ~ '^[A-Z]{2,6}$'),
	ADD COLUMN receipt_ticket_width integer NOT NULL DEFAULT 80 CHECK (receipt_ticket_width IN (58, 80)),
	-- Premier reçu numéroté : posée par la base (numérotation) ; fige le préfixe et le premier numéro.
	ADD COLUMN receipt_numbering_started_at timestamptz;
--> statement-breakpoint
-- Préfixe figé après le premier reçu : seul le back-office (app_admin) le change ensuite, avec motif et audit écrits
-- par l'API. La date du premier reçu ne s'efface jamais.
CREATE FUNCTION organizations_receipt_settings_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF OLD.receipt_numbering_started_at IS NOT NULL AND NEW.receipt_numbering_started_at IS DISTINCT FROM OLD.receipt_numbering_started_at THEN
		RAISE EXCEPTION 'RECEIPT_NUMBERING_STARTED: la date du premier reçu ne change pas' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.receipt_prefix IS DISTINCT FROM OLD.receipt_prefix AND OLD.receipt_numbering_started_at IS NOT NULL
		AND current_user <> 'app_admin' THEN
		RAISE EXCEPTION 'RECEIPT_PREFIX_LOCKED: le préfixe des reçus est figé après le premier reçu' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.receipt_prefix IS NULL AND OLD.receipt_prefix IS NOT NULL THEN
		RAISE EXCEPTION 'RECEIPT_PREFIX_REQUIRED: un préfixe ne s''efface pas' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organizations_receipt_settings BEFORE UPDATE OF receipt_prefix, receipt_numbering_started_at ON organizations
	FOR EACH ROW EXECUTE FUNCTION organizations_receipt_settings_rules();
--> statement-breakpoint
-- Changement exceptionnel du préfixe par le back-office (motif et audit écrits par l'API) : cette colonne seulement.
GRANT UPDATE (receipt_prefix) ON organizations TO app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- encaissements

CREATE TABLE payments (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	kind text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'reversal')),
	-- Contre-écriture : l'encaissement annulé qu'elle compense.
	reverses_payment_id uuid,
	lease_id uuid NOT NULL,
	-- Locataire du bail, recopié par la base (jamais pris de l'appareil).
	tenant_id uuid NOT NULL,
	purpose text NOT NULL CHECK (purpose IN ('rent', 'deposit')),
	deposit_account_id uuid,
	-- FCFA entiers, strictement positifs ; une contre-écriture est une ligne à part, pas un montant négatif (règle 2).
	amount bigint NOT NULL CHECK (amount > 0),
	method text NOT NULL CHECK (method IN ('cash', 'mobile_money_manual', 'bank_transfer', 'mobile_money_direct')),
	operator text CHECK (operator IN ('orange_money', 'moov_money', 'other')),
	transaction_reference text CHECK (char_length(transaction_reference) BETWEEN 1 AND 60),
	-- Référence normalisée (packages/shared, normalizeTransactionReference) : majuscules, sans espaces ni séparateurs.
	reference_key text GENERATED ALWAYS AS (
		upper(regexp_replace(normalize(transaction_reference, NFKC), '[[:space:]._/-]+', '', 'g'))
	) STORED,
	paid_on date NOT NULL,
	status text NOT NULL CHECK (status IN ('to_validate', 'to_reconcile', 'confirmed', 'initiated', 'pending', 'failed', 'cancelled')),
	-- `manual` pour le registre ; la clé d'un agrégateur au lot 14.
	provider text NOT NULL DEFAULT 'manual' CHECK (char_length(provider) BETWEEN 1 AND 40),
	provider_reference text CHECK (char_length(provider_reference) BETWEEN 1 AND 200),
	-- Une écriture rejouée (synchronisation, route) ne crée jamais de doublon.
	idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
	note text CHECK (char_length(note) <= 500),
	recorded_by uuid REFERENCES users (id),
	confirmed_at timestamptz,
	confirmed_by uuid REFERENCES users (id),
	cancellation_reason text CHECK (char_length(cancellation_reason) BETWEEN 5 AND 500),
	cancelled_at timestamptz,
	cancelled_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT payments_idempotency UNIQUE (organization_id, idempotency_key),
	CONSTRAINT payments_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT payments_tenant_fk FOREIGN KEY (organization_id, tenant_id) REFERENCES tenants (organization_id, id),
	CONSTRAINT payments_deposit_account_fk FOREIGN KEY (organization_id, deposit_account_id) REFERENCES deposit_accounts (organization_id, id),
	CONSTRAINT payments_reverses_fk FOREIGN KEY (organization_id, reverses_payment_id) REFERENCES payments (organization_id, id),
	CONSTRAINT payments_purpose CHECK ((purpose = 'deposit') = (deposit_account_id IS NOT NULL)),
	CONSTRAINT payments_mobile_money CHECK (
		method NOT IN ('mobile_money_manual', 'mobile_money_direct') OR (operator IS NOT NULL AND transaction_reference IS NOT NULL)
	),
	CONSTRAINT payments_operator CHECK (method IN ('mobile_money_manual', 'mobile_money_direct') OR operator IS NULL),
	CONSTRAINT payments_cash_reference CHECK (method <> 'cash' OR transaction_reference IS NULL),
	CONSTRAINT payments_reversal CHECK ((kind = 'reversal') = (reverses_payment_id IS NOT NULL)),
	CONSTRAINT payments_reversal_status CHECK (kind = 'payment' OR status = 'confirmed'),
	CONSTRAINT payments_confirmed CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL),
	CONSTRAINT payments_cancelled CHECK (
		(status = 'cancelled') = (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND cancelled_by IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE INDEX payments_by_lease ON payments (organization_id, lease_id);
--> statement-breakpoint
CREATE INDEX payments_awaiting ON payments (organization_id, status) WHERE status IN ('to_validate', 'to_reconcile');
--> statement-breakpoint
-- Une seule contre-écriture par encaissement annulé.
CREATE UNIQUE INDEX payments_reversed_once ON payments (organization_id, reverses_payment_id) WHERE reverses_payment_id IS NOT NULL;
--> statement-breakpoint
-- Point b du porteur : une même référence chez le même opérateur ne se saisit pas deux fois dans une organisation,
-- sauf si le paiement précédent est annulé.
CREATE UNIQUE INDEX payments_mobile_money_reference ON payments (organization_id, operator, reference_key)
	WHERE kind = 'payment' AND method = 'mobile_money_manual' AND status <> 'cancelled';
--> statement-breakpoint
SELECT enable_organization_rls('payments');
--> statement-breakpoint
-- Règle 3 : jamais supprimé ; seules les colonnes du cycle se modifient, et la base en contrôle chaque transition.
REVOKE UPDATE, DELETE, TRUNCATE ON payments FROM app_api, app_admin;
--> statement-breakpoint
GRANT UPDATE (status, provider_reference, confirmed_at, confirmed_by, cancellation_reason, cancelled_at, cancelled_by, updated_at)
	ON payments TO app_api;
--> statement-breakpoint
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Machine d'états (packages/shared, PAYMENT_TRANSITIONS ; comparée par un test).
CREATE FUNCTION payment_transition_allowed(from_status text, to_status text) RETURNS boolean
	LANGUAGE sql IMMUTABLE
AS $$
	SELECT (from_status, to_status) IN (
		('to_validate', 'confirmed'), ('to_validate', 'cancelled'),
		('to_reconcile', 'confirmed'), ('to_reconcile', 'cancelled'),
		('confirmed', 'cancelled'),
		('initiated', 'pending'), ('initiated', 'confirmed'), ('initiated', 'failed'),
		('pending', 'confirmed'), ('pending', 'failed')
	)
$$;
--> statement-breakpoint
CREATE FUNCTION payments_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease leases%ROWTYPE;
	account_lease uuid;
	original payments%ROWTYPE;
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
				OR original.deposit_account_id IS DISTINCT FROM NEW.deposit_account_id OR original.amount <> NEW.amount
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
		NEW.deposit_account_id, NEW.method, NEW.operator, NEW.transaction_reference, NEW.paid_on, NEW.provider,
		NEW.idempotency_key, NEW.note, NEW.recorded_by, NEW.created_at)
		IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.kind, OLD.reverses_payment_id, OLD.lease_id, OLD.tenant_id, OLD.purpose,
		OLD.deposit_account_id, OLD.method, OLD.operator, OLD.transaction_reference, OLD.paid_on, OLD.provider,
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
CREATE TRIGGER payments_rules BEFORE INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payments_rules();
--> statement-breakpoint

-- ---------------------------------------------------------------- imputations

CREATE TABLE payment_allocations (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	payment_id uuid NOT NULL,
	lease_id uuid NOT NULL,
	target text NOT NULL CHECK (target IN ('rent_due', 'deposit_account', 'credit')),
	rent_due_id uuid,
	deposit_account_id uuid,
	direction text NOT NULL CHECK (direction IN ('allocate', 'reverse')),
	amount bigint NOT NULL CHECK (amount > 0),
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT payment_allocations_payment_fk FOREIGN KEY (organization_id, payment_id) REFERENCES payments (organization_id, id),
	CONSTRAINT payment_allocations_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT payment_allocations_due_fk FOREIGN KEY (organization_id, rent_due_id) REFERENCES rent_dues (organization_id, id),
	CONSTRAINT payment_allocations_account_fk FOREIGN KEY (organization_id, deposit_account_id) REFERENCES deposit_accounts (organization_id, id),
	CONSTRAINT payment_allocations_target CHECK (
		(target = 'rent_due') = (rent_due_id IS NOT NULL) AND (target = 'deposit_account') = (deposit_account_id IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE INDEX payment_allocations_by_payment ON payment_allocations (organization_id, payment_id);
--> statement-breakpoint
CREATE INDEX payment_allocations_by_due ON payment_allocations (organization_id, rent_due_id) WHERE rent_due_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX payment_allocations_by_lease ON payment_allocations (organization_id, lease_id);
--> statement-breakpoint
SELECT enable_organization_rls('payment_allocations');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON payment_allocations FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_no_update_delete BEFORE UPDATE OR DELETE ON payment_allocations
	FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER payment_allocations_no_truncate BEFORE TRUNCATE ON payment_allocations
	FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Avant chaque imputation, sous le verrou de l'encaissement : même bail, bon objet ; une imputation naît d'un
-- encaissement confirmé ; une ligne inverse, d'un encaissement confirmé (crédit imputé) ou annulé (contre-écriture) ;
-- jamais sur une échéance abandonnée.
CREATE FUNCTION payment_allocations_rules() RETURNS trigger
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
		RAISE EXCEPTION 'ALLOCATION_PURPOSE: un versement de caution s''impute sur son compte de caution' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.target = 'deposit_account' AND (p.purpose <> 'deposit' OR p.deposit_account_id <> NEW.deposit_account_id) THEN
		RAISE EXCEPTION 'ALLOCATION_PURPOSE: un encaissement de loyer ne s''impute pas sur une caution' USING ERRCODE = 'P0001';
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
CREATE TRIGGER payment_allocations_rules BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION payment_allocations_rules();
--> statement-breakpoint
-- Après chaque imputation : montant payé de l'échéance recalculé (somme nette, plafonnée par sa contrainte), mouvement
-- de caution créé, aucun solde négatif par cible et par encaissement. SECURITY DEFINER (uuid_v7, mouvements) : chaque
-- requête filtre explicitement sur l'organisation de la ligne.
CREATE FUNCTION payment_allocations_apply() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	net bigint;
	paid_on date;
BEGIN
	SELECT coalesce(sum(CASE direction WHEN 'allocate' THEN amount ELSE -amount END), 0) INTO net
	FROM payment_allocations
	WHERE organization_id = NEW.organization_id AND payment_id = NEW.payment_id AND target = NEW.target
		AND rent_due_id IS NOT DISTINCT FROM NEW.rent_due_id AND deposit_account_id IS NOT DISTINCT FROM NEW.deposit_account_id;
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
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION payment_allocations_apply() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_apply AFTER INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION payment_allocations_apply();
--> statement-breakpoint
-- À la validation de la transaction : un encaissement confirmé impute exactement son montant ; en attente, échoué ou
-- annulé, rien (somme nette nulle). Invariant du test de propriété de packages/shared (allocation.ts).
CREATE FUNCTION payments_allocation_balance() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	p payments%ROWTYPE;
	net bigint;
BEGIN
	IF TG_TABLE_NAME = 'payments' THEN
		SELECT * INTO p FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.id;
	ELSE
		SELECT * INTO p FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.payment_id;
	END IF;
	IF p.id IS NULL OR p.kind <> 'payment' THEN
		RETURN NULL;
	END IF;
	SELECT coalesce(sum(CASE direction WHEN 'allocate' THEN amount ELSE -amount END), 0) INTO net
	FROM payment_allocations WHERE organization_id = p.organization_id AND payment_id = p.id;
	IF (p.status = 'confirmed' AND net <> p.amount) OR (p.status <> 'confirmed' AND net <> 0) THEN
		RAISE EXCEPTION 'PAYMENT_ALLOCATION_MISMATCH: l''encaissement % (%) impute % FCFA sur %', p.id, p.status, net, p.amount
			USING ERRCODE = 'P0001';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payments_allocation_balance AFTER INSERT OR UPDATE OF status ON payments
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments_allocation_balance();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_allocations_balance AFTER INSERT ON payment_allocations
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments_allocation_balance();
--> statement-breakpoint

-- ---------------------------------------------------------------- échéances : montant payé tenu par les imputations

ALTER TABLE rent_dues ADD CONSTRAINT rent_dues_paid_within_due CHECK (amount_paid <= amount_due);
--> statement-breakpoint
-- Règles du lot 08, plus : le montant payé est la somme nette des imputations, jamais une saisie.
CREATE OR REPLACE FUNCTION rent_dues_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	lease_status text;
	allocated bigint;
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

-- ---------------------------------------------------------------- caution : contre-écriture d'un versement

ALTER TABLE deposit_movements DROP CONSTRAINT deposit_movements_type_check;
--> statement-breakpoint
ALTER TABLE deposit_movements ADD CONSTRAINT deposit_movements_type_check CHECK (
	type IN ('received', 'received_cancelled', 'retained', 'applied_to_rent', 'refunded', 'additional_claimed', 'holder_changed')
);
--> statement-breakpoint
ALTER TABLE deposit_movements ADD CONSTRAINT deposit_movements_payment_fk
	FOREIGN KEY (organization_id, payment_id) REFERENCES payments (organization_id, id);
--> statement-breakpoint
-- La contre-écriture d'un versement vient toujours de l'annulation de son encaissement.
ALTER TABLE deposit_movements ADD CONSTRAINT deposit_movements_cancelled_payment CHECK (type <> 'received_cancelled' OR payment_id IS NOT NULL);
--> statement-breakpoint
-- Règles du lot 08, plus : le reçu net retire les versements annulés ; annuler un versement ne fait jamais passer le
-- reçu sous les sorties déjà faites (règle 14, réponse du porteur) et ne retire que ce que cet encaissement a versé.
CREATE OR REPLACE FUNCTION deposit_movements_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
DECLARE
	account deposit_accounts%ROWTYPE;
	received bigint;
	outflows bigint;
	paid_by_payment bigint;
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
		coalesce(sum(amount) FILTER (WHERE type IN ('retained', 'applied_to_rent', 'refunded')), 0)
	INTO received, outflows
	FROM deposit_movements WHERE organization_id = NEW.organization_id AND account_id = NEW.account_id;
	IF NEW.type = 'received' AND received + NEW.amount > account.agreed_amount THEN
		RAISE EXCEPTION 'DEPOSIT_OVERPAID: versement au-delà du montant convenu' USING ERRCODE = 'P0001';
	END IF;
	IF NEW.type IN ('retained', 'applied_to_rent', 'refunded') AND outflows + NEW.amount > received THEN
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
	RETURN NEW;
END;
$$;
--> statement-breakpoint
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
CREATE OR REPLACE FUNCTION deposit_accounts_refresh_status() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	received bigint;
BEGIN
	SELECT coalesce(sum(amount) FILTER (WHERE type = 'received'), 0) - coalesce(sum(amount) FILTER (WHERE type = 'received_cancelled'), 0)
	INTO received FROM deposit_movements
	WHERE organization_id = NEW.organization_id AND account_id = NEW.id;
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

-- ---------------------------------------------------------------- reçus

CREATE TABLE receipts (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	payment_id uuid NOT NULL,
	-- Recopiés de l'encaissement par la base (streams de l'agent de terrain : ses baux, jamais une caution).
	lease_id uuid NOT NULL,
	purpose text NOT NULL CHECK (purpose IN ('rent', 'deposit')),
	-- Numéro affiché par l'appareil jusqu'à la synchronisation ; jamais unique ni continu.
	provisional_number text NOT NULL CHECK (provisional_number ~ '^PROV-[0-9A-F]{6}$'),
	-- Attribués par la base à la validation (règle 9) ; jamais envoyés par l'appareil.
	number text,
	year integer CHECK (year BETWEEN 2000 AND 9999),
	sequence bigint CHECK (sequence >= 1),
	status text NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional', 'valid', 'cancelled')),
	issued_on date,
	issued_at timestamptz,
	-- Copie figée à l'émission (D29) : organisation, locataire, unité, objet, solde, personne qui a encaissé.
	snapshot jsonb,
	logo_id uuid,
	-- PDF (A6 et ticket) ; régénérés avec « ANNULÉ » à l'annulation, jamais écrasés dans le stockage.
	pdf_a6_key text,
	pdf_ticket_key text,
	pdf_generated_at timestamptz,
	cancelled_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id),
	CONSTRAINT receipts_one_per_payment UNIQUE (organization_id, payment_id),
	CONSTRAINT receipts_number_unique UNIQUE (organization_id, number),
	CONSTRAINT receipts_sequence_unique UNIQUE (organization_id, year, sequence),
	CONSTRAINT receipts_payment_fk FOREIGN KEY (organization_id, payment_id) REFERENCES payments (organization_id, id),
	CONSTRAINT receipts_lease_fk FOREIGN KEY (organization_id, lease_id) REFERENCES leases (organization_id, id),
	CONSTRAINT receipts_logo_fk FOREIGN KEY (organization_id, logo_id) REFERENCES organization_logos (organization_id, id),
	CONSTRAINT receipts_numbered CHECK (
		(number IS NULL) = (year IS NULL) AND (number IS NULL) = (sequence IS NULL) AND (number IS NULL) = (issued_on IS NULL)
		AND (number IS NULL) = (snapshot IS NULL) AND (number IS NULL) = (issued_at IS NULL)
	),
	CONSTRAINT receipts_status_number CHECK ((status <> 'valid' OR number IS NOT NULL) AND (status <> 'provisional' OR number IS NULL)),
	CONSTRAINT receipts_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX receipts_by_lease ON receipts (organization_id, lease_id);
--> statement-breakpoint
SELECT enable_organization_rls('receipts');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON receipts FROM app_api, app_admin;
--> statement-breakpoint
GRANT UPDATE (status, issued_on, issued_at, snapshot, logo_id, pdf_a6_key, pdf_ticket_key, pdf_generated_at, cancelled_at, updated_at)
	ON receipts TO app_api;
--> statement-breakpoint
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON receipts FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TABLE receipt_counters (
	organization_id uuid NOT NULL REFERENCES organizations (id),
	year integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
	next_sequence bigint NOT NULL CHECK (next_sequence >= 1),
	-- Premier numéro fixé par le directeur (carnet papier) : une seule fois, avant le premier reçu.
	first_number bigint CHECK (first_number >= 1),
	first_number_set_by uuid REFERENCES users (id),
	first_number_set_at timestamptz,
	PRIMARY KEY (organization_id, year),
	CHECK ((first_number IS NULL) = (first_number_set_at IS NULL))
);
--> statement-breakpoint
SELECT enable_organization_rls('receipt_counters');
--> statement-breakpoint
-- Écrit par la base seule (numérotation et set_receipt_first_number) : l'application ne fait que lire.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON receipt_counters FROM app_api, app_admin;
--> statement-breakpoint
CREATE TRIGGER receipt_counters_no_delete BEFORE DELETE ON receipt_counters FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER receipt_counters_no_truncate BEFORE TRUNCATE ON receipt_counters FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Numérotation et cycle du reçu. SECURITY DEFINER (compteur et organisation écrits par la base seule) : chaque requête
-- filtre explicitement sur l'organisation du reçu. Le verrou de l'organisation sérialise les numérotations : la suite
-- est continue, sans trou ni doublon, par organisation et par année, même sous 1 000 confirmations concurrentes ; un
-- retour arrière rend le numéro (le compteur est dans la même transaction).
CREATE FUNCTION receipts_rules() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	p payments%ROWTYPE;
	prefix text;
	seq bigint;
	y integer;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT * INTO p FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.payment_id;
		IF p.id IS NULL THEN
			RAISE EXCEPTION 'RECEIPT_PAYMENT_NOT_FOUND: encaissement introuvable' USING ERRCODE = '23503';
		END IF;
		IF p.kind <> 'payment' THEN
			RAISE EXCEPTION 'RECEIPT_ON_REVERSAL: une contre-écriture n''a pas de reçu' USING ERRCODE = 'P0001';
		END IF;
		NEW.lease_id := p.lease_id;
		NEW.purpose := p.purpose;
		IF NEW.number IS NOT NULL OR NEW.year IS NOT NULL OR NEW.sequence IS NOT NULL OR NEW.cancelled_at IS NOT NULL
			OR NEW.status = 'cancelled' THEN
			RAISE EXCEPTION 'RECEIPT_NUMBER_BY_SERVER: un reçu naît provisoire ou valide ; son numéro vient de la base' USING ERRCODE = 'P0001';
		END IF;
	ELSE
		SELECT * INTO p FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.payment_id;
		IF (NEW.id, NEW.organization_id, NEW.payment_id, NEW.lease_id, NEW.purpose, NEW.provisional_number, NEW.created_at)
			IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.payment_id, OLD.lease_id, OLD.purpose, OLD.provisional_number, OLD.created_at) THEN
			RAISE EXCEPTION 'RECEIPT_IMMUTABLE: un reçu reste attaché à son encaissement' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
			(OLD.status = 'provisional' AND NEW.status IN ('valid', 'cancelled')) OR (OLD.status = 'valid' AND NEW.status = 'cancelled')
		) THEN
			RAISE EXCEPTION 'RECEIPT_TRANSITION_FORBIDDEN: transition % → % refusée', OLD.status, NEW.status USING ERRCODE = 'P0001';
		END IF;
		-- Émis : numéro, date, copie et logo figés (D29).
		IF OLD.number IS NOT NULL AND (NEW.number, NEW.year, NEW.sequence, NEW.issued_on, NEW.issued_at, NEW.snapshot, NEW.logo_id)
			IS DISTINCT FROM (OLD.number, OLD.year, OLD.sequence, OLD.issued_on, OLD.issued_at, OLD.snapshot, OLD.logo_id) THEN
			RAISE EXCEPTION 'RECEIPT_IMMUTABLE: un reçu émis ne change plus' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.number IS NULL AND NEW.status <> 'valid' AND (NEW.number, NEW.year, NEW.sequence) IS DISTINCT FROM (OLD.number, OLD.year, OLD.sequence) THEN
			RAISE EXCEPTION 'RECEIPT_NUMBER_BY_SERVER: le numéro vient de la base, à la validation' USING ERRCODE = 'P0001';
		END IF;
		IF OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
			RAISE EXCEPTION 'RECEIPT_IMMUTABLE: l''annulation ne se réécrit pas' USING ERRCODE = 'P0001';
		END IF;
		IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' AND p.status <> 'cancelled' THEN
			RAISE EXCEPTION 'RECEIPT_CANCELLED_WITH_PAYMENT: un reçu s''annule avec son encaissement' USING ERRCODE = 'P0001';
		END IF;
	END IF;

	-- Validation : l'encaissement est confirmé ; le numéro est attribué ici, jamais ailleurs.
	IF NEW.status = 'valid' AND (TG_OP = 'INSERT' OR OLD.status = 'provisional') THEN
		IF p.status <> 'confirmed' THEN
			RAISE EXCEPTION 'RECEIPT_PAYMENT_NOT_CONFIRMED: un reçu n''est numéroté qu''à la confirmation de son encaissement'
				USING ERRCODE = 'P0001';
		END IF;
		IF NEW.issued_on IS NULL OR NEW.snapshot IS NULL THEN
			RAISE EXCEPTION 'RECEIPT_SNAPSHOT_REQUIRED: un reçu émis porte sa date et sa copie figée' USING ERRCODE = 'P0001';
		END IF;
		SELECT receipt_prefix INTO prefix FROM organizations WHERE id = NEW.organization_id FOR NO KEY UPDATE;
		IF prefix IS NULL THEN
			RAISE EXCEPTION 'RECEIPT_PREFIX_MISSING: le préfixe des reçus n''est pas réglé' USING ERRCODE = 'P0001';
		END IF;
		y := extract(year FROM NEW.issued_on)::integer;
		INSERT INTO receipt_counters (organization_id, year, next_sequence) VALUES (NEW.organization_id, y, 1)
			ON CONFLICT (organization_id, year) DO NOTHING;
		SELECT next_sequence INTO seq FROM receipt_counters WHERE organization_id = NEW.organization_id AND year = y FOR UPDATE;
		UPDATE receipt_counters SET next_sequence = seq + 1 WHERE organization_id = NEW.organization_id AND year = y;
		UPDATE organizations SET receipt_numbering_started_at = coalesce(receipt_numbering_started_at, now())
			WHERE id = NEW.organization_id AND receipt_numbering_started_at IS NULL;
		NEW.year := y;
		NEW.sequence := seq;
		NEW.number := prefix || '-' || y::text || '-' || lpad(seq::text, greatest(6, length(seq::text)), '0');
		NEW.issued_at := coalesce(NEW.issued_at, now());
	END IF;
	IF TG_OP = 'UPDATE' THEN
		NEW.updated_at := now();
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION receipts_rules() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER receipts_rules BEFORE INSERT OR UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION receipts_rules();
--> statement-breakpoint
-- Premier numéro de l'année en cours, pour continuer un carnet papier (réponse du porteur) : une seule fois, avant le
-- premier reçu. Dans le contexte de l'organisation ; l'audit est écrit par l'API.
CREATE FUNCTION set_receipt_first_number(p_year integer, p_first bigint, p_user uuid) RETURNS void
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
DECLARE
	org uuid := current_organization_id();
	started timestamptz;
BEGIN
	IF org IS NULL THEN
		RAISE EXCEPTION 'ORGANIZATION_CONTEXT_REQUIRED: hors du contexte d''une organisation' USING ERRCODE = 'P0001';
	END IF;
	IF p_first IS NULL OR p_first < 1 THEN
		RAISE EXCEPTION 'RECEIPT_FIRST_NUMBER_INVALID: le premier numéro vaut 1 au moins' USING ERRCODE = 'P0001';
	END IF;
	SELECT receipt_numbering_started_at INTO started FROM organizations WHERE id = org FOR NO KEY UPDATE;
	IF started IS NOT NULL THEN
		RAISE EXCEPTION 'RECEIPT_FIRST_NUMBER_LOCKED: un reçu a déjà été émis' USING ERRCODE = 'P0001';
	END IF;
	IF EXISTS (SELECT FROM receipt_counters WHERE organization_id = org AND first_number_set_at IS NOT NULL) THEN
		RAISE EXCEPTION 'RECEIPT_FIRST_NUMBER_ALREADY_SET: le premier numéro se fixe une seule fois' USING ERRCODE = 'P0001';
	END IF;
	INSERT INTO receipt_counters (organization_id, year, next_sequence, first_number, first_number_set_by, first_number_set_at)
	VALUES (org, p_year, p_first, p_first, p_user, now())
	ON CONFLICT (organization_id, year) DO UPDATE
		SET next_sequence = EXCLUDED.next_sequence, first_number = EXCLUDED.first_number,
			first_number_set_by = EXCLUDED.first_number_set_by, first_number_set_at = EXCLUDED.first_number_set_at;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION set_receipt_first_number(integer, bigint, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_receipt_first_number(integer, bigint, uuid) TO app_api;
--> statement-breakpoint

-- ---------------------------------------------------------------- jetons des reçus

CREATE TABLE receipt_tokens (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations (id),
	receipt_id uuid NOT NULL,
	-- `verification` : QR code, page /r/<jeton> minimale ; `share` : lien WhatsApp, page /recu/<jeton>, révocable.
	kind text NOT NULL CHECK (kind IN ('verification', 'share')),
	-- Empreinte SHA-256 du jeton ; le jeton n'est jamais gardé (réponse du porteur).
	token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	created_by uuid REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz,
	revoked_by uuid REFERENCES users (id),
	UNIQUE (organization_id, id),
	CONSTRAINT receipt_tokens_receipt_fk FOREIGN KEY (organization_id, receipt_id) REFERENCES receipts (organization_id, id),
	-- Un jeton de vérification ne se révoque pas : il est imprimé sur le reçu.
	CONSTRAINT receipt_tokens_revocable CHECK (revoked_at IS NULL OR kind = 'share'),
	CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
--> statement-breakpoint
CREATE INDEX receipt_tokens_by_receipt ON receipt_tokens (organization_id, receipt_id);
--> statement-breakpoint
SELECT enable_organization_rls('receipt_tokens');
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON receipt_tokens FROM app_api, app_admin;
--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_by) ON receipt_tokens TO app_api;
--> statement-breakpoint
CREATE TRIGGER receipt_tokens_no_delete BEFORE DELETE ON receipt_tokens FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER receipt_tokens_no_truncate BEFORE TRUNCATE ON receipt_tokens FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE FUNCTION receipt_tokens_rules() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF OLD.revoked_at IS NOT NULL THEN
		RAISE EXCEPTION 'RECEIPT_TOKEN_REVOKED: un jeton révoqué le reste' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER receipt_tokens_rules BEFORE UPDATE ON receipt_tokens FOR EACH ROW EXECUTE FUNCTION receipt_tokens_rules();
--> statement-breakpoint
-- Page publique de vérification (/r/<jeton>) : pour l'empreinte exacte d'un jeton de vérification, seulement
-- l'organisation (nom figé à l'émission, D29), le numéro, la date, le montant et le statut ; aucune autre donnée.
-- SECURITY DEFINER : hors de tout contexte d'organisation, par l'empreinte seule.
CREATE FUNCTION receipt_verification(p_hash bytea)
	RETURNS TABLE (organization_name text, number text, issued_on date, amount bigint, status text)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT coalesce(r.snapshot -> 'organization' ->> 'name', coalesce(o.trade_name, o.legal_name)), r.number, r.issued_on, p.amount, r.status
	FROM receipt_tokens t
	JOIN receipts r ON r.organization_id = t.organization_id AND r.id = t.receipt_id
	JOIN payments p ON p.organization_id = r.organization_id AND p.id = r.payment_id
	JOIN organizations o ON o.id = r.organization_id
	WHERE t.token_hash = p_hash AND t.kind = 'verification'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION receipt_verification(bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION receipt_verification(bytea) TO app_api;
--> statement-breakpoint
-- Lien partagé (/recu/<jeton>) : seulement l'organisation et le reçu d'un jeton de partage non révoqué ; l'API lit
-- ensuite le reçu dans le contexte de cette organisation (sous la RLS), en lecture seule.
CREATE FUNCTION receipt_share_target(p_hash bytea) RETURNS TABLE (organization_id uuid, receipt_id uuid)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT t.organization_id, t.receipt_id FROM receipt_tokens t
	WHERE t.token_hash = p_hash AND t.kind = 'share' AND t.revoked_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION receipt_share_target(bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION receipt_share_target(bytea) TO app_api;
--> statement-breakpoint

-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)

-- Ni les jetons, ni les compteurs, ni les clés des PDF : ils restent sur le serveur.
GRANT SELECT ON payments, payment_allocations, receipts TO app_sync;
--> statement-breakpoint
CREATE POLICY sync_read ON payments FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON payment_allocations FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON receipts FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE payments, payment_allocations, receipts;
