# Lot 04 — Interrupteurs de fonctionnalités, formules et back-office minimal

## Contexte
Décision D05 : chaque fonctionnalité optionnelle (paiement direct, annonces, etc.) doit pouvoir être coupée pour tout le monde, ouverte à tout le monde, ou ouverte seulement à certaines agences ou personnes, depuis le back-office et sans intervention de développement. Ce moteur est construit **avant** les modules métier pour que chacun soit protégé dès sa création.

**La spécification complète est `docs/FEATURE-FLAGS.md`. Elle fait foi.**

## Prérequis
Lot 03 terminé.

## Périmètre
1. **Catalogue** dans `packages/shared/features.ts` : les clés du §4 de la spécification, avec description, dépendances, `plan_bound`, mode global par défaut. Migration qui insère le catalogue.
2. **Formules** : table `plans` (`discovery`, `essential`, `pro`, `custom`) avec quotas (unités, utilisateurs, relevés par mois) ; table `plan_features`. Données initiales conformes au cadrage (Découverte 10 unités et 1 utilisateur, Essentiel 60 et 3, Pro 250 et 10).
3. **Tables** `features`, `feature_overrides`, `agency_feature_settings` (§5 de la spécification).
4. **Service de résolution** `features.isEnabled(key, ctx)` et `features.explain(key, ctx)` (renvoie l'étape qui a décidé) : les 7 étapes du §3, dans l'ordre exact. Cache Redis avec invalidation par publication à chaque modification ; propagation en 30 secondes maximum.
5. **Application** : décorateur `@RequiresFeature(key)` (refus `403`, code `FEATURE_DISABLED`) ; endpoint `GET /me/features` qui renvoie l'état effectif des clés pour l'utilisateur et l'agence active ; store Svelte `features` et composant `<FeatureGate key="...">` côté interface.
6. **Quotas** : service `quotas.check(agencyId, 'units' | 'users' | ...)` utilisé à la création (les lots suivants l'appelleront).
7. **Back-office**, pensé d'abord pour l'ordinateur et utilisable sur tablette (tableaux, filtres, panneaux latéraux, `docs/UX.md`) (`/admin`, réservé à `super_admin` et `support`, rôle base `app_admin`, chaque lecture d'une agence journalisée) :
   - Agences : liste, fiche, validation (`pending` → `verified`), suspension avec motif, changement de formule.
   - Fonctionnalités : les 4 écrans du §7 de la spécification (liste avec sélecteur à 3 positions, fiche avec exceptions, onglet « Fonctionnalités » sur les fiches agence et utilisateur avec la raison, simulateur).
   - Confirmation renforcée pour couper une fonctionnalité utilisée (affiche le nombre d'agences touchées) et pour suspendre une agence.
   - `support` peut consulter et valider ; seul `super_admin` modifie les interrupteurs et les formules.
8. **Réglages de l'agence** : le directeur voit les fonctionnalités ouvertes à son agence et peut en désactiver certaines pour son agence (jamais en activer).
9. **Audit** : toute modification d'interrupteur, d'exception, de formule, de statut d'agence écrit dans `audit_log` avec avant et après.

## Hors périmètre
Facturation et paiement des abonnements, modules métier, pages publiques.

## Tests attendus
Tous les tests du §8 de `docs/FEATURE-FLAGS.md`, plus :
- `support` ne peut pas modifier un interrupteur ; `super_admin` peut.
- Un utilisateur sans rôle plateforme ne peut pas accéder à `/admin` ni à ses endpoints.
- Quota d'utilisateurs : l'invitation d'un 2e membre sur la formule Découverte est refusée avec un message clair, sauf exception.
- `GET /me/features` reflète un changement en moins de 30 secondes.
- `<FeatureGate>` masque bien l'élément (test de composant).

## Critères d'acceptation
- [ ] Depuis le back-office, en moins d'une minute : couper `listings.publication` pour tous, puis l'ouvrir pour une seule agence, puis la fermer pour un seul utilisateur de cette agence. Chaque état est vérifié par le simulateur et par un appel d'API.
- [ ] Le simulateur explique chaque résultat (étape et motif).
- [ ] Aucune lecture directe des tables d'interrupteurs hors du module `features` (règle ESLint d'import ou test d'architecture).
- [ ] Journal des lots mis à jour.

## Instructions de travail
Commence par implémenter et tester la fonction de résolution seule, en pur TypeScript dans `packages/shared` (sans base), avec un test par ligne du tableau de résolution. Ensuite seulement : tables, cache, guards, écrans.
