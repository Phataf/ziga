/**
 * Lot 08 bis, étape 2 : contrats, versions, modèles et avenants dans la base (migration 0014), en SQL, avec le rôle de
 * l'API (app_api, sans BYPASSRLS), le propriétaire du schéma (triggers) et le rôle de réplication (app_sync).
 * - Accès croisé A/B sur les quatre tables et sur les documents du contrat : lecture, modification, création,
 *   référence (clés composites).
 * - Versions : ajout seul (UPDATE et DELETE refusés, même au propriétaire du schéma), numérotation continue, fichiers
 *   actifs du même contrat avec leur empreinte, aucune version pour un contrat figé.
 * - Cycle du contrat : pas de saut, figement de la dernière version, contrat figé non modifiable, signature écrite une
 *   seule fois sur un scan du bon type, un contrat par bail et par avenant ; scan déposé hors plateforme.
 * - Modèles : naissent brouillons, activation sans balise inconnue, un seul actif par type, inspection figée.
 * - Avenants : valeurs selon le type, un seul avenant de loyer ou de renouvellement en cours par bail.
 * - Bail : renouvellement par la version suivante (fin postérieure), jamais avec un changement de loyer.
 * - Documents : le Word seulement pour un modèle ou un projet ; un projet se rattache à son contrat et à son bail.
 */
import { newId } from '@ziga/shared/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addVersion, DOCX, freeze, insertAmendment, insertContract, insertDocument, insertTemplate, sign } from './contracts.js';
import { startApp, type TestApp } from './http.js';
import { insertLease, insertTenant } from './leases.js';
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

/** Écrit des données de test validées (COMMIT) dans le contexte d'une organisation, avec le rôle de l'API. */
async function seed<T>(organizationId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
	await api.query('BEGIN');
	try {
		await api.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
		const r = await fn(api);
		await api.query('COMMIT');
		return r;
	} catch (error) {
		await api.query('ROLLBACK');
		throw error;
	}
}

/** Une unité neuve (bien et propriétaire compris), un locataire et un bail en vigueur à durée déterminée. */
async function aLease(org: Org, endsOn: string | null = '2026-12-31'): Promise<{ unit: string; tenant: string; lease: string }> {
	return seed(org.id, async (c) => {
		const ownerId = newId();
		await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Awa Sawadogo', '+22670445566')`, [
			ownerId,
			org.id
		]);
		const { unit } = await propertyWithUnit(c, org.id, ownerId);
		const tenant = await insertTenant(c, org.id);
		const lease = await insertLease(c, org.id, unit, tenant, { endsOn });
		return { unit, tenant, lease };
	});
}

/** Erreur attendue dans le contexte d'une organisation (la transaction est annulée). */
async function refused(
	organizationId: string,
	client: pg.Client,
	query: string,
	params: unknown[] = []
): Promise<{ code: string; message: string }> {
	return inContext(client, { organizationId }, () => sqlError(client, query, params));
}

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A contrats');
	b = await createOrg(t, 'agency', 'Agence B contrats');
	owner = await connect(process.env.DATABASE_MIGRATION_URL!);
	api = await apiSql();
});
afterAll(async () => {
	await api.end();
	await owner.end();
	await t.close();
});

