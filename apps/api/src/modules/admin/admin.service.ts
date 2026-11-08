/**
 * Back-office (lot 04) : annuaire des organisations et des personnes, état des fonctionnalités avec la raison,
 * accès d'assistance motivé, journal de la plateforme. Toujours par la connexion `app_admin` (AdminDatabase).
 * Aucune connexion « en tant que » un utilisateur : l'assistance lit avec ses propres droits, en lecture seule,
 * et chaque lecture apparaît dans le journal de l'organisation.
 */
import { Injectable } from '@nestjs/common';
import { toIsoDate } from '@ziga/shared/dates';
import { GLOBAL_MODES, resolveAll, resolveFeature, toStatusView, type GlobalMode } from '@ziga/shared/features';
import { newId } from '@ziga/shared/ids';
import { and, desc, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import type { Tx } from '../../db/database.js';
import { auditLog } from '../../db/schema/organizations.js';
import { supportAccesses } from '../../db/schema/platform.js';
import { auditPage } from '../audit/audit-page.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { FeatureAdminService } from '../features/feature-admin.service.js';
import { FeaturesService } from '../features/features.service.js';
import { SubscriptionsService } from '../features/subscriptions.service.js';
import { AuthService } from '../identity/auth.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { AdminDatabase } from './admin-database.service.js';
import type { PlatformActor } from './platform.guard.js';

export function actorOf(p: PlatformActor): AuditActor & { type: 'user'; userId: string; role: string } {
	return { type: 'user', userId: p.userId, role: p.role };
}

@Injectable()
export class AdminService {
	constructor(
		private readonly admin: AdminDatabase,
		private readonly organizations: OrganizationsService,
		private readonly people: AuthService,
		private readonly features: FeaturesService,
		private readonly featureAdmin: FeatureAdminService,
		private readonly subscriptions: SubscriptionsService,
		private readonly audit: AuditService
	) {}

	// ------------------------------------------------------------ organisations

	async organizationRows(tx: Tx) {
		const [rows, subs] = await Promise.all([this.organizations.directory(tx), this.featureAdmin.subscriptions(tx)]);
		return rows.map((o) => ({
			...o,
			subscription: this.subscriptions.stage(
				o.planId,
				subs.filter((s) => s.organizationId === o.id)
			)
		}));
	}

	async listOrganizations(filter: { type?: string; status?: string; plan?: string; q?: string }) {
		return this.admin.transaction(
			async (tx) => {
				const q = filter.q?.trim().toLowerCase();
				return (await this.organizationRows(tx)).filter(
					(o) =>
						(!filter.type || o.type === filter.type) &&
						(!filter.status || o.verificationStatus === filter.status || o.subscription.stage === filter.status) &&
						(!filter.plan || o.planId === filter.plan) &&
						(!q || o.name.toLowerCase().includes(q) || o.legalName.toLowerCase().includes(q) || o.phone.includes(q))
				);
			},
			{ readOnly: true }
		);
	}

	async organization(id: string) {
		return this.admin.transaction(
			async (tx) => {
				const row = (await this.organizationRows(tx)).find((o) => o.id === id);
				if (!row) throw new AppError('NOT_FOUND', 'Organisation introuvable.', 404);
				const [members, subs, quotas, overrides, accesses, disabled] = await Promise.all([
					this.organizations.directoryMembers(tx, id),
					this.featureAdmin.subscriptions(tx, id),
					this.featureAdmin.quotaOverrides(tx, id),
					this.featureAdmin.overrides(tx, { organizationId: id }),
					this.accesses(tx, id),
					this.features.disabledFor(tx, id)
				]);
				const all = resolveAll(
					{ organizationId: id, planId: row.planId, disabledByOrganization: disabled, userId: null, now: new Date() },
					await this.features.snapshot()
				);
				const names = await this.people.namesOf(
					tx,
					subs.flatMap((s) => [s.recordedBy, s.paymentRecordedBy ?? ''])
				);
				return {
					...row,
					members,
					subscriptions: subs.map((s) => ({
						...s,
						organizationName: row.name,
						recordedBy: names.get(s.recordedBy) ?? null,
						createdAt: s.createdAt.toISOString()
					})),
					quotaOverrides: quotas.map((q) => ({
						id: q.id,
						quota: q.quota,
						value: q.value,
						reason: q.reason,
						endsAt: q.endsAt?.toISOString() ?? null
					})),
					overrides: overrides.map((o) => ({
						id: o.id,
						featureKey: o.featureKey,
						value: o.value,
						reason: o.reason,
						endsAt: o.endsAt?.toISOString() ?? null
					})),
					features: Object.fromEntries(Object.entries(all).map(([k, r]) => [k, toStatusView(r)])),
					supportAccesses: accesses
				};
			},
			{ readOnly: true }
		);
	}

	// ------------------------------------------------------------ personnes

	async searchPeople(q: string) {
		return this.admin.transaction((tx) => this.people.searchPeople(tx, q), { readOnly: true });
	}

	/** Fiche d'une personne : appartenances, état des fonctionnalités (hors organisation) et événements de sécurité. */
	async person(id: string) {
		return this.admin.transaction(
			async (tx) => {
				const person = await this.people.person(tx, id);
				const [memberships, overrides, events] = await Promise.all([
					this.organizations.membershipsOfPerson(tx, id),
					this.featureAdmin.overrides(tx, { userId: id }),
					auditPage(tx, undefined, 50, [isNull(auditLog.organizationId), eq(auditLog.subjectUserId, id)])
				]);
				const all = resolveAll({ userId: id, now: new Date() }, await this.features.snapshot());
				return {
					...person,
					memberships,
					overrides: overrides.map((o) => ({
						id: o.id,
						featureKey: o.featureKey,
						value: o.value,
						reason: o.reason,
						endsAt: o.endsAt?.toISOString() ?? null
					})),
					features: Object.fromEntries(Object.entries(all).map(([k, r]) => [k, toStatusView(r)])),
					events: events.entries
				};
			},
			{ readOnly: true }
		);
	}

	// ------------------------------------------------------------ fonctionnalités

	/** Simulateur : l'état effectif de chaque clé, et l'étape de résolution qui a décidé. */
	async simulate(organizationId: string | null, userId: string | null) {
		return this.admin.transaction(
			async (tx) => {
				let org = null;
				if (organizationId) {
					const row = (await this.organizations.directory(tx)).find((o) => o.id === organizationId);
					if (!row) throw new AppError('NOT_FOUND', 'Organisation introuvable.', 404);
					org = { organizationId, planId: row.planId, disabled: await this.features.disabledFor(tx, organizationId) };
				}
				if (userId) await this.people.person(tx, userId);
				const all = await this.features.resolveAll(userId, org);
				return {
					organizationId,
					userId,
					planId: org?.planId ?? null,
					features: Object.fromEntries(Object.entries(all).map(([k, r]) => [k, toStatusView(r)]))
				};
			},
			{ readOnly: true }
		);
	}

	/** Nombre d'organisations qui gagneraient ou perdraient la fonctionnalité si le mode global changeait. */
	async impact(key: string, mode: GlobalMode) {
		if (!(GLOBAL_MODES as readonly string[]).includes(mode)) throw new AppError('BAD_REQUEST', 'Mode inconnu.', 400);
		return this.admin.transaction(
			async (tx) => {
				const [rows, disabled, snapshot] = await Promise.all([
					this.organizations.directory(tx),
					this.features.allDisabled(tx),
					this.features.snapshot()
				]);
				const feature = snapshot.features[key];
				if (!feature) throw new AppError('NOT_FOUND', 'Fonctionnalité inconnue.', 404);
				const changed = { ...snapshot, features: { ...snapshot.features, [key]: { ...feature, globalMode: mode } } };
				let losing = 0;
				let gaining = 0;
				let withAccess = 0;
				for (const o of rows) {
					const ctx = {
						organizationId: o.id,
						planId: o.planId,
						disabledByOrganization: disabled.get(o.id) ?? [],
						userId: null,
						now: new Date()
					};
					const before = resolveFeature(key, ctx, snapshot).enabled;
					const after = resolveFeature(key, ctx, changed).enabled;
					if (before) withAccess += 1;
					if (before && !after) losing += 1;
					if (!before && after) gaining += 1;
				}
				return { key, from: feature.globalMode, to: mode, organizations: rows.length, withAccess, losing, gaining };
			},
			{ readOnly: true }
		);
	}

	async overridesWithNames(tx: Tx, rows: Awaited<ReturnType<FeatureAdminService['overrides']>>) {
		const orgs = new Map((await this.organizations.directory(tx)).map((o) => [o.id, o.name]));
		const names = await this.people.namesOf(
			tx,
			rows.flatMap((r) => [r.userId ?? '', r.createdBy])
		);
		return rows.map((o) => ({
			id: o.id,
			featureKey: o.featureKey,
			scope: o.scope,
			targetId: (o.organizationId ?? o.userId)!,
			targetName: (o.organizationId ? orgs.get(o.organizationId) : names.get(o.userId!)) ?? '—',
			value: o.value,
			reason: o.reason,
			startsAt: o.startsAt.toISOString(),
			endsAt: o.endsAt?.toISOString() ?? null,
			createdBy: names.get(o.createdBy) ?? null,
			createdAt: o.createdAt.toISOString()
		}));
	}

	// ------------------------------------------------------------ accès d'assistance

	async accesses(tx: Tx, organizationId?: string) {
		const rows = await tx
			.select()
			.from(supportAccesses)
			.where(organizationId ? eq(supportAccesses.organizationId, organizationId) : undefined)
			.orderBy(desc(supportAccesses.createdAt))
			.limit(100);
		const orgs = new Map((await this.organizations.directory(tx)).map((o) => [o.id, o.name]));
		const names = await this.people.namesOf(
			tx,
			rows.map((r) => r.agentId)
		);
		const now = Date.now();
		return rows.map((a) => ({
			id: a.id,
			organizationId: a.organizationId,
			organizationName: orgs.get(a.organizationId) ?? '—',
			agentId: a.agentId,
			agentName: names.get(a.agentId) ?? '—',
			reason: a.reason,
			startsAt: a.startsAt.toISOString(),
			endsAt: a.endsAt.toISOString(),
			closedAt: a.closedAt?.toISOString() ?? null,
			active: !a.closedAt && a.startsAt.getTime() <= now && a.endsAt.getTime() > now
		}));
	}

	listAccesses() {
		return this.admin.transaction((tx) => this.accesses(tx), { readOnly: true });
	}

	/** Ouverture : motif (15 caractères au moins) et durée (24 h au plus), visibles dans le journal de l'organisation. */
	async openAccess(actor: PlatformActor, input: { organizationId: string; reason: string; durationMinutes: number }) {
		const id = newId();
		const startsAt = new Date();
		const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
		await this.admin.withOrganization(input.organizationId, async (tx) => {
			const exists = (await this.organizations.directory(tx)).some((o) => o.id === input.organizationId);
			if (!exists) throw new AppError('NOT_FOUND', 'Organisation introuvable.', 404);
			await tx
				.insert(supportAccesses)
				.values({ id, organizationId: input.organizationId, agentId: actor.userId, reason: input.reason, startsAt, endsAt });
			await this.audit.record(tx, {
				actor: actorOf(actor),
				organizationId: input.organizationId,
				action: 'support.access_open',
				objectType: 'support_access',
				objectId: id,
				after: { reason: input.reason, endsAt: endsAt.toISOString(), readOnly: true },
				origin: 'admin'
			});
		});
		return { id, endsAt: endsAt.toISOString() };
	}

	async closeAccess(actor: PlatformActor, id: string) {
		const access = await this.activeAccess(actor, id);
		await this.admin.withOrganization(access.organizationId, async (tx) => {
			await tx.update(supportAccesses).set({ closedAt: new Date(), closedBy: actor.userId }).where(eq(supportAccesses.id, id));
			await this.audit.record(tx, {
				actor: actorOf(actor),
				organizationId: access.organizationId,
				action: 'support.access_close',
				objectType: 'support_access',
				objectId: id,
				after: { closed: true },
				origin: 'admin'
			});
		});
	}

	/** Accès en cours, ouvert par cette personne : sinon refus (un accès expiré ou clos ne lit plus rien). */
	private async activeAccess(actor: PlatformActor, id: string) {
		const [access] = await this.admin.transaction(
			(tx) =>
				tx
					.select()
					.from(supportAccesses)
					.where(and(eq(supportAccesses.id, id), isNull(supportAccesses.closedAt), gt(supportAccesses.endsAt, new Date())))
					.limit(1),
			{ readOnly: true }
		);
		if (!access)
			throw new AppError('SUPPORT_ACCESS_EXPIRED', 'Cet accès d’assistance est terminé. Ouvrez-en un nouveau, avec son motif.', 403);
		if (access.agentId !== actor.userId) throw new AppError('FORBIDDEN_ACTION', 'Cet accès a été ouvert par une autre personne.', 403);
		return access;
	}

	/**
	 * Lecture pendant un accès : transaction en lecture seule dans le contexte de l'organisation, puis une ligne
	 * « Lecture par l'assistance » dans son journal. Sans journalisation réussie, rien n'est renvoyé.
	 */
	async readDuringAccess<T>(actor: PlatformActor, id: string, page: string, read: (tx: Tx) => Promise<T>): Promise<T> {
		const access = await this.activeAccess(actor, id);
		const data = await this.admin.withOrganization(access.organizationId, read, { readOnly: true });
		await this.admin.withOrganization(access.organizationId, (tx) =>
			this.audit.record(tx, {
				actor: actorOf(actor),
				organizationId: access.organizationId,
				action: 'support.read',
				objectType: 'support_access',
				objectId: id,
				after: { page, reason: access.reason },
				origin: 'admin'
			})
		);
		return data;
	}

	readOrganization(actor: PlatformActor, id: string) {
		return this.readDuringAccess(actor, id, 'organisation', async (tx) => {
			const view = await this.organizations.view(tx);
			return { organization: view, members: await this.organizations.directoryMembers(tx, view.id) };
		});
	}

	readJournal(actor: PlatformActor, id: string, before?: string) {
		return this.readDuringAccess(actor, id, 'journal', (tx) => auditPage(tx, before, 50, [sql`${auditLog.organizationId} is not null`]));
	}

	// ------------------------------------------------------------ journal de la plateforme

	/** Événements de plateforme (connexions, révocations, réutilisations…) et actions du back-office. */
	async journal(filter: { before?: string; userId?: string; action?: string }) {
		return this.admin.transaction(
			async (tx) => {
				const conditions: SQL[] = [];
				if (filter.userId)
					conditions.push(sql`(${auditLog.subjectUserId} = ${filter.userId} or ${auditLog.actorUserId} = ${filter.userId})`);
				if (filter.action) conditions.push(sql`starts_with(${auditLog.action}, ${filter.action})`);
				const page = await auditPage(tx, filter.before, 50, conditions);
				const orgs = new Map((await this.organizations.directory(tx)).map((o) => [o.id, o.name]));
				const names = await this.people.namesOf(
					tx,
					page.entries.map((e) => e.subjectUserId ?? '')
				);
				return {
					...page,
					entries: page.entries.map((e) => ({
						...e,
						organizationName: e.organizationId ? (orgs.get(e.organizationId) ?? null) : null,
						subjectName: e.subjectUserId ? (names.get(e.subjectUserId) ?? null) : null
					}))
				};
			},
			{ readOnly: true }
		);
	}

	today(): string {
		return toIsoDate();
	}
}
