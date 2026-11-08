# Lot 00 ter — Compléter la maquette avec les écrans de l'audit (en parallèle des lots 01 à 05)

## Contexte
L'audit du 08/11/2026 (`docs/AUDIT.md`) et les décisions D12 à D19 ajoutent des parcours qui n'existent pas encore dans la maquette. Les plus risqués doivent être montrés aux trois agences pilotes **avant le lot 06**, pour corriger les règles avant de les coder. Ce lot ne touche **que** `maquette/` (exception à D10, limitée à ce lot) et se fait dans une session séparée de celle des lots 01 à 05.

## Prérequis
Maquette du lot 00 bis en place. Lis `docs/UX.md` (§2, §9, §10), `docs/DECISIONS.md` (D12 à D19) et `docs/AUDIT.md`.

## Périmètre
1. **Données de démonstration** : ajouter une deuxième agence et un bailleur particulier ; un propriétaire qui a un bien dans chacune ; un locataire passé de l'une à l'autre ; un bail en préavis ; une unité « à remettre en état ».
2. **Statut en quatre dimensions** sur la fiche unité et dans les listes (pastille de synthèse), occupation calculée à partir des baux.
3. **Assistant d'ajout de bien** en cinq étapes (type et propriétaire, localisation, unités, médias, documents), sur les trois appareils.
4. **Sortie du locataire** : préavis, état des lieux guidé pièce par pièce, décompte de caution avec l'exemple du porteur (100 000 FCFA, douche 10 000, porte 5 000, restitution 85 000), variante « caution imputée sur les derniers loyers » avec accord, variante « réparé par le locataire ».
5. **Espace propriétaire** : patrimoine groupé par gestionnaire (deux agences et gestion directe), fiche bien, revenus.
6. **Espace locataire** : historique des deux baux, caution et décompte, signalement suivi.
7. **Back-office** (ordinateur) : liste des organisations, abonnements, interrupteurs, accès d'assistance motivé.
8. **Choix de l'espace** pour une personne qui en a plusieurs.

## Hors périmètre
Tout code du produit (`apps/`, `packages/`), backend, nouvelles dépendances.

## Tests attendus
- Les 15 tests d'origine et ceux du lot 00 bis passent sans modification.
- Un parcours Playwright par nouvel écran sur 360 × 800, 820 × 1180 et 1440 × 900 ; aucun débordement horizontal sur téléphone ; test anti-émoji.
- Fonctions pures de démonstration (occupation calculée, décompte) testées avec Vitest.

## Critères d'acceptation
- [ ] Le porteur a présenté la sortie du locataire et l'espace propriétaire aux trois agences pilotes ; leurs remarques sont consignées dans `docs/JOURNAL-LOTS.md`, et les écarts avec D14 à D17 sont signalés avant le lot 06.
- [ ] Les réponses des pilotes aux questions ouvertes (détenteur de la caution, légalisation des baux) sont reportées dans `docs/DECISIONS.md`.
