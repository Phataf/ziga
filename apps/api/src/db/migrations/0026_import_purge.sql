-- Lot 11, étape 3 : fichier d'origine d'un import conservé 90 jours (prompt §4). La tâche du jour efface du stockage
-- les fichiers échus, organisation par organisation, chacune dans son contexte (RLS) ; cette fonction ne rend que les
-- identifiants (organisation, import), comme due_lease_organizations (lot 08). La ligne de l'import reste.
CREATE FUNCTION expired_import_files(as_of timestamptz) RETURNS TABLE (organization_id uuid, id uuid)
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT organization_id, id FROM import_jobs WHERE file_deleted_at IS NULL AND file_expires_at <= as_of
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION expired_import_files(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION expired_import_files(timestamptz) TO app_api;
