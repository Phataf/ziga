# Dossier de démarrage Claude Code — Plateforme immobilière Burkina Faso

Ce dossier transforme le cadrage en instructions exécutables par Claude Code, lot par lot.

## Contenu

| Fichier | Rôle |
| --- | --- |
| `CLAUDE.md` | Référence permanente : pile, architecture, règles métier non négociables, règles de code, définition de « terminé ». Claude Code le lit automatiquement à la racine du dépôt. |
| `docs/CADRAGE.md` | Le cadrage complet, en contexte. Claude Code le consulte en cas de doute mais ne le code pas directement. |
| `docs/DECISIONS.md` | Décisions prises (D01 à D08) et questions ouvertes, avec le lot avant lequel les trancher. |
| `docs/FEATURE-FLAGS.md` | Spécification des interrupteurs : couper ou ouvrir chaque fonctionnalité pour tous, pour une agence ou pour une personne. |
| `docs/LOTS.md` | Ordre des 15 lots, dépendances, portes de décision. |
| `docs/JOURNAL-LOTS.md` | Journal tenu par Claude Code à la fin de chaque lot. |
| `prompts/lot-XX-*.md` | Un prompt par lot : contexte, périmètre, hors périmètre, tests attendus, critères d'acceptation. |

## Mode d'emploi

1. **Lot 00 (phase 0)** : crée un dossier à part, par exemple `maquettes/`, copie-y `CLAUDE.md` et `prompts/lot-00-maquettes.md`, puis lance Claude Code. Les maquettes sont jetables et servent aux entretiens avec les agences.
2. **Après la porte 0** : crée le dépôt du produit, copie tout ce dossier à sa racine, puis pour chaque lot :
   - lance Claude Code à la racine du dépôt ;
   - donne-lui ce message : « Lis CLAUDE.md, docs/DECISIONS.md, docs/LOTS.md et docs/JOURNAL-LOTS.md, puis exécute prompts/lot-01-socle.md. Commence par me présenter ton plan. » (en changeant le numéro du lot) ;
   - relis et valide le plan avant qu'il code ;
   - à la fin, vérifie toi-même les critères d'acceptation et relis l'entrée du journal ;
   - fais un commit de fin de lot, puis passe au suivant.
3. **Avant les lots 08, 09, 13 et 14**, réponds aux questions ouvertes de `docs/DECISIONS.md` et ajoute ta réponse dans ce fichier.

## Points de vigilance

- Relis toujours le code des lots 03 (cloisonnement), 05 (synchronisation), 09 (encaissements) et 14 (paiement direct) : une erreur y touche l'argent ou les données de vos clients.
- Si Claude Code propose d'élargir un lot, refuse et note l'idée pour plus tard dans le journal.
- Toute nouvelle fonctionnalité optionnelle doit avoir sa clé d'interrupteur dès sa création (`docs/FEATURE-FLAGS.md` §4).
