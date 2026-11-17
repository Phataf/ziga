# Impayés, relances, dépenses, relevés et reversements

Référence du module `collections` (lot 10). Règles de `CLAUDE.md` concernées : 1 (cloisonnement), 2 (montants entiers), 3 (ajout seul, contre-écriture), 4 (journal), 5 (la plateforme ne détient jamais les fonds), 14 (caution), 15 (aucune donnée d'un locataire ailleurs) et 16 (une dépense est un seul enregistrement).

Les règles sont écrites une seule fois, en fonctions pures, dans `packages/shared` ; la base (migrations `0017_collections` et `0018_statement_organizations`) applique les mêmes en dernier rempart.

| Fichier | Contenu |
| --- | --- |
| `statements.ts` | part du loyer et des charges, calcul du relevé, commissions, émission, rectificatif, quota, reversements, lien `/s`, document |
| `expenses.ts` | combinaisons admises (qui paie, qui supporte, comment c'est récupéré), créance sur le locataire |
| `collections.ts` | impayés groupés par locataire, tranches, suggestion de relance |
| `reminders.ts` | modèles, période, lien `wa.me` |
| `dashboard.ts` | indicateurs de l'accueil |

## 1. Part du loyer et des charges

Un encaissement imputé sur une échéance se répartit entre loyer et charges par la **règle du cumul** (`splitDueLedger`). On reprend toutes les imputations de l'échéance dans l'ordre du registre (`created_at`, identifiant) ; `P₀` et `P₁` sont le total net payé avant et après la ligne :

```
charges de la ligne = ⌊P₁·charges/dû⌋ − ⌊P₀·charges/dû⌋      (négatif pour une ligne inverse)
loyer de la ligne   = montant signé − charges de la ligne
```

Le cumul des charges vaut toujours ⌊P·charges/dû⌋ : des paiements partiels qui soldent l'échéance donnent exactement le loyer et les charges. Un encaissement annulé avant d'avoir été repris peut laisser 1 FCFA passer du loyer aux charges sur cette échéance ; le total encaissé reste exact.

## 2. Éléments d'un relevé

Les éléments sont les **imputations sur échéance** du propriétaire (réponse du porteur) :

| Élément | Date de rattachement |
| --- | --- |
| Imputation directe, à la confirmation | date du paiement |
| Imputation d'un crédit (trop-perçu) sur une échéance émise plus tard | date d'imputation |
| Contre-écriture d'un encaissement annulé | date d'annulation |

- Un **trop-perçu** est l'argent du locataire : tant qu'il n'est pas imputé, il figure dans la section « Trop-perçus détenus pour vos locataires », hors du net, sans commission.
- Un encaissement **annulé avant d'avoir été repris** dans un relevé émis n'apparaît jamais. Annulé après, il apparaît en ligne négative sur le relevé du mois de l'annulation ; l'ancien relevé ne change pas.
- Un encaissement d'un mois **confirmé après l'émission** du relevé de ce mois entre dans le relevé suivant, avec la mention « enregistré après l'émission du relevé de … ».
- **Un élément n'entre qu'une fois** : à l'émission, la base écrit les éléments consommés (`owner_statement_lines`), avec la clé `statementItemKey` de `packages/shared`, sous un index unique.
- Le **mandat** d'un élément est celui de ce propriétaire qui couvre l'unité à la date de l'élément (pour une contre-écriture : à la date de l'imputation annulée), dans la version enregistrée à cette date. L'imputation se reconnaît comme venant d'un crédit à sa ligne `credit` inverse, écrite dans la même transaction.

## 3. Totaux et net

```
net = encaissé par l'organisation (loyer et charges)
      − commission
      − dépenses avancées par l'organisation pour le propriétaire (et + celles annulées ensuite)
      + solde négatif du relevé précédent
```

- **Commission** (sur le loyer encaissé seul, hors charges) :
  - pourcentage : arrondi vers zéro, sur le total du mois, par version du mandat ;
  - montant fixe par mois : entier pour un mois complet, au prorata des jours en vigueur le premier et le dernier mois (arrondi à l'inférieur) ;
  - montant fixe par opération : un bail validé dans le mois sur une unité du mandat.
- **Mandat sans encaissement par l'organisation** (`can_collect_funds = false`) : les loyers figurent dans « Loyers perçus directement par vous (pour information) », hors du net ; la commission reste due. Le net peut être négatif : le cadre de synthèse affiche « Solde en faveur de [organisation] : 27 000 FCFA », jamais un montant négatif, et le solde est reporté sur le relevé suivant (« Solde du relevé précédent ») jusqu'à ce qu'il soit absorbé.
- **Hors du net, en information** : cautions détenues par l'organisation, trop-perçus, dépenses réglées directement par le propriétaire.
- Un locataire n'apparaît sur un relevé (écran, PDF, page `/s`) **que par son nom** : ni téléphone, ni pièce d'identité.

## 4. Émission, rectificatif, quota

- **Brouillon** : calculé à la demande (`POST /owner-statements/generate`) ou par la tâche du 1er du mois (01:00 UTC, mois écoulé, chaque propriétaire sous mandat). Un brouillon n'est qu'un calcul.
- **Émission** (direction, gestion) : le serveur recalcule ; il refuse un brouillon changé depuis son affichage (`STATEMENT_DRAFT_STALE`, empreinte `revision`), un mois pas terminé, un mois plus ancien qu'un relevé émis. Puis le relevé est figé (copie D29) et ses éléments écrits, dans la même transaction. Le PDF part en tâche de fond.
- **Rectificatif** : version suivante du dernier mois émis ; il ne reprend que ce qui n'a été repris nulle part, et son net est la différence. Sans élément nouveau : `STATEMENT_RECTIFICATION_EMPTY`.
- **Quota Découverte** : 2 relevés émis par mois civil (`QUOTA_EXCEEDED`), rectificatifs non comptés.
- **Bailleur particulier** : pas de relevé propriétaire (`STATEMENT_LANDLORD`).

## 5. Dépenses (règle 16)

| Payée par | Supportée par | Récupération | Effet |
| --- | --- | --- | --- |
| organisation | propriétaire | relevé | déduite du relevé, une seule fois |
| organisation | organisation | aucune | rien sur le relevé |
| organisation | locataire | réclamée au locataire | due par le locataire (impayés, relances) |
| organisation | locataire | caution | lot 10 bis |
| propriétaire | propriétaire | aucune | information sur le relevé |
| locataire | locataire | aucune | réparation faite par le locataire, information |

Ajout seul ; annulation motivée par le directeur. Une dépense réclamée au locataire **est** la créance : elle s'encaisse par un encaissement « dépense » (`docs/PAIEMENTS.md` §5 bis), jamais copiée.

## 6. Impayés et relances

- **Impayés** : échéances en retard, ou payées en partie et exigibles, et dépenses réclamées, groupées par locataire, triées par ancienneté ; filtres quartier, propriétaire, agent, tranche (1 à 7 jours, 8 à 30, plus de 30).
- Une échéance couverte par un encaissement **à valider ou à rapprocher** n'est ni proposée ni relancée (imputation prévisionnelle du lot 09).
- **Suggestion** à J+5, J+15 puis J+30 (seuils de l'organisation), sauf relance faite depuis le dernier seuil franchi. Aucun envoi automatique.
- **Relance** : un message (WhatsApp, SMS) exige `reminder.send` (direction, gestion) ; un appel ou une visite, `reminder.record_visit` (agent de terrain compris, sur les locataires de ses unités). Le lien WhatsApp est sous l'interrupteur `collections.reminders_whatsapp_link`.
- **Lien `wa.me`** : numéro E.164 sans « + », message encodé par `encodeURIComponent` (accents, espace fine des montants, retours à la ligne).

## 7. Reversements (règle 5)

Enregistrés, jamais exécutés par la plateforme : relevé émis, net positif, total reversé jamais au-delà du net. Ajout seul ; une erreur se corrige par une contre-écriture à l'identique (directeur, motif).

## 8. Lien `/s/<jeton>`

- Jeton de 256 bits ; la base n'en garde que l'empreinte SHA-256 ; 90 jours au plus ; révocable.
- `GET /public/statements/shared/:token` : le relevé émis en lecture seule. Limite de débit par adresse IP (`STATEMENT_PUBLIC_RATE_PER_MINUTE`, 30 par défaut), `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`. Lien expiré, révoqué ou inconnu : introuvable (`STATEMENT_LINK_INVALID`).
- **Page `/s/<jeton>`** (interface) : rendue par le serveur, **sans JavaScript** (`csr = false`), pour s'ouvrir vite depuis WhatsApp en 3G (mesurée par Playwright : 1,6 Mbit/s, 300 ms de latence, cache vide, moins de 3 s). Le serveur web lit l'API en transmettant l'adresse du visiteur (`X-Forwarded-For`), pour que la limite de débit compte le visiteur. Le PDF passe par `/s/<jeton>/pdf`, qui redirige vers une URL signée de 5 minutes. Mêmes en-têtes que l'API. Le contenu est celui de l'écran et du PDF (`statementDocument`) : un locataire n'y apparaît que par son nom, jamais par son téléphone ni sa pièce d'identité (testé).

## 9. Routes

| Route | Permission |
| --- | --- |
| `GET /collections/arrears` (curseur, filtres) | `reminder.read` |
| `GET /reminders`, `POST /reminders` | `reminder.read` ; `reminder.record_visit` puis le canal précis |
| `GET /organization/reminder-settings`, `PUT …` | `reminder.read` ; `reminder.templates` (directeur) |
| `GET /expenses`, `GET /expenses/:id`, `POST /expenses`, `POST /expenses/:id/cancel` | `expense.read` ; `expense.record` ; `expense.cancel` (directeur) |
| `GET /owner-statements`, `GET /owner-statements/:id`, `GET …/pdf`, `GET …/payouts` | `statement.read` |
| `POST /owner-statements/generate`, `POST …/:id/issue`, `POST …/:id/rectify` | `statement.issue` |
| `POST …/:id/share-token`, `POST …/:id/share-token/revoke` | `statement.share` |
| `POST /owner-payouts`, `POST /owner-payouts/:id/cancel` | `payout.record` ; `payout.cancel` (directeur) |
| `GET /public/statements/shared/:token[/pdf]` | aucune (jeton) |

Relevés et reversements : sous l'interrupteur `collections.owner_statements`. Depuis l'appareil : relances et dépenses (`PUT`, même service, audit d'origine `sync`).
