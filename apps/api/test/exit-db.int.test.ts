/**
 * Lot 10 bis, étape 2 : sortie du locataire dans la base (migration 0019), en SQL, avec le rôle de l'API (app_api, sans
 * BYPASSRLS) et le propriétaire du schéma (triggers).
 * - Accès croisé A/B sur les neuf nouvelles tables : lire, modifier, référencer (règle 1).
 * - Ajout seul : lignes de décompte, mouvements de caution, transferts de gestion (règle 14), même pour le propriétaire.
 * - Règle 14 et D32 : retenue sans ligne `tenant_damage`, sans montant ou sans justificatif refusée ; somme due vers
 *   l'échéance ou la dépense elle-même, avec son justificatif ; imputation sur loyer sans accord accepté avant le mois
 *   refusée ; imputation sur caution jamais sans son mouvement ; décompte clos seulement mouvements écrits.
 * - État des lieux : « bon état » seul refusé (article 9), constat obligatoire à la sortie, figé une fois signé.
 * - Préavis seulement sur congé enregistré ; fin de bail → unité « à remettre en état » (D14) ; dernière période ramenée
 *   une fois à la sortie (D32).
 * - Transfert de gestion : portée terminée, nouveau mandat possible, caution au nouveau gestionnaire nommé en texte,
 *   aucune ligne dans une autre organisation (règles 12 et 15).
 */
import { newId } from '@ziga/shared/ids';
import { inspectionDescriptionBlocker, VAGUE_WORDS } from '@ziga/shared/tenant-exit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertExpense } from './collections.js';
import {
	acceptAgreement,
	endLease,
	giveNotice,
	insertAgreement,
	insertDocument,
	insertInspection,
	insertItem,
	insertRepair,
	insertSettlement,
	insertSettlementLine,
	insertTransfer,
	setSettlementStatus,
	signInspection
} from './exit.js';
import { startApp, type TestApp } from './http.js';
import { insertDepositAccount, insertDue, insertLease, insertMovement, insertTenant } from './leases.js';
import { apiSql, createOrg, inContext, sqlError, type Org } from './orgs.js';
import { allocate, insertPayment, insertReceipt, receiveDeposit } from './payments.js';
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

async function checkDeferred(c: pg.Client): Promise<void> {
	await c.query('set constraints all immediate');
	await c.query('set constraints all deferred');
}

interface World {
	owner: string;
	mandate: string;
	property: string;
	unit: string;
	tenant: string;
	lease: string;
	/** Échéance de décembre 2026, émise (due). */
	due: string;
	/** Caution de 100 000 FCFA, reçue en entier, détenue par l'organisation. */
	account: string;
	/** Dépense réclamée au locataire, avec son justificatif. */
	claim: string;
	claimDocument: string;
}

/** Propriétaire sous mandat de gestion (portée sur le bien), bien et unité, bail en vigueur, échéance, caution, dépense. */
async function world(org: Org): Promise<World> {
	const user = org.director.userId;
	return seed(org.id, async (c) => {
		const ownerId = newId();
		await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Awa Sawadogo', '+22670445566')`, [
			ownerId,
			org.id
		]);
		const mandate = newId();
		await c.query(
			`insert into mandates (id, organization_id, owner_id, type, starts_on, commission_basis, commission_rate_bp)
			 values ($1, $2, $3, 'rental_management', '2026-01-01', 'percent_of_collected', 1000)`,
			[mandate, org.id, ownerId]
		);
		const { property, unit } = await propertyWithUnit(c, org.id, ownerId);
		await c.query(`insert into mandate_scopes (id, organization_id, mandate_id, property_id) values ($1, $2, $3, $4)`, [
			newId(),
			org.id,
			mandate,
			property
		]);
		const tenant = await insertTenant(c, org.id);
		const lease = await insertLease(c, org.id, unit, tenant);
		await insertDue(c, org.id, lease, '2026-12-01', { status: 'due' });
		const due = (await c.query(`select id from rent_dues where lease_id = $1 and period_start = '2026-12-01'`, [lease])).rows[0]
			.id as string;
		const account = await insertDepositAccount(c, org.id, lease, { agreed: 100_000 });
		await receiveDeposit(c, org.id, account, 100_000);
		const claim = await insertExpense(c, org.id, {
			propertyId: property,
			unitId: unit,
			leaseId: lease,
			borneBy: 'tenant',
			recovery: 'claimed_from_tenant'
		});
		const claimDocument = await insertDocument(c, org.id, user, { type: 'expense_receipt', propertyId: property });
		await c.query(`update expenses set document_id = $2 where id = $1`, [claim, claimDocument]);
		return { owner: ownerId, mandate, property, unit, tenant, lease, due, account, claim, claimDocument };
	});
}

/** Refus attendu : renvoie le message (point de sauvegarde, la transaction reste utilisable). */
async function refused(sql: string, params: unknown[] = []): Promise<string> {
	return (await sqlError(api, sql, params)).message;
}

async function refusedBy(fn: () => Promise<unknown>): Promise<string> {
	await api.query('SAVEPOINT attendu');
	try {
		await fn();
	} catch (error) {
		await api.query('ROLLBACK TO SAVEPOINT attendu');
		return (error as Error).message;
	}
	throw new Error('Écriture acceptée alors qu’elle devait être refusée');
}

let wa: World;
let wb: World;

beforeAll(async () => {
	t = await startApp();
	a = await createOrg(t, 'agency', 'Agence A sortie');
	b = await createOrg(t, 'agency', 'Agence B sortie');
	owner = await connect(process.env.DATABASE_MIGRATION_URL!);
	api = await apiSql();
	wa = await world(a);
	wb = await world(b);
});
afterAll(async () => {
	await api.end();
	await owner.end();
	await t.close();
});

