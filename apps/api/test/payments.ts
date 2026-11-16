/**
 * Encaissements, imputations et reçus de test (lot 09), écrits en SQL dans le contexte d'une organisation (client déjà
 * dans sa transaction de contexte). Les règles sont celles de la base (migration 0015) ; l'API viendra à l'étape 3.
 */
import { createHash } from 'node:crypto';
import { newId } from '@ziga/shared/ids';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import type pg from 'pg';

export type PaymentMethodSql = 'cash' | 'mobile_money_manual' | 'bank_transfer' | 'mobile_money_direct';

export interface PaymentExtra {
	purpose?: 'rent' | 'deposit';
	depositAccountId?: string | null;
	amount?: number;
	method?: PaymentMethodSql;
	status?: string;
	operator?: string | null;
	reference?: string | null;
	/** Obligatoire pour un encaissement confirmé. */
	confirmedBy?: string | null;
	paidOn?: string;
}

/** Un encaissement (par défaut : espèces confirmées, loyer, 80 000 FCFA). Sans imputation : à ajouter dans la même transaction. */
export async function insertPayment(c: pg.Client, organizationId: string, leaseId: string, extra: PaymentExtra = {}): Promise<string> {
	const id = newId();
	const method = extra.method ?? 'cash';
	const status = extra.status ?? (method === 'cash' ? 'confirmed' : method === 'mobile_money_direct' ? 'initiated' : 'to_reconcile');
	const isMobile = method === 'mobile_money_manual' || method === 'mobile_money_direct';
	await c.query(
		`insert into payments (id, organization_id, lease_id, purpose, deposit_account_id, amount, method, operator, transaction_reference,
			paid_on, status, idempotency_key, confirmed_at, confirmed_by)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
		[
			id,
			organizationId,
			leaseId,
			extra.purpose ?? 'rent',
			extra.depositAccountId ?? null,
			extra.amount ?? 80_000,
			method,
			extra.operator === undefined ? (isMobile ? 'orange_money' : null) : extra.operator,
			extra.reference === undefined ? (isMobile ? `MP${id.slice(-10)}` : null) : extra.reference,
			extra.paidOn ?? '2027-01-05',
			status,
			`test:${id}`,
			status === 'confirmed' ? new Date().toISOString() : null,
			status === 'confirmed' ? (extra.confirmedBy ?? null) : null
		]
	);
	return id;
}

export interface AllocationSql {
	target: 'rent_due' | 'deposit_account' | 'credit';
	rentDueId?: string;
	depositAccountId?: string;
	direction?: 'allocate' | 'reverse';
	amount: number;
}

export async function allocate(
	c: pg.Client,
	organizationId: string,
	paymentId: string,
	leaseId: string,
	lines: AllocationSql[]
): Promise<void> {
	for (const l of lines) {
		await c.query(
			`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, rent_due_id, deposit_account_id, direction, amount)
			 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[
				newId(),
				organizationId,
				paymentId,
				leaseId,
				l.target,
				l.rentDueId ?? null,
				l.depositAccountId ?? null,
				l.direction ?? 'allocate',
				l.amount
			]
		);
	}
}

/** Encaissement de loyer confirmé et imputé en crédit du bail (aucune échéance nécessaire). */
export async function confirmedCreditPayment(
	c: pg.Client,
	organizationId: string,
	leaseId: string,
	userId: string,
	amount = 80_000
): Promise<string> {
	const id = await insertPayment(c, organizationId, leaseId, { amount, confirmedBy: userId });
	await allocate(c, organizationId, id, leaseId, [{ target: 'credit', amount }]);
	return id;
}

/** Annulation d'un encaissement confirmé : statut, contre-écriture et imputations inverses (rôle du service, étape 3). */
export async function cancelPayment(
	c: pg.Client,
	organizationId: string,
	paymentId: string,
	userId: string,
	reason = 'Erreur de saisie'
): Promise<string> {
	await c.query(
		`update payments set status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancellation_reason = $4 where organization_id = $1 and id = $2`,
		[organizationId, paymentId, userId, reason]
	);
	const p = (await c.query(`select * from payments where organization_id = $1 and id = $2`, [organizationId, paymentId])).rows[0];
	const lines = await c.query(
		`select target, rent_due_id, deposit_account_id, sum(case direction when 'allocate' then amount else -amount end)::bigint as net
		 from payment_allocations where organization_id = $1 and payment_id = $2 group by 1, 2, 3`,
		[organizationId, paymentId]
	);
	await allocate(
		c,
		organizationId,
		paymentId,
		p.lease_id,
		lines.rows
			.filter((r) => Number(r.net) > 0)
			.map((r) => ({
				target: r.target,
				rentDueId: r.rent_due_id ?? undefined,
				depositAccountId: r.deposit_account_id ?? undefined,
				direction: 'reverse' as const,
				amount: Number(r.net)
			}))
	);
	if (p.confirmed_at) {
		const reversal = newId();
		await c.query(
			`insert into payments (id, organization_id, kind, reverses_payment_id, lease_id, purpose, deposit_account_id, amount, method, operator,
				transaction_reference, paid_on, status, idempotency_key, confirmed_at, confirmed_by)
			 values ($1, $2, 'reversal', $3, $4, $5, $6, $7, $8, $9, $10, current_date, 'confirmed', $11, now(), $12)`,
			[
				reversal,
				organizationId,
				paymentId,
				p.lease_id,
				p.purpose,
				p.deposit_account_id,
				p.amount,
				p.method,
				p.operator,
				p.transaction_reference,
				`reversal:${paymentId}`,
				userId
			]
		);
		return reversal;
	}
	return paymentId;
}

/** Reçu provisoire d'un encaissement. */
export async function insertReceipt(c: pg.Client, organizationId: string, paymentId: string): Promise<string> {
	const id = newId();
	await c.query(`insert into receipts (id, organization_id, payment_id, provisional_number) values ($1, $2, $3, $4)`, [
		id,
		organizationId,
		paymentId,
		provisionalReceiptNumber(id)
	]);
	return id;
}

/** Validation d'un reçu : la base attribue le numéro. */
export async function validateReceipt(c: pg.Client, organizationId: string, receiptId: string, issuedOn = '2027-01-05'): Promise<string> {
	const r = await c.query(
		`update receipts set status = 'valid', issued_on = $3, snapshot = '{"organization":{"name":"Test"}}'::jsonb
		 where organization_id = $1 and id = $2 returning number`,
		[organizationId, receiptId, issuedOn]
	);
	return r.rows[0].number as string;
}

export function sha256(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}

/** Jeton d'un reçu : renvoie le jeton (gardé par le test), la base n'en a que l'empreinte. */
export async function insertToken(
	c: pg.Client,
	organizationId: string,
	receiptId: string,
	kind: 'verification' | 'share'
): Promise<string> {
	const token = newReceiptToken();
	await c.query(`insert into receipt_tokens (id, organization_id, receipt_id, kind, token_hash) values ($1, $2, $3, $4, $5)`, [
		newId(),
		organizationId,
		receiptId,
		kind,
		sha256(token)
	]);
	return token;
}
