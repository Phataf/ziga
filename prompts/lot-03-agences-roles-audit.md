# Lot 03 — Agences, rôles, cloisonnement et journal d'audit

## Contexte
C'est le lot le plus important pour la sécurité. Il crée l'agence comme frontière de cloisonnement, les rôles et leurs permissions, et le journal d'audit que tous les lots suivants utiliseront. Les règles 1 et 4 de `CLAUDE.md` §5 doivent être démontrées par des tests.

## Prérequis
Lot 02 terminé.

## Périmètre
1. **Tables** (module `agencies`) :
   - `agencies` : id, raison sociale, nom commercial, téléphone, adresse, commune, RCCM, IFU, statut de vérification (`pending`, `verified`, `suspended`), formule (`plan_id`, la table des formules arrive au lot 04 : prévoir la colonne nullable), dates.
   - `agency_members` : `agency_id`, `user_id`, rôle, statut (`invited`, `active`, `removed`), invité par, dates. Un utilisateur peut appartenir à plusieurs agences.
   - `agency_invitations` : téléphone invité, rôle, jeton haché, expiration.
2. **Rôles d'agence** et **matrice de permissions** dans `packages/shared/permissions.ts` (source unique, utilisée par l'API et l'interface) :

   | Rôle | Clé | Résumé |
   | --- | --- | --- |
   | Directeur | `director` | Tout dans l'agence : collaborateurs, exports, annulation de reçu, réglages |
   | Gestionnaire | `manager` | Biens, baux, encaissements, relances, publication ; ni annulation de reçu validé, ni export, ni collaborateurs |
   | Agent de terrain | `field_agent` | Prospects, visites, photos, saisie d'espèces « à valider » sur les biens qui lui sont affectés |
   | Lecture et comptabilité | `viewer` | Lecture de tout ; exports si la fonctionnalité `exports.csv` est active |

   Les actions sont nommées (`lease.create`, `payment.cancel`, `member.invite`…). Les lots suivants complètent la matrice.
3. **Cloisonnement** :
   - Politiques RLS sur `agencies` (lecture de sa propre agence) et `agency_members`.
   - Modèle de politique réutilisable (fonction SQL ou gabarit de migration) que chaque table métier future appliquera : `agency_id = current_agency_id()`.
   - Guard NestJS `AgencyContext` : lit l'agence active (en-tête `X-Agency-Id`), vérifie que l'utilisateur en est membre actif, ouvre `withAgency`. Guard `@Can('action')` pour les permissions.
   - Clés étrangères composites `(agency_id, id)` : documente le gabarit dans `apps/api/src/db/README.md`.
4. **Journal d'audit** (module `audit`) :
   - Table `audit_log` : id, date, acteur (utilisateur ou système), rôle de l'acteur, `agency_id` nullable, action, type et id de l'objet, `before` et `after` (JSON), origine (`app`, `api`, `admin`, `sync`, `job`), adresse IP, identifiant de requête.
   - Trigger qui interdit `UPDATE` et `DELETE` sur `audit_log`.
   - Service `audit.record(...)` appelé dans la même transaction que l'écriture métier.
   - Lecture du journal par le directeur de l'agence (filtré par RLS) et par le back-office.
5. **Parcours** : création d'une agence par un utilisateur connecté (il en devient directeur, statut `pending`) ; invitation d'un collaborateur par téléphone (lien d'invitation à envoyer par WhatsApp) ; acceptation ; changement de rôle ; retrait d'un membre (ses sessions sur cette agence sont coupées) ; sélecteur d'agence si l'utilisateur en a plusieurs.
6. **Données de démonstration** `pnpm db:seed` : deux agences A et B avec un membre de chaque rôle.

## Hors périmètre
Vérification de l'agence par le back-office (lot 04), formules et interrupteurs (lot 04), affectation de biens aux agents (lot 07).

## Tests attendus
- **Accès croisé** : un membre de A ne peut pas lire, modifier ni référencer l'agence B ni ses membres, ni par l'API, ni par SQL direct avec le rôle `app_api` et `app.agency_id` de A.
- Sans `app.agency_id`, une requête sur une table cloisonnée ne renvoie rien.
- Chaque action de la matrice : autorisée pour les bons rôles, refusée (`403`, code `FORBIDDEN_ACTION`) pour les autres.
- Un membre retiré perd l'accès immédiatement.
- Un utilisateur de deux agences ne voit que l'agence active.
- `audit_log` : `UPDATE` et `DELETE` refusés ; chaque action du lot écrit sa ligne avec `before` et `after` ; l'écriture d'audit et l'écriture métier réussissent ou échouent ensemble.
- Invitation expirée ou déjà utilisée refusée.

## Critères d'acceptation
- [ ] Les tests d'accès croisé couvrent chaque table du lot et passent.
- [ ] La matrice de permissions est une source unique, partagée par l'API et l'interface.
- [ ] Le gabarit RLS + clé composite est documenté et prêt à réutiliser.
- [ ] Un directeur invite un gestionnaire, qui accepte depuis un autre téléphone, en moins de 2 minutes.
- [ ] Journal des lots mis à jour.

## Instructions de travail
Présente d'abord les migrations SQL (tables, politiques RLS, trigger d'audit) et la matrice de permissions. Attends la validation avant d'écrire les services.