// ---------------------------------------------------------------- accès croisé

const TABLES = [
	'lease_notices',
	'inspections',
	'inspection_items',
	'inspection_catalog_entries',
	'agreements',
	'repairs',
	'deposit_settlements',
	'deposit_settlement_lines',
	'management_transfers'
];

describe('accès croisé A/B en SQL (règle 1)', () => {
	let inB: {
		notice: string;
		inspection: string;
		item: string;
		catalog: string;
		agreement: string;
		repair: string;
		settlement: string;
		line: string;
		transfer: string;
		quote: string;
	};

	beforeAll(async () => {
		const user = b.director.userId;
		inB = await seed(b.id, async (c) => {
			const notice = await giveNotice(c, b.id, wb.lease, user);
			const inspection = await insertInspection(c, b.id, wb.lease, user);
			const item = await insertItem(c, b.id, inspection);
			const catalog = newId();
			await c.query(
				`insert into inspection_catalog_entries (id, organization_id, kind, key, label) values ($1, $2, 'element', 'door', 'Porte')`,
				[catalog, b.id]
			);
			const agreement = await insertAgreement(c, b.id, wb.lease, { type: 'tenant_self_repair' });
			const quote = await insertDocument(c, b.id, user, { type: 'repair_quote', leaseId: wb.lease });
			const repair = await insertRepair(c, b.id, item, { quoteDocumentId: quote });
			const settlement = await insertSettlement(c, b.id, wb.account, {
				received: 100_000,
				deductions: 10_000,
				coveredByDeposit: 10_000,
				refund: 90_000,
				refundFromDeposit: 90_000,
				outcome: 'refund'
			});
			const line = await insertSettlementLine(c, b.id, settlement, {
				kind: 'repair',
				amount: 10_000,
				inspectionItemId: item,
				repairId: repair,
				documentId: quote
			});
			const transfer = await insertTransfer(c, b.id, { mandateId: wb.mandate, propertyId: wb.property, userId: user });
			return { notice, inspection, item, catalog, agreement, repair, settlement, line, transfer, quote };
		});
	});

	it('A ne lit aucune ligne de B, dans aucune des neuf tables ; B voit les siennes', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			for (const table of TABLES) {
				const r = await api.query(`select count(*)::int as n from ${table} where organization_id = $1`, [b.id]);
				expect(r.rows[0].n, table).toBe(0);
			}
		});
		await inContext(api, { organizationId: b.id }, async () => {
			for (const table of TABLES) {
				const r = await api.query(`select count(*)::int as n from ${table} where organization_id = $1`, [b.id]);
				expect(r.rows[0].n, table).toBeGreaterThan(0);
			}
		});
	});

	it('A ne modifie rien chez B (aucune ligne touchée)', async () => {
		await inContext(api, { organizationId: a.id }, async () => {
			const updates: [string, unknown[]][] = [
				[`update lease_notices set reason = 'Essai A' where id = $1`, [inB.notice]],
				[`update inspections set tenant_observations = 'Essai A' where id = $1`, [inB.inspection]],
				[`update inspection_items set description = 'Description réécrite par A' where id = $1`, [inB.item]],
				[`update inspection_catalog_entries set active = false where id = $1`, [inB.catalog]],
				[`update agreements set description = 'Essai A' where id = $1`, [inB.agreement]],
				[`update repairs set estimated_amount = 1 where id = $1`, [inB.repair]],
				[`update deposit_settlements set tenant_observations = 'Essai A' where id = $1`, [inB.settlement]],
				[`delete from inspection_items where id = $1`, [inB.item]]
			];
			for (const [sql, params] of updates) expect((await api.query(sql, params)).rowCount, sql).toBe(0);
		});
	});

	it('A ne référence rien de B : bail, état des lieux, ligne, réparation, accord, compte, décompte, mandat (clés composites)', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			const ownInspection = await insertInspection(api, a.id, wa.lease, user);
			const refusedFk: [string, string, unknown[]][] = [
				[
					'congé sur un bail de B',
					`insert into lease_notices (id, organization_id, lease_id, origin, status) values ($1, $2, $3, 'tenant', 'requested')`,
					[newId(), a.id, wb.lease]
				],
				[
					'état des lieux d’un bail de B',
					`insert into inspections (id, organization_id, lease_id, type, inspected_on, performed_by) values ($1, $2, $3, 'entry', current_date, $4)`,
					[newId(), a.id, wb.lease, user]
				],
				[
					'ligne dans un état des lieux de B',
					`insert into inspection_items (id, organization_id, inspection_id, room, element, description, finding) values ($1, $2, $3, 'Salon', 'door', 'Porte rayée sur toute la hauteur', 'tenant_damage')`,
					[newId(), a.id, inB.inspection]
				],
				[
					'comparaison avec une ligne de B',
					`insert into inspection_items (id, organization_id, inspection_id, room, element, description, finding, entry_item_id) values ($1, $2, $3, 'Salon', 'door', 'Porte rayée sur toute la hauteur', 'tenant_damage', $4)`,
					[newId(), a.id, ownInspection, inB.item]
				],
				[
					'réparation d’une ligne de B',
					`insert into repairs (id, organization_id, inspection_item_id, lease_id, description, performed_by) values ($1, $2, $3, $4, 'Remplacer', 'organization')`,
					[newId(), a.id, inB.item, wa.lease]
				],
				[
					'accord sur un bail de B',
					`insert into agreements (id, organization_id, lease_id, type, proposed_by, proposed_on) values ($1, $2, $3, 'tenant_self_repair', 'tenant', current_date)`,
					[newId(), a.id, wb.lease]
				],
				[
					'décompte du compte de caution de B',
					`insert into deposit_settlements (id, organization_id, deposit_account_id, lease_id, exit_on, refund_deadline) values ($1, $2, $3, $4, current_date, current_date)`,
					[newId(), a.id, wb.account, wa.lease]
				],
				[
					'ligne dans un décompte de B',
					`insert into deposit_settlement_lines (id, organization_id, settlement_id, revision, kind, amount, covered, uncovered, rent_due_id) values ($1, $2, $3, 1, 'unpaid_rent', 0, 0, 0, $4)`,
					[newId(), a.id, inB.settlement, wa.due]
				],
				[
					'transfert du mandat de B',
					`insert into management_transfers (id, organization_id, mandate_id, property_id, transfer_on, new_manager_name, handed_over_on, handed_over_items, mandate_action, recorded_by) values ($1, $2, $3, $4, current_date, 'Agence X', current_date, '{Bail}', 'end_mandate', $5)`,
					[newId(), a.id, wb.mandate, wa.property, user]
				],
				[
					'mouvement vers un décompte de B',
					`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on, settlement_id) values ($1, $2, $3, 'additional_claimed', 1000, current_date, $4)`,
					[newId(), a.id, wa.account, inB.settlement]
				],
				[
					'document rattaché à un état des lieux de B',
					`insert into documents (id, organization_id, type, lease_id, inspection_id, file_name, mime_type, byte_size, storage_key, uploaded_by) values ($1, $2, 'inspection_scan', $3, $4, 'scan.pdf', 'application/pdf', 10, $5, $6)`,
					[newId(), a.id, wa.lease, inB.inspection, `documents/${a.id}/${newId()}`, user]
				]
			];
			for (const [label, sql, params] of refusedFk) expect((await sqlError(api, sql, params)).code, label).toBe('23503');
		});
	});
});

