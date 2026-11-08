# Lot 06 — Propriétaires et mandats

## Contexte
Une agence gère des biens pour des propriétaires qui, souvent, n'utiliseront jamais la plateforme (beaucoup vivent dans la diaspora). L'agence doit pouvoir tout gérer pour eux, sous un mandat enregistré. Le mandat conditionne plus tard la publication et l'encaissement.

## Prérequis
Lot 05 terminé. Suis `docs/SYNC.md` pour chaque nouvelle table.

## Périmètre
1. **Tables** (module `owners`), toutes avec `organization_id`, RLS, clés composites, audit, synchronisation :
   - `owners` : type (personne, société, groupe d'indivisaires avec un représentant désigné), nom, téléphone, e-mail facultatif, adresse, pays de résidence, pièce d'identité (référence de document, ajoutée au lot 07), notes internes, `user_id` facultatif (compte lié, jamais obligatoire), statut (actif, archivé).
   - `mandates` : propriétaire, type (`rental_management`, `letting`, `sale`, `self_managed`, `other`), date de début, date de fin facultative, commission (taux en points de base, ex. 1000 = 10 %, ou montant fixe en FCFA), autorisations (`can_publish`, `can_take_photos`, `can_collect_funds`, `can_sign_leases` : l'organisation peut signer les baux au nom du propriétaire, D24), exclusivité (information seulement), statut (`draft`, `active`, `expired`, `revoked`), motif et date de révocation, numéro de version.
   - `mandate_scopes` : lien entre un mandat et des biens ou des unités (rempli au lot 07 ; prévoir la table et ses contraintes dès maintenant).
2. **Versionnage des mandats** : toute modification d'un mandat actif crée une nouvelle version ; les versions précédentes restent consultables.
3. **Règles métier** :
   - **Un seul mandat de gestion actif par unité (D16, règle 12)** : prépare la contrainte dès maintenant ; elle sera vérifiée sur `mandate_scopes` au lot 07, y compris quand un mandat couvre un bien entier.
   - **Organisation de type bailleur** : à sa création, une fiche propriétaire qui le représente et un mandat `self_managed` permanent sont créés automatiquement ; il ne voit pas l'écran des mandats.
   - Un propriétaire de type groupe a un représentant (nom, téléphone) ; la répartition des revenus entre indivisaires est hors périmètre.
   - Créer une fiche propriétaire **n'envoie aucune invitation** et ne publie rien.
   - Un mandat expire automatiquement à sa date de fin (tâche quotidienne BullMQ) ; une alerte apparaît dans l'application 30 jours avant.
   - Un mandat révoqué ou expiré retire ses autorisations immédiatement (les effets sur la publication seront branchés au lot 12).
   - Permissions : `owner.create`, `owner.update`, `mandate.create`, `mandate.revoke` (directeur et gestionnaire ; `field_agent` en lecture seule ; `viewer` en lecture).
   - Quotas et interrupteurs : aucun interrupteur spécifique, mais le module respecte le contexte d'agence.
4. **Écrans** (application, données locales) : liste des propriétaires avec recherche, fiche propriétaire (coordonnées, mandats, biens à venir), création rapide en un écran, création et révocation de mandat, historique des versions, bandeau « mandat expirant ».
5. **Matrice de permissions** complétée dans `packages/shared/permissions.ts`.

## Hors périmètre
Pièces jointes (lot 07), biens et unités (lot 07), signature électronique, compte propriétaire, relevés (lot 10).

## Tests attendus
- Accès croisé A/B sur `owners`, `mandates`, `mandate_scopes` (API, SQL, synchronisation).
- Un mandat ne peut pas référencer un propriétaire d'une autre agence (clé composite).
- Modification d'un mandat actif : nouvelle version, ancienne conservée, audit avec avant et après.
- Organisation bailleur : fiche propriétaire et mandat `self_managed` créés automatiquement, une seule fois.
- Expiration automatique à la date de fin ; alerte à J-30.
- Révocation : autorisations à faux, motif obligatoire.
- Commission : taux entre 0 et 10 000 points de base, ou montant entier en FCFA, jamais les deux.
- Création d'un propriétaire hors ligne, synchronisée à la reconnexion.
- `field_agent` ne peut pas créer de mandat.

## Critères d'acceptation
- [ ] Un gestionnaire crée un propriétaire et son mandat de gestion en moins de 1 minute sur téléphone, hors ligne.
- [ ] Aucune invitation n'est envoyée au propriétaire, en aucun cas.
- [ ] Journal des lots mis à jour.

## Instructions de travail
Présente les migrations et les règles de synchronisation avant de coder. Ajoute les tables à `docs/SYNC.md`.
