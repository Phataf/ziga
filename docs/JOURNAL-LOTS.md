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

## Lot 00 ter — Maquette des écrans de l'audit — 08/11/2026

Prompt : `prompts/lot-00ter-maquette-audit.md`. Seul `maquette/` est modifié (exception à D10 limitée à ce lot), plus ce journal.

### Fait
- **Données de démonstration** : trois organisations, chacune avec son propre jeu de données isolé et sa propre numérotation de reçus (`src/lib/fixtures.ts`, `src/lib/fixtures-orgs.ts`) :
  - Immo Démo (inchangée en volume : 12 biens, 20 unités, 15 locataires) ; bail de Mme Mariétou Sorgho **en préavis** (caution de 100 000 FCFA, libre à la fin du mois) ; baux signés qui rendent « réservées » les deux unités qui l'étaient déjà.
  - **Horizon Immo**, deuxième agence : 2 biens, 3 unités, dont la Maison Kossodo de M. Issouf Sawadogo ; l'ancien bail de M. Rodrigue Yaméogo, clos avec le décompte du porteur (100 000 − 10 000 − 5 000 = 85 000 FCFA).
  - **Bailleur particulier** M. Issouf Sawadogo (Résidence Larlé, 2 logements, dont un **à remettre en état**). Le profil « Bailleur particulier » utilise désormais cette organisation, et non plus des biens d'Immo Démo (qui contredisaient D16).
  - Personnes et liens vérifiés (code SMS et acceptation) : M. Issouf Sawadogo, propriétaire dans les trois organisations ; M. Rodrigue Yaméogo, passé d'Horizon Immo à Immo Démo.
