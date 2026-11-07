# Expérience utilisateur — profils et appareils

Ce document fait foi pour toute interface du projet (maquette et produit). `CLAUDE.md` §6 y renvoie. La maquette (`maquette/`) l'applique et sert de référence visuelle : couleurs, typographie et composants y sont déjà fixés.

**Principe** : on ne redimensionne pas l'écran du téléphone. Chaque profil a son espace, et chaque appareil a sa coque, ses composants et ses interactions. Les données et les règles métier, elles, sont les mêmes partout.

---

## 1. Principes

1. **Un profil, un espace.** Chacun ne voit que ce qui le concerne, avec le vocabulaire de son métier. Un locataire ne voit jamais un menu d'agence.
2. **L'action principale toujours à portée.** Sur téléphone, sous le pouce. Sur tablette, en tête du rail. Sur ordinateur, en tête du menu latéral et au clavier.
3. **Même donnée, forme adaptée.** Une liste de cartes sur téléphone devient un tableau sur ordinateur. Un bouton visible devient un menu d'actions. Une feuille du bas devient une boîte de dialogue ou un tiroir latéral.
4. **Rien d'inutile.** Pas de décoration, pas d'animation gratuite, pas d'émoji. Une hiérarchie claire : le chiffre ou l'action qui compte d'abord.
5. **Familier.** Les gestes des applications que les utilisateurs connaissent déjà : onglets en bas comme Orange Money et WhatsApp, partage natif, liens WhatsApp pré-remplis.

---

## 2. Profils et espaces

| Profil | Espace | Accès | Ce qu'il vient faire | Écran d'accueil | Données visibles |
| --- | --- | --- | --- | --- | --- |
| Directeur d'agence | Agence | Compte | Piloter : encaissements, retards, équipe, contrôle | Tableau de bord | Toute l'agence |
| Gestionnaire | Agence | Compte | Encaisser, relancer, publier, envoyer les relevés | Tableau de bord | Toute l'agence |
| Agent de terrain | Agence | Compte | Encaisser en espèces, visiter ses biens | « Ma tournée » | Ses biens affectés seulement |
| Bailleur particulier | Agence (formule Découverte) | Compte | Gérer lui-même quelques logements | Accueil « Mes logements » | Ses logements |
| Propriétaire | Propriétaire | Lien sans compte (compte plus tard) | Suivre ses revenus et ses biens | « Mes revenus » | Ses biens, ses relevés ; pas les coordonnées des locataires |
| Locataire | Locataire | Lien sans compte | Connaître son solde, retrouver ses reçus, joindre l'agence | « Mon logement » | Son bail, ses échéances, ses reçus |
| Visiteur ou acheteur | Vitrine publique | Aucun | Trouver un logement à louer ou un bien à acheter | Recherche | Annonces publiées |
| Administrateur plateforme | Back-office | Compte plateforme | Agences, formules, interrupteurs | Liste des agences | Selon `docs/FEATURE-FLAGS.md` |

**Navigation par profil**

| Profil | Onglets du téléphone (4 au plus) | Menu latéral de l'ordinateur |
| --- | --- | --- |
| Directeur | Accueil, Biens, Encaissements, Plus | Pilotage, Gestion (biens, encaissements, impayés, propriétaires), Contrôle (à valider), Agence (équipe) |
| Gestionnaire | Accueil, Biens, Encaissements, Plus | Même chose, sans l'équipe |
| Agent de terrain | Tournée, Biens, Encaissements, Plus | Terrain : tournée, mes biens, mes encaissements, retards |
| Bailleur particulier | Accueil, Logements, Loyers, Plus | Mes logements |
| Propriétaire | Revenus, Biens, Relevés | Mon patrimoine |
| Locataire | Logement, Reçus, Contact | Mon espace |
| Visiteur ou acheteur | Pas d'onglets : en-tête de site avec Louer et Acheter | Même en-tête, filtres à gauche |

