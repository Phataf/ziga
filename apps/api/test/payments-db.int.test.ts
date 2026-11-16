/**
 * Lot 09, étape 2 : encaissements, imputations et reçus dans la base (migration 0015), en SQL, avec le rôle de l'API
 * (app_api, sans BYPASSRLS), le propriétaire du schéma (triggers) et le rôle du back-office (app_admin).
 * - Accès croisé A/B sur les cinq tables, et par les deux fonctions publiques des jetons (règle 1).
 * - Ajout seul : ni UPDATE du montant, ni DELETE, ni TRUNCATE sur payments, payment_allocations et receipts (règle 3).
 * - Machine d'états : la même que packages/shared ; statut de saisie cohérent avec le moyen (règle 6).
 * - Doublon Mobile Money (point b).
 * - Imputations : montant payé des échéances tenu par la base, invariant à la validation de la transaction,
 *   contre-écriture ; caution : mouvements `received` et `received_cancelled`, jamais sous les sorties (règle 14).
 * - Numérotation : par la base, continue, sans trou ni doublon, 1 000 confirmations concurrentes (règle 9) ; préfixe
 *   et premier numéro figés après le premier reçu.
 */
import { newId } from '@ziga/shared/ids';
import { PAYMENT_STATUSES, PAYMENT_TRANSITIONS } from '@ziga/shared/payments';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './http.js';
import { insertDepositAccount, insertDue, insertLease, insertMovement, insertTenant } from './leases.js';
import { apiSql, createOrg, inContext, sqlError, type Org } from './orgs.js';
import {
	allocate,
	cancelPayment,
	confirmedCreditPayment,
	insertPayment,
	insertReceipt,
	insertToken,
	sha256,
	validateReceipt
} from './payments.js';
import { propertyWithUnit } from './properties.js';

let t: TestApp;
let a: Org;
let b: Org;
let owner: pg.Client;
let api: pg.Client;

async function connect(url: string): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: url });
	await c.connect();
	return c;
}

/** Écrit et valide des données de test dans le contexte d'une organisation (propriétaire du schéma, sous la RLS). */
async function seed<T>(organizationId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
	await owner.query('BEGIN');
	try {
		await owner.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
		const r = await fn(owner);
		await owner.query('COMMIT');
		return r;
	} catch (error) {
		await owner.query('ROLLBACK');
		throw error;
	}
}

/** Un bail en vigueur neuf (unité, propriétaire et locataire compris). */
async function newLease(organizationId: string): Promise<string> {
	return seed(organizationId, async (c) => {
		const ownerId = newId();
		await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Awa Sawadogo', '+22670445566')`, [
			ownerId,
			organizationId
		]);
		const { unit } = await propertyWithUnit(c, organizationId, ownerId);
		const tenant = await insertTenant(c, organizationId);
		return insertLease(c, organizationId, unit, tenant);
	});
}

async function dueId(c: pg.Client, organizationId: string, leaseId: string, periodStart: string): Promise<string> {
	const r = await c.query(`select id from rent_dues where organization_id = $1 and lease_id = $2 and period_start = $3`, [
		organizationId,
		leaseId,
		periodStart
	]);
	return r.rows[0].id as string;
}

/** Force les contrôles différés (invariant des imputations) avant la fin de la transaction. */
async function checkDeferred(c: pg.Client): Promise<void> {
	await c.query('set constraints all immediate');
	await c.query('set constraints all deferred');
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A encaissements');
	b = await createOrg(t, 'agency', 'Agence B encaissements');
	owner = await connect(process.env.DATABASE_MIGRATION_URL!);
	api = await apiSql();
	for (const [org, prefix] of [
		[a, 'AGA'],
		[b, 'AGB']
	] as const) {
		await seed(org.id, (c) => c.query(`update organizations set receipt_prefix = $2 where id = $1`, [org.id, prefix]));
	}
});
afterAll(async () => {
	await api.end();
	await owner.end();
	await t.close();
});

