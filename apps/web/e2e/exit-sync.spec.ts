/**
 * Lot 10 bis, étape 2 : la sortie du locataire dans le flux du vrai service PowerSync (docs/SYNC.md §3).
 * - La direction et le profil lecture reçoivent congés, états des lieux et leurs lignes, accords, réparations, décompte
 *   et ses lignes, mouvements de caution du décompte et imputation sur caution.
 * - L'agent de terrain reçoit le congé enregistré de son bail (sans indemnité ni preuve), l'état des lieux de son unité,
 *   ses lignes et ses photos ; jamais rien de la caution : ni compte, ni mouvement, ni décompte, ni ligne, ni accord, ni
 *   réparation, ni imputation sur caution (encaissement, imputation, reçu), ni autre document.
 * - Une autre organisation ne reçoit rien.
 *
 * Les routes de la sortie viennent à l'étape 3 : les lignes sont écrites ici en SQL, dans la base de l'API de test, sous
 * la RLS de l'organisation (propriétaire du schéma), avec les règles de la migration 0019.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, test } from '@playwright/test';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import pg from 'pg';
import { addMember, availableUnit, freshAgency, get, leaseViaApi, login, post, receivedOwn, receivedWhen, type SyncedRow } from './agency';

const today = toIsoDate();
const env = parseEnv(readFileSync(join(import.meta.dirname, '../../../.env'), 'utf8'));

/** Base de l'API de test (ziga_e2e), propriétaire du schéma. */
function e2eDatabase(): pg.Client {
	const url = new URL(process.env.DATABASE_MIGRATION_URL ?? env.DATABASE_MIGRATION_URL!);
	url.pathname = '/ziga_e2e';
	return new pg.Client({ connectionString: url.toString() });
}