describe('accès croisé A/B en SQL (règle 1)', () => {
	const tables = ['contract_templates', 'lease_contracts', 'contract_versions', 'lease_amendments'];
	let inB: { lease: string; contract: string; template: string; amendment: string; draft: string };
	let mine: { lease: string };
	let mine2: { lease: string };

	beforeAll(async () => {
		const { lease } = await aLease(b);
		inB = await seed(b.id, async (c) => {
			const template = (await insertTemplate(c, b.id, b.director.userId)).id;
			const amendment = await insertAmendment(c, b.id, lease, b.director.userId);
			const contract = await insertContract(c, b.id, lease, b.director.userId);
			await addVersion(c, b.id, contract, lease, b.director.userId);
			const draft = (await c.query(`select docx_document_id from contract_versions where contract_id = $1`, [contract])).rows[0]
				.docx_document_id as string;
			return { lease, contract, template, amendment, draft };
		});
		mine = await aLease(a);
		mine2 = await aLease(a);
	});

	it('A ne lit aucune ligne de B, dans aucune des quatre tables ni dans ses documents de contrat ; B voit les siennes', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			for (const table of [...tables, 'documents']) {
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
			expect((await api.query(`update contract_templates set name = 'Piraté' where id = $1`, [inB.template])).rowCount).toBe(0);
			expect((await api.query(`update lease_contracts set legalization_reminder = false where id = $1`, [inB.contract])).rowCount).toBe(0);
			expect((await api.query(`update lease_amendments set description = 'Piraté' where id = $1`, [inB.amendment])).rowCount).toBe(0);
			expect((await api.query(`update documents set restriction = 'director_only' where id = $1`, [inB.draft])).rowCount).toBe(0);
		});
	});

	it('A ne crée rien au nom de B (WITH CHECK de la RLS)', async () => {
		const e = await refused(
			a.id,
			api,
			`insert into lease_contracts (id, organization_id, lease_id, origin, template_source, template_version, status)
			 values ($1, $2, $3, 'generated', 'platform', 1, 'draft')`,
			[newId(), b.id, inB.lease]
		);
		expect(e.code).toBe('42501');
	});

	it('A ne référence aucune ligne de B : bail, avenant, contrat, modèle, documents (clés composites)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const myContract = await insertContract(api, a.id, mine.lease, a.director.userId);
			const cases: [string, unknown[], string][] = [
				[
					`insert into lease_contracts (id, organization_id, lease_id, origin, template_source, template_version, status)
					 values ($1, $2, $3, 'generated', 'platform', 1, 'draft')`,
					[newId(), a.id, inB.lease],
					'lease_contracts_lease_fk'
				],
				[
					`insert into lease_amendments (id, organization_id, lease_id, number, type, effective_from, new_rent, new_charges,
						expected_lease_version, created_by) values ($1, $2, $3, 9, 'rent_change', '2026-07-01', 1, 0, 1, $4)`,
					[newId(), a.id, inB.lease, a.director.userId],
					'lease_amendments_lease_fk'
				],
				[
					`insert into lease_contracts (id, organization_id, lease_id, amendment_id, origin, template_source, template_version, status)
					 values ($1, $2, $3, $4, 'generated', 'platform', 1, 'draft')`,
					[newId(), a.id, mine.lease, inB.amendment],
					'lease_contracts_amendment_fk'
				],
				[
					`insert into lease_contracts (id, organization_id, lease_id, origin, template_source, template_id, template_version, status)
					 values ($1, $2, $3, 'generated', 'organization', $4, 1, 'draft')`,
					[newId(), a.id, mine2.lease, inB.template],
					'lease_contracts_template_fk'
				],
				[
					`insert into documents (id, organization_id, type, lease_id, lease_contract_id, file_name, mime_type, byte_size, storage_key,
						uploaded_by) values ($1, $2, 'contract_draft', $3, $4, 'projet.pdf', 'application/pdf', 1000, $5, $6)`,
					[newId(), a.id, mine.lease, inB.contract, `documents/${newId()}`, a.director.userId],
					'documents_contract_fk'
				],
				[`update lease_contracts set signed_document_id = $2 where id = $1`, [myContract, inB.draft], 'lease_contracts_signed_document_fk']
			];
			for (const [query, params, constraint] of cases) {
				const e = await sqlError(api, query, params);
				expect(e.code, constraint).toBe('23503');
				expect(e.message, constraint).toContain(constraint);
			}
			// Une version de A qui citerait un fichier de B (avec un projet à elle) : refusée, B étant invisible sous la RLS.
			const own = await insertDocument(api, a.id, a.director.userId, {
				type: 'contract_draft',
				leaseId: mine.lease,
				leaseContractId: myContract
			});
			const v = await sqlError(
				api,
				`insert into contract_versions (id, organization_id, contract_id, number, lease_version, template_source, template_version, data,
					fields, docx_document_id, pdf_document_id, docx_sha256, pdf_sha256)
				 values ($1, $2, $3, 1, 1, 'platform', 1, '{}', '{}', $4, $5, $6, $7)`,
				[newId(), a.id, myContract, inB.draft, own.id, 'a'.repeat(64), own.sha256]
			);
			expect(v.message).toContain('CONTRACT_VERSION_FILES');
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
				expect((await sqlError(sync, `update lease_contracts set legalization_reminder = false where id = $1`, [inB.contract])).code).toBe(
					'42501'
				);
			} finally {
				await sync.query('ROLLBACK');
			}
		} finally {
			await sync.end();
		}
	});
});

