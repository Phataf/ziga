# Spécification — Interrupteurs de fonctionnalités

**Besoin exprimé par le porteur** : « le paiement direct, les annonces, etc. doivent être gérables par l'administrateur de la plateforme : désactivés pour une tierce personne ou pour tout le monde, et vice versa. »

Ce document fait foi pour le lot 04 et pour tout lot qui ajoute une fonctionnalité optionnelle.

---

## 1. Ce que l'administrateur peut faire

Pour **chaque fonctionnalité** du catalogue, depuis le back-office :

| Action | Effet |
| --- | --- |
| **Couper pour tout le monde** (arrêt d'urgence) | Personne n'y a accès, aucune exception ne s'applique. |
| **Ouvrir à tout le monde** | Tout le monde y a accès, sauf les exceptions « forcer à non ». |
| **Ouvrir seulement à une liste** (accès restreint) | Personne n'y a accès, sauf les exceptions « forcer à oui ». C'est le mode « bêta » ou « vice versa ». |
| **Exception pour une organisation** | Forcer à oui ou à non pour cette organisation, agence ou bailleur particulier (tous ses membres). |
| **Exception pour une personne** | Forcer à oui ou à non pour un utilisateur précis, quelle que soit son organisation. |
| **Inclure ou exclure d'une formule** | La fonctionnalité fait partie, ou non, de la formule Découverte, Essentiel ou Pro. |

Chaque exception porte un **motif obligatoire** et une **date de fin facultative** (après laquelle elle disparaît d'elle-même).

Le **directeur d'une organisation** (ou le bailleur particulier) peut seulement **désactiver** pour son organisation une fonctionnalité qui lui est ouverte (par exemple ne pas publier sur la vitrine). Il ne peut jamais activer ce que la plateforme ne lui ouvre pas.

---

## 2. États globaux d'une fonctionnalité

| État (`global_mode`) | Libellé dans le back-office | Défaut sans exception |
| --- | --- | --- |
| `disabled` | Coupée pour tous | Non, et les exceptions sont ignorées |
| `restricted` | Ouverte sur liste | Non |
| `enabled` | Ouverte à tous | Oui (sous réserve de la formule) |

---

## 3. Règle de résolution (une seule fonction)

`isEnabled(key, { userId, organizationId, now })` renvoie `true` ou `false`, dans cet ordre strict :

1. Si `global_mode = disabled` → **non**. Fin.
2. S'il existe une exception **utilisateur** active pour (`key`, `userId`) → sa valeur. Fin.
3. S'il existe une exception **organisation** active pour (`key`, `organizationId`) → sa valeur. Fin.
4. Si `global_mode = restricted` → **non**. Fin.
5. Si la fonctionnalité est **liée aux formules** et que la formule de l'organisation ne l'inclut pas → **non**. Fin.
6. Si le **directeur de l'organisation** l'a désactivée pour son organisation → **non**. Fin.
7. Sinon → **oui**.

Puis, **séparément**, la permission du rôle est vérifiée (`can(user, action)`). Accès réel = `isEnabled(...) && can(...)`.

Remarques :
- Une exception de l'administrateur « forcer à oui » l'emporte sur la formule (cas d'un geste commercial). Elle ne l'emporte pas sur l'arrêt d'urgence.
- Une exception expirée (`ends_at < now`) est ignorée.
- Pour une action sans organisation (visiteur de la vitrine, espace personnel d'un propriétaire ou d'un locataire), seuls les points 1, 2, 4 et 7 s'appliquent, et l'interrupteur de l'organisation **propriétaire de l'annonce** (ou de chaque organisation lue par l'espace personnel) s'applique à l'affichage de ses annonces.
- Dépendances : certaines clés en exigent d'autres (`payments.direct` exige `payments.registry`). Si la clé requise est désactivée, la clé dépendante l'est aussi. Le back-office l'affiche.

---

## 4. Catalogue initial des fonctionnalités

| Clé | Description | Liée aux formules | Mode global au lancement |
| --- | --- | --- | --- |
| `payments.registry` | Saisie des encaissements et reçus | Non (socle) | `enabled` |
| `payments.direct` | Paiement Mobile Money initié depuis la plateforme vers le compte de l'agence (lot 14) | Oui (Pro, option Essentiel) | `disabled` |
| `listings.publication` | Publier des annonces sur la vitrine | Non | `enabled` |
| `listings.featured` | Mise en avant d'annonces | Oui (Pro) | `disabled` |
| `listings.public_showcase` | Vitrine publique accessible (arrêt d'urgence de toute la vitrine) | Non | `enabled` |
| `leads.contact_form` | Formulaire de contact sur les annonces | Non | `enabled` |
| `collections.reminders_whatsapp_link` | Relances par lien WhatsApp pré-rempli | Non | `enabled` |
| `collections.owner_statements` | Relevés propriétaires | Oui (quota Découverte) | `enabled` |
| `field_agents` | Rôle agent de terrain et validation des espèces | Oui (Essentiel, Pro) | `enabled` |
| `imports.excel` | Import Excel | Non | `enabled` |
| `exports.csv` | Exports CSV | Oui (Essentiel, Pro) | `enabled` |
| `notifications.whatsapp_api` | Messages via l'API WhatsApp Business (phase 4) | Oui | `disabled` |
| `listings.private_sellers` | Publication par les particuliers (phase 4) | Non | `disabled` |
| `media.virtual_tour_360` | Visites 360° (phase 4) | Oui | `disabled` |
| `portals.owner_space` | Espace propriétaire avec compte, regroupant toutes les organisations (D13, lot 10 ter) | Non | `enabled` |
| `portals.tenant_space` | Espace locataire avec compte, regroupant tout son historique (D13, lot 10 ter) | Non | `enabled` |
| `listings.facebook_publish` | Publication automatique des annonces sur une page Facebook (après validation par Meta) | Oui | `disabled` |

**Ce qui n'est pas un interrupteur (D18)** : les moyens de paiement acceptés (espèces, Mobile Money saisi avec sa référence, virement) font partie du registre. Chaque organisation choisit dans ses réglages ceux qu'elle accepte, au moins un restant actif. La plateforme ne les vend pas et ne les coupe pas. Seul le paiement initié depuis la plateforme (`payments.direct`) est une fonctionnalité optionnelle.

Ajouter une fonctionnalité = ajouter sa clé ici **et** dans `packages/shared/features.ts`, avec sa description, ses dépendances et son mode par défaut, puis une migration qui l'insère.

---

## 5. Modèle de données

- `features` : `key` (PK), `description`, `global_mode`, `plan_bound` (booléen), `requires` (liste de clés), `updated_at`, `updated_by`.
- `plan_features` : `plan_id`, `feature_key`, `quota` (facultatif, ex. 2 relevés par mois).
- `feature_overrides` : `id`, `feature_key`, `scope` (`organization` | `user`), `organization_id` ou `user_id`, `value` (booléen), `reason` (obligatoire), `starts_at`, `ends_at` (facultatif), `created_by`, `created_at`, `revoked_at`, `revoked_by`. Contrainte : une seule exception active par (clé, portée, cible).
- `organization_feature_settings` : `organization_id`, `feature_key`, `disabled_by_organization` (booléen), `updated_by`. L'organisation ne peut que désactiver.

Ces tables ne sont **pas** sous RLS d'organisation (sauf `organization_feature_settings`). Elles ne sont modifiables que par les rôles de la plateforme. Chaque modification écrit dans `audit_log`.

---

## 6. Propagation et application

- **Côté serveur** : un guard NestJS `@RequiresFeature('payments.direct')` sur chaque endpoint concerné. La résolution est mise en cache dans Redis ; toute modification invalide le cache (publication Redis). **Délai de propagation maximal : 30 secondes.**
- **Côté application (hors ligne)** : la liste des fonctionnalités actives de l'utilisateur est synchronisée par PowerSync. L'interface masque ce qui est désactivé. Si une action faite hors ligne arrive au serveur alors que la fonctionnalité a été coupée entre-temps, le serveur **la refuse** et l'application affiche le motif.
- **Côté vitrine** : si `listings.publication` est coupée pour une organisation, ses annonces disparaissent de la vitrine (statut interne inchangé) et le cache CDN de ses pages est purgé. Elles réapparaissent si l'interrupteur est rouvert.
- **Paiements en cours** : couper `payments.direct` bloque les nouvelles initiations. Les paiements déjà initiés continuent d'être confirmés ou rejetés par les notifications du prestataire.

---

## 7. Écrans du back-office

1. **Liste des fonctionnalités** : clé, description, mode global (sélecteur à 3 positions), nombre d'exceptions actives, dernière modification. Couper une fonctionnalité utilisée demande une confirmation qui affiche le nombre d'organisations touchées.
2. **Fiche d'une fonctionnalité** : formules qui l'incluent, liste des exceptions (portée, cible, valeur, motif, échéance), ajout et révocation d'une exception.
3. **Fiche d'une organisation** et **fiche d'un utilisateur** : onglet « Fonctionnalités » qui affiche l'état effectif de chaque clé **et la raison** (ex. « Non — formule Découverte » ou « Oui — exception jusqu'au 31/03/2027 »).
4. **Simulateur** : choisir une organisation et un utilisateur, voir l'état effectif de toutes les clés et l'étape de résolution qui a décidé.

---

## 8. Tests obligatoires (lot 04)

- Les 7 étapes de résolution, chacune isolée, plus les combinaisons : arrêt d'urgence + exception oui → non ; restreint + exception organisation oui → oui ; ouvert + exception utilisateur non → non pour lui, oui pour ses collègues ; exception expirée ignorée ; formule sans la clé + exception organisation oui → oui.
- Dépendances : `payments.direct` ouverte mais `payments.registry` coupée → non.
- Un directeur ne peut pas activer une clé fermée par la plateforme.
- Endpoint protégé appelé avec la fonctionnalité coupée → refus `403` avec code `FEATURE_DISABLED`.
- Modification d'un interrupteur → ligne d'audit avec avant et après.
- Propagation : après modification, le résultat change en moins de 30 secondes (test d'intégration avec Redis).
