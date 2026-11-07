# Lot 08 — Locataires, baux, échéancier et cautions

## Contexte
Le bail relie une unité à un locataire et génère les échéances de loyer. C'est lui qui fait passer l'unité à « louée » et, plus tard, retire l'annonce automatiquement. La caution est suivie à part.

## Prérequis
Lot 07 terminé. **Question ouverte à poser au porteur avant de coder** : plafond légal de la caution et règles d'avance (voir `docs/DECISIONS.md`). En attendant sa réponse, le plafond est un **paramètre d'agence**, par défaut 2 mois de loyer.

## Périmètre
1. **Tables** (module `leases`), cloisonnées, auditées, synchronisées :
   - `tenants` : nom, téléphone, téléphone secondaire, pièce d'identité (document), profession facultative, personne à prévenir facultative, notes, statut.
   - `leases` : unité, locataire, date de début, date de fin facultative, durée, loyer mensuel, charges mensuelles, périodicité (mensuelle au MVP ; prévoir trimestrielle), jour d'échéance (1 à 28), caution convenue, avance convenue en mois, statut (`draft`, `active`, `notice`, `ended`, `cancelled`), date de préavis, date de sortie, bail scanné (document), version.
   - `rent_dues` : bail, période (mois), date d'échéance, montant dû (loyer + charges), montant payé (calculé à partir des imputations du lot 09), solde, statut (`upcoming`, `due`, `partial`, `paid`, `overdue`, `waived`).
   - `deposit_movements` : bail, type (`received`, `retained`, `refunded`), montant, motif, justificatif (document), date. **Ajout seul.**
2. **Règles métier** :
   - **Un seul bail actif par unité** (index unique partiel sur `unit_id` où statut dans `active`, `notice`).
   - Activer un bail fait passer l'unité à `occupied` ; terminer ou annuler un bail la repasse à `vacant`. Ces transitions ne se font que par le bail.
   - À l'activation, génération des échéances jusqu'à la fin du bail, ou sur 12 mois glissants pour un bail sans fin (tâche quotidienne qui prolonge).
   - L'avance perçue à l'entrée se traduit par des échéances marquées comme dues dès la signature (leur paiement se fera au lot 09).
   - Une échéance passe à `overdue` le lendemain de sa date si elle n'est pas soldée (tâche quotidienne).
   - Modifier le loyer d'un bail actif : nouvelle version, effet à partir d'une date ; les échéances déjà émises ne changent pas, les suivantes sont recalculées.
   - Caution : plafond de l'agence vérifié ; retenue impossible sans motif ni justificatif ; restitution plus retenues ne dépassent jamais la caution reçue.
   - Fin de bail : préavis (date), état des lieux (document), mouvements de caution, solde final ; l'unité redevient `vacant`.
   - Vente du bien en cours de bail (changement de propriétaire) : le bail continue ; l'historique est conservé. Prévoir la règle, sans écran dédié au MVP.
3. **Écrans** : liste des locataires, fiche locataire (baux, solde), création d'un bail en un parcours depuis une unité libre (choisir ou créer le locataire, conditions, documents), fiche bail (échéancier, caution, documents, historique), fin de bail guidée.
4. **Permissions** : `lease.create`, `lease.update`, `lease.end`, `deposit.move` (directeur, gestionnaire) ; agent de terrain en lecture sur ses unités.

## Hors périmètre
Encaissements et imputations (lot 09), relances (lot 10), génération d'un contrat de bail (modèles juridiques à valider plus tard), indexation automatique des loyers, colocation.

## Tests attendus
- Accès croisé A/B sur chaque table.
- Deux baux actifs sur la même unité : refusé (y compris par deux appareils hors ligne qui se synchronisent l'un après l'autre : le second est refusé et signalé).
- Transitions de statut de l'unité uniquement par le bail.
- Génération des échéances : bail de 12 mois, bail sans fin, bail commençant le 31, jour d'échéance 28, changement de loyer en cours de bail.
- Passage en `overdue` à la bonne date.
- Caution : plafond respecté ; retenue sans justificatif refusée ; total des sorties ≤ caution reçue ; mouvements non modifiables.
- Montants : uniquement des entiers FCFA.

## Critères d'acceptation
- [ ] Depuis une unité libre, un gestionnaire crée un bail complet (nouveau locataire, caution, avance, bail scanné) en moins de 3 minutes.
- [ ] L'échéancier d'un bail est juste sur 24 mois, vérifié par un test de propriété (génération aléatoire de baux).
- [ ] Journal des lots mis à jour, avec la réponse du porteur sur le plafond de caution.

## Instructions de travail
Commence par écrire la génération d'échéances comme fonction pure dans `packages/shared`, avec ses tests, avant toute table.
