/**
 * Lot 07 : référentiel géographique (migration 0009_geography), en SQL.
 * - Données initiales : liste du porteur (Ouagadougou 39 quartiers dont 21 avec point, Saaba 27), verified = false.
 * - Tables de la plateforme : app_api lit sans pouvoir écrire ; app_admin ajoute et corrige ; personne ne supprime.
 * - Un nom par commune, accents et casse confondus ; point complet ou absent.
 */
import { newId } from '@ziga/shared/ids';
import { placeNameKey } from '@ziga/shared/geography';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlError } from './orgs.js';

let owner: pg.Client;
let api: pg.Client;
let admin: pg.Client;

async function connect(url: string): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: url });
	await c.connect();
	return c;
}

/** Exécute `fn` dans une transaction annulée ensuite : le référentiel reste celui de la migration. */
async function rolledBack<T>(c: pg.Client, fn: () => Promise<T>): Promise<T> {
	await c.query('BEGIN');
	try {
		return await fn();
	} finally {
		await c.query('ROLLBACK');
	}
}

beforeAll(async () => {
	owner = await connect(process.env.DATABASE_MIGRATION_URL!);
	api = await connect(process.env.DATABASE_URL!);
	admin = await connect(process.env.DATABASE_ADMIN_URL!);
});

afterAll(async () => {
	await Promise.all([owner?.end(), api?.end(), admin?.end()]);
});

describe('référentiel géographique : données initiales', () => {
	it('communes du lancement (D08) avec leur centre, non vérifié', async () => {
		const r = await api.query('select id, name, lat, lng, osm_ref, verified from communes order by id');
		expect(r.rows).toEqual([
			{ id: 'ouagadougou', name: 'Ouagadougou', lat: 12.368187, lng: -1.527094, osm_ref: 'node/27565002', verified: false },
			{ id: 'saaba', name: 'Saaba', lat: 12.376944, lng: -1.420833, osm_ref: 'node/902867125', verified: false }
		]);
	});

	it('Ouagadougou : 39 quartiers, 21 avec point ; Saaba : 27 villages, tous avec point ; rien de vérifié', async () => {
		const r = await api.query(
			`select commune_id, count(*)::int as total, count(lat)::int as with_point, count(*) filter (where verified)::int as verified
			from neighborhoods group by commune_id order by commune_id`
		);
		expect(r.rows).toEqual([
			{ commune_id: 'ouagadougou', total: 39, with_point: 21, verified: 0 },
			{ commune_id: 'saaba', total: 27, with_point: 27, verified: 0 }
		]);
	});

	it('orthographe du porteur, point OSM des lieux désignés ; « Saaba » n’est pas un quartier de Ouagadougou', async () => {
		const r = await api.query(
			`select name, osm_ref from neighborhoods where commune_id = 'ouagadougou'
				and name in ('Kalgondé', 'Pagalayiri', 'Zékounga', 'Tabtenga', 'Saaba', 'Bendogo') order by name`
		);
		expect(r.rows).toEqual([
			{ name: 'Bendogo', osm_ref: null },
			{ name: 'Kalgondé', osm_ref: 'node/3350189466' },
			{ name: 'Pagalayiri', osm_ref: 'node/3296496974' },
			{ name: 'Tabtenga', osm_ref: 'node/903015666' },
			{ name: 'Zékounga', osm_ref: 'node/12915364746' }
		]);
		const tabtenga = await api.query(`select commune_id from neighborhoods where name = 'Tabtenga'`);
		expect(tabtenga.rows).toEqual([{ commune_id: 'ouagadougou' }]);
	});

	it('la clé SQL des noms est celle de packages/shared (placeNameKey)', async () => {
		const names = ['Somgandé', ' ZÉKOUNGA  I ', 'Patte d’Oie', 'Gampéla', 'Toéssen'];
		const r = await api.query('select geo_name_key(n) as key from unnest($1::text[]) with ordinality as t(n, i) order by i', [names]);
		expect(r.rows.map((row) => row.key)).toEqual(names.map(placeNameKey));
	});
});

