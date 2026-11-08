# Journal des lots

Claude Code complète ce fichier à la fin de chaque lot. Le porteur le relit avant de lancer le lot suivant.

## Modèle d'entrée

```
## Lot NN — Titre — jj/mm/aaaa

### Fait
- …

### Critères d'acceptation
- [x] Critère 1
- [ ] Critère 2 — raison si non coché

### Écarts par rapport au prompt
- …

### Dette technique
- …

### Questions ouvertes pour le porteur
- …
```

---

<!-- Les entrées commencent ici -->

## Lot 00 — Maquettes cliquables (sans backend) — 07/11/2026

### Fait
- Documents de référence ajoutés au dépôt : `CLAUDE.md`, `docs/` (cadrage, décisions, lots, interrupteurs, journal) et `prompts/lot-00-maquettes.md`.
- Projet SvelteKit seul dans `maquette/` (pas de monorepo) : Svelte 5 (runes), Tailwind CSS 4, composants au format shadcn-svelte, `adapter-static` avec page de repli `index.html`.
- Données fictives (`src/lib/fixtures.ts`) : agence Immo Démo, 6 propriétaires, 12 biens (Ouaga 2000, Tampouy, Pissy, Patte d'Oie, Dassasgho, Gounghin, Wemtenga, Zogona, Somgandé, Saaba centre, Saaba — Kouanda), 20 unités (15 louées, 3 libres, 2 réservées), 15 locataires. 3 mois d'échéances calculés à partir de la date du jour, avec 4 impayés, un paiement partiel, deux échéances du jour, un Mobile Money à rapprocher et des dépenses.
- 12 écrans : Accueil, Encaisser (choix du locataire), Encaisser (montant et moyen), Reçu, Encaissements, Impayés, Biens, Fiche bien avec feuille de publication, Plus, Propriétaires, Relevé propriétaire, Vitrine (liste et annonce).
- Barre de 4 onglets (Accueil, Biens, Encaissements, Plus), chaque pictogramme accompagné de son libellé, cibles ≥ 44 px, texte ≥ 16 px, clavier numérique pour les montants.
- Liens `wa.me` pré-remplis : reçu, relance polie, relevé propriétaire, contact depuis l'annonce, partage d'une annonce.
- Reçu avec numéro continu, QR code et impression. Paiement partiel imputé sur l'échéance la plus ancienne. Mobile Money déclaré : référence obligatoire et statut « à rapprocher ».
- Publication : 4 conditions vérifiées et affichées (unité libre, mandat actif qui l'autorise, 3 photos ou plus, loyer). Refus expliqué sinon. Une unité louée, réservée ou retirée n'a pas d'annonce.
- Les actions faites pendant la démo sont gardées dans le navigateur (`localStorage`) et effacées par « Réinitialiser la démo » (onglet Plus, avec confirmation).
- PWA : manifeste, icônes 192 et 512 (dont une icône masquable), service worker qui met l'application en cache (ouverture hors connexion).
- `GUIDE-ENTRETIEN.md` : préparation, déroulé en 10 minutes, les 8 questions, grille du test « sans explication ».
- Tests : 34 tests Vitest (formats FCFA, téléphone et date ; imputation ; publication ; relevé ; cohérence des données, y compris en fin et début de mois) et 15 tests Playwright en 360 × 800 (un fichier par parcours, plus PWA, hors ligne et 3G).

### Critères d'acceptation
- [ ] Les 6 parcours se font au doigt sur un Android d'entrée de gamme sans explication préalable — **à faire par le porteur** avec une personne extérieure ; la grille est dans `maquette/GUIDE-ENTRETIEN.md`. Les 6 parcours passent en émulation mobile tactile (Playwright, 360 × 800).
- [x] L'encaissement se fait en 3 gestes au plus avant la validation : choisir le locataire, puis **Valider** (montant pré-rempli, espèces par défaut). En Mobile Money : choisir le locataire, choisir le moyen, saisir la référence, puis **Valider**.
- [x] Aucun écran ne met plus de 1 seconde à s'afficher en 3G simulée après le premier chargement : 7 écrans enchaînés en 995 ms au total, avec le profil « Fast 3G » de Chrome (`e2e/07-pwa-performance.spec.ts`). Mesure faite en Chromium sur serveur, à confirmer sur un vrai téléphone.
- [x] La maquette s'installe comme application : manifeste `standalone`, icônes, service worker actif et ouverture hors connexion vérifiés par test. L'installation réelle sur Android reste à constater par le porteur.
- [x] `GUIDE-ENTRETIEN.md` est rédigé.

### Écarts par rapport au prompt
- **PWA** : le service worker est celui intégré à SvelteKit (`src/service-worker.ts`), pas le plugin PWA de Vite prévu par `CLAUDE.md` §2. La seule version du plugin compatible avec SvelteKit ≥ 2.63 (`@vite-pwa/sveltekit` 2.0.0, fondé sur `@unplugin-pwa` 0.0.3) ne passait pas le build : modules internes non résolus avec pnpm, adaptateur ignoré. **À trancher au lot 01.**
- **shadcn-svelte** : le CLI n'a pas pu télécharger les composants (`shadcn-svelte.com` est refusé par la politique réseau de l'environnement). Button, Badge, Card et Input sont écrits à la main au format shadcn-svelte (`tailwind-variants`, `clsx`, `tailwind-merge`, icônes `@lucide/svelte`), et `components.json` est en place.
- **Versions** : SvelteKit 2.70.4 et non 3.1.1, la dernière publiée, car `CLAUDE.md` fige SvelteKit 2. Vite 8, Svelte 5.57, Tailwind 4.3, Vitest 4.1, Playwright 1.63 (version du Chromium préinstallé).
- **Dépendance hors liste** : `qrcode`, pour un QR code lisible sur le reçu. Elle a été proposée avant le code.
- **`pnpm lint`** = `svelte-check` avec les avertissements bloquants. ESLint et Prettier ne sont pas installés : ils relèvent du socle (lot 01).
- **Textes** : ils ne sont pas centralisés dans `i18n/fr.ts`, car le code est jetable. Les libellés de statut sont dans `src/lib/labels.ts`.
- **Ajouts mineurs** : le moyen « Virement », en plus d'espèces et Mobile Money (il est cité au cadrage) ; une liste de la vitrine et une liste des propriétaires, pour la navigation ; un bouton « Retirer » sur une annonce publiée.
- **Aperçu** : `pnpm preview` lance un petit serveur statique Node (`scripts/serve-static.mjs`), parce que `vite preview` ne sert pas `/index.html`, dont le service worker a besoin.

### Dette technique
- Code jetable : rien n'est à reprendre tel quel au lot 01, seulement l'ergonomie et les règles de `rules.ts`, qui préfigurent `packages/shared`.
- La vitrine de la maquette est rendue côté client. La vraie vitrine (lot 12) sera rendue serveur. La page d'annonce de la maquette charge environ 70 Ko de JavaScript compressé (101 Ko pour toute l'application) : ce n'est pas représentatif.
- Le QR code et les liens envoyés pointent vers les pages de la maquette. Un reçu créé pendant la démo n'existe que sur le téléphone qui l'a créé.
- Le statut « à rapprocher » ne peut pas être levé dans la maquette : pas d'écran de rapprochement.