// ---------------------------------------------------------------- ajout seul

describe('ajout seul (règle 14) : lignes de décompte, mouvements de caution, transferts de gestion', () => {
	it('UPDATE et DELETE refusés à l’API ; refusés aussi au propriétaire du schéma', async () => {
		const settlement = await seed(
			b.id,
			async (c) => (await c.query(`select id from deposit_settlement_lines limit 1`)).rows[0].id as string
		);
		const transfer = await seed(b.id, async (c) => (await c.query(`select id from management_transfers limit 1`)).rows[0].id as string);
		const movement = await seed(b.id, async (c) => (await c.query(`select id from deposit_movements limit 1`)).rows[0].id as string);
		await inContext(api, { organizationId: b.id }, async () => {
			for (const [table, id] of [
				['deposit_settlement_lines', settlement],
				['management_transfers', transfer],
				['deposit_movements', movement]
			] as const) {
				expect((await sqlError(api, `update ${table} set created_at = now() where id = $1`, [id])).code, table).toBe('42501');
				expect((await sqlError(api, `delete from ${table} where id = $1`, [id])).code, table).toBe('42501');
			}
		});
		await inContext(owner, { organizationId: b.id }, async () => {
			for (const [table, id] of [
				['deposit_settlement_lines', settlement],
				['management_transfers', transfer],
				['deposit_movements', movement]
			] as const) {
				expect((await sqlError(owner, `update ${table} set created_at = now() where id = $1`, [id])).message, table).toContain(
					'APPEND_ONLY'
				);
				expect((await sqlError(owner, `delete from ${table} where id = $1`, [id])).message, table).toContain('APPEND_ONLY');
				expect((await sqlError(owner, `truncate ${table} cascade`)).message, table).toContain('APPEND_ONLY');
			}
		});
	});
});

// ---------------------------------------------------------------- décompte : exemple du porteur, règle 14, D32

