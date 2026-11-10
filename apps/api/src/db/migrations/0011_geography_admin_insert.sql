-- Lot 07, étape 2 : le back-office ajoute un quartier par Drizzle, qui nomme toutes les colonnes de l'INSERT (DEFAULT
-- pour les instants) ; PostgreSQL exige alors le droit d'insertion sur chacune. La migration 0009 (déjà appliquée, donc
-- inchangée) ne l'accordait pas sur les deux instants.
GRANT INSERT (created_at, updated_at) ON neighborhoods TO app_admin;
