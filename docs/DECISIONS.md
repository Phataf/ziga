# Décisions du projet

Journal des décisions structurantes. Une décision ne change que par une nouvelle entrée datée qui la remplace. Claude Code ne modifie pas ce fichier sans demande explicite du porteur.

| N° | Date | Décision | Conséquence pour le code |
| --- | --- | --- | --- |
| D01 | 07/11/2026 | Le porteur développe lui-même avec Claude Code. Le budget initial (< 2 000 000 FCFA) finance l'exploitation, le juridique, le pilote et le lancement. | Privilégier les outils libres et auto-hébergeables ; pas de service payant sans validation. |
| D02 | 07/11/2026 | La gestion locative (baux, échéancier, encaissements, reçus, impayés) fait partie du MVP. | Lots 06 à 10 avant la vitrine. |
| D03 | 07/11/2026 | La plateforme est un **registre des paiements**. Elle ne détient jamais les fonds. Les intégrations d'API de paiement direct sont **prévues dès la conception** et livrées en phase 3, vers le compte marchand de l'agence. | Interface d'adaptateur de paiement dès le lot 09 (implémentation `manual`) ; agrégateurs au lot 14 ; identifiants marchands par agence. |
| D04 | 07/11/2026 | La phase 0 (10 entretiens, 3 agences pilotes, maquettes cliquables) n'est pas sautée. | Lot 00 = maquettes sans backend ; le lot 01 démarre après la porte 0. |
| D05 | 07/11/2026 | Chaque fonctionnalité optionnelle (paiement direct, annonces, etc.) est pilotable par l'administrateur : coupée pour tous, ouverte à tous, ou ouverte sur liste, avec exceptions par agence ou par personne. | Moteur d'interrupteurs au lot 04, avant les modules métier ; spécification `docs/FEATURE-FLAGS.md`. |
| D06 | 07/11/2026 | Pile : SvelteKit, NestJS, PostgreSQL, PowerSync, Cloudflare, en TypeScript. | Voir `CLAUDE.md` §2. |
| D07 | 07/11/2026 | Application local-first : lecture locale, synchronisation en arrière-plan. | Socle de synchronisation au lot 05, avant les modules métier ; identifiants UUIDv7 générés côté client. |
| D08 | 07/11/2026 | Lancement à Ouagadougou et Saaba, location résidentielle d'abord ; bureaux et commerces sur le même modèle ; vente et terrains en fiche simple. | Types d'unités paramétrables ; pas de pipeline de vente. |
| D09 | 07/11/2026 | PWA : service worker natif de SvelteKit, sans plugin PWA. Remplace la ligne PWA de la pile (D06, `CLAUDE.md` §2) : au lot 00, `@vite-pwa/sveltekit` 2.0.0 ne passait pas le build avec SvelteKit 2.70. | Mise en cache et hors ligne écrits dans `apps/web/src/service-worker.ts` (module `$service-worker`), manifeste statique dans `static/` ; aucune dépendance PWA. |
| D10 | 07/11/2026 | La maquette du lot 00 reste dans `maquette/`. Le lot 01 ne la modifie pas. | `maquette/` reste un projet autonome, avec ses propres dépendances et son lockfile, hors des workspaces pnpm et de Turborepo ; les commandes du monorepo ne la touchent pas. |

## Questions ouvertes (à trancher avant le lot indiqué)

| Question | Avant le lot | Source à consulter |
| --- | --- | --- |
| SvelteKit 2 ou 3, selon la compatibilité avec PowerSync et shadcn-svelte | 01 | Documentation du SDK web de PowerSync, de shadcn-svelte et guide de migration vers SvelteKit 3 |
| Plafond légal de la caution (2 mois ?) et règles de l'arrêté du 8 avril 2026 sur les démarcheurs | 08 | Texte officiel de la loi 103-2015/CNT et de l'arrêté |
| Contenu minimal d'un reçu de loyer | 09 | Juriste, pratiques des agences pilotes |
| Formalités de déclaration à la CIL | 13 | CIL |
| Agrégateur de paiement retenu (CinetPay, Ligdicash, PayDunya…) : frais, KYC, plafonds, notifications | 14 | Grilles et documentation des prestataires |
