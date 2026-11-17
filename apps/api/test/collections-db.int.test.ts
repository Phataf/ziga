/**
 * Lot 10, étape 2 : relances, dépenses, relevés et reversements dans la base (migration 0017), en SQL, avec le rôle de
 * l'API (app_api, sans BYPASSRLS) et le propriétaire du schéma (triggers).
 * - Accès croisé A/B sur les sept tables : lire, modifier, référencer (règle 1) ; un jeton de relevé de A ne donne rien
 *   de B ; jeton expiré ou révoqué refusé.
 * - Ajout seul : relances, éléments consommés, reversements ; dépense et relevé émis jamais modifiés (règles 3 et 16).
 * - Dépenses : les six combinaisons de packages/shared, bail exigé, bailleur particulier ; encaissement « dépense »
 *   imputé exactement, jamais en crédit ni au-delà (option A du porteur).
 * - Relevés : émis dans l'ordre des mois, mois terminé, rectificatif du dernier émis seulement, figé ; un élément
 *   n'entre qu'une fois ; reversements jamais au-delà du net.
 * - Listes de la base égales à celles de packages/shared.
 */
import { EXPENSE_BEARERS, EXPENSE_CATEGORIES, EXPENSE_COMBINATIONS, EXPENSE_PAYERS, EXPENSE_RECOVERIES } from '@ziga/shared/expenses';
import { newId } from '@ziga/shared/ids';
import { REMINDER_CHANNELS } from '@ziga/shared/reminders';
import { PAYOUT_METHODS, STATEMENT_ITEM_KINDS, statementItemKey } from '@ziga/shared/statements';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	insertExpense,
	insertLine,
	insertPayout,
	insertReminder,
	insertStatement,
	insertStatementToken,
	issueStatement
} from './collections.js';
import { startApp, type TestApp } from './http.js';
import { insertDue, insertLease, insertTenant } from './leases.js';
import { apiSql, createOrg, inContext, sqlError, type Org } from './orgs.js';
import { allocate, cancelPayment, insertPayment, sha256 } from './payments.js';
import { propertyWithUnit } from './properties.js';

let t: TestApp;
let a: Org;
let b: Org;
let landlord: Org;
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

/** Dans le contexte d'une organisation, avec le propriétaire du schéma ; tout est annulé à la fin. */
async function asOwner<T>(organizationId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
	return inContext(owner, { organizationId }, () => fn(owner));
}

interface World {
	owner: string;
	property: string;
	unit: string;
	tenant: string;
	lease: string;
	due: string;
	mandate: string;
}

/** Un propriétaire, un bien, une unité, un locataire, un bail en vigueur, une échéance de septembre 2026, un mandat. */
async function world(organizationId: string): Promise<World> {
	return seed(organizationId, async (c) => {
		const ownerId = newId();
		await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Awa Sawadogo', '+22670445566')`, [
			ownerId,
			organizationId
		]);
		const mandate = newId();
		await c.query(`insert into mandates (id, organization_id, owner_id, type, starts_on) values ($1, $2, $3, 'other', '2026-01-01')`, [
			mandate,
			organizationId,
			ownerId
		]);
		const { property, unit } = await propertyWithUnit(c, organizationId, ownerId);
		const tenant = await insertTenant(c, organizationId);
		const lease = await insertLease(c, organizationId, unit, tenant);
		await insertDue(c, organizationId, lease, '2026-09-01', { status: 'overdue' });
		const due = (await c.query(`select id from rent_dues where lease_id = $1 and period_start = '2026-09-01'`, [lease])).rows[0]
			.id as string;
		return { owner: ownerId, property, unit, tenant, lease, due, mandate };
	});
}

/** Encaissement de loyer confirmé et imputé sur l'échéance ; renvoie l'imputation. */
async function paidDue(c: pg.Client, org: Org, w: World, amount = 80_000): Promise<{ payment: string; allocation: string }> {
	const payment = await insertPayment(c, org.id, w.lease, { amount, confirmedBy: org.director.userId, paidOn: '2026-09-04' });
	await allocate(c, org.id, payment, w.lease, [{ target: 'rent_due', rentDueId: w.due, amount }]);
	const r = await c.query(`select id from payment_allocations where payment_id = $1`, [payment]);
	return { payment, allocation: r.rows[0].id as string };
}

/** Refus attendu, dans un point de sauvegarde : la transaction reste utilisable ensuite. Renvoie le message. */
async function fails(c: pg.Client, fn: () => Promise<unknown>): Promise<string> {
	await c.query('SAVEPOINT attendu');
	try {
		await fn();
	} catch (error) {
		await c.query('ROLLBACK TO SAVEPOINT attendu');
		return (error as Error).message;
	}
	throw new Error('Écriture acceptée alors qu’elle devait être refusée');
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A relevés');
	b = await createOrg(t, 'agency', 'Agence B relevés');
	landlord = await createOrg(t, 'landlord', 'Bailleur relevés');
	owner = await connect(process.env.DATABASE_MIGRATION_URL!);
	api = await apiSql();
});
afterAll(async () => {
	await api.end();
	await owner.end();
	await t.close();
});

// ---------------------------------------------------------------- accès croisé

