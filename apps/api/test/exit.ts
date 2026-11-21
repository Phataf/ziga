/**
 * Sortie du locataire (lot 10 bis), écrite en SQL dans le contexte d'une organisation (client déjà dans sa transaction
 * de contexte) : documents, congés, états des lieux, accords, réparations, décomptes et transferts de gestion. Les
 * règles sont celles de la base (migration 0019) ; l'API viendra à l'étape 3.
 */
import { newId } from '@ziga/shared/ids';
import type pg from 'pg';

/** Un document du registre, reçu (en vigueur) par défaut. */
export async function insertDocument(
	c: pg.Client,
	organizationId: string,
	uploadedBy: string,
	d: {
		type: string;
		leaseId?: string | null;
		propertyId?: string | null;
		inspectionId?: string | null;
		inspectionItemId?: string | null;
		active?: boolean;
	}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into documents (id, organization_id, type, lease_id, property_id, inspection_id, inspection_item_id, file_name, mime_type, byte_size,
			storage_key, status, uploaded_by)
		 values ($1, $2, $3, $4, $5, $6, $7, 'piece.pdf', 'application/pdf', 1000, $8, 'pending', $9)`,
		[
			id,
			organizationId,
			d.type,
			d.leaseId ?? null,
			d.propertyId ?? null,
			d.inspectionId ?? null,
			d.inspectionItemId ?? null,
			`documents/${organizationId}/${id}`,
			uploadedBy
		]
	);
	if (d.active ?? true) {
		await c.query(`update documents set status = 'active', sha256 = $2, activated_at = now() where id = $1`, [id, 'a'.repeat(64)]);
	}
	return id;
}

/** Congé enregistré, puis bail en préavis (mêmes dates). */
export async function giveNotice(
	c: pg.Client,
	organizationId: string,
	leaseId: string,
	userId: string,
	n: { notifiedOn?: string; exitOn?: string; origin?: 'tenant' | 'lessor' } = {}
): Promise<string> {
	const id = newId();
	const notifiedOn = n.notifiedOn ?? '2026-10-01';
	const exitOn = n.exitOn ?? '2026-12-31';
	await c.query(
		`insert into lease_notices (id, organization_id, lease_id, origin, status, delivery_mode, notified_on, planned_exit_on, notice_months,
			notice_ends_on, rent_ends_on, recorded_at, recorded_by, created_by)
		 values ($1, $2, $3, $4, 'recorded', 'hand_delivery', $5, $6, 3, $6, $6, now(), $7, $7)`,
		[id, organizationId, leaseId, n.origin ?? 'tenant', notifiedOn, exitOn, userId]
	);
	await c.query(`update leases set status = 'notice', notice_given_on = $2, exit_on = $3 where id = $1`, [leaseId, notifiedOn, exitOn]);
	return id;
}

/** Fin du bail (tâche du jour, étape 3) : terminé, avec la nature de la fin. */
export async function endLease(c: pg.Client, leaseId: string, kind = 'tenant_exit'): Promise<void> {
	await c.query(
		`update leases set status = 'ended', ended_at = now(), end_kind = $2, end_reason = 'Départ du locataire', exit_on = coalesce(exit_on, current_date)
		 where id = $1`,
		[leaseId, kind]
	);
}

export async function insertInspection(
	c: pg.Client,
	organizationId: string,
	leaseId: string,
	userId: string,
	type: 'entry' | 'exit' = 'exit'
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into inspections (id, organization_id, lease_id, type, inspected_on, performed_by, created_by) values ($1, $2, $3, $4, '2026-12-31', $5, $5)`,
		[id, organizationId, leaseId, type, userId]
	);
	return id;
}

export async function insertItem(
	c: pg.Client,
	organizationId: string,
	inspectionId: string,
	i: { room?: string; element?: string; description?: string; finding?: string | null; entryItemId?: string | null } = {}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into inspection_items (id, organization_id, inspection_id, room, element, description, finding, entry_item_id)
		 values ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[
			id,
			organizationId,
			inspectionId,
			i.room ?? 'Douche et WC',
			i.element ?? 'shower',
			i.description ?? 'Pommeau de douche arraché, carrelage fendu',
			i.finding === undefined ? 'tenant_damage' : i.finding,
			i.entryItemId ?? null
		]
	);
	return id;
}

/** Signature des deux parties (cases cochées), puis l'état des lieux est figé. */
export async function signInspection(c: pg.Client, inspectionId: string, userId: string): Promise<void> {
	await c.query(
		`update inspections set status = 'signed_both', organization_signed_at = now(), organization_signed_by = $2, tenant_signed_at = now(),
			tenant_signed_recorded_by = $2
		 where id = $1`,
		[inspectionId, userId]
	);
}

