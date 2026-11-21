# Sortie du locataire : préavis, états des lieux, décompte de caution, remise en état, transfert de gestion

Référence du lot 10 bis. Décisions D14, D15, D16 et D32 ; règles 1, 3, 4, 12, 13, 14, 15 et 16 de `CLAUDE.md`. Lecture de la loi n° 103-2015/CNT (articles 3, 8, 9, 20, 26, 45 et 46, `docs/AUDIT.md` §C1) **à confirmer par un juriste**.

Les règles sont écrites une seule fois, en fonctions pures, dans `packages/shared` ; l'API les applique avant d'écrire, la synchronisation en écriture passe par les mêmes services, et la base (migrations `0019_tenant_exit` et `0020_exit_api`) les applique en dernier rempart.

| Fichier | Contenu |
| --- | --- |
| `packages/shared/src/tenant-exit.ts` | préavis et indemnité, dernières échéances, fin de bail, état des lieux, catalogue, réparations, accords, transfert de gestion |
| `packages/shared/src/deposit-settlement.ts` | décompte de sortie, refus nommés de chaque ligne, mouvements de clôture, délai et alerte de restitution |
| `packages/shared/src/exit-schemas.ts` | schémas Zod des routes et de la synchronisation, libellés des signatures |
| `apps/api/src/modules/leases/exit.service.ts` | service de la sortie (module `leases`) |
| `apps/api/src/modules/leases/exit.controller.ts` | routes |
| `apps/api/src/modules/leases/exit.sync.ts` | synchronisation en écriture |
| `apps/api/src/modules/leases/exit-hooks.ts` | ce que le module `leases` demande aux modules `payments` et `collections` |
| `apps/api/src/modules/leases/leases-daily.ts` | tâche du jour (fin des baux, alertes de restitution) |

## 1. Préavis

- Un congé (`POST /leases/:id/notice`, `lease.notice`) n'existe que sur un bail en vigueur ; il fait passer le bail en `notice`. Origine (locataire, bailleur), mode de notification (lettre recommandée, acte d'huissier, remise en main propre, autre), preuve (document), date de notification, date de sortie prévue, motif, préavis réduit.
- Les délais viennent des paramètres du bail (lot 08, D24) : le loyer court jusqu'à la fin du préavis (`rentEndsOn`), sauf préavis réduit. Un congé du bailleur plus court que le délai est refusé (`NOTICE_LESSOR_TOO_SHORT`) ; le préavis réduit n'est admis que s'il est prévu au bail et jamais pour le bailleur (`NOTICE_REDUCED_NOT_IN_LEASE`, `NOTICE_REDUCED_LESSOR`).
- Départ anticipé : l'indemnité prévue au bail est **calculée et enregistrée** sur le congé, jamais facturée automatiquement (question au juriste, `docs/DECISIONS.md`).
- Une demande faite par le locataire depuis son espace (lot 10 ter) est une demande à traiter, jamais un congé.

## 2. Tâche du jour

La tâche quotidienne (`leases-daily`, worker BullMQ, une transaction par organisation, `due_lease_organizations`) fait, pour chaque bail en préavis dont la date de sortie est atteinte :

1. **dernières échéances** : l'échéancier du bail est recalculé avec la date de fin du loyer ; la période qui la contient est ramenée **au prorata, selon le mode du bail**, une seule fois (`exit_adjusted_at`) ; les échéances suivantes sont **abandonnées** (`waived`) ; un surplus déjà payé sur une période raccourcie ou abandonnée revient au **crédit du bail** (argent du locataire, point a) ;
2. **fin du bail** : `ended`, nature `tenant_exit` ou `lessor_notice`, journalisée (`lease.end`) ;
3. **remise en état** : l'unité prête passe « à remettre en état » (`to_refurbish`, par la base). Elle ne redevient disponible que déclarée prête par le gestionnaire (D14, règle 13).

Puis, pour chaque décompte non clos, l'**alerte de restitution** : « bientôt » à 7 jours du terme (`REFUND_ALERT_DAYS`), « dépassé » après ; le niveau est écrit sur le décompte (`refund_alert`) et journalisé une fois par niveau (`deposit.refund_deadline_soon`, `deposit.refund_deadline_overdue`). Le terme est la date de sortie plus le délai de restitution du bail.

Rejouée le même jour, la tâche ne change rien : un bail terminé n'est plus en préavis, une période déjà ramenée ne l'est plus, une alerte déjà posée à ce niveau ne l'est plus.

