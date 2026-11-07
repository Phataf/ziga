> **Note pour Claude Code** : ce document explique le *pourquoi* du projet (marché, concurrence, choix, budget). Il ne se code pas directement. Pour savoir *quoi* construire, suis `CLAUDE.md`, `docs/DECISIONS.md` et le prompt du lot en cours, qui l'emportent en cas de différence. Les deux schémas du document original (architecture et feuille de route) ne sont pas reproduits ici.

# Cadrage — Plateforme immobilière Burkina Faso

Nov 6, 2026 · @Phataf

Ce cadrage répond au document « Projet de plateforme immobilière — cadrage initial v1.0 » (section 21) et intègre l'analyse de Zakafy.bf faite le 6 novembre 2026. Chaque affirmation importante porte une étiquette :

- **\[Fait\]** : vérifié sur une source publique, citée en fin de document.
- **\[Hypothèse\]** : non vérifiée ; la ligne indique comment la valider.
- **\[Reco\]** : recommandation argumentée du consultant.

Les montants sont en FCFA, hors taxes, et sont des ordres de grandeur, pas des devis.

## 1. Avis exécutif

**Verdict : la direction est bonne, le périmètre ne l'est pas.** Construire d'abord un outil de gestion pour les agences est le seul angle où vous battez Zakafy. En revanche, le document décrit un ERP immobilier, une marketplace, un outil marketing multicanal, un module de paiement, des visites 360° et un moteur de configuration. C'est 12 à 18 mois de travail pour une équipe, pas un MVP.

**Pourquoi l'angle gestion gagne.** Zakafy s'arrête à la mise en relation et ses CGU disent qu'il ne vérifie pas l'exactitude des annonces \[Fait\]. Il n'a que 8 agences, dont une qui porte 197 annonces sur 230 \[Fait\]. Un outil que l'agence ouvre chaque jour pour suivre ses loyers crée une habitude que Zakafy ne peut pas offrir. Et une annonce issue d'un portefeuille géré est fiable par construction : l'unité passe « louée » dès que le bail est signé, donc l'annonce disparaît seule.

**Proposition de valeur reformulée \[Reco\].**

> Le registre de l'agence dans le téléphone : chaque bien, chaque mandat et chaque loyer suivis, les impayés relancés, et les logements libres publiés en un clic avec une disponibilité toujours exacte.

**Le budget de 2 000 000 FCFA ne paie pas le développement.** Il représente environ 3 050 €. Il ne couvre même pas deux à trois mois d'un développeur freelance local \[Hypothèse\]. Il n'est réaliste que si vous développez vous-même avec Claude Code, comme sur vos autres projets. Dans ce cas, il finance l'hébergement, les outils, le juridique et le pilote, et c'est suffisant pour 12 mois (section 7).

**Cinq décisions changent tout \[Reco\].**

1. **La gestion locative entre dans le MVP**, en version simple : baux, échéancier, reçus, impayés. Sans elle, vous êtes un Zakafy de plus.
2. **La marketplace commence en vitrine.** Une page publique par bien et par agence, partageable sur WhatsApp, avant un portail de recherche complet.
3. **Les paiements commencent en registre.** On enregistre le paiement et la référence Mobile Money, sans jamais détenir les fonds.
4. **Le « back-office sans code » devient un simple système d'interrupteurs** (feature flags) liés aux formules d'abonnement, pas un moteur de configuration générique.
5. **Pas de 360°, de 3D, de TikTok ni d'automatisation Facebook avant que 10 agences paient.**

**Le vrai risque n'est pas technique.** C'est la disposition à payer des agences et leur volonté de saisir leurs données. Il faut 8 à 10 entretiens d'agences et 3 à 5 agences pilotes avant d'écrire le module de paiement.

## 2. Hypothèses et inconnues

Votre premier concurrent n'est pas Zakafy : c'est le cahier, Excel et le démarcheur de quartier. Un responsable d'agence estime qu'il y a plus de 57 400 démarcheurs au Burkina \[Fait, déclaration publiée par Sidwaya\].

### Concurrence