describe('versions des contrats : ajout seul (règle 17)', () => {
	it('UPDATE et DELETE refusés à l’API (droits) et au propriétaire du schéma (trigger)', async () => {
		const { lease } = await aLease(a);
		const contract = await seed(a.id, async (c) => {
			const id = await insertContract(c, a.id, lease, a.director.userId);
			await addVersion(c, a.id, id, lease, a.director.userId);
			return id;
		});
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await sqlError(api, `update contract_versions set fields = '{}' where contract_id = $1`, [contract])).code).toBe('42501');
			expect((await sqlError(api, `delete from contract_versions where contract_id = $1`, [contract])).code).toBe('42501');
			expect((await sqlError(api, `delete from lease_contracts where id = $1`, [contract])).code).toBe('42501');
		});
		await inContext(owner, { organizationId: a.id }, async () => {
			expect((await sqlError(owner, `update contract_versions set fields = '{}' where contract_id = $1`, [contract])).message).toContain(
				'APPEND_ONLY'
			);
			expect((await sqlError(owner, `delete from contract_versions where contract_id = $1`, [contract])).message).toContain('APPEND_ONLY');
		});
	});

	it('numérotation continue ; fichiers : projets actifs du même contrat, empreinte identique, Word et PDF distincts', async () => {
		const { lease } = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const contract = await insertContract(api, a.id, lease, a.director.userId);
			const other = await insertContract(api, a.id, (await aLeaseInContext()).lease, a.director.userId);
			const draft = (type = 'contract_draft', contractId = contract, extra: { pending?: boolean; mimeType?: string } = {}) =>
				insertDocument(api, a.id, a.director.userId, { type, leaseId: lease, leaseContractId: contractId, ...extra });
			const insert = (number: number, docx: { id: string; sha256: string }, pdf: { id: string; sha256: string }, sha = docx.sha256) =>
				sqlError(
					api,
					`insert into contract_versions (id, organization_id, contract_id, number, lease_version, template_source, template_version, data,
						fields, docx_document_id, pdf_document_id, docx_sha256, pdf_sha256)
					 values ($1, $2, $3, $4, 1, 'platform', 1, '{}', '{}', $5, $6, $7, $8)`,
					[newId(), a.id, contract, number, docx.id, pdf.id, sha, pdf.sha256]
				);
			const docx = await draft('contract_draft', contract, { mimeType: DOCX });
			const pdf = await draft();
			expect((await insert(2, docx, pdf)).message).toContain('CONTRACT_VERSION: la version suivante est la 1');
			expect((await insert(1, docx, pdf, 'b'.repeat(64))).message).toContain('CONTRACT_VERSION_FINGERPRINT');
			expect((await insert(1, docx, docx)).message).toContain('CONTRACT_VERSION_FILES');
			expect((await insert(1, docx, await draft('contract_draft', other))).message).toContain('CONTRACT_VERSION_FILES');
			expect((await insert(1, docx, await draft('contract_draft', contract, { pending: true }))).message).toContain(
				'CONTRACT_VERSION_FILES'
			);
			// Le contrat ne cite qu'une version qui existe, une à la fois.
			expect((await sqlError(api, `update lease_contracts set current_version = 1 where id = $1`, [contract])).message).toContain(
				'CONTRACT_VERSION'
			);
			expect(await addVersion(api, a.id, contract, lease, a.director.userId)).toBe(1);
			expect(await addVersion(api, a.id, contract, lease, a.director.userId)).toBe(2);
			expect((await sqlError(api, `update lease_contracts set current_version = 4 where id = $1`, [contract])).message).toContain(
				'CONTRACT_VERSION'
			);
		});
	});

	it('un contrat figé ne reçoit plus de version ; « modifier » le renvoie d’abord en vérification', async () => {
		const { lease } = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const contract = await insertContract(api, a.id, lease, a.director.userId);
			await addVersion(api, a.id, contract, lease, a.director.userId);
			await freeze(api, contract, a.director.userId);
			const e = await addVersion(api, a.id, contract, lease, a.director.userId).catch((error: { message: string }) => error);
			expect((e as { message: string }).message).toContain('CONTRACT_FROZEN');
		});
	});

	/** Une seconde unité louée, dans la transaction de contexte en cours. */
	async function aLeaseInContext(): Promise<{ lease: string }> {
		const ownerId = newId();
		await api.query(
			`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Issa Ouédraogo', '+22670445577')`,
			[ownerId, a.id]
		);
		const { unit } = await propertyWithUnit(api, a.id, ownerId);
		const tenant = await insertTenant(api, a.id);
		return { lease: await insertLease(api, a.id, unit, tenant) };
	}
});

