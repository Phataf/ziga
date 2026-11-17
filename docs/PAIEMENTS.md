# Encaissements, reçus et adaptateurs de paiement

Référence du module `payments` (lot 09, décisions D03, D18 et D29). Règles de `CLAUDE.md` concernées : 2 (montants en entiers FCFA), 3 (ajout seul, contre-écriture), 4 (journal), 5 (la plateforme ne détient jamais les fonds), 6 (confirmé seulement sur preuve), 9 (numérotation continue par le serveur) et 10 (désactiver ne supprime rien).

Les règles sont écrites une seule fois, en fonctions pures, dans `packages/shared` :

| Fichier | Contenu |
| --- | --- |
| `payments.ts` | moyens, opérateurs, machine d'états, statut à la saisie, contrôles d'une saisie, doublon Mobile Money, jetons, schémas |
| `allocation.ts` | imputation, crédit du bail, contre-écriture, imputation prévisionnelle |
| `receipts.ts` | numérotation, réglages, contenu du reçu (le même pour le PDF et l'écran) |

La base (migration `0015_payments`) applique les mêmes règles en dernier rempart : triggers, contraintes, index uniques partiels.

## 1. Machine d'états

| De | Vers | Qui, sur quelle preuve |
| --- | --- | --- |
| (saisie) | `to_validate` | espèces saisies par un agent de terrain |
| (saisie) | `to_reconcile` | Mobile Money saisi à la main, ou virement, quel que soit le rôle |
| (saisie) | `confirmed` | espèces saisies par la direction ou la gestion |
| (saisie) | `initiated` | paiement direct (lot 14) |
| `to_validate` | `confirmed` | validation : `payment.validate` (direction, gestion) |
| `to_reconcile` | `confirmed` | rapprochement : `payment.validate` |
| `to_validate`, `to_reconcile`, `confirmed` | `cancelled` | annulation motivée : `payment.cancel` (directeur) |
| `initiated` | `pending`, `confirmed`, `failed` | prestataire (lot 14) |
| `pending` | `confirmed`, `failed` | prestataire (lot 14) |

- `failed` et `cancelled` sont terminaux.
- Toute autre transition est refusée avec le code `PAYMENT_TRANSITION_FORBIDDEN`, par `packages/shared` puis par la base (`payment_transition_allowed`, comparée à `PAYMENT_TRANSITIONS` par un test).
- **Le statut n'est jamais envoyé par l'appareil.** Le serveur le décide avec le prestataire (`initialPaymentStatus` pour `manual`), et la base refuse un statut de saisie incohérent avec le moyen (`PAYMENT_INITIAL_STATUS`).
- **`confirmed` exige une preuve** :
  - une personne habilitée (registre manuel) ;
  - ou, au lot 14, une notification signée ou une vérification auprès du prestataire, jamais la seule redirection du client.

## 2. Adaptateur de paiement

`apps/api/src/modules/payments/payment-provider.ts` :

```ts
interface PaymentProvider {
  readonly key: string;                       // 'manual', ou la clé d'un agrégateur (lot 14)
  initiate(input): Promise<{ status; providerReference; redirectUrl? }>;
  verify(payment): Promise<{ status; providerReference }>;
  handleWebhook(headers, rawBody): Promise<{ paymentId; status; providerReference }>;
  refund?(payment): Promise<{ providerReference }>;
}
```

- **Registre** (`PaymentProviders`) : un prestataire par clé. Le lot 09 n'inscrit que `manual`, le registre des encaissements saisis à la main :
  - `initiate` donne le statut de départ (règle 6) ;
  - `verify` ne change rien, car la preuve est une validation humaine ;
  - `handleWebhook` est refusé (`WEBHOOK_UNSUPPORTED`).
- **Lot 14** : chaque agrégateur (CinetPay, Ligdicash, PayDunya…) implémente la même interface.
  - Il encaisse sur le **compte marchand de l'organisation**, avec ses identifiants à elle, chiffrés (règle 5).
  - `handleWebhook` vérifie la signature **avant** de lire le corps.
  - Le prestataire de l'encaissement est enregistré dans `payments.provider`, sa référence dans `payments.provider_reference`, écrite une seule fois.
  - Couper `payments.direct` bloque les nouveaux paiements initiés, mais les notifications des paiements déjà initiés sont encore traitées (règle 10).

## 3. Saisie

`POST /payments` en ligne, ou `PUT payments` depuis l'appareil : même service, même schéma (`paymentEntrySchema`).

- **Un seul objet par encaissement** : le loyer d'un bail, ou le versement sur un compte de caution.
  - « Caution et avance » à la signature : une seule saisie qui crée deux encaissements et deux reçus, dans une même transaction (`paymentEntriesSchema`).
- **Contrôles**, dans cet ordre :
  1. droit du rôle selon le moyen : l'agent de terrain n'encaisse que des espèces, sur les baux de ses unités, et jamais une caution ;
  2. moyen accepté par l'organisation (D18, `PAYMENT_METHOD_NOT_ACCEPTED`) ;
  3. date du paiement pas dans le futur ;
  4. bail signé, en vigueur ou terminé ;
  5. caution jamais au-delà du montant convenu, versements en attente compris (`DEPOSIT_OVERPAID`) ;
  6. doublon Mobile Money (§6).
- **Interrupteur** : `payments.registry` garde toutes les routes et l'écriture depuis l'appareil.
- **Abonnement échu** : il ne bloque pas l'encaissement. Les reçus restent possibles (lot 04).
- **Idempotence** : la clé de l'opération (module `sync`), puis l'identifiant de l'encaissement. Un rejeu renvoie le premier enregistrement et ne crée rien.
- **Reçu** : créé avec l'encaissement, provisoire (`PROV-XXXXXX`).
  - Sur l'appareil, le connecteur joint au `PUT` l'identifiant du reçu, son numéro provisoire et ses deux jetons (`op.receipt`), lus dans la table locale non synchronisée.
  - La base ne garde que l'empreinte des jetons.

## 4. Imputation (faite par le serveur, à la confirmation)

- **Loyer** : les échéances ouvertes **les plus anciennes d'abord** (date d'échéance, puis début de période), à venir comprises. Un trop-perçu va donc sur l'échéance suivante.
- **Crédit du bail** : ce qui reste quand aucune échéance n'est ouverte devient un crédit, rattaché à son encaissement. Il est imputé sur chaque nouvelle échéance :
  - à la validation du bail, au changement de loyer et au renouvellement ;
  - quand la tâche de nuit prolonge un bail sans fin.
  - Le module `leases` annonce ces émissions (`RentDueEvents`), et le module `payments` y impute le crédit, le plus ancien d'abord. L'imputation s'écrit sur l'encaissement d'origine : une ligne `credit` en sens `reverse`, et une ligne `rent_due` en sens `allocate`.