describe('accès croisé A/B en SQL (règle 1)', () => {
	const tables = ['payments', 'payment_allocations', 'receipts', 'receipt_counters', 'receipt_tokens'];
	let inB: { lease: string; payment: string; receipt: string; due: string; verification: string; share: string };
	let leaseA: string;

	beforeAll(async () => {
		const lease = await newLease(b.id);
		inB = await seed(b.id, async (c) => {
			await insertDue(c, b.id, lease, '2027-01-01');
			const due = await dueId(c, b.id, lease, '2027-01-01');
			const payment = await insertPayment(c, b.id, lease, { confirmedBy: b.director.userId });
			await allocate(c, b.id, payment, lease, [{ target: 'rent_due', rentDueId: due, amount: 80_000 }]);
			const receipt = await insertReceipt(c, b.id, payment);
			await validateReceipt(c, b.id, receipt);
			return {
				lease,
				payment,
				receipt,
				due,
				verification: await insertToken(c, b.id, receipt, 'verification'),
				share: await insertToken(c, b.id, receipt, 'share')
			};
		});
		leaseA = await newLease(a.id);
	});

	it('A ne lit aucune ligne de B, dans aucune des cinq tables ; B voit les siennes', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			for (const table of tables) {
				const r = await api.query(`select count(*)::int as n from ${table} where organization_id = $1`, [b.id]);
				expect(r.rows[0].n, table).toBe(0);
			}
		});
		await inContext(api, { organizationId: b.id }, async () => {
			for (const table of tables) {
				const r = await api.query(`select count(*)::int as n from ${table} where organization_id = $1`, [b.id]);
				expect(r.rows[0].n, table).toBeGreaterThan(0);
			}
		});
	});

	it('A ne modifie rien chez B (aucune ligne touchée)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await api.query(`update payments set status = 'cancelled' where id = $1`, [inB.payment])).rowCount).toBe(0);
			expect((await api.query(`update receipts set pdf_a6_key = 'x' where id = $1`, [inB.receipt])).rowCount).toBe(0);
			expect(
				(
					await api.query(`update receipt_tokens set revoked_at = now(), revoked_by = $2 where receipt_id = $1`, [
						inB.receipt,
						a.director.userId
					])
				).rowCount
			).toBe(0);
		});
	});

	it('A ne référence rien de B : bail, échéance, encaissement, reçu (clés composites)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const lease = await sqlError(
				api,
				`insert into payments (id, organization_id, lease_id, tenant_id, purpose, amount, method, paid_on, status, idempotency_key)
				 values ($1, $2, $3, $4, 'rent', 1000, 'cash', current_date, 'to_validate', 'x')`,
				[newId(), a.id, inB.lease, newId()]
			);
			expect(lease.code).toBe('23503');
			const payment = await insertPayment(api, a.id, leaseA, { confirmedBy: a.director.userId });
			const due = await sqlError(
				api,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, rent_due_id, direction, amount)
				 values ($1, $2, $3, $4, 'rent_due', $5, 'allocate', 1000)`,
				[newId(), a.id, payment, leaseA, inB.due]
			);
			expect(due.code).toBe('23503');
			const foreignPayment = await sqlError(
				api,
				`insert into receipts (id, organization_id, payment_id, provisional_number) values ($1, $2, $3, 'PROV-ABCDEF')`,
				[newId(), a.id, inB.payment]
			);
			expect(foreignPayment.code).toBe('23503');
			const foreignReceipt = await sqlError(
				api,
				`insert into receipt_tokens (id, organization_id, receipt_id, kind, token_hash) values ($1, $2, $3, 'share', $4)`,
				[newId(), a.id, inB.receipt, sha256('x'.repeat(43))]
			);
			expect(foreignReceipt.code).toBe('23503');
		});
	});

	it('un jeton de vérification de B ne révèle que les cinq informations de son reçu ; un jeton inconnu ou de partage, rien', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const r = await api.query(`select * from receipt_verification($1)`, [sha256(inB.verification)]);
			expect(r.fields.map((f) => f.name)).toEqual(['organization_name', 'number', 'issued_on', 'amount', 'status']);
			expect(r.rows).toEqual([
				{
					organization_name: 'Test',
					number: 'AGB-2027-000001',
					issued_on: new Date('2027-01-05T00:00:00Z'),
					amount: '80000',
					status: 'valid'
				}
			]);
			expect((await api.query(`select * from receipt_verification($1)`, [sha256(inB.share)])).rows).toEqual([]);
			expect((await api.query(`select * from receipt_verification($1)`, [sha256('inconnu'.repeat(7))])).rows).toEqual([]);
		});
	});

	it('lien partagé : seulement l’organisation et le reçu, jamais après révocation', async () => {
		const target = await api.query(`select * from receipt_share_target($1)`, [sha256(inB.share)]);
		expect(target.rows).toEqual([{ organization_id: b.id, receipt_id: inB.receipt }]);
		expect((await api.query(`select * from receipt_share_target($1)`, [sha256(inB.verification)])).rows).toEqual([]);
		await seed(b.id, (c) =>
			c.query(`update receipt_tokens set revoked_at = now(), revoked_by = $2 where token_hash = $1`, [sha256(inB.share), b.director.userId])
		);
		expect((await api.query(`select * from receipt_share_target($1)`, [sha256(inB.share)])).rows).toEqual([]);
		await inContext(api, { organizationId: b.id }, async () => {
			const again = await sqlError(api, `update receipt_tokens set revoked_at = now(), revoked_by = $2 where token_hash = $1`, [
				sha256(inB.share),
				b.director.userId
			]);
			expect(again.message).toContain('RECEIPT_TOKEN_REVOKED');
			const verification = await sqlError(api, `update receipt_tokens set revoked_at = now(), revoked_by = $2 where token_hash = $1`, [
				sha256(inB.verification),
				b.director.userId
			]);
			expect(verification.code).toBe('23514');
		});
	});

	it('le jeton lui-même n’est jamais gardé : seulement son empreinte de 32 octets', async () => {
		const cols = await owner.query(
			`select column_name, data_type from information_schema.columns where table_name = 'receipt_tokens' order by ordinal_position`
		);
		expect(cols.rows.map((r) => r.column_name)).not.toContain('token');
		expect(cols.rows.find((r) => r.column_name === 'token_hash')?.data_type).toBe('bytea');
	});
});

describe('ajout seul (règle 3)', () => {
	let lease: string;
	let payment: string;
	let receipt: string;
	beforeAll(async () => {
		lease = await newLease(a.id);
		({ payment, receipt } = await seed(a.id, async (c) => {
			const p = await confirmedCreditPayment(c, a.id, lease, a.director.userId);
			const r = await insertReceipt(c, a.id, p);
			await validateReceipt(c, a.id, r);
			// Une ligne par table : les triggers d'ajout seul sont des triggers de ligne.
			await insertToken(c, a.id, r, 'verification');
			return { payment: p, receipt: r };
		}));
	});

	it('UPDATE du montant refusé : au rôle de l’API (droit), au propriétaire du schéma (trigger)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update payments set amount = 1 where id = $1`, [payment])).code).toBe('42501');
			expect((await sqlError(api, `update payment_allocations set amount = 1 where payment_id = $1`, [payment])).code).toBe('42501');
			expect((await sqlError(api, `update receipts set number = 'AGA-2027-999999' where id = $1`, [receipt])).code).toBe('42501');
		});
		await inContext(owner, { organizationId: a.id }, async () => {
			expect((await sqlError(owner, `update payments set amount = 1 where id = $1`, [payment])).message).toContain(
				'PAYMENT_AMOUNT_IMMUTABLE'
			);
			expect((await sqlError(owner, `update payments set paid_on = '2020-01-01' where id = $1`, [payment])).message).toContain(
				'PAYMENT_IMMUTABLE'
			);
			expect((await sqlError(owner, `update payment_allocations set amount = 1 where payment_id = $1`, [payment])).message).toContain(
				'APPEND_ONLY'
			);
			expect((await sqlError(owner, `update receipts set number = 'AGA-2027-999999' where id = $1`, [receipt])).message).toContain(
				'RECEIPT_IMMUTABLE'
			);
			expect((await sqlError(owner, `update receipts set snapshot = '{}' where id = $1`, [receipt])).message).toContain(
				'RECEIPT_IMMUTABLE'
			);
		});
	});

	it('DELETE et TRUNCATE refusés, même au propriétaire du schéma', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			for (const table of ['payments', 'payment_allocations', 'receipts', 'receipt_tokens', 'receipt_counters']) {
				expect((await sqlError(api, `delete from ${table} where organization_id = $1`, [a.id])).code, table).toBe('42501');
			}
		});
		await inContext(owner, { organizationId: a.id }, async () => {
			for (const table of ['payments', 'payment_allocations', 'receipts', 'receipt_tokens', 'receipt_counters']) {
				expect((await sqlError(owner, `delete from ${table} where organization_id = $1`, [a.id])).message, table).toContain('APPEND_ONLY');
				expect((await sqlError(owner, `truncate ${table} cascade`)).message, table).toContain('APPEND_ONLY');
			}
		});
	});

	it('l’application n’écrit jamais un compteur de reçus', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update receipt_counters set next_sequence = 1 where organization_id = $1`, [a.id])).code).toBe('42501');
			expect(
				(await sqlError(api, `insert into receipt_counters (organization_id, year, next_sequence) values ($1, 2031, 1)`, [a.id])).code
			).toBe('42501');
		});
	});
});

describe('machine d’états (règle 6)', () => {
	let lease: string;
	beforeAll(async () => {
		lease = await newLease(a.id);
	});

	it('la base autorise exactement les transitions de packages/shared', async () => {
		for (const from of PAYMENT_STATUSES) {
			for (const to of PAYMENT_STATUSES) {
				const r = await api.query(`select payment_transition_allowed($1, $2) as ok`, [from, to]);
				expect(r.rows[0].ok, `${from} → ${to}`).toBe(PAYMENT_TRANSITIONS[from].includes(to));
			}
		}
	});

	it('transition interdite refusée (à rapprocher → échoué ; confirmé → à valider)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const mm = await insertPayment(api, a.id, lease, { method: 'mobile_money_manual' });
			expect((await sqlError(api, `update payments set status = 'failed' where id = $1`, [mm])).message).toContain(
				'PAYMENT_TRANSITION_FORBIDDEN'
			);
			const cash = await insertPayment(api, a.id, lease, { confirmedBy: a.director.userId });
			expect((await sqlError(api, `update payments set status = 'to_validate' where id = $1`, [cash])).message).toContain(
				'PAYMENT_TRANSITION_FORBIDDEN'
			);
		});
	});

	it('statut de saisie cohérent avec le moyen : jamais confirmé sans preuve', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			for (const [method, status] of [
				['mobile_money_manual', 'confirmed'],
				['bank_transfer', 'confirmed'],
				['cash', 'to_reconcile'],
				['cash', 'cancelled'],
				['mobile_money_direct', 'confirmed']
			] as const) {
				const e = await sqlError(
					api,
					`insert into payments (id, organization_id, lease_id, purpose, amount, method, operator, transaction_reference, paid_on, status,
						idempotency_key, confirmed_at, confirmed_by)
					 values ($1, $2, $3, 'rent', 1000, $4, $5, $6, current_date, $7, $9, now(), $8)`,
					[
						newId(),
						a.id,
						lease,
						method,
						method === 'cash' || method === 'bank_transfer' ? null : 'orange_money',
						method === 'cash' ? null : 'REF1',
						status,
						a.director.userId,
						newId()
					]
				);
				expect(e.message, `${method} ${status}`).toMatch(/PAYMENT_INITIAL_STATUS|payments_cancelled/);
			}
		});
	});

	it('validation : auteur et date exigés ; écrits une seule fois ; le locataire vient du bail', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, lease, { status: 'to_validate' });
			expect((await sqlError(api, `update payments set status = 'confirmed' where id = $1`, [p])).message).toContain(
				'PAYMENT_CONFIRMED_BY'
			);
			await api.query(`update payments set status = 'confirmed', confirmed_at = now(), confirmed_by = $2 where id = $1`, [
				p,
				a.director.userId
			]);
			expect((await sqlError(api, `update payments set confirmed_at = now() - interval '1 day' where id = $1`, [p])).message).toContain(
				'PAYMENT_IMMUTABLE'
			);
			const tenant = await api.query(
				`select p.tenant_id = l.tenant_id as same from payments p join leases l on l.id = p.lease_id where p.id = $1`,
				[p]
			);
			expect(tenant.rows[0].same).toBe(true);
		});
	});

	it('jamais d’encaissement sur un bail brouillon', async () => {
		const draft = await seed(a.id, async (c) => {
			const ownerId = newId();
			await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Awa', '+22670445566')`, [
				ownerId,
				a.id
			]);
			const { unit } = await propertyWithUnit(c, a.id, ownerId);
			return insertLease(c, a.id, unit, await insertTenant(c, a.id), { status: 'draft' });
		});
		await inContext(api, { organizationId: a.id }, async () => {
			await api.query('savepoint s');
			await expect(insertPayment(api, a.id, draft, { status: 'to_validate' })).rejects.toThrow(/PAYMENT_LEASE_NOT_VALIDATED/);
			await api.query('rollback to savepoint s');
		});
	});
});

