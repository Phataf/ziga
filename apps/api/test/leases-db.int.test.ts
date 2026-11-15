/**
 * Lot 08, étape 2 : locataires, baux, échéances et cautions dans la base (migration 0013), en SQL, avec le rôle de
 * l'API (app_api, sans BYPASSRLS), le propriétaire du schéma (triggers) et le rôle de réplication (app_sync).
 * - Accès croisé A/B sur les six tables : lecture, modification, création, référence (clés composites).
 * - Règle 8 : un seul bail en vigueur et un seul bail à venir par unité.
 * - Bail : cycle, conditions figées après validation, changement de loyer par version, bailleur particulier.
 * - Échéances : une par bail et par période (idempotence), jamais pour un brouillon, émise : montant figé.
 * - Caution : détenteur obligatoire, statut et détenteur écrits par la base, mouvements en ajout seul, versements
 *   plafonnés au convenu, sorties plafonnées au reçu, retenue sans état des lieux refusée (règle 14).
 * - Occupation : aucune colonne, ni dans units ni dans leases (règle 13).
 */
import { newId } from '@ziga/shared/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './http.js';
import { insertDepositAccount, insertDue, insertLease, insertMovement, insertTenant } from './leases.js';
import { apiSql, createOrg, inContext, sqlError, type Org } from './orgs.js';
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

/** Écrit des données de test, validées, dans le contexte d'une organisation (propriétaire du schéma, sous la RLS). */
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

async function insertOwner(c: pg.Client, organizationId: string): Promise<string> {
	const id = newId();
	await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Awa Sawadogo', '+22670445566')`, [
		id,
		organizationId
	]);
	return id;
}

/** Une unité neuve de l'organisation (bien et propriétaire compris), et un locataire. */
async function unitAndTenant(organizationId: string): Promise<{ unit: string; tenant: string }> {
	return seed(organizationId, async (c) => {
		const ownerId = await insertOwner(c, organizationId);
		const { unit } = await propertyWithUnit(c, organizationId, ownerId);
		const tenant = await insertTenant(c, organizationId);
		return { unit, tenant };
	});
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A baux');
	b = await createOrg(t, 'agency', 'Agence B baux');
	landlord = await createOrg(t, 'landlord', 'Bailleur baux');
	owner = await connect(process.env.DATABASE_MIGRATION_URL!);
	api = await apiSql();
});
afterAll(async () => {
	await api.end();
	await owner.end();
	await t.close();
});