**Ce que chaque profil peut faire** : la matrice de permissions (`packages/shared/permissions.ts`) et les interrupteurs (`docs/FEATURE-FLAGS.md`) décident. L'interface masque ce qui est interdit, et le serveur le refuse quand même. Une fonctionnalité coupée s'affiche désactivée avec une explication quand l'utilisateur s'y attend (par exemple « Payer par Mobile Money », bientôt disponible), sinon elle disparaît.

---

## 3. Appareils

| | Téléphone | Tablette | Ordinateur |
| --- | --- | --- | --- |
| Largeur | < 768 px | 768 à 1279 px | ≥ 1280 px |
| Préfixe Tailwind | (aucun) | `md:` ; `lg:` dès 1024 px | `xl:` |
| Coque | Contenu + barre d'onglets en bas | Rail de navigation à gauche (112 px) | Menu latéral (256 px) + barre du haut |
| Action principale | Gros bouton plein écran, sous le pouce | Bouton en tête du rail | Bouton en tête du menu, raccourcis clavier |
| Recherche | Champ en haut de la liste | Champ en haut de la liste | Recherche globale (Ctrl+K ou ⌘K) dans la barre du haut |
| Listes | Cartes, une colonne | Cartes en grille ou tableau simplifié | Tableaux avec tri, sélection multiple, menu d'actions |
| Détail | Page séparée, bouton retour | Page pleine largeur ; liste et détail côte à côte dès 1024 px (paysage) | Liste et détail côte à côte, fil d'Ariane |
| Panneaux | Feuille qui monte du bas | Boîte de dialogue centrée | Boîte de dialogue ou tiroir latéral droit |
| Interaction | Toucher, partage natif | Toucher, parfois clavier | Souris et clavier : survol, focus visible, Échap, flèches |
| Densité | Faible, cibles ≥ 44 px | Moyenne | Plus élevée, mais texte de contenu toujours ≥ 16 px |

Conteneurs : `page` (32 rem sur téléphone, pleine largeur sur tablette, 80 rem au plus sur ordinateur) ; `page-narrow` pour les formulaires et les documents (48 rem au plus).

**Règle d'implémentation** : une forme différente selon l'appareil s'affiche avec `{#if device.kind === …}` (store `device`), pas en masquant l'autre version en CSS. Un seul arbre dans la page : plus léger, et lisible par les lecteurs d'écran et les tests. Le CSS responsive (`md:`, `xl:`) sert aux ajustements de mise en page, pas à doubler un composant.

---

## 4. Transformations de composants

| Élément | Téléphone | Tablette | Ordinateur |
| --- | --- | --- | --- |
| Navigation | Onglets en bas + « Plus » | Rail à gauche | Menu latéral par sections |
| Tableau de bord | Carte des loyers, bouton Encaisser, carte des impayés, échéances du jour | 3 indicateurs côte à côte, échéances en tableau | 4 indicateurs, échéances en tableau, panneau des plus anciens retards |
| Encaisser | Liste, puis formulaire, bouton Valider fixé au-dessus des onglets | Liste puis formulaire pleine largeur ; côte à côte en paysage | Liste et formulaire côte à côte ; on tape un nom puis Entrée |
| Encaissements | Liste compacte, filtres en pastilles | Tableau | Tableau, sélection multiple, « Valider la sélection », menu par ligne |
| Impayés | Une carte par locataire, deux boutons (Relancer, Encaisser) | Tableau | Tableau, sélection multiple, « Relancer la sélection » (tiroir de relances en série), menu par ligne (Encaisser, Appeler) |
| Biens | Liste de cartes | Liste ; synthèse du parc à droite en paysage | Liste à gauche, synthèse ou fiche à droite |
| Unités d'un bien | Cartes avec boutons | Cartes en deux colonnes | Tableau avec bouton principal et menu d'actions |
| Publication | Feuille du bas | Boîte de dialogue | Boîte de dialogue |
| Reçu, relevé | Document, puis boutons en dessous | Document et panneau d'actions à droite | Idem, panneau collant |
| Choix du mois (relevés) | Pastilles qui défilent | Liste des mois à gauche | Liste des mois avec le net de chaque mois |
| Vitrine | Liste, bouton « Filtres » (feuille) | Grille de 2, bouton « Filtres » | Filtres toujours visibles à gauche, grille de 3 |
| Annonce | Carrousel, barre WhatsApp et Appeler fixée en bas | Mosaïque de photos, carte de contact collante | Idem |
| Profil (démo) | Bandeau en haut | Pastille en bas du rail | Carte en bas du menu latéral |