describe('doublon Mobile Money (point b)', () => {
	let lease: string;
	beforeAll(async () => {
		lease = await newLease(a.id);
	});

	it('même opérateur, même référence normalisée : refusé ; autre opérateur : permis ; après annulation : permis', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const first = await insertPayment(api, a.id, lease, {
				method: 'mobile_money_manual',
				operator: 'orange_money',
				reference: 'MP231116.1234.A12'
			});
			await api.query('savepoint s');
			await expect(
				insertPayment(api, a.id, lease, { method: 'mobile_money_manual', operator: 'orange_money', reference: ' mp 2311161234-a12 ' })
			).rejects.toMatchObject({ code: '23505', constraint: 'payments_mobile_money_reference' });
			await api.query('rollback to savepoint s');
			await insertPayment(api, a.id, lease, { method: 'mobile_money_manual', operator: 'moov_money', reference: 'MP231116.1234.A12' });
			await api.query(
				`update payments set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Erreur de saisie' where id = $1`,
				[first, a.director.userId]
			);
			await insertPayment(api, a.id, lease, { method: 'mobile_money_manual', operator: 'orange_money', reference: 'MP2311161234A12' });
		});
	});

	it('la référence normalisée par la base est celle de packages/shared', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, lease, { method: 'mobile_money_manual', reference: ' ab-12.cd/34_ef 5 ' });
			expect((await api.query(`select reference_key from payments where id = $1`, [p])).rows[0].reference_key).toBe('AB12CD34EF5');
		});
	});

	it('une autre organisation peut saisir la même référence', async () => {
		const leaseB = await newLease(b.id);
		await inContext(api, { organizationId: a.id }, () =>
			insertPayment(api, a.id, lease, { method: 'mobile_money_manual', reference: 'SAME-REF-1' })
		);
		await inContext(api, { organizationId: b.id }, () =>
			insertPayment(api, b.id, leaseB, { method: 'mobile_money_manual', reference: 'SAME-REF-1' })
		);
	});
});

