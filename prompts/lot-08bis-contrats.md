# Lot 08 bis — Contrats et documents contractuels

## Contexte
Décisions D20 à D24 ; règle 17 de `CLAUDE.md` ; analyse détaillée dans `docs/AUDIT.md` §C7. Le contrat est le **document du bail**, pas un module à part : le bail (lot 08) porte les données qui font tourner la gestion, le contrat en est la version rédigée, signée et archivée. Chaque organisation garde **son propre modèle Word** ; la plateforme le remplit avec les données déjà saisies. Le modèle d'une agence pilote (cinq pages) a servi de référence : l'agence y signe comme « bailleur », il prévoit deux dépôts, un intérêt de retard, des préavis particuliers et une reconduction tacite.

## Prérequis
Lot 08 terminé. Le porteur fournit les modèles Word des trois agences pilotes. Questions ouvertes (voir `docs/DECISIONS.md`) : statut juridique de l'agence qui signe comme bailleur ; délai et coût de la légalisation et de l'enregistrement.

## Périmètre
1. **Tables** (module `leases`, documents par le module `documents`), cloisonnées, auditées, synchronisées en lecture :
   - `contract_templates` : organisation, nom, type (`lease`, `amendment`), fichier Word (registre `documents`), version, statut (`draft`, `active`, `retired`), champs détectés, champs inconnus.
   - `lease_contracts` : bail, modèle et version utilisés, statut (`draft`, `in_review`, `ready_to_sign`, `signed`), signataires attendus (représentant de l'organisation, propriétaire si désigné bailleur, locataire), dates de signature par partie et mode (`handwritten_scan` au MVP), légalisation (date, commune, référence, document ; facultatif), enregistrement (date, référence, document ; facultatif), alertes.
   - `contract_versions` : contrat, numéro, contenu des champs résolus (JSON), document Word et PDF (registre `documents`), empreinte SHA-256 de chacun, auteur, date. **Ajout seul** (trigger).
   - `lease_amendments` : bail, type (`renewal`, `rent_change`, `other`), date d'effet, nouvelles valeurs, contrat d'avenant (même cycle).
2. **Catalogue de champs** (`packages/shared/contract-fields.ts`) : organisation et représentant légal, bailleur désigné, propriétaire, locataire (état civil, pièce), logement (destination, pièces détaillées, surface, clôture, localisation), conditions (durée, début, fin, loyer en chiffres et **en lettres**, jour limite, modalités, caution, garantie des factures, délai de restitution, pénalité, règles de préavis, reconduction), signature (lieu, date, nombre d'exemplaires). Chaque champ a sa source et son format d'affichage (`jj/mm/aaaa`, `75 000 FCFA`). Fonction pure `amountInFrenchWords` (« soixante-quinze mille francs CFA »), testée.
3. **Mise en place d'un modèle** (directeur ; pour les pilotes, l'équipe de la plateforme) : dépôt du Word, détection des balises `{champ}`, liste des champs reconnus et inconnus, aperçu avec des données d'exemple. Un champ inconnu bloque l'activation.
4. **Génération** (tâche BullMQ) : depuis un bail, remplissage du modèle actif avec docxtemplater, conversion en PDF par Gotenberg (service ajouté à `infra/docker-compose.dev.yml`, image `gotenberg/gotenberg:8-libreoffice`, accessible uniquement depuis l'API). **Contrôles avant génération** : champs vides, dates incohérentes, caution au-delà de deux mois (avertissement journalisé), mandat de gestion actif sur l'unité (sinon refus). Le texte du modèle reste sous la responsabilité de l'organisation.
5. **Cycle du contrat** : brouillon (nouvelle génération possible après correction du bail) → en vérification → **prêt à signer : figé**, toute modification crée une nouvelle version → signé quand le scan signé est déposé (assemblage de photos multipages en un PDF compressé, possible hors ligne). Le contrat signé passe le bail de `draft` à `signed` (puis `active` à sa date d'effet, lot 08). Légalisation et enregistrement : suivis, **jamais bloquants**. Libellé du dépôt : « Signature manuscrite, scan déposé par … le … » ; **jamais** « signé électroniquement » (D21).
6. **Avenants** : même cycle et même mécanisme de modèle. Un avenant `rent_change` crée les nouvelles échéances à sa date d'effet ; un avenant `renewal` prolonge le bail existant (même compte de caution, même historique). À l'échéance d'un bail sans congé, la reconduction prévue par ses paramètres est appliquée et journalisée.
7. **Alertes** (tâches planifiées, affichées dans l'application) : fin de bail à 4 puis 3 mois, terme atteint sans congé, contrat en attente de signature depuis 7 jours, contrat signé non légalisé (rappel mensuel désactivable), bail en vigueur **sans contrat signé**, avenant à valider ou à signer.
8. **Interface `SignatureProvider`** avec une seule implémentation `handwritten_scan`.
9. **Droits** : création et modification par directeur et gestionnaire (`contract.create`, `contract.freeze`, `contract.upload_signed`) ; modèles par le directeur (`contract_template.manage`) ; agent de terrain sans accès aux projets. Documents selon la matrice de `docs/UX.md` §10.
10. **Écrans** (`docs/UX.md` §10) : liste des contrats (filtres par statut du bail et du contrat, alertes) ; génération depuis la fiche bail ; relecture (aperçu PDF, champs vides signalés) ; suivi de signature avec dépôt du scan, légalisation et enregistrement ; fiche contrat (versions, avenants, documents, chronologie) ; modèles de contrat (réglages). Sur téléphone : aperçu plein écran et dépôt par l'appareil photo ; sur ordinateur : aperçu à gauche, panneau d'actions à droite.

## Hors périmètre
Signature électronique et acceptation par code SMS (phase 3), modèle de base de la plateforme pour les organisations sans modèle, outil permettant à l'organisation de placer elle-même les balises, envoi des alertes par WhatsApp ou SMS, validation par le propriétaire, calcul des pénalités de retard, « Mes contrats » dans l'espace locataire (lot 10 ter).

## Tests attendus
- Accès croisé A/B sur chaque nouvelle table et sur les documents générés ; un lien signé expiré est refusé.
- Catalogue : chaque champ du modèle de l'agence pilote est résolu ; `amountInFrenchWords` sur 0, 1, 21, 80, 81, 100, 1 000, 75 000, 1 250 000, 999 999 999.
- Génération : modèle avec champ inconnu refusé ; bail sans mandat actif refusé ; caution au-delà de deux mois : avertissement et audit.
- Figement : modifier un contrat « prêt à signer » crée la version suivante ; `UPDATE` et `DELETE` refusés sur `contract_versions` ; empreinte recalculée identique au téléchargement.
- Dépôt du scan : statut « signé », libellé exact « Signature manuscrite, scan déposé », bail passé à `signed`.
- Avenant de loyer : nouvelles échéances à la date d'effet, anciennes inchangées. Reconduction : appliquée selon le paramètre du bail.
- Alerte « sans contrat signé » présente pour un bail actif sans contrat, absente après dépôt.
- Matrice de documents : l'agent de terrain ne voit pas le projet ; le locataire ne voit pas le mandat.
- Playwright sur les trois appareils : génération, relecture, figement, dépôt du scan, avenant.

## Critères d'acceptation
- [ ] À partir du modèle Word réel d'une agence pilote et d'un bail saisi, le gestionnaire obtient un contrat prêt à imprimer, sans aucun blanc, en moins de 2 minutes.
- [ ] Les modèles des trois pilotes sont mis en place et activés.
- [ ] Aucun écran ni aucun document ne présente un scan déposé comme une signature électronique.
- [ ] Journal des lots mis à jour, avec les réponses du juriste.

## Instructions de travail
Écris d'abord le catalogue de champs et `amountInFrenchWords` avec leurs tests, puis la matrice d'accès aux documents. Présente ensuite le schéma des tables, le diagramme du cycle du contrat et la liste des balises du modèle pilote. Propose l'ajout des deux dépendances (D23) avec leur version stable actuelle avant de les installer. Attends la validation avant les écrans.
