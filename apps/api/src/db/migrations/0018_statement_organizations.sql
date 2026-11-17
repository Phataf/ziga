-- Lot 10 — tâche mensuelle des relevés : organisations (agences non suspendues) qui ont un mandat pouvant donner lieu
-- à un relevé propriétaire. Seulement des identifiants ; la tâche ouvre ensuite chaque organisation dans son propre
-- contexte (withOrganization), sous la RLS. Même modèle que due_lease_organizations (lot 08).
CREATE FUNCTION statement_organizations() RETURNS SETOF uuid
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT DISTINCT m.organization_id FROM mandates m
	JOIN organizations o ON o.id = m.organization_id
	WHERE o.type = 'agency' AND o.verification_status <> 'suspended'
		AND m.type IN ('rental_management', 'letting', 'other')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION statement_organizations() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION statement_organizations() TO app_api;
