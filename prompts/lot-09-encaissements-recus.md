# Lot 09 — Encaissements, imputations et reçus

## Contexte
C'est le geste que l'agence répète le plus : encaisser un loyer et remettre un reçu. Il doit prendre 3 gestes, marcher hors ligne et être inattaquable sur le plan financier. Ce lot crée aussi l'**interface d'adaptateur de paiement** qui recevra les agrégateurs Mobile Money au lot 14 (décision D03).

## Prérequis
Lot 08 terminé. Question au porteur : mentions minimales d'un reçu de loyer (voir `docs/DECISIONS.md`). Proposition par défaut ci-dessous.

## Périmètre
1. **Tables** (module `payments`), cloisonnées, auditées, synchronisées, **ajout seul** (triggers interdisant `UPDATE` des montants et tout `DELETE`) :
   - `payments` : bail, locataire, montant, moyen (`cash`, `mobile_money_manual`, `bank_transfer`, `mobile_money_direct` réservé au lot 14), opérateur (Orange Money, Moov Money, autre), référence de transaction, date de paiement, saisi par, statut, prestataire (`manual` ou clé d'agrégateur), référence prestataire, clé d'idempotence, motif d'annulation, annulé par, paiement d'annulation lié.
   - `payment_allocations` : paiement, cible (échéance **ou compte de caution**), montant. Un versement de caution est un encaissement comme un autre : il a son reçu, et il crée le mouvement `received` du compte de caution (lot 08).
   - `receipts` : paiement, numéro (attribué par le serveur), numéro provisoire (local), date d'émission, statut (`provisional`, `valid`, `cancelled`), jeton de vérification, clé du PDF.
   - `receipt_counters` : compteur par agence et par année, verrouillé en ligne pour garantir la continuité.
2. **Machine d'états du paiement** (source unique dans `packages/shared`) :
   - `to_validate` : espèces saisies par un agent de terrain, en attente du gestionnaire.
   - `to_reconcile` : Mobile Money ou virement saisi à la main, en attente de rapprochement.
   - `confirmed` : espèces saisies ou validées par un gestionnaire ou directeur ; Mobile Money rapproché.
   - `initiated`, `pending`, `failed` : réservés au paiement direct (lot 14).
   - `cancelled` : annulé par contre-écriture.
   Chaque transition autorisée est listée ; toute autre est refusée.
3. **Imputation** : un paiement s'impute sur les échéances **les plus anciennes non soldées** du bail ; un paiement partiel laisse un solde ; un trop-perçu crée un crédit imputé sur l'échéance suivante. L'imputation est faite **par le serveur** à la confirmation (le téléphone affiche une imputation prévisionnelle).
4. **Plafonds** : plusieurs paiements pour une même échéance sont permis (plafonds Mobile Money).
5. **Reçus** :
   - Numéro définitif attribué à la confirmation, continu par agence et par année (`IMMO-2027-000123`). Un reçu créé hors ligne affiche « Reçu provisoire » jusqu'à la synchronisation.
   - PDF généré par tâche BullMQ (pdf-lib), format A6 et format ticket : agence, locataire, unité, période(s) couverte(s), montant en chiffres et en lettres, moyen et référence, solde restant, numéro, date, QR code.
   - Le QR code ouvre une page publique de vérification `/r/<jeton>` qui affiche seulement : agence, numéro, date, montant, statut (valide ou annulé). Aucune autre donnée personnelle.
   - Partage par le partage natif du téléphone (lien du reçu vers WhatsApp ou SMS) ; impression possible.
6. **Annulation** : réservée au directeur (`payment.cancel`), motif obligatoire, crée une contre-écriture, annule les imputations par écritures inverses, marque le reçu « ANNULÉ » sur la page de vérification et le PDF.
7. **Validation et rapprochement** : écran du gestionnaire listant les espèces `to_validate` et les Mobile Money `to_reconcile`, avec validation unitaire ou groupée.
8. **Adaptateur de paiement** : interface `PaymentProvider` (`initiate`, `verify`, `handleWebhook`, `refund` facultatif) et registre des prestataires ; implémentation `manual` uniquement. Documente l'interface dans `docs/PAIEMENTS.md`.
9. **Interrupteurs et réglages** : `payments.registry` protège les endpoints et écrans. Les moyens proposés à l'encaissement sont ceux que l'organisation accepte (réglage D18, lot 04) ; un moyen non accepté est refusé par l'API.
10. **Écran d'encaissement en 3 gestes** : rechercher un locataire (par nom, téléphone ou unité) → montant pré-rempli avec le solde dû, modifiable au clavier numérique → moyen (et référence si Mobile Money) → valider → reçu. Sur ordinateur et tablette en paysage : liste et formulaire côte à côte ; tableau des encaissements avec validation groupée des espèces « à valider » (`docs/UX.md` §4).
11. **Lien du reçu** : le lien partagé par WhatsApp ouvre le reçu (lecture seule, jeton long et révocable) et invite le locataire à créer son compte pour retrouver tout son historique. L'espace locataire avec compte est au lot 10 ter (D13).

## Hors périmètre
Paiement initié depuis la plateforme (lot 14), rapprochement automatique avec un relevé d'opérateur, remboursements, relances (lot 10).

## Tests attendus
- Accès croisé A/B sur chaque table ; un jeton de vérification de A ne révèle rien de B.
- `UPDATE` du montant et `DELETE` refusés sur `payments`, `payment_allocations`, `receipts`.
- Imputation : paiement exact, partiel, trop-perçu, plusieurs échéances en retard, plusieurs paiements pour une échéance ; somme des imputations = montant du paiement (test de propriété).
- Numérotation : 1 000 confirmations concurrentes sans trou ni doublon.
- Paiement saisi hors ligne puis rejoué deux fois : un seul paiement (idempotence).
- Agent de terrain : statut `to_validate` ; ne peut pas confirmer ; le gestionnaire valide.
- Annulation : réservée au directeur, motif obligatoire, échéances ressoldées correctement, reçu marqué annulé.
- Transition d'état interdite refusée (ex. `to_reconcile` → `failed`).
- Moyen de paiement non accepté par l'organisation : absent de l'écran et refusé par l'API.
- Versement de caution en deux fois : deux reçus, deux mouvements `received`, solde restant dû juste.
- Montant en lettres correct (test sur 0, 1, 80 000, 1 250 000, 21 000 000).

## Critères d'acceptation
- [ ] Encaisser et partager un reçu prend 3 gestes jusqu'à la validation, et moins de 20 secondes au total, hors ligne.
- [ ] Le QR code d'un reçu imprimé ouvre la page de vérification.
- [ ] `docs/PAIEMENTS.md` décrit l'interface d'adaptateur et la machine d'états.
- [ ] Journal des lots mis à jour.

## Instructions de travail
Écris d'abord, dans `packages/shared`, la machine d'états et l'algorithme d'imputation en fonctions pures, avec leurs tests. Puis les tables et triggers, puis l'API, puis l'écran.