test.describe('Flux PowerSync : sortie du locataire', () => {
	test('direction et lecture : tout ; agent de terrain : congé et état des lieux, jamais la caution ; B ne reçoit rien de A', async ({
		request
	}) => {
		test.setTimeout(120_000);
		const agency = await freshAgency(request, `Agence sortie ${newId().slice(-6)}`);
		const agent = await addMember(request, agency, 'field_agent', 'Agent des états des lieux');
		const viewer = await addMember(request, agency, 'viewer', 'Lecture des sorties');
		const director = (await get<{ id: string }>(request, { Authorization: agency.headers.Authorization! }, '/me')).id;
		const { unitId } = await availableUnit(request, agency, { agentId: agent.userId });
		const { leaseId } = await leaseViaApi(request, agency, unitId);
		const lease = await get<{ rentDues: { id: string; amountDue: number }[]; deposits: { id: string }[] }>(
			request,
			agency.headers,
			`/leases/${leaseId}`
		);
		const accountId = lease.deposits[0]!.id;
		const receiptId = newId();
		await post(request, agency.headers, '/payments', {
			payments: [
				{
					id: newId(),
					leaseId,
					purpose: 'deposit',
					depositAccountId: accountId,
					amount: 150000,
					method: 'cash',
					paidOn: today,
					receiptId,
					provisionalNumber: provisionalReceiptNumber(receiptId),
					verificationToken: newReceiptToken(),
					shareToken: newReceiptToken()
				}
			]
		});
		const due = lease.rentDues[0]!;

		// La sortie, en SQL (étape 2) : congé et préavis, état des lieux de sortie et sa photo, réparation au devis,
		// accord, décompte proposé, échéance payée par la caution (encaissement interne, imputation, mouvement, reçu).
		const ids = {
			notice: newId(),
			inspection: newId(),
			item: newId(),
			photo: newId(),
			quote: newId(),
			repair: newId(),
			agreement: newId(),
			settlement: newId(),
			line: newId(),
			offset: newId(),
			movement: newId(),
			receipt: newId()
		};
		const db = e2eDatabase();
		await db.connect();
		try {
			await db.query('BEGIN');
			await db.query(`select set_config('app.organization_id', $1, true)`, [agency.id]);
			const exitOn = addDays(today, 90);
			await db.query(
				`insert into lease_notices (id, organization_id, lease_id, origin, status, delivery_mode, notified_on, planned_exit_on, notice_months,
					notice_ends_on, rent_ends_on, early_termination_indemnity, recorded_at, recorded_by)
				 values ($1, $2, $3, 'tenant', 'recorded', 'hand_delivery', $4, $5, 3, $5, $5, 75000, now(), $6)`,
				[ids.notice, agency.id, leaseId, today, exitOn, director]
			);
			await db.query(`update leases set status = 'notice', notice_given_on = $2, exit_on = $3 where id = $1`, [leaseId, today, exitOn]);
			await db.query(
				`insert into inspections (id, organization_id, lease_id, type, inspected_on, performed_by) values ($1, $2, $3, 'exit', $4, $5)`,
				[ids.inspection, agency.id, leaseId, today, agent.userId]
			);
			await db.query(
				`insert into inspection_items (id, organization_id, inspection_id, room, element, description, finding)
				 values ($1, $2, $3, 'Douche et WC', 'shower', 'Pommeau de douche arraché, carrelage fendu', 'tenant_damage')`,
				[ids.item, agency.id, ids.inspection]
			);
			for (const [id, type, item] of [
				[ids.photo, 'inspection_photo', ids.item],
				[ids.quote, 'repair_quote', null]
			] as const) {
				await db.query(
					`insert into documents (id, organization_id, type, lease_id, inspection_id, inspection_item_id, file_name, mime_type, byte_size,
						storage_key, uploaded_by)
					 values ($1, $2, $3, $4, $5, $6, 'piece.jpg', 'image/jpeg', 1000, $7, $8)`,
					[
						id,
						agency.id,
						type,
						leaseId,
						type === 'inspection_photo' ? ids.inspection : null,
						item,
						`documents/${agency.id}/${id}`,
						director
					]
				);
			}
			await db.query(
				`insert into repairs (id, organization_id, inspection_item_id, lease_id, description, performed_by, estimated_amount, quote_document_id)
				 values ($1, $2, $3, $4, 'Remplacer le pommeau', 'organization', 10000, $5)`,
				[ids.repair, agency.id, ids.item, leaseId, ids.quote]
			);
			await db.query(
				`insert into agreements (id, organization_id, lease_id, type, proposed_by, proposed_on) values ($1, $2, $3, 'tenant_self_repair', 'tenant', $4)`,
				[ids.agreement, agency.id, leaseId, today]
			);
			const owed = due.amountDue;
			await db.query(
				`insert into deposit_settlements (id, organization_id, deposit_account_id, lease_id, exit_on, refund_deadline, received, deductions,
					covered_by_deposit, refund, refund_from_deposit, outcome)
				 values ($1, $2, $3, $4, $5, $5::date + 30, 150000, $6, $6, $7, $7, 'refund')`,
				[ids.settlement, agency.id, accountId, leaseId, exitOn, 10000 + owed, 150000 - 10000 - owed]
			);
			await db.query(
				`insert into deposit_settlement_lines (id, organization_id, settlement_id, revision, kind, amount, covered, uncovered, inspection_item_id,
					repair_id, document_id)
				 values ($1, $2, $3, 1, 'repair', 10000, 10000, 0, $4, $5, $6)`,
				[ids.line, agency.id, ids.settlement, ids.item, ids.repair, ids.quote]
			);
			await db.query(`update deposit_settlements set status = 'proposed', proposed_at = now() where id = $1`, [ids.settlement]);
			await db.query(
				`insert into payments (id, organization_id, lease_id, purpose, amount, method, paid_on, status, idempotency_key, confirmed_at, confirmed_by)
				 values ($1, $2, $3, 'rent', $4, 'deposit_offset', $5, 'confirmed', $6, now(), $7)`,
				[ids.offset, agency.id, leaseId, owed, today, `settlement:${ids.settlement}:${due.id}`, director]
			);
			await db.query(
				`insert into payment_allocations (id, organization_id, payment_id, lease_id, target, rent_due_id, direction, amount)
				 values ($1, $2, $3, $4, 'rent_due', $5, 'allocate', $6)`,
				[newId(), agency.id, ids.offset, leaseId, due.id, owed]
			);
			await db.query(
				`insert into deposit_movements (id, organization_id, account_id, type, amount, occurred_on, settlement_id, rent_due_id, payment_id)
				 values ($1, $2, $3, 'applied_to_debt', $4, $5, $6, $7, $8)`,
				[ids.movement, agency.id, accountId, owed, today, ids.settlement, due.id, ids.offset]
			);
			await db.query(`insert into receipts (id, organization_id, payment_id, provisional_number) values ($1, $2, $3, $4)`, [
				ids.receipt,
				agency.id,
				ids.offset,
				provisionalReceiptNumber(ids.receipt)
			]);
			await db.query('COMMIT');
		} catch (error) {
			await db.query('ROLLBACK');
			throw error;
		} finally {
			await db.end();
		}
		const other = await freshAgency(request, `Agence B sortie ${newId().slice(-6)}`);

		const complete = (rows: SyncedRow[]) =>
			rows.some((r) => r.table === 'deposit_settlement_lines' && r.data.id === ids.line) &&
			rows.some((r) => r.table === 'deposit_movements' && r.data.id === ids.movement) &&
			rows.some((r) => r.table === 'receipts' && r.data.id === ids.receipt);
		for (const person of [agency.director, viewer]) {
			const rows = await receivedWhen(request, await login(request, person.phone, person.password), complete, 30_000);
			const has = (table: string, id: string) => rows.some((r) => r.table === table && r.data.id === id);
			for (const [table, id] of [
				['lease_notices', ids.notice],
				['inspections', ids.inspection],
				['inspection_items', ids.item],
				['repairs', ids.repair],
				['agreements', ids.agreement],
				['deposit_settlements', ids.settlement],
				['payments', ids.offset]
			] as const) {
				expect(has(table, id), table).toBe(true);
			}
			expect(rows.find((r) => r.table === 'deposit_settlements' && r.data.id === ids.settlement)?.data).toMatchObject({
				status: 'proposed',
				received: 150000,
				refund: 150000 - 10000 - due.amountDue
			});
			expect(rows.find((r) => r.table === 'deposit_movements' && r.data.id === ids.movement)?.data).toMatchObject({
				type: 'applied_to_debt',
				rent_due_id: due.id,
				payment_id: ids.offset,
				settlement_id: ids.settlement
			});
			expect(rows.find((r) => r.table === 'receipts' && r.data.id === ids.receipt)?.data).toMatchObject({ source: 'deposit' });
		}

		const asAgent = await receivedWhen(
			request,
			await login(request, agent.phone, agent.password),
			(rows) =>
				rows.some((r) => r.table === 'inspection_items' && r.data.id === ids.item) &&
				rows.some((r) => r.table === 'rent_dues' && r.data.id === due.id),
			30_000
		);
		const notice = asAgent.find((r) => r.table === 'lease_notices' && r.data.id === ids.notice)!;
		expect(notice.data).toMatchObject({ status: 'recorded', planned_exit_on: addDays(today, 90) });
		expect(notice.data).not.toHaveProperty('early_termination_indemnity');
		expect(notice.data).not.toHaveProperty('proof_document_id');
		expect(asAgent.some((r) => r.table === 'inspections' && r.data.id === ids.inspection)).toBe(true);
		expect(asAgent.filter((r) => r.table === 'documents').map((r) => r.data.id)).toEqual([ids.photo]);
		for (const table of [
			'deposit_accounts',
			'deposit_movements',
			'deposit_settlements',
			'deposit_settlement_lines',
			'agreements',
			'repairs'
		]) {
			expect(
				asAgent.filter((r) => r.table === table),
				table
			).toEqual([]);
		}
		expect(asAgent.filter((r) => r.table === 'payments' && (r.data.method === 'deposit_offset' || r.data.purpose === 'deposit'))).toEqual(
			[]
		);
		expect(asAgent.filter((r) => r.table === 'payment_allocations' && r.data.source === 'deposit')).toEqual([]);
		expect(asAgent.filter((r) => r.table === 'receipts' && (r.data.source === 'deposit' || r.data.id === ids.receipt))).toEqual([]);
		// L'échéance réglée par la caution descend (elle est payée), sans dire comment.
		expect(asAgent.find((r) => r.table === 'rent_dues' && r.data.id === due.id)?.data).toMatchObject({ amount_paid: due.amountDue });

		const b = await receivedOwn(request, await login(request, other.director.phone, other.director.password), other.id);
		for (const table of [
			'lease_notices',
			'inspections',
			'inspection_items',
			'inspection_catalog_entries',
			'agreements',
			'repairs',
			'deposit_settlements',
			'deposit_settlement_lines',
			'management_transfers',
			'deposit_movements',
			'documents'
		]) {
			expect(
				b.filter((r) => r.table === table && r.data.organization_id === agency.id),
				table
			).toEqual([]);
		}
	});
});
