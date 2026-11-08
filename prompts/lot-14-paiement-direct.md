# Lot 14 — Paiement direct Mobile Money via agrégateurs

## Contexte
Décision D03 : la plateforme reste un registre et ne détient jamais les fonds. En phase 3, le locataire peut payer son loyer par Orange Money ou Moov Money depuis un lien envoyé par l'agence ; l'argent arrive **sur le compte marchand de l'agence** ; le paiement est confirmé et imputé automatiquement. La fonctionnalité est pilotable par l'administrateur (`payments.direct`, coupée par défaut, ouverte agence par agence).

## Prérequis
Porte 1 franchie. Lot 13 terminé. **Avant de coder** : le porteur a choisi le ou les agrégateurs (CinetPay, Ligdicash, PayDunya ou autre) après comparaison des frais, des exigences KYC, des plafonds, des remboursements et de la fiabilité des notifications ; il fournit des accès de test. Lis la documentation officielle **actuelle** de l'agrégateur retenu ; ne te fie pas à ta mémoire pour ses endpoints ou ses signatures.

## Périmètre
1. **Implémentation de `PaymentProvider`** (interface du lot 09) pour l'agrégateur retenu, isolée dans `apps/api/src/modules/payments/providers/<nom>/`. Le reste du code ne connaît que l'interface.
2. **Identifiants marchands par agence** : table `organization_payment_accounts` (organisation, prestataire, identifiants **chiffrés** avec une clé hors base, mode test ou production, statut de vérification, dernier test réussi). Saisie par le directeur ; bouton « Tester la connexion ». Jamais affichés en clair après saisie.
3. **Parcours de paiement** :
   - Depuis un bail ou une échéance, l'agence génère un **lien de paiement** (`/p/<jeton>`), envoyé par WhatsApp.
   - Le locataire ouvre la page (sans compte) : agence, unité, période, montant dû (modifiable vers le bas si l'agence autorise les paiements partiels), choix de l'opérateur, puis redirection ou validation selon le flux de l'agrégateur.
   - Création d'un paiement `initiated` avec une clé d'idempotence ; passage à `pending` quand l'agrégateur l'accepte.
   - **Confirmation uniquement** par notification signée de l'agrégateur, dont la signature est vérifiée, **ou** par appel de vérification côté serveur. Le retour du navigateur du locataire ne confirme jamais rien.
   - À la confirmation : statut `confirmed`, imputation automatique, reçu définitif, notification à l'agence.
   - Échec ou expiration : `failed`, avec motif ; le lien peut être réutilisé tant qu'il est valide.
4. **Robustesse** :
   - Notifications rejouées : traitées une seule fois (idempotence sur la référence du prestataire).
   - Notification perdue : tâche de vérification des paiements `pending` toutes les 5 minutes pendant 24 heures, puis `failed` ou alerte.
   - Montant notifié différent du montant initié : paiement placé en `to_reconcile` et alerte au directeur, jamais confirmé automatiquement.
   - Plafond par transaction de l'opérateur : la page propose de payer en plusieurs fois.
   - Couper `payments.direct` bloque les nouveaux liens et initiations ; les paiements déjà `pending` continuent d'être traités.
5. **Frais** : affichage des frais de l'agrégateur à l'agence dans ses réglages ; le choix de les répercuter au locataire appartient à l'agence (paramètre), conformément aux conditions du prestataire.
6. **Back-office** : liste des comptes marchands par agence, paiements directs par statut, paiements bloqués en `pending` ou `to_reconcile`, journal des notifications reçues (contenu brut conservé 90 jours, sans données de carte).
7. **Documentation** : `docs/PAIEMENTS.md` complété (flux, états, erreurs, procédure en cas d'incident chez l'agrégateur).

## Hors périmètre
Encaissement par la plateforme pour compte de tiers, reversements automatiques aux propriétaires, prélèvements récurrents, cartes bancaires (sauf si l'agrégateur les fournit sans effort et que le porteur le demande), remboursements automatiques.

## Tests attendus
- Simulateur de l'agrégateur (faux serveur de test) : succès, échec, expiration, notification en double, notification avec signature invalide (rejetée), notification avec montant différent, notification perdue rattrapée par la vérification périodique.
- Le retour du navigateur seul ne confirme jamais un paiement.
- Identifiants marchands chiffrés en base ; jamais renvoyés par l'API.
- Accès croisé : un lien de paiement de A n'affiche rien de B ; une notification ne peut confirmer qu'un paiement de l'agence du compte marchand concerné.
- Interrupteur coupé pendant un paiement `pending` : la confirmation arrive quand même ; un nouveau lien est refusé.
- Exception d'interrupteur : `payments.direct` coupée pour tous sauf l'agence pilote → seule cette agence voit et utilise la fonctionnalité.
- Tests de bout en bout sur l'environnement de test réel de l'agrégateur (à lancer à la main, hors CI).

## Critères d'acceptation
- [ ] Une agence pilote reçoit un vrai paiement de test sur son compte marchand, confirmé, imputé et accompagné d'un reçu, sans intervention manuelle.
- [ ] L'administrateur ouvre `payments.direct` pour une seule agence, puis la coupe pour tous, depuis le back-office, avec effet en moins de 30 secondes.
- [ ] Aucune somme ne transite par un compte de la plateforme.
- [ ] Journal des lots mis à jour.

## Instructions de travail
Présente d'abord le diagramme de séquence complet (agence, locataire, plateforme, agrégateur, opérateur) et la liste des cas d'erreur, puis le simulateur de test, puis l'implémentation.
