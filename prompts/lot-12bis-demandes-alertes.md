# Lot 12 bis — Demandes de recherche et alertes

## Contexte
Beaucoup de personnes cherchent un logement précis (un quartier, un type, un budget) et ne trouvent rien le jour où elles regardent. Ce lot leur permet de laisser leur demande **sans créer de compte** et d'être prévenues quand une annonce correspond ou s'en approche, jusqu'à ce qu'elles disent « Je ne suis plus intéressé » (D31). Il permet aussi à une organisation d'enregistrer la recherche d'un client venu au bureau et de voir quels logements de son portefeuille lui conviennent.

Deux règles priment sur tout le reste :
- **Les demandes de la vitrine appartiennent à la plateforme.** Aucune organisation n'en voit la liste, ni par un écran, ni par un export, ni par la synchronisation. Une organisation reçoit les coordonnées d'un visiteur seulement quand il clique « Ça m'intéresse » sur une de ses annonces (`CLAUDE.md` règle 15, D17, D31).
- **On n'écrit qu'à quelqu'un qui l'a demandé, et on s'arrête dès qu'il le demande.** Le numéro est confirmé par un code SMS ; chaque message porte le lien d'arrêt ; un clic suffit, sans connexion ni code.

## Prérequis
Lot 12 terminé (annonces, vitrine, prospects). Ce lot réutilise :
- l'envoi et la vérification des codes SMS du lot 02, par le service public du module `identity` (nouveau motif `search_request`, mêmes limites de tentatives et de renvoi) ;
- l'adaptateur SMS du module `notifications` (implémentations `console`, `file` et `memory` pour le développement et les tests) ;
- le référentiel des communes et quartiers et les types d'unité du lot 07 ;
- la table `leads` et la protection du formulaire de contact du lot 12 ;
- la résolution des interrupteurs du lot 04.

## Périmètre

### 1. Critères et rapprochement (règles pures, `packages/shared/search-match.ts`)
- Schéma Zod `searchCriteria`, partagé par la vitrine, l'application et l'API :
  - opération (location, achat) ;
  - communes et quartiers (au moins un, dix au plus ; choisir une commune vaut tous ses quartiers) ;
  - types d'unité (facultatif, plusieurs) ;
  - chambres minimum (facultatif) ;
  - budget maximum en FCFA entier (obligatoire) ;
  - meublé (oui, non, indifférent) ;
  - date d'entrée souhaitée (facultatif).