describe('référentiel géographique : droits', () => {
	it('app_api lit mais ne peut ni ajouter, ni modifier, ni supprimer', async () => {
		await rolledBack(api, async () => {
			expect(
				(await sqlError(api, `insert into neighborhoods (id, commune_id, name) values ($1, 'saaba', 'Nouveau')`, [newId()])).code
			).toBe('42501');
			expect((await sqlError(api, `update neighborhoods set verified = true where name = 'Gampéla'`)).code).toBe('42501');
			expect((await sqlError(api, `delete from neighborhoods where name = 'Gampéla'`)).code).toBe('42501');
			expect((await sqlError(api, `update communes set verified = true`)).code).toBe('42501');
		});
	});

	it('app_admin ajoute un quartier et corrige un point, sans pouvoir supprimer ni créer une commune', async () => {
		await rolledBack(admin, async () => {
			await admin.query(`insert into neighborhoods (id, commune_id, name) values ($1, 'saaba', 'Nouveau quartier')`, [newId()]);
			await admin.query(`update neighborhoods set lat = 12.37, lng = -1.42, verified = true where name = 'Gampéla'`);
			await admin.query(`update communes set verified = true where id = 'saaba'`);
			expect((await sqlError(admin, `delete from neighborhoods where name = 'Gampéla'`)).code).toBe('42501');
			expect((await sqlError(admin, `insert into communes (id, name, lat, lng) values ('koubri', 'Koubri', 12.2, -1.4)`)).code).toBe(
				'42501'
			);
			expect((await sqlError(admin, `delete from communes where id = 'saaba'`)).code).toBe('42501');
		});
	});

	it('app_sync lit le référentiel, sans rien écrire', async () => {
		const sync = await connect(process.env.DATABASE_SYNC_URL!);
		try {
			const r = await sync.query('select count(*)::int as n from neighborhoods');
			expect(r.rows[0].n).toBe(66);
			await rolledBack(sync, async () => {
				expect((await sqlError(sync, `update neighborhoods set verified = true`)).code).toBe('42501');
			});
		} finally {
			await sync.end();
		}
	});
});

describe('référentiel géographique : contraintes', () => {
	it('un nom par commune, accents et casse confondus ; le même nom reste possible dans une autre commune', async () => {
		await rolledBack(admin, async () => {
			expect(
				(await sqlError(admin, `insert into neighborhoods (id, commune_id, name) values ($1, 'ouagadougou', 'somgande')`, [newId()])).code
			).toBe('23505');
			expect(
				(await sqlError(admin, `insert into neighborhoods (id, commune_id, name) values ($1, 'ouagadougou', 'ZOGONA')`, [newId()])).code
			).toBe('23505');
			await admin.query(`insert into neighborhoods (id, commune_id, name) values ($1, 'saaba', 'Zogona')`, [newId()]);
		});
	});

	it('point complet ou absent ; un point vérifié existe ; nom sans espaces autour ; commune connue', async () => {
		await rolledBack(admin, async () => {
			const insert = (name: string, lat: number | null, lng: number | null, verified = false, commune = 'saaba') =>
				sqlError(admin, 'insert into neighborhoods (id, commune_id, name, lat, lng, verified) values ($1, $2, $3, $4, $5, $6)', [
					newId(),
					commune,
					name,
					lat,
					lng,
					verified
				]);
			expect((await insert('Demi point', 12.3, null)).code).toBe('23514');
			expect((await insert('Vérifié sans point', null, null, true)).code).toBe('23514');
			expect((await insert(' Espaces ', null, null)).code).toBe('23514');
			expect((await insert('Hors du monde', 120, -1.4)).code).toBe('23514');
			expect((await insert('Commune inconnue', null, null, false, 'koubri')).code).toBe('23503');
		});
	});
});
