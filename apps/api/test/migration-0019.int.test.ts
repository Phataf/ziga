/**
 * Lot 10 bis : la migration 0019 s'applique sur une base du lot 10 déjà remplie (CLAUDE.md §7). Base jetable migrée
 * jusqu'à 0018, avec un bail en vigueur, son échéance, un loyer encaissé, son imputation et son reçu, une caution reçue
 * par un encaissement, une dépense réclamée au locataire, une relance, un relevé émis. Après migration : tout est intact
 * (provenance `tenant`, détenteur inchangé) ; la sortie complète s'enregistre (congé, préavis, fin de bail et remise en
 * état, état des lieux, réparation, décompte clos) ; migrations rejouées sans doublon.
 */
import { rmSync } from 'node:fs';
import { newId } from '@ziga/shared/ids';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { insertExpense, insertReminder, insertStatement, issueStatement } from './collections.js';
import {
	endLease,
	giveNotice,
	insertDocument,
	insertInspection,
	insertItem,
	insertRepair,
	insertSettlement,
	insertSettlementLine,
	setSettlementStatus,
	signInspection
} from './exit.js';
import { insertDepositAccount, insertDue, insertLease, insertMovement, insertTenant } from './leases.js';
import { foldersUpTo, inOrganization, scratchUrl, serverUrl, withClient } from './migrations.js';
import { allocate, insertPayment, insertReceipt, receiveDeposit, validateReceipt } from './payments.js';
import { propertyWithUnit } from './properties.js';

const SCRATCH = 'ziga_lot10_for_0019_test';
const scratch = () => scratchUrl(SCRATCH);