### Questions ouvertes pour le porteur
1. **Reçu d'un Mobile Money déclaré** : la maquette émet tout de suite un « reçu provisoire — paiement Mobile Money à rapprocher », avec un numéro. Faut-il plutôt ne rien émettre avant le rapprochement ? Cela touche les règles §5.6 et §5.9 (numéro attribué par le serveur à la validation), à trancher avant le lot 09.
2. **Base du relevé propriétaire** : la maquette calcule la commission sur les loyers **encaissés** dans le mois. Les agences calculent-elles sur l'encaissé ou sur le dû ? À demander pendant les entretiens.
3. **Hébergement de la maquette** : Cloudflare Pages est recommandé (gratuit, cohérent avec la pile). Le déploiement demande l'accès au compte du porteur.
4. **Plugin PWA pour le lot 01** : attendre une version stable de `@vite-pwa/sveltekit`, ou garder le service worker natif de SvelteKit ? Une décision écrite dans `docs/DECISIONS.md` est nécessaire si la pile change.
5. **Réseau de l'environnement de développement** : ouvrir l'accès à `shadcn-svelte.com` pour que le lot 01 utilise le CLI shadcn-svelte.

## Lot 00 bis — Maquette multiprofil et multiplateforme — 07/11/2026

Demande du porteur après test de la maquette : une expérience adaptée à chaque profil et à chaque appareil, et non un écran de téléphone étiré ; icônes professionnelles, aucune émoji. Décision D11, spécification `docs/UX.md`.