describe('accès croisé A/B en SQL (règle 1)', () => {
	const tables = ['tenants', 'leases', 'lease_versions', 'rent_dues', 'deposit_accounts', 'deposit_movements'];
	let inB: { unit: string; tenant: string; lease: string; account: string };
	let mine: { unit: string; tenant: string };

	beforeAll(async () => {
		const { unit, tenant } = await unitAndTenant(b.id);
		inB = await seed(b.id, async (c) => {
			const lease = await insertLease(c, b.id, unit, tenant);
			await insertDue(c, b.id, lease, '2026-01-01');
			const account = await insertDepositAccount(c, b.id, lease);
			await insertMovement(c, b.id, account, 'received', 50_000);
			return { unit, tenant, lease, account };
		});
		mine = await unitAndTenant(a.id);
	});

	it('A ne lit aucune ligne de B, dans aucune des six tables ; B voit les siennes', async () => {
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
			expect((await api.query(`update tenants set full_name = 'Piraté' where id = $1`, [inB.tenant])).rowCount).toBe(0);
			expect((await api.query(`update leases set payment_terms = 'Piraté' where id = $1`, [inB.lease])).rowCount).toBe(0);
			expect((await api.query(`update rent_dues set status = 'waived' where lease_id = $1`, [inB.lease])).rowCount).toBe(0);
			expect((await api.query(`update deposit_accounts set agreed_amount = 1 where id = $1`, [inB.account])).rowCount).toBe(0);
		});
		const r = await owner.query(`select full_name from tenants where id = $1`, [inB.tenant]);
		expect(r.rows[0].full_name).toBe('Issa Kaboré');
	});

	it('A ne crée rien au nom de B (WITH CHECK de la RLS)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const e = await sqlError(api, `insert into tenants (id, organization_id, full_name) values ($1, $2, 'Intrus')`, [newId(), b.id]);
			expect(e.code).toBe('42501');
		});
	});

	it('A ne référence aucune ligne de B : unité, locataire, bail, compte de caution (clés composites)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const myLease = await insertLease(api, a.id, mine.unit, mine.tenant);
			const cases: [() => Promise<unknown>, string][] = [
				[() => insertLease(api, a.id, inB.unit, mine.tenant), 'leases_unit_fk'],
				[() => insertLease(api, a.id, mine.unit, inB.tenant, { status: 'draft' }), 'leases_tenant_fk'],
				[() => insertDue(api, a.id, inB.lease, '2026-02-01'), 'rent_dues_lease_fk'],
				[() => insertDepositAccount(api, a.id, inB.lease), 'deposit_accounts_lease_fk'],
				[() => insertMovement(api, a.id, inB.account, 'received', 1_000), 'deposit_movements_account_fk']
			];
			for (const [run, constraint] of cases) {
				await api.query('SAVEPOINT attendu');
				const e = await run().then(
					() => null,
					(error: { code: string; message: string }) => error
				);
				await api.query('ROLLBACK TO SAVEPOINT attendu');
				expect(e?.code, constraint).toBe('23503');
				expect(e?.message, constraint).toContain(constraint);
			}
			// Un document de A rattaché au bail de B : refusé.
			const doc = await sqlError(
				api,
				`insert into documents (id, organization_id, type, lease_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
				 values ($1, $2, 'signed_lease_scan', $3, 'bail.pdf', 'application/pdf', 1000, $4, $5)`,
				[newId(), a.id, inB.lease, `documents/${newId()}`, a.director.userId]
			);
			expect(doc.code).toBe('23503');
			expect(doc.message).toContain('documents_lease_fk');
			expect(myLease).toBeTruthy();
		});
	});

	it('app_sync lit les six tables (copie initiale) mais n’y écrit pas', async () => {
		const sync = await connect(process.env.DATABASE_SYNC_URL!);
		try {
			for (const table of tables) {
				const r = await sync.query(`select count(*)::int as n from ${table} where organization_id = $1`, [b.id]);
				expect(r.rows[0].n, table).toBeGreaterThan(0);
			}
			await sync.query('BEGIN');
			try {
				expect((await sqlError(sync, `update tenants set full_name = 'x' where id = $1`, [inB.tenant])).code).toBe('42501');
			} finally {
				await sync.query('ROLLBACK');
			}
		} finally {
			await sync.end();
		}
	});
});

