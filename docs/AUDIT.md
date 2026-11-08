# Audit fonctionnel et UX/UI — Plateforme immobilière (avant lot 01)

Rapport d'audit du 08/11/2026, mis à jour avec les décisions du porteur. Version de travail partagée : https://claude.ai/artifact/WNYWg6QEaXPttoDzifpkyE. Les décisions qui font foi sont dans `docs/DECISIONS.md` (D12 à D24).

## Synthèse

Le socle de la maquette est sain : le registre des encaissements, les reçus, les impayés, les profils et l'adaptation aux appareils tiennent. En revanche, trois choix de modèle doivent être tranchés **avant le lot 01** : qui est une « organisation », comment une même personne existe dans plusieurs agences, et comment se compose le statut d'un logement. Les reprendre après le lot 03 coûterait une refonte des tables, des règles d'isolement par agence (RLS) et de la synchronisation.

**Ce qui manque pour une première version exploitable** : la sortie du locataire (préavis, état des lieux, décompte de caution, remise en état), un vrai parcours d'ajout de bien, la répartition des dépenses entre propriétaire, agence et locataire, et le back-office.

**Points discutés et décision retenue (votre retour du 08/11/2026) :**

1. **Statuts des biens — validé.** Quatre dimensions séparées ; l'occupation est calculée à partir du bail, jamais saisie.
2. **Caution — validé.** Un seul décompte de sortie, fait de lignes justifiées, couvre les scénarios A, B et C. Le scénario B n'est possible que par accord écrit (article 26).
3. **Historique du locataire — précisé et validé.** Le locataire retrouve dans son espace tout son historique (baux, reçus, cautions, décomptes), quelle que soit l'agence. Aucune information sur un locataire ne passe d'une agence à une autre : l'attestation partagée que je proposais est retirée.
4. **Propriétaire multi-agences — validé.** Un logement n'a qu'un seul gestionnaire. L'espace du propriétaire présente tous ses logements au même endroit : ceux confiés à chaque agence utilisatrice et ceux qu'il gère lui-même.
5. **Espèces — validé.** Les moyens de paiement acceptés sont un réglage de l'agence, pas une option commerciale.
6. **3D immersive — validé.** Écartée de la vitrine ; la visite 360° reste une option chargée à la demande.
7. **Signature électronique — sans retour.** Je maintiens la recommandation : bail généré en PDF, signé, légalisé à la mairie, puis scanné.

**Complément du 08/11/2026 : contrats de bail et documents (section C7).** Le contrat devient le document officiel du bail, avec son propre cycle. Après votre retour : chaque organisation garde son modèle Word, que la plateforme remplit automatiquement ; la légalisation et l'enregistrement sont suivis sans bloquer ; un bail peut être en vigueur sans contrat signé, avec une alerte. Le modèle transmis par une agence pilote révèle des paramètres que le bail doit porter (garantie des factures, pénalité, préavis, reconduction) et une question juridique : l'agence y signe comme bailleur. D23 et D24 restent à valider.

**Décisions à écrire dans `docs/DECISIONS.md` avant de coder :**

