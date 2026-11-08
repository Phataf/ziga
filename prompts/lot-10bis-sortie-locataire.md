# Lot 10 bis — Sortie du locataire : préavis, états des lieux, décompte de caution, remise en état, transfert de gestion

## Contexte
Décisions D14, D15 et D16 ; règles 12, 13, 14 et 16 de `CLAUDE.md`. Quand un locataire part, l'organisation doit pouvoir faire l'état des lieux, chiffrer les réparations qui lui sont imputables, régler la caution sans retenue arbitraire, et remettre le logement en état avant de le relouer. La loi n° 103-2015/CNT encadre ces étapes (articles 3, 8, 9, 20, 26, 45 et 46, résumés dans `docs/AUDIT.md` §C1 ; lecture à confirmer par un juriste).

Les trois scénarios du porteur (restitution après réparations ; caution imputée sur les derniers loyers par accord écrit ; réparations faites par le locataire) **ne sont pas trois parcours** : ce sont des variantes d'un seul décompte, fait de lignes justifiées.

## Prérequis
Lot 10 terminé (encaissements, échéances soldées, dépenses à trois questions). Questions ouvertes à poser au porteur : liste des réparations à la charge du locataire (décret prévu à l'article 25) ; qui détient la caution en pratique.

## Périmètre
1. **Tables** (module `leases`), cloisonnées, auditées, synchronisées :
   - `lease_notices` : bail, origine (locataire, bailleur), date de notification, date de sortie prévue, motif, document. Le bail passe en `notice`. Délais légaux proposés par défaut et affichés : deux mois pour un bail à durée déterminée quitté avant terme, trois mois pour un bail à durée indéterminée ; un délai plus court est possible avec un motif.
   - `inspections` : bail, type (`entry`, `exit`), date, réalisée par, statut (`draft`, `signed_both`, `disputed`), signature des deux parties (document scanné ou case cochée par chacun avec horodatage).
   - `inspection_items` : état des lieux, pièce, élément (porte, douche, prises, peinture…, liste modifiable par organisation ; pour un meublé, l'inventaire des meubles), état décrit (texte obligatoire : « bon état » seul est refusé, article 9), photos, et pour la sortie : **constat** (`normal_wear`, `tenant_damage`, `landlord_defect`), comparaison avec la ligne d'entrée.
   - `repairs` : ligne d'état des lieux, description, montant estimé (devis) puis réel (facture), justificatif, réalisée par (`organization`, `tenant`), statut (`planned`, `done`, `verified`). Une réparation réalisée par l'organisation crée la dépense correspondante (lot 10, supportée par le locataire, récupérée sur la caution).
   - `agreements` : bail, type (`deposit_applied_to_rent`, `tenant_self_repair`, `settlement_dispute`), proposé par, accepté ou refusé par, motif du refus, date, document. **Circuit d'accord** de `docs/UX.md` §10.
   - `deposit_settlements` : compte de caution, lignes, total, résultat (`refund`, `claim`, `zero`), statut (`draft`, `proposed`, `accepted`, `disputed`, `closed`), observations des deux parties.
2. **Décompte de sortie** (fonction pure dans `packages/shared`, testée avant toute table) : caution reçue − retenues pour réparations justifiées − loyers et charges impayés − mois imputés par accord = montant à restituer (≥ 0) ou complément à réclamer.
   - Une **retenue** n'est possible que si elle pointe vers une ligne d'état des lieux classée `tenant_damage`, avec un montant et un justificatif (devis ou facture). Sinon, refus.
   - Une **imputation sur loyer** n'est possible qu'avec un accord `deposit_applied_to_rent` accepté **avant** les mois concernés ; l'écran affiche ce qui restera pour couvrir d'éventuels dégâts et permet d'en garder une partie.
   - Une **réparation faite par le locataire** n'est retirée du décompte qu'après contre-visite (`verified`).
   - À la clôture, les mouvements du compte de caution (`retained`, `applied_to_rent`, `refunded`, `additional_claimed`) sont écrits en ajout seul ; leur total ne dépasse jamais la caution reçue. La restitution est **enregistrée** (montant, date, moyen, référence), jamais exécutée par la plateforme.
3. **Contestation simple** : si une partie refuse l'état des lieux ou le décompte, le statut passe à `disputed` ; observations libres et pièces jointes des deux côtés, historique. La partie non contestée peut être restituée sans attendre. La plateforme n'arbitre pas : elle enregistre l'issue (accord amiable ou décision de justice) avec son document.
4. **Fin de bail et remise en état (D14)** : à la date de sortie, le bail passe à `ended`, l'occupation calculée devient `free` et l'état technique passe **automatiquement à `to_refurbish`**. L'unité ne redevient disponible que lorsque le gestionnaire la déclare `ready` (directement si rien n'est à réparer, ou après `under_works`).
5. **Transfert de gestion (D16, règle 12)** : assistant qui termine le mandat de gestion de l'organisation A sur une unité ou un bien, enregistre la remise du dossier (bail, locataire, documents remis, date) et le changement de détenteur de la caution (mouvement `holder_changed`, avec le nouveau détenteur nommé en texte). A conserve tout son historique. **Aucune donnée n'est copiée vers une autre organisation** (règle 15) : la nouvelle organisation saisit ou importe le dossier qui lui a été remis.
6. **Écrans** : bouton « Préavis » sur la fiche bail ; état des lieux guidé pièce par pièce, photos prises sur place, utilisable hors ligne par l'agent de terrain ; comparaison entrée et sortie ; décompte avec ses lignes et leurs justificatifs ; accords ; contestation ; liste des unités « à remettre en état » ; assistant de transfert de gestion. Sur ordinateur : décompte en tableau avec le panneau des justificatifs à droite.
7. **Permissions** : `lease.notice`, `inspection.create`, `inspection.sign`, `deposit.settle`, `agreement.decide`, `management.transfer` (directeur, gestionnaire ; agent de terrain : états des lieux sur ses unités).

## Hors périmètre
Espace locataire et propriétaire avec compte (lot 10 ter : ils afficheront ces données), approbation par le propriétaire des dépenses au-delà d'un seuil, contestation structurée en plusieurs tours, médiation, intérêts de retard sur la restitution.

## Tests attendus
- Accès croisé A/B sur chaque nouvelle table.
- Décompte (fonction pure) : exemple du porteur (caution 100 000, douche 10 000, porte 5 000 → restitution 85 000) ; caution entièrement imputée sur loyers puis dégâts → complément réclamé ; réparation par le locataire non vérifiée → retenue maintenue ; impayés supérieurs à la caution → complément ; test de propriété : total des sorties ≤ caution reçue.
- Retenue sans ligne `tenant_damage`, sans montant ou sans justificatif : refusée (API et synchronisation).
- Imputation sur loyer sans accord accepté, ou accord daté après les mois concernés : refusée.
- Ligne d'état des lieux « bon état » seule : refusée.
- Fin de bail : état technique `to_refurbish`, unité non disponible, annonce impossible ; passage à `ready` : unité disponible.
- Transfert de gestion : ancien mandat terminé, nouveau mandat possible, mouvement `holder_changed` écrit, aucune ligne copiée dans une autre organisation.
- Mouvements de caution : `UPDATE` et `DELETE` refusés.
- Playwright sur les trois appareils : sortie complète d'un locataire, de la date de préavis à la restitution.

## Critères d'acceptation
- [ ] Un gestionnaire réalise sur téléphone un état des lieux de sortie de 4 pièces avec photos, hors ligne, en moins de 15 minutes.
- [ ] L'exemple du porteur produit un décompte de deux lignes justifiées et une restitution de 85 000 FCFA.
- [ ] Une unité ne réapparaît jamais comme disponible tant que le gestionnaire ne l'a pas déclarée prête.
- [ ] Journal des lots mis à jour, avec les réponses du porteur aux questions ouvertes.

## Instructions de travail
Écris d'abord, dans `packages/shared`, le calcul du décompte et les règles de retenue et d'imputation en fonctions pures, avec leurs tests. Présente ensuite le schéma des tables et le diagramme d'états (bail, état des lieux, décompte, unité). Attends la validation avant les écrans.