describe('cycle du contrat (D20, D21)', () => {
	it('pas de saut : brouillon → prêt à signer ou signé refusé ; signé : plus aucun changement de statut', async () => {
		const { lease } = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const contract = await insertContract(api, a.id, lease, a.director.userId);
			await addVersion(api, a.id, contract, lease, a.director.userId);
			const jump = await sqlError(
				api,
				`update lease_contracts set status = 'ready_to_sign', frozen_version = 1, frozen_at = now(), expected_signers = array['organization']
				 where id = $1`,
				[contract]
			);
			expect(jump.message).toContain('CONTRACT_STATUS');
			await freeze(api, contract, a.director.userId);
			await sign(api, a.id, contract, lease, a.director.userId);
			for (const status of ['draft', 'in_review', 'ready_to_sign']) {
				expect((await sqlError(api, `update lease_contracts set status = $2 where id = $1`, [contract, status])).message).toMatch(
					/CONTRACT_STATUS|CONTRACT_FREEZE|lease_contracts_/
				);
			}
		});
	});

	it('figement : la dernière version, avec ses signataires ; un contrat prêt à signer ne se modifie pas', async () => {
		const { lease } = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const contract = await insertContract(api, a.id, lease, a.director.userId);
			await addVersion(api, a.id, contract, lease, a.director.userId);
			await addVersion(api, a.id, contract, lease, a.director.userId);
			await api.query(`update lease_contracts set status = 'in_review' where id = $1`, [contract]);
			const old = await sqlError(
				api,
				`update lease_contracts set status = 'ready_to_sign', frozen_version = 1, frozen_at = now(), expected_signers = array['organization', 'tenant']
				 where id = $1`,
				[contract]
			);
			expect(old.message).toContain('CONTRACT_FREEZE');
			const noSigners = await sqlError(
				api,
				`update lease_contracts set status = 'ready_to_sign', frozen_version = 2, frozen_at = now() where id = $1`,
				[contract]
			);
			expect(noSigners.message).toContain('lease_contracts_frozen');
			await api.query(
				`update lease_contracts set status = 'ready_to_sign', frozen_version = 2, frozen_at = now(), expected_signers = array['organization', 'tenant']
				 where id = $1`,
				[contract]
			);
			for (const [column, value] of [
				['signing_place', 'Saaba'],
				['copies', 5],
				['frozen_version', 1]
			] as const) {
				const e = await sqlError(api, `update lease_contracts set ${column} = $2 where id = $1`, [contract, value]);
				expect(e.message, column).toContain('CONTRACT_FROZEN');
			}
			// « Modifier » : retour en vérification, figement levé ; la version suivante peut alors être générée.
			const stillFrozen = await sqlError(api, `update lease_contracts set status = 'in_review' where id = $1`, [contract]);
			expect(stillFrozen.message).toMatch(/CONTRACT_FREEZE|lease_contracts_frozen/);
			await api.query(
				`update lease_contracts set status = 'in_review', frozen_version = null, frozen_at = null, frozen_by = null, expected_signers = null
				 where id = $1`,
				[contract]
			);
			expect(await addVersion(api, a.id, contract, lease, a.director.userId)).toBe(3);
		});
	});

	it('signé : sur le scan actif du bail, du bon type ; chaque signataire attendu a sa date ; la signature ne se réécrit pas', async () => {
		const { lease } = await aLease(a);
		const other = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const contract = await insertContract(api, a.id, lease, a.director.userId);
			await addVersion(api, a.id, contract, lease, a.director.userId);
			await freeze(api, contract, a.director.userId);
			const signWith = (documentId: string, tenantSignedOn: string | null = '2026-11-15') =>
				sqlError(
					api,
					`update lease_contracts set status = 'signed', signature_mode = 'handwritten_scan', signed_document_id = $2,
						signature_recorded_by = $3, signature_recorded_at = now(), organization_signed_on = '2026-11-15', tenant_signed_on = $4
					 where id = $1`,
					[contract, documentId, a.director.userId, tenantSignedOn]
				);
			const otherScan = await insertDocument(api, a.id, a.director.userId, { type: 'signed_lease_scan', leaseId: other.lease });
			expect((await signWith(otherScan.id)).message).toContain('CONTRACT_SCAN');
			const wrongType = await insertDocument(api, a.id, a.director.userId, {
				type: 'signed_amendment_scan',
				leaseId: lease,
				leaseContractId: contract
			});
			expect((await signWith(wrongType.id)).message).toContain('CONTRACT_SCAN');
			const pending = await insertDocument(api, a.id, a.director.userId, { type: 'signed_lease_scan', leaseId: lease, pending: true });
			expect((await signWith(pending.id)).message).toContain('CONTRACT_SCAN');
			const scan = await insertDocument(api, a.id, a.director.userId, {
				type: 'signed_lease_scan',
				leaseId: lease,
				leaseContractId: contract
			});
			expect((await signWith(scan.id, null)).message).toContain('lease_contracts_signers_dates');
			// Sans scan : refusé (par le trigger, avant même la contrainte lease_contracts_signed).
			const noScan = await sqlError(api, `update lease_contracts set status = 'signed' where id = $1`, [contract]);
			expect(noScan.message).toMatch(/CONTRACT_SCAN|lease_contracts_signed/);
			await sign(api, a.id, contract, lease, a.director.userId);
			for (const [column, value] of [
				['tenant_signed_on', '2026-11-14'],
				['signed_document_id', scan.id],
				['signature_recorded_by', b.director.userId]
			] as const) {
				expect(
					(await sqlError(api, `update lease_contracts set ${column} = $2 where id = $1`, [contract, value])).message,
					column
				).toContain('CONTRACT_SIGNED');
			}
			// Légalisation et enregistrement : suivis après la signature, sans bloquer.
			await api.query(
				`update lease_contracts set legalized_on = '2026-11-20', legalization_commune = 'Ouagadougou', registered_on = '2026-11-25' where id = $1`,
				[contract]
			);
		});
	});

	it('légalisation et enregistrement : seulement pour un contrat signé ; commune exigée', async () => {
		const { lease } = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const contract = await insertContract(api, a.id, lease, a.director.userId);
			const e = await sqlError(
				api,
				`update lease_contracts set legalized_on = '2026-11-20', legalization_commune = 'Saaba' where id = $1`,
				[contract]
			);
			expect(e.message).toContain('lease_contracts_tracking');
			const commune = await sqlError(api, `update lease_contracts set legalized_on = '2026-11-20' where id = $1`, [contract]);
			expect(commune.message).toContain('lease_contracts_legalization');
		});
	});

	it('un contrat par bail, un par avenant ; le bail, l’origine et le modèle ne changent pas', async () => {
		const { lease } = await aLease(a);
		const other = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const contract = await insertContract(api, a.id, lease, a.director.userId);
			await api.query('SAVEPOINT s');
			const twice = await insertContract(api, a.id, lease, a.director.userId).catch((error: { code: string; message: string }) => error);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect(twice).toMatchObject({ code: '23505' });
			const amendment = await insertAmendment(api, a.id, lease, a.director.userId);
			await api.query('SAVEPOINT s');
			await insertContract(api, a.id, lease, a.director.userId, { amendmentId: amendment });
			const again = await insertContract(api, a.id, lease, a.director.userId, { amendmentId: amendment }).catch(
				(error: { code: string; message: string }) => error
			);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect(again).toMatchObject({ code: '23505' });
			expect((await sqlError(api, `update lease_contracts set lease_id = $2 where id = $1`, [contract, other.lease])).message).toContain(
				'CONTRACT_IMMUTABLE'
			);
			expect((await sqlError(api, `update lease_contracts set template_version = 2 where id = $1`, [contract])).message).toContain(
				'CONTRACT_IMMUTABLE'
			);
		});
	});

	it('scan déposé hors plateforme : naît signé, sur le bail signé scanné actif de son bail, sans modèle ni version', async () => {
		const { lease } = await aLease(a);
		const other = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const insert = (documentId: string, extra = '') =>
				sqlError(
					api,
					`insert into lease_contracts (id, organization_id, lease_id, origin, status, signature_mode, signed_document_id,
						signature_recorded_by, signature_recorded_at${extra ? ', template_source, template_version' : ''})
					 values ($1, $2, $3, 'uploaded_scan', 'signed', 'handwritten_scan', $4, $5, now()${extra})`,
					[newId(), a.id, lease, documentId, a.director.userId]
				);
			const foreign = await insertDocument(api, a.id, a.director.userId, { type: 'signed_lease_scan', leaseId: other.lease });
			expect((await insert(foreign.id)).message).toContain('CONTRACT_SCAN');
			const scan = await insertDocument(api, a.id, a.director.userId, { type: 'signed_lease_scan', leaseId: lease });
			expect((await insert(scan.id, ", 'platform', 1")).message).toContain('lease_contracts_origin');
			await api.query(
				`insert into lease_contracts (id, organization_id, lease_id, origin, status, signature_mode, signed_document_id, signature_recorded_by,
					signature_recorded_at) values ($1, $2, $3, 'uploaded_scan', 'signed', 'handwritten_scan', $4, $5, now())`,
				[newId(), a.id, lease, scan.id, a.director.userId]
			);
			const draft = await sqlError(
				api,
				`insert into lease_contracts (id, organization_id, lease_id, origin, status) values ($1, $2, $3, 'uploaded_scan', 'draft')`,
				[newId(), a.id, other.lease]
			);
			expect(draft.message).toMatch(/CONTRACT_SCAN|lease_contracts_/);
		});
	});
});

