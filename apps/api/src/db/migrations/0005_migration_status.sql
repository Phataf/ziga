-- Vérification au démarrage (src/db/migration-status.ts) : l'API et le back-office lisent la liste des migrations
-- appliquées, pour refuser de démarrer sur une base en retard avec un message clair, au lieu d'une erreur SQL à la
-- première requête. Lecture seule ; la table appartient au rôle propriétaire du schéma.
GRANT USAGE ON SCHEMA drizzle TO app_api, app_admin;
--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO app_api, app_admin;