describe('imputations', () => {
	let lease: string;
	let jan: string;
	let feb: string;
	beforeAll(async () => {
		lease = await newLease(a.id);
		({ jan, feb } = await seed(a.id, async (c) => {
			await insertDue(c, a.id, lease, '2027-01-01');
			await insertDue(c, a.id, lease, '2027-02-01');
			return { jan: await dueId(c, a.id, lease, '2027-01-01'), feb: await dueId(c, a.id, lease, '2027-02-01') };
		}));
	});

	const paid = async (id: string) => Number((await api.query(`select amount_paid from rent_dues where id = $1`, [id])).rows[0].amount_paid);

	it('le montant payé d’une échéance suit les imputations ; jamais saisi', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, lease, { amount: 120_000, confirmedBy: a.director.userId });
			await allocate(api, a.id, p, lease, [
				{ target: 'rent_due', rentDueId: jan, amount: 80_000 },
				{ target: 'rent_due', rentDueId: feb, amount: 40_000 }
			]);
			expect([await paid(jan), await paid(feb)]).toEqual([80_000, 40_000]);
			await checkDeferred(api);
			expect((await sqlError(api, `update rent_dues set amount_paid = 0 where id = $1`, [jan])).message).toContain(
				'RENT_DUE_PAID_BY_ALLOCATIONS'
			);
		});
	});

	it('une échéance ne reçoit jamais plus que son montant', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, lease, { amount: 90_000, confirmedBy: a.director.userId });
			const e = await sqlError(
				api,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, rent_due_id, direction, amount)
				 values ($1, $2, $3, $4, 'rent_due', $5, 'allocate', 90000)`,
				[newId(), a.id, p, lease, jan]
			);
			expect(e.code).toBe('23514');
		});
	});

	it('à la validation : un encaissement confirmé impute exactement son montant ; en attente, rien', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, lease, { amount: 80_000, confirmedBy: a.director.userId });
			await allocate(api, a.id, p, lease, [{ target: 'rent_due', rentDueId: jan, amount: 70_000 }]);
			expect((await sqlError(api, 'set constraints all immediate')).message).toContain('PAYMENT_ALLOCATION_MISMATCH');
		});
		await inContext(api, { organizationId: a.id }, async () => {
			await insertPayment(api, a.id, lease, { amount: 80_000, confirmedBy: a.director.userId });
			expect((await sqlError(api, 'set constraints all immediate')).message).toContain('PAYMENT_ALLOCATION_MISMATCH');
		});
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, lease, { status: 'to_validate' });
			const e = await sqlError(
				api,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, direction, amount) values ($1, $2, $3, $4, 'credit', 'allocate', 80000)`,
				[newId(), a.id, p, lease]
			);
			expect(e.message).toContain('ALLOCATION_NOT_CONFIRMED');
		});
	});

	it('validation d’espèces à valider : statut et imputations dans la même transaction', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, lease, { status: 'to_validate', amount: 80_000 });
			await checkDeferred(api);
			await api.query(`update payments set status = 'confirmed', confirmed_at = now(), confirmed_by = $2 where id = $1`, [
				p,
				a.director.userId
			]);
			await allocate(api, a.id, p, lease, [{ target: 'rent_due', rentDueId: jan, amount: 80_000 }]);
			await checkDeferred(api);
			expect(await paid(jan)).toBe(80_000);
		});
	});

	it('contre-écriture : imputations inverses, échéance ressoldée à zéro, encaissement net nul', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, lease, { amount: 100_000, confirmedBy: a.director.userId });
			await allocate(api, a.id, p, lease, [
				{ target: 'rent_due', rentDueId: jan, amount: 80_000 },
				{ target: 'credit', amount: 20_000 }
			]);
			await checkDeferred(api);
			const reversal = await cancelPayment(api, a.id, p, a.director.userId);
			await checkDeferred(api);
			expect(await paid(jan)).toBe(0);
			const net = await api.query(
				`select sum(case direction when 'allocate' then amount else -amount end)::int as net from payment_allocations where payment_id = $1`,
				[p]
			);
			expect(net.rows[0].net).toBe(0);
			const r = await api.query(`select kind, reverses_payment_id, amount::int, status from payments where id = $1`, [reversal]);
			expect(r.rows[0]).toEqual({ kind: 'reversal', reverses_payment_id: p, amount: 100_000, status: 'confirmed' });
			// Une seule contre-écriture ; on ne contrepasse pas plus que l'imputé ; une contre-écriture ne se modifie pas.
			const twice = await sqlError(
				api,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, direction, amount) values ($1, $2, $3, $4, 'credit', 'reverse', 1)`,
				[newId(), a.id, p, lease]
			);
			expect(twice.message).toContain('ALLOCATION_NEGATIVE');
			expect((await sqlError(api, `update payments set status = 'cancelled' where id = $1`, [reversal])).message).toMatch(
				/PAYMENT_IMMUTABLE|payments_cancelled/
			);
		});
	});

	it('jamais d’imputation sur une échéance abandonnée ni sur une échéance d’un autre bail', async () => {
		const other = await newLease(a.id);
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, other, { amount: 1_000, confirmedBy: a.director.userId });
			const e = await sqlError(
				api,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, rent_due_id, direction, amount) values ($1, $2, $3, $4, 'rent_due', $5, 'allocate', 1000)`,
				[newId(), a.id, p, other, feb]
			);
			expect(e.message).toContain('ALLOCATION_LEASE');
			await api.query(`update rent_dues set status = 'waived' where id = $1`, [feb]);
			const p2 = await insertPayment(api, a.id, lease, { amount: 1_000, confirmedBy: a.director.userId });
			const waived = await sqlError(
				api,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, rent_due_id, direction, amount) values ($1, $2, $3, $4, 'rent_due', $5, 'allocate', 1000)`,
				[newId(), a.id, p2, lease, feb]
			);
			expect(waived.message).toContain('ALLOCATION_DUE_WAIVED');
		});
	});
});

describe('caution : versements par encaissement (règle 14)', () => {
	let lease: string;
	let account: string;
	beforeAll(async () => {
		lease = await newLease(a.id);
		account = await seed(a.id, (c) => insertDepositAccount(c, a.id, lease, { agreed: 150_000 }));
	});

	const movements = async () =>
		(
			await api.query(`select type, amount::int, payment_id from deposit_movements where account_id = $1 order by created_at, type`, [
				account
			])
		).rows;
	const status = async () => (await api.query(`select status from deposit_accounts where id = $1`, [account])).rows[0].status as string;

	it('versement en deux fois : deux mouvements `received` liés à leur encaissement, statut suivi', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const p1 = await insertPayment(api, a.id, lease, {
				purpose: 'deposit',
				depositAccountId: account,
				amount: 100_000,
				confirmedBy: a.director.userId
			});
			await allocate(api, a.id, p1, lease, [{ target: 'deposit_account', depositAccountId: account, amount: 100_000 }]);
			expect(await status()).toBe('partially_received');
			const p2 = await insertPayment(api, a.id, lease, {
				purpose: 'deposit',
				depositAccountId: account,
				amount: 50_000,
				confirmedBy: a.director.userId
			});
			await allocate(api, a.id, p2, lease, [{ target: 'deposit_account', depositAccountId: account, amount: 50_000 }]);
			await checkDeferred(api);
			expect(await movements()).toEqual([
				{ type: 'received', amount: 100_000, payment_id: p1 },
				{ type: 'received', amount: 50_000, payment_id: p2 }
			]);
			expect(await status()).toBe('held');
			// Au-delà du convenu : refusé.
			const p3 = await insertPayment(api, a.id, lease, {
				purpose: 'deposit',
				depositAccountId: account,
				amount: 1,
				confirmedBy: a.director.userId
			});
			const over = await sqlError(
				api,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, deposit_account_id, direction, amount) values ($1, $2, $3, $4, 'deposit_account', $5, 'allocate', 1)`,
				[newId(), a.id, p3, lease, account]
			);
			expect(over.message).toContain('DEPOSIT_OVERPAID');
		});
	});

	it('annulation d’un versement : `received_cancelled`, statut recalculé ; refusée sous les sorties déjà faites', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const p1 = await insertPayment(api, a.id, lease, {
				purpose: 'deposit',
				depositAccountId: account,
				amount: 100_000,
				confirmedBy: a.director.userId
			});
			await allocate(api, a.id, p1, lease, [{ target: 'deposit_account', depositAccountId: account, amount: 100_000 }]);
			const p2 = await insertPayment(api, a.id, lease, {
				purpose: 'deposit',
				depositAccountId: account,
				amount: 50_000,
				confirmedBy: a.director.userId
			});
			await allocate(api, a.id, p2, lease, [{ target: 'deposit_account', depositAccountId: account, amount: 50_000 }]);
			await cancelPayment(api, a.id, p2, a.director.userId);
			await checkDeferred(api);
			expect((await movements()).at(-1)).toEqual({ type: 'received_cancelled', amount: 50_000, payment_id: p2 });
			expect(await status()).toBe('partially_received');
			// Restitution de 80 000 : annuler le versement de 100 000 ferait passer le reçu (0) sous les sorties (80 000).
			await insertMovement(api, a.id, account, 'refunded', 80_000);
			await api.query('savepoint s');
			await expect(cancelPayment(api, a.id, p1, a.director.userId)).rejects.toThrow(/DEPOSIT_CANCELLATION_BELOW_OUTFLOWS/);
			await api.query('rollback to savepoint s');
		});
	});

	it('un encaissement de loyer ne s’impute pas sur une caution, ni l’inverse', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const rent = await insertPayment(api, a.id, lease, { amount: 1_000, confirmedBy: a.director.userId });
			const e = await sqlError(
				api,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, deposit_account_id, direction, amount) values ($1, $2, $3, $4, 'deposit_account', $5, 'allocate', 1000)`,
				[newId(), a.id, rent, lease, account]
			);
			expect(e.message).toContain('ALLOCATION_PURPOSE');
			const deposit = await insertPayment(api, a.id, lease, {
				purpose: 'deposit',
				depositAccountId: account,
				amount: 1_000,
				confirmedBy: a.director.userId
			});
			const credit = await sqlError(
				api,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, direction, amount) values ($1, $2, $3, $4, 'credit', 'allocate', 1000)`,
				[newId(), a.id, deposit, lease]
			);
			expect(credit.message).toContain('ALLOCATION_PURPOSE');
		});
	});
});