- **Caution** : une ligne sur le compte. La base crée le mouvement `received` lié à l'encaissement.
- **Montant payé d'une échéance** : c'est la somme nette des imputations, tenue par la base, jamais saisie (`RENT_DUE_PAID_BY_ALLOCATIONS`). Il ne dépasse jamais le montant dû.
- **Statut des échéances touchées** : recalculé par la règle de `packages/shared`, `rentDueStatus`. Avance et premier mois incomplet dus à la signature, en retard seulement à partir du début du bail.
- **Invariant**, vérifié par un test de propriété et par la base, à la validation de chaque transaction (trigger différé) :
  - un encaissement confirmé impute exactement son montant ;
  - un encaissement en attente ou annulé n'impute rien ;
  - aucun crédit n'est négatif.
- **Appareil** : il affiche une imputation **prévisionnelle** (`forecastRentAllocation`), avec la même fonction. Le serveur refait le calcul et fait foi.

## 5. Annulation (contre-écriture)

Elle est réservée au directeur (`payment.cancel`), avec un motif obligatoire, et se fait en ligne.

- **Statut** : `cancelled`, avec l'auteur, la date et le motif, écrits une seule fois.
- **Encaissement confirmé** :
  - une ligne inverse par cible, et un paiement de contre-écriture lié (`kind = 'reversal'`, même montant, jamais imputé) ;
  - un crédit déjà imputé sur une échéance suivante est contrepassé avec elle : l'échéance redevient due ou en retard. Le crédit ne devient jamais négatif ;
  - les autres encaissements ne sont pas réimputés ;
  - caution : mouvement `received_cancelled`, refusé s'il ferait passer le reçu sous les sorties déjà faites (`DEPOSIT_CANCELLATION_BELOW_OUTFLOWS`, règle 14).
