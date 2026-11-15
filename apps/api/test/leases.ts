/**
 * Locataires, baux, échéances et cautions de test (lot 08), écrits en SQL dans le contexte d'une organisation (client
 * déjà dans sa transaction de contexte).
 */
import { newId } from '@ziga/shared/ids';
import type pg from 'pg';

export async function insertTenant(c: pg.Client, organizationId: string, name = 'Issa Kaboré'): Promise<string> {
	const id = newId();
	await c.query(`insert into tenants (id, organization_id, full_name, phone) values ($1, $2, $3, '+22676112233')`, [
		id,
		organizationId,
		name
	]);
	return id;
}

export interface LeaseExtra {
	status?: 'draft' | 'signed' | 'active';
	startsOn?: string;
	endsOn?: string | null;
	rent?: number;
	charges?: number;
	lessorType?: 'owner' | 'organization';
	billingMode?: 'calendar_prorata' | 'calendar_full_first' | 'anniversary';
}

/** Un bail (par défaut en vigueur depuis le 01/01/2026, sans fin, 75 000 FCFA). */
export async function insertLease(
	c: pg.Client,
	organizationId: string,
	unitId: string,
	tenantId: string,
	extra: LeaseExtra = {}
): Promise<string> {
	const id = newId();
	const status = extra.status ?? 'active';
	const startsOn = extra.startsOn ?? '2026-01-01';
	await c.query(
		`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, ends_on, dues_start_on, rent, charges, rent_effective_from,
			billing_mode, lessor_type, status, activated_on, activated_at)
		 values ($1, $2, $3, $4, $5, $6, $5, $7, $8, $5, $9, $10, $11, $12, $13)`,
		[
			id,
			organizationId,
			unitId,
			tenantId,
			startsOn,
			extra.endsOn ?? null,
			extra.rent ?? 75_000,
			extra.charges ?? 5_000,
			extra.billingMode ?? 'calendar_prorata',
			extra.lessorType ?? 'owner',
			status,
			status === 'draft' ? null : startsOn,
			status === 'draft' ? null : new Date().toISOString()
		]
	);
	return id;
}

export async function insertDue(
	c: pg.Client,
	organizationId: string,
	leaseId: string,
	periodStart: string,
	extra: { status?: string; rent?: number; charges?: number; onConflict?: boolean } = {}
): Promise<number> {
	const rent = extra.rent ?? 75_000;
	const charges = extra.charges ?? 5_000;
	const periodEnd = new Date(Date.UTC(+periodStart.slice(0, 4), +periodStart.slice(5, 7), 0)).toISOString().slice(0, 10);
	const r = await c.query(
		`insert into rent_dues (id, organization_id, lease_id, period_start, period_end, due_on, rent, charges, amount_due, status, lease_version)
		 values ($1, $2, $3, $4, $5, $4::date + 4, $6, $7, $8, $9, 1)${extra.onConflict ? ' on conflict (organization_id, lease_id, period_start) do nothing' : ''}`,
		[newId(), organizationId, leaseId, periodStart, periodEnd, rent, charges, rent + charges, extra.status ?? 'upcoming']
	);
	return r.rowCount ?? 0;
}

export async function insertDepositAccount(
	c: pg.Client,
	organizationId: string,
	leaseId: string,
	extra: { type?: 'security_deposit' | 'utilities_guarantee'; agreed?: number; holder?: 'organization' | 'owner' | null } = {}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into deposit_accounts (id, organization_id, lease_id, type, agreed_amount, holder) values ($1, $2, $3, $4, $5, $6)`,
		[
			id,
			organizationId,
			leaseId,
			extra.type ?? 'security_deposit',
			extra.agreed ?? 150_000,
			extra.holder === undefined ? 'organization' : extra.holder
		]
	);
	return id;
}

export async function insertMovement(
	c: pg.Client,
	organizationId: string,
	accountId: string,
	type: string,
	amount: number,
	extra: { previousHolder?: string; newHolder?: string; reason?: string; inspectionItemId?: string; documentId?: string } = {}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into deposit_movements (id, organization_id, account_id, type, amount, previous_holder, new_holder, reason, occurred_on,
			inspection_item_id, document_id)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, current_date, $9, $10)`,
		[
			id,
			organizationId,
			accountId,
			type,
			amount,
			extra.previousHolder ?? null,
			extra.newHolder ?? null,
			extra.reason ?? null,
			extra.inspectionItemId ?? null,
			extra.documentId ?? null
		]
	);
	return id;
}
