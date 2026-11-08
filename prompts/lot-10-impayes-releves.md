# Lot 10 — Impayés, relances, dépenses et relevés propriétaires

## Contexte
Deux fonctions qui justifient l'abonnement : savoir qui doit quoi et relancer en un geste ; envoyer chaque mois au propriétaire, même sans compte, un relevé clair de ce que l'agence a encaissé et dépensé pour lui.

## Prérequis
Lot 09 terminé.

## Périmètre
1. **Impayés** (module `collections`) : vue des échéances `overdue` et `partial`, groupées par locataire, triées par ancienneté, avec total dû, nombre de jours de retard, dernière relance. Filtres : quartier, propriétaire, agent, tranche de retard (1–7 jours, 8–30, plus de 30).
2. **Relances** :
   - Table `reminders` (cloisonnée, auditée, synchronisée) : locataire, échéances concernées, canal (`whatsapp_link`, `sms`, `call`, `visit`), modèle utilisé, date, auteur, note.
   - Bouton « Relancer » qui ouvre WhatsApp (`wa.me`) avec un message pré-rempli, poli et personnalisé (nom, montant, période, agence) ; la relance est enregistrée au retour dans l'application.
   - 3 modèles de messages par agence, modifiables par le directeur (rappel courtois, deuxième rappel, dernier rappel).
   - Suggestion de relance : échéance non soldée à J+5, puis J+15, puis J+30 (paramétrable par agence). Aucun envoi automatique au MVP.
   - Protégé par `collections.reminders_whatsapp_link`.
3. **Dépenses** (`CLAUDE.md` règle 16) : table `expenses` (bien ou unité, date, catégorie : plomberie, électricité, menuiserie, peinture, entretien, taxe, eau, électricité, gardiennage, autre ; description ; prestataire facultatif ; montant ; justificatif ; **qui a payé le prestataire** : `organization`, `owner`, `tenant` ; **qui la supporte au final** : `owner`, `organization`, `tenant` ; **comment elle est récupérée** : `owner_statement`, `deposit`, `claimed_from_tenant`, `none`). Une dépense supportée par le locataire n'apparaît jamais dans le relevé du propriétaire comme une charge ; la retenue sur caution (lot 10 bis) renverra à la dépense. Ajout seul ; correction par écriture d'annulation motivée. **La commission de gestion n'est pas une dépense.**
4. **Commissions** : calcul de la commission de gestion de l'agence à partir du mandat (taux sur les loyers encaissés ou montant fixe), au moment du relevé.
5. **Relevés propriétaires** :
   - Table `owner_statements` : propriétaire, période (mois), totaux (loyers encaissés par unité, commission, dépenses imputables, net à reverser), statut (`draft`, `issued`), date d'émission, jeton d'accès, clé du PDF, version.
   - Génération du brouillon à la fin du mois (tâche) ou à la demande ; émission par le directeur ou le gestionnaire ; **un relevé émis est figé** : toute correction produit un relevé rectificatif qui référence le précédent.
   - Lien de consultation `/s/<jeton>` (lecture seule, sans compte, jeton long et révocable, expiration 90 jours) et PDF. Envoi par WhatsApp avec message pré-rempli.
   - Quota : 2 relevés par mois en formule Découverte (`collections.owner_statements` avec quota).
   - Le reversement des fonds au propriétaire est **enregistré** dans `owner_payouts` (propriétaire, relevé, montant, date, moyen, référence, auteur ; ajout seul), jamais exécuté par la plateforme.
6. **Lien du relevé** : le lien partagé ouvre le relevé (lecture seule) et invite le propriétaire à créer son compte pour voir tous ses biens, quelle que soit l'organisation qui les gère. L'espace propriétaire avec compte est au lot 10 ter (D13).
7. **Impayés sur ordinateur** : tableau, sélection multiple et relances en série (un message WhatsApp ouvert par locataire, progression affichée).
8. **Tableau de bord d'accueil**, différent par profil (« Ma tournée » pour l'agent de terrain) et par appareil (`docs/UX.md` §4) : loyers attendus et encaissés du mois, taux d'encaissement, montant des impayés, échéances du jour, relevés à émettre.

## Hors périmètre
Envoi automatique de messages, API WhatsApp, SMS réels, espace propriétaire avec compte (lot 10 ter), sortie du locataire (lot 10 bis), comptabilité générale de l'agence (SYSCOHADA : export seulement), pénalités de retard.

## Tests attendus
- Accès croisé A/B sur `reminders`, `expenses`, `owner_statements`, `owner_payouts` ; un jeton de relevé de A ne donne rien de B ; jeton révoqué ou expiré refusé.
- Calcul des totaux d'un relevé : loyers de plusieurs unités, paiement partiel, paiement annulé dans le mois, dépense supportée par le locataire ou par l'organisation exclue, dépense avancée par l'organisation et récupérée sur le relevé incluse une seule fois, commission en taux et en montant fixe.
- Relevé émis non modifiable ; le rectificatif référence l'original.
- Quota de relevés de la formule Découverte.
- Lien WhatsApp correctement encodé (accents, montant formaté, retours à la ligne).
- Interrupteur `collections.reminders_whatsapp_link` coupé : bouton absent, API refusée.

## Critères d'acceptation
- [ ] Depuis l'accueil, un gestionnaire relance 5 locataires en retard en moins de 2 minutes.
- [ ] Un propriétaire ouvre son relevé depuis un lien WhatsApp sur un téléphone sans compte, en 3G, en moins de 3 secondes.
- [ ] Les totaux du relevé correspondent exactement aux reçus valides de la période (test de rapprochement).
- [ ] Journal des lots mis à jour.

## Instructions de travail
Écris d'abord le calcul du relevé en fonction pure avec ses tests, puis le reste.
