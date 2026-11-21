-- Lot 10 bis, étape 3 — compléments pour l'API et la tâche du jour de la sortie du locataire.
--
-- - inspections : la case cochée par le locataire est saisie sur l'appareil d'un membre ; on garde qui l'a saisie
--   (« Case cochée par … le … sur l'appareil de … », jamais une signature électronique, même principe que D21).
-- - deposit_settlements : dernier niveau d'alerte du délai de restitution écrit par la tâche du jour (une ligne d'audit
--   par niveau atteint, jamais deux).
-- - due_lease_organizations : celle de 0014 (dont les baux à reconduire), plus les organisations qui ont un bail en préavis arrivé à sa date de sortie, ou un
--   décompte pas encore clos (alerte du délai de restitution).

ALTER TABLE inspections ADD COLUMN tenant_signed_recorded_by uuid REFERENCES users (id);
--> statement-breakpoint
ALTER TABLE inspections ADD CONSTRAINT inspections_tenant_signature_recorder CHECK ((tenant_signed_at IS NULL) = (tenant_signed_recorded_by IS NULL));
--> statement-breakpoint
ALTER TABLE inspections ADD CONSTRAINT inspections_organization_signature_signer CHECK ((organization_signed_at IS NULL) = (organization_signed_by IS NULL));
--> statement-breakpoint
ALTER TABLE deposit_settlements ADD COLUMN refund_alert text CHECK (refund_alert IN ('soon', 'overdue'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION due_lease_organizations(as_of date) RETURNS SETOF uuid
	LANGUAGE sql STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT organization_id FROM leases WHERE status = 'signed' AND starts_on <= as_of
	UNION
	SELECT organization_id FROM leases WHERE status IN ('active', 'notice') AND ends_on IS NULL
	UNION
	SELECT organization_id FROM leases WHERE status = 'active' AND ends_on < as_of AND notice_given_on IS NULL
	UNION
	SELECT organization_id FROM rent_dues
	WHERE (status = 'upcoming' AND due_on <= as_of) OR (status IN ('due', 'partial') AND due_on < as_of)
	UNION
	SELECT organization_id FROM leases WHERE status = 'notice' AND exit_on <= as_of
	UNION
	SELECT organization_id FROM deposit_settlements WHERE status <> 'closed'
$$;
