# Lot 00 — Maquettes cliquables (sans backend)

## Contexte
Phase 0 du cadrage : avant de construire, le porteur rencontre 10 agences de Ouagadougou pour valider le besoin et le prix. Il lui faut une maquette **cliquable sur téléphone** qui montre les parcours clés avec des données fictives. Ce code est jetable : il ne sera pas réutilisé tel quel, mais il fixe l'ergonomie.

## Objectif
Une application SvelteKit statique, déployable gratuitement (export statique), qui simule les 6 parcours principaux sur un téléphone Android, sans serveur ni base de données.

## Prérequis
Aucun. Lis `CLAUDE.md` (§6 règles d'ergonomie) et `docs/DECISIONS.md`.

## Périmètre
1. Projet SvelteKit seul (pas encore de monorepo), Tailwind, shadcn-svelte, `adapter-static`.
2. Données fictives en dur dans `src/lib/fixtures.ts` : 1 agence « Immo Démo », 12 biens à Ouagadougou et Saaba (quartiers réels : Ouaga 2000, Tampouy, Pissy, Patte d'Oie, Dassasgho, Saaba centre…), 20 unités, 15 locataires, 3 mois d'échéances avec des impayés.
3. Barre de 4 onglets en bas : Accueil, Biens, Encaissements, Plus.
4. Écrans à simuler (l'état change en mémoire pendant la démo) :
   - **Accueil** : loyers attendus et encaissés du mois, nombre d'impayés, échéances du jour.
   - **Encaisser en 3 gestes** : chercher un locataire → montant pré-rempli modifiable (clavier numérique) → choisir espèces ou Mobile Money (avec champ référence) → valider → aperçu du reçu avec QR code → bouton « Envoyer sur WhatsApp » (ouvre un lien `wa.me` avec un texte pré-rempli).
   - **Impayés** : liste triée par retard, bouton « Relancer » qui ouvre un message WhatsApp pré-rempli et poli.
   - **Biens et unités** : liste, fiche d'un bien avec ses unités et leur statut (libre, louée, réservée), bouton « Publier » sur une unité libre.
   - **Relevé propriétaire** : aperçu du relevé du mois (loyers reçus, commission, dépenses, net à reverser), bouton « Envoyer le lien ».
   - **Vitrine** : une page publique d'annonce (photos de remplacement neutres, prix, quartier, caractéristiques, boutons WhatsApp et Appeler, mention « Géré sous mandat par Immo Démo »).
5. Formats locaux : `75 000 FCFA`, `+226 70 12 34 56`, dates `jj/mm/aaaa`.
6. Un bouton discret « Réinitialiser la démo ».
7. Un fichier `GUIDE-ENTRETIEN.md` : le déroulé de démonstration en 10 minutes et les 8 questions à poser aux agences (outil actuel, nombre de lots, impayés, relevés propriétaires, prix acceptable, qui saisit, connexion, Mobile Money).

## Hors périmètre
Backend, base de données, authentification, synchronisation, vrai envoi WhatsApp (seulement des liens `wa.me`), vraies photos de biens, interrupteurs de fonctionnalités.

## Tests attendus
- Un test Playwright par parcours, en émulation mobile (viewport 360 × 800).
- Un test unitaire du formatage des montants et des téléphones.

## Critères d'acceptation
- [ ] Les 6 parcours se font au doigt sur un Android d'entrée de gamme sans explication préalable (test avec une personne extérieure).
- [ ] L'encaissement se fait en 3 gestes au plus avant la validation.
- [ ] Aucun écran ne met plus de 1 seconde à s'afficher en 3G simulée après le premier chargement.
- [ ] La maquette s'installe comme application sur l'écran d'accueil (manifeste PWA).
- [ ] `GUIDE-ENTRETIEN.md` est rédigé.

## Instructions de travail
Propose d'abord la liste des écrans et la navigation, puis code. Garde le code simple : ce lot sert à apprendre, pas à durer.