describe('règle 8 : un seul bail en vigueur et un seul bail à venir par unité', () => {
	it('deux baux en vigueur sur la même unité : refusé ; un bail à venir à côté d’un bail en vigueur : accepté', async () => {
		const { unit, tenant } = await unitAndTenant(a.id);
		await inContext(api, { organizationId: a.id }, async () => {
			await insertLease(api, a.id, unit, tenant);
			await api.query('SAVEPOINT s');
			const e = await insertLease(api, a.id, unit, tenant).catch((error: { code: string; message: string }) => error);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect(e).toMatchObject({ code: '23505' });
			expect((e as { message: string }).message).toContain('leases_one_in_force_per_unit');
			await insertLease(api, a.id, unit, tenant, { status: 'signed', startsOn: '2027-06-01' });
			await insertLease(api, a.id, unit, tenant, { status: 'draft' });
			await insertLease(api, a.id, unit, tenant, { status: 'draft' });
		});
	});

	it('deux baux à venir sur la même unité : refusé', async () => {
		const { unit, tenant } = await unitAndTenant(a.id);
		await inContext(api, { organizationId: a.id }, async () => {
			await insertLease(api, a.id, unit, tenant, { status: 'signed', startsOn: '2027-06-01' });
			await api.query('SAVEPOINT s');
			const e = await insertLease(api, a.id, unit, tenant, { status: 'signed', startsOn: '2027-09-01' }).catch(
				(error: { code: string; message: string }) => error
			);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect(e).toMatchObject({ code: '23505' });
			expect((e as { message: string }).message).toContain('leases_one_reserved_per_unit');
		});
	});

	it('un brouillon validé sur une unité déjà louée : refusé par l’index', async () => {
		const { unit, tenant } = await unitAndTenant(a.id);
		await inContext(api, { organizationId: a.id }, async () => {
			await insertLease(api, a.id, unit, tenant);
			const draft = await insertLease(api, a.id, unit, tenant, { status: 'draft' });
			const e = await sqlError(
				api,
				`update leases set status = 'active', activated_on = current_date, activated_at = now() where id = $1`,
				[draft]
			);
			expect(e.code).toBe('23505');
		});
	});
});

