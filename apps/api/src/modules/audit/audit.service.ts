/**
 * Journal d'audit (lot 03, CLAUDE.md règle 4) : une ligne par création, modification, annulation, publication,
 * changement de configuration ou événement de sécurité. Toujours écrite dans la transaction de l'action
 * (paramètre `tx`) : l'une n'existe jamais sans l'autre. La table est en ajout seul (triggers).
 *
 * Deux portées : `organizationId` (événement d'une organisation, contexte withOrganization) ou, sans
 * organisation, `subjectUserId` (événement de plateforme, contexte withUser de la personne concernée).
 */
import { Injectable } from '@nestjs/common';
import { newId } from '@ziga/shared/ids';
import { RequestContext, type AuditOrigin } from '../../common/request-context.js';
import type { Tx } from '../../db/database.js';
import { auditLog } from '../../db/schema/organizations.js';

export type AuditActor = { type: 'user'; userId: string; role?: string | null } | { type: 'system' };

export interface AuditEntry {
	actor: AuditActor;
	action: string;
	objectType: string;
	objectId?: string | null;
	organizationId?: string | null;
	subjectUserId?: string | null;
	before?: unknown;
	after?: unknown;
	origin?: AuditOrigin;
}

/** Valeurs avant et après réduites aux seuls champs qui changent. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): { before: Partial<T>; after: Partial<T> } | null {
	const b: Partial<T> = {};
	const a: Partial<T> = {};
	for (const key of Object.keys(after) as (keyof T)[]) {
		if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
			b[key] = (before[key] ?? null) as T[keyof T];
			a[key] = (after[key] ?? null) as T[keyof T];
		}
	}
	return Object.keys(a).length ? { before: b, after: a } : null;
}

@Injectable()
export class AuditService {
	async record(tx: Tx, entry: AuditEntry): Promise<void> {
		const ctx = RequestContext.get();
		await tx.insert(auditLog).values({
			id: newId(),
			actorType: entry.actor.type,
			actorUserId: entry.actor.type === 'user' ? entry.actor.userId : null,
			actorRole: entry.actor.type === 'user' ? (entry.actor.role ?? null) : null,
			organizationId: entry.organizationId ?? null,
			subjectUserId: entry.subjectUserId ?? null,
			action: entry.action,
			objectType: entry.objectType,
			objectId: entry.objectId ?? null,
			before: entry.before ?? null,
			after: entry.after ?? null,
			origin: entry.origin ?? ctx?.origin ?? 'api',
			ip: ctx?.ip ?? null,
			requestId: ctx?.requestId ?? null
		});
	}
}