/** Réparation prévue par l'organisation, au devis (justificatif « devis de réparation »). */
export async function insertRepair(
	c: pg.Client,
	organizationId: string,
	itemId: string,
	r: { amount?: number; quoteDocumentId?: string | null; performedBy?: 'organization' | 'tenant'; agreementId?: string | null } = {}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into repairs (id, organization_id, inspection_item_id, lease_id, description, performed_by, estimated_amount, quote_document_id,
			agreement_id)
		 values ($1, $2, $3, $3::uuid, 'Remplacer', $4, $5, $6, $7)`,
		[id, organizationId, itemId, r.performedBy ?? 'organization', r.amount ?? 10_000, r.quoteDocumentId ?? null, r.agreementId ?? null]
	);
	return id;
}

export async function insertAgreement(
	c: pg.Client,
	organizationId: string,
	leaseId: string,
	a: { type?: string; months?: string[]; proposedOn?: string; settlementId?: string | null; proposedBy?: string } = {}
): Promise<string> {
	const id = newId();
	const type = a.type ?? 'deposit_applied_to_rent';
	await c.query(
		`insert into agreements (id, organization_id, lease_id, type, proposed_by, proposed_on, months, settlement_id)
		 values ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[
			id,
			organizationId,
			leaseId,
			type,
			a.proposedBy ?? 'tenant',
			a.proposedOn ?? '2026-09-15',
			a.months ?? (type === 'deposit_applied_to_rent' ? ['2026-11-01', '2026-12-01'] : []),
			a.settlementId ?? null
		]
	);
	return id;
}

export async function acceptAgreement(
	c: pg.Client,
	agreementId: string,
	userId: string,
	a: { decidedOn?: string; documentId?: string | null; by?: string } = {}
): Promise<void> {
	await c.query(
		`update agreements set status = 'accepted', decided_by_party = $3, decided_on = $4, decided_at = now(), decided_by = $2, document_id = $5
		 where id = $1`,
		[agreementId, userId, a.by ?? 'organization', a.decidedOn ?? '2026-09-20', a.documentId ?? null]
	);
}

export interface SettlementTotalsSql {
	received: number;
	credit?: number;
	deductions: number;
	coveredByDeposit: number;
	creditUsed?: number;
	refund: number;
	refundFromDeposit: number;
	refundFromCredit?: number;
	claim?: number;
	outcome: 'refund' | 'claim' | 'zero';
}

export async function insertSettlement(
	c: pg.Client,
	organizationId: string,
	accountId: string,
	t: SettlementTotalsSql,
	exitOn = '2026-12-31'
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into deposit_settlements (id, organization_id, deposit_account_id, lease_id, exit_on, refund_deadline, received, credit, deductions,
			covered_by_deposit, credit_used, refund, refund_from_deposit, refund_from_credit, claim, outcome)
		 values ($1, $2, $3, $3::uuid, $4, $4::date + 30, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
		[
			id,
			organizationId,
			accountId,
			exitOn,
			t.received,
			t.credit ?? 0,
			t.deductions,
			t.coveredByDeposit,
			t.creditUsed ?? 0,
			t.refund,
			t.refundFromDeposit,
			t.refundFromCredit ?? 0,
			t.claim ?? 0,
			t.outcome
		]
	);
	return id;
}

export interface LineSql {
	kind: string;
	amount: number;
	covered?: number;
	revision?: number;
	blocker?: string | null;
	inspectionItemId?: string | null;
	repairId?: string | null;
	rentDueId?: string | null;
	expenseId?: string | null;
	agreementId?: string | null;
	documentId?: string | null;
}

export async function insertSettlementLine(c: pg.Client, organizationId: string, settlementId: string, l: LineSql): Promise<string> {
	const id = newId();
	const covered = l.covered ?? l.amount;
	await c.query(
		`insert into deposit_settlement_lines (id, organization_id, settlement_id, revision, kind, amount, covered, uncovered, blocker,
			inspection_item_id, repair_id, rent_due_id, expense_id, agreement_id, document_id)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
		[
			id,
			organizationId,
			settlementId,
			l.revision ?? 1,
			l.kind,
			l.amount,
			covered,
			l.amount - covered,
			l.blocker ?? null,
			l.inspectionItemId ?? null,
			l.repairId ?? null,
			l.rentDueId ?? null,
			l.expenseId ?? null,
			l.agreementId ?? null,
			l.documentId ?? null
		]
	);
	return id;
}

export async function setSettlementStatus(c: pg.Client, settlementId: string, status: string, userId?: string): Promise<void> {
	const stamp: Record<string, string> = {
		proposed: 'proposed_at = now()',
		accepted: 'accepted_at = now()',
		disputed: 'disputed_at = now()',
		closed: 'closed_at = now(), closed_by = $2'
	};
	await c.query(`update deposit_settlements set status = '${status}', ${stamp[status] ?? 'updated_at = now()'} where id = $1`, [
		settlementId,
		...(status === 'closed' ? [userId] : [])
	]);
}

/** Transfert de gestion enregistré (owners, ajout seul). */
export async function insertTransfer(
	c: pg.Client,
	organizationId: string,
	t: { mandateId: string; propertyId: string; unitId?: string | null; userId: string; newManagerName?: string }
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into management_transfers (id, organization_id, mandate_id, property_id, unit_id, transfer_on, new_manager_name, handed_over_on,
			handed_over_items, mandate_action, recorded_by)
		 values ($1, $2, $3, $4, $5, current_date, $6, current_date, $7, 'end_scopes', $8)`,
		[
			id,
			organizationId,
			t.mandateId,
			t.propertyId,
			t.unitId ?? null,
			t.newManagerName ?? 'Agence Faso Habitat',
			['Bail signé', 'État des lieux'],
			t.userId
		]
	);
	return id;
}
