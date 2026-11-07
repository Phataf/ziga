# Lot 11 — Import Excel

## Contexte
Une agence n'adoptera pas l'outil si elle doit ressaisir 100 baux à la main. Les agences tiennent aujourd'hui leurs registres sur Excel ou sur papier. L'import est la première barrière à l'adoption.

## Prérequis
Lot 10 terminé.

## Périmètre
1. **Modèle Excel téléchargeable** (un classeur, un onglet par type, avec en-têtes en français, exemples, listes déroulantes et notice) : Propriétaires, Biens, Unités, Locataires, Baux, Soldes d'ouverture (montant dû par bail à la date de démarrage).
2. **Parcours d'import** (directeur ou gestionnaire, protégé par `imports.excel`), sur ordinateur de préférence, possible sur téléphone :
   1. Envoi du fichier (`.xlsx`, `.csv`).
   2. Correspondance des colonnes : automatique sur les en-têtes du modèle, manuelle pour un fichier libre (glisser une colonne vers un champ).
   3. **Prévisualisation** : lignes valides, lignes en erreur avec le motif en français (« Téléphone invalide ligne 14 »), doublons détectés (même téléphone, même unité), rapprochements proposés (« Kaboré Issouf » existe déjà).
   4. Validation : l'import s'exécute en tâche de fond, **en une seule transaction par onglet** ; en cas d'échec, rien n'est importé pour cet onglet.
   5. Rapport final téléchargeable (lignes importées, ignorées, erreurs).
3. **Soldes d'ouverture** : pour chaque bail importé, une échéance d'ouverture « Solde antérieur » du montant indiqué, sans reçu ; les échéances futures sont générées normalement.
4. **Traçabilité** : table `import_jobs` (fichier d'origine conservé 90 jours, auteur, statut, rapport) ; chaque ligne créée porte l'identifiant de l'import ; une annulation d'import possible dans les 24 heures s'il n'y a eu aucun encaissement depuis (archive les lignes créées, jamais de suppression physique de données financières).
5. **Quotas** de la formule vérifiés avant l'exécution (message clair si l'import dépasse le nombre d'unités).
6. **Normalisation** : téléphones en E.164, montants (« 75.000 », « 75 000 F », « 75000 FCFA » → 75000), dates (jj/mm/aaaa, aaaa-mm-jj, nombres de série Excel), quartiers rapprochés du référentiel (avec suggestions).

## Hors périmètre
Import depuis d'autres logiciels par API, import de l'historique des paiements passés, import de photos.

## Tests attendus
- Fichier du modèle rempli : tout est importé, baux actifs, unités `occupied`, échéances générées, soldes d'ouverture corrects.
- Fichier avec erreurs : prévisualisation exacte, aucun import partiel dans un onglet en erreur.
- Normalisation des montants, téléphones et dates (tableau de cas).
- Doublons et rapprochements détectés.
- Quota dépassé : refus avant exécution.
- Annulation d'import dans les 24 heures ; refusée après un encaissement.
- Accès croisé : un import de A ne crée jamais rien dans B.
- Fichier de 1 000 lignes importé en moins de 60 secondes.

## Critères d'acceptation
- [ ] Le porteur importe le registre réel (anonymisé) d'une agence pilote et émet le premier reçu le jour même.
- [ ] Chaque message d'erreur dit la ligne, la colonne et quoi corriger, en français simple.
- [ ] Journal des lots mis à jour.

## Instructions de travail
Commence par le modèle Excel et les fonctions de normalisation (pures, testées), puis la prévisualisation, puis l'exécution.
