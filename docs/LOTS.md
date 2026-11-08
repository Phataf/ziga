# Découpage en lots

Les lots s'exécutent **dans l'ordre**. Un lot ne commence que lorsque le précédent remplit sa définition de « terminé » (`CLAUDE.md` §7). Chaque lot a son prompt dans `prompts/`.

Durées indicatives pour un développement à temps partiel avec Claude Code, relecture comprise.

| Lot | Titre | Phase du cadrage | Dépend de | Durée indicative | Prompt |
| --- | --- | --- | --- | --- | --- |
| 00 | Maquettes cliquables (sans backend) | 0. Valider | — | 1 à 2 semaines | `prompts/lot-00-maquettes.md` |
| — | **Porte 0 : 3 agences pilotes engagées** | | | | |
| — | **Préparation métier en parallèle des lots 01 à 05** : maquette 00 ter (assistant d'ajout de bien, statuts, sortie et décompte, patrimoine multi-agences, back-office) et test avec les agences pilotes. À terminer avant le lot 06. | 0 | Audit (`docs/AUDIT.md`) | 1 semaine | `prompts/lot-00ter-maquette-audit.md` |
| 01 | Socle technique | 1. Construire | Porte 0 | 1 semaine | `prompts/lot-01-socle.md` |
| 02 | Authentification | 1 | 01 | 1 semaine | `prompts/lot-02-authentification.md` |
| 03 | Organisations, rôles, cloisonnement, journal d'audit | 1 | 02 | 1 à 2 semaines | `prompts/lot-03-agences-roles-audit.md` |
| 04 | Interrupteurs, formules, back-office minimal | 1 | 03 | 1 à 2 semaines | `prompts/lot-04-interrupteurs-backoffice.md` |
| 05 | Synchronisation hors ligne (socle PowerSync) | 1 | 04 | 1 à 2 semaines | `prompts/lot-05-synchronisation.md` |
| 06 | Propriétaires et mandats | 1 | 05 | 1 semaine | `prompts/lot-06-proprietaires-mandats.md` |
| 07 | Biens, unités, médias, documents | 1 | 06 | 1 à 2 semaines | `prompts/lot-07-biens-unites-medias.md` |
| 08 | Locataires, baux, échéancier, comptes de caution | 1 | 07 | 1 à 2 semaines | `prompts/lot-08-baux-echeancier.md` |
| 09 | Encaissements, imputations, reçus | 1 | 08 | 2 semaines | `prompts/lot-09-encaissements-recus.md` |
| 10 | Impayés, relances, dépenses, relevés propriétaires | 1 | 09 | 1 à 2 semaines | `prompts/lot-10-impayes-releves.md` |
| 10 bis | Sortie du locataire : préavis, états des lieux, décompte, remise en état, transfert de gestion | 1 | 10 | 1 à 2 semaines | `prompts/lot-10bis-sortie-locataire.md` |
| 10 ter | Espaces propriétaire et locataire avec compte, regroupant toutes les organisations | 1 | 10 bis | 1 à 2 semaines | `prompts/lot-10ter-espaces-personnels.md` |
| 11 | Import Excel | 1 | 10 ter | 1 semaine | `prompts/lot-11-import-excel.md` |
| 12 | Vitrine publique, annonces, prospects | 1 | 11 | 2 semaines | `prompts/lot-12-vitrine-annonces.md` |
| 13 | Durcissement et mise en production pilote | 1 → 2 | 12 | 1 à 2 semaines | `prompts/lot-13-production.md` |
| — | **Phase 2 : pilote de 12 semaines, corrections hebdomadaires** | 2. Piloter | | | |
| — | **Porte 1 : 70 % des loyers saisis, 2 pilotes payants** | | | | |
| 14 | Paiement direct Mobile Money (agrégateurs) | 3. Lancer | Porte 1 | 2 à 3 semaines | `prompts/lot-14-paiement-direct.md` |

## Après le lot 14 (prompts à écrire après la porte 2)

Ces lots ne sont pas détaillés volontairement : leur contenu dépendra du pilote.

- Abonnements et facturation automatisés.
- Rapprochement automatique des demandes de locataires et des unités libres.
- API WhatsApp Business (`notifications.whatsapp_api`).
- Publication par les particuliers avec modération (`listings.private_sellers`).
- Visites 360° (`media.virtual_tour_360`).
- Extension à Bobo-Dioulasso.

## Règle de priorité pendant le pilote

Pendant la phase 2, aucun nouveau lot : seulement des corrections et des améliorations demandées par les agences pilotes, chacune décrite dans `docs/JOURNAL-LOTS.md` avec son origine.