- `matchListing(criteria, candidate, settings)` renvoie `null` ou `{ kind: 'exact' | 'similar', relaxed?: 'neighborhood' | 'budget' | 'bedrooms', detail }`.
  - **Exacte** : même opération, quartier retenu, type retenu (si renseigné), chambres au moins égales au minimum, prix au plus égal au budget, meublé compatible, logement libre à la date souhaitée ou avant (une unité en préavis compte à sa date de libération).
  - **Similaire** : **un seul critère assoupli** parmi : autre quartier de la même commune ; budget dépassé de `budgetTolerancePct` au plus (15 % par défaut) ; chambres à `bedroomsTolerance` près (1 par défaut, jamais moins d'une chambre). L'opération, le type et le meublé ne sont jamais assouplis. Deux critères hors limites : aucun rapprochement.
  - `detail` est la phrase affichée au visiteur, par exemple « 10 000 FCFA au-dessus de votre budget » ou « À Tampouy, dans la même commune ».
- Les réglages (tolérances, plafonds, heures de silence, délais, durées de conservation, prix estimé d'un SMS) vivent dans une table de configuration de la plateforme, modifiable par l'administrateur général dans le back-office ; chaque changement est journalisé avec avant et après.

### 2. Demandes de la vitrine
**Tables de plateforme, sans `organization_id`** (comme `users`), dans le module `listings` :
- `search_requests` :
  - critères (JSON validé par le schéma, plus des colonnes indexées pour le préfiltre : opération, commune, budget, chambres) ;
  - nom (facultatif) et téléphone E.164 ;
  - statut (`pending_verification`, `active`, `paused`, `stopped`) ;
  - date de confirmation du numéro, version du texte de consentement accepté ;
  - date de la dernière confirmation « toujours en recherche » ;
  - `user_id` facultatif (rattachement à un compte) ;
  - dates de création et de modification.
- `search_request_tokens` : jeton du lien personnel, **stocké haché** (le jeton en clair n'est jamais enregistré), date de création, date de révocation.
- `search_alert_matches` : couple (demande, annonce) unique, type (exacte, similaire), critère assoupli, prix au moment du rapprochement, état (`pending`, `sent`, `interested`, `dismissed`, `withdrawn`), date d'envoi. Un même logement n'est jamais signalé deux fois à la même demande, sauf après une baisse de prix (une seule fois de plus).
- `search_alert_messages` : chaque message envoyé (demande, canal, annonces incluses, clé d'idempotence, coût estimé, résultat de l'adaptateur).

**Protection.** Ces tables ne sont **jamais publiées vers PowerSync** et `app_sync` n'a aucun droit dessus. Aucun endpoint d'une organisation ne les lit. Le rôle `app_api` n'y accède que par le service de ce sous-domaine. Le back-office (`app_admin`) les consulte seulement par une fonction dédiée, avec motif, pour l'assistance. **Propose dans le plan** comment RLS et les droits protègent ces tables sans `organization_id`, en partant de ce qui a été fait pour `users` au lot 02.

**Parcours sans compte**
1. Bouton « Je cherche un logement » sur l'accueil et sur la liste de résultats. Quand une recherche ne donne rien : « Aucun logement ne correspond pour l'instant. Soyez prévenu dès qu'il y en a un », avec les filtres en cours déjà remplis.
2. Formulaire court : critères, nom facultatif, numéro, case de consentement **non cochée par défaut** avec un texte clair (qui écrit, pourquoi, à quelle fréquence au plus, comment arrêter) et le lien vers la politique de confidentialité.
3. Code SMS. Sans code, rien n'est envoyé, et la demande en attente est effacée au bout de 24 heures.
4. Page de confirmation : résumé de la demande, **annonces déjà en ligne qui correspondent** (affichées tout de suite, jamais envoyées par SMS), lien personnel à garder, proposition d'activer les notifications du navigateur.

**Lien personnel** `/demande/<jeton>` :
- voir et modifier la demande ;
- voir les annonces signalées, avec « Ça m'intéresse » et « Pas pour moi » sur chacune ;
- mettre en pause ou relancer ;
- « Je ne suis plus intéressé » ;
- « Arrêter tous mes messages » (toutes les demandes du numéro).

« Retrouver mes demandes » : numéro et code SMS, puis un nouveau lien ; l'ancien est révoqué.

**Limites.** Trois demandes actives par numéro. Limitation de débit par adresse IP et par numéro. Champ piège. Aucun service tiers.

**Rattachement à un compte.** Une personne qui a ou crée un compte avec ce numéro vérifié retrouve ses demandes dans « Mon compte ». Rien n'est rattaché sans numéro vérifié.

### 3. Rapprochement et envois (BullMQ)
- **Déclencheurs** émis par le module `listings` : annonce publiée, remise en ligne, prix baissé. La tâche `search-alerts.match-listing` (clé d'idempotence : annonce et version) préfiltre les demandes actives en SQL (opération, commune, budget avec tolérance), applique `matchListing`, puis crée les rapprochements. Les annonces d'une organisation dont `listings.publication` est coupée ne sont jamais rapprochées.
- **Annonce suspendue ou retirée** avant l'envoi : le rapprochement en attente passe `withdrawn` et ne part pas. Après l'envoi : la page personnelle l'affiche « Plus disponible ».
- **Envoi** : la tâche `search-alerts.dispatch` envoie **au plus un message par demande et par jour**. Le premier rapprochement du jour part tout de suite ; les suivants sont regroupés dans le message du lendemain. Aucun envoi entre 21 h et 7 h (heure de Ouagadougou, UTC) ; plafond mensuel par demande (8 par défaut). Les correspondances exactes passent avant les similaires. **Le statut de la demande est relu juste avant chaque envoi** : un message en file ne part jamais après un arrêt ou une pause.
- **Texte du SMS** : court, en **alphabet GSM 7 bits**, 160 caractères au plus, par exemple : « Ziga : 2 logements pour votre recherche (Ouaga 2000, 2 ch., 100 000 FCFA max). Voir : https://ziga.com/d/xxxx Arrêter : https://ziga.com/d/xxxx/stop ». Les montants y sont écrits avec une espace ordinaire (l'espace fine insécable n'existe pas en GSM 7 bits). Les liens courts sont servis par la vitrine elle-même, sans raccourcisseur tiers.
- **Notification du navigateur** (si la personne l'accepte) : envoyée à la place du SMS tant que l'abonnement est valide ; SMS en secours si l'envoi échoue ou si l'abonnement a expiré. Cela demande la bibliothèque `web-push` (clés VAPID) : **propose-la dans le plan**, avec sa raison ; si elle est refusée, livre le SMS seul et note l'écart au journal.
- **Reconfirmation** tous les 90 jours depuis la dernière confirmation : « Ziga : toujours en recherche ? Confirmer : lien. Arrêter : lien ». Sans réponse sous 7 jours, la demande passe `paused` (plus aucun envoi) ; un clic depuis le lien personnel la relance pour 90 jours. Un « Ça m'intéresse » ou une modification de la demande vaut confirmation.
- **Conservation** : une demande en pause depuis 6 mois, ou arrêtée depuis 30 jours, perd son nom, son numéro et ses jetons ; les critères restent, anonymes, pour les statistiques. Durées réglables, en attente de la réponse du juriste (question ouverte de `docs/DECISIONS.md`).
- **Coût** : chaque message enregistre son coût estimé (réglage « prix d'un SMS ») ; le back-office affiche le total du mois.

### 4. « Ça m'intéresse » crée un prospect dans l'organisation de l'annonce
- Un `lead` est créé dans l'organisation de l'annonce, source `search_alert`, avec le nom, le numéro et un résumé de la recherche ; notification dans l'application comme au lot 12. Une seule fois par demande et par annonce (idempotence).
- Si `leads.contact_form` est coupé pour cette organisation : pas de prospect ; la page propose les boutons WhatsApp et Appeler de l'annonce.
- L'organisation ne voit **rien d'autre** de la demande : ni les autres annonces signalées, ni les autres organisations concernées, ni l'historique des messages.
- « Pas pour moi » retire l'annonce des messages et n'envoie rien à l'organisation.

### 5. Recherches des clients d'une organisation (`client_searches`)
- **Table métier** : `organization_id NOT NULL`, clés étrangères composites, RLS, journal d'audit, **synchronisée par PowerSync** (utilisable hors connexion). Contenu :
  - critères (même schéma) ;
  - nom et téléphone du client ;
  - prospect lié facultatif (`lead_id`) et agent affecté ;
  - statut (`active`, `found`, `abandoned`) ;
  - mention « Le client accepte d'être recontacté », avec sa date.
- **Rapprochement local**, avec la même fonction appliquée aux unités : unités **disponibles** de l'organisation au sens de la règle 13, publiées ou non, y compris celles en préavis. Jamais un logement d'une autre organisation.
- **Écrans** :
  - liste « Recherches clients », avec le nombre de logements correspondants ;
  - formulaire (le même que sur la vitrine, sans code SMS) ;
  - fiche avec les logements correspondants et le bouton « Prévenir par WhatsApp » (message pré-rempli avec le logement, et le lien de l'annonce si elle est publiée) ;
  - sur la fiche d'une unité disponible : « 2 recherches de clients correspondent ».
- Notification dans l'application quand une unité devient disponible et correspond à une recherche active.
- **Pas d'envoi automatique par la plateforme** pour ces recherches : l'agent prévient son client lui-même.
- **Permissions** : direction et gestionnaire (tout) ; agent de terrain (les recherches qui lui sont affectées) ; lecture et comptabilité (lecture seule).

### 6. Back-office
- Réglages listés au point 1, chaque changement journalisé.
- Suivi agrégé : demandes par statut, messages du mois et coût estimé, part de « Ça m'intéresse », part des arrêts. Aucune donnée personnelle sur cet écran.
- Assistance : recherche d'une demande par numéro, avec motif, journalisée ; actions possibles : arrêter la demande, renvoyer le lien personnel.

### 7. Interrupteurs
À ajouter au catalogue `packages/shared/features.ts` (déjà décrits dans `docs/FEATURE-FLAGS.md`) :
- `listings.search_alerts` (`enabled` au lancement). Coupé : le bouton disparaît de la vitrine, aucune nouvelle demande, **aucun envoi** ; les pages personnelles restent consultables et « Je ne suis plus intéressé » marche toujours (règle 10). Rouvert : les envois reprennent, sans rattrapage des messages des jours coupés.
- `leads.client_searches` (`enabled` au lancement), vérifié pour chaque organisation.

## Hors périmètre
- Statistiques de la demande pour les agences (« 120 demandes pour Ouaga 2000, 2 chambres, moins de 100 000 FCFA ») : plus tard, agrégées et anonymes, par une décision séparée.
- Liste publique des demandes, ou réponses des agences aux demandes (modèle des « annonces inversées ») : écarté par D31.
- Envoi par l'API WhatsApp Business (`notifications.whatsapp_api`, phase 4) ; arrêt par réponse « STOP » à un SMS.
- Envoi automatique aux clients enregistrés par une organisation.
- Favoris, comptes visiteurs dédiés.

## Tests attendus
- `matchListing` : table de cas (exacte ; chaque assouplissement ; deux critères hors limites, donc aucun rapprochement ; bornes exactes du budget et de la tolérance de 15 % ; unité en préavis et date souhaitée).
- Numéro non confirmé : aucun envoi ; demande en attente effacée après 24 heures.
- Un même logement n'est signalé qu'une fois, une seconde fois seulement après une baisse de prix ; rejouer la tâche ne crée aucun doublon.
- Au plus un message par jour ; aucun entre 21 h et 7 h ; plafond mensuel respecté (horloge simulée).
- « Je ne suis plus intéressé » : un message déjà en file ne part pas.
- Reconfirmation : message à 90 jours ; pause après 7 jours sans réponse ; envois repris après réactivation ; un « Ça m'intéresse » repousse l'échéance.
- Conservation : nom, numéro et jetons effacés aux échéances ; critères gardés, anonymes.
- Interrupteur `listings.search_alerts` coupé : aucun envoi, bouton absent, arrêt toujours possible.
- **Cloisonnement** :
  - aucun endpoint d'organisation, aucune règle PowerSync et aucun export ne renvoie une demande de la vitrine (deux organisations, avec des demandes qui correspondent à leurs annonces) ;
  - `app_sync` n'a aucun droit sur les tables de demandes ;
  - « Ça m'intéresse » crée un prospect dans la seule organisation de l'annonce ;
  - tests d'accès croisé sur `client_searches` : une organisation A tente de lire, modifier et référencer une recherche de B, et elle est refusée.
- Rapprochement de `client_searches` : uniquement les unités de l'organisation, y compris non publiées ; jamais une unité occupée, « à remettre en état » ou « en travaux ».
- SMS : chaque texte généré tient en 160 caractères de l'alphabet GSM 7 bits (aucune espace fine insécable, aucun caractère hors alphabet).
- Lien personnel : jeton stocké haché ; ancien lien révoqué après « Retrouver mes demandes ».
- Playwright :
  - sur téléphone (360 × 800), avec le faux adaptateur SMS : demande, code, confirmation, publication d'une annonce qui correspond, lien reçu, « Ça m'intéresse », prospect visible côté agence, arrêt ;
  - écrans de la vitrine et « Recherches clients » sur les trois appareils, sans débordement horizontal sur téléphone.

## Critères d'acceptation
- [ ] Un visiteur sans compte enregistre une demande en moins d'une minute sur téléphone, code SMS compris.
- [ ] Une annonce publiée qui correspond déclenche le message en moins de 5 minutes, hors heures de silence.
- [ ] Un clic sur « Je ne suis plus intéressé » arrête tout envoi immédiatement, sans connexion ni code.
- [ ] Aucune organisation ne peut obtenir la liste des demandes de la vitrine (vérifié par les tests de cloisonnement).
- [ ] JavaScript des pages de la demande < 100 Ko compressés.
- [ ] Journal des lots mis à jour, avec une estimation du coût des SMS pour un mois de pilote.

## Instructions de travail
Présente avant de coder :
- le schéma, et la protection des tables de plateforme sans `organization_id` ;
- la fonction de rapprochement, avec sa table de cas ;
- le calendrier des tâches BullMQ (déclencheurs, envoi quotidien, reconfirmation, effacement) ;
- les textes exacts des messages (SMS, notification du navigateur, case de consentement) ;
- la dépendance `web-push`, avec sa raison.

Les textes des messages et du consentement sont relus par le porteur avant d'être figés.