- **Reçu** : `cancelled`. Il garde son numéro (aucun trou). La page de vérification affiche « annulé », et le PDF est régénéré avec « ANNULÉ » en tête et en filigrane.
- **Encaissement en attente** : il n'a rien d'imputé. Il est seulement annulé, et son reçu provisoire aussi.

## 5 bis. Encaissement d'une dépense réclamée au locataire (lot 10, option A du porteur)

- Objet `expense` : l'encaissement vise une dépense réclamée au locataire de ce bail (`expenses.recovery = 'claimed_from_tenant'`), non annulée (`PAYMENT_EXPENSE_NOT_CLAIMED`, `PAYMENT_EXPENSE_CANCELLED`). La dépense **est** la créance : aucune copie (règle 16).
- Imputation exacte sur cette dépense (cible `expense`), jamais en crédit ni sur une échéance (`ALLOCATION_PURPOSE`), jamais au-delà de son montant, tous encaissements confondus (`EXPENSE_OVERPAID`).
- Contre-écriture comme pour un loyer ; une dépense en partie remboursée, ou dont un encaissement attend sa validation, ne s'annule pas (`EXPENSE_CLAIM_RECOVERED`, `EXPENSE_CLAIM_PENDING`).
- L'argent revient à l'organisation qui a avancé la dépense : il n'entre jamais dans le relevé du propriétaire.
- Reçu « Remboursement de dépense » (objet `expense` accepté par la base) ; routes et écran à l'étape 3 du lot 10.

## 6. Doublon Mobile Money

- **Règle** : une même référence de transaction chez le même opérateur ne se saisit pas deux fois dans une organisation, sauf si le paiement précédent est annulé.
- **Référence normalisée** : majuscules, sans espaces ni séparateurs (`normalizeTransactionReference`). La base calcule la même dans une colonne générée (`reference_key`).
- **Refus nommé** : `MOBILE_MONEY_REFERENCE_DUPLICATE`. Il est vérifié par le service, puis par l'index unique partiel `payments_mobile_money_reference`, qui tranche deux appareils hors ligne.
- **À la synchronisation** : le refus est rangé dans « Modifications non acceptées ».

## 7. Reçus

- **Numéro** : `PRÉFIXE-AAAA-NNNNNN`, attribué **par la base** au passage `provisional` → `valid`, et seulement pour un encaissement confirmé.
  - Le compteur (`receipt_counters`) est verrouillé, sous le verrou de l'organisation.
  - La suite est continue, sans trou ni doublon, par organisation et par année. Un retour arrière rend le numéro.
  - Testé avec 1 000 confirmations concurrentes.
- **Préfixe** : 2 à 6 lettres majuscules.
  - Sans réglage, les initiales du nom sont posées au premier reçu, et ce réglage est journalisé.
  - Le directeur peut le changer jusqu'au premier reçu, puis il est figé.
  - Un changement exceptionnel passe par le back-office : `PUT /admin/organizations/:id/receipt-prefix`, rôle super administrateur, motif obligatoire, journalisé chez l'organisation.