describe('modèles de contrat', () => {
	it('le modèle et son fichier se citent : enregistrés ensemble ; sans fichier, refusé à la validation de la transaction', async () => {
		const template = await seed(a.id, (c) => insertTemplate(c, a.id, a.director.userId));
		expect(template.id).toBeTruthy();
		await api.query('BEGIN');
		await api.query(`select set_config('app.organization_id', $1, true)`, [a.id]);
		await api.query(
			`insert into contract_templates (id, organization_id, kind, name, document_id, created_by) values ($1, $2, 'lease', 'Sans fichier', $3, $4)`,
			[newId(), a.id, newId(), a.director.userId]
		);
		const e = await api.query('COMMIT').then(
			() => null,
			(error: { code: string; message: string }) => error
		);
		if (e) await api.query('ROLLBACK').catch(() => undefined);
		expect(e?.code).toBe('23503');
		expect(e?.message).toContain('contract_templates_document_fk');
	});

	it('naît brouillon ; activation : inspecté, sans balise inconnue ; un seul actif par type ; inspection figée une fois actif', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const born = await sqlError(
				api,
				`insert into contract_templates (id, organization_id, kind, name, document_id, created_by, status) values ($1, $2, 'lease', 'Actif', $3, $4, 'active')`,
				[newId(), a.id, newId(), a.director.userId]
			);
			expect(born.message).toContain('TEMPLATE_BORN_DRAFT');
			const one = await insertTemplate(api, a.id, a.director.userId);
			const activate = (id: string) =>
				sqlError(api, `update contract_templates set status = 'active', activated_at = now() where id = $1`, [id]);
			expect((await activate(one.id)).message).toContain('contract_templates_active');
			await api.query(`update contract_templates set inspected_at = now(), unknown_fields = array['client.nom'] where id = $1`, [one.id]);
			expect((await activate(one.id)).message).toContain('contract_templates_active');
			await api.query(`update contract_templates set unknown_fields = '{}', detected_fields = array['locataire.nom'] where id = $1`, [
				one.id
			]);
			await api.query(`update contract_templates set status = 'active', activated_at = now() where id = $1`, [one.id]);
			const reinspect = await sqlError(api, `update contract_templates set detected_fields = '{}' where id = $1`, [one.id]);
			expect(reinspect.message).toContain('TEMPLATE_IMMUTABLE');
			const two = await insertTemplate(api, a.id, a.director.userId);
			await api.query(`update contract_templates set inspected_at = now() where id = $1`, [two.id]);
			const second = await sqlError(api, `update contract_templates set status = 'active', activated_at = now() where id = $1`, [two.id]);
			expect(second.code).toBe('23505');
			// Un modèle d'avenant actif à côté du modèle de bail actif : accepté.
			const amendment = await insertTemplate(api, a.id, a.director.userId, 'amendment');
			await api.query(`update contract_templates set inspected_at = now(), status = 'active', activated_at = now() where id = $1`, [
				amendment.id
			]);
			// Retiré : plus rien ne change.
			await api.query(`update contract_templates set status = 'retired', retired_at = now() where id = $1`, [one.id]);
			expect((await sqlError(api, `update contract_templates set name = 'Autre' where id = $1`, [one.id])).message).toContain(
				'TEMPLATE_RETIRED'
			);
			expect(
				(await sqlError(api, `update contract_templates set document_id = $2 where id = $1`, [two.id, one.documentId])).message
			).toContain('TEMPLATE_IMMUTABLE');
		});
	});
});

