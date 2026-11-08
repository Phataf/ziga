-- Lot 01 — socle de la base.
-- Rôles applicatifs et fonction d'isolement par organisation (CLAUDE.md règle 1, D12).
-- Les mots de passe ne sont jamais écrits ici : `pnpm db:migrate` les fixe à partir de l'environnement.

DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_api') THEN
		CREATE ROLE app_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
	END IF;
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_admin') THEN
		CREATE ROLE app_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
	END IF;
END
$$;
--> statement-breakpoint
-- Les rôles existaient peut-être déjà (base recréée) : on réaffirme qu'aucun ne contourne RLS.
ALTER ROLE app_api NOSUPERUSER NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE app_admin NOSUPERUSER NOBYPASSRLS;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_api, app_admin;
--> statement-breakpoint
-- Les tables créées par les prochaines migrations seront lisibles et modifiables par les rôles applicatifs ;
-- la RLS de chaque table métier décide ensuite des lignes visibles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api, app_admin;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_api, app_admin;
--> statement-breakpoint
-- Organisation de la transaction en cours, fixée par withOrganization() avec SET LOCAL.
-- NULL hors d'une transaction d'organisation : une politique RLS qui la compare ne laisse alors rien passer.
CREATE OR REPLACE FUNCTION current_organization_id() RETURNS uuid
	LANGUAGE sql
	STABLE
	PARALLEL SAFE
AS $$
	SELECT nullif(current_setting('app.organization_id', true), '')::uuid
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION current_organization_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION current_organization_id() TO app_api, app_admin;
