# Lot 05 — Synchronisation hors ligne (socle PowerSync)

## Contexte
Décision D07 : l'application des organisations lit ses données dans une base SQLite du téléphone et se synchronise en arrière-plan. Ce lot met en place le mécanisme sur les données déjà existantes (agence, membres, fonctionnalités) et fixe le **modèle que tous les modules métier suivront**. C'est le lot le plus technique : avance par petites étapes vérifiées.

## Prérequis
Lot 04 terminé. Lis la documentation actuelle de PowerSync (service auto-hébergé, SDK web, règles de synchronisation, connecteur d'envoi) avant de proposer le plan.

## Périmètre
1. **Service PowerSync** ajouté à `infra/docker-compose.dev.yml`, branché sur PostgreSQL par réplication logique (publication dédiée), avec son stockage interne.
2. **Authentification du client auprès de PowerSync** : l'API émet un jeton dédié (JWT signé, clés exposées par un endpoint JWKS) contenant l'utilisateur et la liste de ses organisations actives.
3. **Règles de synchronisation** (`infra/powersync/`) : un utilisateur ne reçoit que les lignes de ses organisations actives. Données synchronisées dans ce lot : son organisation, les membres de son organisation (sans données sensibles), l'état effectif de ses fonctionnalités.
4. **Client** (`apps/web/src/lib/sync/`) : base SQLite locale, schéma local généré ou maintenu à côté du schéma Drizzle (documenter comment les garder alignés), connexion et reconnexion automatiques, indicateur d'état dans l'en-tête (« À jour », « Hors ligne », « N modifications en attente »).
5. **Chemin d'écriture** : les écritures sont appliquées localement puis mises en file. Le connecteur les envoie à l'API (`POST /sync/upload`) par lots, avec une clé d'idempotence par opération. L'API rejoue chaque opération dans `withOrganization`, avec les **mêmes** validations Zod, permissions, interrupteurs et audit (origine `sync`) que l'API classique.
6. **Gestion des refus** : une opération refusée par le serveur (permission, interrupteur coupé, validation, conflit) est retirée de la file, l'état local est corrigé par la synchronisation suivante, et l'utilisateur voit une notification claire avec le motif. Rien n'est perdu en silence : les opérations refusées sont conservées dans une liste consultable « Modifications non acceptées ».
7. **Politique de conflits** documentée dans `docs/SYNC.md` :
   - Créations : pas de conflit (UUIDv7 générés côté client).
   - Modifications : dernière écriture gagnante **par champ**, sauf règle métier contraire, validée côté serveur.
   - Encaissements et toute écriture financière : **ajout seul**, jamais de modification, donc pas de conflit (préparé pour le lot 09).
8. **Modèle de référence** pour les lots suivants : exemple complet sur la modification du nom commercial de l'agence (lecture locale, écriture locale, envoi, validation serveur, audit, refus si l'utilisateur n'est pas directeur).
9. **Déconnexion et changement d'organisation** : la base locale de l'utilisateur est vidée à la déconnexion ; changer d'organisation ne mélange jamais les données.

## Hors périmètre
Tables métier (lots 06 et suivants), médias hors ligne (lot 07), mode hors ligne de la vitrine.

## Tests attendus
- Un utilisateur de A ne reçoit **aucune** ligne de B (test d'intégration sur les règles de synchronisation).
- Écriture hors ligne puis reconnexion : la modification arrive en base, avec une ligne d'audit d'origine `sync`.
- Même opération envoyée deux fois : appliquée une seule fois.
- Opération refusée (gestionnaire qui modifie le nom de l'agence) : l'état local revient à la valeur serveur et la modification apparaît dans « Modifications non acceptées ».
- Fonctionnalité coupée pendant que l'appareil est hors ligne : l'opération est refusée à la reconnexion avec le code `FEATURE_DISABLED`.
- Membre retiré d'une organisation : ses données locales de cette organisation disparaissent à la synchronisation suivante.
- Déconnexion : base locale vide.
- Playwright : passer hors ligne (émulation), modifier, revenir en ligne, constater la synchronisation.

## Critères d'acceptation
- [ ] Ouverture d'un écran de l'application sans appel réseau (vérifié dans l'onglet réseau ou par test).
- [ ] Délai de synchronisation inférieur à 5 secondes une fois en ligne, en local.
- [ ] `docs/SYNC.md` décrit le modèle à suivre, étape par étape, pour ajouter une table synchronisée.
- [ ] Journal des lots mis à jour, avec les limites connues de PowerSync rencontrées.

## Instructions de travail
Procède en 4 étapes validées une à une : (1) service PowerSync et réplication, (2) lecture synchronisée, (3) chemin d'écriture et idempotence, (4) refus et conflits. Montre le résultat de chaque étape avant de passer à la suivante.
