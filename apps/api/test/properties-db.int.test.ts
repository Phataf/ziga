/**
 * Lot 07, étape 1 : biens, unités, photos et documents dans la base (migration 0010), en SQL, avec le rôle de l'API
 * (app_api, sans BYPASSRLS) et le rôle de réplication (app_sync).
 * - Accès croisé A/B sur properties, units, media et documents : lecture, modification, création, référence.
 * - Règle 12 dans les deux sens : unité créée dans un bien couvert ; mandat posé sur un bien qui a déjà des unités.
 * - Statut d'unité (D14) : l'occupation n'est pas une colonne ; motif obligatoire hors « prête » ; agent affecté.
 * - Photos : 15 au plus par unité, la 16e refusée ; documents : versions figées, chaîne de remplacement.
 */
import { DOCUMENT_MIME_TYPES, DOCUMENT_TYPES } from '@ziga/shared/documents';
import { newId } from '@ziga/shared/ids';
import {
	AMENITIES,
	DECLARED_LAND_DOCUMENTS,
	PHOTO_MIME_TYPES,
	PROPERTY_OPERATIONS,
	PROPERTY_TYPES,
	TECHNICAL_STATUSES,
	UNIT_TYPES,
	UNIT_USAGES
} from '@ziga/shared/properties';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './http.js';
import { addMember, apiSql, createOrg, inContext, sqlError, type Member, type Org } from './orgs.js';
import { aNeighborhood, insertProperty, insertUnit, propertyWithUnit } from './properties.js';

let t: TestApp;
let a: Org;
let b: Org;
let agentA: Member;
let managerA: Member;
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

async function insertOwner(c: pg.Client, organizationId: string, name = 'Awa Sawadogo'): Promise<string> {
	const id = newId();
	await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', $3, '+22670445566')`, [
		id,
		organizationId,
		name
	]);
	return id;
}

async function insertMandate(c: pg.Client, organizationId: string, ownerId: string, type = 'rental_management'): Promise<string> {
	const id = newId();
	const commission =
		type === 'rental_management'
			? { basis: 'percent_of_collected', rate: 1000, amount: null }
			: { basis: 'fixed_per_operation', rate: null, amount: 50000 };
	await c.query(
		`insert into mandates (id, organization_id, owner_id, type, starts_on, commission_basis, commission_rate_bp, commission_amount)
		 values ($1, $2, $3, $4, '2026-01-01', $5, $6, $7)`,
		[id, organizationId, ownerId, type, commission.basis, commission.rate, commission.amount]
	);
	return id;
}

async function insertScope(c: pg.Client, organizationId: string, mandateId: string, propertyId: string, unitId: string | null = null) {
	await c.query(`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id) values ($1, $2, $3, $4, $5)`, [
		newId(),
		organizationId,
		mandateId,
		propertyId,
		unitId
	]);
}

async function insertMedia(c: pg.Client, organizationId: string, propertyId: string, unitId: string | null): Promise<string> {
	const id = newId();
	await c.query(
		`insert into media (id, organization_id, property_id, unit_id, mime_type, byte_size) values ($1, $2, $3, $4, 'image/jpeg', 350000)`,
		[id, organizationId, propertyId, unitId]
	);
	return id;
}

