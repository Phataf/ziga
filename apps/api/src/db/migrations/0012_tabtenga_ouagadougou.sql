-- Correction du lot 07 (réponse du porteur du 14/11/2026) : Tabtenga est un quartier de Ouagadougou seulement, jamais
-- un village de Saaba. La migration 0009 (appliquée, donc inchangée) ne l'a créé qu'à Ouagadougou ; celle-ci le
-- garantit sur toute base : une ligne « Tabtenga » à Saaba (ajoutée par le back-office, par exemple) est retirée si
-- aucun bien ne la référence. Si un bien la référence, rien n'est supprimé : un avis le signale, à traiter à la main.
DO $$
DECLARE
	saaba_tabtenga uuid;
BEGIN
	SELECT id INTO saaba_tabtenga FROM neighborhoods WHERE commune_id = 'saaba' AND geo_name_key(name) = 'tabtenga';
	IF saaba_tabtenga IS NULL THEN
		RETURN;
	END IF;
	IF EXISTS (SELECT FROM properties WHERE neighborhood_id = saaba_tabtenga) THEN
		RAISE NOTICE 'Tabtenga (Saaba) est référencé par des biens : non supprimé, à corriger à la main.';
		RETURN;
	END IF;
	DELETE FROM neighborhoods WHERE id = saaba_tabtenga;
END
$$;