describe('décompte de sortie dans la base (règle 14, D32)', () => {
	it('exemple du porteur : deux retenues justifiées, 85 000 restitués ; clos seulement mouvements écrits ; compte soldé', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			await giveNotice(api, a.id, wa.lease, user);
			await endLease(api, wa.lease);
			const insp = await insertInspection(api, a.id, wa.lease, user);
			const shower = await insertItem(api, a.id, insp);
			const door = await insertItem(api, a.id, insp, {
				room: 'Chambre',
				element: 'door',
				description: 'Porte du placard fendue, gond arraché'
			});
			await signInspection(api, insp, user);
			const q1 = await insertDocument(api, a.id, user, { type: 'repair_quote', leaseId: wa.lease });
			const q2 = await insertDocument(api, a.id, user, { type: 'repair_quote', leaseId: wa.lease });
			const r1 = await insertRepair(api, a.id, shower, { amount: 10_000, quoteDocumentId: q1 });
			const r2 = await insertRepair(api, a.id, door, { amount: 5_000, quoteDocumentId: q2 });
			const s = await insertSettlement(api, a.id, wa.account, {
				received: 100_000,
				deductions: 15_000,
				coveredByDeposit: 15_000,
				refund: 85_000,
				refundFromDeposit: 85_000,
				outcome: 'refund'
			});
			expect((await api.query(`select status from deposit_accounts where id = $1`, [wa.account])).rows[0].status).toBe('settling');
			await insertSettlementLine(api, a.id, s, { kind: 'repair', amount: 10_000, inspectionItemId: shower, repairId: r1, documentId: q1 });
			await insertSettlementLine(api, a.id, s, { kind: 'repair', amount: 5_000, inspectionItemId: door, repairId: r2, documentId: q2 });
			// Un brouillon n'écrit aucun mouvement.
			expect(
				await refusedBy(() =>
					insertMovement(api, a.id, wa.account, 'retained', 10_000, { settlementId: s, inspectionItemId: shower, documentId: q1 })
				)
			).toContain('SETTLEMENT_LOCKED');
			await setSettlementStatus(api, s, 'proposed');
			// Proposé : ni nouvelle ligne, ni total changé.
			expect(
				await refusedBy(() =>
					insertSettlementLine(api, a.id, s, { kind: 'repair', amount: 1_000, inspectionItemId: shower, repairId: r1, documentId: q1 })
				)
			).toContain('SETTLEMENT_LOCKED');
			expect(await refused(`update deposit_settlements set refund = 1 where id = $1`, [s])).toContain('SETTLEMENT_LOCKED');
			await setSettlementStatus(api, s, 'accepted');
			expect(await refusedBy(() => setSettlementStatus(api, s, 'closed', user))).toContain('SETTLEMENT_MOVEMENTS_MISSING');
			await insertMovement(api, a.id, wa.account, 'retained', 10_000, {
				settlementId: s,
				inspectionItemId: shower,
				documentId: q1,
				repairId: r1
			});
			await insertMovement(api, a.id, wa.account, 'retained', 5_000, {
				settlementId: s,
				inspectionItemId: door,
				documentId: q2,
				repairId: r2
			});
			await insertMovement(api, a.id, wa.account, 'refunded', 85_000, {
				settlementId: s,
				refundedBy: 'owner',
				refundMethod: 'mobile_money',
				refundReference: 'MP123'
			});
			await setSettlementStatus(api, s, 'closed', user);
			expect((await api.query(`select status from deposit_accounts where id = $1`, [wa.account])).rows[0].status).toBe('closed');
			expect(await refusedBy(() => insertMovement(api, a.id, wa.account, 'additional_claimed', 1, { settlementId: s }))).toContain(
				'DEPOSIT_ACCOUNT_CLOSED'
			);
			expect(await refused(`update deposit_settlements set tenant_observations = 'Après' where id = $1`, [s])).toContain(
				'SETTLEMENT_CLOSED'
			);
		});
	});

	it('retenue refusée sans ligne tenant_damage, sans montant, sans justificatif, ou hors du décompte', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			await giveNotice(api, a.id, wa.lease, user);
			const insp = await insertInspection(api, a.id, wa.lease, user);
			const damage = await insertItem(api, a.id, insp);
			const wear = await insertItem(api, a.id, insp, {
				element: 'walls_paint',
				description: 'Peinture jaunie par le temps',
				finding: 'normal_wear'
			});
			const quote = await insertDocument(api, a.id, user, { type: 'repair_quote', leaseId: wa.lease });
			const notice = await insertDocument(api, a.id, user, { type: 'notice_proof', leaseId: wa.lease });
			const repair = await insertRepair(api, a.id, damage, { quoteDocumentId: quote });
			// Une réparation n'existe que sur une ligne imputable au locataire.
			expect(await refusedBy(() => insertRepair(api, a.id, wear, { quoteDocumentId: quote }))).toContain('REPAIR_NOT_TENANT_DAMAGE');
			const s = await insertSettlement(api, a.id, wa.account, {
				received: 100_000,
				deductions: 0,
				coveredByDeposit: 0,
				refund: 100_000,
				refundFromDeposit: 100_000,
				outcome: 'refund'
			});
			expect(
				await refusedBy(() =>
					insertSettlementLine(api, a.id, s, {
						kind: 'repair',
						amount: 10_000,
						inspectionItemId: wear,
						repairId: repair,
						documentId: quote
					})
				)
			).toContain('RETENTION_NOT_TENANT_DAMAGE');
			expect(
				await refusedBy(() =>
					insertSettlementLine(api, a.id, s, { kind: 'repair', amount: 10_000, inspectionItemId: damage, repairId: repair })
				)
			).toMatch(/RETENTION_PROOF_MISSING|deposit_settlement_lines_repair/);
			expect(
				await refusedBy(() =>
					insertSettlementLine(api, a.id, s, {
						kind: 'repair',
						amount: 10_000,
						inspectionItemId: damage,
						repairId: repair,
						documentId: notice
					})
				)
			).toContain('RETENTION_PROOF_MISSING');
			expect(
				await refusedBy(() => insertSettlementLine(api, a.id, s, { kind: 'repair', amount: 10_000, repairId: repair, documentId: quote }))
			).toMatch(/deposit_settlement_lines_repair|RETENTION_NOT_TENANT_DAMAGE/);
			// Une ligne refusée reste affichée avec son motif, à 0 FCFA ; jamais un montant.
			await insertSettlementLine(api, a.id, s, {
				kind: 'repair',
				amount: 0,
				blocker: 'RETENTION_PROOF_MISSING',
				inspectionItemId: damage,
				repairId: repair
			});
			expect(
				await refusedBy(() =>
					insertSettlementLine(api, a.id, s, {
						kind: 'repair',
						amount: 5_000,
						blocker: 'RETENTION_PROOF_MISSING',
						inspectionItemId: damage,
						repairId: repair
					})
				)
			).toContain('deposit_settlement_lines_refused');
			await setSettlementStatus(api, s, 'proposed');
			// Mouvement : sans décompte, ou sur une ligne d'usure normale.
			expect(
				await refusedBy(() => insertMovement(api, a.id, wa.account, 'retained', 1_000, { inspectionItemId: damage, documentId: quote }))
			).toContain('deposit_movements_retained_settlement');
			expect(
				await refusedBy(() =>
					insertMovement(api, a.id, wa.account, 'retained', 1_000, { settlementId: s, inspectionItemId: wear, documentId: quote })
				)
			).toContain('RETENTION_NOT_TENANT_DAMAGE');
			expect(
				await refusedBy(() =>
					insertMovement(api, a.id, wa.account, 'retained', 1_000, { settlementId: s, inspectionItemId: damage, documentId: notice })
				)
			).toContain('RETENTION_PROOF_MISSING');
			expect(
				await refusedBy(() => insertMovement(api, a.id, wa.account, 'retained', 1_000, { settlementId: s, inspectionItemId: damage }))
			).toContain('deposit_movements_retained');
		});
	});

	it('somme due (D32) : l’échéance ou la dépense elle-même, avec son justificatif, payée par une imputation sur caution', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			await giveNotice(api, a.id, wa.lease, user);
			const s = await insertSettlement(api, a.id, wa.account, {
				received: 100_000,
				deductions: 95_000,
				coveredByDeposit: 95_000,
				refund: 5_000,
				refundFromDeposit: 5_000,
				outcome: 'refund'
			});
			await insertSettlementLine(api, a.id, s, {
				kind: 'expense_claim',
				amount: 15_000,
				expenseId: wa.claim,
				documentId: wa.claimDocument
			});
			await insertSettlementLine(api, a.id, s, { kind: 'unpaid_rent', amount: 80_000, rentDueId: wa.due });
			// Une copie de la dépense, ou un autre document, n'est pas son justificatif.
			const other = await insertDocument(api, a.id, user, { type: 'expense_receipt', propertyId: wa.property });
			expect(
				await refusedBy(() =>
					insertSettlementLine(api, a.id, s, { kind: 'expense_claim', amount: 15_000, expenseId: wa.claim, documentId: other })
				)
			).toContain('DEBT_PROOF_MISSING');
			const noProof = await insertExpense(api, a.id, {
				propertyId: wa.property,
				leaseId: wa.lease,
				borneBy: 'tenant',
				recovery: 'claimed_from_tenant'
			});
			expect(
				await refusedBy(() => insertSettlementLine(api, a.id, s, { kind: 'expense_claim', amount: 15_000, expenseId: noProof }))
			).toContain('DEBT_PROOF_MISSING');
			const forOwner = await insertExpense(api, a.id, { propertyId: wa.property });
			expect(
				await refusedBy(() =>
					insertSettlementLine(api, a.id, s, { kind: 'expense_claim', amount: 15_000, expenseId: forOwner, documentId: other })
				)
			).toContain('DEBT_NOT_CLAIMED');
			await setSettlementStatus(api, s, 'proposed');
			await setSettlementStatus(api, s, 'accepted');
			// L'échéance de décembre, payée par la caution : encaissement interne, imputation exacte, mouvement lié.
			const offset = await insertPayment(api, a.id, wa.lease, {
				method: 'deposit_offset',
				amount: 80_000,
				confirmedBy: user,
				paidOn: '2026-12-31'
			});
			await allocate(api, a.id, offset, wa.lease, [{ target: 'rent_due', rentDueId: wa.due, amount: 80_000 }]);
			await insertMovement(api, a.id, wa.account, 'applied_to_debt', 80_000, { settlementId: s, rentDueId: wa.due, paymentId: offset });
			const claimPayment = await insertPayment(api, a.id, wa.lease, {
				method: 'deposit_offset',
				purpose: 'expense',
				expenseId: wa.claim,
				amount: 15_000,
				confirmedBy: user
			});
			await allocate(api, a.id, claimPayment, wa.lease, [{ target: 'expense', expenseId: wa.claim, amount: 15_000 }]);
			await insertMovement(api, a.id, wa.account, 'applied_to_debt', 15_000, {
				settlementId: s,
				expenseId: wa.claim,
				paymentId: claimPayment
			});
			await checkDeferred(api);
			// Provenance recopiée par la base : l'agent de terrain ne reçoit jamais ces lignes.
			expect((await api.query(`select distinct source from payment_allocations where payment_id = $1`, [offset])).rows).toEqual([
				{ source: 'deposit' }
			]);
			const receipt = await insertReceipt(api, a.id, offset);
			expect((await api.query(`select source from receipts where id = $1`, [receipt])).rows[0].source).toBe('deposit');
			expect((await api.query(`select amount_paid::int from rent_dues where id = $1`, [wa.due])).rows[0].amount_paid).toBe(80_000);
			// Sans cible, ou sans encaissement interne : refusé.
			expect(await refusedBy(() => insertMovement(api, a.id, wa.account, 'applied_to_debt', 1_000, { settlementId: s }))).toContain(
				'deposit_movements_debt'
			);
			const cash = await insertPayment(api, a.id, wa.lease, { amount: 1_000, confirmedBy: user });
			expect(
				await refusedBy(() =>
					insertMovement(api, a.id, wa.account, 'applied_to_debt', 1_000, { settlementId: s, rentDueId: wa.due, paymentId: cash })
				)
			).toContain('DEPOSIT_OFFSET_MISMATCH');
			await insertMovement(api, a.id, wa.account, 'refunded', 5_000, { settlementId: s });
			await setSettlementStatus(api, s, 'closed', user);
		});
	});

	it('imputation sur caution jamais saisie seule : sans son mouvement, refusée à la validation ; jamais pour une caution', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			const p = await insertPayment(api, a.id, wa.lease, { method: 'deposit_offset', amount: 1_000, confirmedBy: user });
			await allocate(api, a.id, p, wa.lease, [{ target: 'rent_due', rentDueId: wa.due, amount: 1_000 }]);
			expect(await refusedBy(() => checkDeferred(api))).toContain('DEPOSIT_OFFSET_UNBACKED');
		});
		await inContext(api, { organizationId: a.id }, async () => {
			expect(
				await refusedBy(() =>
					insertPayment(api, a.id, wa.lease, {
						method: 'deposit_offset',
						purpose: 'deposit',
						depositAccountId: wa.account,
						amount: 1_000,
						confirmedBy: user
					})
				)
			).toContain('payments_deposit_offset');
			expect(
				await refusedBy(() => insertPayment(api, a.id, wa.lease, { method: 'deposit_offset', status: 'to_validate', amount: 1_000 }))
			).toContain('PAYMENT_INITIAL_STATUS');
		});
	});

	it('imputation sur loyer : accord écrit accepté avant le mois ; sinon refusée', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			await insertDue(api, a.id, wa.lease, '2026-11-01', { status: 'due' });
			const nov = (await api.query(`select id from rent_dues where lease_id = $1 and period_start = '2026-11-01'`, [wa.lease])).rows[0]
				.id as string;
			const written = await insertDocument(api, a.id, user, { type: 'agreement_document', leaseId: wa.lease });
			const proposed = await insertAgreement(api, a.id, wa.lease);
			// Sans écrit, ou accepté après le début d'un des mois : refusé.
			expect(await refusedBy(() => acceptAgreement(api, proposed, user))).toContain('agreements_written');
			expect(await refusedBy(() => acceptAgreement(api, proposed, user, { decidedOn: '2026-11-02', documentId: written }))).toContain(
				'AGREEMENT_MONTH_STARTED'
			);
			const pay = async (dueId: string) => {
				const p = await insertPayment(api, a.id, wa.lease, { method: 'deposit_offset', amount: 80_000, confirmedBy: user });
				await allocate(api, a.id, p, wa.lease, [{ target: 'rent_due', rentDueId: dueId, amount: 80_000 }]);
				return p;
			};
			// Accord seulement proposé : refusé.
			const p0 = await pay(nov);
			expect(
				await refusedBy(() =>
					insertMovement(api, a.id, wa.account, 'applied_to_rent', 80_000, { agreementId: proposed, rentDueId: nov, paymentId: p0 })
				)
			).toContain('AGREEMENT_NOT_ACCEPTED');
			await acceptAgreement(api, proposed, user, { documentId: written });
			await insertMovement(api, a.id, wa.account, 'applied_to_rent', 80_000, { agreementId: proposed, rentDueId: nov, paymentId: p0 });
			await checkDeferred(api);
			// Un mois que l'accord ne couvre pas.
			await insertDue(api, a.id, wa.lease, '2027-01-01', { status: 'upcoming' });
			const jan = (await api.query(`select id from rent_dues where lease_id = $1 and period_start = '2027-01-01'`, [wa.lease])).rows[0]
				.id as string;
			const p1 = await insertPayment(api, a.id, wa.lease, { method: 'deposit_offset', amount: 20_000, confirmedBy: user });
			expect(
				await refusedBy(() =>
					insertMovement(api, a.id, wa.account, 'applied_to_rent', 20_000, { agreementId: proposed, rentDueId: jan, paymentId: p1 })
				)
			).toContain('AGREEMENT_AFTER_PERIOD');
			// Sans accord du tout (contrainte du lot 08) ; au-delà de la caution reçue.
			expect(
				await refusedBy(() => insertMovement(api, a.id, wa.account, 'applied_to_rent', 20_000, { rentDueId: jan, paymentId: p1 }))
			).toContain('deposit_movements_applied');
			expect(
				await refusedBy(() =>
					insertMovement(api, a.id, wa.account, 'applied_to_rent', 20_001, { agreementId: proposed, rentDueId: nov, paymentId: p1 })
				)
			).toContain('DEPOSIT_OUTFLOW_EXCEEDS_RECEIVED');
		});
	});
});