describe('reçus et numérotation (règle 9)', () => {
	let c: Org;
	let lease: string;
	beforeAll(async () => {
		c = await createOrg(t, 'agency', 'Agence C numérotation');
		lease = await newLease(c.id);
	});

	it('sans préfixe : refusé ; un reçu naît provisoire, sans numéro ; le numéro vient de la base', async () => {
		await inContext(api, { organizationId: c.id }, async () => {
			const p = await confirmedCreditPayment(api, c.id, lease, c.director.userId);
			const r = await insertReceipt(api, c.id, p);
			await api.query('savepoint s');
			await expect(validateReceipt(api, c.id, r)).rejects.toThrow(/RECEIPT_PREFIX_MISSING/);
			await api.query('rollback to savepoint s');
			const forged = await sqlError(
				api,
				`insert into receipts (id, organization_id, payment_id, provisional_number, number) values ($1, $2, $3, 'PROV-ABCDEF', 'X')`,
				[newId(), c.id, await confirmedCreditPayment(api, c.id, lease, c.director.userId)]
			);
			expect(forged.message).toContain('RECEIPT_NUMBER_BY_SERVER');
		});
	});

	it('jamais numéroté avant la confirmation de l’encaissement ; lease et objet recopiés de l’encaissement', async () => {
		await seed(c.id, (x) => x.query(`update organizations set receipt_prefix = 'AGC' where id = $1`, [c.id]));
		await inContext(api, { organizationId: c.id }, async () => {
			const p = await insertPayment(api, c.id, lease, { status: 'to_validate' });
			const r = await insertReceipt(api, c.id, p);
			await api.query('savepoint s');
			await expect(validateReceipt(api, c.id, r)).rejects.toThrow(/RECEIPT_PAYMENT_NOT_CONFIRMED/);
			await api.query('rollback to savepoint s');
			const row = (await api.query(`select lease_id, purpose, status, number from receipts where id = $1`, [r])).rows[0];
			expect(row).toEqual({ lease_id: lease, purpose: 'rent', status: 'provisional', number: null });
		});
	});

	it('premier numéro du carnet papier : une seule fois, avant le premier reçu ; préfixe figé ensuite', async () => {
		await inContext(api, { organizationId: c.id }, async () => {
			await api.query(`select set_receipt_first_number(2027, 124, $1)`, [c.director.userId]);
			expect((await sqlError(api, `select set_receipt_first_number(2027, 200, $1)`, [c.director.userId])).message).toContain(
				'RECEIPT_FIRST_NUMBER_ALREADY_SET'
			);
			const p = await confirmedCreditPayment(api, c.id, lease, c.director.userId);
			const r = await insertReceipt(api, c.id, p);
			expect(await validateReceipt(api, c.id, r)).toBe('AGC-2027-000124');
			const p2 = await confirmedCreditPayment(api, c.id, lease, c.director.userId);
			expect(await validateReceipt(api, c.id, await insertReceipt(api, c.id, p2))).toBe('AGC-2027-000125');
			// L'année suivante repart de 1.
			const p3 = await confirmedCreditPayment(api, c.id, lease, c.director.userId);
			expect(await validateReceipt(api, c.id, await insertReceipt(api, c.id, p3), '2028-01-02')).toBe('AGC-2028-000001');
			await checkDeferred(api);
			expect((await sqlError(api, `update organizations set receipt_prefix = 'NEW' where id = $1`, [c.id])).message).toContain(
				'RECEIPT_PREFIX_LOCKED'
			);
			expect((await sqlError(api, `select set_receipt_first_number(2027, 1, $1)`, [c.director.userId])).message).toContain(
				'RECEIPT_FIRST_NUMBER_LOCKED'
			);
			expect((await sqlError(api, `update organizations set receipt_numbering_started_at = null where id = $1`, [c.id])).message).toContain(
				'RECEIPT_NUMBERING_STARTED'
			);
		});
	});

	it('après le premier reçu, seul le back-office (app_admin) change le préfixe', async () => {
		await seed(c.id, async (x) => {
			await x.query(`update organizations set receipt_prefix = coalesce(receipt_prefix, 'AGC') where id = $1`, [c.id]);
			const p = await confirmedCreditPayment(x, c.id, lease, c.director.userId);
			await validateReceipt(x, c.id, await insertReceipt(x, c.id, p));
		});
		const admin = await connect(process.env.DATABASE_ADMIN_URL!);
		try {
			await inContext(admin, { organizationId: c.id }, async () => {
				expect((await admin.query(`update organizations set receipt_prefix = 'AGCX' where id = $1`, [c.id])).rowCount).toBe(1);
			});
		} finally {
			await admin.end();
		}
	});

	it('un reçu annulé garde son numéro ; il ne s’annule qu’avec son encaissement', async () => {
		await inContext(api, { organizationId: c.id }, async () => {
			const p = await confirmedCreditPayment(api, c.id, lease, c.director.userId);
			const r = await insertReceipt(api, c.id, p);
			const number = await validateReceipt(api, c.id, r);
			expect((await sqlError(api, `update receipts set status = 'cancelled', cancelled_at = now() where id = $1`, [r])).message).toContain(
				'RECEIPT_CANCELLED_WITH_PAYMENT'
			);
			await cancelPayment(api, c.id, p, c.director.userId);
			await api.query(`update receipts set status = 'cancelled', cancelled_at = now() where id = $1`, [r]);
			expect((await api.query(`select number, status from receipts where id = $1`, [r])).rows[0]).toEqual({ number, status: 'cancelled' });
			expect((await sqlError(api, `update receipts set status = 'valid' where id = $1`, [r])).message).toContain(
				'RECEIPT_TRANSITION_FORBIDDEN'
			);
			await checkDeferred(api);
		});
	});
});

