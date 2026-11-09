/**
 * Données de démonstration (lot 03, CLAUDE.md §10) : deux agences A et B avec un membre de chaque rôle,
 * et une organisation de bailleur particulier dont la directrice est aussi gestionnaire de A (elle ne voit
 * jamais les deux à la fois). Rejouable : ce qui existe déjà est laissé tel quel.
 * Écrit avec le rôle app_api, dans le contexte de chaque organisation : la RLS s'applique au seed aussi.
 */
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import type { OrganizationRole, OrganizationType } from '@ziga/shared/permissions';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../modules/identity/passwords.js';
import { withOrganization, type Database } from './database.js';
import { users } from './schema/identity.js';
import { auditLog, organizationMembers, organizations } from './schema/organizations.js';
import { subscriptions } from './schema/platform.js';

export interface DemoPerson {
	key: string;
	phone: string;
	name: string;
	platformRole?: 'support' | 'sales' | 'finance';
}

export interface DemoOrganization {
	id: string;
	type: OrganizationType;
	legalName: string;
	tradeName: string | null;
	phone: string;
	commune: string;
	members: { person: string; role: OrganizationRole }[];
	plan: 'discovery' | 'essential' | 'pro';
	/** Abonnement de démonstration : payé et en cours, ou échu (délai de grâce). */
	subscription?: 'paid' | 'expired';
}

/** Personnes de démonstration (numéros fictifs +226 70 0x xx xx). */
export const DEMO_PEOPLE: DemoPerson[] = [
	{ key: 'a.director', phone: '+22670010001', name: 'Awa Ouédraogo' },
	{ key: 'a.manager', phone: '+22670010002', name: 'Mariam Zongo' },
	{ key: 'a.field_agent', phone: '+22670010003', name: 'Issa Kaboré' },
	{ key: 'a.viewer', phone: '+22670010004', name: 'Salif Traoré' },
	{ key: 'b.director', phone: '+22670020001', name: 'Fatimata Sawadogo' },
	{ key: 'b.manager', phone: '+22670020002', name: 'Boukary Compaoré' },
	{ key: 'b.field_agent', phone: '+22670020003', name: 'Adama Ilboudo' },
	{ key: 'b.viewer', phone: '+22670020004', name: 'Rasmata Kinda' },
	{ key: 'person', phone: '+22670090001', name: 'Moussa Nikiéma' },
	// Équipe de la plateforme (lot 04) ; le super administrateur, lui, se crée par la ligne de commande seulement.
	{ key: 'platform.support', phone: '+22670030001', name: 'Aïcha Sanogo', platformRole: 'support' },
	{ key: 'platform.sales', phone: '+22670030002', name: 'Yacouba Ouattara', platformRole: 'sales' },
	{ key: 'platform.finance', phone: '+22670030003', name: 'Delphine Somé', platformRole: 'finance' }
];

export const DEMO_ORGANIZATIONS: DemoOrganization[] = [
	{
		id: '01a1bc9c-acb6-72bf-a37c-2c1ab454e4f3',
		type: 'agency',
		legalName: 'Faso Immobilier SARL',
		tradeName: 'Faso Immobilier',
		phone: '+22625300101',
		commune: 'Ouagadougou',
		plan: 'pro',
		subscription: 'paid',
		members: [
			{ person: 'a.director', role: 'director' },
			{ person: 'a.manager', role: 'manager' },
			{ person: 'a.field_agent', role: 'field_agent' },
			{ person: 'a.viewer', role: 'viewer' }
		]
	},
	{
		id: '01a1bc9c-acb8-76a8-9e80-6b616c469cc5',
		type: 'agency',
		legalName: 'Sahel Habitat SA',
		tradeName: 'Sahel Habitat',
		phone: '+22625300202',
		commune: 'Ouagadougou',
		plan: 'essential',
		subscription: 'expired',
		members: [
			{ person: 'b.director', role: 'director' },
			{ person: 'b.manager', role: 'manager' },
			{ person: 'b.field_agent', role: 'field_agent' },
			{ person: 'b.viewer', role: 'viewer' }
		]
	},
	{
		// La gestionnaire de A gère aussi ses propres logements, comme bailleur particulier.
		id: '01a1bc9c-acb8-76a8-9e80-6cbd85e552fd',
		type: 'landlord',
		legalName: 'Mariam Zongo',
		tradeName: null,
		phone: '+22670010002',
		commune: 'Saaba',
		plan: 'discovery',
		members: [{ person: 'a.manager', role: 'director' }]
	}
];

