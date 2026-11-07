# Maquette cliquable — lot 00

Application SvelteKit **100 % statique**, sans serveur ni base de données, qui simule les parcours de la phase 0 avec des données fictives : accueil, encaissement en 3 gestes, impayés, biens et publication, relevé propriétaire, vitrine.

Elle applique `docs/UX.md` : **7 profils** (directeur, gestionnaire, agent de terrain, bailleur particulier, propriétaire, locataire, visiteur ou acheteur), chacun avec son espace, et **3 coques** selon l'appareil (téléphone, tablette, ordinateur).

## Démonstration par profil

Le bandeau « Démo » en haut (téléphone), la pastille « Profil » en bas du rail (tablette) ou la carte en bas du menu latéral (ordinateur) ouvrent le sélecteur **« Voir l'application en tant que… »**.

| Profil | Espace | À montrer |
| --- | --- | --- |
| Directeur, gestionnaire | `/` | Tableau de bord, encaisser, impayés, relevés ; sur ordinateur : Ctrl+K, tableaux, actions groupées |
| Agent de terrain | `/` | « Ma tournée », 3 biens affectés, espèces « à valider » |
| Bailleur particulier | `/` | Ses 2 logements, sans menu d'agence |
| Propriétaire | `/proprietaire` | Revenus, biens, relevés (ouvert par lien, sans compte) |
| Locataire | `/locataire` | Solde, échéances, reçus, contact et signalement d'un problème |
| Visiteur ou acheteur | `/vitrine` | Louer ou Acheter, filtres, annonce |

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
pnpm test:e2e     # Playwright : parcours en 360 × 800, PWA, hors ligne, 3G, et 08-multiplateforme (3 appareils, profils)
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
| `src/lib/fixtures.ts` | Données fictives : Immo Démo, 12 biens, 20 unités, 15 locataires, 3 mois d'échéances calculés à partir de la date du jour |
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
| `src/service-worker.ts` | Mise en cache pour l'installation et le hors ligne |
| `GUIDE-ENTRETIEN.md` | Déroulé de la démonstration et questions aux agences |

« Réinitialiser la démo » se trouve en bas de l'onglet **Plus**, et dans le sélecteur de profil.