describe('avenants', () => {
	it('valeurs selon le type ; un seul avenant de loyer ou de renouvellement en cours par bail ; clos : figé', async () => {
		const { lease } = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const bad = [
				{ type: 'rent_change' as const, values: { new_rent: null } },
				{ type: 'renewal' as const, values: { open_ended: false } },
				{ type: 'renewal' as const, values: { new_ends_on: '2027-12-31' } },
				{ type: 'other' as const, values: { description: null } },
				{ type: 'other' as const, values: { new_rent: 1 } }
			];
			for (const [i, extra] of bad.entries()) {
				await api.query('SAVEPOINT s');
				const e = await insertAmendment(api, a.id, lease, a.director.userId, { number: 10 + i, ...extra }).catch(
					(error: { message: string }) => error
				);
				await api.query('ROLLBACK TO SAVEPOINT s');
				expect((e as { message: string }).message, JSON.stringify(extra)).toContain('lease_amendments_values');
			}
			const first = await insertAmendment(api, a.id, lease, a.director.userId, { number: 1 });
			await api.query('SAVEPOINT s');
			const concurrent = await insertAmendment(api, a.id, lease, a.director.userId, { number: 2, type: 'renewal' }).catch(
				(error: { code: string }) => error
			);
			await api.query('ROLLBACK TO SAVEPOINT s');
			expect(concurrent).toMatchObject({ code: '23505' });
			// Un avenant « autre » à côté : accepté.
			await insertAmendment(api, a.id, lease, a.director.userId, { number: 3, type: 'other' });
			expect((await sqlError(api, `update lease_amendments set type = 'other' where id = $1`, [first])).message).toContain(
				'AMENDMENT_IMMUTABLE'
			);
			await api.query(
				`update lease_amendments set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Erreur de saisie' where id = $1`,
				[first]
			);
			expect((await sqlError(api, `update lease_amendments set description = 'x' where id = $1`, [first])).message).toContain(
				'AMENDMENT_CLOSED'
			);
			const applied = await sqlError(
				api,
				`insert into lease_amendments (id, organization_id, lease_id, number, type, effective_from, description, expected_lease_version, status,
					applied_at, created_by) values ($1, $2, $3, 4, 'other', '2026-07-01', 'x', 1, 'applied', now(), $4)`,
				[newId(), a.id, lease, a.director.userId]
			);
			expect(applied.message).toContain('AMENDMENT_BORN_DRAFT');
		});
	});
});