describe('accès croisé A/B en SQL (règle 1)', () => {
	const tables = [
		'reminders',
		'reminder_settings',
		'expenses',
		'owner_statements',
		'owner_statement_lines',
		'owner_statement_tokens',
		'owner_payouts'
	];
	let wa: World;
	let wb: World;
	let inB: { expense: string; claim: string; statement: string; allocation: string; token: string; reminder: string; payout: string };

	beforeAll(async () => {
		wa = await world(a.id);
		wb = await world(b.id);
		inB = await seed(b.id, async (c) => {
			await c.query(
				`insert into reminder_settings (organization_id, template_1, template_2, template_3) values ($1, 'Bonjour {nom}, rappel', 'Bonjour {nom}, deuxième', 'Bonjour {nom}, dernier')`,
				[b.id]
			);
			const expense = await insertExpense(c, b.id, { propertyId: wb.property, unitId: wb.unit });
			const claim = await insertExpense(c, b.id, {
				propertyId: wb.property,
				leaseId: wb.lease,
				borneBy: 'tenant',
				recovery: 'claimed_from_tenant'
			});
			const { allocation } = await paidDue(c, b, wb);
			const statement = await insertStatement(c, b.id, wb.owner, '2026-09');
			await issueStatement(c, b.id, statement, b.director.userId);
			await insertLine(c, b.id, statement, { kind: 'allocation', allocationId: allocation });
			const token = await insertStatementToken(c, b.id, statement);
			const reminder = await insertReminder(c, b.id, wb.tenant, { dueIds: [wb.due] });
			const payout = await insertPayout(c, b.id, statement, wb.owner, 10_000);
			return { expense, claim, statement, allocation, token, reminder, payout };
		});
	});

	it('A ne lit aucune ligne de B, dans aucune des sept tables ; B voit les siennes', async () => {
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
			const updates: [string, unknown[]][] = [
				[`update reminder_settings set offset_1 = 2 where organization_id = $1`, [b.id]],
				[
					`update expenses set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Essai A' where id = $1`,
					[inB.expense, a.director.userId]
				],
				[
					`update owner_statement_tokens set revoked_at = now(), revoked_by = $2 where statement_id = $1`,
					[inB.statement, a.director.userId]
				],
				[`update owner_statements set pdf_key = 'x', pdf_generated_at = now() where id = $1`, [inB.statement]]
			];
			for (const [sql, params] of updates) expect((await api.query(sql, params)).rowCount, sql).toBe(0);
		});
	});

	it('A ne référence rien de B : locataire, échéance, bien, bail, dépense, propriétaire, relevé, imputation (clés composites)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const refused: [string, string, unknown[]][] = [
				[
					'relance d’un locataire de B',
					`insert into reminders (id, organization_id, tenant_id, rent_due_ids, channel, template_level) values ($1, $2, $3, $4, 'call', null)`,
					[newId(), a.id, wb.tenant, [wa.due]]
				],
				[
					'dépense sur un bien de B',
					`insert into expenses (id, organization_id, property_id, spent_on, category, description, amount, paid_by, borne_by, recovery)
					 values ($1, $2, $3, '2026-09-01', 'tax', 'Taxe', 1000, 'organization', 'organization', 'none')`,
					[newId(), a.id, wb.property]
				],
				[
					'relevé d’un propriétaire de B',
					`insert into owner_statements (id, organization_id, owner_id, month, revision, rent_collected, charges_collected, collected,
						rent_collected_by_owner, charges_collected_by_owner, commission, expenses, carried_balance, net, snapshot)
					 values ($1, $2, $3, '2026-09', '00000000', 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}')`,
					[newId(), a.id, wb.owner]
				],
				[
					'lien vers un relevé de B',
					`insert into owner_statement_tokens (id, organization_id, statement_id, token_hash) values ($1, $2, $3, $4)`,
					[newId(), a.id, inB.statement, sha256('y'.repeat(43))]
				],
				[
					'reversement sur un relevé de B',
					`insert into owner_payouts (id, organization_id, owner_id, statement_id, amount, paid_on, method) values ($1, $2, $3, $4, 1000, '2026-10-01', 'cash')`,
					[newId(), a.id, wa.owner, inB.statement]
				]
			];
			for (const [label, sql, params] of refused) expect((await sqlError(api, sql, params)).code, label).toBe('23503');
			// Échéance de B dans une relance de A : introuvable sous la RLS, donc refusée par le trigger.
			const due = await sqlError(
				api,
				`insert into reminders (id, organization_id, tenant_id, rent_due_ids, channel, template_level) values ($1, $2, $3, $4, 'call', null)`,
				[newId(), a.id, wa.tenant, [wb.due]]
			);
			expect(due.message).toContain('REMINDER_SUBJECT_INVALID');
			// Encaissement d'une dépense de B.
			const foreignClaim = await sqlError(
				api,
				`insert into payments (id, organization_id, lease_id, tenant_id, purpose, expense_id, amount, method, paid_on, status, idempotency_key)
				 values ($1, $2, $3, $4, 'expense', $5, 1000, 'cash', current_date, 'to_validate', 'x')`,
				[newId(), a.id, wa.lease, wa.tenant, inB.claim]
			);
			expect(foreignClaim.code).toBe('23503');
			// Élément d'un relevé de A qui pointerait vers une imputation ou une dépense de B.
			const statement = await insertStatement(api, a.id, wa.owner, '2026-09');
			await issueStatement(api, a.id, statement, a.director.userId);
			const line = await sqlError(
				api,
				`insert into owner_statement_lines (id, organization_id, statement_id, kind, role, allocation_id) values ($1, $2, $3, 'allocation', 'line', $4)`,
				[newId(), a.id, statement, inB.allocation]
			);
			expect(line.code).toBe('23503');
			const expense = await sqlError(
				api,
				`insert into owner_statement_lines (id, organization_id, statement_id, kind, role, expense_id) values ($1, $2, $3, 'expense', 'line', $4)`,
				[newId(), a.id, statement, inB.expense]
			);
			expect(expense.code).toBe('23503');
		});
	});

	it('lien /s : un jeton de B ne donne que l’organisation et le relevé de B ; jamais après révocation ou expiration', async () => {
		const target = await api.query(`select * from statement_share_target($1)`, [sha256(inB.token)]);
		expect(target.fields.map((f) => f.name)).toEqual(['organization_id', 'statement_id']);
		expect(target.rows).toEqual([{ organization_id: b.id, statement_id: inB.statement }]);
		expect((await api.query(`select * from statement_share_target($1)`, [sha256('inconnu'.repeat(7))])).rows).toEqual([]);

		// Un lien de A ne mène jamais à B.
		const statementA = await seed(a.id, async (c) => {
			const s = await insertStatement(c, a.id, wa.owner, '2026-08');
			await issueStatement(c, a.id, s, a.director.userId);
			return s;
		});
		const tokenA = await seed(a.id, (c) => insertStatementToken(c, a.id, statementA));
		expect((await api.query(`select * from statement_share_target($1)`, [sha256(tokenA)])).rows).toEqual([
			{ organization_id: a.id, statement_id: statementA }
		]);

		// Expiré : un lien de 90 jours créé il y a 91 jours.
		const expired = await seed(a.id, async (c) => {
			const token = 'e'.repeat(43);
			await c.query(
				`insert into owner_statement_tokens (id, organization_id, statement_id, token_hash, created_at, expires_at)
				 values ($1, $2, $3, $4, now() - interval '91 days', now() - interval '1 day')`,
				[newId(), a.id, statementA, sha256(token)]
			);
			return token;
		});
		expect((await api.query(`select * from statement_share_target($1)`, [sha256(expired)])).rows).toEqual([]);
		// Jamais plus de 90 jours.
		await inContext(api, { organizationId: a.id }, async () => {
			const tooLong = await sqlError(
				api,
				`insert into owner_statement_tokens (id, organization_id, statement_id, token_hash, expires_at) values ($1, $2, $3, $4, now() + interval '91 days')`,
				[newId(), a.id, statementA, sha256('l'.repeat(43))]
			);
			expect(tooLong.code).toBe('23514');
		});

		// Révoqué : plus rien ; une révocation ne se réécrit pas.
		await seed(b.id, (c) =>
			c.query(`update owner_statement_tokens set revoked_at = now(), revoked_by = $2 where token_hash = $1`, [
				sha256(inB.token),
				b.director.userId
			])
		);
		expect((await api.query(`select * from statement_share_target($1)`, [sha256(inB.token)])).rows).toEqual([]);
		await inContext(api, { organizationId: b.id }, async () => {
			const again = await sqlError(api, `update owner_statement_tokens set revoked_at = now(), revoked_by = $2 where token_hash = $1`, [
				sha256(inB.token),
				b.director.userId
			]);
			expect(again.message).toContain('STATEMENT_TOKEN_REVOKED');
		});
	});

	it('le jeton lui-même n’est jamais gardé, et un brouillon ne se partage pas', async () => {
		const cols = await owner.query(
			`select column_name, data_type from information_schema.columns where table_name = 'owner_statement_tokens' order by ordinal_position`
		);
		expect(cols.rows.map((r) => r.column_name)).not.toContain('token');
		expect(cols.rows.find((r) => r.column_name === 'token_hash')?.data_type).toBe('bytea');
		await inContext(api, { organizationId: a.id }, async () => {
			const draft = await insertStatement(api, a.id, wa.owner, '2026-10');
			const r = await sqlError(
				api,
				`insert into owner_statement_tokens (id, organization_id, statement_id, token_hash) values ($1, $2, $3, $4)`,
				[newId(), a.id, draft, sha256('d'.repeat(43))]
			);
			expect(r.message).toContain('STATEMENT_NOT_ISSUED');
		});
	});
});