| N° | Décision proposée | Avant le lot | Statut |
| --- | --- | --- | --- |
| D12 | L'unité d'isolement devient l'**organisation** : une agence ou un bailleur particulier | 01 | Validée |
| D13 | Une **personne** (compte global) peut être liée aux fiches propriétaire ou locataire de plusieurs organisations ; son espace présente l'ensemble de ses biens ou de son historique, dès le lancement | 02 | Validée |
| D14 | Statut d'une unité en quatre dimensions ; occupation calculée | 07 | Validée |
| D15 | Compte de caution et décompte de sortie unique ; aucune retenue sans ligne d'état des lieux et justificatif | 08 | Validée |
| D16 | Un seul mandat de gestion actif par unité ; transfert de gestion guidé | 06 | Validée |
| D17 | Aucune information sur un locataire ou un propriétaire ne passe d'une organisation à une autre ; seule la personne concernée voit l'ensemble de ses données | 02 | Validée |
| D18 | Moyens de paiement acceptés : réglage de l'agence, pas un interrupteur commercial | 04 | Validée |
| D19 | Pas de 3D sur la vitrine ; visite 360° en option, chargée à la demande | 12 | Validée |
| D20 | Le contrat est le **document du bail**, avec son propre cycle (brouillon, vérification, prêt à signer, signé) séparé de celui du bail ; légalisation et enregistrement suivis sans bloquer ; **modèle Word de l'organisation rempli automatiquement**, relu puis figé ; versions avec empreinte ; avenants ; bail en vigueur possible sans contrat signé, avec alerte | 08 bis | Validée |
| D21 | Signature **manuscrite** au MVP, puis scan déposé ; un PDF déposé n'est jamais présenté comme une signature électronique ; signature qualifiée plus tard par une interface dédiée | 08 bis | Validée |
| D22 | **Registre de documents** avec une matrice de confidentialité par type (restreindre possible, élargir impossible) ; aucun document d'une organisation visible par une autre ; le locataire et le propriétaire voient les documents dont ils sont parties | 07 | Validée |
| D23 | Génération des contrats avec **docxtemplater** (remplissage du modèle Word) et **Gotenberg** (conversion en PDF) : deux nouvelles dépendances | 08 bis | Validée |
| D24 | Le contrat **désigne le bailleur** (propriétaire représenté par l'organisation, ou organisation en son nom). Préavis et indemnités, reconduction, jour d'échéance, pénalité de retard, garantie des factures et délai de restitution sont des **paramètres du bail** issus du contrat, avec les valeurs légales par défaut | 08 | Validée |

Le lot 01 peut démarrer dès que D12 est tranchée, car elle fixe le nom de la colonne d'isolement dans tout le code.

## A. Audit de l'existant

La maquette couvre bien le travail quotidien d'une agence pendant le bail, mais presque rien avant (ajout du bien, recherche du locataire) ni après (sortie). Les lots 07, 08 et 10 prévoient une partie de ce qui manque, avec deux contradictions à corriger.

### Ce qui fonctionne bien

- **Encaisser en trois gestes** depuis le téléphone, avec un statut qui dépend de la preuve : « à rapprocher » pour le Mobile Money déclaré, « à valider » pour les espèces d'un agent de terrain.
- **Reçus numérotés par le serveur**, jamais supprimés, corrigés par une annulation motivée.
- **Impayés et relances WhatsApp** en série, **relevé propriétaire** partagé par lien.
- **Sept profils** qui ne voient que leur périmètre, trois agencements selon l'appareil, icônes Lucide uniquement.
- **Isolement par agence et interrupteurs** pensés dès la conception, et non ajoutés après coup.

### Incomplet

| Élément | Dans la maquette aujourd'hui | Ce qui manque |
| --- | --- | --- |
| Caution | Un montant sur le bail | Versements en plusieurs fois, solde, détenteur (agence ou propriétaire), mouvements |
| Biens | Liste et fiche | Parcours d'ajout, terrain, vente, géolocalisation, documents |
| Statut d'unité | 4 valeurs saisies à la main | Séparation des dimensions, calcul à partir du bail |
| Dépenses | Libellé et montant | Catégorie, qui paie, qui supporte, justificatif, lien avec la caution |
| Mandat | Un mandat implicite par propriétaire | Plusieurs propriétaires d'un même bien (indivision), transfert de gestion |
| Espace locataire | Solde, reçus, signalement | Bail, caution, suivi du signalement, historique complet |
| Espace propriétaire | Une seule agence | Plusieurs agences et ses biens en gestion directe |

### Absent

- État des lieux d'entrée et de sortie, préavis, décompte de caution.
- Demandes de location, visites, candidatures.
- Back-office de la plateforme : organisations, formules, abonnements, interrupteurs.
- Interventions : du signalement du locataire à la réparation et à sa dépense.
- Reversements aux propriétaires (prévus au lot 10, absents de la maquette).

### Incohérences à corriger

1. **Le lot 08 remet l'unité « libre » à la fin du bail.** C'est contraire à votre exigence : un logement qui attend des travaux ne doit pas redevenir disponible.
2. **Le statut d'unité est stocké alors que le bail le détermine.** Deux sources de vérité finiront par se contredire, et l'annonce affichera un logement occupé.
3. **D11 prévoit des espaces propriétaire et locataire par lien, agence par agence.** Votre exigence d'un espace unique couvrant plusieurs agences demande un compte de personne, absent du modèle actuel.
4. **Le plafond de caution est un paramètre d'agence (2 mois par défaut).** Or la loi le fixe à deux mois (article 26) ; l'agence ne doit pas pouvoir le relever en silence.

### Problèmes d'ergonomie

- Sur ordinateur, la seule action principale est « Encaisser » ; il manque un bouton « Créer » (bien, locataire, bail, dépense).
- Aucun écran de démarrage : une agence qui s'inscrit arrive sur un tableau vide, sans guide vers l'import Excel.
- L'onglet « Plus » du téléphone regroupe des sujets sans rapport ; il grossira avec chaque lot.
- Les données de démonstration ne contiennent qu'une agence : impossible de montrer un propriétaire ou un locataire présent dans deux agences.

### Risques liés à la logique métier

| Risque | Conséquence | Parade |
| --- | --- | --- |
| Retenue sur caution sans preuve | Litige, perte de confiance des locataires | Retenue possible seulement sur une ligne d'état des lieux imputée au locataire, avec justificatif |
| Logement annoncé alors qu'il est en travaux | Visites inutiles, vitrine non fiable | Disponibilité calculée (bail + état technique) |
| Deux agences gèrent la même unité | Double encaissement, reçus contradictoires | Un seul mandat de gestion actif par unité (contrainte en base) |
| Gestion transférée d'une agence à une autre | Caution « perdue » entre les deux | Transfert guidé qui enregistre qui détient la caution |
| Même dépense comptée sur le relevé et retenue sur la caution | Le propriétaire est remboursé deux fois | Une dépense = un enregistrement, avec une seule partie qui la supporte |
| Historique locataire partagé entre agences | Infraction au droit des données, « liste noire » erronée | Aucun partage : chaque agence ne voit que ses propres baux |
| Abonnement impayé qui bloque l'agence | Loyers non saisis, agence perdue | Mode restreint progressif ; consultation et export toujours possibles |

## B. Parcours utilisateurs

Cinq acteurs échangent autour d'un logement, mais seule l'organisation qui le gère (agence ou bailleur particulier) écrit dans le registre. Les autres consultent, demandent ou valident. Le schéma montre qui fait quoi pour qui ; le tableau donne les parcours et les écrans.

*Schéma (version texte) — seule l'organisation gestionnaire écrit dans le registre :*

- Visiteur ou acheteur → organisation : demande, visite ; organisation → visiteur : annonces. Le visiteur devient locataire en signant un bail.
- Locataire → organisation : loyers, préavis ; organisation → locataire : reçus, décompte.
- Propriétaire → organisation : mandat, approbations ; organisation → propriétaire : relevés, reversements. Le propriétaire voit aussi, en lecture, ses autres biens gérés par une autre agence ; les deux agences n'ont aucun accès croisé.
- Organisation → plateforme : abonnement ; plateforme → organisation : fonctionnalités, assistance.

Le propriétaire voit ses biens chez d'autres agences dans son propre espace ; les deux agences, elles, ne voient jamais rien l'une de l'autre.

| Profil | Parcours essentiels | Écrans nécessaires | Avec qui |
| --- | --- | --- | --- |
| **Visiteur, acheteur** | Chercher, comparer, demander une visite, être rappelé | Vitrine (Louer, Acheter), fiche annonce, formulaire de demande, suivi de sa demande par lien | Agence |
| **Candidat locataire** | Visiter, déposer un dossier, recevoir l'accord, signer le bail | Demande, créneau de visite, dépôt de pièces (P2), bail à relire | Agence |
| **Locataire** | Payer, retrouver ses reçus, suivre sa caution, signaler un problème, donner son préavis, suivre le décompte de sortie | Accueil (solde, prochaine échéance), reçus, bail, caution, signalements, préavis, décompte | Agence ou bailleur |
| **Propriétaire** | Confier un bien, suivre ses revenus, approuver une dépense importante ou un accord de caution, recevoir ses reversements | Patrimoine (tous ses biens, par gestionnaire), fiche bien, relevés, reversements, approbations | Une ou plusieurs agences |
| **Bailleur particulier** | Tout ce que fait une agence, en version simple, sur ses propres biens | Mêmes écrans que l'agence, sans équipe ni commission | Ses locataires |
| **Agence : direction** | Piloter l'activité, gérer l'équipe, l'abonnement et les réglages | Tableau de bord, équipe et rôles, réglages, formule | Plateforme |
| **Agence : gestionnaire** | Ajouter des biens, louer, encaisser, relancer, sortir un locataire, produire les relevés | Biens, locataires, baux, encaissements, impayés, sorties, dépenses, relevés, demandes | Tous |
| **Agence : agent de terrain** | Visites, encaissements en espèces, photos, états des lieux | Ses unités, encaisser, prendre des photos, état des lieux guidé | Gestionnaire, locataire |
| **Administrateur plateforme** | Accueillir une agence, gérer formules et abonnements, activer des fonctionnalités, assister sans voir plus que nécessaire | Organisations, formules, abonnements, interrupteurs, journal, accès d'assistance | Agences |

Deux interactions demandent un circuit de validation entre acteurs, absent aujourd'hui :

- **Accords autour de la caution** (imputation sur les derniers loyers, réparation faite par le locataire) : proposés par l'un, acceptés par l'autre, horodatés.
- **Dépenses au-delà d'un seuil fixé dans le mandat** : approbation du propriétaire avant les travaux, comme le font déjà les agences par téléphone.

## C. Analyse fonctionnelle

Vos six besoins sont fondés, et la loi n° 103-2015/CNT sur le bail d'habitation privée en couvre déjà une bonne partie. La plateforme doit appliquer ce cadre plutôt qu'inventer ses propres règles. Les articles cités ci-dessous sont à faire confirmer par un juriste (voir la dernière section).

### C1. Caution : de l'entrée à la restitution

Selon la loi, la garantie couvre les loyers impayés, les charges impayées et les réparations locatives ; elle ne dépasse pas deux mois de loyer (articles 3 et 26). Elle est rendue à la fin du bail lorsque les deux parties acceptent l'état des lieux de sortie, déduction faite des sommes dues et justifiées. Les parties peuvent aussi convenir de l'imputer sur les derniers loyers.

**À l'entrée : un compte de caution par bail.**

- Montant convenu, saisi en mois de loyer ou en somme fixe, toujours stocké en FCFA.
- Versements en une ou plusieurs fois, chacun avec son reçu ; le solde restant dû est affiché.
- **Détenteur** de la caution : l'agence ou le propriétaire. Sans cette information, personne ne sait qui doit rembourser.
- Avertissement explicite, et tracé dans le journal, au-delà de deux mois de loyer.
- L'**avance** (loyers payés d'avance) n'est pas une caution : c'est un encaissement imputé sur les premières échéances. Les mélanger fausse les deux soldes.

**À la sortie : l'état des lieux, puis un décompte unique.**

La loi exige un état des lieux écrit, daté, signé des deux parties, à l'entrée et à la sortie, sans formule vague comme « bon état » (articles 8 et 9). Le locataire ne répond ni de l'usure normale ni de la vétusté (article 20). La plateforme reprend ces règles telles quelles :

