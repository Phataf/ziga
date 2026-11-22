/**
 * Liens entre une fiche d'organisation et le compte d'une personne (lot 10 ter, module organizations). La migration SQL
 * (0022) fait foi : RLS, clés composites, transitions et numéros vérifiés par déclencheur, révocation à un changement de
 * numéro. Lu et écrit par le seul module organizations (règle ESLint d'import, CLAUDE.md §4) ; pas exporté par l'index
 * du schéma. Le module portals ne lit que les identifiants de ses propres liens, par my_person_links().
 */
import type { PersonLinkOrigin, PersonLinkRecordType, PersonLinkRevoker, PersonLinkStatus } from '@ziga/shared/person-links';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const personLinks = pgTable('person_links', {
	id: uuid('id').primaryKey(),
	organizationId: uuid('organization_id').notNull(),
	userId: uuid('user_id').notNull(),
	recordType: text('record_type').$type<PersonLinkRecordType>().notNull(),
	ownerId: uuid('owner_id'),
	tenantId: uuid('tenant_id'),
	status: text('status').$type<PersonLinkStatus>().notNull(),
	origin: text('origin').$type<PersonLinkOrigin>().notNull(),
	phone: text('phone').notNull(),
	phoneVerifiedAt: tstz('phone_verified_at'),
	requestedBy: uuid('requested_by').notNull(),
	acceptedBy: uuid('accepted_by'),
	acceptedAt: tstz('accepted_at'),
	revokedBy: uuid('revoked_by'),
	revokedByParty: text('revoked_by_party').$type<PersonLinkRevoker>(),
	revokedAt: tstz('revoked_at'),
	revocationReason: text('revocation_reason'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});