// ---------------------------------------------------------------- ajout seul

describe('ajout seul (règles 3, 4 et 16)', () => {
	let w: World;
	beforeAll(async () => {
		w = await world(a.id);
	});

	it('relances, éléments consommés et reversements : ni UPDATE ni DELETE ni TRUNCATE, même au propriétaire du schéma', async () => {
		await asOwner(a.id, async (c) => {
			const reminder = await insertReminder(c, a.id, w.tenant, { dueIds: [w.due] });
			await insertExpense(c, a.id, { propertyId: w.property });
			const { allocation } = await paidDue(c, a, w);
			const statement = await insertStatement(c, a.id, w.owner, '2026-09');
			await issueStatement(c, a.id, statement, a.director.userId);
			await insertLine(c, a.id, statement, { kind: 'allocation', allocationId: allocation });
			const payout = await insertPayout(c, a.id, statement, w.owner, 1_000);
			const cases: [string, string, unknown[]][] = [
				['reminders', `update reminders set note = 'x' where id = $1`, [reminder]],
				['reminders', `delete from reminders where id = $1`, [reminder]],
				['owner_statement_lines', `update owner_statement_lines set role = 'neutralized' where statement_id = $1`, [statement]],
				['owner_statement_lines', `delete from owner_statement_lines where statement_id = $1`, [statement]],
				['owner_payouts', `update owner_payouts set amount = 2 where id = $1`, [payout]],
				['owner_payouts', `delete from owner_payouts where id = $1`, [payout]],
				['owner_statements', `delete from owner_statements where id = $1`, [statement]],
				['expenses', `delete from expenses where organization_id = $1`, [a.id]]
			];
			for (const [table, sql, params] of cases) {
				const e = await sqlError(c, sql, params);
				expect(e.message, sql).toContain(`APPEND_ONLY: ${table}`);
			}
		});
	});

	it('TRUNCATE refusé sur les six tables en ajout seul, même au propriétaire du schéma', async () => {
		// Transaction sans écriture en attente : PostgreSQL refuse sinon TRUNCATE avant les triggers.
		await asOwner(a.id, async (c) => {
			for (const table of [
				'reminders',
				'expenses',
				'owner_statements',
				'owner_statement_lines',
				'owner_statement_tokens',
				'owner_payouts'
			]) {
				expect((await sqlError(c, `truncate ${table} cascade`)).message, table).toContain('APPEND_ONLY');
			}
		});
	});

	it('le rôle de l’API n’a pas les droits d’écriture (seules l’annulation et le justificatif d’une dépense)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const expense = await insertExpense(api, a.id, { propertyId: w.property });
			expect((await sqlError(api, `update expenses set amount = 1 where id = $1`, [expense])).code).toBe('42501');
			expect((await sqlError(api, `delete from expenses where id = $1`, [expense])).code).toBe('42501');
			expect((await sqlError(api, `update reminders set note = 'x'`)).code).toBe('42501');
			expect((await sqlError(api, `update owner_payouts set amount = 1`)).code).toBe('42501');
			expect((await sqlError(api, `update owner_statement_lines set role = 'line'`)).code).toBe('42501');
		});
	});

	it('une dépense ne se modifie pas ; elle s’annule une fois, avec un motif ; le justificatif s’ajoute une fois', async () => {
		await asOwner(a.id, async (c) => {
			const expense = await insertExpense(c, a.id, { propertyId: w.property });
			for (const sql of [
				`update expenses set amount = 20000 where id = $1`,
				`update expenses set borne_by = 'organization', recovery = 'none' where id = $1`,
				`update expenses set spent_on = '2026-09-01' where id = $1`
			]) {
				expect((await sqlError(c, sql, [expense])).message, sql).toContain('EXPENSE_IMMUTABLE');
			}
			expect((await sqlError(c, `update expenses set status = 'cancelled' where id = $1`, [expense])).message).toContain(
				'expenses_cancelled'
			);
			await c.query(
				`update expenses set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Doublon de saisie' where id = $1`,
				[expense, a.director.userId]
			);
			const again = await sqlError(c, `update expenses set cancellation_reason = 'Autre motif' where id = $1`, [expense]);
			expect(again.message).toContain('EXPENSE_IMMUTABLE');
			const reopened = await sqlError(
				c,
				`update expenses set status = 'recorded', cancelled_at = null, cancelled_by = null, cancellation_reason = null where id = $1`,
				[expense]
			);
			expect(reopened.message).toContain('EXPENSE_IMMUTABLE');
		});
	});
});

