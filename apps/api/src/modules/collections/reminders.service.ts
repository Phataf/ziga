/**
 * Impayés et relances (lot 10).
 * - Impayés : la même fonction pure que l'appareil (`arrearsGroups`, packages/shared), sur les données des modules
 *   leases, properties, payments et des dépenses réclamées ; agent de terrain : ses unités seulement.
 * - Relances : ajout seul ; un message (WhatsApp, SMS) exige `reminder.send`, un appel ou une visite
 *   `reminder.record_visit` (agent de terrain compris, sur les locataires de ses unités). Le lien WhatsApp est sous
 *   l'interrupteur `collections.reminders_whatsapp_link` : coupé, la relance par WhatsApp est refusée. Aucun envoi.
 * - Modèles et seuils : réglage du directeur, journalisé.
 */
import { Injectable } from '@nestjs/common';
import { arrearsGroups, type ArrearsFilter, type ArrearsGroup } from '@ziga/shared/collections';
import { toIsoDate } from '@ziga/shared/dates';
import type { Page } from '@ziga/shared/leases';
import { can } from '@ziga/shared/permissions';
import {
	DEFAULT_REMINDER_OFFSETS,
	DEFAULT_REMINDER_TEMPLATES,
	REMINDER_CHANNEL_ACTION,
	type CreateReminderData,
	type ReminderLevel,
	type ReminderSettingsData,
	type ReminderSettingsView,
	type ReminderView
} from '@ziga/shared/reminders';
import { desc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import type { AuditOrigin } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import { reminders, reminderSettings } from '../../db/schema/collections.js';
import { AuditService } from '../audit/audit.service.js';
import { FeaturesService } from '../features/features.service.js';
import { LeasesService } from '../leases/leases.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PropertiesService } from '../properties/properties.service.js';
import { collectionsContext } from './collections-context.js';
import { ExpensesService } from './expenses.service.js';

type ReminderRow = typeof reminders.$inferSelect;

export function reminderView(r: ReminderRow): ReminderView {
	return {
		id: r.id,
		tenantId: r.tenantId,
		rentDueIds: r.rentDueIds,
		expenseIds: r.expenseIds,
		channel: r.channel,
		templateLevel: (r.templateLevel ?? null) as ReminderLevel | null,
		note: r.note,
		sentAt: r.sentAt.toISOString(),
		sentBy: r.sentBy
	};
}

@Injectable()
export class RemindersService {
	constructor(
		private readonly audit: AuditService,
		private readonly features: FeaturesService,
		private readonly leases: LeasesService,
		private readonly properties: PropertiesService,
		private readonly payments: PaymentsService,
		private readonly expenses: ExpensesService
	) {}

	// ---------------------------------------------------------------- réglages

	async settings(tx: Tx = collectionsContext().tx): Promise<ReminderSettingsView> {
		const [row] = await tx.select().from(reminderSettings).limit(1);
		if (!row) return { templates: [...DEFAULT_REMINDER_TEMPLATES], offsets: [...DEFAULT_REMINDER_OFFSETS], updatedAt: null };
		return {
			templates: [row.template1, row.template2, row.template3],
			offsets: [row.offset1, row.offset2, row.offset3],
			updatedAt: row.updatedAt.toISOString()
		};
	}

	async updateSettings(input: ReminderSettingsData): Promise<ReminderSettingsView> {
		const c = collectionsContext();
		const before = await this.settings(c.tx);
		const values = {
			template1: input.templates[0],
			template2: input.templates[1],
			template3: input.templates[2],
			offset1: input.offsets[0],
			offset2: input.offsets[1],
			offset3: input.offsets[2],
			updatedBy: c.userId,
			updatedAt: new Date()
		};
		await c.tx
			.insert(reminderSettings)
			.values({ organizationId: c.organizationId, ...values })
			.onConflictDoUpdate({ target: reminderSettings.organizationId, set: values });
		const after = await this.settings(c.tx);
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'reminder.settings',
			objectType: 'organization',
			objectId: c.organizationId,
			before: { templates: before.templates, offsets: before.offsets },
			after: { templates: after.templates, offsets: after.offsets }
		});
		return after;
	}

	// ---------------------------------------------------------------- impayés

	/**
	 * Impayés groupés par locataire, du plus ancien retard au plus récent ; curseur : le dernier locataire de la page.
	 * Agent de terrain : les locataires des baux de ses unités seulement.
	 */
	async arrears(filter: ArrearsFilter & { cursor?: string | null; limit: number }): Promise<Page<ArrearsGroup>> {
		const c = collectionsContext();
		const assigned = await this.properties.assignedUnitIds();
		const scope = assigned ? { unitIds: assigned } : {};
		const units = await this.properties.collectionUnits(c.tx, scope);
		const data = await this.leases.collectionLeases(c.tx, scope);
		const leaseById = new Map(data.leases.map((l) => [l.id, l]));
		const tenants = new Map(data.leases.map((l) => [l.tenantId, { id: l.tenantId, name: l.tenantName, phone: l.tenantPhone }]));
		const recovered = await this.payments.expenseRecoveries(c.tx);
		const awaiting = await this.payments.awaitingPayments(c.tx);
		const claims = (await this.expenses.tenantClaims(c.tx))
			.filter((e) => e.leaseId && leaseById.has(e.leaseId))
			.map((e) => ({
				expenseId: e.id,
				leaseId: e.leaseId!,
				tenantId: leaseById.get(e.leaseId!)!.tenantId,
				unitId: e.unitId ?? leaseById.get(e.leaseId!)!.unitId,
				date: e.spentOn,
				category: e.category,
				description: e.description,
				amount: e.amount,
				recovered: recovered.get(e.id) ?? 0,
				cancelled: e.status === 'cancelled'
			}));
		const tenantIds = [...tenants.keys()];
		const sent = tenantIds.length
			? await c.tx
					.select({ tenantId: reminders.tenantId, sentAt: reminders.sentAt, channel: reminders.channel })
					.from(reminders)
					.where(inArray(reminders.tenantId, tenantIds))
			: [];
		const settings = await this.settings(c.tx);
		const groups = arrearsGroups({
			today: toIsoDate(),
			dues: data.dues.map((d) => ({ ...d, tenantId: leaseById.get(d.leaseId)!.tenantId, unitId: leaseById.get(d.leaseId)!.unitId })),
			claims,
			tenants: [...tenants.values()],
			pendingRentPayments: awaiting.filter((p) => p.purpose === 'rent' && leaseById.has(p.leaseId)),
			pendingClaimPayments: awaiting
				.filter((p) => p.purpose === 'expense' && p.expenseId)
				.map((p) => ({ expenseId: p.expenseId!, amount: p.amount })),
			reminders: sent.map((r) => ({ tenantId: r.tenantId, sentAt: r.sentAt.toISOString(), channel: r.channel })),
			offsets: settings.offsets as [number, number, number],
			filter,
			units: new Map(
				units.map((u) => [u.id, { neighborhoodId: u.neighborhoodId, ownerId: u.ownerId, agentIds: u.agentId ? [u.agentId] : [] }])
			)
		});
		const start = filter.cursor ? groups.findIndex((g) => g.tenantId === filter.cursor) + 1 : 0;
		const items = groups.slice(start, start + filter.limit);
		return { items, nextCursor: start + filter.limit < groups.length ? items.at(-1)!.tenantId : null };
	}

	// ---------------------------------------------------------------- relances

	async list(filter: { tenantId?: string; limit: number }): Promise<ReminderView[]> {
		const c = collectionsContext();
		const assigned = await this.properties.assignedUnitIds();
		const rows = await c.tx
			.select()
			.from(reminders)
			.where(filter.tenantId ? eq(reminders.tenantId, filter.tenantId) : undefined)
			.orderBy(desc(reminders.sentAt), desc(reminders.id))
			.limit(filter.limit);
		if (!assigned) return rows.map(reminderView);
		const mine = new Set((await this.leases.collectionLeases(c.tx, { unitIds: assigned })).leases.map((l) => l.tenantId));
		return rows.filter((r) => mine.has(r.tenantId)).map(reminderView);
	}

	/**
	 * Relance enregistrée (route ou appareil), idempotente par identifiant. Aucun message n'est envoyé par la plateforme :
	 * l'appareil a ouvert WhatsApp, ou la personne a appelé ou s'est déplacée.
	 */
	async create(input: CreateReminderData, origin?: AuditOrigin): Promise<ReminderView> {
		const c = collectionsContext();
		const [existing] = await c.tx.select().from(reminders).where(eq(reminders.id, input.id)).limit(1);
		if (existing) return reminderView(existing);
		const action = REMINDER_CHANNEL_ACTION[input.channel];
		if (!can(c.role, action)) {
			throw new AppError('FORBIDDEN_ACTION', 'Votre rôle ne permet pas cette relance.', 403, { action });
		}
		if (input.channel === 'whatsapp_link') {
			await this.features.assertEnabled(
				'collections.reminders_whatsapp_link',
				c.userId,
				await this.features.organizationContext(c.organizationId, c.planId, c.tx)
			);
		}
		const assigned = await this.properties.assignedUnitIds();
		if (assigned) {
			const mine = (await this.leases.collectionLeases(c.tx, { unitIds: assigned })).leases.some((l) => l.tenantId === input.tenantId);
			if (!mine) throw new AppError('TENANT_NOT_FOUND', 'Locataire introuvable.', 404);
		}
		const [row] = await c.tx
			.insert(reminders)
			.values({
				id: input.id,
				organizationId: c.organizationId,
				tenantId: input.tenantId,
				rentDueIds: input.rentDueIds,
				expenseIds: input.expenseIds,
				channel: input.channel,
				templateLevel: input.templateLevel,
				note: input.note,
				sentBy: c.userId
			})
			.returning();
		await this.audit.record(c.tx, {
			actor: c.actor,
			organizationId: c.organizationId,
			action: 'reminder.record',
			objectType: 'tenant',
			objectId: input.tenantId,
			after: {
				reminderId: input.id,
				channel: input.channel,
				templateLevel: input.templateLevel,
				rentDueIds: input.rentDueIds,
				expenseIds: input.expenseIds
			},
			...(origin ? { origin } : {})
		});
		return reminderView(row!);
	}
}