1. **État des lieux par pièce et par élément** (porte, douche, prises…), photos datées, comparé à celui d'entrée. Pour un meublé, l'inventaire des meubles en fait partie.
2. **Constat par élément**, parmi trois choix : usure normale, dégradation imputable au locataire, défaut à la charge du propriétaire.
3. **Réparation** pour chaque dégradation imputable : description, montant estimé (devis) puis réel (facture), justificatif, et qui la réalise (le propriétaire via l'agence, ou le locataire lui-même).
4. **Décompte de sortie** : caution reçue, moins les réparations justifiées, moins les loyers et charges impayés, moins les mois couverts par accord. Le résultat est soit un montant à restituer, soit un complément à réclamer.
5. **Mouvements en ajout seul** sur le compte de caution : versement reçu, retenue pour réparation, imputation sur loyer, restitution, complément réclamé, changement de détenteur. Le total des sorties ne dépasse jamais la caution reçue.

Votre exemple (100 000 FCFA de caution, 10 000 FCFA pour la douche, 5 000 FCFA pour la porte, 85 000 FCFA à restituer) devient un décompte de deux lignes, chacune rattachée à un élément de l'état des lieux et à son justificatif.

**Règle contre les retenues arbitraires** : une retenue n'existe que si elle pointe vers une ligne d'état des lieux classée « imputable au locataire », avec un montant et un justificatif. Sinon, l'application refuse de l'enregistrer.

**Vos trois scénarios deviennent trois variantes du même décompte :**

| Scénario | Ce qui change dans le décompte | Condition |
| --- | --- | --- |
| A. Restitution après réparations | Lignes de réparation, puis restitution du solde | État des lieux de sortie accepté |
| B. Caution utilisée comme derniers loyers | Lignes « imputation sur loyer », mois par mois, puis réparations, puis solde | Accord écrit et daté **avant** les mois concernés ; l'application affiche ce qu'il restera pour couvrir les dégâts |
| C. Le locataire répare lui-même | Lignes « réparé par le locataire » à 0 FCFA, après contre-visite | Proposition du locataire, acceptation ou refus motivé du gestionnaire |

Le scénario B est le plus risqué pour le propriétaire : si toute la caution part en loyers, plus rien ne couvre les dégradations. Je recommande de l'autoriser, mais avec cet avertissement et la possibilité d'en garder une partie.

**Désaccord.** Si l'une des parties refuse l'état des lieux, le décompte passe « en contestation » : observations des deux côtés, pièces, historique. Je recommande de restituer sans attendre la partie non contestée. La plateforme n'arbitre pas : elle enregistre l'issue (accord amiable ou décision de justice).

### C2. Ajout des biens et statuts

**Le parcours d'ajout** se fait en cinq étapes, enregistrables à tout moment en brouillon :

1. **Type et propriétaire** : villa ou maison, immeuble d'appartements, cour commune, local commercial, terrain ; propriétaire et mandat (ou « je suis le propriétaire » pour un bailleur particulier).
2. **Localisation** : commune, quartier, repère en texte (« derrière la pharmacie »), point GPS pris sur place avec le téléphone. La vitrine n'affiche que le quartier, jamais le point exact.
3. **Unités** : pour chacune, type (entrée-coucher, chambre-salon, appartement…), pièces, douches, meublé ou non, équipements, loyer, charges, conditions (caution, avance).
4. **Médias** : photos (déjà prévues), courte vidéo compressée (P2), lien vers une visite 360° hébergée ailleurs (P3).
5. **Documents privés** : titre foncier, PUH, attestation d'attribution, mandat. Ils ne sont jamais publiés.

**« Maison meublée » n'est pas un type** : c'est une caractéristique de l'unité. Elle a une conséquence pratique : l'état des lieux comprend alors l'inventaire des meubles. **Le terrain** est un bien sans unité à louer dans la plupart des cas ; on le gère surtout en vente. **La vente** suppose un mandat de vente et un prix ; elle n'a ni bail ni échéances.

**Les statuts : quatre dimensions, pas une liste.** Votre liste mélange des informations qui changent pour des raisons différentes. Un logement peut être à la fois occupé (bail en cours), en préavis (libre dans deux mois) et annoncé (pour éviter la vacance). Avec un statut unique, il faut choisir et perdre de l'information.

| Dimension | Valeurs | Qui la change |
| --- | --- | --- |
| Fiche | Brouillon, active, archivée | Le gestionnaire |
| Occupation | Libre, réservée (bail signé qui commence plus tard), occupée, en préavis (libre le jj/mm/aaaa) | **Calculée à partir des baux**, jamais saisie |
| État technique | Prête, à remettre en état, en travaux, indisponible (motif obligatoire) | L'état des lieux et le gestionnaire |
| Annonce | Non publiée, en attente de vérification, publiée, suspendue, retirée | Les règles de publication et le gestionnaire |

**« Disponible » devient un résultat**, pas une saisie : fiche active, logement libre ou en préavis, état « prête ». « En cours de visite » devient un compteur de visites prévues sur la carte du logement. « Disponible à la vente » dépend du mandat et de l'annonce, pas du logement.

C'est ce qui répond à votre exemple : à la fin du bail, l'unité passe « à remettre en état ». Elle ne redevient disponible qu'une fois l'état des lieux clos et les travaux terminés.

*Schéma (version texte) — cycle de vie d'une unité :* Brouillon → (fiche complète) → **Disponible** → (bail signé) → Réservée → (entrée, état des lieux) → Occupée → (préavis donné) → En préavis → (sortie, état des lieux) → À remettre en état → soit (rien à réparer) → Disponible, soit (travaux à faire) → En travaux → (travaux terminés) → Disponible. « Indisponible » et « archivée » s'appliquent à tout moment, avec un motif. Une annonce est possible en « Disponible » et « En préavis ».

La fin du bail ne ramène pas l'unité à « Disponible » : elle passe d'abord par « À remettre en état », puis, si nécessaire, par « En travaux ».

### C3. Location : de l'annonce à la fin du bail

| Étape | Ce que la plateforme fait | Priorité |
| --- | --- | --- |
| Demande | Formulaire ou WhatsApp depuis l'annonce, enregistré comme demande | P1 (lot 12) |
| Visite | Créneau, agent, compte rendu en une ligne | P2 |
| Candidature | Pièces minimales (identité, contact, garant) ; supprimées quelques mois après un refus | P2 |
| Réservation | Bail signé qui commence plus tard ; tout acompte est un encaissement avec reçu | P1 |
| Bail | Généré en PDF depuis un modèle, imprimé, signé, légalisé à la mairie, transmis aux impôts (articles 5 et 11), puis scanné et joint | P1 |
| État des lieux d'entrée | Même outil que la sortie | P1 |
| Loyers, reçus, impayés | Déjà couverts | P1 |
| Renouvellement, révision | Date de fin, alerte ; révision selon le décret prévu à l'article 37 | P2 |
| Préavis | Date, origine, motif ; deux mois pour un bail à durée déterminée quitté avant terme, trois mois pour un bail à durée indéterminée (articles 45 et 46) | P1 |
| Sortie | État des lieux, décompte, remise en état (C1) | P1 |

**Signature électronique** : je déconseille d'en faire un objectif. La légalisation en mairie reste obligatoire, et une signature en ligne n'aurait pas la même valeur. Plus tard, une acceptation par code SMS peut servir de preuve complémentaire (P3). Chaque étape écrit une ligne dans le journal et dans l'historique du bail.

### C4. Dépenses

Pour éviter les doubles comptes, une dépense est **un seul enregistrement** qui répond à trois questions distinctes :

| Question | Réponses possibles |
| --- | --- |
| Qui a payé le réparateur ? | L'agence (avance), le propriétaire, le locataire |
| Qui la supporte au final ? | Le propriétaire, l'agence, le locataire |
| Comment est-elle récupérée ? | Déduite du relevé du propriétaire, retenue sur la caution, réclamée au locataire, aucune récupération |

La retenue sur caution **renvoie** à la dépense au lieu d'en créer une seconde ; le relevé du propriétaire l'exclut dès qu'elle est supportée par le locataire. Chaque dépense a une catégorie (plomberie, électricité, menuiserie, entretien, taxe, autre), une date, un bien ou une unité, et un justificatif si possible.

Deux points de désaccord avec votre liste :

- **Les frais de gestion ne sont pas une dépense** : c'est la commission de l'agence, calculée sur le relevé. La traiter en dépense la compterait deux fois.
- **La comptabilité générale de l'agence (SYSCOHADA) reste hors périmètre.** La plateforme tient la comptabilité des mandats (ce qui est encaissé, retenu et reversé pour chaque propriétaire) et l'exporte au comptable.

### C5. Propriétaire ayant des biens dans plusieurs agences

Votre exemple (maison A chez l'agence A, maison B chez l'agence B, appartement C géré en direct) se résout ainsi :

- **Chaque organisation garde sa fiche propriétaire**, comme aujourd'hui. L'agence A ne sait rien de la maison B.
- **Le propriétaire a un compte de personne**, vérifié par code SMS. Chaque agence accepte de lier sa fiche à ce compte.
- **Son espace agrège des vues en lecture** fournies par chaque organisation : statut, loyers, baux, cautions, dépenses, rendement par bien. L'appartement C vit dans son propre espace de bailleur particulier.
- **Chaque bien affiche son gestionnaire** (agence A, agence B, gestion directe).

**Règle proposée : un seul mandat de gestion actif par unité.** Partager la gestion d'un logement entre deux agences créerait deux registres pour les mêmes loyers. Les mandats de vente non exclusifs, eux, peuvent coexister (P3).

**Le transfert de gestion** (A vers B, ou A vers le propriétaire) devient une opération guidée : fin du mandat de A, remise du dossier (bail, locataire, documents), changement de détenteur de la caution. A garde son historique comptable ; B reçoit une copie du dossier, jamais l'accès aux écritures de A.

**Indivision** : beaucoup de biens appartiennent à plusieurs héritiers. Au MVP, le propriétaire peut être un groupe avec un représentant ; la répartition des revenus par quote-part vient en P2.

### C6. Locataire qui change d'agence

**Décision (08/11/2026) : le locataire suit tout son historique, et rien n'est partagé entre agences.** Un locataire qui déménage d'un logement géré par l'agence A vers un logement géré par l'agence B retrouve tout dans son propre espace. L'agence B, elle, ne voit que ce qu'elle a saisi.

Concrètement :

- **Chaque agence garde sa propre fiche locataire**, isolée comme toutes ses données.
- **Le compte du locataire est lié à chacune de ces fiches**, après vérification par code SMS et accord de l'agence.
- **Son espace présente une chronologie unique** : tous ses baux, reçus, cautions et décomptes, chaque élément indiquant l'agence concernée.
- **Aucune agence ne voit les baux d'une autre**, ni directement ni par une attestation. Ce choix respecte aussi la loi n° 001-2021/AN et la nouvelle loi sur les données votée le 3 août 2026.

### C7. Contrats de bail et documents contractuels (complément du 08/11/2026)

**Le contrat doit devenir le document officiel du bail déjà enregistré, pas un module à part.** Le bail porte les données qui font tourner la gestion (dates, loyer, caution, échéances) ; le contrat en est la version rédigée, signée, légalisée et archivée. Deux modules séparés finiraient par afficher un loyer différent dans le contrat et dans l'échéancier.

Le cadre burkinabè impose trois étapes que votre liste ne mentionne pas. Depuis la loi de 2015, le bail doit être écrit, puis légalisé auprès de la commune où se trouve le logement. La commune garde un exemplaire et en transmet un autre à la division fiscale, qui l'enregistre. Le module doit suivre ces trois étapes, sinon le contrat « signé » dans la plateforme n'est pas en règle.

#### 1. Ce que prévoit la maquette aujourd'hui

Rien de spécifique : le bail n'existe que comme une ligne de données (unité, locataire, loyer, dates). Il n'y a ni modèle, ni projet de contrat, ni registre de documents, ni rubrique « Mes contrats » pour le locataire. Trois composants existants sont réutilisables : le rendu de document du reçu et du relevé (aperçu avec panneau d'actions), les panneaux latéraux et les menus d'actions par ligne.

#### 2. Deux cycles distincts : le bail et son contrat

Votre liste de dix étapes mélange, comme pour les biens, deux choses qui changent pour des raisons différentes. Je propose de les séparer :

| Dimension | Étapes | Ce qui la fait avancer |
| --- | --- | --- |
| **Bail** (la relation) | Brouillon, signé à venir, en vigueur, en préavis, terminé (motif : expiration, résiliation par le locataire ou le bailleur, accord, décision de justice), annulé | Les dates et les événements de gestion |
| **Contrat** (le document) | Brouillon, en vérification, prêt à signer (figé), signé par le bailleur, signé par le locataire, **légalisé**, **enregistré** | Les actions des personnes, chacune datée |

Trois étapes de votre liste ne sont pas des statuts :

- **« Renouvelé »** est un événement : un avenant qui prolonge le même bail. Le bail reste le même, avec sa caution et son historique. Selon la loi, un bail à durée déterminée maintenu au-delà de son terme devient à durée indéterminée ; la plateforme doit le signaler plutôt que d'exiger un nouveau contrat chaque année.
- **« Archivé »** est un état de consultation : tout bail terminé reste consultable, en lecture seule, sans limite.
- **« En vigueur », « résilié », « expiré »** appartiennent au bail, pas au document.

**Bail en vigueur sans contrat signé : validé (08/11/2026).** Il est permis, avec une alerte visible et une ligne d'audit ; le tableau de bord liste les baux « sans contrat signé ».

**Légalisation et enregistrement : suivis, jamais bloquants.** Comme vous le soulignez, la plateforme apporte la traçabilité. Pour chaque contrat, elle enregistre si et quand il a été légalisé et enregistré, avec la référence et le document. Pour la plateforme, le contrat est complet dès sa signature ; un filtre « non légalisés » aide l'agence à régulariser.

*Schéma (version texte) — bail et contrat :* Bail : Brouillon → (loyer, caution, dates) → Signé, à venir → (date d'effet) → En vigueur → (préavis donné) → En préavis → (date de sortie) → Terminé (motif obligatoire). Contrat : Modèle Word rempli → (relecture) → En vérification → (champs complets) → Prêt à signer (figé) → (signatures datées) → Signé par les deux parties → Légalisé à la commune (suivi) → Enregistré aux impôts (suivi). Le contrat signé rend le bail « signé » ; un avenant depuis un bail en vigueur suit le même cycle. Un bail peut être en vigueur sans contrat signé, avec une alerte.

Les deux étapes en couleur sont propres au Burkina Faso. Elles sont suivies pour la traçabilité, sans bloquer : le contrat est complet dès sa signature.

#### 3. Le modèle de l'organisation, rempli automatiquement (révisé après votre retour)

Votre retour change ma recommandation : chaque organisation garde **son propre modèle**, et la plateforme le remplit avec les données déjà saisies. Le modèle transmis par une agence pilote (cinq pages, imprimé depuis Word) est un document structuré, avec des blancs à remplir et des cases à cocher. Le reproduire clause par clause dans un éditeur de la plateforme coûterait cher et ne serait pas adopté.

- **Mise en place** : l'organisation dépose son modèle Word, et l'on y place une fois les champs (`{locataire.nom}`, `{loyer.montant_lettres}`…) à partir d'un catalogue fourni. Pour les trois pilotes, l'équipe de la plateforme s'en charge à l'accueil.
- **Génération** : depuis le bail, la plateforme remplit le modèle ; le gestionnaire relit le projet, le corrige au besoin, puis le fige (« prêt à signer »).
- **Contrôles au lieu de clauses verrouillées** : le texte du modèle reste sous la responsabilité de l'organisation. La plateforme vérifie les valeurs qu'elle y insère (caution au-delà de deux mois, champ vide, dates incohérentes) et les signale avant la génération.
- **Modèle de base de la plateforme** : seulement pour les organisations qui n'en ont pas, surtout les bailleurs particuliers, après validation par un juriste.
- **Avenants** : même mécanisme, avec un modèle d'avenant.

**Ce que montre le modèle de l'agence pilote :**

| Constat dans le modèle | Conséquence pour la plateforme |
| --- | --- |
| L'agence est désignée comme « le Bailleur » ; le propriétaire n'apparaît pas | Le contrat doit pouvoir désigner comme bailleur soit l'organisation, soit le propriétaire représenté par l'organisation. Question au juriste : en signant en son nom, l'agence endosse les obligations du bailleur |
| Deux dépôts : la caution (au plus deux mois, plus un mois de loyer) et une somme forfaitaire pour les factures d'eau et d'électricité restées impayées | Le compte de caution distingue la caution et la garantie des factures, chacune avec son montant et ses retenues |
| Restitution dans un délai maximal d'un mois après la remise des clés | Délai de restitution enregistré dans le bail, alerte avant son terme |
| Les dépôts ne peuvent servir à payer les loyers en cours du bail | L'imputation de la caution sur les derniers loyers (scénario B) exige un avenant ou un accord écrit explicite |
| Loyer payable au plus tard le 5 du mois ; intérêt de retard de 0,75 % par mois après 10 jours, au profit de l'agence | Jour d'échéance et pénalité sont des paramètres du bail ; le relevé doit savoir à qui reviennent les pénalités |
| Préavis par lettre recommandée ou acte d'huissier ; deux ou trois mois selon la durée ; un mois dans des cas listés (premier emploi, mutation…) ; indemnité en cas de départ anticipé | Le préavis enregistre son mode de notification et sa preuve. La demande faite par le locataire dans son espace n'est qu'une demande, pas un congé. Délais et indemnités viennent du bail, pas d'une règle fixe |
| Reconduction tacite pour une durée égale | Le comportement à l'échéance est un paramètre du bail (même durée, ou durée indéterminée) ; sa compatibilité avec la loi est à vérifier |
| Clause résolutoire deux mois après un commandement de payer resté sans effet | Le commandement de payer devient un événement daté du suivi des impayés (P2) |
| Signatures de l'agence (le gérant) et du locataire, précédées de « lu et approuvé » ; nombre d'exemplaires à remplir | Confirme la signature manuscrite au départ ; lieu, date et nombre d'exemplaires sont des champs |

**Champs à remplir automatiquement et leur source :**

| Groupe | Champs du modèle | Source | Ce qui manque aujourd'hui |
| --- | --- | --- | --- |
| Organisation | Raison sociale, siège, RCCM, IFU, boîte postale, téléphones, logo | Fiche organisation (lot 03) | Boîte postale, logo |
| Représentant | Nom, profession, domicile, nationalité, pièce d'identité (numéro, date, autorité), qualité | Fiche organisation (lot 03) | Tout le bloc |
| Locataire | Civilité, nom, date et lieu de naissance, pièce (type, numéro, date, autorité), nationalité, profession, domicile, téléphones | Fiche locataire (lot 08) | Naissance, nationalité, profession, détail de la pièce |
| Logement | Destination (meublé, usage), type, chambres, salon, cuisine, salle de bain, garage, terrasse, buanderie, surface, terrain, clôture, localisation | Fiche unité (lot 07) | Pièces détaillées, surface, usage, clôture |
| Conditions | Durée, début, fin, loyer en chiffres et en lettres, jour limite, modalités de paiement, caution, garantie des factures, délai de restitution, pénalité, règles de préavis, reconduction, visites | Bail (lot 08) | Montant en lettres, pénalité, garantie des factures, préavis, reconduction |
| Signature | Lieu, date, nombre d'exemplaires | Saisie à la génération | — |

Ces champs complètent les lots 03, 07 et 08. Les données d'état civil du locataire ne sont collectées que parce que le contrat les demande. Le montant en lettres (« soixante-quinze mille francs CFA ») est une fonction pure de `packages/shared`.

#### 4. Signature : ce qui est possible aujourd'hui

La loi n° 045-2009/AN reconnaît la signature électronique et présume fiable la signature sécurisée reposant sur un certificat qualifié. Une plateforme nationale, **FasoSign**, a été lancée en septembre 2026 par le ministère de la Transition digitale ; l'article qui l'annonce ne dit pas si elle est ouverte aux entreprises et aux particuliers. Et même signé électroniquement, le bail resterait à légaliser à la commune.

| Mode | Ce qu'il prouve | Priorité |
| --- | --- | --- |
| PDF généré, imprimé, signé à la main, légalisé, puis scanné et déposé | Le contrat en règle ; la plateforme en garde la copie, avec qui l'a déposée, quand, et son empreinte | P1 |
| Dépôt d'un contrat signé hors plateforme (anciens baux, modèle de l'agence) | Une archive. **Jamais présentée comme une signature électronique** | P1 |
| Acceptation en ligne par code SMS | Que la personne a lu et accepté ce texte précis, à telle date. Ne remplace ni la signature ni la légalisation ; libellé « accepté en ligne » | P3 |
| Signature électronique qualifiée (prestataire agréé ou FasoSign) | Même valeur que la signature manuscrite | P3, à réévaluer quand l'accès privé sera connu |

La signature passe par une interface `SignatureProvider`, avec une seule implémentation « manuscrite » au MVP. Un prestataire qualifié pourra s'y brancher plus tard sans toucher au reste.

#### 5. Documents et confidentialité

Chaque document porte : type, organisation, objets liés (bail, unité, personnes, mandat), version, auteur, date d'ajout, empreinte, statut (actif, remplacé, retiré). Les droits de consultation viennent d'une **matrice par type de document**, que l'organisation peut restreindre mais jamais élargir.

**Mon désaccord** : choisir à la main, pour chaque document, les personnes autorisées serait source d'erreurs (une pièce d'identité ouverte par mégarde). La matrice décide par défaut ; la main ne sert qu'à restreindre.

| Type de document | Organisation (direction, gestionnaire) | Agent de terrain | Propriétaire | Locataire |
| --- | --- | --- | --- | --- |
| Contrat signé, annexes, avenants | Oui | Non | Oui (il est le bailleur) | Oui |
| Projet de contrat | Oui | Non | Si son accord est requis | À partir de « prêt à signer » |
| État des lieux, inventaire | Oui | Oui, sur ses unités | Oui | Oui |
| Justificatifs retenus sur la caution | Oui | Non | Oui | Oui |
| Pièce d'identité du locataire | Oui | Non | Non | Oui (la sienne) |
| Pièce d'identité du propriétaire, titre foncier | Oui | Non | Oui (les siens) | Non |
| Mandat de gestion (contient la commission) | Oui | Non | Oui | Non |
| Notes internes | Oui | Selon le rôle | Non | Non |

**Une autre organisation n'a jamais accès à aucun de ces documents** (règle 15). Chaque téléchargement est journalisé. La durée de conservation des copies de pièces d'identité après la fin du bail est à fixer avec le juriste.

#### 6. Espace locataire : « Mes contrats » et changement d'agence

- Rubrique « Mes contrats », avec trois onglets : en vigueur, à signer, terminés (expirés et résiliés). Chaque carte affiche : logement, agence ou bailleur, dates, loyer, caution, statut du bail et du document, prochaine échéance ou date de renouvellement.
- Fiche contrat : lecture du contrat et des avenants, documents autorisés, téléchargement par lien signé de courte durée.
- **Changement d'agence** : votre exemple (maison chez l'agence A, puis appartement chez l'agence B) est déjà couvert par D13 et D17. Le locataire retrouve les deux contrats dans son compte. L'agence B ne voit ni le contrat de A ni la pièce d'identité déposée chez A ; elle demande ses propres pièces. Le locataire peut télécharger ses documents et les remettre lui-même, hors plateforme, s'il le souhaite.

#### 7. Échéances et alertes

| Échéance | Quand | Qui est prévenu |
| --- | --- | --- |
| Fin d'un bail à durée déterminée | 4 mois puis 3 mois avant, pour laisser le temps du préavis | Organisation, propriétaire |
| Terme atteint sans congé | Le lendemain du terme | Gestionnaire : reconduction appliquée selon le bail (même durée ou durée indéterminée) |
| Contrat en attente de signature | Après 7 jours | Gestionnaire, personne qui doit signer |
| Contrat signé non légalisé ou non enregistré | Rappel mensuel, désactivable | Gestionnaire |
| Fin de préavis | 30 jours et 7 jours avant | Organisation, agent (état des lieux), locataire |
| Restitution de la caution | Avant la fin du délai prévu au bail (un mois dans le modèle pilote) | Organisation, détenteur de la caution, locataire |
| Avenant à valider ou à signer | À sa création | Valideur, locataire, propriétaire si concerné |
| Révision du loyer possible | Tous les trois ans | Gestionnaire, propriétaire |

Au MVP, les alertes apparaissent dans l'application et dans les espaces personnels. Leur envoi par WhatsApp ou SMS vient en P2, par le module `notifications`.

#### 8. Responsabilités

| Question | Réponse proposée |
| --- | --- |
| Qui est le bailleur ? | Celui que le contrat désigne : le propriétaire représenté par l'organisation, ou l'organisation en son nom, comme dans le modèle de l'agence pilote. La plateforme enregistre ce choix et l'affiche au propriétaire ; sa portée juridique est à confirmer par un juriste. |
| L'agence est-elle mandataire ? | Toujours vis-à-vis du propriétaire : un mandat de gestion actif doit couvrir l'unité, même quand l'agence signe en son nom. Sans mandat actif, pas de contrat. |
| Qui crée et modifie un contrat ? | Directeur et gestionnaire. L'agent de terrain, non. |
| Qui valide ? | Le directeur, ou le gestionnaire s'il y est autorisé ; le propriétaire aussi si son mandat l'exige (P2). |
| Qui signe pour le bailleur ? | Le représentant de l'organisation (le gérant dans le modèle pilote) ; le propriétaire lui-même s'il est désigné bailleur, ou l'agence pour lui si son mandat le permet (`can_sign_leases`). |
| Qui ajoute un avenant ? | Les mêmes personnes, avec le même circuit que le contrat. |
| Qui conserve les documents ? | L'organisation gestionnaire, pour l'archive numérique. Au transfert de gestion, la remise du dossier est enregistrée (lot 10 bis). |
| Qui consulte et télécharge ? | Selon la matrice du point 5. |

#### 9. Liens avec le reste de la gestion locative

| Élément du contrat | Effet dans la gestion |
| --- | --- |
| Date de prise d'effet | Occupation calculée (réservée avant, occupée ensuite) et première échéance |
| Loyer, périodicité, jour de paiement | Échéancier ; un avenant de loyer crée les échéances suivantes |
| Caution et détenteur | Compte de caution (D15), reçus de versement |
| Avance | Échéances payées d'avance |
| Durée et date de fin | Alertes ; à la fin, déclenchement de la sortie (préavis, état des lieux, impayés, décompte) |
| Inventaire et état des lieux d'entrée | Annexes du contrat ; référence pour la sortie |
| Clause d'entretien et de réparations | Classement usure normale ou dégradation à la sortie |
| Résiliation | Préavis, date de sortie, décompte, remise en état |

#### 10. Écrans nécessaires

| Espace | Écrans |
| --- | --- |
| Organisation | Liste des contrats (filtres par statut du bail et du document, alertes) ; assistant de création depuis une unité disponible et un locataire retenu ; éditeur de projet (clauses, champs, aperçu, champs manquants) ; suivi de signature, légalisation et enregistrement avec dépôt du scan ; fiche contrat (versions, avenants, documents, chronologie) ; création d'avenant ; modèles de contrat (réglages, direction) ; registre des documents |
| Propriétaire | Contrats de ses biens par gestionnaire ; documents dont il est partie ; validation d'un projet si son mandat l'exige (P2) |
| Locataire | « Mes contrats », fiche contrat, lecture d'un projet « prêt à signer », documents autorisés |

#### 11. Solutions techniques

- **Remplissage des modèles Word** : bibliothèque docxtemplater, dans une tâche BullMQ. Nouvelle dépendance, à inscrire dans `docs/DECISIONS.md` (D23), licence à vérifier avant de l'adopter.
- **Conversion en PDF** : Gotenberg, service conteneurisé fondé sur LibreOffice, ajouté à l'infrastructure. Le PDF sert à la relecture sur téléphone, au partage et au calcul de l'empreinte. Nouvelle dépendance d'infrastructure (D23). pdf-lib reste utilisé pour les reçus et les relevés.
- **Stockage** : compartiment S3 privé, une version = un objet jamais écrasé, empreinte SHA-256 en base, chiffrement côté serveur, liens signés de courte durée, aucun cache CDN (règle 11).
- **Scan sur téléphone** : photos de plusieurs pages assemblées en un PDF compressé, utilisable hors ligne et envoyé à la synchronisation.
- **Signature** : interface `SignatureProvider`, implémentation manuscrite au MVP.

#### 12. Ce qui entre dans la première version

- **P1** : les deux cycles séparés ; modèle Word de l'organisation rempli automatiquement (mis en place par la plateforme pour les pilotes) ; relecture puis figement ; Word et PDF ; versions avec empreinte ; signature manuscrite et dépôt du scan ; légalisation et enregistrement suivis sans bloquer ; avenants ; paramètres du bail issus du modèle (jour d'échéance, pénalité, garantie des factures, délai de restitution, préavis, reconduction) ; bailleur désigné et `can_sign_leases` ; registre des documents et matrice de confidentialité ; alertes dans l'application ; « Mes contrats » ; bail en vigueur possible sans contrat signé, avec alerte.
- **P2** : modèle de base de la plateforme validé par un juriste ; outil qui permet à l'organisation de placer elle-même les champs ; calcul automatique des pénalités de retard ; commandement de payer ; envoi des alertes par WhatsApp et SMS ; validation par le propriétaire ; durées de conservation automatiques.
- **P3** : acceptation en ligne par code SMS ; signature électronique qualifiée (prestataire agréé ou FasoSign, si ouvert au privé) ; dématérialisation de la légalisation et de l'enregistrement, si l'administration la propose.