describe('bail : cycle, conditions et versions', () => {
	let unit: string;
	let tenant: string;
	beforeAll(async () => {
		({ unit, tenant } = await unitAndTenant(a.id));
	});

	it('un bail naît brouillon ou validé, en version 1, son premier loyer dès le début de la facturation', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const notice = await sqlError(
				api,
				`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, dues_start_on, rent, rent_effective_from, billing_mode, lessor_type,
					status, activated_on, activated_at) values ($1, $2, $3, $4, '2026-01-01', '2026-01-01', 75000, '2026-01-01', 'calendar_prorata', 'owner',
					'notice', '2026-01-01', now())`,
				[newId(), a.id, unit, tenant]
			);
			expect(notice.message).toContain('LEASE_BORN_DRAFT_OR_VALIDATED');
			const shifted = await sqlError(
				api,
				`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, dues_start_on, rent, rent_effective_from, billing_mode, lessor_type)
				 values ($1, $2, $3, $4, '2026-01-01', '2026-01-01', 75000, '2026-03-01', 'calendar_prorata', 'owner')`,
				[newId(), a.id, unit, tenant]
			);
			expect(shifted.message).toContain('LEASE_RENT_EFFECTIVE');
			// Validé sans date de validation : refusé (contrainte).
			const unsigned = await sqlError(
				api,
				`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, dues_start_on, rent, rent_effective_from, billing_mode, lessor_type, status)
				 values ($1, $2, $3, $4, '2026-01-01', '2026-01-01', 75000, '2026-01-01', 'calendar_prorata', 'owner', 'active')`,
				[newId(), a.id, unit, tenant]
			);
			expect(unsigned.code).toBe('23514');
		});
	});

	it('montants : uniquement des entiers FCFA, loyer positif', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			for (const [rent, code] of [
				['75000.5', '22P02'],
				['0', '23514'],
				['-1', '23514']
			] as const) {
				const e = await sqlError(
					api,
					`insert into leases (id, organization_id, unit_id, tenant_id, starts_on, dues_start_on, rent, rent_effective_from, billing_mode, lessor_type)
					 values ($1, $2, $3, $4, '2026-01-01', '2026-01-01', $5, '2026-01-01', 'calendar_prorata', 'owner')`,
					[newId(), a.id, unit, tenant, rent]
				);
				expect(e.code, rent).toBe(code);
			}
		});
	});

	it('brouillon : tout se modifie, sans version ; validé : conditions figées', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const lease = await insertLease(api, a.id, unit, tenant, { status: 'draft' });
			await api.query(`update leases set due_day = 10, billing_mode = 'anniversary', rent = 80000 where id = $1`, [lease]);
			expect((await api.query(`select count(*)::int as n from lease_versions where lease_id = $1`, [lease])).rows[0].n).toBe(0);
			await api.query(`update leases set status = 'active', activated_on = current_date, activated_at = now() where id = $1`, [lease]);
			const v = await api.query(`select version, rent, billing_mode, due_day from lease_versions where lease_id = $1`, [lease]);
			expect(v.rows).toEqual([{ version: 1, rent: '80000', billing_mode: 'anniversary', due_day: 10 }]);
			for (const change of [
				`due_day = 12`,
				`billing_mode = 'calendar_prorata'`,
				`ends_on = '2027-12-31'`,
				`lessor_type = 'organization'`
			]) {
				const e = await sqlError(api, `update leases set ${change} where id = $1`, [lease]);
				expect(e.message, change).toContain('LEASE_TERMS_LOCKED');
			}
		});
	});

	it('changement de loyer : version suivante, date d’effet postérieure ; copie de la version par la base', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const lease = await insertLease(api, a.id, unit, tenant);
			const same = await sqlError(api, `update leases set rent = 90000 where id = $1`, [lease]);
			expect(same.message).toContain('LEASE_VERSION');
			const earlier = await sqlError(api, `update leases set rent = 90000, version = 2, rent_effective_from = '2026-01-01' where id = $1`, [
				lease
			]);
			expect(earlier.message).toContain('LEASE_RENT_EFFECTIVE');
			await api.query(`update leases set rent = 90000, charges = 6000, version = 2, rent_effective_from = '2026-07-01' where id = $1`, [
				lease
			]);
			const v = await api.query(
				`select version, rent, charges, rent_effective_from::text from lease_versions where lease_id = $1 order by version`,
				[lease]
			);
			expect(v.rows).toEqual([
				{ version: 1, rent: '75000', charges: '5000', rent_effective_from: '2026-01-01' },
				{ version: 2, rent: '90000', charges: '6000', rent_effective_from: '2026-07-01' }
			]);
			const bump = await sqlError(api, `update leases set version = 3 where id = $1`, [lease]);
			expect(bump.message).toContain('LEASE_VERSION');
		});
	});

	it('transitions permises seulement ; un bail terminé ou annulé ne change plus ; l’unité d’un bail ne change pas', async () => {
		const other = await unitAndTenant(a.id);
		await inContext(api, { organizationId: a.id }, async () => {
			const lease = await insertLease(api, a.id, unit, tenant);
			for (const status of ['draft', 'cancelled', 'signed']) {
				const e = await sqlError(api, `update leases set status = $2 where id = $1`, [lease, status]);
				expect(e.message, status).toMatch(/LEASE_STATUS|leases_cancelled|leases_activated/);
			}
			const moved = await sqlError(api, `update leases set unit_id = $2 where id = $1`, [lease, other.unit]);
			expect(moved.message).toContain('LEASE_IMMUTABLE');
			const draft = await insertLease(api, a.id, unit, tenant, { status: 'draft' });
			await api.query(
				`update leases set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Erreur de saisie' where id = $1`,
				[draft]
			);
			const reopened = await sqlError(api, `update leases set payment_terms = 'x' where id = $1`, [draft]);
			expect(reopened.message).toContain('LEASE_CLOSED');
		});
	});

	it('les versions sont écrites par la base seule, en ajout seul ; un bail ne se supprime pas', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const lease = await insertLease(api, a.id, unit, tenant);
			const write = await sqlError(
				api,
				`insert into lease_versions (id, organization_id, lease_id, version, rent, charges, rent_effective_from, starts_on, dues_start_on, due_day,
					billing_mode, periodicity, advance_months, status) values ($1, $2, $3, 9, 1, 0, '2026-01-01', '2026-01-01', '2026-01-01', 5,
					'calendar_prorata', 'monthly', 0, 'active')`,
				[newId(), a.id, lease]
			);
			expect(write.code).toBe('42501');
			expect((await sqlError(api, `update lease_versions set rent = 1 where lease_id = $1`, [lease])).code).toBe('42501');
			expect((await sqlError(api, `delete from leases where id = $1`, [lease])).code).toBe('42501');
		});
		const lease = await seed(a.id, (c) => insertLease(c, a.id, unit, tenant, { status: 'draft' }));
		await seed(a.id, (c) =>
			c.query(`update leases set status = 'active', activated_on = current_date, activated_at = now() where id = $1`, [lease])
		);
		await owner.query('BEGIN');
		try {
			await owner.query(`select set_config('app.organization_id', $1, true)`, [a.id]);
			expect((await sqlError(owner, `update lease_versions set rent = 1 where lease_id = $1`, [lease])).message).toContain('APPEND_ONLY');
			expect((await sqlError(owner, `delete from lease_versions where lease_id = $1`, [lease])).message).toContain('APPEND_ONLY');
		} finally {
			await owner.query('ROLLBACK');
		}
	});

	it('bailleur particulier : il est lui-même le bailleur désigné', async () => {
		const own = await seed(landlord.id, async (c) => {
			const ownerId = (await c.query(`select id from owners where organization_id = $1`, [landlord.id])).rows[0].id as string;
			const { unit: u } = await propertyWithUnit(c, landlord.id, ownerId);
			return { unit: u, tenant: await insertTenant(c, landlord.id) };
		});
		await inContext(api, { organizationId: landlord.id }, async () => {
			await api.query('SAVEPOINT s');
			const e = await insertLease(api, landlord.id, own.unit, own.tenant).catch((error: { message: string }) => error);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect((e as { message: string }).message).toContain('LANDLORD_IS_LESSOR');
			const lease = await insertLease(api, landlord.id, own.unit, own.tenant, { lessorType: 'organization' });
			await api.query('SAVEPOINT s');
			const holder = await insertDepositAccount(api, landlord.id, lease, { holder: 'owner' }).catch((error: { message: string }) => error);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect((holder as { message: string }).message).toContain('LANDLORD_IS_HOLDER');
			await insertDepositAccount(api, landlord.id, lease, { holder: 'organization' });
		});
	});

	it('règle 13 : l’occupation n’est une colonne ni des unités ni des baux', async () => {
		const r = await owner.query(
			`select table_name, column_name from information_schema.columns
			 where table_name in ('units', 'leases') and column_name ~ '(occupancy|occupied|available|availability)'`
		);
		expect(r.rows).toEqual([]);
	});
});

