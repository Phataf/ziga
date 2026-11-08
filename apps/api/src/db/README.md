# Base de données : cloisonnement par organisation

Règle 1 de `CLAUDE.md` §5. Ce gabarit s'applique à **chaque table métier**, dans la migration qui la crée.

## Gabarit d'une table métier

```sql
CREATE TABLE leases (
	id uuid PRIMARY KEY,                                  -- UUIDv7 généré par le client
	organization_id uuid NOT NULL REFERENCES organizations (id),
	unit_id uuid NOT NULL,
	-- … colonnes métier …
	created_at timestamptz NOT NULL DEFAULT now(),
	-- Cible des clés composites des autres tables :
	UNIQUE (organization_id, id),
	-- Clé composite : un bail ne peut pointer que vers une unité de la même organisation.
	FOREIGN KEY (organization_id, unit_id) REFERENCES units (organization_id, id)
);
--> statement-breakpoint
-- RLS activée et forcée ; lecture et écriture limitées à organization_id = current_organization_id().
SELECT enable_organization_rls('leases');
--> statement-breakpoint
-- Ce que la table interdit (exemple : un paiement n'est jamais supprimé).
REVOKE DELETE, TRUNCATE ON leases FROM app_api, app_admin;
```

À ne pas oublier :

- `organization_id NOT NULL` sur chaque table métier ;
- `UNIQUE (organization_id, id)` sur toute table qu'une autre référence, et des clés étrangères **composites** `(organization_id, x_id)` : une clé simple `x_id` laisserait pointer vers une ligne d'une autre organisation ;
- `SELECT enable_organization_rls('table')` dans la même migration ;
- un test d'accès croisé : une organisation A tente de lire, de modifier et de référencer une ligne de B, par l'API et en SQL avec `app_api` (voir `test/organizations.int.test.ts`).

`enable_organization_rls` (migration `0002_organizations_audit`) exécute :

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON <t>
	USING (organization_id = current_organization_id())
	WITH CHECK (organization_id = current_organization_id());
```

Sans `app.organization_id`, `current_organization_id()` vaut `NULL` : aucune ligne n'est visible ni insérable.

## Deux contextes, jamais mélangés

| Contexte     | Ouvert par                                                                                      | Réglage                         | Sert à                                                           |
| ------------ | ----------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| Organisation | `withOrganization(db, organizationId, …)`, ou l'intercepteur des routes `@OrganizationScoped()` | `SET LOCAL app.organization_id` | Toutes les données d'une organisation                            |
| Personnel    | `withUser(db, userId, …)`                                                                       | `SET LOCAL app.user_id`         | Sessions, appartenances, événements de plateforme de la personne |

Chaque aide vide l'autre réglage : une transaction n'a jamais les deux. Les politiques personnelles exigent en plus `current_organization_id() IS NULL`, pour que la base le garantisse elle aussi.

Dans une route `@OrganizationScoped()`, la transaction est ouverte par l'intercepteur et lue par `RequestContext.tx()` : services et `AuditService.record()` écrivent dans la même transaction, qui réussit ou échoue d'un bloc.

## Journal d'audit

`audit_log` est en ajout seul : les triggers refusent `UPDATE`, `DELETE` et `TRUNCATE`, même au propriétaire de la table. Deux portées :

- `organization_id` renseigné : événement d'une organisation, visible dans son seul contexte (directeur) ;
- `organization_id` vide et `subject_user_id` renseigné : événement de plateforme (connexion, mot de passe, numéro…), visible par la personne concernée en contexte personnel, et par le back-office (`app_admin`).

## Migrations

- Une migration appliquée n'est jamais modifiée : on en ajoute une nouvelle (`CLAUDE.md` §6).
- Elles sont écrites à la main dans `migrations/`, avec leur entrée dans `migrations/meta/_journal.json`, et appliquées par `pnpm db:migrate` avec le rôle propriétaire du schéma.
- Les rôles `app_api` et `app_admin` n'ont pas `BYPASSRLS`.
