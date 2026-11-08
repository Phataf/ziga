# Lot 07 — Biens, unités, médias et documents

## Contexte
Un bien (villa ou maison, immeuble d'appartements, cour commune, local commercial, terrain) contient une ou plusieurs unités (chambre-salon, studio, appartement, mini-villa, boutique, bureau…). Chaque unité a son statut, son loyer et, plus tard, son bail. Les photos servent la vitrine ; les documents (titres, pièces d'identité, mandats) sont strictement privés.

## Prérequis
Lot 06 terminé.

## Périmètre
1. **Référentiel géographique** (partagé, non cloisonné, lecture seule pour les agences) : `communes` et `neighborhoods` (Ouagadougou et Saaba au minimum, avec un point central latitude/longitude). Données initiales en migration ; ajout de quartiers par le back-office.
2. **Tables** (module `properties`), cloisonnées, auditées, synchronisées :
   - `properties` : propriétaire, type (`house`, `apartment_building`, `shared_compound`, `commercial`, `land`), opération visée (location, vente, les deux), nom interne, commune, quartier, adresse ou repère (« derrière la pharmacie… »), point GPS pris sur place (facultatif, jamais publié tel quel), documents déclarés (APFR, attestation d'attribution, PUH, titre foncier, aucun), notes internes, statut de la fiche (`draft`, `active`, `archived`). Un terrain peut n'avoir aucune unité louable.
   - `units` : bien, type, libellé (« Appartement A2 »), pièces détaillées (chambres, salon, cuisine, salles de bain, garage, terrasse, buanderie), surface facultative, terrain en m² facultatif, clôturé ou non, usage (habitation, professionnel et habitation), meublé (caractéristique, pas un type ; un meublé aura un inventaire dans l'état des lieux), équipements (liste fermée : clôture, gardien, compteur séparé, climatisation, garage, eau courante…), loyer affiché, charges, caution et avance proposées, agent affecté facultatif, et le **statut en quatre dimensions (D14, `CLAUDE.md` règle 13)** :
     - `record_status` : `draft`, `active`, `archived` (saisi) ;
     - `technical_status` : `ready`, `to_refurbish`, `under_works`, `unavailable`, avec motif obligatoire hors `ready` et date prévue facultative (saisi) ;
     - occupation : **jamais stockée ni saisie**, calculée à partir des baux par une fonction pure de `packages/shared` (`free`, `reserved`, `occupied`, `notice`) ; au lot 07, sans bail, elle vaut toujours `free` ;
     - annonce : ajoutée au lot 12.
     - `isAvailable(unit)` (fonction pure) : fiche active, occupation `free` ou `notice`, état `ready`.
   - `media` : propriétaire de l'objet (bien ou unité), clé de stockage, type, ordre, légende, largeur et hauteur, statut de traitement.
   - **Module `documents` (D22)** — `documents` : objets liés (propriétaire, mandat, bien, unité ; bail, contrat, locataire au lot 08 bis), type (liste fermée : titre foncier, PUH, attestation d'attribution, pièce d'identité du propriétaire, mandat, photo de document, autre…), version, document remplacé, auteur, date d'ajout, clé de stockage, nom, taille, empreinte SHA-256, statut (`active`, `replaced`, `withdrawn`), restriction facultative, **toujours privé**. Les droits de consultation viennent de la **matrice par type** de `docs/UX.md` §10, codée dans `packages/shared` ; une restriction ne peut que réduire. Chaque téléchargement écrit une ligne d'audit. Durée de conservation : question ouverte, rien n'est supprimé automatiquement.
   - Remplir `mandate_scopes` : un mandat couvre des biens entiers ou des unités précises. **Contrainte (D16)** : une unité est couverte au plus par un mandat de gestion actif, qu'elle soit visée directement ou par son bien.
3. **Statut d'unité** : seuls `record_status` et `technical_status` se modifient à la main ; aucun endpoint ni aucune opération de synchronisation ne peut écrire l'occupation.
4. **Photos** :
   - Compression et redimensionnement **sur le téléphone** avant envoi (largeur max 1600 px), envoi direct vers le stockage par URL présignée, puis tâche BullMQ qui produit les variantes WebP (miniature 320, moyenne 800, grande 1600) avec sharp et supprime les métadonnées EXIF (position GPS).
   - Hors ligne : la photo est mise en file d'envoi et affichée localement en attendant.
   - Quota : 15 photos par unité ; formats JPEG, PNG, WebP, HEIC si possible ; 10 Mo maximum avant compression.
5. **Documents** : envoi par URL présignée, accès en lecture par URL signée de 5 minutes, jamais derrière le CDN public, téléchargement journalisé dans l'audit.
6. **Quota d'unités** de la formule vérifié à la création (`quotas.check`).
7. **Affectation** d'unités à un agent de terrain : l'agent ne voit que ses unités affectées (règle de synchronisation et API).
8. **Écrans** : liste des biens (filtre par quartier, disponibilité, état technique, propriétaire), fiche bien avec ses unités et une pastille par dimension de statut, **assistant d'ajout en cinq étapes** (`docs/UX.md` §10 : type et propriétaire ; localisation avec repère et point GPS ; unités ; médias ; documents privés), brouillon enregistré à chaque étape, bouton global « Créer » sur tablette et ordinateur, galerie photo avec réordonnancement, ajout de documents, changement de statut d'une unité.

## Hors périmètre
Publication et vitrine (lot 12), baux (lot 08), visites 360°, vidéos, carte interactive (lot 12).

## Tests attendus
- Accès croisé A/B sur chaque table, y compris l'accès aux fichiers (une URL signée de A n'ouvre pas un document de B ; une clé de stockage de B demandée par A est refusée).
- EXIF supprimés des variantes (test sur une image contenant une position GPS).
- 16e photo refusée ; quota d'unités de la formule respecté.
- Écriture de l'occupation refusée (API et synchronisation) ; `isAvailable` testée sur toutes les combinaisons.
- Deux mandats de gestion actifs sur la même unité (directement ou par le bien) : refusé.
- Point GPS absent du HTML et des réponses publiques (préparé pour le lot 12).
- Agent de terrain : ne voit et ne modifie que ses unités affectées.
- Document : jamais accessible sans URL signée ; URL expirée refusée ; téléchargement audité.
- Photo prise hors ligne envoyée à la reconnexion.

## Critères d'acceptation
- [ ] Un gestionnaire crée un immeuble de 6 appartements avec 3 photos chacun depuis son téléphone en moins de 10 minutes.
- [ ] Les variantes WebP d'une photo de 4 Mo pèsent moins de 200 Ko (taille moyenne).
- [ ] Journal des lots mis à jour.

## Instructions de travail
Présente le schéma, les règles de synchronisation (dont l'affectation aux agents) et le flux d'envoi des photos avant de coder.