describe('échéances', () => {
	let lease: string;
	let draft: string;
	beforeAll(async () => {
		const { unit, tenant } = await unitAndTenant(a.id);
		const other = await unitAndTenant(a.id);
		lease = await seed(a.id, (c) => insertLease(c, a.id, unit, tenant));
		draft = await seed(a.id, (c) => insertLease(c, a.id, other.unit, other.tenant, { status: 'draft' }));
	});

	it('une seule échéance par bail et par période : un rejeu ne crée pas de doublon', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			expect(await insertDue(api, a.id, lease, '2026-03-01', { onConflict: true })).toBe(1);
			expect(await insertDue(api, a.id, lease, '2026-03-01', { onConflict: true })).toBe(0);
			const r = await api.query(`select count(*)::int as n from rent_dues where lease_id = $1 and period_start = '2026-03-01'`, [lease]);
			expect(r.rows[0].n).toBe(1);
		});
	});

	it('aucune échéance pour un brouillon ; montant dû = loyer + charges, en entiers', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			await api.query('SAVEPOINT s');
			const e = await insertDue(api, a.id, draft, '2026-03-01').catch((error: { message: string }) => error);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect((e as { message: string }).message).toContain('RENT_DUE_LEASE_NOT_VALIDATED');
			const wrong = await sqlError(
				api,
				`insert into rent_dues (id, organization_id, lease_id, period_start, period_end, due_on, rent, charges, amount_due, lease_version)
				 values ($1, $2, $3, '2026-04-01', '2026-04-30', '2026-04-05', 75000, 5000, 70000, 1)`,
				[newId(), a.id, lease]
			);
			expect(wrong.code).toBe('23514');
			const decimal = await sqlError(
				api,
				`insert into rent_dues (id, organization_id, lease_id, period_start, period_end, due_on, rent, charges, amount_due, lease_version)
				 values ($1, $2, $3, '2026-04-01', '2026-04-30', '2026-04-05', $4, 0, $4, 1)`,
				// Paramètre, comme l'API : un littéral SQL décimal serait arrondi par la conversion en bigint.
				[newId(), a.id, lease, '75000.5']
			);
			expect(decimal.code).toBe('22P02');
		});
	});

	it('à venir et sans paiement : montant recalculable ; émise : montant et date figés ; jamais supprimée', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			await insertDue(api, a.id, lease, '2026-05-01');
			await api.query(
				`update rent_dues set rent = 90000, amount_due = 95000, lease_version = 2 where lease_id = $1 and period_start = '2026-05-01'`,
				[lease]
			);
			await api.query(`update rent_dues set status = 'due' where lease_id = $1 and period_start = '2026-05-01'`, [lease]);
			const frozen = await sqlError(
				api,
				`update rent_dues set rent = 75000, amount_due = 80000 where lease_id = $1 and period_start = '2026-05-01'`,
				[lease]
			);
			expect(frozen.message).toContain('RENT_DUE_ISSUED');
			const moved = await sqlError(api, `update rent_dues set due_on = '2026-05-10' where lease_id = $1 and period_start = '2026-05-01'`, [
				lease
			]);
			expect(moved.message).toContain('RENT_DUE_ISSUED');
			await insertDue(api, a.id, lease, '2026-06-01');
			await api.query(`update rent_dues set amount_paid = 10000 where lease_id = $1 and period_start = '2026-06-01'`, [lease]);
			const paid = await sqlError(
				api,
				`update rent_dues set rent = 1, amount_due = 5001 where lease_id = $1 and period_start = '2026-06-01'`,
				[lease]
			);
			expect(paid.message).toContain('RENT_DUE_ISSUED');
			const period = await sqlError(
				api,
				`update rent_dues set period_end = '2026-06-15' where lease_id = $1 and period_start = '2026-06-01'`,
				[lease]
			);
			expect(period.message).toContain('RENT_DUE_IMMUTABLE');
			expect((await sqlError(api, `delete from rent_dues where lease_id = $1`, [lease])).code).toBe('42501');
		});
	});
});