describe('renouvellement du bail par sa version suivante (D24)', () => {
	it('fin postérieure ou durée indéterminée, version suivante, copie dans lease_versions ; jamais avec un changement de loyer', async () => {
		const { lease } = await aLease(a, '2026-12-31');
		await inContext(api, { organizationId: a.id }, async () => {
			const renew = (endsOn: string | null, version: number, extra = '') =>
				sqlError(
					api,
					`update leases set ends_on = $2, last_renewed_on = '2027-01-01', last_renewal_automatic = true, version = $3${extra} where id = $1`,
					[lease, endsOn, version]
				);
			expect((await renew('2026-06-30', 2)).message).toContain('LEASE_RENEWAL');
			expect((await renew('2027-12-31', 3)).message).toContain('LEASE_VERSION');
			expect((await renew('2027-12-31', 2, `, rent = 90000, rent_effective_from = '2026-06-01'`)).message).toContain('LEASE_VERSION');
			// Sans date de renouvellement, la fin reste une condition figée (règle du lot 08).
			const noDate = await sqlError(api, `update leases set ends_on = '2027-12-31', version = 2 where id = $1`, [lease]);
			expect(noDate.message).toContain('LEASE_TERMS_LOCKED');
			await api.query(
				`update leases set ends_on = '2027-12-31', last_renewed_on = '2027-01-01', last_renewal_automatic = true, version = 2 where id = $1`,
				[lease]
			);
			const copy = await api.query(`select ends_on::text from lease_versions where lease_id = $1 and version = 2`, [lease]);
			expect(copy.rows[0].ends_on).toBe('2027-12-31');
			// Puis passage à durée indéterminée par la version suivante.
			await api.query(`update leases set ends_on = null, last_renewed_on = '2028-01-01', version = 3 where id = $1`, [lease]);
			// Un bail sans fin ne se renouvelle plus.
			const open = await sqlError(
				api,
				`update leases set ends_on = '2030-12-31', last_renewed_on = '2029-01-01', version = 4 where id = $1`,
				[lease]
			);
			expect(open.message).toContain('LEASE_RENEWAL');
		});
	});

	it('un brouillon ne se renouvelle pas ; un bail naît sans renouvellement', async () => {
		const { unit, tenant } = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const draft = await insertLease(api, a.id, unit, tenant, { status: 'draft' });
			const e = await sqlError(api, `update leases set last_renewed_on = '2027-01-01' where id = $1`, [draft]);
			expect(e.message).toMatch(/LEASE_RENEWAL|leases_renewal/);
		});
	});
});

