-- Lot 10 ter (correctif avant l'étape 3) : un décompte proposé puis remis en brouillon (nouveau calcul) ne montre plus
-- ses montants au locataire ; son espace dit seulement qu'il est « en cours de correction par l'organisation ». Le
-- recalcul efface proposed_at : la base garde la date de la première proposition, posée une fois, jamais effacée.

ALTER TABLE deposit_settlements ADD COLUMN first_proposed_at timestamptz;
--> statement-breakpoint
-- Décomptes déjà proposés (ou au-delà : acceptés, contestés, clos).
UPDATE deposit_settlements SET first_proposed_at = coalesce(proposed_at, accepted_at, disputed_at, closed_at, updated_at)
WHERE status <> 'draft' OR proposed_at IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION deposit_settlements_first_proposed() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD.first_proposed_at IS NOT NULL THEN
		NEW.first_proposed_at := OLD.first_proposed_at;
	ELSIF NEW.status = 'proposed' AND NEW.first_proposed_at IS NULL THEN
		NEW.first_proposed_at := now();
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION deposit_settlements_first_proposed() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER deposit_settlements_first_proposed BEFORE INSERT OR UPDATE ON deposit_settlements
	FOR EACH ROW EXECUTE FUNCTION deposit_settlements_first_proposed();
