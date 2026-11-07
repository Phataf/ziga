# Lot 07 — Biens, unités, médias et documents

## Contexte
Un bien (maison, villa, immeuble, cour commune, terrain…) contient une ou plusieurs unités (chambre-salon, studio, appartement, mini-villa, boutique, bureau…). Chaque unité a son statut, son loyer et, plus tard, son bail. Les photos servent la vitrine ; les documents (titres, pièces d'identité, mandats) sont strictement privés.

## Prérequis
Lot 06 terminé.

## Périmètre
1. **Référentiel géographique** (partagé, non cloisonné, lecture seule pour les agences) : `communes` et `neighborhoods` (Ouagadougou et Saaba au minimum, avec un point central latitude/longitude). Données initiales en migration ; ajout de quartiers par le back-office.
2. **Tables** (module `properties`), cloisonnées, auditées, synchronisées :
   - `properties` : propriétaire, type, nom interne, commune, quartier, adresse ou repère (« derrière la pharmacie… »), coordonnées facultatives, documents déclarés (APFR, attestation d'attribution, PUH, titre foncier, aucun), notes internes, statut (actif, archivé).
   - `units` : bien, type, libellé (« Appartement A2 »), pièces, douches, surface facultative, meublé, équipements (liste fermée : clôture, gardien, compteur séparé, climatisation, garage, eau courante…), loyer affiché, charges, statut (`vacant`, `occupied`, `reserved`, `unavailable`), agent affecté facultatif.
   - `media` : propriétaire de l'objet (bien ou unité), clé de stockage, type, ordre, légende, largeur et hauteur, statut de traitement.
   - `documents` : objet lié (propriétaire, mandat, bien, unité ; plus tard bail), type, clé de stockage, nom, taille, **toujours privé**.
   - Remplir `mandate_scopes` : un mandat couvre des biens entiers ou des unités précises.
3. **Statut d'unité** : modifiable à la main sauf `occupied`, qui sera piloté par le bail au lot 08 (préparer la règle : pas de passage manuel à `occupied`).
4. **Photos** :
   - Compression et redimensionnement **sur le téléphone** avant envoi (largeur max 1600 px), envoi direct vers le stockage par URL présignée, puis tâche BullMQ qui produit les variantes WebP (miniature 320, moyenne 800, grande 1600) avec sharp et supprime les métadonnées EXIF (position GPS).
   - Hors ligne : la photo est mise en file d'envoi et affichée localement en attendant.
   - Quota : 15 photos par unité ; formats JPEG, PNG, WebP, HEIC si possible ; 10 Mo maximum avant compression.
5. **Documents** : envoi par URL présignée, accès en lecture par URL signée de 5 minutes, jamais derrière le CDN public, téléchargement journalisé dans l'audit.
6. **Quota d'unités** de la formule vérifié à la création (`quotas.check`).
7. **Affectation** d'unités à un agent de terrain : l'agent ne voit que ses unités affectées (règle de synchronisation et API).
8. **Écrans** : liste des biens (filtre par quartier, statut, propriétaire), fiche bien avec ses unités, création d'un bien et de ses unités en un parcours, galerie photo avec réordonnancement, ajout de documents, changement de statut d'une unité.

## Hors périmètre
Publication et vitrine (lot 12), baux (lot 08), visites 360°, vidéos, carte interactive (lot 12).

## Tests attendus
- Accès croisé A/B sur chaque table, y compris l'accès aux fichiers (une URL signée de A n'ouvre pas un document de B ; une clé de stockage de B demandée par A est refusée).
- EXIF supprimés des variantes (test sur une image contenant une position GPS).
- 16e photo refusée ; quota d'unités de la formule respecté.
- Passage manuel à `occupied` refusé.
- Agent de terrain : ne voit et ne modifie que ses unités affectées.
- Document : jamais accessible sans URL signée ; URL expirée refusée ; téléchargement audité.
- Photo prise hors ligne envoyée à la reconnexion.

## Critères d'acceptation
- [ ] Un gestionnaire crée un immeuble de 6 appartements avec 3 photos chacun depuis son téléphone en moins de 10 minutes.
- [ ] Les variantes WebP d'une photo de 4 Mo pèsent moins de 200 Ko (taille moyenne).
- [ ] Journal des lots mis à jour.

## Instructions de travail
Présente le schéma, les règles de synchronisation (dont l'affectation aux agents) et le flux d'envoi des photos avant de coder.