describe('comptes de caution (règle 14)', () => {
	let active: string;
	let unitDraft: { unit: string; tenant: string };
	beforeAll(async () => {
		const { unit, tenant } = await unitAndTenant(a.id);
		active = await seed(a.id, (c) => insertLease(c, a.id, unit, tenant));
		unitDraft = await unitAndTenant(a.id);
	});

	it('détenteur obligatoire ; un compte par type et par bail ; il naît en attente', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			await api.query('SAVEPOINT s');
			const e = await insertDepositAccount(api, a.id, active, { holder: null }).catch((error: { code: string }) => error);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect(e).toMatchObject({ code: '23502' });
			await insertDepositAccount(api, a.id, active);
			await insertDepositAccount(api, a.id, active, { type: 'utilities_guarantee', agreed: 25_000 });
			await api.query('SAVEPOINT s');
			const twice = await insertDepositAccount(api, a.id, active).catch((error: { code: string }) => error);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect(twice).toMatchObject({ code: '23505' });
			const held = await sqlError(
				api,
				`insert into deposit_accounts (id, organization_id, lease_id, type, agreed_amount, holder, status) values ($1, $2, $3, 'security_deposit', 1, 'owner', 'held')`,
				[newId(), a.id, active]
			);
			expect(held.code).toMatch(/^(23505|P0001)$/);
		});
	});

	it('versements partiels : statut et solde justes ; au-delà du convenu, refusé', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const account = await insertDepositAccount(api, a.id, active, { agreed: 150_000 });
			const status = async () => (await api.query(`select status from deposit_accounts where id = $1`, [account])).rows[0].status as string;
			expect(await status()).toBe('pending');
			await insertMovement(api, a.id, account, 'received', 100_000);
			expect(await status()).toBe('partially_received');
			const over = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'received', 50001, current_date)`,
				[newId(), a.id, account]
			);
			expect(over.message).toContain('DEPOSIT_OVERPAID');
			await insertMovement(api, a.id, account, 'received', 50_000);
			expect(await status()).toBe('held');
			const sums = await api.query(
				`select coalesce(sum(amount) filter (where type = 'received'), 0)::bigint as received from deposit_movements where account_id = $1`,
				[account]
			);
			expect(sums.rows[0].received).toBe('150000');
		});
	});

	it('sorties plafonnées au reçu ; retenue sans état des lieux ni justificatif, imputation sans accord : refusées', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const account = await insertDepositAccount(api, a.id, active);
			await insertMovement(api, a.id, account, 'received', 40_000);
			const refund = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'refunded', 40001, current_date)`,
				[newId(), a.id, account]
			);
			expect(refund.message).toContain('DEPOSIT_OUTFLOW_EXCEEDS_RECEIVED');
			const retained = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, reason, occurred_on) values ($1, $2, $3, 'retained', 1000, 'Porte', current_date)`,
				[newId(), a.id, account]
			);
			expect(retained.code).toBe('23514');
			expect(retained.message).toContain('deposit_movements_retained');
			const applied = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on) values ($1, $2, $3, 'applied_to_rent', 1000, current_date)`,
				[newId(), a.id, account]
			);
			expect(applied.message).toContain('deposit_movements_applied');
		});
	});

	it('mouvements en ajout seul : ni modification ni suppression, même par le propriétaire du schéma', async () => {
		const account = await seed(a.id, (c) => insertDepositAccount(c, a.id, active, { type: 'utilities_guarantee', agreed: 20_000 }));
		const movement = await seed(a.id, (c) => insertMovement(c, a.id, account, 'received', 20_000));
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update deposit_movements set amount = 1 where id = $1`, [movement])).code).toBe('42501');
			expect((await sqlError(api, `delete from deposit_movements where id = $1`, [movement])).code).toBe('42501');
		});
		await owner.query('BEGIN');
		try {
			await owner.query(`select set_config('app.organization_id', $1, true)`, [a.id]);
			expect((await sqlError(owner, `update deposit_movements set amount = 1 where id = $1`, [movement])).message).toContain('APPEND_ONLY');
			expect((await sqlError(owner, `delete from deposit_movements where id = $1`, [movement])).message).toContain('APPEND_ONLY');
		} finally {
			await owner.query('ROLLBACK');
		}
	});

	it('détenteur et statut : jamais modifiés par l’application ; un changement de détenteur est un mouvement', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const account = await insertDepositAccount(api, a.id, active, { holder: 'owner' });
			expect((await sqlError(api, `update deposit_accounts set holder = 'organization' where id = $1`, [account])).code).toBe('42501');
			expect((await sqlError(api, `update deposit_accounts set status = 'held' where id = $1`, [account])).code).toBe('42501');
			const mismatch = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, previous_holder, new_holder, reason, occurred_on)
				 values ($1, $2, $3, 'holder_changed', 0, 'organization', 'owner', 'Transfert', current_date)`,
				[newId(), a.id, account]
			);
			expect(mismatch.message).toContain('DEPOSIT_HOLDER_MISMATCH');
			const noReason = await sqlError(
				api,
				`insert into deposit_movements (id, organization_id, account_id, type, amount, previous_holder, new_holder, occurred_on)
				 values ($1, $2, $3, 'holder_changed', 0, 'owner', 'organization', current_date)`,
				[newId(), a.id, account]
			);
			expect(noReason.code).toBe('23514');
			await insertMovement(api, a.id, account, 'holder_changed', 0, {
				previousHolder: 'owner',
				newHolder: 'organization',
				reason: 'Le propriétaire confie la caution à l’agence'
			});
			expect((await api.query(`select holder from deposit_accounts where id = $1`, [account])).rows[0].holder).toBe('organization');
		});
	});

	it('montant convenu : modifiable tant que le bail est un brouillon, figé ensuite', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const draft = await insertLease(api, a.id, unitDraft.unit, unitDraft.tenant, { status: 'draft' });
			const draftAccount = await insertDepositAccount(api, a.id, draft, { agreed: 100_000 });
			await insertMovement(api, a.id, draftAccount, 'received', 100_000);
			expect((await api.query(`select status from deposit_accounts where id = $1`, [draftAccount])).rows[0].status).toBe('held');
			await api.query(`update deposit_accounts set agreed_amount = 150000, agreed_months = 2 where id = $1`, [draftAccount]);
			expect((await api.query(`select status from deposit_accounts where id = $1`, [draftAccount])).rows[0].status).toBe(
				'partially_received'
			);
			const below = await sqlError(api, `update deposit_accounts set agreed_amount = 90000 where id = $1`, [draftAccount]);
			expect(below.message).toContain('DEPOSIT_OVERPAID');
			const account = await insertDepositAccount(api, a.id, active, { agreed: 100_000 });
			const locked = await sqlError(api, `update deposit_accounts set agreed_amount = 200000 where id = $1`, [account]);
			expect(locked.message).toContain('DEPOSIT_TERMS_LOCKED');
		});
	});
});