async function insertDocument(
	c: pg.Client,
	organizationId: string,
	subject: { propertyId?: string; ownerId?: string; unitId?: string },
	extra: { replaces?: string; version?: number; type?: string } = {}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into documents (id, organization_id, type, owner_id, property_id, unit_id, version, replaces_id, file_name, mime_type, byte_size,
			storage_key, uploaded_by)
		 select $1, $2, $3, $4, $5, $6, $7, $8, 'titre-foncier.pdf', 'application/pdf', 120000, $9, created_by from organizations where id = $2`,
		[
			id,
			organizationId,
			extra.type ?? 'title_deed',
			subject.ownerId ?? null,
			subject.propertyId ?? null,
			subject.unitId ?? null,
			extra.version ?? 1,
			extra.replaces ?? null,
			`documents/${organizationId}/${id}`
		]
	);
	return id;
}

const SHA = 'a'.repeat(64);

async function activate(c: pg.Client, documentId: string, sha = SHA) {
	await c.query(`update documents set status = 'active', sha256 = $2, activated_at = now() where id = $1`, [documentId, sha]);
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A biens');
	b = await createOrg(t, 'agency', 'Agence B biens');
	agentA = await addMember(t, a, 'field_agent');
	managerA = await addMember(t, a, 'manager');
	owner = await connect(process.env.DATABASE_MIGRATION_URL!);
	api = await apiSql();
});
afterAll(async () => {
	await api.end();
	await owner.end();
	await t.close();
});

describe('accès croisé A/B en SQL (règle 1)', () => {
	const tables = ['properties', 'units', 'media', 'documents'];
	let inB: { owner: string; property: string; unit: string; media: string; document: string };

	beforeAll(async () => {
		inB = await seed(b.id, async (c) => {
			const ownerB = await insertOwner(c, b.id, 'Propriétaire de B');
			const { property, unit } = await propertyWithUnit(c, b.id, ownerB);
			const media = await insertMedia(c, b.id, property, unit);
			const document = await insertDocument(c, b.id, { propertyId: property });
			return { owner: ownerB, property, unit, media, document };
		});
	});

	it('A ne lit aucune ligne de B, dans aucune des quatre tables ; B voit les siennes', async () => {
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
			expect((await api.query(`update properties set name = 'Piraté' where id = $1`, [inB.property])).rowCount).toBe(0);
			expect((await api.query(`update units set label = 'Piraté' where id = $1`, [inB.unit])).rowCount).toBe(0);
			expect((await api.query(`update media set caption = 'Piraté' where id = $1`, [inB.media])).rowCount).toBe(0);
			expect((await api.query(`update documents set restriction = 'director_only' where id = $1`, [inB.document])).rowCount).toBe(0);
		});
		const r = await owner.query(`select name from properties where id = $1`, [inB.property]);
		expect(r.rows[0].name).toBe('Immeuble de test');
	});

	it('A ne crée rien au nom de B (WITH CHECK de la RLS)', async () => {
		const ownerA = await seed(a.id, (c) => insertOwner(c, a.id));
		await inContext(api, { organizationId: a.id }, async () => {
			const r = await sqlError(
				api,
				`insert into properties (id, organization_id, owner_id, type, name) values ($1, $2, $3, 'house', 'Intrus')`,
				[newId(), b.id, ownerA]
			);
			expect(r.code).toBe('42501');
		});
	});

	it('A ne référence aucune ligne de B : propriétaire, bien, unité, photo, document remplacé (clés composites)', async () => {
		const ownerA = await seed(a.id, (c) => insertOwner(c, a.id));
		const mine = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			const cases: [string, unknown[], string][] = [
				[
					`insert into properties (id, organization_id, owner_id, type, name) values ($1, $2, $3, 'house', 'Bien')`,
					[newId(), a.id, inB.owner],
					'properties_owner_fk'
				],
				[
					`insert into units (id, organization_id, property_id, type, label) values ($1, $2, $3, 'studio', 'S1')`,
					[newId(), a.id, inB.property],
					'units_property_fk'
				],
				[
					`insert into media (id, organization_id, property_id, unit_id, mime_type, byte_size) values ($1, $2, $3, $4, 'image/jpeg', 1000)`,
					[newId(), a.id, inB.property, inB.unit],
					'media_property_fk'
				],
				[
					// Ma propre unité, rattachée au bien de B : refusée aussi.
					`insert into media (id, organization_id, property_id, unit_id, mime_type, byte_size) values ($1, $2, $3, $4, 'image/jpeg', 1000)`,
					[newId(), a.id, inB.property, mine.unit],
					'media_property_fk'
				],
				[
					`insert into documents (id, organization_id, type, property_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
					 values ($1, $2, 'title_deed', $3, 'x.pdf', 'application/pdf', 1000, $4, $5)`,
					[newId(), a.id, inB.property, `documents/${newId()}`, a.director.userId],
					'documents_property_fk'
				],
				[
					`insert into documents (id, organization_id, type, property_id, version, replaces_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
					 values ($1, $2, 'title_deed', $3, 2, $4, 'x.pdf', 'application/pdf', 1000, $5, $6)`,
					[newId(), a.id, mine.property, inB.document, `documents/${newId()}`, a.director.userId],
					'documents_replaces_fk'
				]
			];
			for (const [query, params, constraint] of cases) {
				const e = await sqlError(api, query, params);
				expect(e.code, constraint).toMatch(/^(23503|P0001)$/);
				if (e.code === '23503') expect(e.message, constraint).toContain(constraint);
			}
			// Une unité de A affectée à un membre de B : refusée (le membre n'est pas de l'organisation).
			const agent = await sqlError(api, `update units set assigned_agent_id = $2 where id = $1`, [mine.unit, b.director.userId]);
			expect(agent.code).toMatch(/^(23503|P0001)$/);
		});
	});

	it('app_sync lit les quatre tables (copie initiale) mais n’y écrit pas', async () => {
		const sync = await connect(process.env.DATABASE_SYNC_URL!);
		try {
			for (const table of tables) {
				const r = await sync.query(`select count(*)::int as n from ${table} where organization_id = $1`, [b.id]);
				expect(r.rows[0].n, table).toBeGreaterThan(0);
			}
			await sync.query('BEGIN');
			try {
				expect((await sqlError(sync, `update units set label = 'x' where id = $1`, [inB.unit])).code).toBe('42501');
			} finally {
				await sync.query('ROLLBACK');
			}
		} finally {
			await sync.end();
		}
	});

	it('rien ne se supprime : ni bien, ni unité, ni photo, ni document', async () => {
		await inContext(api, { organizationId: b.id }, async () => {
			for (const table of tables)
				expect((await sqlError(api, `delete from ${table} where organization_id = $1`, [b.id])).code, table).toBe('42501');
		});
	});
});

describe('règle 12 dans les deux sens (D16)', () => {
	let ownerA: string;
	beforeAll(async () => {
		ownerA = await seed(a.id, (c) => insertOwner(c, a.id, 'Propriétaire règle 12'));
	});

	it('sens 1 : un mandat posé sur un bien couvre ses unités existantes', async () => {
		const property = await seed(a.id, (c) => insertProperty(c, a.id, ownerA));
		const units = await seed(a.id, async (c) => [await insertUnit(c, a.id, property), await insertUnit(c, a.id, property)]);
		const mandate = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await seed(a.id, (c) => insertScope(c, a.id, mandate, property));
		const r = await owner.query(
			`select unit_id, via_property, management_active from mandate_scopes where mandate_id = $1 order by unit_id nulls first`,
			[mandate]
		);
		expect(r.rows).toEqual([
			{ unit_id: null, via_property: false, management_active: true },
			...units.sort().map((unit_id) => ({ unit_id, via_property: true, management_active: true }))
		]);
	});

	it('sens 2 : une unité créée dans un bien couvert reçoit sa portée, dans la même transaction', async () => {
		const property = await seed(a.id, (c) => insertProperty(c, a.id, ownerA));
		const mandate = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await seed(a.id, (c) => insertScope(c, a.id, mandate, property));
		const unit = await seed(a.id, (c) => insertUnit(c, a.id, property));
		const r = await owner.query(`select mandate_id, via_property, management_active from mandate_scopes where unit_id = $1`, [unit]);
		expect(r.rows).toEqual([{ mandate_id: mandate, via_property: true, management_active: true }]);
		// Un second mandat de gestion ne peut alors viser ni l'unité, ni le bien.
		const other = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			expect(
				(
					await sqlError(
						api,
						`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id) values ($1, $2, $3, $4, $5)`,
						[newId(), a.id, other, property, unit]
					)
				).message
			).toContain('mandate_scopes_one_manager_per_unit');
			expect(
				(
					await sqlError(api, `insert into mandate_scopes (id, organization_id, mandate_id, property_id) values ($1, $2, $3, $4)`, [
						newId(),
						a.id,
						other,
						property
					])
				).code
			).toBe('23505');
		});
	});

	it('une unité déjà gérée par un autre mandat bloque le mandat sur le bien entier : rien n’est posé', async () => {
		const { property, unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		const onUnit = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await seed(a.id, (c) => insertScope(c, a.id, onUnit, property, unit));
		const whole = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			const e = await sqlError(api, `insert into mandate_scopes (id, organization_id, mandate_id, property_id) values ($1, $2, $3, $4)`, [
				newId(),
				a.id,
				whole,
				property
			]);
			expect(e.code).toBe('23505');
			expect(e.message).toContain('mandate_scopes_one_manager_per_unit');
		});
		expect((await owner.query(`select count(*)::int as n from mandate_scopes where mandate_id = $1`, [whole])).rows[0].n).toBe(0);
	});

	it('une mise en location sur le bien couvre aussi ses unités, sans entrer dans la règle ; un mandat fermé ne couvre plus les nouvelles unités', async () => {
		const property = await seed(a.id, (c) => insertProperty(c, a.id, ownerA));
		const letting = await seed(a.id, (c) => insertMandate(c, a.id, ownerA, 'letting'));
		await seed(a.id, (c) => insertScope(c, a.id, letting, property));
		const unit = await seed(a.id, (c) => insertUnit(c, a.id, property));
		expect((await owner.query(`select management_active from mandate_scopes where unit_id = $1`, [unit])).rows).toEqual([
			{ management_active: false }
		]);
		await seed(a.id, (c) =>
			c.query(
				`update mandates set status = 'revoked', revoked_at = now(), revocation_reason = 'Fin de la mise en location', can_publish = false,
					can_take_photos = false, can_collect_funds = false, can_sign_leases = false, version = version + 1 where id = $1`,
				[letting]
			)
		);
		const later = await seed(a.id, (c) => insertUnit(c, a.id, property));
		expect((await owner.query(`select count(*)::int as n from mandate_scopes where unit_id = $1`, [later])).rows[0].n).toBe(0);
	});

	it('un mandat ne couvre que les biens de son propriétaire ; le propriétaire d’un bien géré ne change pas', async () => {
		const other = await seed(a.id, (c) => insertOwner(c, a.id, 'Autre propriétaire'));
		const property = await seed(a.id, (c) => insertProperty(c, a.id, ownerA));
		const mandateOfOther = await seed(a.id, (c) => insertMandate(c, a.id, other));
		await inContext(api, { organizationId: a.id }, async () => {
			const e = await sqlError(api, `insert into mandate_scopes (id, organization_id, mandate_id, property_id) values ($1, $2, $3, $4)`, [
				newId(),
				a.id,
				mandateOfOther,
				property
			]);
			expect(e.message).toContain('MANDATE_SCOPE_OWNER');
		});
		const mandate = await seed(a.id, (c) => insertMandate(c, a.id, ownerA));
		await seed(a.id, (c) => insertScope(c, a.id, mandate, property));
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update properties set owner_id = $2 where id = $1`, [property, other])).message).toContain(
				'PROPERTY_OWNER_LOCKED'
			);
		});
	});
});