// ---------------------------------------------------------------- états des lieux

describe('états des lieux (article 9)', () => {
	it('« bon état » seul refusé ; liste des mots de la base égale à celle de packages/shared', async () => {
		const words = (await owner.query(`select inspection_vague_words() as w`)).rows[0].w as string[];
		expect([...words].sort()).toEqual([...VAGUE_WORDS].sort());
		const samples = [
			'Bon état.',
			'BON ETAT',
			'Bon état général, RAS',
			'Très bon état',
			'Bon état, peinture blanche sans trace',
			'Porte rayée, poignée cassée'
		];
		for (const sample of samples) {
			const vague = (await owner.query(`select inspection_description_vague($1) as v`, [sample])).rows[0].v as boolean;
			expect(vague, sample).toBe(inspectionDescriptionBlocker(sample) === 'INSPECTION_DESCRIPTION_VAGUE');
		}
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			const insp = await insertInspection(api, a.id, wa.lease, user);
			expect(await refusedBy(() => insertItem(api, a.id, insp, { description: 'Bon état général, RAS' }))).toContain(
				'INSPECTION_DESCRIPTION_VAGUE'
			);
			expect(await refusedBy(() => insertItem(api, a.id, insp, { description: 'Fissurée' }))).toContain(
				'inspection_items_description_check'
			);
			await insertItem(api, a.id, insp, { description: 'Bon état, peinture blanche sans trace', finding: 'normal_wear' });
		});
	});

	it('constat obligatoire à la sortie, jamais à l’entrée ; comparaison avec l’entrée du même bail', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			const entry = await insertInspection(api, a.id, wa.lease, user, 'entry');
			const exit = await insertInspection(api, a.id, wa.lease, user, 'exit');
			expect(await refusedBy(() => insertItem(api, a.id, exit, { finding: null }))).toContain('INSPECTION_FINDING_REQUIRED');
			expect(await refusedBy(() => insertItem(api, a.id, entry, { finding: 'normal_wear' }))).toContain('INSPECTION_FINDING_ON_ENTRY');
			const entryItem = await insertItem(api, a.id, entry, { finding: null, description: 'Douche complète, pommeau et flexible neufs' });
			const exitItem = await insertItem(api, a.id, exit, { entryItemId: entryItem });
			expect(await refusedBy(() => insertItem(api, a.id, exit, { entryItemId: exitItem }))).toContain('INSPECTION_COMPARISON');
			// Un seul état des lieux de chaque type par bail.
			expect(
				(
					await sqlError(
						api,
						`insert into inspections (id, organization_id, lease_id, type, inspected_on, performed_by) values ($1, $2, $3, 'exit', current_date, $4)`,
						[newId(), a.id, wa.lease, user]
					)
				).code
			).toBe('23505');
		});
	});

	it('signé des deux parties, puis figé : ni ligne ajoutée, modifiée ou supprimée ; brouillon : ligne supprimable', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			const insp = await insertInspection(api, a.id, wa.lease, user);
			const item = await insertItem(api, a.id, insp);
			const extra = await insertItem(api, a.id, insp, { element: 'door', description: 'Porte d’entrée, serrure forcée' });
			expect((await api.query(`delete from inspection_items where id = $1`, [extra])).rowCount).toBe(1);
			expect(await refused(`update inspections set status = 'signed_both' where id = $1`, [insp])).toContain('inspections_signed');
			await signInspection(api, insp, user);
			expect(await refusedBy(() => insertItem(api, a.id, insp))).toContain('INSPECTION_LOCKED');
			expect(
				await refused(`update inspection_items set description = 'Description changée après la signature' where id = $1`, [item])
			).toContain('INSPECTION_LOCKED');
			expect(await refused(`delete from inspection_items where id = $1`, [item])).toContain('INSPECTION_LOCKED');
			expect(await refused(`update inspections set tenant_observations = 'Après' where id = $1`, [insp])).toContain('INSPECTION_LOCKED');
		});
	});
});