La tâche tourne dans le worker (`worker.ts`). Le retour au crédit passe par `ExitHooks`, que les modules `payments` et `collections` remplissent au démarrage de **chaque** processus, l'API comme le worker. Un point vide n'est jamais ignoré : le processus refuse de démarrer, et une opération qui le lit échoue avec `EXIT_HOOKS_NOT_REGISTERED` (sa transaction est annulée, rien n'est écrit). Une seconde inscription est refusée.

## 3. États des lieux

- `POST /inspections` (entrée ou sortie), `POST /inspections/:id/items`, `PATCH` et `DELETE /inspection-items/:id` (`inspection.create`) ; l'agent de terrain les fait sur ses unités, y compris hors ligne.
- Chaque ligne : pièce, élément (catalogue, D14 ; distinct de la liste des réparations à la charge du locataire), description. « Bon état » ou « RAS » seuls sont refusés (`INSPECTION_DESCRIPTION_VAGUE`, article 9). À la sortie, le **constat** est obligatoire : usure normale, dégradation imputable au locataire (`tenant_damage`), vétusté, inchangé.
- **Signature** (`POST /inspections/:id/sign`, `inspection.sign`), au choix :
  - la **case cochée** par chaque partie sur l'appareil : horodatée (heure de l'appareil, par la synchronisation), avec l'auteur de la saisie ; affichée « Case cochée par … le … à … sur l'appareil de … » (`inspectionCheckboxLabel`), **jamais présentée comme une signature électronique** (même principe que D21) ;
  - le **scan** signé à la main, déposé : « Signature manuscrite, scan déposé par … le … ».
  Signé des deux parties, l'état des lieux est figé (`signed_both`).
- **Contestation** (`POST /inspections/:id/dispute`) : observations libres, statut `disputed` ; l'issue (accord amiable, décision de justice) est enregistrée avec son document (`POST /inspections/:id/resolve`, `deposit.settle`). La plateforme n'arbitre pas.

## 4. Réparations et accords

- Une réparation (`POST /repairs`) n'existe que sur une ligne de sortie `tenant_damage`. Montant estimé et devis ; faite par l'organisation, le propriétaire ou le locataire (celui-ci seulement avec un accord `tenant_self_repair` accepté).
- Faite par l'organisation (`POST /repairs/:id/done`) : montant réel et **facture exigés** ; la dépense est créée par le module `collections` (un seul enregistrement, règle 16 : payée par l'organisation, supportée par le locataire, récupérée sur la caution) ; la réparation pointe vers elle. Faite par le locataire : contre-visite (`POST /repairs/:id/verify`).
- **Accords** (`POST /agreements`, décision `POST /agreements/:id/decision`, `agreement.decide`) : imputation de la caution sur les derniers loyers (`deposit_applied_to_rent`, avec les mois visés et la part gardée pour les dégâts), réparation par le locataire, règlement d'une contestation. Décidé une fois, par écrit, avec sa date.

## 5. Décompte de sortie

`POST /deposit-accounts/:id/settlement` prépare le décompte (ou une nouvelle révision du brouillon), à partir du serveur seul :

| Ligne | Mouvement à la clôture | Condition (refus nommé sinon) |
| --- | --- | --- |
| `rent_by_agreement` | `applied_to_rent` | accord `deposit_applied_to_rent` accepté **avant** le mois, mois couvert, pas après la sortie (`AGREEMENT_MISSING`, `AGREEMENT_NOT_ACCEPTED`, `AGREEMENT_AFTER_PERIOD`, `AGREEMENT_MONTH_NOT_COVERED`, `AGREEMENT_PERIOD_AFTER_EXIT`) |
| `repair` | `retained` | ligne de sortie `tenant_damage`, montant, devis ou facture (`RETENTION_NOT_TENANT_DAMAGE`, `RETENTION_AMOUNT_MISSING`, `RETENTION_PROOF_MISSING`) ; réparation du locataire vérifiée |
| `expense_claim`, `utility_bill` | `applied_to_debt` | dépense réclamée au locataire avec son justificatif, pointée elle-même (jamais une copie, point b) |
| `unpaid_rent` | `applied_to_debt` | échéance encore due, déduction faite des encaissements en attente |

- Ordre de couverture : mois imputés par accord, réparations, dépenses, loyers. **Le total des sorties ne dépasse jamais la caution reçue** ; le reste est un complément réclamé (`additional_claimed`).
- Le **trop-perçu** du bail s'ajoute à la restitution ou réduit le complément (point a) ; il n'est pas une sortie de la caution.
- Circuit : brouillon → proposé → accepté (ou contesté) → clos (`propose`, `accept`, `dispute`, `close`).
- **Contestation** : la part non contestée se restitue sans attendre (`POST /deposit-settlements/:id/refunds`), jamais au-delà de ce qui reste (`SETTLEMENT_REFUND_EXCEEDS`) ; la clôture exige alors l'issue et son document (`SETTLEMENT_DISPUTE_OUTCOME`).
- **Clôture** : chaque ligne couverte devient son mouvement ; la restitution du reste exige sa date, son moyen et qui restitue (`SETTLEMENT_REFUND_DETAILS_REQUIRED`) ; le compte est soldé.