describe('triggers de portée : SECURITY DEFINER, search_path fixé, non exécutables depuis l’application', () => {
	it('mandate_scopes_cover_units et units_inherit_scopes', async () => {
		const r = await owner.query(
			`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
				has_function_privilege('app_api', p.oid, 'EXECUTE') as api_exec
			 from pg_proc p where p.proname in ('mandate_scopes_cover_units', 'units_inherit_scopes') order by p.proname`
		);
		expect(r.rows).toEqual(
			['mandate_scopes_cover_units', 'units_inherit_scopes'].map((proname) => ({
				proname,
				prosecdef: true,
				proconfig: ['search_path=pg_catalog, public'],
				public_exec: false,
				api_exec: false
			}))
		);
	});
});

describe('biens et unités : localisation, statut (D14), agent affecté', () => {
	let ownerA: string;
	beforeAll(async () => {
		ownerA = await seed(a.id, (c) => insertOwner(c, a.id, 'Propriétaire des statuts'));
	});

	it('brouillon sans localisation ; fiche active : commune et quartier exigés, le quartier de la commune', async () => {
		const draft = await seed(a.id, (c) => insertProperty(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update properties set record_status = 'active' where id = $1`, [draft])).message).toContain(
				'properties_located'
			);
			const saaba = await aNeighborhood(api, 'saaba');
			expect(
				(await sqlError(api, `update properties set commune_id = 'ouagadougou', neighborhood_id = $2 where id = $1`, [draft, saaba]))
					.message
			).toContain('properties_neighborhood_fk');
			await api.query(`update properties set commune_id = 'saaba', neighborhood_id = $2, record_status = 'active' where id = $1`, [
				draft,
				saaba
			]);
			expect((await sqlError(api, `update properties set gps_lat = 12.3 where id = $1`, [draft])).message).toContain('properties_gps');
			expect(
				(await sqlError(api, `update properties set declared_land_documents = array['none', 'puh'] where id = $1`, [draft])).message
			).toContain('properties_land_documents');
		});
	});

	it('l’occupation n’est pas une colonne : elle ne peut ni se stocker, ni s’écrire', async () => {
		const r = await owner.query(
			`select column_name from information_schema.columns where table_name = 'units' and column_name ~ '(occupan|lease|tenant)'`
		);
		expect(r.rows).toEqual([]);
		const { unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update units set occupancy = 'occupied' where id = $1`, [unit])).code).toBe('42703');
		});
	});

	it('état technique : motif obligatoire hors « prête », date prévue seulement hors « prête »', async () => {
		const { unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update units set technical_status = 'under_works' where id = $1`, [unit])).message).toContain(
				'units_technical_reason'
			);
			expect((await sqlError(api, `update units set technical_reason = 'Peinture' where id = $1`, [unit])).message).toContain(
				'units_technical_reason'
			);
			expect((await sqlError(api, `update units set technical_expected_on = '2026-12-01' where id = $1`, [unit])).message).toContain(
				'units_technical_expected'
			);
			await api.query(
				`update units set technical_status = 'under_works', technical_reason = 'Réfection de la toiture', technical_expected_on = '2026-12-01' where id = $1`,
				[unit]
			);
		});
	});

	it('une unité ne change pas de bien ; un libellé par bien, casse et accents confondus', async () => {
		const { property, unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		const elsewhere = await seed(a.id, (c) => insertProperty(c, a.id, ownerA));
		await seed(a.id, (c) => insertUnit(c, a.id, property, { label: 'Appartement A2' }));
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update units set property_id = $2 where id = $1`, [unit, elsewhere])).message).toContain(
				'UNIT_PROPERTY_IMMUTABLE'
			);
			expect(
				(
					await sqlError(
						api,
						`insert into units (id, organization_id, property_id, type, label) values ($1, $2, $3, 'apartment', 'APPARTEMENT a2')`,
						[newId(), a.id, property]
					)
				).code
			).toBe('23505');
		});
	});

	it('agent affecté : un agent de terrain actif de l’organisation, jamais un autre rôle', async () => {
		const { unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			await api.query(`update units set assigned_agent_id = $2 where id = $1`, [unit, agentA.userId]);
			expect((await sqlError(api, `update units set assigned_agent_id = $2 where id = $1`, [unit, managerA.userId])).message).toContain(
				'UNIT_AGENT_NOT_FIELD_AGENT'
			);
			await api.query(`update units set assigned_agent_id = null where id = $1`, [unit]);
		});
	});
});