- **Premier numéro** : fixé une seule fois, pour l'année en cours, avant le premier reçu, pour continuer un carnet papier (`set_receipt_first_number`).
- **Copie figée** (D29), à l'émission : organisation (nom, adresse, boîte postale, téléphone, RCCM et IFU s'ils existent, version du logo), locataire, unité et adresse, objet (périodes couvertes et crédit, ou dépôt de garantie et son détenteur), montant, moyen et référence, date du paiement, solde restant dû et personne qui a encaissé.
- **Document** : toujours « Reçu de paiement », jamais « quittance ». Le contenu vient de `receiptDocument` (packages/shared), le même pour le PDF et pour l'écran.
- **PDF** : produit par une tâche BullMQ (`receipts`), avec pdf-lib.
  - Formats : A6, et ticket de 58 ou 80 mm (réglage de l'organisation, 80 mm par défaut).
  - Le QR code est dessiné à partir de la matrice d'uqr.
  - Chaque génération écrit de nouveaux fichiers : rien n'est écrasé.
  - Téléchargement par URL signée de 5 minutes, journalisé (`receipt.download`).

## 8. Jetons et pages publiques

- **Deux jetons par reçu**, de 256 bits, tirés par `crypto.getRandomValues` sur l'appareil, pour partager hors ligne. La base n'en garde que l'**empreinte SHA-256** (`receipt_tokens`).
  - **Vérification** : dans le QR code. Le worker en crée aussi un pour chaque PDF. Un reçu peut en avoir plusieurs, tous valables : un QR code déjà imprimé ne cesse jamais de marcher. Ce jeton n'est jamais révoqué.
  - **Partage** : dans le lien WhatsApp. Il est révocable (`POST /receipts/:id/share-token/revoke`), et un nouveau lien se crée en ligne (`POST /receipts/:id/share-token`).
  - **Reçu saisi sur un autre appareil** : l'appareil n'a pas ses jetons. `POST /receipts/:id/tokens` (en ligne, toute personne qui lit ce reçu) crée un nouveau jeton de vérification, sans retirer les précédents, et un nouveau jeton de partage ; ils ne sont renvoyés qu'à cette réponse et l'appareil les garde dans sa table locale. Chaque création est journalisée (`receipt.verification_token`, `receipt.share_link`).
- **`GET /public/receipts/verify/:token`** (page `/r/<jeton>`) : organisation, numéro, date, montant et statut. Aucune autre donnée.
- **`GET /public/receipts/shared/:token`** (page `/recu/<jeton>`) : le reçu en lecture seule, ou `{ state: 'pending' }`, affiché « Reçu en cours d'enregistrement » tant que le reçu n'est pas synchronisé.
- **Les deux pages** :
  - limite de débit par adresse IP (`RECEIPT_PUBLIC_RATE_PER_MINUTE`, 30 par défaut) ;
  - `Cache-Control: no-store`, donc aucun cache Cloudflare ;
  - `X-Robots-Tag: noindex, nofollow` et `Referrer-Policy: no-referrer`.
- **Recherche par empreinte exacte**, par deux fonctions de la base qui ne renvoient que le strict nécessaire (`receipt_verification`, `receipt_share_target`). Un jeton d'une organisation ne révèle rien d'une autre.

## 9. Routes

| Route | Permission |
| --- | --- |
| `GET /payments` (curseur, filtres statut et bail), `GET /payments/:id` | `payment.read` |
| `POST /payments` (une ou deux saisies) | `payment.record_cash`, puis le moyen précis |
| `POST /payments/validate` (unitaire ou groupée, un refus n'arrête pas les autres) | `payment.validate` |
| `POST /payments/:id/cancel` | `payment.cancel` (directeur) |
| `GET /receipts/:id/pdf?format=a6|ticket` | `payment.read` |
| `POST /receipts/:id/share-token`, `POST /receipts/:id/share-token/revoke` | `receipt.share` |
| `POST /receipts/:id/tokens` | `payment.read` (en ligne) |
| `GET /organization/receipt-settings` | `payment.read` |
| `PUT /organization/receipt-settings` (préfixe, premier numéro, ticket) | `receipt.settings` (directeur) |
| `GET /public/receipts/verify/:token`, `GET /public/receipts/shared/:token[/pdf]` | aucune (jeton) |
| `PUT /admin/organizations/:id/receipt-prefix` | `receipt.prefix_override` (plateforme) |