describe('1 000 confirmations concurrentes : numérotation sans trou ni doublon (règle 9)', () => {
	const COUNT = 1_000;
	const WORKERS = 24;
	let org: Org;
	let receiptIds: string[];

	beforeAll(async () => {
		org = await createOrg(t, 'agency', 'Agence numérotation concurrente');
		const lease = await newLease(org.id);
		receiptIds = await seed(org.id, async (c) => {
			await c.query(`update organizations set receipt_prefix = 'CONC' where id = $1`, [org.id]);
			const ids: string[] = [];
			for (let i = 0; i < COUNT; i += 1) {
				const p = await confirmedCreditPayment(c, org.id, lease, org.director.userId, 1_000 + i);
				ids.push(await insertReceipt(c, org.id, p));
			}
			return ids;
		});
	}, 120_000);

	it(`${COUNT} reçus validés en parallèle par ${WORKERS} connexions, dont des transactions annulées puis rejouées`, async () => {
		const queue = [...receiptIds];
		let rolledBack = 0;
		const worker = async () => {
			const c = await apiSql();
			try {
				for (let id = queue.shift(); id; id = queue.shift()) {
					// Une transaction sur vingt est annulée après avoir pris son numéro, puis rejouée : le numéro est rendu.
					for (const commit of id.endsWith('0') && rolledBack < COUNT / 20 ? [false, true] : [true]) {
						await c.query('BEGIN');
						await c.query(`select set_config('app.organization_id', $1, true)`, [org.id]);
						await validateReceipt(c, org.id, id, '2027-03-01');
						await c.query(commit ? 'COMMIT' : 'ROLLBACK');
						if (!commit) rolledBack += 1;
					}
				}
			} finally {
				await c.end();
			}
		};
		await Promise.all(Array.from({ length: WORKERS }, worker));
		expect(rolledBack).toBeGreaterThan(0);
		const r = await owner.query(
			`select sequence::int, number from receipts where organization_id = $1 and status = 'valid' order by sequence`,
			[org.id]
		);
		expect(r.rows.map((x) => x.sequence)).toEqual(Array.from({ length: COUNT }, (_, i) => i + 1));
		expect(new Set(r.rows.map((x) => x.number)).size).toBe(COUNT);
		expect(r.rows[0].number).toBe('CONC-2027-000001');
		expect(r.rows.at(-1).number).toBe('CONC-2027-001000');
		const counter = await owner.query(`select next_sequence::int from receipt_counters where organization_id = $1 and year = 2027`, [
			org.id
		]);
		expect(counter.rows[0].next_sequence).toBe(COUNT + 1);
	}, 120_000);
});
