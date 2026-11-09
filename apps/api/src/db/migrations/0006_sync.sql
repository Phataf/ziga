-- Lot 05 — synchronisation hors ligne (PowerSync), décision D30.
--
-- Rôle de réplication `app_sync` : lit les tables publiées pour PowerSync, et rien d'autre.
--   - LOGIN REPLICATION, sans BYPASSRLS ni aucun droit d'écriture ;
--   - lecture accordée table par table (jamais par défaut), avec une politique `sync_read` explicite sur chaque
--     table à RLS : PowerSync lit toutes les organisations pour les répartir entre les appareils, et ce sont les
--     Sync Streams (infra/powersync/sync-config.yaml) qui ne laissent descendre vers un appareil que les lignes des
--     organisations dont la personne est membre active ;
--   - `users`, les sessions, les jetons et les codes ne sont ni lisibles ni publiés : ils ne quittent pas PostgreSQL.
-- Le réplication logique ne passe pas par la RLS ; la politique sert à la copie initiale des tables.
-- Le mot de passe est fixé par `pnpm db:migrate` à partir de DATABASE_SYNC_URL, jamais écrit ici.
DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_sync') THEN
		CREATE ROLE app_sync LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION NOBYPASSRLS INHERIT;
	END IF;
END
$$;
--> statement-breakpoint
ALTER ROLE app_sync NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION NOBYPASSRLS;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_sync;
--> statement-breakpoint
-- Nom affiché d'un membre, recopié depuis `users.name` : l'équipe se synchronise sans répliquer `users`
-- (ni téléphone, ni mot de passe). Tenu à jour par le module organizations (adhésion, changement de nom).
ALTER TABLE organization_members ADD COLUMN display_name text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE organization_members m SET display_name = u.name FROM users u WHERE u.id = m.user_id;
--> statement-breakpoint
-- Tables synchronisées au lot 05. Pour en ajouter une : docs/SYNC.md (droit, politique, publication, stream).
GRANT SELECT ON organizations, organization_members, features, plan_features, feature_overrides, organization_feature_settings TO app_sync;
--> statement-breakpoint
CREATE POLICY sync_read ON organizations FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON organization_members FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
CREATE POLICY sync_read ON organization_feature_settings FOR SELECT TO app_sync USING (true);
--> statement-breakpoint
-- PowerSync lit la publication nommée « powersync ». Jamais FOR ALL TABLES : une table n'y entre que sur décision.
CREATE PUBLICATION powersync FOR TABLE organizations, organization_members, features, plan_features, feature_overrides, organization_feature_settings;