| Acteur | Type | Ce qu'il fait | Ce qu'il ne fait pas |
| --- | --- | --- | --- |
| [Zakafy](https://zakafy.bf/) | Direct, marketplace BF | Annonces gratuites modérées, demandes inversées, 4 calculateurs, apps mobiles, 8 agences | Aucune gestion locative, aucun paiement, aucune vérification des documents |
| Groupes Facebook et WhatsApp, démarcheurs | Indirect, dominant | L'essentiel des locations à Ouagadougou | Aucune traçabilité, arnaques fréquentes |
| Cahier, Excel, carnet de reçus | Indirect, outil de gestion actuel | Gratuit, maîtrisé | Pas de relance, pas de vue propriétaire, erreurs |
| [Expat.com Burkina](https://www.expat.com/fr/immobilier/afrique/burkina-faso/a-vendre.html) | Indirect, annonces | Annonces BF visibles par la diaspora et les expatriés | Pas de gestion |
| [ImmoTopia](https://slashdot.org/software/p/ImmoTopia/) | SaaS régional (Côte d'Ivoire) | ERP cloud pour agences, promoteurs et gestionnaires, fondé en 2024 | Présence au Burkina non vérifiée |
| [mamaisonbf](https://burkina24.com/?p=137121) | Agence avec vitrine web | Location, vente, offre diaspora | Outil interne, pas une plateforme ouverte |

### Inconnues à lever

| Inconnue | Hypothèse de travail | Comment valider | Si l'hypothèse est fausse |
| --- | --- | --- | --- |
| Disposition à payer des agences | 10 000 à 25 000 FCFA par mois pour 50 à 150 lots gérés | 8 à 10 entretiens, puis une prévente à l'agence pilote | Modèle gratuit financé par les services ou la mise en avant |
| Nombre d'agences actives à Ouagadougou | Quelques centaines, dont 30 à 80 gèrent plus de 30 lots | Annuaires, Chambre de commerce, terrain | Cible élargie aux bailleurs particuliers à plusieurs logements |
| Charge de saisie initiale | Une agence n'importera pas 100 baux à la main | Import Excel et saisie assistée testés au pilote | Service d'import fait par vous, facturé |
| Texte exact de l'arrêté du 8 avril 2026 | Carte pro obligatoire, commission à la charge du bailleur, plafond de la moitié du loyer pour les meublés | Obtenir le texte au Journal officiel ou au ministère (la presse se contredit) | Règles de calcul des commissions à revoir |
| Plafond de caution | 2 mois selon la loi 103-2015/CNT, d'après la presse | Lire la loi et son décret de 2018 | Les modèles de bail changent |
| Formalités CIL | Déclaration préalable des traitements sous la loi 001-2021/AN | Contacter la CIL avant le pilote | Retard de lancement, amende de 5 à 100 M FCFA |
| Plafond Orange Money BF | 500 000 FCFA par transaction (source secondaire) | Confirmer auprès de l'agrégateur choisi | Loyers élevés payés en plusieurs fois ou par virement |
| Frais d'agrégateur | 1,5 à 2,5 % par transaction (source secondaire) | Grilles de CinetPay, Ligdicash, PayDunya | Commission sur transaction non rentable |
| Tarif WhatsApp pour un numéro burkinabè | Quelques centimes de dollar par message marketing | Grille officielle Meta, région Afrique | Alertes envoyées par SMS ou par lien |

Les hypothèses chiffrées sur les agences sont les miennes et non sourcées. Ce sont elles que les entretiens doivent confirmer en premier.

## 3. Recommandations prioritaires

Vendez la gestion, offrez la vitrine. L'agence paie pour ce qu'elle utilise chaque jour. La vitrine gratuite sert à attirer des prospects et à rendre l'outil indispensable.

### Dans l'ordre

1. **Valider avant de coder.** Faites 8 à 10 entretiens avec des agences et des gestionnaires de Ouagadougou. Obtenez 3 lettres d'intention d'agences pilotes avant la phase 1.
2. **Cibler un seul segment au lancement.** Les agences et gestionnaires de 20 à 200 lots à Ouagadougou et Saaba, en location résidentielle. Les bureaux et commerces suivent le même modèle d'unités et viennent sans coût supplémentaire.
3. **Traiter la vente en fiche simple.** Les biens et terrains à vendre ont une fiche, des documents et une annonce, mais pas de pipeline de négociation au MVP.
4. **Faire de l'import Excel une fonction prioritaire.** C'est la première barrière à l'adoption. Proposez aussi l'import fait par vous comme service payant.
5. **Construire hors ligne d'abord pour les gestes de terrain** : visite, état des lieux, encaissement en espèces. Vous maîtrisez déjà ce modèle de PWA.
6. **Respecter la réglementation de 2026 dès la conception** : carte professionnelle des démarcheurs rattachés à l'agence, commission calculée selon les règles en vigueur, caution plafonnée.

### Différenciateurs défendables face à Zakafy

| Différenciateur | Pourquoi Zakafy ne le copie pas vite | Phase |
| --- | --- | --- |
| Disponibilité toujours exacte : l'annonce suit le statut de l'unité | Il faudrait qu'il gère les baux, donc qu'il change de métier | MVP |
| Relevé mensuel au propriétaire sans compte, envoyé par lien WhatsApp | Même raison : il n'a pas les loyers | MVP |
| Reçus numérotés vérifiables par QR code (lutte contre les faux reçus) | Pas de flux de paiement chez lui | MVP |
| Annonces portant « géré sous mandat », avec le mandat enregistré | Ses annonces sont déclaratives | MVP |
| Démarcheurs rattachés à l'agence avec leur carte professionnelle | Son modèle vise les agences et les particuliers | Phase 3 |
| Paiement du loyer par Mobile Money avec rapprochement automatique | Il faut un agrégateur et un registre des loyers | Phase 3 |
| Demandes de locataires rapprochées des unités libres du portefeuille | Il a les demandes mais pas les portefeuilles | Phase 3 |

**Ce qui n'est pas un différenciateur** : les annonces gratuites, les calculateurs et les guides, que Zakafy a déjà. Les visites 360° sont imitables en quelques semaines.

**À éviter** : un fichier partagé de « mauvais locataires » entre agences. C'est tentant commercialement, mais très risqué au regard de la loi 001-2021/AN sans avis de la CIL.

## 4. Périmètre MVP

Le MVP est un registre de gestion locative multi-agences, avec une vitrine publique. Votre priorité 2 (baux, échéancier, reçus) remonte en priorité 1. Les intégrations automatiques descendent.

| Module | Classement | Contenu du MVP | Coupé ou reporté |
| --- | --- | --- | --- |
| Authentification et rôles | Indispensable | Téléphone et mot de passe, 4 rôles prédéfinis par agence, contrôle côté serveur | Rôles personnalisables, connexion Google ou Apple |
| Multi-agences et cloisonnement | Indispensable | Chaque donnée rattachée à une agence, isolement en base | Partage de données entre agences |
| Propriétaires, y compris sans compte | Indispensable | Fiche interne, coordonnées, biens rattachés | Invitation et espace propriétaire complet |
| Mandats | Indispensable | Type, dates, commission, 3 autorisations (publier, photographier, encaisser), pièce jointe | Workflow de signature, révocation en ligne |
| Biens et unités | Indispensable | Bien principal, unités, statut (libre, louée, réservée, indisponible) | Plans, lots de copropriété |
| Photos et documents | Indispensable | Compression à l'envoi, 15 photos par unité, documents privés | Vidéos, panoramas |
| Baux et échéancier | Indispensable | Bail, loyer, charges, caution, échéances générées, renouvellement et résiliation | Indexation automatique, modèles juridiques validés |
| Encaissements et reçus | Indispensable | Saisie espèces, virement ou Mobile Money avec référence, paiement partiel, reçu PDF avec QR | Paiement initié depuis la plateforme |
| Impayés et relances | Indispensable | Liste des retards, relance pré-remplie ouverte dans WhatsApp | Relances automatiques par l'API WhatsApp |
| Import Excel | Indispensable | Modèle Excel pour propriétaires, biens, unités, baux | Import depuis d'autres logiciels |
| Visibilité | Indispensable | 4 états : interne, publié, suspendu, archivé | États « en préparation » et « en attente », autorisation par canal |
| Vitrine publique | Important | Page agence, page bien partageable, liste filtrée (ville, quartier, budget, pièces), localisation au quartier | Carte précise, favoris, alertes |
| Prospects et demandes de visite | Important | Formulaire de contact transformé en prospect, statut, rapprochement manuel | Rapprochement automatique |
| Dépenses et relevé propriétaire | Important | Dépenses par bien, relevé mensuel PDF envoyé par lien | Reversements, comptabilité |
| Back-office central | Indispensable | Agences, validation, formule, interrupteurs de modules, journal d'audit | Moteur de configuration générique |
| Abonnements | Important | Facture manuelle et paiement hors plateforme | Facturation et relance automatiques |
| Paiement Mobile Money intégré | Différable (phase 3) | — | Via un agrégateur, après le pilote |
| Alertes WhatsApp officielles | Différable (phase 4) | — | Après validation des coûts par message |
| Espace locataire | Différable | Reçus consultables par lien | Compte locataire, paiement en ligne |
| Publication par les particuliers | Différable (phase 4) | — | Demande une modération humaine |
| Visite 360° | Différable (phase 4) | — | Service payant si des agences le demandent |
| Encaissement pour compte de tiers | Exclu | — | Seulement après avis juridique et partenaire agréé |
| Publication auto Facebook et TikTok | Exclu | Visuel et texte générés, à copier | TikTok limite les apps non auditées aux publications privées |
| 3D, application native, microservices, comptabilité complète | Exclu | Export CSV, PWA | — |

**Le compromis assumé** : au lancement, la vitrine sera moins riche que Zakafy. C'est voulu. Votre promesse est la fiabilité des biens, pas leur nombre.

## 5. Parcours, rôles et règles métier

Le parcours qui doit être parfait est l'encaissement mensuel. C'est lui que l'agence répète des centaines de fois, et c'est lui qui justifie l'abonnement.

### Parcours principaux

1. **Arrivée d'une agence.** Inscription, puis contrôle des pièces (RCCM, IFU, identité du gérant) par le back-office, puis import Excel. Objectif : le premier reçu émis le jour même.
2. **Mise en location d'une unité.** Créer le bien et l'unité, rattacher le mandat, passer l'annonce en « publié », partager le lien sur WhatsApp. Le prospect contacte, visite, puis signe. L'agence joint le bail scanné : l'unité passe « louée », l'annonce se retire seule et l'échéancier est généré.
3. **Encaissement mensuel.** L'échéance arrive. Le locataire paie en espèces ou par Mobile Money. L'agent saisit le montant et la référence. Le reçu avec QR code part par lien WhatsApp. S'il reste un solde, il apparaît dans les impayés, avec une relance pré-remplie à J+5.
4. **Relevé propriétaire.** En fin de mois : loyers reçus, moins la commission, moins les dépenses. Le relevé part par lien au propriétaire, même sans compte.
5. **Visiteur.** Il ouvre une page bien, puis contacte par WhatsApp, par appel ou par formulaire. Le contact devient un prospect dans l'agence.
6. **Départ d'un locataire.** Préavis, état des lieux de sortie, retenues sur la caution avec justificatif, solde. L'unité redevient libre et peut être republiée si le mandat l'autorise.

### Rôles et permissions

| Rôle | Périmètre | Peut | Ne peut pas |
| --- | --- | --- | --- |
| Super administrateur | Plateforme | Tout, y compris interrupteurs de modules et formules | Lire les données d'une agence sans que ce soit tracé |
| Support et modération | Plateforme | Valider les agences, suspendre une annonce, accès assisté tracé | Modifier un paiement |
| Directeur d'agence | Son agence | Tout dans l'agence, collaborateurs, exports, annulation d'un reçu | Voir une autre agence |
| Gestionnaire | Son agence | Biens, baux, encaissements, relances, publication | Annuler un reçu validé, exporter |
| Agent de terrain | Biens qui lui sont affectés | Prospects, visites, photos, saisie d'espèces « à valider » | Valider un encaissement, modifier un bail |
| Propriétaire (lien) | Ses biens | Lire ses relevés et reçus | Toute modification |

Toutes les permissions sont vérifiées côté serveur. Les rôles sont fixes au MVP, et des rôles personnalisés pourront venir ensuite.

### Règles métier

- **Enregistrer n'est jamais publier.** La publication exige un mandat actif autorisant la publication, au moins 3 photos et un loyer renseigné.
- **Un bail actif par unité.** Une unité louée ne peut pas être publiée. La colocation est hors MVP.
- **Un paiement n'est jamais supprimé.** Il est annulé par une contre-écriture motivée, faite par le directeur. Le reçu reste visible avec la mention « annulé ».
- **Un paiement Mobile Money déclaré reste « à rapprocher »** jusqu'à sa confirmation, conformément à votre règle de la section 11.
- **Les espèces saisies par un agent restent « à valider »** jusqu'à la validation du gestionnaire. C'est la principale protection contre la fraude interne.
- **Un paiement partiel s'impute sur l'échéance la plus ancienne.**
- **La caution est suivie à part.** Le plafond est paramétrable (2 mois par défaut, à confirmer au regard de la loi). Toute retenue exige un justificatif.

### Cas limites

- **Mandat expiré.** Le bien reste consultable, la publication est suspendue automatiquement, et une alerte part 30 jours avant l'échéance.
- **Même bien dans deux agences.** Le cloisonnement l'empêche de le voir. On l'accepte au MVP, puis on détecte les doublons sur la vitrine en phase 3. Le mandat exclusif est un champ informatif.
- **Vente du bien en cours de bail.** Le bail est transféré au nouveau propriétaire, et l'historique est conservé.
- **Loyer supérieur au plafond Mobile Money.** On autorise plusieurs paiements pour une même échéance.
- **Locataire sans smartphone.** Le reçu peut être imprimé.
- **Désactivation d'un module.** Les données passent en lecture seule, rien n'est supprimé.
- **Fin de contrat d'une agence.** Export complet, puis conservation 30 jours avant suppression.

### Fonctionnalités par formule

| Fonction | Découverte | Essentiel | Pro |
| --- | --- | --- | --- |
| Unités gérées | 10 | 60 | 250 |
| Utilisateurs | 1 | 3 | 10 |
| Baux, échéancier, reçus | Oui | Oui | Oui |
| Relances WhatsApp pré-remplies | Oui | Oui | Oui |
| Relevés propriétaires | 2 par mois | Illimités | Illimités |
| Vitrine et page agence | Oui, avec mention de la plateforme | Oui | Oui, avec logo |
| Agents de terrain et validation des espèces | Non | Oui | Oui |
| Import Excel | Oui | Oui | Oui, fait par nous |
| Exports | Non | CSV | CSV et comptable |
| Mobile Money intégré (phase 3) | Non | Option | Oui |
| Mise en avant sur la vitrine | Non | Non | Oui |

## 6. Architecture et données

L'architecture est pensée d'abord pour l'expérience : l'application de l'agence travaille sur les données stockées dans le téléphone et se synchronise en arrière-plan. La vitrine est servie depuis un CDN présent à Ouagadougou. Derrière, un monolithe modulaire TypeScript et PostgreSQL, qui passent à plusieurs instances quand la charge l'exige. Les microservices restent écartés : pour une équipe d'une personne, ils ajoutent des coûts sans améliorer la fluidité.

### Ce qui rend l'interface fluide

La fluidité ne vient pas de la base de données. Elle vient de trois choix côté utilisateur \[Reco\].

1. **Local d'abord pour l'application des agences.** Les données de l'agence sont copiées dans une base SQLite du téléphone, grâce à un moteur de synchronisation (PowerSync). Chaque écran se lit en local : il s'ouvre sans attente réseau, même hors connexion. Chaque saisie est enregistrée tout de suite, puis envoyée au serveur dès que le réseau revient. PowerSync existe en édition libre auto-hébergée et s'appuie sur PostgreSQL \[Fait\].
2. **Une vitrine servie au plus près.** Cloudflare dispose d'un point de présence à Ouagadougou (OUA) \[Fait\]. Les pages de biens et les photos y sont mises en cache. Un visiteur de Ouaga les reçoit sans aller-retour vers l'Europe.
3. **Un client léger pour les Android d'entrée de gamme.** SvelteKit envoie moins de JavaScript que Next.js pour un même écran, d'après plusieurs comparatifs publiés, et se charge plus vite en 3G. Un seul code sert la vitrine (pages rendues côté serveur) et l'application (PWA).

### Pile recommandée

| Option | Pile | Atouts | Limites | Verdict |
| --- | --- | --- | --- | --- |
| A. TypeScript de bout en bout | SvelteKit et composants shadcn-svelte, API Node.js en NestJS, PostgreSQL, PowerSync, Cloudflare | Un seul langage, schémas de validation partagés, client léger, hors ligne fourni par un outil éprouvé | Les conflits de synchronisation sont à régler côté serveur ; l'écosystème Svelte est plus petit que celui de React | Recommandée |
| A bis. Même pile en React | React Router 7 et shadcn/ui à la place de SvelteKit | Votre expérience React, écosystème très large | Un peu plus de JavaScript à charger | À retenir si vous préférez React |
| B. Laravel avec Inertia et React | Laravel, Filament pour le back-office, PostgreSQL | Très productif pour l'administration | Hors ligne à construire soi-même, deux langages | Second choix |
| C. FastAPI et React (version initiale) | FastAPI, React, PostgreSQL | Pile maîtrisée | Hors ligne, rendu serveur et cache à assembler à la main | Écartée |

**PostgreSQL reste le bon choix.** Il garantit l'intégrité des loyers et des reçus (transactions, contraintes), cloisonne les agences au niveau des lignes et fournit la réplication logique dont PowerSync a besoin. Ce n'est pas lui qui rendrait l'interface lente.

### Principes d'interface

- **Des gestes familiers.** Une barre de 4 onglets en bas (Accueil, Biens, Encaissements, Plus), comme dans les applications Mobile Money et WhatsApp. Des boutons larges, des pictogrammes toujours accompagnés d'un mot.
- **Encaisser en 3 gestes.** Chercher le locataire, vérifier le montant pré-rempli, valider. Le reçu part ensuite par le partage natif du téléphone (WhatsApp, SMS).
- **Formats locaux partout.** Montants en « 75 000 FCFA », clavier numérique pour les montants, numéros en +226, dates au format jour/mois.
- **Aucune attente visible.** L'action s'affiche tout de suite, avec un petit indicateur « en attente d'envoi » tant que la synchronisation n'a pas eu lieu. Des squelettes d'écran remplacent les icônes de chargement.
- **Notifications de la PWA** pour les échéances du jour et les impayés.
- **Tests avec les pilotes** : 5 tâches chronométrées par agence (encaisser, relancer, publier, envoyer un relevé, importer). On corrige tout ce qui prend plus de 30 secondes.

| Indicateur de performance | Cible |
| --- | --- |
| Ouverture d'un écran de l'application | Moins de 100 ms (lecture locale) |
| Délai de synchronisation une fois en ligne | Moins de 5 secondes |
| Affichage d'une page de bien en 3G | Moins de 2,5 secondes |
| JavaScript d'une page de vitrine | Moins de 100 Ko compressés |
| Temps de réponse du serveur (95 % des requêtes) | Moins de 300 ms |

### Autres choix techniques

- **Tâches de fond** (échéances, PDF, compression d'images, relances) dans une file dédiée, jamais pendant la requête de l'utilisateur.
- **Photos** redimensionnées en WebP à l'envoi, servies depuis le stockage objet via le CDN.
- **Cartographie** : OpenStreetMap avec Leaflet, localisation au centre du quartier par défaut.
- **Adaptateurs isolés** pour le paiement et les notifications. La première implémentation est manuelle (saisie de référence, lien WhatsApp), et on branche ensuite l'agrégateur ou l'API WhatsApp sans toucher au métier.
- **Application en boutique** si besoin : la même PWA peut être empaquetée avec Capacitor pour le Play Store, sans réécriture.

### Montée en charge

Le risque de ralentissement vient surtout de la vitrine. Une annonce partagée dans de grands groupes WhatsApp peut attirer des milliers de visites en quelques minutes. Les agences, elles, produisent peu d'écritures, et leurs lectures se font sur le téléphone.

- **Le CDN absorbe les pics** : pages de biens et photos servies depuis le cache, rafraîchies à chaque modification de l'annonce. Cloudflare filtre aussi les attaques et limite les abus.
- **Des serveurs d'application sans état**, conditionnés en conteneurs. On passe d'une instance à plusieurs derrière un répartiteur, sans changer le code.
- **Une base protégée** : regroupement des connexions (PgBouncer), index sur les recherches de la vitrine, pagination par curseur. Une réplique en lecture seule viendra quand le besoin sera mesuré.
- **Un cache Redis** pour les listes de la vitrine et les compteurs, avec une limitation du nombre de requêtes par client.
- **Une supervision dès le pilote** : suivi des erreurs (Sentry), temps de réponse, alertes de disponibilité.
- **Des tests de charge avant chaque palier** (k6) : un pic de 10 fois le trafic normal sur la vitrine, et 50 utilisateurs d'agence qui se synchronisent en même temps.

| Palier | Volume indicatif | Infrastructure | Coût mensuel estimé (FCFA) |
| --- | --- | --- | --- |
| 1. Pilote et lancement | Jusqu'à 15 agences | Un serveur (4 vCPU, 8 Go), Cloudflare gratuit, stockage objet | 30 000 à 60 000 |
| 2. Croissance | Jusqu'à 100 agences | Deux serveurs d'application, PostgreSQL géré, Redis | 100 000 à 200 000 |
| 3. Échelle nationale | Plus de 100 agences, vitrine très fréquentée | Réplique en lecture, synchronisation sur serveur dédié | 250 000 à 500 000 |

Les coûts des paliers 2 et 3 sont des hypothèses. Ils sont couverts par les abonnements de la phase 3, pas par le budget initial.

### Isolation, sécurité et exploitation

- **Cloisonnement** : un identifiant d'agence sur chaque table métier, contrôlé dans le code et par la sécurité au niveau des lignes de PostgreSQL. Des tests automatiques tentent un accès d'une agence vers une autre à chaque déploiement.
- **Interrupteurs de modules** : l'administrateur peut couper chaque fonctionnalité pour tout le monde, l'ouvrir à tout le monde ou l'ouvrir seulement à une liste, et poser des exceptions pour une agence ou une personne précise (paiement direct, annonces, etc.). La résolution suit un ordre fixe : arrêt d'urgence, exception personne, exception agence, mode restreint, formule, réglage de l'agence. La permission du rôle est vérifiée en plus. Spécification détaillée dans le dossier Claude Code (FEATURE-FLAGS.md).
- **Journal d'audit** en ajout seul : qui, quand, quoi, ancienne et nouvelle valeur. Il couvre les paiements, les baux, les mandats, les publications et la configuration.
- **Sauvegardes** : copie chiffrée quotidienne de la base vers un autre fournisseur, conservée 30 jours. Une restauration est testée chaque mois.
- **Secrets** : variables d'environnement chiffrées, jamais dans le code. Les clés d'agrégateur sont chiffrées en base.
- **Montants** en entiers FCFA, jamais en nombres à virgule.
- **Trois environnements** : développement, test, production. Les tests automatiques couvrent l'encaissement, l'imputation et le cloisonnement.

### Modèle de données conceptuel

| Entité | Champs clés | Relations et règles d'intégrité |
| --- | --- | --- |
| Agence | Raison sociale, RCCM, IFU, statut de vérification, formule | Racine du cloisonnement |
| Utilisateur et appartenance | Téléphone, rôle par agence | Un utilisateur peut appartenir à plusieurs agences |
| Propriétaire | Nom, téléphone, compte lié (facultatif) | Appartient à une agence ; un compte n'est jamais obligatoire |
| Mandat | Type, début, fin, commission, autorisations, pièce | Lie un propriétaire, une agence et des biens ou unités ; versionné |
| Bien | Type, commune, quartier, adresse, documents déclarés | Appartient à un propriétaire ; contient des unités |
| Unité | Type, pièces, surface, loyer affiché, statut | Un seul bail actif à la fois (index unique partiel) |
| Média et document | Fichier, type, visibilité publique ou privée | Rattaché à un bien, une unité, un bail ou un mandat |
| Annonce | Cible (bien ou unité), état de visibilité, prix, texte | Publiée seulement si le mandat est actif et l'autorise |
| Prospect et visite | Contact, source, statut, date | Rattaché à une annonce ou à une demande |
| Locataire | Nom, téléphone, pièce d'identité | Appartient à une agence |
| Bail | Unité, locataire, dates, loyer, charges, caution, statut | Génère les échéances |
| Échéance | Période, montant dû, solde | Appartient à un bail |
| Paiement | Montant, moyen, référence, statut, clé d'idempotence | Imputé sur une ou plusieurs échéances ; la somme des imputations ne dépasse pas le montant |
| Reçu | Numéro, QR, statut (valide ou annulé) | Numérotation continue par agence, sans trou |
| Mouvement de caution | Encaissement, retenue, restitution, justificatif | Appartient à un bail |
| Dépense | Bien, montant, nature, pièce | Déduite du relevé propriétaire |
| Relevé propriétaire | Période, totaux, lien d'accès | Figé une fois émis |
| Formule et interrupteur | Module, quotas, niveau | Plateforme, formule, agence |
| Journal d'audit | Acteur, action, objet, avant, après, date | Ajout seul, jamais modifié |
| Référentiel géographique | Commune, quartier, centre | Partagé entre agences |

### Intégrations réellement faisables

| Intégration | État vérifié | Condition | Phase |
| --- | --- | --- | --- |
| Liens WhatsApp (wa.me) | Fonctionne sans API ni coût | Aucune | MVP |
| Agrégateurs Mobile Money | [CinetPay](https://docs.cinetpay.com/api/1.0-en/checkout/tableau) liste Orange Money BF et Moov Money BF ; [Moneroo](https://docs.moneroo.io/fr/payments/methodes-disponibles) aussi ; Ligdicash, PayDunya et BarkaPay sont cités pour le Burkina | Compte marchand avec KYC, donc société constituée | Phase 3 |
| API WhatsApp Business | Facturation par message depuis le 1er juillet 2025 ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)) ; les messages de service deviendraient payants au 1er octobre 2026 (sources secondaires) | Vérification Meta Business, modèles approuvés, consentement | Phase 4 |
| SMS (code de vérification) | Prestataire local à choisir, coût non vérifié | Contrat avec un agrégateur SMS | Phase 1, limité à la récupération de compte |
| Publication de pages Facebook | Possible via l'API Graph \[Hypothèse\] | Revue de l'application par Meta | Phase 4 |
| TikTok | Les applications non auditées ne publient qu'en mode privé ([TikTok, via Postiz](https://docs.postiz.com/providers/tiktok.md)) | Audit TikTok | Hors feuille de route |

Le schéma ci-dessous montre comment les modules s'articulent. Seul le registre métier écrit les données ; la vitrine ne fait que lire les annonces publiées.

&#91;embedded content: Architecture cible · un monolithe, quatre modules, quatre dépendances\]

Les deux adaptateurs de droite commencent en mode manuel. On les remplace par l'agrégateur et l'API WhatsApp sans modifier le registre.

## 7. Budget, coûts et offres

Avec un développement fait par vous, 2 000 000 FCFA couvrent 12 mois d'exploitation, le juridique et le pilote. Avec un prestataire, il faudrait plutôt 8 à 20 millions FCFA pour ce MVP \[Hypothèse à confirmer par 2 devis\], et le budget actuel ne suffit pas. Tous les montants sont des estimations, pas des devis.

### Répartition des 2 000 000 FCFA sur 12 mois (développement par vous)

| Poste | Estimation (FCFA) | Contenu |
| --- | --- | --- |
| Juridique et conformité | 500 000 | Modèles de bail, de mandat et CGU relus par un juriste, déclaration CIL, conseil sur les paiements |
| Hébergement et services | 400 000 | Serveurs d'application et de test, synchronisation PowerSync, CDN (offre gratuite), stockage objet, sauvegardes, noms de domaine, crédit SMS |
| Outils de développement | 300 000 | Abonnement d'assistant de code, outils de suivi d'erreurs |
| Pilote et terrain | 300 000 | Déplacements, démonstrations, aide à l'import des données des pilotes |
| Lancement commercial | 300 000 | Supports, visuels, publicité Facebook ciblée, événement agences |
| Réserve | 200 000 | Imprévus, frais d'agrégateur, taxes |

Si la société n'existe pas encore, sa création s'ajoute. Elle est nécessaire pour ouvrir un compte marchand Mobile Money.

### Coûts récurrents après lancement

| Poste | Estimation mensuelle (FCFA) | Évolution |
| --- | --- | --- |
| Hébergement, stockage, sauvegardes | 30 000 à 60 000 | Augmente avec les photos ; quotas par formule |
| SMS de vérification | 5 000 à 15 000 | Limité à la récupération de compte |
| Messages WhatsApp (phase 4) | Variable | Facturés par message ; à répercuter dans les formules |
| Frais d'agrégateur | 1,5 à 2,5 % des montants (source secondaire) | Sur les abonnements encaissés, puis sur les loyers |
| Support | Votre temps | Le plus gros coût caché |

### Offres tarifaires proposées \[Hypothèse à tester en entretien\]

| Formule | Prix mensuel (FCFA) | Prix annuel (FCFA) | Cible |
| --- | --- | --- | --- |
| Découverte | 0 | 0 | Bailleur ou petite agence, 10 unités |
| Essentiel | 15 000 | 150 000 | Agence jusqu'à 60 unités |
| Pro | 35 000 | 350 000 | Agence jusqu'à 250 unités |
| Sur mesure | Sur devis | Sur devis | Plus de 250 unités, promoteurs |

Services en plus : import des données fait par vous, environ 25 000 FCFA par tranche de 100 unités ; plus tard, mise en avant d'annonces et visites 360°.

**Test de cohérence.** Prenons une agence de 60 unités à un loyer moyen de 75 000 FCFA et une commission de gestion de 10 % \[Hypothèses\]. Elle perçoit environ 450 000 FCFA de commission par mois. L'offre Essentiel en représente 3,3 %, ce qui reste défendable si l'outil réduit les impayés.

**Seuil de rentabilité technique** : environ 3 abonnements Essentiel couvrent l'hébergement. Pour rémunérer votre temps, visez 30 à 50 agences payantes.

### Acquisition des premières agences

1. **Dresser une liste de 40 agences à Ouagadougou** à partir de l'annuaire Zakafy, d'Expat.com, des pages Facebook et des panneaux de rue.
2. **Faire 10 entretiens** et choisir 3 pilotes. Le pilote est gratuit pendant 3 mois, en échange d'un engagement à payer ensuite et d'un témoignage.
3. **Faire vous-même l'import** des données des pilotes.
4. **Proposer une offre fondateurs** : -50 % pendant 24 mois pour les 10 premières agences payantes.
5. **Mettre en place le parrainage** : un mois offert par agence parrainée.
6. **Publier des contenus utiles** sur WhatsApp et Facebook : l'arrêté de 2026 sur les démarcheurs, la caution, les modèles de reçus. Ils amènent des agences qualifiées.

### Coûts cachés et risques de marge

- Le support par WhatsApp aux heures de bureau, qui grossit avec chaque agence.
- La saisie initiale, si elle n'est pas facturée.
- La facturation par message de WhatsApp, étendue à de nouvelles catégories en 2026.
- La TVA et les taxes sur les abonnements, à vérifier avec un comptable.
- Les outils payés en dollars ou en euros.
- La croissance du stockage photo si aucun quota n'est appliqué.

## 8. Feuille de route

Cinq phases sur environ 12 mois, séparées par trois portes de décision. Les durées supposent un développement à temps partiel par vous, avec un début en décembre 2026.

&#91;embedded content: Feuille de route · 5 phases, 3 portes de décision, bandes non proportionnelles\]

La porte 1, à la fin du pilote, est la vraie décision d'investir : rien de la phase 3 ne se construit avant.

| Phase | Objectif | Livrables | Dépendances | Critères d'acceptation | Durée | Coût estimé (FCFA) |
| --- | --- | --- | --- | --- | --- | --- |
| 0. Valider | Prouver le besoin et le prix | 10 comptes rendus d'entretien, maquettes cliquables, 3 lettres d'intention, texte de l'arrêté obtenu | Votre disponibilité terrain | 3 pilotes engagés ; au moins 5 agences sur 10 prêtes à payer 10 000 FCFA ou plus | 4 semaines | 150 000 |
| 1. Construire | Registre utilisable au quotidien | Modules indispensables de la section 4, vitrine de base, back-office minimal | Modèles de bail et de mandat relus, serveur | Premier reçu émis le jour de l'import ; aucun accès inter-agences aux tests ; restauration testée | 10 à 12 semaines | 700 000 |
| 2. Piloter | Prouver l'usage réel | 3 à 5 agences actives, relevés propriétaires, agents de terrain hors ligne, corrections hebdomadaires | Import des données des pilotes | 70 % des loyers des pilotes saisis dans l'outil ; usage au moins 4 jours sur 7 ; 2 pilotes convertis en payants | 12 semaines | 350 000 |
| 3. Lancer | Premiers revenus récurrents | Offre fondateurs, paiement Mobile Money via agrégateur vers le compte de l'agence, vitrine enrichie, demandes rapprochées | Société et compte marchand | 15 agences payantes ; moins de 10 % de départs à 3 mois | 3 à 4 mois | 600 000 |
| 4. Étendre | Croissance | API WhatsApp, publication par les particuliers, Bobo-Dioulasso, 360° en service | Revenus de la phase 3 | Financé par les abonnements | 6 mois et plus | Hors budget initial |

Le reste du budget (200 000 FCFA) est la réserve de la section 7.

### Stratégie de pilote

- **Profils variés** : une agence de 30 à 50 lots, une de 100 lots ou plus, et un gestionnaire indépendant qui travaille pour des propriétaires de la diaspora.
- **Rituel hebdomadaire** : 30 minutes par pilote pour recueillir les blocages, et une mise à jour par semaine.
- **Mesures automatiques** depuis le jour 1 : unités importées, part des loyers saisis, reçus émis, jours d'usage, relevés envoyés.

### Continuer, corriger ou arrêter

| Signal à la porte 1 (fin du pilote) | Décision |
| --- | --- |
| Au moins 70 % des loyers saisis et 2 pilotes payants | Continuer vers le lancement |
| Usage réel, mais refus de payer | Corriger le modèle : gratuit avec services payants, ou facturation à l'unité |
| Saisie abandonnée après l'import | Corriger le produit : simplifier l'encaissement, renforcer le hors ligne |
| Moins de 2 pilotes actifs après 8 semaines | Arrêter ou pivoter vers un outil pour bailleurs particuliers |

## 9. Risques et mesures de maîtrise

Les deux risques les plus probables sont commerciaux : les agences n'adoptent pas l'outil, ou l'utilisent sans payer. Les risques techniques sont réels mais mieux maîtrisés.

| Risque | Probabilité | Impact | Mesure de maîtrise |
| --- | --- | --- | --- |
| Les agences n'adoptent pas l'outil après l'import | Élevée | Fort | Encaissement en 3 gestes, import fait par vous, rituel hebdomadaire du pilote |
| Usage sans paiement | Élevée | Fort | Prévente dès la phase 0, quotas sur la formule gratuite, porte 1 |
| Périmètre qui gonfle | Élevée | Fort | Liste « exclu » de la section 4 opposable, aucune nouvelle fonction avant la porte 1 |
| Porteur seul, en parallèle d'un emploi | Élevée | Moyen | Code documenté, déploiement scripté, sauvegardes externes ; vérifier les clauses de votre contrat de travail sur les activités annexes |
| Fraude interne en agence (espèces non déclarées) | Moyenne | Moyen | Statut « à valider », reçus numérotés sans trou, QR vérifiable par le locataire |
| Fuite de données entre agences | Faible | Très fort | Sécurité au niveau des lignes, tests automatiques à chaque déploiement |
| Non-conformité à la loi 001-2021/AN | Moyenne | Fort | Déclaration à la CIL avant le pilote, minimisation des données, pas de fichier partagé de locataires |
| Encaissement pour compte de tiers sans cadre | Faible si exclu | Très fort | Exclu du périmètre ; fonds versés directement sur le compte de l'agence |
| Zakafy ajoute un module de gestion | Moyenne | Moyen | Avance sur les relevés propriétaires, le hors ligne et la conformité de 2026 ; relation directe avec les agences |
| Réglementation mal interprétée (arrêté de 2026, caution) | Moyenne | Moyen | Texte officiel obtenu en phase 0, règles paramétrables |
| Hausse des coûts WhatsApp ou des agrégateurs | Moyenne | Faible | Adaptateurs isolés, liens wa.me gratuits par défaut, coûts répercutés dans les formules |
| Perte de données | Faible | Très fort | Sauvegarde chiffrée quotidienne chez un autre fournisseur, restauration testée chaque mois |
| Connexion instable et coupures | Élevée | Moyen | PWA hors ligne pour les gestes de terrain, pages légères, images compressées |
| Coût des médias | Moyenne | Faible | 15 photos par unité, compression à l'envoi, pas de vidéo au MVP |

## 10. Décisions à prendre

Les décisions 1 à 3 ont été prises le 7 novembre 2026 : vous développez vous-même, la gestion locative est dans le MVP, et la plateforme est un registre des paiements avec des intégrations d'API de paiement direct prévues dès la conception. Le framework retenu est SvelteKit. Les autres décisions restent à prendre. Les numéros entre parenthèses renvoient aux questions de votre section 20.

| Ordre | Décision | Recommandation | Quand |
| --- | --- | --- | --- |
| 1 | Qui développe, et ce que couvre le budget (Q18) | Vous, avec Claude Code ; le budget finance l'exploitation, le juridique et le lancement | Avant la phase 0 |
| 2 | Gestion locative dans le MVP (Q5) | Oui, en version simple : baux, échéancier, reçus, impayés | Phase 0 |
| 3 | Rôle de la plateforme dans les paiements (Q9) | Registre au MVP, puis paiement vers le compte de l'agence en phase 3, jamais d'encaissement pour compte de tiers sans avis juridique | Phase 0 |
| 4 | Zone de lancement (Q1) | Ouagadougou et Saaba ; Bobo-Dioulasso en phase 4 | Phase 0 |
| 5 | Catégories au lancement (Q2) | Location résidentielle complète, bureaux et commerces sur le même modèle ; vente et terrains en fiche simple | Phase 0 |
| 6 | Niveau de vérification (Q4) | Agences : RCCM, IFU, identité du gérant. Propriétaires : déclaratif, mandat joint. Annonces : badge « géré sous mandat », jamais « vérifié » | Phase 1 |
| 7 | Formules et prix (Q12, Q13) | Vitrine incluse, formules de la section 7 à tester en entretien | Phase 0 |
| 8 | Documents générés (Q8) | Reçu, appel de loyer, relevé propriétaire ; bail et mandat à partir de modèles relus par un juriste, signalés « modèle à adapter » | Phase 1 |
| 9 | Données publiques et privées (Q16) | Public : type, quartier, prix, photos, agence. Privé : adresse exacte, propriétaire, locataire, documents, paiements | Phase 1 |
| 10 | Espace propriétaire (Q7) | Lien de lecture seule au MVP, compte en phase 3 | Phase 1 |
| 11 | Espace locataire (Q6) | Non ; reçus consultables par lien | Phase 1 |
| 12 | WhatsApp (Q11) | Manuel assisté (liens wa.me) ; API officielle après la porte 2 | Phase 1 |
| 13 | Modération (Q15) | Agences vérifiées : publication directe, signalement et contrôle a posteriori | Phase 1 |
| 14 | Biens confiés à plusieurs agences (Q14) | Un bien par agence ; exclusivité en champ informatif ; doublons détectés en phase 3 | Phase 1 |
| 15 | Prestataire Mobile Money (Q10) | Consulter CinetPay, Ligdicash et PayDunya sur les frais, le KYC, les plafonds et les notifications ; choisir pendant le pilote | Phase 2 |
| 16 | Publication par les particuliers (Q3) | Non avant la phase 4, et alors avec modération humaine | Porte 2 |
| 17 | Dimensionnement (Q17) | Année 1 : 10 à 15 agences, environ 1 500 unités et 20 000 photos compressées (quelques Go), aucune visite 360° | Phase 1 |

## Sources

- [Zakafy — accueil, fonctionnement, agences, CGU](https://zakafy.bf/) (consulté le 6 novembre 2026)
- [Sidwaya — formalisation des démarcheurs, arrêté du 8 avril 2026](https://www.sidwaya.info/formalisation-des-activites-de-demarcheurs-la-decision-gouvernementale-saluee-a-dedougou/)
- [Le360 Afrique — réforme de l'intermédiation immobilière](https://afrique.le360.ma/societe/burkina-faso-intermediation-immobiliere-on-ne-peut-que-sen-rejouir-une-reforme-qui-soulage-les_AZCXRFBGDBCQDFA2WFG5U6B72E/)
- [Burkina24 — loi 103-2015/CNT sur le bail d'habitation privée](https://burkina24.com/?p=194217)
- [L'Économiste du Faso — caution de deux mois](https://leconomistedufaso.com/?p=16582)
- [Loi 001-2021/AN sur les données personnelles](https://assembleenationale.bf/storage/Loi/kDsWHXOTUCQFVESChh8BlBdiZnCrdTsOpXe1rzmH.pdf) et [amendes de la CIL](https://burkina24.com/?p=258385)
- [CinetPay — moyens de paiement par pays](https://docs.cinetpay.com/api/1.0-en/checkout/tableau)
- [Moneroo — méthodes disponibles](https://docs.moneroo.io/fr/payments/methodes-disponibles)
- [Kolonell — paiement mobile au Burkina, frais et plafonds](https://kolonell.com/fr/blog/accepter-paiement-mobile-burkina-faso-orange-moov-2026) (source secondaire)
- [Meta — tarification de la plateforme WhatsApp Business](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [Yournotify — changement de tarifs WhatsApp au 1er octobre 2026](https://yournotify.com/blog/whatsapp-pricing-update-2026/) (source secondaire)
- [Postiz — restrictions de l'API TikTok pour les applications non auditées](https://docs.postiz.com/providers/tiktok.md)
- [ImmoTopia — ERP immobilier Côte d'Ivoire](https://slashdot.org/software/p/ImmoTopia/)

* [PowerSync — édition libre auto-hébergée](https://powersync.com/blog/powersync-open-edition-release)
* [Cloudflare — statut du point de présence de Ouagadougou (OUA)](https://www.cloudflarestatus.com/?hn=2020)
* [Strapi — comparatif Next.js et SvelteKit](https://strapi.io/blog/nextjs-vs-sveltekit-which-one-is-better-for-your-next-strapi-app) (source secondaire)
