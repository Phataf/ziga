/**
 * Lot 09 : encaissements, imputations et reçus dans le flux du vrai service PowerSync (docs/SYNC.md §3).
 * - La direction et le profil lecture reçoivent les encaissements, les imputations et les reçus, cautions comprises.
 * - L'agent de terrain ne reçoit que les loyers de ses unités : jamais un versement de caution, ni son imputation, ni
 *   son reçu.
 * - Jamais un jeton de reçu, un compteur ni une clé de PDF dans un flux.
 * - Une autre organisation ne reçoit rien.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import {
	addMember,
	availableUnit,
	freshAgency,
	get,
	leaseViaApi,
	login,
	post,
	receivedOwn,
	receivedWhen,
	type Agency,
	type SyncedRow
} from './agency';

const today = toIsoDate();

function entry(leaseId: string, extra: Record<string, unknown> = {}) {
	const receiptId = newId();
	return {
		id: newId(),
		leaseId,
		purpose: 'rent',
		amount: 80000,
		method: 'cash',
		paidOn: today,
		receiptId,
		provisionalNumber: provisionalReceiptNumber(receiptId),
		verificationToken: newReceiptToken(),
		shareToken: newReceiptToken(),
		...extra
	};
}

async function pay(request: APIRequestContext, headers: Record<string, string>, e: ReturnType<typeof entry>) {
	return post(request, headers, '/payments', { payments: [e] });
}

test.describe('Flux PowerSync : encaissements, imputations et reçus', () => {
	test('direction et lecture : tout ; agent de terrain : les loyers de ses unités, jamais une caution ; B ne reçoit rien de A', async ({
		request
	}) => {
		const agency: Agency = await freshAgency(request, `Agence encaissements ${newId().slice(-6)}`);
		const agent = await addMember(request, agency, 'field_agent', 'Agent des encaissements');
		const viewer = await addMember(request, agency, 'viewer', 'Comptable des encaissements');
		const { unitId } = await availableUnit(request, agency, { agentId: agent.userId });
		const { leaseId } = await leaseViaApi(request, agency, unitId);
		const lease = await get<{ deposits: { id: string }[] }>(request, agency.headers, `/leases/${leaseId}`);
		const rent = entry(leaseId);
		const deposit = entry(leaseId, { purpose: 'deposit', depositAccountId: lease.deposits[0]!.id, amount: 50000 });
		await pay(request, agency.headers, rent);
		await pay(request, agency.headers, deposit);
		const cash = entry(leaseId, { amount: 10000 });
		await pay(request, agent.headers, cash);
		const other = await freshAgency(request, `Agence B encaissements ${newId().slice(-6)}`);

		const complete = (rows: SyncedRow[]) =>
			[rent.id, deposit.id, cash.id].every((id) => rows.some((r) => r.table === 'payments' && r.data.id === id)) &&
			rows.some((r) => r.table === 'receipts' && r.data.payment_id === deposit.id && r.data.status === 'valid') &&
			rows.some((r) => r.table === 'payment_allocations' && r.data.payment_id === deposit.id);
		for (const person of [agency.director, viewer]) {
			const rows = await receivedWhen(request, await login(request, person.phone, person.password), complete);
			const receipt = rows.find((r) => r.table === 'receipts' && r.data.payment_id === rent.id)!;
			expect(receipt.data).toMatchObject({
				status: 'valid',
				purpose: 'rent',
				lease_id: leaseId,
				number: expect.stringMatching(/-\d{4}-\d{6}$/)
			});
			expect(typeof receipt.data.snapshot).toBe('string');
			expect(rows.find((r) => r.table === 'payments' && r.data.id === cash.id)?.data).toMatchObject({
				status: 'to_validate',
				amount: 10000
			});
			expect(rows.find((r) => r.table === 'organizations' && r.data.id === agency.id)?.data).toMatchObject({ receipt_ticket_width: 80 });
		}

		const asAgent = await receivedWhen(
			request,
			await login(request, agent.phone, agent.password),
			(rows) =>
				rows.some((r) => r.table === 'payments' && r.data.id === rent.id) &&
				rows.some((r) => r.table === 'payments' && r.data.id === cash.id) &&
				rows.some((r) => r.table === 'receipts' && r.data.payment_id === rent.id)
		);
		expect(asAgent.some((r) => r.table === 'payments' && r.data.id === deposit.id)).toBe(false);
		expect(asAgent.some((r) => r.table === 'receipts' && r.data.payment_id === deposit.id)).toBe(false);
		expect(asAgent.some((r) => r.table === 'payment_allocations' && r.data.target === 'deposit_account')).toBe(false);
		expect(asAgent.some((r) => r.table === 'payment_allocations' && r.data.payment_id === rent.id)).toBe(true);

		// Jamais un jeton, un compteur ni une clé de PDF.
		for (const r of asAgent.filter((x) => x.table === 'receipts')) {
			for (const column of ['verification_token', 'share_token', 'token_hash', 'pdf_a6_key', 'pdf_ticket_key'])
				expect(r.data, column).not.toHaveProperty(column);
		}
		expect(asAgent.some((r) => r.table === 'receipt_tokens' || r.table === 'receipt_counters')).toBe(false);

		const b = await receivedOwn(request, await login(request, other.director.phone, other.director.password), other.id);
		for (const table of ['payments', 'payment_allocations', 'receipts']) {
			expect(
				b.filter((r) => r.table === table && r.data.organization_id === agency.id),
				table
			).toEqual([]);
		}
	});
});
