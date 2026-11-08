# Lot 10 ter — Espaces propriétaire et locataire avec compte, regroupant toutes les organisations

## Contexte
Décisions D13 et D17 ; règle 15 de `CLAUDE.md`. **Dès le lancement**, un propriétaire doit voir dans un seul espace tous ses logements, qu'ils soient confiés à l'agence A, à l'agence B (toutes deux utilisatrices de la plateforme) ou gérés par lui-même. Un locataire doit retrouver tout son historique (baux, reçus, cautions, décomptes), même s'il a changé de logement et d'agence.

**Ce lot ne partage aucune information entre organisations.** Chaque organisation garde sa propre fiche ; c'est la **personne** qui voit l'ensemble de ses propres données, en lecture seule, à travers les fiches que chaque organisation a acceptées de lier à son compte. Aucune organisation ne voit les baux, paiements ou fiches d'une autre, ni directement, ni par attestation.

## Prérequis
Lot 10 bis terminé. Questions au porteur : prestataire SMS réel (coût, couverture) ; formalités liées à la nouvelle loi sur les données personnelles (voir `docs/DECISIONS.md`).

## Périmètre
1. **Liaison d'une fiche à une personne** (module `organizations`) :
   - Table `person_links` (cloisonnée par organisation, auditée) : organisation, personne (`user_id`), type de fiche (`owner`, `tenant`), fiche, statut (`requested`, `active`, `revoked`), téléphone vérifié le, accepté par, révoqué par et motif.
   - Deux chemins : (a) l'organisation invite depuis la fiche (lien envoyé par WhatsApp ou SMS) ; (b) la personne demande la liaison depuis son espace. Dans les deux cas : **code SMS envoyé au numéro de la fiche** et **acceptation par l'organisation**. Un numéro différent de celui de la fiche est refusé.
   - L'organisation peut révoquer un lien à tout moment ; la personne aussi. Révoquer ne supprime rien.
   - Adaptateur SMS réel branché derrière `SmsSender` (lot 02) si le porteur a choisi le prestataire ; sinon l'implémentation `console` reste en développement.
2. **Module `portals`** (lecture seule) :
   - Parcourt les liens `active` de la personne et lit chaque organisation **l'une après l'autre**, dans son propre `withOrganization`, uniquement les données de la fiche liée. Aucune requête ne lit deux organisations à la fois.
   - Chaque lecture est journalisée (origine `portal`). Aucune écriture, sauf : signalement, demande de préavis et observation sur un décompte, enregistrés **dans l'organisation concernée** comme demandes à traiter.
   - Respecte les interrupteurs `portals.owner_space` et `portals.tenant_space`, et l'interrupteur de chaque organisation lue.
   - Lecture serveur à la demande (ces espaces ne sont pas synchronisés hors ligne au MVP), avec cache court et pagination par curseur.
3. **Espace propriétaire** (`/espace/proprietaire`, `docs/UX.md` §2 et §10) :
   - Patrimoine : tous ses biens, groupés par gestionnaire (agence A, agence B, gestion directe), avec pour chaque unité sa disponibilité, son loyer, son bail en cours (sans les coordonnées du locataire), la caution détenue et par qui.
   - Revenus : loyers encaissés, commissions, dépenses, net et reversements, par mois et par bien ; rendement simple par bien.
   - Relevés de chaque organisation ; reversements enregistrés.
   - Les biens gérés directement par lui proviennent de son organisation de bailleur, s'il en a une.
4. **Espace locataire** (`/espace/locataire`) :
   - Mon logement actuel : solde, prochaine échéance, contact de l'organisation, bail (PDF ou scan).
   - Historique toutes agences confondues : chronologie unique de ses baux, échéances, reçus, cautions et décomptes, chaque élément indiquant l'organisation concernée.
   - Caution et décompte : montant versé, détenteur, lignes du décompte avec leurs justificatifs, accords, observation possible en cas de désaccord.
   - Signalements suivis (reçu, planifié, fait) et demande de préavis, transmis à l'organisation.
   - Le bouton « Payer par Mobile Money » s'affiche désactivé, avec une explication, tant que `payments.direct` est coupée pour l'organisation.
5. **Liens existants** : les liens de reçu (`/r/`) et de relevé (`/s/`) restent valables et proposent de créer un compte.
6. **Choix de l'espace** : une personne qui est aussi membre d'une organisation, ou propriétaire et locataire à la fois, choisit son espace dans le menu du compte.

## Hors périmètre
Attestation ou tout partage d'historique entre organisations (refusé par D17), écriture directe par le propriétaire ou le locataire dans le registre, synchronisation hors ligne de ces espaces, approbation des dépenses par le propriétaire, paiement direct (lot 14).

## Tests attendus
- **Isolement** : la personne P, liée à une fiche propriétaire dans A et dans B, voit ses biens de A et de B ; un membre de A ne voit rien de B, ni par l'API, ni par SQL avec le rôle `app_api`, ni par la synchronisation ; le module `portals` n'exécute aucune requête qui porte sur deux organisations.
- Liaison : numéro différent refusé ; code expiré refusé ; lien non accepté par l'organisation sans effet ; lien révoqué : les données disparaissent de l'espace immédiatement.
- Locataire passé de A à B : son espace montre les deux baux ; l'agence B ne voit pas le bail de A.
- Le propriétaire ne voit jamais le téléphone ni la pièce d'identité d'un locataire.
- Interrupteur `portals.owner_space` coupé : espace inaccessible, liens de relevé toujours valables.
- Chaque lecture du module `portals` écrit une ligne d'audit dans l'organisation lue.
- Playwright sur les trois appareils : propriétaire avec des biens dans deux agences et en gestion directe ; locataire avec deux baux successifs dans deux agences.

## Critères d'acceptation
- [ ] Un propriétaire lié à deux agences et à sa propre organisation voit tous ses biens sur un même écran, avec le gestionnaire de chacun, en moins de 3 secondes en 3G.
- [ ] Un locataire retrouve le reçu d'un loyer payé à son ancienne agence depuis son téléphone.
- [ ] Le test d'isolement du module `portals` passe et fait partie de la CI.
- [ ] Journal des lots mis à jour.

## Instructions de travail
Présente d'abord le schéma de `person_links`, le diagramme de liaison (invitation, code SMS, acceptation, révocation) et l'interface du module `portals` (quelles données, de quelles tables, par quels services publics des autres modules). Écris le test d'isolement avant le code. Attends la validation.