### Imputation sur caution (D32)

Une ligne `rent_by_agreement`, `unpaid_rent`, `expense_claim` ou `utility_bill` solde l'échéance ou la dépense par un **encaissement interne** de moyen `deposit_offset`, décidé par le serveur à la clôture : confirmé, imputé exactement sur l'échéance ou la dépense visée, avec un **reçu numéroté** (« Imputation sur caution »), et porté par le mouvement de caution du même montant (contrainte différée de la base). Clé d'idempotence par ligne : une ligne n'est imputée qu'une fois. Ce moyen n'est jamais proposé à l'encaissement ni accepté par `POST /payments` (D18, `PAYMENT_METHOD_INTERNAL`).

### Caution détenue par le propriétaire

- La restitution est **enregistrée** (montant, date, moyen, référence), « Restituée par le propriétaire », jamais exécutée par la plateforme (règle 5).
- Relevé du propriétaire (lot 10, `docs/RELEVES.md`) : un loyer couvert par la caution qu'il détient figure **en information** (« perçus directement par vous »), hors du net ; une réparation avancée par l'organisation puis retenue par le propriétaire sur la caution est **déduite** de son relevé, une fois, au mois de la retenue.

## 6. Transfert de gestion (D16, règles 12 et 15)

`POST /mandates/:id/transfer` (`management.transfer`), sur un bien ou une unité :

- fin du mandat de gestion, ou des seules portées concernées ; un nouveau mandat peut ensuite couvrir l'unité ;
- remise du dossier enregistrée (nouveau gestionnaire nommé en texte, date, pièces remises) ;
- baux de l'organisation terminés (`management_transfer`, l'unité garde son état technique), échéances futures abandonnées ;
- caution : mouvement `holder_changed` vers le nouveau gestionnaire (`third_party`, nommé en texte), le compte est soldé ;
- l'organisation garde tout son historique. **Rien n'est écrit ni copié dans une autre organisation** : la nouvelle saisit ou importe le dossier remis.

## 7. Synchronisation en écriture

`POST /sync/upload` (`docs/SYNC.md`) passe par les mêmes services et les mêmes refus nommés, visibles dans « Modifications non acceptées » :

| Table | Opérations | Permission |
| --- | --- | --- |
| `inspections` | création ; case cochée par l'organisation ou le locataire (`organization_signed_at`, `tenant_signed_at`, heure de l'appareil) | `inspection.create`, `inspection.sign` |
| `inspection_items` | création, modification, suppression au brouillon | `inspection.create` |
| `deposit_settlement_lines` | proposition d'une ligne `repair` ou `rent_by_agreement` au brouillon ; le montant est celui du serveur | `deposit.settle` |

Une ligne de décompte non justifiée est refusée avec son code (`RETENTION_*`, `AGREEMENT_*`) ; une colonne non prévue, avec `FIELD_NOT_WRITABLE`. L'agent de terrain ne reçoit ni n'écrit rien de la caution.

## 8. Permissions

| Permission | Direction | Gestion | Agent de terrain | Lecture |
| --- | --- | --- | --- | --- |
| `lease.notice` | oui | oui | non | non |
| `inspection.read` | oui | oui | ses unités | oui |
| `inspection.create`, `inspection.sign` | oui | oui | ses unités | non |
| `deposit.settle` | oui | oui | non | non |
| `agreement.decide` | oui | oui | non | non |
| `management.transfer` | oui | oui | non | non |

La source est la matrice de `packages/shared/src/permissions.ts` ; ce tableau la résume.

## 9. Tests

- `packages/shared` : `deposit-settlement.test.ts`, `tenant-exit.test.ts` (règles pures, propriété sur 2 000 décomptes).
- Base : `exit-db.int.test.ts`, `migration-0019.int.test.ts`.
- API, synchronisation et worker : `exit.int.test.ts` (exemple du porteur de bout en bout ; tâche du jour rejouée ; imputation sur caution numérotée ; caution du propriétaire et relevé ; cases cochées ; contestation ; transfert ; accès croisé A/B sur chaque route et par l'appareil).
- Worker seul : `exit-worker.int.test.ts` (l'API arrêtée ; points d'inscription remplis ; point vide : démarrage refusé, fin de bail annulée sans rien écrire ; fin de bail avec retour au crédit, rien de perdu, rejouée sans effet).
- Flux PowerSync : `apps/web/e2e/exit-sync.spec.ts`.
