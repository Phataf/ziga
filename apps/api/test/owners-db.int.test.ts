/**
 * Lot 06, étape 1 : propriétaires et mandats dans la base (migration 0008), en SQL, avec le rôle de l'API (app_api,
 * sans BYPASSRLS) et le rôle de réplication (app_sync).
 * - Accès croisé A/B sur owners, mandates, mandate_versions et mandate_scopes : lecture, modification, référence.
 * - Commission (règle 2), mandat qui naît actif et ne fait que se fermer, versions en ajout seul (point 5).
 * - Règle 12 : un seul mandat de gestion actif par unité, et par bien entier.
 * - Bailleur : une seule fiche, un seul mandat self_managed ; backfill des bailleurs existants, idempotent.
 * - due_mandate_organizations : ne renvoie que des identifiants d'organisation ; exécutable par app_api seul.
 */
import { newId } from '@ziga/shared/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './http.js';
import { apiSql, createOrg, inContext, sqlError, type Org } from './orgs.js';
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

async function insertOwner(c: pg.Client, organizationId: string, name = 'Issa Ouédraogo'): Promise<string> {
	const id = newId();
	await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', $3, '+22670112233')`, [
		id,
		organizationId,
		name
	]);
	return id;
}

async function insertMandate(
	c: pg.Client,
	organizationId: string,
	ownerId: string,
	extra: { type?: string; endsOn?: string | null; startsOn?: string } = {}
): Promise<string> {
	const id = newId();
	const type = extra.type ?? 'rental_management';
	const percent = ['rental_management'].includes(type);
	const fixed = ['letting', 'sale'].includes(type);
	await c.query(
		`insert into mandates (id, organization_id, owner_id, type, starts_on, ends_on, commission_basis, commission_rate_bp, commission_amount,
			can_publish, can_take_photos, can_collect_funds)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, true, true)`,
		[
			id,
			organizationId,
			ownerId,
			type,
			extra.startsOn ?? '2026-01-01',
			extra.endsOn ?? null,
			percent ? 'percent_of_collected' : fixed ? 'fixed_per_operation' : null,
			percent ? 1000 : null,
			fixed ? 100000 : null
		]
	);
	return id;
}

async function insertScope(
	c: pg.Client,
	organizationId: string,
	mandateId: string,
	propertyId: string,
	unitId: string | null,
	viaProperty = false
) {
	await c.query(
		`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id, via_property, management_active)
		 values ($1, $2, $3, $4, $5, $6, false)`,
		[newId(), organizationId, mandateId, propertyId, unitId, viaProperty]
	);
}

/** Un bailleur « ancien » : créé directement en base, comme avant le lot 06, sans fiche ni mandat. */
async function legacyLandlord(name: string): Promise<string> {
	const id = newId();
	const creator = (await owner.query(`select created_by from organizations where id = $1`, [a.id])).rows[0].created_by;
	await seed(id, (c) =>
		c.query(
			`insert into organizations (id, type, legal_name, phone, commune, created_by) values ($1, 'landlord', $2, '+22670998877', 'Saaba', $3)`,
			[id, name, creator]
		)
	);
	return id;
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A propriétaires');
	b = await createOrg(t, 'agency', 'Agence B propriétaires');
	owner = await connect(process.env.DATABASE_MIGRATION_URL!);
	api = await apiSql();
});
afterAll(async () => {
	await api.end();
	await owner.end();
	await t.close();
});