describe('documents du bail', () => {
	it('le bail scanné se rattache à un bail, la pièce d’identité à un locataire', async () => {
		const { unit, tenant } = await unitAndTenant(a.id);
		await inContext(api, { organizationId: a.id }, async () => {
			const lease = await insertLease(api, a.id, unit, tenant);
			const insert = (type: string, column: 'lease_id' | 'tenant_id' | 'property_id', value: string) =>
				api.query(
					`insert into documents (id, organization_id, type, ${column}, file_name, mime_type, byte_size, storage_key, uploaded_by)
					 values ($1, $2, $3, $4, 'piece.pdf', 'application/pdf', 1000, $5, $6)`,
					[newId(), a.id, type, value, `documents/${newId()}`, a.director.userId]
				);
			await insert('signed_lease_scan', 'lease_id', lease);
			await insert('tenant_identity', 'tenant_id', tenant);
			const propertyId = (await api.query(`select property_id from units where id = $1`, [unit])).rows[0].property_id as string;
			for (const type of ['signed_lease_scan', 'tenant_identity']) {
				await api.query('SAVEPOINT s');
				const e = await insert(type, 'property_id', propertyId).catch((error: { code: string; message: string }) => error);
				await api.query('ROLLBACK TO SAVEPOINT s');
				expect(e, type).toMatchObject({ code: '23514' });
			}
		});
	});
});

describe('tâche quotidienne : organisations concernées', () => {
	it('ne renvoie que des identifiants d’organisation ; une organisation sans bail n’y est pas', async () => {
		const { unit, tenant } = await unitAndTenant(b.id);
		await seed(b.id, (c) => insertLease(c, b.id, unit, tenant, { status: 'signed', startsOn: '2026-01-01' }).then(() => undefined));
		const r = await api.query(`select * from due_lease_organizations('2026-11-15')`);
		expect(r.fields.map((f) => f.name)).toEqual(['due_lease_organizations']);
		const ids = r.rows.map((row) => row.due_lease_organizations as string);
		expect(ids).toContain(b.id);
		expect(ids).not.toContain(landlord.id);
	});
});