// ---------------------------------------------------------------- dépenses

describe('dépenses (règle 16)', () => {
	let w: World;
	let landlordWorld: { property: string; lease: string };
	beforeAll(async () => {
		w = await world(a.id);
		landlordWorld = await seed(landlord.id, async (c) => {
			const ownerId = (await c.query(`select id from owners where organization_id = $1 limit 1`, [landlord.id])).rows[0].id as string;
			const { property, unit } = await propertyWithUnit(c, landlord.id, ownerId);
			const tenant = await insertTenant(c, landlord.id);
			return { property, lease: await insertLease(c, landlord.id, unit, tenant, { lessorType: 'organization' }) };
		});
	});

	it('les six combinaisons de packages/shared, et elles seules (36 essais)', async () => {
		const accepted: string[] = [];
		await asOwner(a.id, async (c) => {
			for (const paidBy of EXPENSE_PAYERS)
				for (const borneBy of EXPENSE_BEARERS)
					for (const recovery of EXPENSE_RECOVERIES) {
						await c.query('SAVEPOINT essai');
						try {
							await insertExpense(c, a.id, { propertyId: w.property, leaseId: w.lease, paidBy, borneBy, recovery });
							accepted.push(`${paidBy}/${borneBy}/${recovery}`);
						} catch (error) {
							expect((error as Error).message).toContain('expenses_combination');
						}
						await c.query('ROLLBACK TO SAVEPOINT essai');
					}
		});
		expect(accepted.sort()).toEqual(EXPENSE_COMBINATIONS.map((x) => `${x.paidBy}/${x.borneBy}/${x.recovery}`).sort());
	});

	it('catégories : la liste de packages/shared', async () => {
		const r = await owner.query(
			`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid
			 where t.relname = 'expenses' and pg_get_constraintdef(c.oid) like '%category%'`
		);
		const values = [...String(r.rows[0].def).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
		expect([...new Set(values)].sort()).toEqual([...EXPENSE_CATEGORIES].sort());
	});

	it('une dépense qui concerne le locataire désigne son bail, sur le même bien ; date future refusée', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const noLease = await sqlError(
				api,
				`insert into expenses (id, organization_id, property_id, spent_on, category, description, amount, paid_by, borne_by, recovery)
				 values ($1, $2, $3, '2026-09-01', 'painting', 'Mur', 1000, 'organization', 'tenant', 'claimed_from_tenant')`,
				[newId(), a.id, w.property]
			);
			expect(noLease.message).toContain('expenses_lease_required');
			const other = await world(a.id);
			expect(
				await fails(api, () =>
					insertExpense(api, a.id, { propertyId: w.property, leaseId: other.lease, borneBy: 'tenant', recovery: 'deposit' })
				)
			).toMatch(/EXPENSE_LEASE_MISMATCH/);
			expect(await fails(api, () => insertExpense(api, a.id, { propertyId: w.property, spentOn: '2099-01-01' }))).toMatch(
				/EXPENSE_DATE_IN_FUTURE/
			);
			const zero = await sqlError(
				api,
				`insert into expenses (id, organization_id, property_id, spent_on, category, description, amount, paid_by, borne_by, recovery)
				 values ($1, $2, $3, '2026-09-01', 'tax', 'Taxe', 0, 'organization', 'organization', 'none')`,
				[newId(), a.id, w.property]
			);
			expect(zero.code).toBe('23514');
		});
	});

	it('un bailleur particulier n’a pas de propriétaire distinct', async () => {
		await inContext(api, { organizationId: landlord.id }, async () => {
			expect(await fails(api, () => insertExpense(api, landlord.id, { propertyId: landlordWorld.property }))).toMatch(
				/EXPENSE_COMBINATION_UNSUPPORTED/
			);
			await insertExpense(api, landlord.id, { propertyId: landlordWorld.property, borneBy: 'organization', recovery: 'none' });
		});
	});
});

