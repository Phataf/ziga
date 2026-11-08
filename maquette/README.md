# Maquette cliquable — lot 00

Application SvelteKit **100 % statique**, sans serveur ni base de données, qui simule les parcours de la phase 0 avec des données fictives : accueil, encaissement en 3 gestes, impayés, biens et publication, relevé propriétaire, vitrine.

Elle applique `docs/UX.md` : **8 profils** (directeur, gestionnaire, agent de terrain, bailleur particulier, propriétaire, locataire, visiteur ou acheteur, administrateur de la plateforme), chacun avec son espace, et **3 coques** selon l'appareil (téléphone, tablette, ordinateur).

Depuis le lot 00 ter, elle montre aussi les écrans de l'audit du 08/11/2026 (D12 à D19) : **trois organisations** isolées (Immo Démo, Horizon Immo et le bailleur particulier Issouf Sawadogo), le statut d'unité en quatre dimensions, l'assistant d'ajout de bien, la sortie du locataire avec le décompte de caution, les espaces personnels qui regroupent plusieurs organisations, le back-office et le choix de l'espace.

## Démonstration par profil

Le bandeau « Démo » en haut (téléphone), la pastille « Profil » en bas du rail (tablette) ou la carte en bas du menu latéral (ordinateur) ouvrent le sélecteur **« Voir l'application en tant que… »**.

| Profil | Espace | À montrer |
| --- | --- | --- |
| Directeur, gestionnaire | `/` | Tableau de bord, encaisser, impayés, relevés ; sur ordinateur : Ctrl+K, tableaux, actions groupées |
| Agent de terrain | `/` | « Ma tournée », 3 biens affectés, espèces « à valider » |
| Directeur, gestionnaire | `/sorties` | Préavis et sortie du locataire : état des lieux pièce par pièce, décompte 100 000 − 10 000 − 5 000 = 85 000 FCFA, variantes « caution sur les derniers loyers » et « réparé par le locataire » |
| Directeur, gestionnaire, bailleur | `/biens/nouveau` | Assistant d'ajout de bien en cinq étapes, brouillon repris |
| Bailleur particulier | `/` | M. Issouf Sawadogo, son immeuble de Larlé (2 logements, dont un « à remettre en état »), sans menu d'agence |
| Propriétaire | `/proprietaire` | M. Issouf Sawadogo : patrimoine groupé par gestionnaire (deux agences et gestion directe), fiche bien, revenus, relevés |
| Locataire | `/locataire` | M. Rodrigue Yaméogo : solde, reçus, caution et décompte, historique de ses deux baux (Horizon Immo puis Immo Démo), signalements suivis |
| Visiteur ou acheteur | `/vitrine` | Louer ou Acheter, filtres, annonce |
| Administrateur plateforme | `/admin` | Organisations, formules et abonnements, interrupteurs, accès d'assistance motivé, journal (ordinateur d'abord) |
| Une personne, plusieurs espaces | `/espaces` | Choix de l'espace de M. Issouf Sawadogo : « Mon patrimoine » ou « Mes logements » |

Ouvrir l'adresse d'un espace bascule sur le bon profil.

> Code jetable : il sert à valider l'ergonomie auprès des agences, pas à être repris tel quel au lot 01.

## Commandes

```bash
pnpm install
pnpm dev          # développement : http://localhost:5173
pnpm build        # export statique dans build/
pnpm preview      # sert build/ comme un hébergeur statique : http://localhost:4173
pnpm lint         # svelte-check, avertissements bloquants
pnpm typecheck    # svelte-check
pnpm test         # Vitest : formats, règles, données
pnpm test:e2e     # Playwright : parcours en 360 × 800, PWA, hors ligne, 3G, 08-multiplateforme et 09-audit (3 appareils, profils)
```

## Déploiement gratuit

Le dossier `build/` se dépose tel quel sur n'importe quel hébergeur statique. Avec **Cloudflare Pages** :

- dossier racine : `maquette`
- commande de build : `pnpm build`
- dossier de sortie : `build`

Toute route inconnue doit renvoyer `index.html` (application d'une seule page) : c'est le comportement par défaut de Cloudflare Pages quand il n'y a pas de `404.html`.

## Organisation

| Chemin | Rôle |
| --- | --- |
| `src/lib/fixtures.ts` | Données fictives : Immo Démo, 12 biens, 20 unités, 15 locataires, 3 mois d'échéances calculés à partir de la date du jour ; un bail en préavis, deux baux signés à venir |
| `src/lib/fixtures-orgs.ts` | Horizon Immo et le bailleur particulier Issouf Sawadogo, chacun isolé ; personnes et liens vérifiés |
| `src/lib/unit-status.ts` | Statut d'unité en quatre dimensions, occupation calculée à partir des baux, pastille de synthèse |
| `src/lib/deposit.ts` | Décompte de sortie et ses variantes, retenues justifiées, mouvements du compte de caution |
| `src/lib/portals.ts` | Espaces personnels : lecture des organisations liées, une à la fois, journalisée |
| `src/lib/platform.ts` | Back-office : formules, interrupteurs et leur résolution, accès d'assistance |
| `src/lib/rules.ts` | Règles pures : imputation sur l'échéance la plus ancienne, conditions de publication, relevé |
| `src/lib/views.ts` | Vues calculées : impayés, statistiques du mois, relevé propriétaire |
| `src/lib/demo.svelte.ts` | État de la démo ; seules les actions faites pendant la démo sont gardées dans le navigateur |
| `src/lib/format.ts` | `75 000 FCFA`, `+226 70 12 34 56`, `jj/mm/aaaa` |
| `src/lib/whatsapp.ts` | Liens `wa.me` pré-remplis |
| `src/lib/profiles.ts` | Profils, espaces et navigation de chacun |
| `src/lib/device.ts`, `device.svelte.ts` | Type d'appareil (téléphone < 768 px, tablette, ordinateur ≥ 1280 px) |
| `src/lib/components/shell/` | Coques : barre d'onglets, rail, menu latéral, barre du haut, recherche Ctrl+K, sélecteur de profil |
| `src/lib/components/ui/` | Composants au format shadcn-svelte (Button, Badge, Card, Input, Sheet, ActionMenu) |
| `src/routes/(app)/` | Espace agence (directeur, gestionnaire, agent de terrain, bailleur) |
| `src/routes/(owner)/proprietaire/` | Espace propriétaire |
| `src/routes/(tenant)/locataire/` | Espace locataire |
| `src/routes/(public)/` | Vitrine publique (Louer, Acheter), sans menu d'application |
| `src/routes/(admin)/admin/` | Back-office de la plateforme |
| `src/routes/(account)/espaces/` | Choix de l'espace |
| `src/lib/components/wizard/`, `status/`, `Timeline.svelte`, `AgreementCard.svelte` | Assistant pas à pas, pastilles de statut, chronologie, circuit d'accord (docs/UX.md §10) |
| `src/service-worker.ts` | Mise en cache pour l'installation et le hors ligne |
| `GUIDE-ENTRETIEN.md` | Déroulé de la démonstration et questions aux agences |

« Réinitialiser la démo » se trouve en bas de l'onglet **Plus**, et dans le sélecteur de profil.