## D. Recommandations UX/UI par espace

La structure actuelle (un espace par profil, une forme par appareil) est la bonne et doit être conservée. L'effort porte sur les écrans manquants et sur trois composants réutilisables : l'assistant pas à pas, la chronologie et le circuit d'accord.

| Espace | Conserver | Améliorer | Repenser | Nouveaux écrans |
| --- | --- | --- | --- | --- |
| **Vitrine** | Louer et Acheter séparés, filtres en panneau, légèreté | Recherche par quartier avec suggestions, tri, compteur de résultats | Page d'accueil éditoriale (G) au lieu d'une simple grille | Quartiers, agences (page publique d'agence), suivi d'une demande |
| **Fiche annonce** | Mosaïque sur ordinateur, carrousel sur téléphone, contact fixe | Photos plein cadre, conditions claires (loyer, caution, avance), quartier sur carte approximative | Bloc « ce qui est inclus » et « conditions », plutôt qu'une liste brute | Demande de visite avec créneaux, bouton 360° (P3) |
| **Agence** | Tableaux, sélection multiple, Ctrl+K, panneaux latéraux, encaissement en trois gestes | Bouton « Créer » global, écrans vides qui guident, onglet « Plus » réorganisé | Fiche unité autour des quatre dimensions de statut | Assistant d'ajout de bien, locataires, fiche bail avec chronologie, sortie guidée, dépenses, demandes et visites, reversements |
| **Agent de terrain** | Périmètre limité, espèces « à valider » | Mode hors connexion visible | — | État des lieux guidé pièce par pièce avec photos, agenda des visites |
| **Propriétaire** | Revenus du mois, relevés | Rendement par bien, cautions détenues | Vue patrimoine groupée par gestionnaire | Approbations (dépense, accord de caution), reversements, choix de l'organisation dans l'en-tête |
| **Locataire** | Solde, reçus, signalement | Gros chiffres, une seule action principale par écran | Signalement devenu demande suivie (reçue, planifiée, faite) | Bail, caution et décompte, préavis, historique de tous ses baux, toutes agences confondues (dès le lancement) |
| **Back-office** | — | — | Conçu d'abord pour ordinateur, très dense | Organisations, formules, abonnements, interrupteurs, journal, accès d'assistance |

**Trois composants à ajouter à `docs/UX.md` :**

- **Assistant pas à pas** (ajout de bien, création de bail, sortie) : une étape par écran sur téléphone ; étapes à gauche et formulaire à droite sur ordinateur ; brouillon enregistré à chaque étape.
- **Chronologie** (bail, unité, caution) : chaque événement daté, avec son auteur et sa pièce jointe. C'est la réponse visible à « tout doit être historisé ».
- **Circuit d'accord** : proposition, acceptation ou refus motivé, horodatage. Il sert pour les accords de caution, les dépenses à approuver et les contestations.

**Navigation multi-organisations** : une personne qui est à la fois propriétaire chez deux agences et locataire ailleurs choisit son espace dans le menu du compte. On ne mélange jamais deux organisations sur un même écran de gestion ; seule la vue patrimoine du propriétaire les rassemble, en lecture.

## E. Architecture fonctionnelle SaaS

L'isolement par agence décrit dans `CLAUDE.md` est solide et doit rester la règle. Il lui manque deux notions : une organisation qui n'est pas une agence, et une personne qui existe dans plusieurs organisations. Toutes deux s'ajoutent sans affaiblir l'isolement, à condition de les poser avant le lot 01.

### Les notions et leur portée

| Notion | Portée | Rôle |
| --- | --- | --- |
| **Organisation** | Unité d'isolement | Une agence, ou un bailleur particulier qui gère lui-même. Toute donnée de gestion lui appartient (colonne `organization_id` à la place de `agency_id`). |
| **Membre** | Organisation | Une personne avec un rôle : direction, gestionnaire, agent de terrain, comptable, lecture seule. |
| **Personne** | Plateforme | Le compte de connexion, vérifié par téléphone. Il ne contient aucune donnée de gestion. |
| **Fiche propriétaire, fiche locataire** | Organisation | Telle que l'organisation l'a saisie. Elle peut être **liée** à une personne, après vérification et accord de l'organisation. |
| **Mandat** | Organisation | Lien entre l'organisation, un propriétaire et un périmètre (biens ou unités). Un seul mandat de gestion actif par unité. |
| **Abonnement** | Organisation | Formule, période, quotas, factures de la plateforme. |
| **Interrupteur** | Plateforme | Déjà spécifié dans `docs/FEATURE-FLAGS.md`. |

**Pourquoi renommer `agency_id` en `organization_id`.** Le bailleur particulier deviendrait sinon une « agence » fictive, avec des écrans, des formules et des textes d'agence qui ne lui conviennent pas. Le changement ne coûte rien tant que le lot 01 n'a pas commencé ; il coûterait une migration de toutes les tables ensuite.

**Comment le propriétaire ou le locataire voit plusieurs organisations.** Pas par une exception aux règles d'isolement. Un service de lecture dédié (module `portals`) parcourt les liens vérifiés de la personne, puis lit dans chaque organisation, l'une après l'autre, avec son contexte d'isolement. Il ne lit que ce qui concerne cette personne, toujours en lecture seule, et chaque lecture est journalisée.

### Risques de permissions et de mélange de données

| Risque | Où il apparaît | Parade |
| --- | --- | --- |
| Une personne se lie à la fiche d'un homonyme | Liaison de compte | Code SMS envoyé au numéro de la fiche, **et** acceptation par l'organisation |
| Une agence découvre les biens confiés à une concurrente | Espace propriétaire | L'agrégation n'existe que côté personne ; aucun écran d'agence ne la montre |
| Un agent de terrain voit tout le portefeuille | Synchronisation | Périmètre d'affectation, déjà prévu au lot 07 |
| Un administrateur de la plateforme lit des données sans raison | Back-office | Rôle distinct, motif obligatoire, durée limitée, accès visible par l'organisation dans son journal |
| L'assistance se connecte « en tant que » un utilisateur | Back-office | Interdit ; l'assistance travaille avec ses propres droits, en lecture |
| Deux organisations gèrent la même unité | Mandats | Contrainte d'unicité sur le mandat de gestion actif |
| Un abonnement impayé bloque la saisie des loyers | Abonnements | Paliers : rappel, puis blocage des créations ; consultation, reçus et export toujours possibles ; aucune suppression |
| Un quota est dépassé en hors connexion | Synchronisation | Le quota bloque la création suivante, jamais une donnée déjà saisie |

### Abonnements et facturation

- **La règle « la plateforme ne détient jamais les fonds » vise les loyers.** Encaisser les abonnements des agences sur le compte marchand de la plateforme est normal ; il faut le préciser dans `CLAUDE.md` pour qu'aucun lot ne le refuse.
- **Au MVP**, abonnements saisis à la main par l'administrateur (formule, période, paiement reçu). La facturation automatique attend la porte 2, comme prévu.
- **Quotas par formule** : nombre d'unités gérées, de membres, de relevés. Ils sont vérifiés par le serveur.
- **Rôles de la plateforme** : administrateur général, assistance, commercial, finances. Chacun n'accède qu'à sa partie du back-office.

### Vos exemples d'interrupteurs

| Votre exemple | Ce que je propose | Pourquoi |
| --- | --- | --- |
| Paiement en ligne | `payments.direct` (déjà prévu) | Fonctionnalité vendable, à activer agence par agence |
| Paiement Mobile Money | Deux choses distinctes : la **saisie** d'un paiement Mobile Money (socle), et le **paiement initié** depuis la plateforme (`payments.direct`) | La saisie fait partie du registre |
| Paiements en espèces | **Réglage de l'agence** (moyens acceptés), pas un interrupteur | Les couper casserait le registre de la plupart des agences |
| Publicité WhatsApp | Partage par lien (socle, gratuit) ; envois en masse via l'API WhatsApp Business (`notifications.whatsapp_api`, P3) | Les envois publicitaires exigent le consentement préalable des destinataires |
| Publication Facebook | Partage avec aperçu soigné (socle) ; publication automatique sur une page (nouvelle clé, P3) | La publication automatique passe par une validation de Meta |
| Visites virtuelles | `media.virtual_tour_360` (déjà prévu) | Option, chargée à la demande |
| Gestion avancée | Contenu des formules, pas une clé unique | Une clé par fonctionnalité reste lisible et testable |

## F. Priorisation

La priorité 1 ajoute surtout la **sortie du locataire** et la **structure des données** ; avec les espaces propriétaire et locataire ouverts dès le lancement (votre décision du 08/11/2026), elle allonge la phase 1 d'environ trois à quatre semaines. Le reste peut attendre le pilote sans rien casser, à condition que le modèle soit posé dès maintenant.

### Priorité 1 : indispensable pour la première version

| Recommandation | Lot concerné |
| --- | --- |
| Organisation (agence ou bailleur particulier), `organization_id` | 01, 03 |
| Personne distincte des fiches, liaison vérifiée aux fiches propriétaire et locataire | 02, 03 |
| Back-office : organisations, interrupteurs, abonnements saisis à la main | 04 |
| Un seul mandat de gestion actif par unité ; propriétaire « groupe » avec représentant | 06 |
| Assistant d'ajout de bien ; terrain ; meublé en caractéristique ; point GPS | 07 |
| Statut en quatre dimensions, occupation calculée | 07, 08 |
| Compte de caution (versements, détenteur, avertissement au-delà de deux mois), avance distincte | 08 |
| Bail scanné ; bail généré en PDF si un juriste a validé le modèle | 08 |
| Préavis, état des lieux d'entrée et de sortie, décompte de sortie, remise en état, transfert de gestion | 10 bis (nouveau) |
| Dépenses : qui paie, qui supporte, comment c'est récupéré ; frais de gestion hors dépenses | 10 |
| Reversements aux propriétaires enregistrés | 10 |
| **Espaces propriétaire et locataire avec compte**, regroupant toutes les organisations : patrimoine, revenus, baux, cautions, reçus, signalements suivis | 10 ter (nouveau) |
| Demandes de location depuis l'annonce | 12 |

Ajouts du complément sur les contrats (P1) :

- Registre de documents et matrice de confidentialité (lot 07, étendu au lot 08 bis).
- Champs requis par les contrats : représentant légal, boîte postale et logo de l'organisation (lot 03) ; pièces détaillées, surface, usage et clôture de l'unité (lot 07) ; état civil et pièce détaillée du locataire, paramètres du bail (lot 08).
- Bailleur désigné et autorisation `can_sign_leases` (lots 06 et 08).
- Contrats (lot 08 bis, nouveau) : modèle Word de l'organisation rempli automatiquement, relecture, Word et PDF, versions, signature manuscrite et scan, légalisation et enregistrement suivis, avenants, alertes.
- « Mes contrats » pour le locataire et contrats pour le propriétaire (lot 10 ter).
- Import des contrats existants scannés (lot 11).

### Priorité 2 : à intégrer pendant le pilote

| Recommandation | Remarque |
| --- | --- |
| Contestation structurée du décompte | Au MVP : observations libres et pièces jointes |
| Visites (agenda) et candidatures simples | Avec effacement automatique des dossiers refusés |
| Interventions : signalement, réparateur, dépense | Relie l'espace locataire aux dépenses |
| Approbation des dépenses par le propriétaire au-delà d'un seuil | Seuil inscrit dans le mandat |
| Indivision : répartition par quote-part sur les relevés |  |
| Vidéos courtes | Compressées sur le téléphone avant envoi |
| Renouvellement et révision du loyer | Après lecture du décret d'application |

### Priorité 3 : évolutions futures

| Recommandation | Condition pour la lancer |
| --- | --- |
| Visite 360° (lien vers un service spécialisé) | Demande réelle des agences, contenu disponible |
| Acceptation du bail par code SMS | En complément de la légalisation |
| Publication Facebook et envois WhatsApp Business automatiques | Validation par Meta, consentement des destinataires |
| Mandats de vente non exclusifs et dédoublonnage des annonces | Ouverture de la rubrique Acheter à plusieurs agences |
| Carte interactive de la vitrine | Mesure du poids de la page |
| Paiement direct Mobile Money | Déjà au lot 14, après la porte 1 |

## G. Proposition de direction artistique

Je propose une identité à deux registres sur une seule base. La vitrine et les fiches adoptent un style **éditorial soigné**, où la photo domine. Les espaces de gestion restent **sobres et denses**, faits pour aller vite. Le « luxe » se limite aux annonces haut de gamme, et la 3D immersive est écartée.

### Ce que je retiens des trois approches

| Approche | À retenir | À écarter | Où |
| --- | --- | --- | --- |
| Premium Editorial | Grandes photos, titres en caractères à empattement, marges généreuses, mise en page de magazine pour la page d'accueil et les quartiers | Textes longs que personne ne lit sur téléphone | Vitrine, fiches, pages de quartier |
| Luxury | Variante de fiche « mise en avant » pour les villas et biens à forte valeur : photo plein écran, prix discret, appel à l'agence | Fond noir et doré partout : la plupart des annonces sont des chambres-salons à moins de 100 000 FCFA, et ce style exclurait ce public | Annonces mises en avant (`listings.featured`) |
| Immersive 3D | Visite 360° en option, ouverte par un bouton, chargée seulement à la demande | Scènes 3D, parallaxe, vidéo en lecture automatique : trop lourdes pour la data mobile et le budget de 100 Ko de JavaScript | Fiche annonce, P3 |

### Base commune

- **Couleurs** : conserver le vert foncé (argent, confiance) et le fond pierre clair de la maquette. Ajouter une seule couleur d'accent chaude, couleur latérite, réservée à la vitrine (repères, mises en avant). Elle donne une identité locale sans concurrencer le vert des actions.
- **Typographie** : une police à empattement pour les titres de la vitrine uniquement, hébergée sur la plateforme et limitée aux caractères latins. Partout ailleurs, la police sans empattement actuelle, avec des chiffres tabulaires pour les montants.
- **Photos** : format 3:2 partout, recadrage centré, chargement progressif. Une vraie photo de couverture compte plus que tout effet graphique.
- **Icônes** : Lucide seulement, en 16, 20 et 24 px, trait uniforme, toujours accompagnées d'un mot (déjà vérifié par un test).
- **Mouvements** : transitions courtes (moins de 200 ms), désactivées si l'appareil le demande. Aucune animation qui retarde une action.

### Par espace

| Espace | Registre | Particularités |
| --- | --- | --- |
| Vitrine et fiches | Éditorial | Accueil en sections (quartiers, nouveautés, villas mises en avant) ; fiche avec photo de couverture large, conditions claires, contact toujours visible |
| Agence | Utilitaire dense | Tableaux, chiffres alignés, couleurs réservées aux statuts ; aucune police d'affichage |
| Propriétaire | Utilitaire aéré | Grands chiffres (revenus, rendement), cartes par bien, logo de l'agence gestionnaire sur chaque bien |
| Locataire | Très simple | Un chiffre principal (ce que je dois), une action principale, vocabulaire de tous les jours |
| Back-office | Dense, ordinateur d'abord | Tableaux filtrables, journaux, couleur d'alerte distincte pour les actions qui touchent toutes les organisations |

Pour valider cette direction avant de l'appliquer, je propose deux écrans de référence (accueil de la vitrine et fiche d'une villa mise en avant), en version téléphone et ordinateur.

