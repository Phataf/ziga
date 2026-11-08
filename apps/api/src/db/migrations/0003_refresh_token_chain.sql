-- Délai de grâce du rafraîchissement (D28, mise à jour du 08/11/2026) : chaque jeton retient son prédécesseur
-- direct, pour reconnaître une réponse perdue (le navigateur renvoie le jeton précédent) et la distinguer d'un vol.
-- Les jetons émis avant cette migration n'ont pas de prédécesseur : une réutilisation reste traitée comme un vol.
ALTER TABLE refresh_tokens ADD COLUMN parent_id uuid REFERENCES refresh_tokens (id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX refresh_tokens_session_latest ON refresh_tokens (session_id, issued_at DESC, id DESC);