- **Statut en quatre dimensions** (`src/lib/unit-status.ts`) : occupation **calculée à partir des baux** (y compris le statut simplifié du lot 00) ; fiche unité `/biens/[bien]/[unité]` avec une pastille par dimension, le bail, le préavis, le compte de caution et une chronologie ; pastille de synthèse dans les listes, les cartes et les tableaux ; la publication et la vitrine suivent la disponibilité (libre ou en préavis, et prête).
- **Assistant d'ajout de bien** `/biens/nouveau` : cinq étapes (type et propriétaire, localisation avec repère et point GPS, unités, photos et médias, documents privés), brouillon enregistré à chaque étape et repris, fiche active seulement avec un mandat ; « Enregistrer n'est jamais publier ».
- **Sortie du locataire** `/sorties` et `/sorties/[bail]` : préavis ; état des lieux guidé pièce par pièce, comparé à l'entrée, signé des deux parties ; décompte unique et ses trois variantes (restitution après réparations ; caution imputée sur le dernier loyer par accord écrit daté avant le mois ; réparations faites par le locataire après accord et contre-visite) ; refus d'une retenue sans constat imputable, montant ou justificatif ; validation qui ajoute les mouvements au compte de caution et fait passer l'unité « à remettre en état », puis « en travaux », puis « disponible ».
- **Espace propriétaire** : patrimoine groupé par gestionnaire avec filtre, fiche bien (statut, loyers, bail et caution sans l'identité du locataire, dépenses, rendement brut sur valeur déclarée), revenus par mois et par gestionnaire, relevés de chaque agence, compte (gestionnaires, liens vérifiés, lectures journalisées).
- **Espace locataire** : historique des deux baux (chaque élément porte son organisation), caution et décompte avec justificatifs, reçus des deux agences, signalements suivis (reçue, planifiée, faite).
- **Back-office** `/admin` (ordinateur d'abord, utilisable sur tablette et téléphone) : organisations et état effectif des fonctionnalités avec la raison ; formules et abonnements avec paiement saisi à la main ; interrupteurs à trois positions avec motif, confirmation qui compte les organisations touchées et couleur d'alerte ; exceptions par organisation ; accès d'assistance motivé, en lecture seule et limité à deux heures ; journal.
- **Choix de l'espace** `/espaces`, et « Changer d'espace » dans le menu du compte.
- **Composants** (`docs/UX.md` §10) : assistant pas à pas, chronologie, circuit d'accord, pastilles de statut, grosses réponses (ChoiceGroup).
- **Présentation aux pilotes** : déroulé, questions et fiche de remarques ajoutés à `maquette/GUIDE-ENTRETIEN.md`.
- **Tests** : 78 tests Vitest (dont `unit-status`, `deposit`, `portals` et `platform` : occupation calculée, décompte et variantes, retenues refusées, plafond des sorties, lecture une organisation à la fois et seulement sur lien accepté, aucune donnée d'une autre organisation) ; 48 tests Playwright, dont `e2e/09-audit.spec.ts` (7 parcours × 3 appareils, refus d'une retenue sans justificatif, débordement horizontal sur téléphone des 19 nouvelles pages, onglets des espaces personnels). Les 15 tests d'origine et ceux du lot 00 bis passent sans modification ; le test anti-émoji couvre les nouveaux fichiers.

### Critères d'acceptation
- [ ] Le porteur a présenté la sortie du locataire et l'espace propriétaire aux trois agences pilotes ; leurs remarques sont consignées ici, et les écarts avec D14 à D17 sont signalés avant le lot 06 — **à faire par le porteur** ; déroulé, questions et fiche de remarques dans `maquette/GUIDE-ENTRETIEN.md` (section « Lot 00 ter »).
- [ ] Les réponses des pilotes aux questions ouvertes (détenteur de la caution, légalisation des baux) sont reportées dans `docs/DECISIONS.md` — **à faire après les rendez-vous** ; les deux questions figurent dans le guide. Claude Code ne modifie `docs/DECISIONS.md` que sur demande du porteur.

### Écarts par rapport au prompt
- **Préavis et sortie** : la remise des clés et l'état des lieux se font « aujourd'hui » dans la démo, avant la fin du préavis (30/11), pour pouvoir dérouler la sortie à toute date ; le loyer du dernier mois reste dû jusqu'à la fin du préavis.
- **Variante B** : la maquette impute la caution sur le loyer du mois où finit le préavis, s'il n'est pas payé ; l'accord du locataire est daté du 22 du mois précédent. L'imputation n'est pas encore transformée en encaissement avec reçu (lot 10 bis).
- **Contestation du décompte** et **transfert de gestion** : non maquettés (lot 10 bis), seulement mentionnés.
- **Rendement** : calculé sur une valeur déclarée par le propriétaire dans son espace (donnée fictive), jamais vue par les agences.
- **Préavis donné par le locataire en ligne** : non maquetté ; l'espace locataire renvoie vers l'agence.
- **Lecture de la loi n° 103-2015/CNT** (délais de préavis de 2 ou 3 mois, état des lieux, usure normale, plafond de deux mois) : appliquée telle que retenue par l'audit, à confirmer par un juriste.

### Dette technique
- Code jetable, comme aux lots 00 et 00 bis. Les règles pures (`unit-status.ts`, `deposit.ts`, `portals.ts`) préfigurent `packages/shared` et le module `portals`.
- Le back-office n'a pas de rôles plateforme distincts (administrateur général, assistance, commercial, finances) ni de simulateur ; la résolution des interrupteurs n'y traite pas les exceptions par personne ni le réglage du directeur.
- Les textes restent dans les composants (pas de `i18n/fr.ts`).
- Les biens créés avec l'assistant et les sorties validées ne vivent que dans le navigateur qui les a saisis.

### Questions ouvertes pour le porteur
1. **Détenteur de la caution** et **légalisation des baux** : à poser aux trois pilotes (questions 1 et 2 du guide).
2. **Variante B** : faut-il permettre de garder une partie de la caution pour les dégâts, comme le recommande l'audit, ou laisser l'agence refuser l'accord ? La maquette affiche seulement ce qu'il restera.
3. **Remise des clés avant la fin du préavis** : les agences rendent-elles la caution dès la remise des clés, ou seulement à la fin du préavis ?
4. **Rendement** : les propriétaires accepteraient-ils de déclarer la valeur de leur bien ? Sinon, afficher seulement le taux d'occupation et le net.
## Complément de l'audit : contrats de bail et documents — 08/11/2026

Demande du porteur : une vraie gestion contractuelle intégrée à la gestion locative (`docs/AUDIT.md` §C7), analysée à partir du modèle de contrat d'une agence pilote.

### Décisions validées
- **D20** contrat = document du bail, cycle distinct ; modèle Word de l'organisation rempli automatiquement ; légalisation et enregistrement suivis sans bloquer ; bail en vigueur possible sans contrat signé, avec alerte.
- **D21** signature manuscrite et scan au MVP ; un PDF déposé n'est jamais une signature électronique.
- **D22** registre de documents avec matrice de confidentialité par type.
- **D23** docxtemplater (cœur MIT) et Gotenberg (MIT) ajoutés à la pile.
- **D24** bailleur désigné par le contrat ; préavis, reconduction, pénalité, garantie des factures et délai de restitution en paramètres du bail.

### Fait (documentation seulement)
`CLAUDE.md` (pile, module `documents`, règle 17, glossaire), `docs/DECISIONS.md`, `docs/LOTS.md`, `docs/UX.md` §10 (écrans, matrice), `docs/AUDIT.md` ; nouveau prompt `lot-08bis-contrats.md` ; prompts 00 ter, 03, 06, 07, 08, 09, 10 bis, 10 ter et 11 complétés.

### Questions ouvertes
Agence qui signe comme bailleur ; reconduction tacite et clauses de pénalité et de préavis ; délai et coût de la légalisation ; conservation des pièces d'identité ; modèles des deux autres pilotes.

### Décision ajoutée le 08/11/2026
- **D25** : modèle de contrat par défaut conforme à la loi n° 103-2015/CNT, pour toute organisation sans modèle (deux des trois pilotes, bailleurs particuliers) ; relu par un juriste avant la première signature réelle. Clauses listées dans `prompts/lot-08bis-contrats.md`.
- Les écrans de contrats ajoutés au prompt du lot 00 ter après sa réalisation ne sont pas maquettés ; ils le seront au lot 08 bis ou dans une reprise de la maquette si le porteur la demande.

## Lot 01 — Socle technique — 08/11/2026

Prompt : `prompts/lot-01-socle.md`. Décisions du porteur avant le lot : porte 0 franchie (3 agences pilotes engagées), SvelteKit 3 (D26), dépendances hors liste validées, Express, SeaweedFS à la place de MinIO (D27), préparation à la montée en charge dans le périmètre.

### Fait
- **Monorepo** pnpm 10 + Turborepo : `apps/api`, `apps/web`, `packages/shared`, `infra/`, `scripts/`. TypeScript 6.0.3 `strict` partout (avec `noUncheckedIndexedAccess`), ESLint 10 (`typescript-eslint`, `eslint-plugin-svelte`) et Prettier communs. `maquette/` reste hors du workspace (D10).
- **`packages/shared`** (ESM, compilé dans `dist/`) : `money.ts` (`formatFcfa`, `parseFcfa`, `fcfaSchema` ; décimales, négatifs et valeurs non sûres refusés), `phone.ts` (E.164 `+226`, formatage, `phoneSchema`), `ids.ts` (UUIDv7 par `uuid`), `dates.ts` (jj/mm/aaaa, heure de Ouagadougou).
- **API NestJS 12 sur Express** :
  - configuration validée par Zod au démarrage, qui refuse de démarrer en nommant chaque variable manquante ;
  - journaux pino en JSON avec identifiant de requête (`x-request-id`, repris s'il est sûr, sinon UUIDv7) ;
  - erreurs uniformes `{ code, message, details }`, sans jamais exposer une erreur interne ;
  - Sentry désactivable (vide = coupé), sans données personnelles.
- **Montée en charge** (demande du porteur) :
  - deux points d'entrée, `main.ts` (HTTP) et `worker.ts` (BullMQ), lancés comme deux processus ;
  - API sans état ;
  - `DATABASE_POOL_MAX` et `DATABASE_STATEMENT_TIMEOUT_MS` réglables, le délai étant appliqué par `SET LOCAL` dans chaque transaction (compatible PgBouncer en mode transaction) ;
  - `/health/live` et `/health/ready` (base, Redis, stockage ; 503 dès le début d'un arrêt) ;
  - arrêt propre sur SIGTERM et SIGINT avec délai maximal (`SHUTDOWN_TIMEOUT_MS`).
- **Base** : Drizzle ORM 0.45 et drizzle-kit, migrations SQL versionnées. Migration `0000_socle` : rôles `app_api` et `app_admin` sans `BYPASSRLS` ni superutilisateur, privilèges par défaut sur les futures tables, fonction `current_organization_id()`. Les mots de passe des rôles sont lus dans les URL de `.env` par `pnpm db:migrate`, jamais écrits dans une migration. `withOrganization(organizationId, fn)` ouvre une transaction et fixe `app.organization_id` par `set_config(…, true)`, l'équivalent paramétré de `SET LOCAL`.
- **Files de tâches** : BullMQ 6 sur Redis (`ioredis` 6, conforme à la dépendance paire `>=5` de BullMQ), processeur d'exemple dans le worker seulement, concurrence réglable (`WORKER_CONCURRENCY`), tableau de bord bull-board sur `/admin/queues` coupé en production.
- **Stockage** derrière une interface : S3 (`@aws-sdk/client-s3`, SeaweedFS en développement) ou dossier local (tests et sessions sans Docker, refusé en production).
- **Web SvelteKit 3** :
  - `adapter-node`, Tailwind 4, thème de la maquette, composants au format shadcn-svelte, icônes Lucide ;
  - configuration dans `vite.config.ts`, alias `#lib`, textes dans `src/lib/i18n/fr.ts` ;
  - manifeste PWA et service worker natif (`src/service-worker/index.ts`, `$app/manifest`, ouverture hors connexion) ;
  - coque responsive (onglets, rail, menu latéral et barre du haut) avec le store `device` et un rendu `{#if}` ;
  - navigation déclarée pour les 8 profils, écrans vides avec le lot qui les construit, espaces `/espace/proprietaire` et `/espace/locataire`, choix de l'espace `/espace`, back-office `/admin`, vitrine rendue côté serveur ;
  - composants `Sheet`, `ActionMenu`, `PageHeader`, `page` et `page-narrow` ; test anti-émoji.
- **Infrastructure locale** : `infra/docker-compose.dev.yml` (PostgreSQL 16.15 avec `wal_level=logical`, Redis 7.4, SeaweedFS 4.51) ; `pnpm infra:up` attend que les services soient sains et crée le compartiment S3.
- **Sessions Claude Code en ligne** : `.claude/settings.json` appelle `scripts/session-start.sh`. Le script ne fait rien hors session cloud. Il saute `pnpm install` si les manifestes et le fichier de verrouillage n'ont pas changé, démarre les services, puis applique les migrations. Mesures : 10 s depuis des services arrêtés, 6 s ensuite.
- **CI** GitHub Actions (`.github/workflows/ci.yml`) :
  - un job installation, lint, typecheck et tests unitaires et d'intégration, avec PostgreSQL 16 et Redis en services ;
  - un job Playwright séparé.
- **Tests** : 82 tests Vitest et 35 tests Playwright.
  - 35 tests de `packages/shared` : formats, arrondi refusé, négatifs refusés, 10 milliards de FCFA, numéros du Burkina dans des formats variés, UUIDv7.
  - 20 tests unitaires de l'API : configuration et refus de démarrer, erreurs uniformes, arrêt propre et délai, santé, stockage, identifiant de requête.
  - 17 tests d'intégration sur une vraie base `ziga_test` recréée à chaque exécution :
    - `app_api` et `app_admin` sans `BYPASSRLS` ;
    - `withOrganization` visible dans la transaction et absente en dehors (même connexion) ;
    - `statement_timeout` appliqué puis effacé ;
    - migrations rejouables ;
    - `/health` complet, et 503 quand PostgreSQL est injoignable ;
    - tâche traitée par le worker.
  - 10 tests unitaires du web : navigation par profil, type d'appareil, anti-émoji.
  - 35 tests Playwright sur 360 × 800, 820 × 1180 et 1440 × 900 :
    - bonne navigation pour chaque profil, et aucune autre ;
    - « Plus » ;
    - aucun débordement horizontal sur téléphone ;
    - vitrine ;
    - choix de l'espace ;
    - manifeste et service worker ;
    - ouverture hors connexion.

### Critères d'acceptation
- [ ] `pnpm install && pnpm dev` démarre tout depuis un clone neuf, en suivant uniquement le `README.md`. **Vérifié en partie** : dans la session en ligne, `pnpm dev:apps` démarre l'API, le worker et le web sur PostgreSQL et Redis natifs, et `/health/ready` répond. La partie Docker (`pnpm infra:up`) n'a pas pu être exécutée ici : Docker Hub refuse les téléchargements anonymes (429) et les miroirs sont bloqués par le proxy. À constater par le porteur sur son poste.
- [x] `pnpm lint`, `pnpm typecheck` et `pnpm test` passent en local. **La CI est écrite mais n'a pas encore tourné** : elle se déclenche sur `main` et sur les pull requests.
- [x] La barre d'onglets s'affiche en émulation mobile et l'application est installable : manifeste `standalone` avec icônes 192, 512 et masquable, service worker actif, ouverture hors connexion vérifiée par Playwright.
- [x] `docs/JOURNAL-LOTS.md` contient l'entrée du lot.

### Écarts par rapport au prompt
- ~~**Porte 0**~~ : les 3 agences pilotes sont engagées. Écart clos le 08/11/2026 sur la réponse du porteur : aucun entretien formel ; les démonstrations aux trois agences pilotes en tiendront lieu (au lieu des 10 entretiens prévus par D04).
- **SeaweedFS au lieu de MinIO** (D27), l'image MinIO n'étant plus publiée.
- **Guide de migration vers SvelteKit 3** : svelte.dev est bloqué par le réseau de la session. La configuration suit les sources officielles distribuées par npm, et pas le site :
  - le modèle de projet de `sv` 1.3.0 ;
  - les tâches de la migration `sveltekit-3` de `sv` ;
  - les types et les messages d'erreur de `@sveltejs/kit` 3.1.1.

  Points appliqués : `vite.config.ts` sans `svelte.config.js` ; `#lib` avec extensions explicites ; `$app/env`, `$app/manifest` et `resolve()` ; `paths.origin` à la place d'`ORIGIN` ; `tsconfig` du service worker.
- **`paths.relative: false`** dans le web : sinon la coquille hors ligne `/app` charge ses fichiers sous `/app/_app/` quand elle sert une autre page.
- **Session en ligne** : le script utilise Docker seulement si les images sont déjà présentes ; sinon PostgreSQL 16 et Redis de la machine, avec `STORAGE_DRIVER=local` écrit dans `.env` (fichier local, ignoré par git).
- **Profil de l'espace de gestion** : avant l'authentification (lot 02) et les rôles (lot 03), il se choisit par `?profil=` (aperçu des navigations), avec un sélecteur visible en développement seulement. Les espaces propriétaire, locataire et back-office ont un profil fixe.
- **Écrans vides** : une route générique par espace (`[...path]`) affiche l'écran déclaré dans la navigation, ou « Écran introuvable ». La réponse HTTP reste 200, puisque l'application est rendue côté client (`ssr = false` sur `/app`, `/espace` et `/admin`).
- **Composants shadcn-svelte** écrits au format shadcn (le registre `shadcn-svelte.com` est bloqué par le réseau) ; `bits-ui` n'est pas installé tant qu'aucun composant ne l'utilise.
- **Outillage ESLint** ajouté : `@eslint/js`, `eslint-config-prettier`, `globals` (configuration ESLint commune demandée par le prompt).
- **Deux composants génériques** (`Button`, `ActionMenu`) désactivent localement la règle `svelte/no-navigation-without-resolve` : ils reçoivent des liens déjà résolus par l'appelant. Tous les autres liens passent par `resolve()`.

### Dette technique
- `app_admin` n'a pas encore de politiques ni de journalisation de ses accès : lot 04.
- `pnpm db:seed` n'a rien à semer avant les tables métier (lot 03).
- La recherche globale (Ctrl+K) de la maquette n'est pas reprise : elle arrivera avec les premiers écrans métier.
- ~~Nom de l'application provisoire~~ : réglé par D28 (Ziga).
- Le test d'intégration du worker vérifie le traitement ; l'attente des tâches en cours à l'arrêt est couverte par les tests unitaires de l'arrêt et par le comportement de BullMQ, pas par un test de bout en bout.

### Questions ouvertes pour le porteur
1. ~~Nombre d'entretiens de la phase 0~~ : clos au lot 03 (aucun entretien formel ; démonstrations aux trois agences pilotes).
2. ~~Nom de la plateforme pour le manifeste et l'interface~~ : Ziga (D28).
3. ~~Ouvrir `svelte.dev` et `shadcn-svelte.com` dans le réseau de l'environnement en ligne~~ : fait le 08/11/2026.

## Lot 02 — Authentification — 08/11/2026

Prompt : `prompts/lot-02-authentification.md`. Plan validé par le porteur avec ses compléments : domaines dans D28, `@node-rs/argon2` et `jose` ajoutées à `CLAUDE.md` §2, SMS de développement hors des journaux, délai de grâce de 10 s, réponse à une inscription sur un numéro déjà vérifié, et corrections a à e (numéros de tout pays, hors connexion, limite par IP, délai progressif, RLS par personne).

### Fait
- **`packages/shared`** :
  - `phone.ts` accepte tout numéro E.164, de tout pays (diaspora), avec une liste de pays proposés (Burkina Faso en tête, `+226` par défaut) et une vérification plus fine des numéros burkinabè ;
  - `auth.ts` : schémas Zod d'inscription, de vérification, de connexion, de mot de passe oublié et de réinitialisation, réutilisés par l'API et les formulaires ; rôles plateforme ; messages qui ne révèlent pas si un numéro existe.
- **Base** (migration `0001_identity`) :
  - tables `users`, `sessions`, `refresh_tokens` et `otp_codes` ;
  - mots de passe en argon2id, codes en HMAC-SHA256, jetons de rafraîchissement en SHA-256 : rien en clair ;
  - RLS sur `sessions` et `refresh_tokens` par `SET LOCAL app.user_id` (fonction `current_user_id()`, aide `withUser`) ; `app_api` ne peut ni supprimer un jeton de rafraîchissement ni le modifier, sauf sa date d'usage.
- **Module `identity`** :
  - inscription, vérification du numéro par code à 6 chiffres (10 min, 5 essais, usage unique), connexion, déconnexion, mot de passe oublié (toutes les sessions révoquées) ;
  - jeton d'accès JWT EdDSA de 15 min (`jose`), clés publiques en JWKS avec identifiant de clé sur `/.well-known/jwks.json`, rotation des clés par `AUTH_JWT_KEYS` (la première signe, les suivantes vérifient) ;
  - jeton de rafraîchissement de 30 jours dans le cookie `__Host-ziga_rt` (httpOnly, Secure, SameSite=Lax), renouvelé à chaque usage ; une réutilisation dans le délai de grâce de 10 s est refusée (409), au-delà toutes les sessions de la personne sont révoquées ;
  - vérification de l'origine et corps JSON exigés sur `/auth/refresh` et `/auth/logout` ; CORS limité à `CORS_ORIGINS` ;
  - limites de débit en Redis : par numéro (connexion, envoi de code) et plafond par IP (300 par minute, réglable) ;
  - délai progressif après un échec (1 s, 2 s, 4 s… jusqu'à 60 s), par numéro et par IP, appliqué aussi aux numéros inconnus ; la réinitialisation par SMS reste toujours possible ;
  - inscription sur un numéro déjà vérifié : même réponse à l'écran, et un SMS « Un compte Ziga existe déjà pour ce numéro. Utilisez « Mot de passe oublié ». », sous les mêmes limites ;
  - garde global : toute route exige un jeton, sauf les exceptions marquées `@Public()` (authentification, JWKS, santé) ;
  - appareils connectés (`GET /sessions`) et déconnexion d'un appareil (`DELETE /sessions/:id`) ;
  - premier super administrateur par la commande `admin:create-super-admin`, jamais par l'interface ; clés par `auth:keygen`.
- **Module `notifications`** : interface `SmsSender`, implémentations `console` (ligne à part sur la sortie standard, hors des journaux pino), `file` (tests de bout en bout) et `memory` (tests d'intégration).
- **Web** :
  - écrans `/connexion`, `/inscription`, `/verification`, `/mot-de-passe-oublie` et `/espace/appareils` ;
  - numéro avec indicatif (`+226` affiché par défaut, autre pays au choix) et clavier téléphonique ; code avec clavier numérique et remplissage automatique ;
  - jeton d'accès en mémoire seulement ; rafraîchissements sérialisés entre onglets (Web Locks), 409 réessayé ;
  - repère non secret de la dernière personne connectée (identifiant, nom, rôle, date), valable 30 jours glissants : hors connexion, la coque s'affiche ; seul un 401 renvoie vers `/connexion` ;
  - gardes de `/app` et `/espace` (session) et de `/admin` (rôle plateforme) ; retour à l'écran demandé après connexion, sans redirection ouverte ;
  - une personne sans organisation arrive sur `/espace`, avec ses espaces personnels vides ;
  - « Mes appareils » et « Se déconnecter » dans chaque coque (menu latéral, rail, écran « Plus », choix de l'espace) ; nom de la personne dans la barre du haut.
- **CI** : le job Playwright tourne désormais contre la vraie API, avec PostgreSQL et Redis en services.
- **Tests** : 143 tests Vitest et 51 tests Playwright.
  - 54 tests de `packages/shared` (numéros de tout pays, schémas d'authentification).
  - 22 tests unitaires de l'API (configuration d'authentification, refus de démarrer en production sans clés ni prestataire SMS).
  - 49 tests d'intégration, dont 36 pour le lot :
    - inscription, vérification, connexion, rafraîchissement, déconnexion ;
    - rotation, délai de grâce et révocation sur réutilisation ;
    - code expiré, code déjà utilisé, 6e essai refusé ;
    - limites par numéro, par envoi de SMS et par IP ; délai progressif puis levée ;
    - même message pour un numéro inconnu et un mauvais mot de passe ;
    - appareils d'une autre personne invisibles ; RLS vérifiée en SQL avec `app_api` ;
    - garde global sur toutes les routes ; JWKS ; super administrateur ;
    - journaux capturés sans mot de passe, code ni jeton.
  - 18 tests unitaires du web, dont 8 pour le repère de 30 jours, la règle « seul un 401 déconnecte » et le chemin de retour.
  - 51 tests Playwright (35 de la coque, désormais connectés, et 16 nouveaux) :
    - inscription puis connexion sur téléphone, en moins d'une minute ;
    - personne sans organisation sur son espace personnel ;
    - même message d'erreur, numéro invalide, autre pays ;
    - gardes et retour à l'écran demandé, back-office refusé sans rôle plateforme ;
    - session conservée au rechargement, cookie httpOnly, aucun jeton dans le stockage du navigateur ;
    - connexion, coupure du réseau, rechargement : la coque s'affiche sans redirection ;
    - cookie refusé (401) : renvoi vers la connexion et repère effacé ;
    - mot de passe oublié ;
    - deux appareils, déconnexion de l'un depuis l'autre ;
    - écrans d'authentification en 360 × 800, 820 × 1180 et 1440 × 900, sans débordement, cibles de 44 px.

### Critères d'acceptation
- [x] Un nouvel utilisateur s'inscrit et se connecte en moins d'une minute : mesuré par le test Playwright (inscription, code lu dans le fichier des SMS, vérification, déconnexion, connexion), quelques secondes.
- [x] Aucune donnée sensible en clair en base ni dans les journaux : empreintes seulement en base (vérifié par les tests), journaux capturés pendant un parcours complet sans mot de passe, code ni jeton.
- [x] Toutes les routes de l'API hors authentification et `/health` exigent un jeton valide par défaut : garde global, exceptions `@Public()` explicites, test qui parcourt toutes les routes déclarées.
- [x] Journal des lots mis à jour.

### Écarts par rapport au prompt
- **Verrouillage après 5 échecs remplacé par un délai progressif** (correction d du porteur) : il ne bloque pas un compte qu'un tiers viserait exprès. Le test « verrouillage puis déverrouillage » devient « délai qui s'allonge, puis levé après le délai ».
- **Marge par IP** (`AUTH_IP_FAILURE_ALLOWANCE`, 20) : interprétation à confirmer. Une adresse IP partagée (réseau mobile, cybercafé) cumule les échecs de plusieurs personnes ; elle n'a son propre délai qu'au-delà de 20 échecs, alors que chaque numéro a le sien dès le premier.
- **Code SMS de développement** : affiché sur la sortie de l'API, sur une ligne à part, et non dans les journaux comme le dit le prompt (validé par le porteur).
- **Table `refresh_tokens`** en plus de `sessions` : une session garde la suite de ses jetons, ce qui permet de reconnaître une réutilisation et le délai de grâce.
- **Production bloquée** tant qu'il n'y a pas de vrai prestataire SMS : la configuration refuse `console`, `file` et `memory` en production.
- **Révocation** : un jeton d'accès déjà émis reste valable jusqu'à son expiration (15 min au plus), puisque l'API est sans état ; la révocation agit au rafraîchissement suivant.
- **Déconnexion hors connexion** : refusée avec un message, car elle laisserait la session ouverte côté serveur.
- **`/app` ouvert à toute personne connectée** jusqu'au lot 03, qui vérifiera l'appartenance à une organisation ; l'aperçu `?profil=` reste en développement. `/espace` propose encore les quatre espaces (lot 10 ter : seulement ceux de la personne).
- **Écrans d'authentification rendus côté client** (`ssr = false`) : ils parlent directement à l'API, qui pose le cookie.
- **Avertissement SvelteKit `window_fetch_in_load`** dans la console : les gardes appellent l'API (autre origine, avec cookie) par `fetch` du navigateur, volontairement.
- **Tests de bout en bout** : l'API de test (`apps/api/scripts/e2e-server.mjs`) recrée la base `ziga_e2e`, utilise la base Redis n° 2, écrit les SMS dans un fichier et relève les limites de débit du compte de test partagé par les tests.
- **`/verification`, « Renvoyer le code »** : l'inscription en cours reste en mémoire de l'onglet (jamais dans le stockage du navigateur) ; après un rechargement, l'écran invite à se connecter, ce qui renvoie un code.

### Dette technique
- ~~Pas encore de journal d'audit des événements d'authentification~~ : fait au lot 03.
- Pas de tâche de nettoyage des codes et des jetons de rafraîchissement expirés.
- Pas de vrai prestataire SMS (hors périmètre).
- Les rôles plateforme `sales` et `finance` existent sans usage avant le lot 04.

### Questions ouvertes pour le porteur
1. ~~Nombre d'entretiens de la phase 0~~ : clos au lot 03 (aucun entretien formel ; démonstrations aux trois agences pilotes).
2. ~~Préproduction~~ : `ziga-staging.com`, D28 inchangée (réponse du 08/11/2026).
3. ~~Marge d'échecs par IP~~ : 20 échecs, validée (réponse du 08/11/2026).

## Lot 03 — Organisations, rôles, cloisonnement et journal d'audit — 08/11/2026

Prompt : `prompts/lot-03-agences-roles-audit.md`. Plan validé par le porteur avec ses réponses et compléments :
- membres `active` et `removed` seulement ;
- le gestionnaire voit l'équipe en lecture (`member.read`), le rôle `viewer` ne la voit pas ;
- l'envoi du logo est fait dans ce lot ;
- liste des pièces d'identité validée, « Autre » demande une précision ;
- compléments a (paramètres de l'organisation avec aperçu de l'en-tête des reçus), b (D29) et c (« Mon compte ») ;
- événements d'authentification du lot 02 au journal ;
- retrait de `?profil=`.

### Fait
- **Documentation** :
  - D29 dans `docs/DECISIONS.md` : un document émis fige les données de l'organisation ;
  - `docs/UX.md` : profil « Lecture et comptabilité », section Agence (équipe, paramètres, journal), « Mon compte » ;
  - gabarit de cloisonnement dans `apps/api/src/db/README.md`.
- **`packages/shared`** :
  - `permissions.ts` : rôles, matrice des actions (8 avec endpoint au lot 03, 13 déclarées pour les lots suivants), `can()`, profil de navigation d'un membre ;
  - `organizations.ts` : création, paramètres, représentant légal (D24), invitation, logo, « Mon compte », vues de l'API.
- **Migration `0002_organizations_audit`** :
  - fonction `enable_organization_rls(table)` : RLS activée **et forcée**, politique `organization_id = current_organization_id()` ;
  - `organizations` avec le représentant légal, contrainte RCCM et IFU pour une agence vérifiée, `plan_id` nullable ;
  - `organization_members` : triggers « bailleur à un seul membre directeur » et « dernier directeur », sous verrou de l'organisation ;
  - `organization_invitations` : empreinte du lien, 7 jours, usage unique, refusée pour un bailleur ;
  - `organization_logos` : versions jamais écrasées, clé composite `(id, logo_id)` depuis `organizations` ;
  - `audit_log` en ajout seul : triggers sur `UPDATE`, `DELETE` et `TRUNCATE`, droits retirés aux rôles applicatifs.
- **Événements de plateforme** : `audit_log` a deux portées.
  - Avec `organization_id` : l'événement est visible dans le seul contexte de son organisation, par la politique du gabarit, inchangée.
  - Sans organisation : l'événement est visible par la personne concernée (`subject_user_id`), en contexte personnel seulement, et par `app_admin`.
  - Une transaction a soit `app.organization_id`, soit `app.user_id`, jamais les deux. Les aides SQL le garantissent, et les politiques personnelles exigent `current_organization_id() IS NULL`.
- **API** :
  - `RequestContext` (AsyncLocalStorage) : identifiant de requête, adresse IP, origine (`app` si l'origine est celle du web) ;
  - garde `@OrganizationScoped()` : en-tête `X-Organization-Id`, appartenance relue à chaque requête, intercepteur qui ouvre `withOrganization` autour du handler ;
  - `@Can('action')` : 403 `FORBIDDEN_ACTION` ;
  - `AuditService.record(tx, …)` toujours dans la transaction de l'action ; tâches lancées seulement après validation (`afterCommit`) ;
  - règles de la base traduites en erreurs 409 claires (`LANDLORD_SINGLE_MEMBER`, `LAST_DIRECTOR`).
- **Endpoints** :
  - `GET /me/organizations`, `POST /organizations` ;
  - `GET` et `PATCH /organization`, `PUT /organization/logo` ;
  - membres : liste, changement de rôle, retrait ;
  - invitations : liste, création, révocation ; aperçu public `GET /invitations/:token` et acceptation ;
  - `GET /organization/audit` (curseur) ;
  - logos publics `GET /logos/:org/:logo/web.webp|print.png`, sans lecture en base, cache permanent ; l'original n'est jamais servi ;
  - « Mon compte » : `PATCH /me`, `POST /me/password`, `POST /me/phone` et `/me/phone/confirm`, `GET /me/activity`.
- **Logo** :
  - PNG, JPEG ou WebP de 2 Mo au plus, type vérifié sur le contenu ; SVG refusé ;
  - traité par sharp 0.35.5 dans une tâche BullMQ du worker : WebP de 512 px pour le web, PNG de 1 000 px pour les PDF, métadonnées retirées, jamais agrandi ;
  - une image illisible est marquée en échec sans remplacer le logo en place.
- **Journal** :
  - toute action du lot écrit sa ligne avec avant et après (seuls les champs qui changent) ;
  - événements de plateforme : `auth.account_created`, `login`, `logout`, `session_revoked`, `refresh_reuse_detected`, `password_reset`, `password_change`, `phone_change`, `profile_update`.
- **`pnpm db:seed`** :
  - agences Faso Immobilier (A) et Sahel Habitat (B), chacune avec un membre par rôle ;
  - un bailleur particulier dirigé par la gestionnaire de A ;
  - une personne sans organisation ;
  - mot de passe dans `SEED_DEMO_PASSWORD`, refusé en production, rejouable.
- **Web** :
  - organisation active gardée sur l'appareil (pour la coque hors connexion), envoyée dans `X-Organization-Id`, effacée à la déconnexion ;
  - profil déduit du rôle ; `?profil=` et le sélecteur d'aperçu retirés ;
  - écrans :
    - `/espace` : vraies organisations, espaces personnels, compte ;
    - `/espace/nouvelle-organisation` ;
    - `/app/organisation` : paramètres, logo, aperçu de l'en-tête des reçus ;
    - `/app/equipe` : cartes sur téléphone, tableau et menu d'actions sur ordinateur, invitation par WhatsApp ;
    - `/app/journal` ;
    - `/invitation/[token]` ;
    - `/espace/compte` ;
    - activité récente sur « Mes appareils » ;
  - nom de l'organisation active dans la coque ; un membre retiré revient au choix de l'espace avec un message.
- **Correctifs Windows** :
  - dépendances réinstallées avant chaque script (`verifyDepsBeforeRun`) ;
  - `@ziga/shared` compilé avant les commandes de l'API ;
  - saisie du mot de passe du super administrateur sous Git Bash ;
  - message clair quand la base n'est pas migrée.
- **Tests** : 248 tests Vitest et 67 tests Playwright.
  - 67 tests de `packages/shared` : matrice complète par rôle, schémas.
  - 22 tests unitaires de l'API.
  - 136 tests d'intégration, dont 87 pour le lot :
    - accès croisé par l'API et en SQL avec `app_api`, pour chacune des 5 tables : lire, modifier, écrire, référencer, supprimer ;
    - sans contexte, aucune ligne ;
    - contexte personnel ;
    - matrice par rôle sur chaque endpoint du lot ;
    - retrait immédiat ; organisation active ; bailleur ; dernier directeur ;
    - invitations expirée, utilisée, révoquée, d'un autre numéro, altérée ;
    - journal en ajout seul, même pour le propriétaire ; atomicité dans les deux sens ;
    - événements de plateforme invisibles depuis une organisation et pour une autre personne ;
    - « Mon compte » et logo (worker réel).
  - 23 tests unitaires du web, dont l'organisation active et les appartenances gardées.
  - 67 tests Playwright, dont 16 nouveaux (12 dans `organisations.spec.ts`, 4 dans la coque : profil « Lecture et comptabilité » sur trois appareils, back-office sans débordement) :
    - invitation acceptée depuis un autre téléphone, puis retrait ;
    - lien utilisé par un autre numéro ;
    - équipe en lecture pour le gestionnaire ;
    - création des deux types d'organisation ;
    - organisation active ;
    - paramètres et logo avec l'aperçu ;
    - « Mon compte » ;
    - trois tailles d'écran sans débordement, cibles de 44 px ;
    - la coque se connecte désormais avec un compte de démonstration par rôle.

### Critères d'acceptation
- [x] Les tests d'accès croisé couvrent chaque table du lot (`organizations`, `organization_members`, `organization_invitations`, `organization_logos`, `audit_log`) et passent.
- [x] La matrice de permissions est une source unique (`packages/shared/src/permissions.ts`), lue par la garde `@Can` de l'API et par l'interface.
- [x] Le gabarit RLS et clé composite est documenté (`apps/api/src/db/README.md`) et prêt à réutiliser (`enable_organization_rls`, testé sur la clé composite du logo).
- [x] Un directeur invite un gestionnaire, qui accepte depuis un autre téléphone, en moins de 2 minutes : vérifié par le test Playwright, qui échoue au-delà de 2 minutes (toute la suite tourne en moins d'une minute).
- [x] Journal des lots mis à jour.

### Écarts par rapport au prompt
- **Statut des membres** : `active` et `removed` seulement (validé). L'état « invité » est porté par `organization_invitations`.
- **Lecture du journal par le back-office** : la politique `app_admin` est en place et testée en SQL (événements de plateforme oui, ceux d'une organisation non). L'endpoint et l'écran arrivent au lot 04, avec la connexion `app_admin` de l'API et l'accès d'assistance motivé : aujourd'hui l'API n'a qu'une connexion, `app_api`.
- **« Sessions coupées sur l'agence »** : un jeton d'accès ne porte aucune organisation. L'appartenance est relue à chaque requête, donc un membre retiré perd l'accès à sa requête suivante, avec le même jeton. La synchronisation (lot 05) devra appliquer la même règle.
- **Invitation** : acceptée seulement par la personne dont le numéro vérifié est celui de l'invitation. Sans compte, la personne s'inscrit d'abord avec ce numéro.
- **Pagination du journal** par identifiant (UUIDv7, ordonné dans le temps), pour ne sauter aucune ligne à la milliseconde près.
- **Création d'une organisation** dans le contexte de la nouvelle organisation (`WITH CHECK id = current_organization_id()`) : aucune exception au cloisonnement.
- **Dépendance ajoutée** : `sharp` 0.35.5 (dans la pile de `CLAUDE.md` §2), binaires précompilés pour Linux et Windows, sans script d'installation.
- **Gestionnaire** : ajout de l'entrée « Équipe » (lecture) dans sa navigation, conformément à la réponse du porteur.
- **Bailleur particulier** : ses paramètres (logo des reçus) et son journal dans sa navigation, sans équipe.
- **Logo affiché** : l'écran montre le dernier envoi s'il est en cours ou en échec, sinon le logo en place.
- **Lot 08 bis** : le cœur gratuit de docxtemplater n'insère pas d'image (note de D29). Le logo devra venir de l'image déjà présente dans le modèle Word, ou remplacée dans le fichier du modèle.

### Dette technique
- Pas de nettoyage des invitations expirées, des codes ni des jetons de rafraîchissement (tâche planifiée à prévoir).
- Pas de recadrage du logo à l'écran : il est redimensionné en gardant ses proportions.
- `users` reste sans RLS (table de plateforme, lue par l'API pour les noms des membres) ; à revoir quand le back-office aura sa connexion (lot 04).
- Les adresses publiques du logo passent par l'API ; en production, Cloudflare les mettra en cache (fichiers jamais réécrits).

### Questions ouvertes pour le porteur
1. ~~**Porte 0**~~ : aucun entretien formel ; les démonstrations aux trois agences pilotes en tiendront lieu (réponse du 08/11/2026).