## H. Conclusion et plan d'action

**Mise à jour du 08/11/2026 : les décisions sont écrites dans le dépôt, le lot 01 peut démarrer dès la fusion.** Les lots 01 à 05 posent le socle technique et ne dépendent pas des écrans métier. Le complément de maquette et le test avec les pilotes se font donc en parallèle, et doivent être terminés avant le lot 06.

*Schéma (version texte) — feuille de route :* Préparer (maquette 00 ter, test des pilotes, en parallèle des lots 01 à 05) ; Socle (01 à 05) ; Registre (06, 07, 08, 08 bis contrats) ; Encaisser (09, 10, 11, 10 bis sortie, 10 ter espaces) ; Publier (12, 13, puis pilote). Décisions utilisées : D12 avant 01 ; D13 et D17 avant 02 ; D16 avant 06 ; D14 avant 07 ; D15 avant 08 ; D20 à D22 avant 07 et 08 bis.

Chaque décision doit être écrite avant le lot qui l'utilise : D12 conditionne le départ, les autres peuvent suivre au fil des lots.

### Les étapes

1. **Valider ou amender ce rapport.** Commentez directement les points sur lesquels vous n'êtes pas d'accord.
2. **Mettre à jour le dossier de référence** (une session Claude Code, sans code) :
   - `docs/DECISIONS.md` : D12 à D17.
   - `CLAUDE.md` : `organization_id`, notion de personne, module `portals` ; trois nouvelles règles non négociables (un seul mandat de gestion actif par unité ; aucune retenue de caution sans justificatif ; aucune information sur un locataire ou un propriétaire transmise d'une organisation à une autre) ; précision sur les abonnements.
   - `docs/UX.md` : nouveaux écrans et les trois composants de la section D.
   - `docs/FEATURE-FLAGS.md` : moyens de paiement en réglage d'agence, clé de publication Facebook.
   - `docs/LOTS.md` et les prompts concernés (tableau ci-dessous).
3. **Compléter la maquette (lot 00 ter, environ une semaine)** avec les écrans les plus risqués : assistant d'ajout de bien, fiche unité à quatre statuts, sortie guidée avec décompte, patrimoine d'un propriétaire présent dans deux agences, écrans principaux du back-office.
4. **Faire tester ces écrans aux trois agences pilotes**, en particulier la sortie : qui détient la caution, comment se fait l'état des lieux, quels accords sont courants.
5. **Lancer le lot 01**, puis suivre l'ordre des lots mis à jour.

### Effets sur les lots

| Lot | Changement |
| --- | --- |
| 01 Socle | `organization_id` dans les conventions, les tests et le schéma de départ |
| 02 Authentification | La personne devient le compte unique ; vérification par code SMS |
| 03 Organisations, rôles | Type agence ou bailleur, membres, rôles ; liaison des fiches à une personne préparée |
| 04 Back-office | Abonnements saisis à la main, rôles de la plateforme, accès d'assistance motivé, moyens de paiement en réglage |
| 06 Propriétaires, mandats | Propriétaire de type groupe ; unicité du mandat de gestion actif |
| 07 Biens | Assistant d'ajout, terrain, point GPS, statut en quatre dimensions |
| 08 Baux | Compte de caution, avance distincte ; l'unité n'est plus remise « libre » automatiquement |
| 10 bis (nouveau, après le lot 10) Sortie | Préavis, états des lieux, accords, décompte, contestation simple, remise en état, transfert de gestion |
| 09 Encaissements | Lien du reçu conservé ; l'espace locataire passe au lot 10 ter |
| 10 Impayés, relevés | Dépenses à trois questions, lien avec la caution, reversements ; l'espace propriétaire passe au lot 10 ter |
| 10 ter (nouveau) Espaces | Comptes propriétaire et locataire, liaison vérifiée, module `portals`, vues regroupant toutes les organisations |
| 12 Vitrine | Disponibilité calculée, demandes, direction éditoriale, variante « mise en avant » |
| 13 Production | Formalités auprès de l'ARCOD (nouvelle loi), tests d'accès du module `portals` |

Effets du complément sur les contrats : nouveau **lot 08 bis « Contrats et documents contractuels »**, entre les lots 08 et 09 (il a besoin du bail et du compte de caution). Le lot 06 ajoute `can_sign_leases`, le lot 07 crée le registre de documents, le lot 10 ter affiche les contrats dans les espaces personnels, le lot 11 importe les contrats existants, et le lot 00 ter maquette la création, la signature et « Mes contrats ».

Les lots 05, 09, 11, 13 et 14 ne changent pas sur le fond. Ils héritent seulement du renommage en `organization_id`.

## Questions ouvertes

Ces points ne se tranchent pas par la technique ; ils conditionnent les lots indiqués.

| Question | À qui la poser | Avant le lot |
| --- | --- | --- |
| Lecture des articles 3, 8, 9, 20, 26, 45 et 46 de la loi n° 103-2015/CNT : l'interprétation retenue ici est-elle juste ? | Juriste | 08 |
| Liste des réparations à la charge du locataire (décret prévu à l'article 25) | Juriste, ministère de l'Habitat | 10 bis |
| Avertir ou bloquer au-delà de deux mois de caution ? | Vous, après avis du juriste | 08 |
| Qui détient la caution en pratique : l'agence ou le propriétaire ? | Agences pilotes | 08 |
| Les pilotes légalisent-ils les baux à la mairie et les transmettent-ils aux impôts ? | Agences pilotes | 08 |
| Arrêté du 8 avril 2026 sur les démarcheurs : effet sur la commission demandée au locataire | Juriste | 08 |
| Nouvelle loi sur les données du 3 août 2026 : promulgation, démarches auprès de l'ARCOD, hébergement des données | Juriste | 02 et 13 |
| « Bailleur particulier » : le terme parle-t-il aux propriétaires qui gèrent eux-mêmes ? | Entretiens | 03 |

Questions ajoutées par le complément sur les contrats :

| Question | À qui la poser | Avant le lot |
| --- | --- | --- |
| Une agence peut-elle se désigner « bailleur » en son nom, et quelles obligations endosse-t-elle alors ? | Juriste | 08 |
| Reconduction tacite pour une durée égale : compatible avec la loi, qui prévoit le passage à durée indéterminée ? | Juriste | 08 |
| Intérêts de retard au profit de l'agence, préavis réduit à un mois, indemnité de départ anticipé : clauses valables ? | Juriste | 10 |
| Délai et coût de la légalisation et de l'enregistrement ; qui s'en charge en pratique | Juriste, agences pilotes | 08 bis |
| Une agence peut-elle signer au nom du propriétaire, et avec quel mandat ? | Juriste | 06 |
| Durée de conservation des copies de pièces d'identité après la fin du bail | Juriste | 07 |
| Modèle de base pour les organisations sans modèle | Juriste | P2 |
| Modèles des deux autres pilotes, pour vérifier que le catalogue de champs les couvre | Agences pilotes | 08 bis |
| FasoSign ou un prestataire agréé sont-ils accessibles aux entreprises privées et aux particuliers ? | ANSSI, ministère de la Transition digitale | Phase 3 |

## Sources

- [Loi n° 103-2015/CNT portant bail d'habitation privée au Burkina Faso](https://academiedepolice.bf/index.php/telechargement/category/28-urbanisme-et-construction?download=75:loi-portant-bail-d-habitation-privee-au-burkina-faso) (texte consulté le 08/11/2026)
- [Loi n° 001-2021/AN portant protection des personnes à l'égard du traitement des données à caractère personnel](https://assembleenationale.bf/storage/Loi/kDsWHXOTUCQFVESChh8BlBdiZnCrdTsOpXe1rzmH.pdf)
- [Adoption de la loi sur la protection des données et création de l'ARCOD, AllAfrica, 4 août 2026](https://fr.allafrica.com/stories/202608040299.html)
- Dépôt `Phataf/ziga` : maquette, `docs/LOTS.md`, `docs/DECISIONS.md`, `docs/FEATURE-FLAGS.md`, prompts des lots 06, 07, 08 et 10

Sources du complément sur les contrats :

- [Loi sur le bail locatif : bail écrit, légalisation à la commune et enregistrement, L'Économiste du Faso, 8 janvier 2016](https://www.leconomistedufaso.com/2016/01/08/loi-sur-le-bail-locatif-locataires-et-bailleurs-a-vos-marques)
- [Loi n° 045-2009/AN portant réglementation des services et des transactions électroniques](https://data.sante.gov.bf/legisante/uploads/Loi%20n%C2%B0045-2009%20AN%20portant%20r%C3%A8glementation%20des%20services%20et%20des%20transactions%20%C3%A9lectroniques%20au%20Burkina%20Faso.pdf)
- [Lancement de FasoSign, plateforme nationale de signature électronique, KOACI, 17 septembre 2026](https://www.koaci.com/article/2026/09/17/burkina-faso/politique/burkina-faso-cap-zero-papier-une-plateforme-nationale-de-signature-electronique-lancee_200617.html)
- [L'administration passe à la signature électronique, OSIRIS, 14 septembre 2026](https://www.osiris.sn/burkina-faso-l-administration-passe-a-la-signature-electronique.html)
