# Lot 08 — Locataires, baux, échéancier et comptes de caution

## Contexte
Le bail relie une unité à un locataire et génère les échéances de loyer. C'est lui qui détermine l'occupation calculée de l'unité (D14) et, plus tard, retire l'annonce automatiquement. La caution a son propre compte (D15). La sortie du locataire (préavis, états des lieux, décompte) est au lot 10 bis.

## Prérequis
Lot 07 terminé. **Questions ouvertes à poser au porteur avant de coder** (voir `docs/DECISIONS.md`) : avertir ou bloquer au-delà de deux mois de caution ; qui détient la caution en pratique ; modèle de bail validé par un juriste. Par défaut : avertissement journalisé au-delà de deux mois (loi n° 103-2015/CNT, article 26), sans blocage.

## Périmètre
1. **Tables** (module `leases`), cloisonnées, auditées, synchronisées :
   - `tenants` : nom, téléphone, téléphone secondaire, pièce d'identité (document), profession facultative, personne à prévenir facultative, notes, statut.
   - `leases` : unité, locataire, date de début, date de fin facultative, durée, loyer mensuel, charges mensuelles, périodicité (mensuelle au MVP ; prévoir trimestrielle), jour d'échéance (1 à 28), caution convenue, avance convenue en mois, statut (`draft`, `active`, `notice`, `ended`, `cancelled`), date de préavis et date de sortie (remplies au lot 10 bis), bail scanné (document), version.
   - `rent_dues` : bail, période (mois), date d'échéance, montant dû (loyer + charges), montant payé (calculé à partir des imputations du lot 09), solde, statut (`upcoming`, `due`, `partial`, `paid`, `overdue`, `waived`).
   - `deposit_accounts` : bail, montant convenu en FCFA, nombre de mois correspondant (information), **détenteur** (`organization` ou `owner`), statut (`pending`, `partially_received`, `held`, `settling`, `closed`). Solde reçu et solde restant dû calculés à partir des mouvements.
   - `deposit_movements` : compte, type (`received`, `retained`, `applied_to_rent`, `refunded`, `additional_claimed`, `holder_changed`), montant, motif, justificatif (document), accord lié, ligne d'état des lieux liée, paiement lié, date, auteur. **Ajout seul (trigger).** Au lot 08, seul `received` est créé (manuellement, en attendant le lot 09 qui le reliera à un encaissement avec reçu) ; les autres types sont prévus dans le schéma et utilisés au lot 10 bis.
2. **Règles métier** :
   - **Un seul bail actif par unité** (index unique partiel sur `unit_id` où statut dans `active`, `notice`).
   - L'occupation de l'unité est **calculée** à partir de ses baux (fonction pure du lot 07, complétée ici) : bail signé dont la date de début est future → `reserved` ; bail `active` → `occupied` ; bail `notice` → `notice` ; aucun → `free`. **La fin d'un bail (lot 10 bis) fait passer l'état technique à `to_refurbish`**, jamais directement à disponible.
   - À l'activation, génération des échéances jusqu'à la fin du bail, ou sur 12 mois glissants pour un bail sans fin (tâche quotidienne qui prolonge).
   - L'avance perçue à l'entrée se traduit par des échéances marquées comme dues dès la signature (leur paiement se fera au lot 09).
   - Une échéance passe à `overdue` le lendemain de sa date si elle n'est pas soldée (tâche quotidienne).
   - Modifier le loyer d'un bail actif : nouvelle version, effet à partir d'une date ; les échéances déjà émises ne changent pas, les suivantes sont recalculées.
   - Caution : au-delà de deux mois de loyer, avertissement explicite et ligne d'audit ; le versement peut se faire en plusieurs fois ; l'**avance** n'est pas une caution (ce sont des échéances payées d'avance).
   - Vente du bien en cours de bail (changement de propriétaire) : le bail continue ; l'historique est conservé. Prévoir la règle, sans écran dédié au MVP.
3. **Bail en PDF** : si le porteur a fourni avant le lot un modèle de bail validé par un juriste, génère le bail en PDF (pdf-lib, tâche BullMQ) à imprimer, signer et légaliser à la mairie ; sinon, bail scanné seulement. Pas de signature électronique (loi n° 103-2015/CNT, article 5).
4. **Écrans** : liste des locataires, fiche locataire (baux, solde), création d'un bail en assistant depuis une unité disponible (choisir ou créer le locataire, conditions, caution et détenteur, avance, documents), fiche bail avec chronologie (`docs/UX.md` §10 : échéancier, compte de caution, documents, historique).
5. **Permissions** : `lease.create`, `lease.update`, `deposit.receive` (directeur, gestionnaire) ; agent de terrain en lecture sur ses unités.

## Hors périmètre
Encaissements et imputations (lot 09), relances (lot 10), préavis, états des lieux, décompte de sortie et transfert de gestion (lot 10 bis), signature électronique, indexation automatique des loyers, colocation.

## Tests attendus
- Accès croisé A/B sur chaque table.
- Deux baux actifs sur la même unité : refusé (y compris par deux appareils hors ligne qui se synchronisent l'un après l'autre : le second est refusé et signalé).
- Occupation calculée juste pour chaque combinaison de baux (réservé, actif, préavis, terminé) ; impossible à écrire.
- Génération des échéances : bail de 12 mois, bail sans fin, bail commençant le 31, jour d'échéance 28, changement de loyer en cours de bail.
- Passage en `overdue` à la bonne date.
- Compte de caution : avertissement et audit au-delà de deux mois ; versements partiels et solde restant dû justes ; `UPDATE` et `DELETE` refusés sur `deposit_movements` ; détenteur obligatoire.
- Montants : uniquement des entiers FCFA.

## Critères d'acceptation
- [ ] Depuis une unité disponible, un gestionnaire crée un bail complet (nouveau locataire, caution et détenteur, avance, bail scanné) en moins de 3 minutes.
- [ ] L'échéancier d'un bail est juste sur 24 mois, vérifié par un test de propriété (génération aléatoire de baux).
- [ ] Journal des lots mis à jour, avec les réponses du porteur aux questions ouvertes.

## Instructions de travail
Commence par écrire la génération d'échéances comme fonction pure dans `packages/shared`, avec ses tests, avant toute table.