describe('encaissement d’une dépense réclamée au locataire (option A)', () => {
	let w: World;
	beforeAll(async () => {
		w = await world(a.id);
	});

	const claimOf = (c: pg.Client, amount = 15_000) =>
		insertExpense(c, a.id, { propertyId: w.property, leaseId: w.lease, borneBy: 'tenant', recovery: 'claimed_from_tenant', amount });

	it('imputé exactement sur sa dépense ; jamais en crédit, jamais au-delà, jamais sur une autre cible', async () => {
		await asOwner(a.id, async (c) => {
			const claim = await claimOf(c);
			const p1 = await insertPayment(c, a.id, w.lease, {
				purpose: 'expense',
				expenseId: claim,
				amount: 10_000,
				confirmedBy: a.director.userId
			});
			await allocate(c, a.id, p1, w.lease, [{ target: 'expense', expenseId: claim, amount: 10_000 }]);
			await c.query('set constraints all immediate');
			await c.query('set constraints all deferred');

			const credit = await insertPayment(c, a.id, w.lease, {
				purpose: 'expense',
				expenseId: claim,
				amount: 1_000,
				confirmedBy: a.director.userId
			});
			expect(
				(
					await sqlError(
						c,
						`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, direction, amount)
				 values ($1, $2, $3, $4, 'credit', 'allocate', 1000)`,
						[newId(), a.id, credit, w.lease]
					)
				).message
			).toContain('ALLOCATION_PURPOSE');

			const over = await insertPayment(c, a.id, w.lease, {
				purpose: 'expense',
				expenseId: claim,
				amount: 6_000,
				confirmedBy: a.director.userId
			});
			const e = await sqlError(
				c,
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, expense_id, direction, amount)
				 values ($1, $2, $3, $4, 'expense', $5, 'allocate', 6000)`,
				[newId(), a.id, over, w.lease, claim]
			);
			expect(e.message).toContain('EXPENSE_OVERPAID');

			// Un loyer ne s'impute pas sur une dépense ; un encaissement « dépense » pas sur une échéance.
			const rent = await insertPayment(c, a.id, w.lease, { amount: 1_000, confirmedBy: a.director.userId });
			expect(
				(
					await sqlError(
						c,
						`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, expense_id, direction, amount)
						 values ($1, $2, $3, $4, 'expense', $5, 'allocate', 1000)`,
						[newId(), a.id, rent, w.lease, claim]
					)
				).message
			).toContain('ALLOCATION_PURPOSE');
			expect(
				(
					await sqlError(
						c,
						`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, rent_due_id, direction, amount)
						 values ($1, $2, $3, $4, 'rent_due', $5, 'allocate', 1000)`,
						[newId(), a.id, credit, w.lease, w.due]
					)
				).message
			).toContain('ALLOCATION_PURPOSE');
		});
	});

	it('seule une dépense réclamée au locataire de ce bail, non annulée, s’encaisse', async () => {
		await asOwner(a.id, async (c) => {
			const forOwner = await insertExpense(c, a.id, { propertyId: w.property });
			expect(
				await fails(c, () =>
					insertPayment(c, a.id, w.lease, { purpose: 'expense', expenseId: forOwner, amount: 1_000, status: 'to_validate' })
				)
			).toMatch(/PAYMENT_EXPENSE_NOT_CLAIMED/);
		});
		await asOwner(a.id, async (c) => {
			const claim = await claimOf(c);
			await c.query(
				`update expenses set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Réclamée par erreur' where id = $1`,
				[claim, a.director.userId]
			);
			expect(
				await fails(c, () =>
					insertPayment(c, a.id, w.lease, { purpose: 'expense', expenseId: claim, amount: 1_000, status: 'to_validate' })
				)
			).toMatch(/PAYMENT_EXPENSE_CANCELLED/);
		});
		await asOwner(a.id, async (c) => {
			const withoutExpense = await sqlError(
				c,
				`insert into payments (id, organization_id, lease_id, purpose, amount, method, paid_on, status, idempotency_key)
				 values ($1, $2, $3, 'expense', 1000, 'cash', current_date, 'to_validate', 'x')`,
				[newId(), a.id, w.lease]
			);
			expect(withoutExpense.message).toContain('payments_purpose_expense');
		});
	});

	it('une dépense en partie remboursée, ou dont un encaissement attend sa validation, ne s’annule pas ; après la contre-écriture, si', async () => {
		await asOwner(a.id, async (c) => {
			const claim = await claimOf(c);
			const paid = await insertPayment(c, a.id, w.lease, {
				purpose: 'expense',
				expenseId: claim,
				amount: 5_000,
				confirmedBy: a.director.userId
			});
			await allocate(c, a.id, paid, w.lease, [{ target: 'expense', expenseId: claim, amount: 5_000 }]);
			const cancel = `update expenses set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Réclamée par erreur' where id = $1`;
			expect((await sqlError(c, cancel, [claim, a.director.userId])).message).toContain('EXPENSE_CLAIM_RECOVERED');
			await cancelPayment(c, a.id, paid, a.director.userId);
			await c.query('set constraints all immediate');
			await c.query('set constraints all deferred');
			const pending = await insertPayment(c, a.id, w.lease, { purpose: 'expense', expenseId: claim, amount: 5_000, status: 'to_validate' });
			expect((await sqlError(c, cancel, [claim, a.director.userId])).message).toContain('EXPENSE_CLAIM_PENDING');
			await c.query(
				`update payments set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Saisie en double' where id = $1`,
				[pending, a.director.userId]
			);
			await c.query(cancel, [claim, a.director.userId]);
			const r = await c.query(`select status from expenses where id = $1`, [claim]);
			expect(r.rows[0].status).toBe('cancelled');
		});
	});

	it('reçus : l’objet « dépense » est accepté', async () => {
		const r = await owner.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'receipts_purpose_check'`);
		expect(String(r.rows[0].def)).toContain('expense');
	});
});

// ---------------------------------------------------------------- relances

describe('relances', () => {
	let w: World;
	beforeAll(async () => {
		w = await world(a.id);
	});

	it('une échéance ou une dépense d’un autre locataire est refusée ; un message porte son modèle', async () => {
		const other = await world(a.id);
		await inContext(api, { organizationId: a.id }, async () => {
			expect(await fails(api, () => insertReminder(api, a.id, w.tenant, { dueIds: [other.due] }))).toMatch(/REMINDER_SUBJECT_INVALID/);
			const forOwner = await insertExpense(api, a.id, { propertyId: w.property });
			expect(await fails(api, () => insertReminder(api, a.id, w.tenant, { expenseIds: [forOwner] }))).toMatch(/REMINDER_SUBJECT_INVALID/);
			const claim = await insertExpense(api, a.id, {
				propertyId: w.property,
				leaseId: w.lease,
				borneBy: 'tenant',
				recovery: 'claimed_from_tenant'
			});
			await insertReminder(api, a.id, w.tenant, { dueIds: [w.due], expenseIds: [claim] });
			expect(
				await fails(api, () => insertReminder(api, a.id, w.tenant, { dueIds: [w.due], channel: 'whatsapp_link', level: null }))
			).toMatch(/reminders_template/);
			expect(await fails(api, () => insertReminder(api, a.id, w.tenant, { dueIds: [w.due], channel: 'visit', level: 2 }))).toMatch(
				/reminders_template/
			);
			expect(await fails(api, () => insertReminder(api, a.id, w.tenant, {}))).toMatch(/reminders_subject/);
		});
	});

	it('canaux : la liste de packages/shared ; seuils croissants', async () => {
		const r = await owner.query(
			`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid
			 where t.relname = 'reminders' and pg_get_constraintdef(c.oid) like '%channel = ANY%'`
		);
		const values = [...String(r.rows[0].def).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
		expect([...new Set(values)].sort()).toEqual([...REMINDER_CHANNELS].sort());
		await inContext(api, { organizationId: a.id }, async () => {
			const e = await sqlError(
				api,
				`insert into reminder_settings (organization_id, template_1, template_2, template_3, offset_1, offset_2, offset_3)
				 values ($1, 'Bonjour {nom} 1', 'Bonjour {nom} 2', 'Bonjour {nom} 3', 15, 5, 30)`,
				[a.id]
			);
			expect(e.message).toContain('reminder_settings_offsets');
		});
	});
});

// ---------------------------------------------------------------- relevés

describe('relevés : émission, ordre, rectificatif, figement', () => {
	it('un mois pas terminé ne s’émet pas ; les mois s’émettent dans l’ordre ; un mois émis ne se réémet pas', async () => {
		const w = await world(a.id);
		await asOwner(a.id, async (c) => {
			const current = await insertStatement(c, a.id, w.owner, thisMonth());
			expect(
				(await sqlError(c, `update owner_statements set status = 'issued', issued_by = $2 where id = $1`, [current, a.director.userId]))
					.message
			).toContain('STATEMENT_PERIOD_NOT_ENDED');
			const sept = await insertStatement(c, a.id, w.owner, '2026-09');
			const aug = await insertStatement(c, a.id, w.owner, '2026-08');
			await issueStatement(c, a.id, sept, a.director.userId);
			expect(
				(await sqlError(c, `update owner_statements set status = 'issued', issued_by = $2 where id = $1`, [aug, a.director.userId])).message
			).toContain('STATEMENT_OUT_OF_ORDER');
			const twice = await sqlError(
				c,
				`insert into owner_statements (id, organization_id, owner_id, month, revision, rent_collected, charges_collected, collected,
					rent_collected_by_owner, charges_collected_by_owner, commission, expenses, carried_balance, net, snapshot)
				 values ($1, $2, $3, '2026-09', '00000000', 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}')`,
				[newId(), a.id, w.owner]
			);
			expect(twice.code).toBe('23505');
			const noAuthor = await insertStatement(c, a.id, w.owner, '2026-10');
			expect((await sqlError(c, `update owner_statements set status = 'issued' where id = $1`, [noAuthor])).message).toMatch(
				/STATEMENT_ISSUED_BY|owner_statements_issued/
			);
		});
	});

	it('un relevé émis est figé (sauf son PDF, écrit une fois) ; il ne redevient pas brouillon', async () => {
		const w = await world(a.id);
		await asOwner(a.id, async (c) => {
			const s = await insertStatement(c, a.id, w.owner, '2026-09');
			await c.query(`update owner_statements set rent_collected = 70000, collected = 75000, net = 67500 where id = $1`, [s]);
			await issueStatement(c, a.id, s, a.director.userId);
			const issued = await c.query(`select issued_on, issued_at from owner_statements where id = $1`, [s]);
			expect(issued.rows[0].issued_at).not.toBeNull();
			for (const sql of [
				`update owner_statements set net = 0, collected = 7500, rent_collected = 2500 where id = $1`,
				`update owner_statements set snapshot = '{"autre":1}' where id = $1`,
				`update owner_statements set status = 'draft', issued_at = null, issued_on = null, issued_by = null where id = $1`,
				`update owner_statements set month = '2026-08' where id = $1`
			]) {
				expect((await sqlError(c, sql, [s])).message, sql).toContain('STATEMENT_IMMUTABLE');
			}
			await c.query(`update owner_statements set pdf_key = 'statements/a.pdf', pdf_generated_at = now() where id = $1`, [s]);
			expect((await sqlError(c, `update owner_statements set pdf_key = 'statements/b.pdf' where id = $1`, [s])).message).toContain(
				'STATEMENT_IMMUTABLE'
			);
			const totals = await sqlError(
				c,
				`insert into owner_statements (id, organization_id, owner_id, month, revision, rent_collected, charges_collected,
				collected, rent_collected_by_owner, charges_collected_by_owner, commission, expenses, carried_balance, net, snapshot)
				values ($1, $2, $3, '2026-07', '00000000', 1, 1, 2, 0, 0, 0, 0, 0, 5, '{}')`,
				[newId(), a.id, w.owner]
			);
			expect(totals.message).toContain('owner_statements_totals');
		});
	});

	it('le rectificatif suit la dernière version émise du dernier mois émis, et elle seule', async () => {
		const w = await world(a.id);
		await asOwner(a.id, async (c) => {
			const aug = await insertStatement(c, a.id, w.owner, '2026-08');
			await issueStatement(c, a.id, aug, a.director.userId);
			const sept = await insertStatement(c, a.id, w.owner, '2026-09');
			await issueStatement(c, a.id, sept, a.director.userId);
			// Rectificatif d'août alors que septembre est émis : refusé à l'émission.
			const lateRect = await insertStatement(c, a.id, w.owner, '2026-08', { version: 2, corrects: aug });
			expect(
				(await sqlError(c, `update owner_statements set status = 'issued', issued_by = $2 where id = $1`, [lateRect, a.director.userId]))
					.message
			).toContain('STATEMENT_RECTIFICATION_NOT_LATEST');
			// Mauvaise version, mauvais mois : refusés à la création.
			expect(
				(
					await sqlError(
						c,
						`insert into owner_statements (id, organization_id, owner_id, month, version, corrects_statement_id, revision, rent_collected, charges_collected,
							collected, rent_collected_by_owner, charges_collected_by_owner, commission, expenses, carried_balance, net, snapshot)
						 values ($1, $2, $3, '2026-09', 3, $4, '00000000', 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}')`,
						[newId(), a.id, w.owner, sept]
					)
				).message
			).toContain('STATEMENT_RECTIFICATION_INVALID');
			const v2 = await insertStatement(c, a.id, w.owner, '2026-09', { version: 2, corrects: sept, rent: 0, charges: 0, commission: 0 });
			await issueStatement(c, a.id, v2, a.director.userId);
			const v1Without = await sqlError(
				c,
				`insert into owner_statements (id, organization_id, owner_id, month, version, revision, rent_collected, charges_collected, collected,
					rent_collected_by_owner, charges_collected_by_owner, commission, expenses, carried_balance, net, snapshot)
				 values ($1, $2, $3, '2026-10', 2, '00000000', 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}')`,
				[newId(), a.id, w.owner]
			);
			expect(v1Without.message).toContain('owner_statements_rectification');
		});
	});

	it('un bailleur particulier n’a pas de relevé propriétaire', async () => {
		await asOwner(landlord.id, async (c) => {
			const ownerId = (await c.query(`select id from owners where organization_id = $1 limit 1`, [landlord.id])).rows[0].id as string;
			expect(await fails(c, () => insertStatement(c, landlord.id, ownerId, '2026-09'))).toMatch(/STATEMENT_LANDLORD/);
		});
	});
});

