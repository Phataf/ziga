-- Lot 11, étape 4a : un bien importé sans quartier reconnu reste en brouillon (jamais situé au hasard) ; l'annulation
-- de l'import l'archive. La contrainte du lot 07 exigeait un bien situé pour tout statut autre que brouillon : elle
-- l'exige désormais pour un bien actif seulement (un bien archivé n'est ni publié ni proposé). Activer un bien exige
-- toujours sa commune et son quartier, ici comme dans le service.
ALTER TABLE properties DROP CONSTRAINT properties_located;
--> statement-breakpoint
ALTER TABLE properties ADD CONSTRAINT properties_located
	CHECK (record_status <> 'active' OR (commune_id IS NOT NULL AND neighborhood_id IS NOT NULL));