---

## 5. Règles d'interface

- **Hiérarchie** : un seul titre de page (h1) ; le chiffre clé en grand (3xl) ; le libellé au-dessus, en texte secondaire.
- **Texte** : 16 px minimum pour le contenu. 14 px admis seulement pour des libellés secondaires de navigation (rail, titres de sections du menu, raccourcis clavier).
- **Cibles tactiles** : 44 px minimum ; 56 px pour les entrées du rail.
- **Couleurs** : vert (`primary`) pour l'argent encaissé et les actions principales ; rouge pour les retards et les montants dus ; ambre pour « à rapprocher » ; bleu pour « à valider » et l'information. Jamais la couleur seule : toujours un mot ou un pictogramme avec.
- **Formats** : `75 000 FCFA` (espace fine insécable), `+226 70 12 34 56`, `jj/mm/aaaa`, chiffres tabulaires dans les colonnes de montants.
- **États** : chaque liste a son état vide rédigé (« Aucun impayé. »). Sur l'application hors ligne, une action s'affiche tout de suite avec « en attente d'envoi ».
- **Formulaires** : une question par bloc, réponses en grosses options plutôt qu'en listes déroulantes sur téléphone ; clavier numérique pour les montants ; bouton de validation qui répète l'effet (« Valider 85 000 FCFA »).
- **Performance** : écran de l'application ouvert en moins de 100 ms (lecture locale) ; page de vitrine en moins de 2,5 s en 3G ; JavaScript d'une page de vitrine < 100 Ko compressés.

---

## 6. Icônes

- **Une seule bibliothèque : Lucide** (`@lucide/svelte`). Même trait (2), mêmes proportions, coins arrondis.
- **Tailles** : 16 px dans le texte et les pastilles, 18 à 20 px dans les menus et les boutons, 24 px dans les boutons principaux et la barre d'onglets.
- **Toujours accompagnées d'un mot**, sauf un bouton icône seul qui porte un `aria-label` (fermer, menu d'actions).
- **Décoratives pour les lecteurs d'écran** : `aria-hidden="true"` quand le mot est à côté.
- **Aucune émoji**, ni comme icône ni comme décoration. Un test (`maquette/src/lib/no-emoji.test.ts`) refuse toute émoji et toute autre bibliothèque d'icônes ; le produit reprend ce test.
- Un pictogramme qui manque dans Lucide se dessine en SVG au même trait, dans `lib/icons/`.

---

## 7. Accessibilité et clavier

- Focus toujours visible (contour de 3 px), ordre de tabulation logique.
- Panneaux modaux : focus piégé dans le panneau, Échap ferme, le focus revient au bouton d'origine.
- Menus d'actions : flèche bas ouvre, flèches haut et bas parcourent, Entrée choisit, Échap ferme.
- Recherche globale : Ctrl+K ou ⌘K, flèches, Entrée, Échap.
- Tableaux : en-têtes `th`, cases à cocher nommées (« Sélectionner Fatimata Sana »), action principale visible sur la ligne.
- Contraste conforme au niveau AA pour tout texte.

---

## 8. Tests attendus pour chaque écran

- Un test Playwright par parcours **sur les trois appareils** : 360 × 800, 820 × 1180 (et 1180 × 820 quand la vue liste-détail apparaît), 1440 × 900.
- Un test qui vérifie l'absence de débordement horizontal sur téléphone.
- Pour chaque profil concerné : ce qu'il voit et ce qu'il ne voit pas (navigation, données, actions).
- Le test anti-émoji.

La maquette contient ces tests (`maquette/e2e/08-multiplateforme.spec.ts`), à reprendre dans le produit.
