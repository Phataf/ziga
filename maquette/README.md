# Maquette cliquable — lot 00

Application SvelteKit **100 % statique**, sans serveur ni base de données, qui simule les 6 parcours de la phase 0 avec des données fictives : accueil, encaissement en 3 gestes, impayés, biens et publication, relevé propriétaire, vitrine.

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
pnpm test:e2e     # Playwright : 6 parcours en 360 × 800, PWA, hors ligne, 3G
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
| `src/lib/components/ui/` | Composants au format shadcn-svelte (Button, Badge, Card, Input) |
| `src/routes/(app)/` | Application de l'agence, avec la barre de 4 onglets |
| `src/routes/(public)/` | Vitrine publique, sans barre d'onglets |
| `src/service-worker.ts` | Mise en cache pour l'installation et le hors ligne |
| `GUIDE-ENTRETIEN.md` | Déroulé de la démonstration et questions aux agences |

« Réinitialiser la démo » se trouve en bas de l'onglet **Plus**.