describe('documents du contrat', () => {
	it('le Word seulement pour un modèle ou un projet ; un projet se rattache à son contrat et à son bail', async () => {
		const { lease } = await aLease(a);
		await inContext(api, { organizationId: a.id }, async () => {
			const contract = await insertContract(api, a.id, lease, a.director.userId);
			const insert = (type: string, mime: string, leaseId: string | null, contractId: string | null) =>
				sqlError(
					api,
					`insert into documents (id, organization_id, type, lease_id, lease_contract_id, file_name, mime_type, byte_size, storage_key, uploaded_by)
					 values ($1, $2, $3, $4, $5, 'f', $6, 1000, $7, $8)`,
					[newId(), a.id, type, leaseId, contractId, mime, `documents/${newId()}`, a.director.userId]
				);
			expect((await insert('signed_lease_scan', DOCX, lease, null)).message).toContain('documents_docx_types');
			expect((await insert('contract_draft', 'application/pdf', lease, null)).message).toContain('documents_contract_types');
			expect((await insert('contract_legalization', 'application/pdf', null, contract)).message).toContain('documents_contract_types');
			expect((await insert('contract_template', DOCX, lease, null)).message).toContain('documents_contract_types');
			await insertDocument(api, a.id, a.director.userId, {
				type: 'contract_draft',
				leaseId: lease,
				leaseContractId: contract,
				mimeType: DOCX
			});
		});
	});
});