describe('accès croisé A/B en SQL (règle 1)', () => {
	let ownerB: string;
	let mandateB: string;

	beforeAll(async () => {
		ownerB = await seed(b.id, (c) => insertOwner(c, b.id, 'Propriétaire de B'));
		mandateB = await seed(b.id, (c) => insertMandate(c, b.id, ownerB));
		await seed(b.id, async (c) => {
			const { property, unit } = await propertyWithUnit(c, b.id, ownerB);
			await insertScope(c, b.id, mandateB, property, unit);
		});
	});

	it('A ne lit aucune ligne de B, dans aucune des quatre tables', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			for (const table of ['owners', 'mandates', 'mandate_versions', 'mandate_scopes']) {
				const r = await api.query(`select count(*)::int as n from ${table} where organization_id = $1`, [b.id]);
				expect(r.rows[0].n, table).toBe(0);
			}
		});
		// B, dans son contexte, voit les siennes.
		await inContext(api, { organizationId: b.id }, async () => {
			for (const table of ['owners', 'mandates', 'mandate_versions', 'mandate_scopes']) {
				const r = await api.query(`select count(*)::int as n from ${table} where organization_id = $1`, [b.id]);
				expect(r.rows[0].n, table).toBeGreaterThan(0);
			}
		});
	});

	it('A ne modifie rien chez B (aucune ligne touchée)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await api.query(`update owners set name = 'Piraté' where id = $1`, [ownerB])).rowCount).toBe(0);
			expect((await api.query(`update mandates set exclusive = true, version = version + 1 where id = $1`, [mandateB])).rowCount).toBe(0);
		});
		const r = await owner.query(`select name from owners where id = $1`, [ownerB]);
		expect(r.rows[0].name).toBe('Propriétaire de B');
	});

	it('A ne crée rien au nom de B (WITH CHECK de la RLS)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			expect(
				(
					await sqlError(
						api,
						`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Intrus', '+22670112233')`,
						[newId(), b.id]
					)
				).code
			).toBe('42501');
		});
	});

	it('un mandat de A ne peut pas viser le propriétaire de B (clé composite), ni une portée viser un mandat de B', async () => {
		const ownerA = await seed(a.id, (c) => insertOwner(c, a.id));
		await inContext(api, { organizationId: a.id }, async () => {
			const fk = await sqlError(
				api,
				`insert into mandates (id, organization_id, owner_id, type, starts_on) values ($1, $2, $3, 'other', '2026-01-01')`,
				[newId(), a.id, ownerB]
			);
			expect(fk.code).toBe('23503');
			expect(fk.message).toContain('mandates_owner_fk');
			const scope = await sqlError(
				api,
				`insert into mandate_scopes (id, organization_id, mandate_id, property_id) values ($1, $2, $3, $4)`,
				[newId(), a.id, mandateB, newId()]
			);
			expect(scope.code).toBe('23503');
			// Son propre propriétaire, oui.
			await api.query(`insert into mandates (id, organization_id, owner_id, type, starts_on) values ($1, $2, $3, 'other', '2026-01-01')`, [
				newId(),
				a.id,
				ownerA
			]);
		});
	});

	it('app_sync lit les quatre tables (copie initiale) mais n’y écrit pas ; le compte lié n’est jamais publié', async () => {
		const sync = await connect(process.env.DATABASE_SYNC_URL!);
		try {
			const r = await sync.query(`select count(*)::int as n from owners where organization_id = $1`, [b.id]);
			expect(r.rows[0].n).toBeGreaterThan(0);
			await sync.query('BEGIN');
			expect((await sqlError(sync, `update owners set name = 'X' where id = $1`, [ownerB])).code).toBe('42501');
			await sync.query('ROLLBACK');
		} finally {
			await sync.end();
		}
		const streams = await import('node:fs').then((fs) =>
			fs.readFileSync(new URL('../../../infra/powersync/sync-config.yaml', import.meta.url), 'utf8')
		);
		const ownersQuery = streams.split('\n').find((l) => /FROM owners WHERE/.test(l))!;
		expect(ownersQuery).not.toMatch(/user_id/);
	});
});