// ---------------------------------------------------------------- préavis, fin de bail, dernière période

describe('préavis et fin de bail (D14, D32)', () => {
	it('préavis seulement sur congé enregistré ; une demande n’en est pas un ; un congé enregistré ne change plus', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			expect(
				await refused(`update leases set status = 'notice', notice_given_on = '2026-10-01', exit_on = '2026-12-31' where id = $1`, [
					wa.lease
				])
			).toContain('LEASE_NOTICE_REQUIRED');
			await api.query(
				`insert into lease_notices (id, organization_id, lease_id, origin, status, created_by) values ($1, $2, $3, 'tenant', 'requested', $4)`,
				[newId(), a.id, wa.lease, user]
			);
			expect(
				await refused(`update leases set status = 'notice', notice_given_on = '2026-10-01', exit_on = '2026-12-31' where id = $1`, [
					wa.lease
				])
			).toContain('LEASE_NOTICE_REQUIRED');
			const notice = await giveNotice(api, a.id, wa.lease, user);
			expect(await refused(`update lease_notices set reason = 'Autre motif' where id = $1`, [notice])).toContain('NOTICE_LOCKED');
			expect(await refused(`update leases set exit_on = '2027-01-31' where id = $1`, [wa.lease])).toContain('LEASE_NOTICE_LOCKED');
			const second = await sqlError(
				api,
				`insert into lease_notices (id, organization_id, lease_id, origin, status, delivery_mode, notified_on, planned_exit_on, notice_months, notice_ends_on, rent_ends_on, recorded_at)
				 values ($1, $2, $3, 'lessor', 'recorded', 'bailiff', '2026-10-02', '2027-01-31', 3, '2027-01-01', '2027-01-31', now())`,
				[newId(), a.id, wa.lease]
			);
			expect(second.message).toContain('NOTICE_LEASE_NOT_IN_FORCE');
		});
	});

	it('fin de bail : unité prête → « à remettre en état », jamais disponible ; transfert de gestion : inchangée', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			expect((await api.query(`select technical_status from units where id = $1`, [wa.unit])).rows[0].technical_status).toBe('ready');
			await giveNotice(api, a.id, wa.lease, user);
			expect(await refused(`update leases set status = 'ended', ended_at = now() where id = $1`, [wa.lease])).toContain('leases_end_kind');
			await endLease(api, wa.lease);
			const u = await api.query(`select technical_status, technical_reason from units where id = $1`, [wa.unit]);
			expect(u.rows[0]).toEqual({ technical_status: 'to_refurbish', technical_reason: 'Fin de bail : à remettre en état' });
			// Déclarée prête par le gestionnaire : seule voie vers la disponibilité.
			await api.query(`update units set technical_status = 'ready', technical_reason = null where id = $1`, [wa.unit]);
			expect((await api.query(`select technical_status from units where id = $1`, [wa.unit])).rows[0].technical_status).toBe('ready');
		});
		await inContext(api, { organizationId: a.id }, async () => {
			await endLease(api, wa.lease, 'management_transfer');
			expect((await api.query(`select technical_status from units where id = $1`, [wa.unit])).rows[0].technical_status).toBe('ready');
		});
	});

	it('dernière période ramenée une fois, à la sortie seulement, à la baisse', async () => {
		const user = a.director.userId;
		const adjust = `update rent_dues set rent = 35000, charges = 2333, amount_due = 37333, period_end = '2026-12-14', prorated = true, exit_adjusted_at = now() where id = $1`;
		await inContext(api, { organizationId: a.id }, async () => {
			expect(await refused(adjust, [wa.due])).toContain('RENT_DUE_EXIT_ADJUSTMENT');
			await giveNotice(api, a.id, wa.lease, user, { exitOn: '2026-12-14' });
			expect(
				await refused(`update rent_dues set rent = 90000, amount_due = 95000, exit_adjusted_at = now() where id = $1`, [wa.due])
			).toContain('RENT_DUE_EXIT_ADJUSTMENT');
			await api.query(adjust, [wa.due]);
			expect((await api.query(`select amount_due::int, period_end::text from rent_dues where id = $1`, [wa.due])).rows[0]).toEqual({
				amount_due: 37_333,
				period_end: '2026-12-14'
			});
			expect(
				await refused(`update rent_dues set amount_due = 30000, rent = 27667, exit_adjusted_at = now() + interval '1 day' where id = $1`, [
					wa.due
				])
			).toContain('RENT_DUE_EXIT_ADJUSTMENT');
			expect(await refused(`update rent_dues set amount_due = 30000, rent = 27667 where id = $1`, [wa.due])).toContain('RENT_DUE_ISSUED');
		});
	});
});

