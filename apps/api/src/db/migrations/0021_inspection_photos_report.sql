-- Lot 10 bis, étape 4 — photos d'un état des lieux et PDF de l'état des lieux.
--
-- - documents.taken_at : heure de la prise de vue sur l'appareil (photo d'une ligne) ; created_at reste l'heure de
--   réception par le serveur.
-- - documents.received_after_signature : photo prise avant la dernière case cochée, reçue après la signature (hors
--   ligne, cases et photos repartent ensemble) ; affichée « Photo reçue après la signature, le … » à l'écran et dans le
--   PDF. Les deux colonnes sont figées comme le reste d'une version.
-- - inspection_report : PDF de l'état des lieux, produit par le worker à la signature et à chaque photo reçue après
--   elle ; une nouvelle version remplace la précédente, jamais écrasée.

ALTER TABLE documents ADD COLUMN taken_at timestamptz, ADD COLUMN received_after_signature boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_photo_dates CHECK (
	(taken_at IS NULL OR type = 'inspection_photo') AND (NOT received_after_signature OR type = 'inspection_photo')
);
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT documents_type_check;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN ('title_deed', 'puh', 'allocation_certificate', 'apfr',
	'owner_identity', 'mandate', 'document_photo', 'other', 'signed_lease_scan', 'tenant_identity', 'contract_template', 'contract_draft',
	'signed_amendment_scan', 'contract_legalization', 'contract_registration', 'expense_receipt', 'notice_proof', 'inspection_photo',
	'inspection_scan', 'repair_quote', 'agreement_document', 'settlement_outcome', 'inspection_report'));
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_inspection_report CHECK (
	type <> 'inspection_report' OR (inspection_id IS NOT NULL AND lease_id IS NOT NULL AND inspection_item_id IS NULL AND mime_type = 'application/pdf')
);
--> statement-breakpoint
CREATE FUNCTION documents_photo_dates_fixed() RETURNS trigger
	LANGUAGE plpgsql
	SET search_path = pg_catalog, public
AS $$
BEGIN
	IF NEW.taken_at IS DISTINCT FROM OLD.taken_at OR NEW.received_after_signature IS DISTINCT FROM OLD.received_after_signature THEN
		RAISE EXCEPTION 'DOCUMENT_IMMUTABLE: les dates d''une photo ne changent pas' USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER documents_photo_dates_fixed BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION documents_photo_dates_fixed();