/**
 * `admin` : connexion app_admin (DATABASE_ADMIN_URL) pour la formule et les abonnements, que app_api ne peut pas écrire.
 */
export async function seedDemo(db: Database, password: string, admin?: Database): Promise<{ people: number; organizations: number }> {
	const passwordHash = await hashPassword(password);
	const ids = new Map<string, string>();
	let createdPeople = 0;
	for (const p of DEMO_PEOPLE) {
		const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.phone, p.phone)).limit(1);
		if (existing) {
			ids.set(p.key, existing.id);
			continue;
		}
		const id = newId();
		await db.insert(users).values({
			id,
			phone: p.phone,
			name: p.name,
			passwordHash,
			status: 'active',
			phoneVerifiedAt: new Date(),
			platformRole: p.platformRole ?? null
		});
		ids.set(p.key, id);
		createdPeople += 1;
	}
	let createdOrgs = 0;
	for (const o of DEMO_ORGANIZATIONS) {
		await withOrganization(db, o.id, { statementTimeoutMs: 15_000 }, async (tx) => {
			const [existing] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, o.id)).limit(1);
			if (existing) return;
			const director = ids.get(o.members[0]!.person)!;
			await tx.insert(organizations).values({
				id: o.id,
				type: o.type,
				legalName: o.legalName,
				tradeName: o.tradeName,
				phone: o.phone,
				commune: o.commune,
				createdBy: director,
				verificationStatus: 'pending'
			});
			await tx.insert(auditLog).values({
				id: newId(),
				actorType: 'system',
				organizationId: o.id,
				action: 'organization.create',
				objectType: 'organization',
				objectId: o.id,
				after: { type: o.type, legalName: o.legalName, seed: true },
				origin: 'job'
			});
			for (const m of o.members) {
				const memberId = newId();
				await tx.insert(organizationMembers).values({
					id: memberId,
					organizationId: o.id,
					userId: ids.get(m.person)!,
					role: m.role,
					status: 'active',
					displayName: DEMO_PEOPLE.find((p) => p.key === m.person)!.name
				});
				await tx.insert(auditLog).values({
					id: newId(),
					actorType: 'system',
					organizationId: o.id,
					action: 'member.create',
					objectType: 'organization_member',
					objectId: memberId,
					after: { role: m.role, seed: true },
					origin: 'job'
				});
			}
			createdOrgs += 1;
		});
		if (admin && o.plan !== 'discovery') await seedPlan(admin, o, ids.get(o.members[0]!.person)!);
	}
	return { people: createdPeople, organizations: createdOrgs };
}

/** Formule et abonnement de démonstration (rejouable : rien n'est ajouté si un abonnement existe déjà). */
async function seedPlan(admin: Database, o: DemoOrganization, recordedBy: string): Promise<void> {
	await withOrganization(admin, o.id, { statementTimeoutMs: 15_000 }, async (tx) => {
		await tx.update(organizations).set({ planId: o.plan }).where(eq(organizations.id, o.id));
		const existing = await tx.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.organizationId, o.id)).limit(1);
		if (existing.length) return;
		const today = toIsoDate();
		const amount = o.plan === 'pro' ? 35_000 : 15_000;
		const period =
			o.subscription === 'expired'
				? { startsOn: addDays(today, -40), endsOn: addDays(today, -10) }
				: { startsOn: addDays(today, -10), endsOn: addDays(today, 50) };
		await tx.insert(subscriptions).values({
			id: newId(),
			organizationId: o.id,
			planId: o.plan,
			...period,
			amount,
			paymentStatus: 'paid',
			paymentReference: `DEMO-${o.plan.toUpperCase()}`,
			paidOn: period.startsOn,
			recordedBy,
			paymentRecordedBy: recordedBy
		});
	});
}
