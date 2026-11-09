-- Lot 05, étape 3 — envoi des modifications locales (POST /sync/upload).
-- Chaque opération reçue d'un appareil laisse une ligne : sa clé d'idempotence (base locale et numéro de
-- l'opération) et son résultat. Une opération renvoyée deux fois n'est appliquée qu'une fois : la seconde reçoit le
-- premier résultat. Table d'organisation (règle 1), jamais publiée vers PowerSync, en ajout seul.
CREATE TABLE sync_operations (
	organization_id uuid NOT NULL REFERENCES organizations (id),
	idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
	user_id uuid NOT NULL REFERENCES users (id),
	operation text NOT NULL CHECK (operation IN ('PUT', 'PATCH', 'DELETE')),
	table_name text NOT NULL,
	row_id text NOT NULL,
	status text NOT NULL CHECK (status IN ('applied', 'rejected')),
	code text,
	message text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (organization_id, idempotency_key),
	CHECK ((status = 'rejected') = (code IS NOT NULL))
);
--> statement-breakpoint
SELECT enable_organization_rls('sync_operations');
--> statement-breakpoint
-- Ajout seul : un résultat enregistré ne change plus.
REVOKE UPDATE, DELETE, TRUNCATE ON sync_operations FROM app_api, app_admin;