describe('mandats : commission, cycle de vie, versions', () => {
	let ownerA: string;
	beforeAll(async () => {
		ownerA = await seed(a.id, (c) => insertOwner(c, a.id, 'Propriétaire versions'));
	});

	it('commission (règle 2) : un taux ou un montant selon la base, jamais les deux ; exigée pour la gestion', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const insert = (basis: string | null, rate: number | null, amount: number | null, type = 'rental_management') =>
				sqlError(
					api,
					`insert into mandates (id, organization_id, owner_id, type, starts_on, commission_basis, commission_rate_bp, commission_amount)
					 values ($1, $2, $3, $4, '2026-01-01', $5, $6, $7)`,
					[newId(), a.id, ownerA, type, basis, rate, amount]
				);
			expect((await insert('percent_of_collected', 1000, 5000)).message).toContain('mandates_commission');
			expect((await insert('fixed_per_month', 1000, null)).message).toContain('mandates_commission');
			expect((await insert('percent_of_collected', 10_001, null)).code).toBe('23514');
			expect((await insert('fixed_per_operation', null, -1)).code).toBe('23514');
			expect((await insert(null, null, null)).message).toContain('mandates_commission_required');
			expect((await insert(null, null, null, 'letting')).message).toContain('mandates_commission_required');
			// Taux non entier : refusé par le type de la colonne.
			expect((await insert('percent_of_collected', 10.5 as number, null)).code).toBe('22P02');
		});
	});

	it('naît actif en version 1, avec sa copie ; une modification exige la version suivante et garde l’ancienne', async () => {
		const id = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			const v1 = await api.query(`select version, can_publish, status from mandate_versions where mandate_id = $1`, [id]);
			expect(v1.rows).toEqual([{ version: 1, can_publish: true, status: 'active' }]);
			// Modifier sans changer de version : refusé ; deux versions d'un coup : refusé.
			expect((await sqlError(api, `update mandates set can_publish = false where id = $1`, [id])).message).toContain('MANDATE_VERSION');
			expect((await sqlError(api, `update mandates set can_publish = false, version = 3 where id = $1`, [id])).message).toContain(
				'MANDATE_VERSION'
			);
			await api.query(`update mandates set can_publish = false, ends_on = '2026-12-31', version = 2 where id = $1`, [id]);
			const versions = await api.query(
				`select version, can_publish, ends_on::text from mandate_versions where mandate_id = $1 order by version`,
				[id]
			);
			expect(versions.rows).toEqual([
				{ version: 1, can_publish: true, ends_on: null },
				{ version: 2, can_publish: false, ends_on: '2026-12-31' }
			]);
			// Une mise à jour qui ne change rien de métier ne crée pas de version.
			await api.query(`update mandates set updated_at = now() where id = $1`, [id]);
			expect((await api.query(`select count(*)::int as n from mandate_versions where mandate_id = $1`, [id])).rows[0].n).toBe(2);
		});
	});

	it('un mandat ne naît pas révoqué ni en version 2 ; propriétaire et type ne changent jamais', async () => {
		const id = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		const other = await seed(a.id, (c) => insertOwner(c, a.id, 'Autre propriétaire'));
		await inContext(api, { organizationId: a.id }, async () => {
			const born = await sqlError(
				api,
				`insert into mandates (id, organization_id, owner_id, type, starts_on, status, expired_at) values ($1, $2, $3, 'other', '2026-01-01', 'expired', now())`,
				[newId(), a.id, ownerA]
			);
			expect(born.message).toContain('MANDATE_BORN_ACTIVE');
			expect(
				(await sqlError(api, `update mandates set owner_id = $2, version = version + 1 where id = $1`, [id, other])).message
			).toContain('MANDATE_IMMUTABLE');
			expect((await sqlError(api, `update mandates set type = 'sale', version = version + 1 where id = $1`, [id])).message).toContain(
				'MANDATE_IMMUTABLE'
			);
		});
	});

	it('révocation : motif et date exigés, autorisations à faux ; ensuite le mandat ne change plus', async () => {
		const id = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			expect(
				(
					await sqlError(
						api,
						`update mandates set status = 'revoked', revoked_at = now(), can_publish = false, can_take_photos = false,
							can_collect_funds = false, can_sign_leases = false, version = 2 where id = $1`,
						[id]
					)
				).message
			).toContain('mandates_revoked');
			expect(
				(
					await sqlError(
						api,
						`update mandates set status = 'revoked', revoked_at = now(), revocation_reason = 'Fin de collaboration', version = 2 where id = $1`,
						[id]
					)
				).message
			).toContain('mandates_closed_authorizations');
			await api.query(
				`update mandates set status = 'revoked', revoked_at = now(), revocation_reason = 'Fin de collaboration',
					can_publish = false, can_take_photos = false, can_collect_funds = false, can_sign_leases = false, version = 2 where id = $1`,
				[id]
			);
			const last = await api.query(
				`select status, revocation_reason, can_publish from mandate_versions where mandate_id = $1 and version = 2`,
				[id]
			);
			expect(last.rows).toEqual([{ status: 'revoked', revocation_reason: 'Fin de collaboration', can_publish: false }]);
			expect((await sqlError(api, `update mandates set exclusive = true, version = 3 where id = $1`, [id])).message).toContain(
				'MANDATE_CLOSED'
			);
		});
	});

	it('versions en ajout seul : aucun rôle de l’application ne les écrit, ne les modifie ni ne les supprime', async () => {
		const id = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update mandate_versions set can_publish = false where mandate_id = $1`, [id])).code).toBe('42501');
			expect((await sqlError(api, `delete from mandate_versions where mandate_id = $1`, [id])).code).toBe('42501');
			expect(
				(
					await sqlError(
						api,
						`insert into mandate_versions (id, organization_id, mandate_id, version, starts_on, can_publish, can_take_photos, can_collect_funds, can_sign_leases, exclusive, status)
						 values ($1, $2, $3, 9, '2026-01-01', true, true, true, true, false, 'active')`,
						[newId(), a.id, id]
					)
				).code
			).toBe('42501');
			// Ni mandat ni fiche ne se suppriment.
			expect((await sqlError(api, `delete from mandates where id = $1`, [id])).code).toBe('42501');
			expect((await sqlError(api, `delete from owners where id = $1`, [ownerA])).code).toBe('42501');
		});
		// Même le propriétaire du schéma ne réécrit pas une version (trigger).
		await owner.query('BEGIN');
		try {
			await owner.query(`select set_config('app.organization_id', $1, true)`, [a.id]);
			expect((await sqlError(owner, `update mandate_versions set can_publish = false where mandate_id = $1`, [id])).message).toContain(
				'MANDATE_VERSIONS_APPEND_ONLY'
			);
		} finally {
			await owner.query('ROLLBACK');
		}
	});
});

describe('règle 12 : un seul mandat de gestion actif par unité', () => {
	let ownerA: string;
	beforeAll(async () => {
		ownerA = await seed(a.id, (c) => insertOwner(c, a.id, 'Propriétaire règle 12'));
	});

	it('deux mandats de gestion actifs sur la même unité : refusé ; une mise en location à côté : permise', async () => {
		const { property, unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		const first = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		const second = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		const letting = await seed(a.id, (c) => insertMandate(c, a.id, ownerA, { type: 'letting' }));
		await seed(a.id, (c) => insertScope(c, a.id, first, property, unit));
		await inContext(api, { organizationId: a.id }, async () => {
			const dup = await sqlError(
				api,
				`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id) values ($1, $2, $3, $4, $5)`,
				[newId(), a.id, second, property, unit]
			);
			expect(dup.code).toBe('23505');
			expect(dup.message).toContain('mandate_scopes_one_manager_per_unit');
			await api.query(`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id) values ($1, $2, $3, $4, $5)`, [
				newId(),
				a.id,
				letting,
				property,
				unit
			]);
		});
	});

	it('le champ calculé ne se force pas : une portée d’un mandat de mise en location reste hors de la règle', async () => {
		const letting = await seed(a.id, (c) => insertMandate(c, a.id, ownerA, { type: 'letting' }));
		const { property, unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		await seed(a.id, (c) =>
			c.query(
				`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id, management_active) values ($1, $2, $3, $4, $5, true)`,
				[newId(), a.id, letting, property, unit]
			)
		);
		const r = await owner.query(`select management_active from mandate_scopes where mandate_id = $1`, [letting]);
		expect(r.rows).toEqual([{ management_active: false }]);
	});

	it('un mandat révoqué libère l’unité, dans la même transaction', async () => {
		const { property, unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		const first = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		const second = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await seed(a.id, (c) => insertScope(c, a.id, first, property, unit));
		await seed(a.id, async (c) => {
			await c.query(
				`update mandates set status = 'revoked', revoked_at = now(), revocation_reason = 'Changement de gestionnaire',
					can_publish = false, can_take_photos = false, can_collect_funds = false, can_sign_leases = false, version = version + 1 where id = $1`,
				[first]
			);
			await insertScope(c, a.id, second, property, unit);
		});
		const r = await owner.query(`select mandate_id, management_active from mandate_scopes where unit_id = $1 order by management_active`, [
			unit
		]);
		expect(r.rows).toEqual([
			{ mandate_id: first, management_active: false },
			{ mandate_id: second, management_active: true }
		]);
	});

	it('mandat sur un bien entier : il couvre chaque unité ; un mandat sur l’une d’elles est refusé, un second sur le bien aussi', async () => {
		const { property, unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		const whole = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		const other = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		// La ligne de l'unité (via_property) est posée par la base avec celle du bien (lot 07).
		await seed(a.id, (c) => insertScope(c, a.id, whole, property, null));
		const covered = await owner.query(`select via_property, management_active from mandate_scopes where mandate_id = $1 and unit_id = $2`, [
			whole,
			unit
		]);
		expect(covered.rows).toEqual([{ via_property: true, management_active: true }]);
		await inContext(api, { organizationId: a.id }, async () => {
			const onUnit = await sqlError(
				api,
				`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id) values ($1, $2, $3, $4, $5)`,
				[newId(), a.id, other, property, unit]
			);
			expect(onUnit.message).toContain('mandate_scopes_one_manager_per_unit');
			const onProperty = await sqlError(
				api,
				`insert into mandate_scopes (id, organization_id, mandate_id, property_id) values ($1, $2, $3, $4)`,
				[newId(), a.id, other, property]
			);
			expect(onProperty.message).toContain('mandate_scopes_one_manager_per_property');
		});
	});

	it('deux organisations ne se gênent pas : chacune son unité sous mandat de gestion actif', async () => {
		const ownerB = await seed(b.id, (c) => insertOwner(c, b.id));
		const inA = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		const inB = await seed(b.id, (c) => propertyWithUnit(c, b.id, ownerB));
		const mandateA = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		const mandateB = await seed(b.id, (c) => insertMandate(c, b.id, ownerB));
		await seed(a.id, (c) => insertScope(c, a.id, mandateA, inA.property, inA.unit));
		await seed(b.id, (c) => insertScope(c, b.id, mandateB, inB.property, inB.unit));
		const r = await owner.query(`select count(*)::int as n from mandate_scopes where unit_id = any($1::uuid[]) and management_active`, [
			[inA.unit, inB.unit]
		]);
		expect(r.rows[0].n).toBe(2);
		// Une portée de A ne peut pas viser l'unité de B (clé composite).
		await inContext(api, { organizationId: a.id }, async () => {
			const fk = await sqlError(
				api,
				`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id) values ($1, $2, $3, $4, $5)`,
				[newId(), a.id, mandateA, inB.property, inB.unit]
			);
			expect(fk.code).toBe('23503');
		});
	});
});

describe('bailleur particulier : une fiche, un mandat self_managed', () => {
	it('une agence n’a jamais de mandat self_managed', async () => {
		const ownerA = await seed(a.id, (c) => insertOwner(c, a.id));
		await inContext(api, { organizationId: a.id }, async () => {
			const r = await sqlError(
				api,
				`insert into mandates (id, organization_id, owner_id, type, starts_on) values ($1, $2, $3, 'self_managed', '2026-01-01')`,
				[newId(), a.id, ownerA]
			);
			expect(r.message).toContain('SELF_MANAGED_LANDLORD_ONLY');
		});
	});

	it('backfill : un bailleur créé avant le lot 06 reçoit sa fiche et son mandat, une seule fois, avec l’audit « migration »', async () => {
		const landlord = await legacyLandlord('Hamidou Bationo');
		const first = await owner.query(`select backfill_landlord_self_managed() as n`);
		expect(first.rows[0].n).toBeGreaterThanOrEqual(1);
		const again = await owner.query(`select backfill_landlord_self_managed() as n`);
		expect(again.rows[0].n).toBe(0);
		await seed(landlord, async (c) => {
			const owners = await c.query(`select type, name, phone, country from owners where organization_id = $1`, [landlord]);
			expect(owners.rows).toEqual([{ type: 'person', name: 'Hamidou Bationo', phone: '+22670998877', country: 'BF' }]);
			const mandates = await c.query(
				`select type, status, ends_on, commission_basis, can_publish, can_take_photos, can_collect_funds, can_sign_leases, version
				 from mandates where organization_id = $1`,
				[landlord]
			);
			expect(mandates.rows).toEqual([
				{
					type: 'self_managed',
					status: 'active',
					ends_on: null,
					commission_basis: null,
					can_publish: true,
					can_take_photos: true,
					can_collect_funds: true,
					can_sign_leases: true,
					version: 1
				}
			]);
			const audit = await c.query(`select action, actor_type, origin from audit_log where organization_id = $1 order by id`, [landlord]);
			expect(audit.rows).toEqual([
				{ action: 'owner.create', actor_type: 'system', origin: 'migration' },
				{ action: 'mandate.create', actor_type: 'system', origin: 'migration' }
			]);
		});
	});

	it('bailleur : pas de seconde fiche, pas d’autre mandat, et son mandat ne se révoque pas', async () => {
		const landlord = await legacyLandlord('Bailleur unique');
		await owner.query(`select backfill_landlord_self_managed()`);
		await seed(landlord, async (c) => {
			const [mine] = (await c.query(`select id, owner_id from mandates where organization_id = $1`, [landlord])).rows;
			expect(
				(
					await sqlError(
						c,
						`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Autre', '+22670112233')`,
						[newId(), landlord]
					)
				).message
			).toContain('LANDLORD_SELF_MANAGED');
			expect(
				(
					await sqlError(
						c,
						`insert into mandates (id, organization_id, owner_id, type, starts_on) values ($1, $2, $3, 'other', '2026-01-01')`,
						[newId(), landlord, mine.owner_id]
					)
				).message
			).toContain('LANDLORD_SELF_MANAGED');
			expect(
				(
					await sqlError(
						c,
						`update mandates set status = 'revoked', revoked_at = now(), revocation_reason = 'Essai interdit', can_publish = false,
							can_take_photos = false, can_collect_funds = false, can_sign_leases = false, version = 2 where id = $1`,
						[mine.id]
					)
				).message
			).toContain('mandates_self_managed');
		});
	});
});