// ---------------------------------------------------------------- transfert de gestion

describe('transfert de gestion (D16, règles 12 et 15)', () => {
	it('portée terminée, nouveau mandat possible, caution au nouveau gestionnaire nommé en texte ; rien chez une autre organisation', async () => {
		const user = a.director.userId;
		const countsOfB = async () => {
			await api.query(`select set_config('app.organization_id', $1, true)`, [b.id]);
			const out: Record<string, number> = {};
			for (const table of [
				...TABLES,
				'leases',
				'deposit_movements',
				'deposit_accounts',
				'mandates',
				'mandate_scopes',
				'tenants',
				'documents'
			]) {
				out[table] = (await api.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;
			}
			await api.query(`select set_config('app.organization_id', $1, true)`, [a.id]);
			return out;
		};
		await inContext(api, { organizationId: a.id }, async () => {
			const before = await countsOfB();
			const transfer = await insertTransfer(api, a.id, { mandateId: wa.mandate, propertyId: wa.property, unitId: wa.unit, userId: user });
			await api.query(`update mandate_scopes set ended_on = current_date, management_transfer_id = $2 where unit_id = $1`, [
				wa.unit,
				transfer
			]);
			expect((await api.query(`select management_active from mandate_scopes where unit_id = $1`, [wa.unit])).rows).toEqual([
				{ management_active: false }
			]);
			expect(
				await refused(`update mandate_scopes set ended_on = null, management_transfer_id = null where unit_id = $1`, [wa.unit])
			).toContain('MANDATE_SCOPE_ENDED');
			// Règle 12 : la portée terminée libère l'unité ; un nouveau mandat de gestion peut la couvrir.
			const next = newId();
			await api.query(
				`insert into mandates (id, organization_id, owner_id, type, starts_on, commission_basis, commission_rate_bp) values ($1, $2, $3, 'rental_management', current_date, 'percent_of_collected', 800)`,
				[next, a.id, wa.owner]
			);
			await api.query(`insert into mandate_scopes (id, organization_id, mandate_id, property_id, unit_id) values ($1, $2, $3, $4, $5)`, [
				newId(),
				a.id,
				next,
				wa.property,
				wa.unit
			]);
			// Bail terminé chez A ; caution au nouveau gestionnaire, nommé en texte seulement ; compte soldé chez A.
			await endLease(api, wa.lease, 'management_transfer');
			expect(
				await refusedBy(() =>
					insertMovement(api, a.id, wa.account, 'holder_changed', 0, {
						previousHolder: 'organization',
						newHolder: 'third_party',
						reason: 'Transfert'
					})
				)
			).toContain('deposit_movements_third_party');
			await insertMovement(api, a.id, wa.account, 'holder_changed', 0, {
				previousHolder: 'organization',
				newHolder: 'third_party',
				newHolderName: 'Agence Faso Habitat',
				managementTransferId: transfer,
				reason: 'Transfert de gestion'
			});
			expect((await api.query(`select holder, holder_name, status from deposit_accounts where id = $1`, [wa.account])).rows[0]).toEqual({
				holder: 'third_party',
				holder_name: 'Agence Faso Habitat',
				status: 'closed'
			});
			// A garde tout son historique ; aucune ligne n'apparaît chez B.
			expect((await api.query(`select count(*)::int as n from deposit_movements where account_id = $1`, [wa.account])).rows[0].n).toBe(2);
			expect(await countsOfB()).toEqual(before);
			expect((await sqlError(api, `update management_transfers set new_manager_name = 'Autre' where id = $1`, [transfer])).code).toBe(
				'42501'
			);
		});
	});

	it('seule une caution détenue par l’organisation passe au nouveau gestionnaire', async () => {
		const user = a.director.userId;
		await inContext(api, { organizationId: a.id }, async () => {
			const transfer = await insertTransfer(api, a.id, { mandateId: wa.mandate, propertyId: wa.property, userId: user });
			const guarantee = await insertDepositAccount(api, a.id, wa.lease, { type: 'utilities_guarantee', agreed: 20_000, holder: 'owner' });
			expect(
				await refusedBy(() =>
					insertMovement(api, a.id, guarantee, 'holder_changed', 0, {
						previousHolder: 'owner',
						newHolder: 'third_party',
						newHolderName: 'Agence Faso Habitat',
						managementTransferId: transfer,
						reason: 'Transfert'
					})
				)
			).toContain('DEPOSIT_HOLDER_MISMATCH');
		});
	});
});
