-- Correction du lot 09 (demande du porteur) : un versement de caution est un encaissement. La base refuse désormais
-- tout nouveau mouvement `received` sans encaissement lié (`payment_id`), pour tous les rôles, propriétaire du schéma
-- compris (trigger, pas seulement un droit). Les mouvements `received` déjà enregistrés sans encaissement (saisis au
-- lot 08) restent tels quels : la règle ne porte que sur l'insertion.
CREATE FUNCTION deposit_movements_received_needs_payment() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF NEW.type = 'received' AND NEW.payment_id IS NULL THEN
		RAISE EXCEPTION 'DEPOSIT_RECEIPT_VIA_PAYMENT: un versement de caution passe par un encaissement' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposit_movements_received_needs_payment BEFORE INSERT ON deposit_movements
	FOR EACH ROW EXECUTE FUNCTION deposit_movements_received_needs_payment();