describe('migration 0019 sur une base du lot 10', () => {
	const agency = newId();
	const user = newId();
	const ownerId = newId();
	let property: string;
	let unit: string;
	let tenant: string;
	let lease: string;
	let due: string;
	let payment: string;
	let receipt: string;
	let account: string;
	let claim: string;

	beforeAll(async () => {
		await withClient(serverUrl(), async (c) => {
			await c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
			await c.query(`CREATE DATABASE ${SCRATCH}`);
		});
		const folder = foldersUpTo('0018_statement_organizations');
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: folder }));
		rmSync(folder, { recursive: true, force: true });
		await withClient(scratch(), async (c) => {
			await c.query(`insert into users (id, phone, name, password_hash, status) values ($1, '+22670555191', 'Directrice', 'x', 'active')`, [
				user
			]);
			await inOrganization(c, agency, () =>
				c.query(
					`insert into organizations (id, type, legal_name, phone, commune, created_by, receipt_prefix) values ($1, 'agency', 'Agence du lot 10', '+22625300191', 'Ouagadougou', $2, 'AGM')`,
					[agency, user]
				)
			);
			await inOrganization(c, agency, async () => {
				await c.query(
					`insert into organization_members (id, organization_id, user_id, role, status) values ($1, $2, $3, 'director', 'active')`,
					[newId(), agency, user]
				);
				await c.query(
					`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', 'Propriétaire', '+22670555193')`,
					[ownerId, agency]
				);
				({ property, unit } = await propertyWithUnit(c, agency, ownerId));
				tenant = await insertTenant(c, agency);
				lease = await insertLease(c, agency, unit, tenant);
				await insertDue(c, agency, lease, '2026-12-01', { status: 'due' });
				due = (await c.query(`select id from rent_dues where lease_id = $1`, [lease])).rows[0].id as string;
				payment = await insertPayment(c, agency, lease, { amount: 40_000, confirmedBy: user, paidOn: '2026-12-04' });
				await allocate(c, agency, payment, lease, [{ target: 'rent_due', rentDueId: due, amount: 40_000 }]);
				receipt = await insertReceipt(c, agency, payment);
				await validateReceipt(c, agency, receipt, '2026-12-04');
				account = await insertDepositAccount(c, agency, lease, { agreed: 100_000 });
				await receiveDeposit(c, agency, account, 100_000);
				claim = await insertExpense(c, agency, {
					propertyId: property,
					unitId: unit,
					leaseId: lease,
					borneBy: 'tenant',
					recovery: 'claimed_from_tenant'
				});
				await insertReminder(c, agency, tenant, { dueIds: [due] });
				const statement = await insertStatement(c, agency, ownerId, '2026-10');
				await issueStatement(c, agency, statement, user);
			});
		});
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
	}, 120_000);
	afterAll(async () => {
		await withClient(serverUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
	});

	it('les données du lot 10 sont intactes : provenance « locataire », détenteur et statut de la caution inchangés', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					expect((await c.query(`select method, status, amount::int from payments where id = $1`, [payment])).rows).toEqual([
						{ method: 'cash', status: 'confirmed', amount: 40_000 }
					]);
					expect((await c.query(`select distinct source from payment_allocations`)).rows).toEqual([{ source: 'tenant' }]);
					expect((await c.query(`select source, number from receipts where id = $1`, [receipt])).rows).toEqual([
						{ source: 'tenant', number: 'AGM-2026-000001' }
					]);
					expect((await c.query(`select holder, holder_name, status from deposit_accounts where id = $1`, [account])).rows).toEqual([
						{ holder: 'organization', holder_name: null, status: 'held' }
					]);
					expect((await c.query(`select type, amount::int from deposit_movements where account_id = $1`, [account])).rows).toEqual([
						{ type: 'received', amount: 100_000 }
					]);
					expect(
						(
							await c.query(
								`select l.status, l.end_kind, d.exit_adjusted_at from leases l join rent_dues d on d.lease_id = l.id where l.id = $1`,
								[lease]
							)
						).rows
					).toEqual([{ status: 'active', end_kind: null, exit_adjusted_at: null }]);
					expect((await c.query(`select ended_on, management_active from mandate_scopes`)).rows).toEqual([]);
				},
				false
			)
		);
	});

	it('la sortie complète s’enregistre : préavis, fin de bail et remise en état, état des lieux, retenue, décompte clos', async () => {
		await withClient(scratch(), (c) =>
			inOrganization(
				c,
				agency,
				async () => {
					await giveNotice(c, agency, lease, user);
					await endLease(c, lease);
					expect((await c.query(`select technical_status from units where id = $1`, [unit])).rows[0].technical_status).toBe('to_refurbish');
					const insp = await insertInspection(c, agency, lease, user);
					const item = await insertItem(c, agency, insp);
					await signInspection(c, insp, user);
					const quote = await insertDocument(c, agency, user, { type: 'repair_quote', leaseId: lease });
					const repair = await insertRepair(c, agency, item, { amount: 10_000, quoteDocumentId: quote });
					const s = await insertSettlement(c, agency, account, {
						received: 100_000,
						deductions: 10_000,
						coveredByDeposit: 10_000,
						refund: 90_000,
						refundFromDeposit: 90_000,
						outcome: 'refund'
					});
					await insertSettlementLine(c, agency, s, {
						kind: 'repair',
						amount: 10_000,
						inspectionItemId: item,
						repairId: repair,
						documentId: quote
					});
					await setSettlementStatus(c, s, 'proposed');
					await setSettlementStatus(c, s, 'accepted');
					await insertMovement(c, agency, account, 'retained', 10_000, {
						settlementId: s,
						inspectionItemId: item,
						documentId: quote,
						repairId: repair
					});
					await insertMovement(c, agency, account, 'refunded', 90_000, { settlementId: s });
					await setSettlementStatus(c, s, 'closed', user);
					expect((await c.query(`select status from deposit_accounts where id = $1`, [account])).rows[0].status).toBe('closed');
					// La dépense du lot 10 reste réclamable (rien ne l'a touchée).
					expect((await c.query(`select recovery, status from expenses where id = $1`, [claim])).rows).toEqual([
						{ recovery: 'claimed_from_tenant', status: 'recorded' }
					]);
				},
				false
			)
		);
	});

	it('les migrations se rejouent sans erreur ni doublon ; les neuf tables sont publiées', async () => {
		await withClient(scratch(), (c) => migrate(drizzle(c), { migrationsFolder: MIGRATIONS_FOLDER }));
		const tables = await withClient(scratch(), (c) =>
			c.query(
				`select count(*)::int as n from pg_publication_tables where pubname = 'powersync' and tablename in ('lease_notices', 'inspections',
					'inspection_items', 'inspection_catalog_entries', 'agreements', 'repairs', 'deposit_settlements', 'deposit_settlement_lines',
					'management_transfers')`
			)
		);
		expect(tables.rows[0].n).toBe(9);
	});
});
