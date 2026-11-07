# Lot 12 — Vitrine publique, annonces et prospects

## Contexte
La vitrine montre les unités libres des portefeuilles gérés. Sa promesse face aux sites d'annonces existants : **la disponibilité est toujours exacte**, car l'annonce suit le statut de l'unité, et chaque annonce porte la mention « Géré sous mandat ». Elle doit être très rapide en 3G et encaisser des pics de trafic (annonce partagée dans de grands groupes WhatsApp).

## Prérequis
Lot 11 terminé.

## Périmètre
1. **Annonces** (module `listings`), cloisonnées, auditées, synchronisées :
   - `listings` : cible (unité, ou bien entier pour une vente), titre, description, prix affiché, type d'opération (location, vente), état de visibilité (`internal`, `published`, `suspended`, `archived`), précision de localisation (`neighborhood` par défaut, `exact` si l'agence le choisit), photos choisies et ordre, slug, dates de publication.
   - Publication possible seulement si : mandat actif avec `can_publish`, au moins 3 photos, prix renseigné, unité `vacant` (ou `reserved` affichée « Réservé »), interrupteur `listings.publication` actif pour l'agence.
   - **Synchronisation automatique** : bail activé → annonce `suspended` (« Loué »), puis retirée ; mandat expiré ou révoqué → annonce suspendue ; interrupteur coupé → annonces masquées. Chaque retrait purge le cache CDN de la page.
2. **Vitrine** (`apps/web/src/routes/(public)/`), rendue côté serveur, **JavaScript minimal** :
   - Accueil : rubriques **Louer** et **Acheter** (biens à vendre en fiche simple, documents déclarés par le vendeur et signalés comme tels) ; recherche par commune, quartier, type, budget, pièces, meublé. Filtres dans une feuille sur téléphone et tablette, toujours visibles à gauche sur ordinateur (`docs/UX.md` §4).
   - Liste de résultats paginée par curseur, avec miniatures WebP et chargement différé.
   - Page d'annonce : carrousel sur téléphone, mosaïque de photos et carte de contact collante sur tablette et ordinateur ; galerie, prix au format FCFA, caractéristiques, quartier sur une carte OpenStreetMap légère (chargée seulement au clic), mention « Géré sous mandat par <agence> », boutons WhatsApp (message pré-rempli avec la référence de l'annonce), Appeler, formulaire de contact.
   - Page agence : présentation, badge « Agence vérifiée » si le back-office l'a vérifiée, annonces en cours.
   - Balises SEO, Open Graph (aperçu soigné quand le lien est partagé sur WhatsApp), plan du site.
   - Aucune donnée privée : ni propriétaire, ni adresse exacte sauf choix de l'agence, ni documents.
3. **Cache et charge** :
   - En-têtes de cache pour Cloudflare sur les pages publiques (`s-maxage`, `stale-while-revalidate`), purge ciblée à chaque modification ou retrait d'une annonce.
   - Images servies depuis le stockage objet via le CDN.
   - Cache Redis des listes de résultats ; limitation de débit sur la recherche et le formulaire de contact.
   - Index PostgreSQL adaptés aux filtres de recherche.
4. **Prospects** : table `leads` (annonce, nom, téléphone, message, source : formulaire, WhatsApp, appel noté à la main ; statut : nouveau, contacté, visite prévue, sans suite, converti ; agent affecté). Notification dans l'application à chaque nouveau prospect. Protection du formulaire contre les robots (champ piège et limitation de débit, sans service tiers). Protégé par `leads.contact_form`.
5. **Écrans de l'application** : bouton « Publier » sur une unité libre (avec la liste de ce qui manque si la publication est impossible), aperçu de l'annonce, liste des annonces et de leur état, liste et fiche des prospects.
6. **Interrupteur global** `listings.public_showcase` : coupé, la vitrine affiche une page de maintenance.

## Hors périmètre
Publication par les particuliers, mise en avant payante (`listings.featured`), alertes de recherche, favoris, visites 360°, rapprochement automatique des demandes.

## Tests attendus
- Publication refusée pour chaque condition manquante, avec le bon motif.
- Bail activé : annonce retirée de la vitrine et cache purgé (test avec un faux client de purge).
- Interrupteur `listings.publication` coupé pour une agence : ses annonces disparaissent, celles des autres restent ; rouvert, elles réapparaissent.
- Aucune donnée privée dans le HTML d'une page publique (test qui cherche le nom du propriétaire, les documents, l'adresse exacte).
- Accès croisé : une agence ne voit pas les prospects d'une autre.
- Performance : JavaScript de la page d'annonce < 100 Ko compressés ; Lighthouse mobile ≥ 90 en performance.
- Formulaire de contact : limitation de débit et champ piège.
- Aperçu Open Graph présent et correct.

## Critères d'acceptation
- [ ] Une page d'annonce s'affiche en moins de 2,5 secondes en 3G simulée.
- [ ] Le lien d'une annonce partagé sur WhatsApp affiche une photo, le prix et le quartier.
- [ ] Un prospect qui écrit depuis la vitrine apparaît dans l'application de l'agence en moins de 10 secondes.
- [ ] Journal des lots mis à jour.

## Instructions de travail
Présente le schéma, la stratégie de cache (quoi, combien de temps, quand purger) et le poids cible de chaque page avant de coder.