describe('éléments consommés : écrits à l’émission, une seule fois, du bon genre', () => {
	it('la clé de la base est celle de packages/shared ; un élément n’entre jamais dans deux relevés', async () => {
		const w = await world(a.id);
		await asOwner(a.id, async (c) => {
			const { allocation } = await paidDue(c, a, w);
			const expense = await insertExpense(c, a.id, { propertyId: w.property });
			const lease = await c.query(`select id from leases where id = $1`, [w.lease]);
			const aug = await insertStatement(c, a.id, w.owner, '2026-08', { rent: 0, charges: 0, commission: 30_000 });
			await issueStatement(c, a.id, aug, a.director.userId);
			const keys = [
				await insertLine(c, a.id, aug, { kind: 'allocation', allocationId: allocation }),
				await insertLine(c, a.id, aug, { kind: 'expense', expenseId: expense }),
				await insertLine(c, a.id, aug, { kind: 'monthly_fee', mandateId: w.mandate, feeMonth: '2026-08' }),
				await insertLine(c, a.id, aug, { kind: 'operation_fee', leaseId: lease.rows[0].id })
			];
			expect(keys).toEqual([
				statementItemKey.allocation(allocation),
				statementItemKey.expense(expense),
				statementItemKey.monthlyFee(w.mandate, '2026-08'),
				statementItemKey.operationFee(w.lease)
			]);
			const sept = await insertStatement(c, a.id, w.owner, '2026-09', { carried: -22_500 });
			await issueStatement(c, a.id, sept, a.director.userId);
			expect(await insertLine(c, a.id, sept, { kind: 'carried_balance', carriedStatementId: aug })).toBe(
				statementItemKey.carriedBalance(aug)
			);
			const twice = await sqlError(
				c,
				`insert into owner_statement_lines (id, organization_id, statement_id, kind, role, allocation_id) values ($1, $2, $3, 'allocation', 'line', $4)`,
				[newId(), a.id, sept, allocation]
			);
			expect(twice.code).toBe('23505');
			expect(twice.message).toContain('owner_statement_lines_once');
		});
	});

	it('jamais après l’émission ; jamais sur un brouillon', async () => {
		const w = await world(a.id);
		const statement = await seed(a.id, async (c) => {
			const s = await insertStatement(c, a.id, w.owner, '2026-09');
			await issueStatement(c, a.id, s, a.director.userId);
			return s;
		});
		await asOwner(a.id, async (c) => {
			const expense = await insertExpense(c, a.id, { propertyId: w.property });
			expect(await fails(c, () => insertLine(c, a.id, statement, { kind: 'expense', expenseId: expense }))).toMatch(
				/STATEMENT_LINES_AT_ISSUE/
			);
			const draft = await insertStatement(c, a.id, w.owner, '2026-10');
			expect(await fails(c, () => insertLine(c, a.id, draft, { kind: 'expense', expenseId: expense }))).toMatch(/STATEMENT_LINES_AT_ISSUE/);
		});
	});

	it('du bon genre : imputation sur échéance, dépense pour le propriétaire, annulation réelle, solde négatif du même propriétaire', async () => {
		const w = await world(a.id);
		const other = await world(a.id);
		await asOwner(a.id, async (c) => {
			const credit = await insertPayment(c, a.id, w.lease, { amount: 5_000, confirmedBy: a.director.userId });
			await allocate(c, a.id, credit, w.lease, [{ target: 'credit', amount: 5_000 }]);
			const creditLine = (await c.query(`select id from payment_allocations where payment_id = $1`, [credit])).rows[0].id as string;
			const orgCost = await insertExpense(c, a.id, { propertyId: w.property, borneBy: 'organization', recovery: 'none' });
			const recorded = await insertExpense(c, a.id, { propertyId: w.property });
			const positive = await insertStatement(c, a.id, w.owner, '2026-08');
			await issueStatement(c, a.id, positive, a.director.userId);
			const foreignNegative = await insertStatement(c, a.id, other.owner, '2026-08', { rent: 0, charges: 0, commission: 1_000 });
			await issueStatement(c, a.id, foreignNegative, a.director.userId);
			const s = await insertStatement(c, a.id, w.owner, '2026-09');
			await issueStatement(c, a.id, s, a.director.userId);
			const cases: [string, Parameters<typeof insertLine>[3]][] = [
				['crédit non imputé', { kind: 'allocation', allocationId: creditLine }],
				['dépense de l’organisation', { kind: 'expense', expenseId: orgCost }],
				['dépense non annulée', { kind: 'expense_cancellation', expenseId: recorded }],
				['solde positif', { kind: 'carried_balance', carriedStatementId: positive }],
				['solde d’un autre propriétaire', { kind: 'carried_balance', carriedStatementId: foreignNegative }],
				['mandat d’un autre propriétaire', { kind: 'monthly_fee', mandateId: other.mandate, feeMonth: '2026-09' }]
			];
			for (const [label, line] of cases) {
				expect(await fails(c, () => insertLine(c, a.id, s, line)), label).toMatch(/STATEMENT_LINE_INVALID/);
			}
			const neutralFee = await sqlError(
				c,
				`insert into owner_statement_lines (id, organization_id, statement_id, kind, role, mandate_id, fee_month) values ($1, $2, $3, 'monthly_fee', 'neutralized', $4, '2026-09')`,
				[newId(), a.id, s, w.mandate]
			);
			expect(neutralFee.message).toContain('owner_statement_lines_neutralized');
		});
	});

	it('sortes d’éléments et moyens de reversement : les listes de packages/shared', async () => {
		for (const [table, column, list] of [
			['owner_statement_lines', 'kind', STATEMENT_ITEM_KINDS],
			['owner_payouts', 'method', PAYOUT_METHODS]
		] as const) {
			const r = await owner.query(
				`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid
				 where t.relname = $1 and pg_get_constraintdef(c.oid) like $2`,
				[table, `%${column} = ANY%`]
			);
			const values = [...String(r.rows[0].def).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
			expect([...new Set(values)].sort(), `${table}.${column}`).toEqual([...list].sort());
		}
	});
});

describe('reversements (règle 5 : enregistrés, jamais exécutés)', () => {
	it('relevé émis du même propriétaire, net positif, total jamais au-delà du net ; contre-écriture à l’identique, une seule fois', async () => {
		const w = await world(a.id);
		const other = await world(a.id);
		await asOwner(a.id, async (c) => {
			const draft = await insertStatement(c, a.id, w.owner, '2026-10');
			expect(await fails(c, () => insertPayout(c, a.id, draft, w.owner, 1_000))).toMatch(/STATEMENT_NOT_ISSUED/);
		});
		await asOwner(a.id, async (c) => {
			const s = await insertStatement(c, a.id, w.owner, '2026-09');
			await issueStatement(c, a.id, s, a.director.userId);
			// Net : 80 000 − 7 500 = 72 500.
			const first = await insertPayout(c, a.id, s, w.owner, 70_000);
			expect(await fails(c, () => insertPayout(c, a.id, s, w.owner, 2_501))).toMatch(/PAYOUT_EXCEEDS_NET/);
			expect(await fails(c, () => insertPayout(c, a.id, s, other.owner, 1_000))).toMatch(/PAYOUT_OWNER_MISMATCH/);
			expect(await fails(c, () => insertPayout(c, a.id, s, w.owner, 1_000, { paidOn: '2099-01-01' }))).toMatch(/PAYOUT_DATE_IN_FUTURE/);
			expect(await fails(c, () => insertPayout(c, a.id, s, w.owner, 1_000, { reverses: first }))).toMatch(/PAYOUT_REVERSAL_INVALID/);
			await insertPayout(c, a.id, s, w.owner, 70_000, { reverses: first });
			expect(await fails(c, () => insertPayout(c, a.id, s, w.owner, 70_000, { reverses: first }))).toMatch(/owner_payouts_reversed_once/);
			// La contre-écriture rend la place : le net entier peut être reversé.
			await insertPayout(c, a.id, s, w.owner, 72_500);
		});
		await asOwner(a.id, async (c) => {
			const negative = await insertStatement(c, a.id, w.owner, '2026-09', { rent: 0, charges: 0, commission: 7_500 });
			await issueStatement(c, a.id, negative, a.director.userId);
			expect(await fails(c, () => insertPayout(c, a.id, negative, w.owner, 1_000))).toMatch(/PAYOUT_NOTHING_DUE/);
		});
	});
});