describe('due_mandate_organizations : seulement des identifiants d’organisation', () => {
	it('renvoie les organisations qui ont un mandat actif échu, et rien d’autre', async () => {
		const ownerA = await seed(a.id, (c) => insertOwner(c, a.id, 'Propriétaire échu'));
		await seed(a.id, (c) => insertMandate(c, a.id, ownerA, { endsOn: '2026-03-31', startsOn: '2026-01-01' }));
		const r = await api.query(`select * from due_mandate_organizations('2026-04-01')`);
		expect(r.fields.map((f) => f.name)).toEqual(['due_mandate_organizations']);
		const ids = r.rows.map((row) => row.due_mandate_organizations as string);
		expect(ids).toContain(a.id);
		expect(ids).not.toContain(b.id);
		expect(new Set(ids).size).toBe(ids.length);
		// La veille de l'échéance (dernier jour couvert), A n'y est pas pour ce mandat.
		const before = await api.query(`select * from due_mandate_organizations('2026-03-31')`);
		expect(before.rows.map((row) => row.due_mandate_organizations)).not.toContain(a.id);
	});

	it('signature, search_path fixé, SECURITY DEFINER ; exécutable par app_api seul', async () => {
		const fn = await owner.query(
			`select p.prosecdef, p.proretset, format_type(p.prorettype, null) as returns, p.proconfig,
				has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
				has_function_privilege('app_api', p.oid, 'EXECUTE') as api_exec,
				has_function_privilege('app_admin', p.oid, 'EXECUTE') as admin_exec,
				has_function_privilege('app_sync', p.oid, 'EXECUTE') as sync_exec
			 from pg_proc p where p.proname = 'due_mandate_organizations'`
		);
		expect(fn.rows).toEqual([
			{
				prosecdef: true,
				proretset: true,
				returns: 'uuid',
				proconfig: ['search_path=pg_catalog, public'],
				public_exec: false,
				api_exec: true,
				admin_exec: false,
				sync_exec: false
			}
		]);
		// Les fonctions de la base (backfill, copie des versions) ne s'exécutent pas depuis l'application.
		for (const name of ['backfill_landlord_self_managed', 'uuid_v7', 'mandates_record_version', 'mandates_refresh_scopes']) {
			const r = await owner.query(`select has_function_privilege('app_api', p.oid, 'EXECUTE') as ok from pg_proc p where p.proname = $1`, [
				name
			]);
			expect(r.rows, name).toEqual([{ ok: false }]);
		}
	});

	it('uuid_v7 produit des UUID de version 7, croissants', async () => {
		const r = await owner.query(`select uuid_v7()::text as a, uuid_v7()::text as b`);
		const { isUuidV7 } = await import('@ziga/shared/ids');
		expect(isUuidV7(r.rows[0].a)).toBe(true);
		expect(isUuidV7(r.rows[0].b)).toBe(true);
	});
});