### Fait
- **Évaluation** : sur tablette et ordinateur, la maquette affichait l'écran du téléphone sur une colonne de 512 px avec la barre d'onglets ; un seul profil (gestionnaire). Les icônes étaient déjà toutes Lucide, sans émoji.
- **7 profils** (`src/lib/profiles.ts`) avec espace, navigation et périmètre de données propres (`scopeDataset`, qui préfigure les règles de synchronisation) : directeur, gestionnaire, agent de terrain (3 biens affectés, espèces « à valider »), bailleur particulier, propriétaire, locataire, visiteur ou acheteur. Sélecteur « Voir en tant que » pour la démonstration.
- **3 coques** (`src/lib/components/shell/`) : téléphone (onglets en bas), tablette (rail à gauche), ordinateur (menu latéral par sections, barre du haut, recherche Ctrl+K). Store `device` et rendu conditionnel, sans doubler les composants.
- **Écrans repensés par appareil** : tableau de bord en grille d'indicateurs et tableaux ; encaissements et impayés en tableaux avec sélection multiple, validation groupée et relances en série ; menus d'actions par ligne (clavier : flèches, Entrée, Échap) ; vues liste-détail pour les biens et l'encaissement dès 1024 px ; reçu et relevé avec panneau d'actions collant ; feuille du bas sur téléphone, boîte de dialogue sur tablette, tiroir sur ordinateur.
- **Nouveaux espaces** : propriétaire (revenus, biens, relevés), locataire (solde, échéances, reçus, contact et signalement, paiement Mobile Money affiché désactivé), vitrine avec Louer et Acheter, filtres et annonce en deux colonnes.
- **Tests** : 40 tests Vitest (dont `scopeDataset`, type d'appareil et test anti-émoji) ; 24 tests Playwright, dont `e2e/08-multiplateforme.spec.ts` (ordinateur 1440 × 900, tablette 820 × 1180 et 1180 × 820, profils, absence de débordement horizontal sur téléphone). Les 15 tests d'origine passent sans modification.

### Écarts
- Le back-office plateforme n'est pas maquetté : il relève du lot 04 (ordinateur d'abord).
- Les biens à vendre (`src/lib/sales.ts`) sont des fiches simples, sans lien avec le registre.

### Questions ouvertes pour le porteur
- Le libellé « Bailleur particulier » et son périmètre (formule Découverte, sans équipe) conviennent-ils ? À vérifier en entretien.

## Audit fonctionnel et décisions D12 à D19 — 08/11/2026

Demande du porteur avant le lot 01 : un audit fonctionnel et UX/UI complet (cautions et sortie du locataire, espace locataire, propriétaire multi-agences, ajout de biens et statuts, cycle de location, dépenses, modèle SaaS, direction artistique), sans modifier le code avant validation. Rapport : `docs/AUDIT.md`.

### Décisions validées par le porteur
- **D12** organisation (agence ou bailleur particulier) comme unité de cloisonnement ; **D13** comptes de personne et espaces propriétaire et locataire regroupant toutes les organisations, **dès le lancement** ; **D14** statut d'unité en quatre dimensions, occupation calculée ; **D15** compte de caution et décompte de sortie unique ; **D16** un seul mandat de gestion actif par unité ; **D17** aucune information transmise d'une organisation à une autre (le locataire suit son propre historique, rien n'est partagé entre agences) ; **D18** moyens de paiement en réglage d'organisation ; **D19** direction artistique, pas de 3D.

### Fait (documentation seulement, aucun code)
- `CLAUDE.md` : vocabulaire `organization_id`, modules `organizations` et `portals`, règles 12 à 16, glossaire.
- `docs/DECISIONS.md`, `docs/FEATURE-FLAGS.md` (clé `payments.mobile_money_manual` retirée, clés `portals.*` et `listings.facebook_publish` ajoutées), `docs/UX.md` (§2, §9, §10), `docs/LOTS.md`.
- Prompts révisés : lots 01 à 04, 06 à 14. Nouveaux prompts : `lot-00ter-maquette-audit.md` (en parallèle des lots 01 à 05), `lot-10bis-sortie-locataire.md`, `lot-10ter-espaces-personnels.md`.

### Écarts par rapport au rapport
- La sortie du locataire est placée au lot **10 bis** (et non « 08 bis ») : le décompte a besoin des encaissements (lot 09) et des dépenses (lot 10).
- La génération du bail en PDF n'est faite que si un modèle validé par un juriste est fourni avant le lot 08 ; la signature électronique est écartée (article 5 de la loi n° 103-2015/CNT), sans décision écrite à ce stade.

### Questions ouvertes
Voir `docs/DECISIONS.md` : lecture juridique de la loi n° 103-2015/CNT, réparations locatives (article 25), détenteur de la caution, légalisation des baux, nouvelle loi sur les données personnelles (ARCOD), prestataire SMS.