describe('photos : 15 au plus par unité', () => {
	it('la 16e photo est refusée ; une photo retirée libère sa place ; le bien a son propre compte', async () => {
		const ownerA = await seed(a.id, (c) => insertOwner(c, a.id, 'Propriétaire des photos'));
		const { property, unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		const first = await seed(a.id, async (c) => {
			const ids: string[] = [];
			for (let i = 0; i < 15; i += 1) ids.push(await insertMedia(c, a.id, property, unit));
			return ids[0]!;
		});
		await inContext(api, { organizationId: a.id }, async () => {
			expect(
				(
					await sqlError(
						api,
						`insert into media (id, organization_id, property_id, unit_id, mime_type, byte_size) values ($1, $2, $3, $4, 'image/png', 1000)`,
						[newId(), a.id, property, unit]
					)
				).message
			).toContain('MEDIA_QUOTA');
			// Photos du bien lui-même : un autre compte.
			await api.query(
				`insert into media (id, organization_id, property_id, mime_type, byte_size) values ($1, $2, $3, 'image/webp', 1000)`,
				[newId(), a.id, property]
			);
			await api.query(`update media set status = 'removed', removed_at = now() where id = $1`, [first]);
			await api.query(
				`insert into media (id, organization_id, property_id, unit_id, mime_type, byte_size) values ($1, $2, $3, $4, 'image/heic', 1000)`,
				[newId(), a.id, property, unit]
			);
			// Une photo retirée le reste.
			expect((await sqlError(api, `update media set status = 'pending', removed_at = null where id = $1`, [first])).message).toContain(
				'MEDIA_FINAL'
			);
		});
	});

	it('format et taille : 10 Mo au plus, formats d’image acceptés seulement', async () => {
		const ownerA = await seed(a.id, (c) => insertOwner(c, a.id, 'Propriétaire des formats'));
		const { property, unit } = await seed(a.id, (c) => propertyWithUnit(c, a.id, ownerA));
		await inContext(api, { organizationId: a.id }, async () => {
			const insert = (mime: string, size: number) =>
				sqlError(
					api,
					`insert into media (id, organization_id, property_id, unit_id, mime_type, byte_size) values ($1, $2, $3, $4, $5, $6)`,
					[newId(), a.id, property, unit, mime, size]
				);
			expect((await insert('image/jpeg', 10 * 1024 * 1024 + 1)).code).toBe('23514');
			expect((await insert('image/gif', 1000)).code).toBe('23514');
			expect((await insert('application/pdf', 1000)).code).toBe('23514');
		});
	});
});

describe('documents privés : versions figées (D22)', () => {
	let ownerA: string;
	let property: string;
	beforeAll(async () => {
		ownerA = await seed(a.id, (c) => insertOwner(c, a.id, 'Propriétaire des documents'));
		property = await seed(a.id, (c) => insertProperty(c, a.id, ownerA));
	});

	it('un document naît en attente ; activé avec son empreinte ; figé ensuite', async () => {
		const doc = await seed(a.id, (c) => insertDocument(c, a.id, { propertyId: property }));
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update documents set status = 'active', activated_at = now() where id = $1`, [doc])).message).toContain(
				'documents_fingerprint'
			);
			await activate(api, doc);
			expect((await sqlError(api, `update documents set storage_key = 'documents/autre-cle' where id = $1`, [doc])).message).toContain(
				'DOCUMENT_IMMUTABLE'
			);
			expect((await sqlError(api, `update documents set sha256 = $2 where id = $1`, [doc, 'b'.repeat(64)])).message).toContain(
				'DOCUMENT_IMMUTABLE'
			);
			expect((await sqlError(api, `update documents set type = 'puh' where id = $1`, [doc])).message).toContain('DOCUMENT_IMMUTABLE');
			expect((await sqlError(api, `update documents set status = 'pending' where id = $1`, [doc])).message).toContain('DOCUMENT_STATUS');
			// La restriction se pose et se retire (elle ne fait que réduire la matrice).
			await api.query(`update documents set restriction = 'director_only' where id = $1`, [doc]);
		});
		await inContext(api, { organizationId: a.id }, async () => {
			const born = await sqlError(
				api,
				`insert into documents (id, organization_id, type, property_id, file_name, mime_type, byte_size, storage_key, uploaded_by, status, sha256, activated_at)
				 values ($1, $2, 'puh', $3, 'puh.pdf', 'application/pdf', 1000, $4, $5, 'active', $6, now())`,
				[newId(), a.id, property, `documents/${newId()}`, a.director.userId, SHA]
			);
			expect(born.message).toContain('DOCUMENT_BORN_PENDING');
		});
	});

	it('nouvelle version : même type et mêmes objets, numéro suivant ; la précédente devient remplacée à l’activation', async () => {
		const v1 = await seed(a.id, async (c) => {
			const id = await insertDocument(c, a.id, { propertyId: property });
			await activate(c, id);
			return id;
		});
		await inContext(api, { organizationId: a.id }, async () => {
			const wrongType = await sqlError(
				api,
				`insert into documents (id, organization_id, type, property_id, version, replaces_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
				 values ($1, $2, 'puh', $3, 2, $4, 'v2.pdf', 'application/pdf', 1000, $5, $6)`,
				[newId(), a.id, property, v1, `documents/${newId()}`, a.director.userId]
			);
			expect(wrongType.message).toContain('DOCUMENT_VERSION_SUBJECT');
			const wrongNumber = await sqlError(
				api,
				`insert into documents (id, organization_id, type, property_id, version, replaces_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
				 values ($1, $2, 'title_deed', $3, 3, $4, 'v2.pdf', 'application/pdf', 1000, $5, $6)`,
				[newId(), a.id, property, v1, `documents/${newId()}`, a.director.userId]
			);
			expect(wrongNumber.message).toContain('DOCUMENT_VERSION');
		});
		const v2 = await seed(a.id, (c) => insertDocument(c, a.id, { propertyId: property }, { replaces: v1, version: 2 }));
		// Tant que la v2 n'est pas active, la v1 reste en vigueur ; une seconde v2 est refusée.
		expect((await owner.query(`select status from documents where id = $1`, [v1])).rows[0].status).toBe('active');
		await inContext(api, { organizationId: a.id }, async () => {
			const twice = await sqlError(
				api,
				`insert into documents (id, organization_id, type, property_id, version, replaces_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
				 values ($1, $2, 'title_deed', $3, 2, $4, 'v2bis.pdf', 'application/pdf', 1000, $5, $6)`,
				[newId(), a.id, property, v1, `documents/${newId()}`, a.director.userId]
			);
			expect(twice.message).toContain('documents_replaced_once');
		});
		await seed(a.id, (c) => activate(c, v2, 'c'.repeat(64)));
		const r = await owner.query(`select id, version, status from documents where id = any($1::uuid[]) order by version`, [[v1, v2]]);
		expect(r.rows).toEqual([
			{ id: v1, version: 1, status: 'replaced' },
			{ id: v2, version: 2, status: 'active' }
		]);
		// Une version remplacée ne peut plus être remplacée.
		await inContext(api, { organizationId: a.id }, async () => {
			const stale = await sqlError(
				api,
				`insert into documents (id, organization_id, type, property_id, version, replaces_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
				 values ($1, $2, 'title_deed', $3, 2, $4, 'v2ter.pdf', 'application/pdf', 1000, $5, $6)`,
				[newId(), a.id, property, v1, `documents/${newId()}`, a.director.userId]
			);
			expect(stale.message).toMatch(/DOCUMENT_REPLACES_ACTIVE|documents_replaced_once/);
		});
	});

	it('un document vise au moins un objet ; une unité, avec son bien ; un retrait est motivé', async () => {
		const unit = await seed(a.id, (c) => insertUnit(c, a.id, property));
		await inContext(api, { organizationId: a.id }, async () => {
			const none = await sqlError(
				api,
				`insert into documents (id, organization_id, type, file_name, mime_type, byte_size, storage_key, uploaded_by)
				 values ($1, $2, 'other', 'x.pdf', 'application/pdf', 1000, $3, $4)`,
				[newId(), a.id, `documents/${newId()}`, a.director.userId]
			);
			expect(none.message).toContain('documents_subject');
			const orphanUnit = await sqlError(
				api,
				`insert into documents (id, organization_id, type, owner_id, unit_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
				 values ($1, $2, 'other', $3, $4, 'x.pdf', 'application/pdf', 1000, $5, $6)`,
				[newId(), a.id, ownerA, unit, `documents/${newId()}`, a.director.userId]
			);
			expect(orphanUnit.message).toContain('documents_unit_property');
		});
		const doc = await seed(a.id, async (c) => {
			const id = await insertDocument(c, a.id, { ownerId: ownerA }, { type: 'owner_identity' });
			await activate(c, id);
			return id;
		});
		await inContext(api, { organizationId: a.id }, async () => {
			expect(
				(await sqlError(api, `update documents set status = 'withdrawn', withdrawn_at = now() where id = $1`, [doc])).message
			).toContain('documents_withdrawn');
			await api.query(
				`update documents set status = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'Pièce expirée' where id = $1`,
				[doc]
			);
		});
	});
});

describe('listes fermées : la base et packages/shared disent la même chose', () => {
	/** Valeurs entre apostrophes de la contrainte CHECK qui porte sur la colonne. */
	async function checkValues(table: string, column: string): Promise<string[]> {
		const r = await owner.query(
			`select pg_get_constraintdef(c.oid) as def from pg_constraint c
			 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
			 where c.conrelid = $1::regclass and c.contype = 'c' and a.attname = $2 and cardinality(c.conkey) = 1`,
			[table, column]
		);
		const values = r.rows.flatMap((row) => [...String(row.def).matchAll(/'([^']+)'/g)].map((m) => m[1]!));
		return [...new Set(values)].sort();
	}

	it('types, opérations, usages, équipements, états techniques, formats, documents', async () => {
		const cases: [string, string, readonly string[]][] = [
			['properties', 'type', PROPERTY_TYPES],
			['properties', 'operation', PROPERTY_OPERATIONS],
			['units', 'type', UNIT_TYPES],
			['units', 'usage', UNIT_USAGES],
			['units', 'amenities', AMENITIES],
			['units', 'technical_status', TECHNICAL_STATUSES],
			['media', 'mime_type', PHOTO_MIME_TYPES],
			['documents', 'type', DOCUMENT_TYPES],
			['documents', 'mime_type', DOCUMENT_MIME_TYPES]
		];
		for (const [table, column, list] of cases) expect(await checkValues(table, column), `${table}.${column}`).toEqual([...list].sort());
		// Documents fonciers déclarés : la contrainte nommée cite les cinq valeurs, « none » compris.
		const land = await owner.query(
			`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'properties_land_documents'`
		);
		const values = [...new Set([...String(land.rows[0].def).matchAll(/'([^']+)'/g)].map((m) => m[1]!))].sort();
		expect(values).toEqual([...DECLARED_LAND_DOCUMENTS].sort());
	});
});
