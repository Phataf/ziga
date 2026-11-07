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
| D09 | 07/11/2026 | PWA : service worker natif de SvelteKit, sans plugin PWA (le plugin ne passait pas le build au lot 00). | `CLAUDE.md` §2 mis à jour. |
| D10 | 07/11/2026 | La maquette reste dans `maquette/`. Elle sert de référence d'ergonomie et de démonstration ; le produit ne la reprend pas telle quelle et le lot 01 ne la modifie pas. | Monorepo du produit à côté de `maquette/`. |
| D11 | 07/11/2026 | Expérience **multiprofil et multisupport** : 7 profils (directeur, gestionnaire, agent de terrain, bailleur particulier, propriétaire, locataire, visiteur ou acheteur), chacun avec son espace ; 3 coques par appareil (téléphone, tablette, ordinateur) ; icônes Lucide uniquement, aucune émoji. Les espaces propriétaire et locataire s'ouvrent **par lien, sans compte**, dès le MVP (lecture seule). | Spécification `docs/UX.md` ; coque responsive au lot 01 ; espace locataire au lot 09 ; espace propriétaire au lot 10 ; vitrine Louer et Acheter au lot 12. |

## Questions ouvertes (à trancher avant le lot indiqué)

| Question | Avant le lot | Source à consulter |
| --- | --- | --- |
| Plafond légal de la caution (2 mois ?) et règles de l'arrêté du 8 avril 2026 sur les démarcheurs | 08 | Texte officiel de la loi 103-2015/CNT et de l'arrêté |
| Contenu minimal d'un reçu de loyer | 09 | Juriste, pratiques des agences pilotes |
| Formalités de déclaration à la CIL | 13 | CIL |
| SvelteKit 2 ou 3 : compatibilité de la version 3 avec PowerSync et shadcn-svelte | 01 | Documentation actuelle des trois projets |
| Agrégateur de paiement retenu (CinetPay, Ligdicash, PayDunya…) : frais, KYC, plafonds, notifications | 14 | Grilles et documentation des prestataires |
