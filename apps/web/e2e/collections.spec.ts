/**
 * Lot 10 : relances, dépenses, relevés, éléments consommés et reversements dans le flux du vrai service PowerSync
 * (docs/SYNC.md §3).
 * - La direction et le profil lecture reçoivent les six tables.
 * - L'agent de terrain ne reçoit que les relances des locataires de ses unités : ni dépense, ni relevé, ni reversement.
 * - Jamais un jeton de lien ni la clé d'un PDF dans un flux.
 * - Une autre organisation ne reçoit rien.
 */
import { expect, test } from '@playwright/test';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { addMember, availableUnit, freshAgency, get, leaseViaApi, login, post, receivedOwn, receivedWhen, type SyncedRow } from './agency';

const today = toIsoDate();
const previousMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);

test.describe('Flux PowerSync : relances, dépenses, relevés et reversements', () => {
	test('direction et lecture : tout ; agent de terrain : ses relances seulement ; B ne reçoit rien de A', async ({ request }) => {
		const agency = await freshAgency(request, `Agence relevés ${newId().slice(-6)}`);
		const agent = await addMember(request, agency, 'field_agent', 'Agent des relances');
		const viewer = await addMember(request, agency, 'viewer', 'Comptable des relevés');
		const { unitId, propertyId } = await availableUnit(request, agency, { agentId: agent.userId });
		const { leaseId, tenantId } = await leaseViaApi(request, agency, unitId);
		const ownerId = (await get<{ ownerId: string }>(request, agency.headers, `/properties/${propertyId}`)).ownerId;
		const lease = await get<{ rentDues: { id: string }[] }>(request, agency.headers, `/leases/${leaseId}`);

		const reminderId = newId();
		await post(request, agency.headers, '/reminders', {
			id: reminderId,
			tenantId,
			rentDueIds: [lease.rentDues[0]!.id],
			channel: 'whatsapp_link',
			templateLevel: 1
		});
		const expenseId = newId();
		await post(request, agency.headers, '/expenses', {
			id: expenseId,
			propertyId,
			spentOn: today,
			category: 'painting',
			description: 'Reprise de la façade',
			amount: 20000,
			paidBy: 'organization',
			borneBy: 'owner',
			recovery: 'owner_statement'
		});
		const draft = (await post(request, agency.headers, '/owner-statements/generate', { ownerId, month: previousMonth })) as {
			id: string;
			revision: string;
		};
		await post(request, agency.headers, `/owner-statements/${draft.id}/issue`, { revision: draft.revision });
		await post(request, agency.headers, `/owner-statements/${draft.id}/share-token`, {});
		const other = await freshAgency(request, `Agence B relevés ${newId().slice(-6)}`);

		const complete = (rows: SyncedRow[]) =>
			rows.some((r) => r.table === 'reminders' && r.data.id === reminderId) &&
			rows.some((r) => r.table === 'expenses' && r.data.id === expenseId) &&
			rows.some((r) => r.table === 'owner_statements' && r.data.id === draft.id && r.data.status === 'issued');
		for (const person of [agency.director, viewer]) {
			const rows = await receivedWhen(request, await login(request, person.phone, person.password), complete);
			const statement = rows.find((r) => r.table === 'owner_statements' && r.data.id === draft.id)!;
			expect(statement.data).toMatchObject({ owner_id: ownerId, month: previousMonth, version: 1 });
			expect(statement.data).not.toHaveProperty('pdf_key');
			expect(typeof statement.data.snapshot).toBe('string');
			expect(rows.find((r) => r.table === 'reminders' && r.data.id === reminderId)?.data).toMatchObject({
				channel: 'whatsapp_link',
				tenant_id: tenantId
			});
			expect(rows.find((r) => r.table === 'expenses' && r.data.id === expenseId)?.data).toMatchObject({
				amount: 20000,
				recovery: 'owner_statement'
			});
			expect(rows.some((r) => r.table === 'owner_statement_tokens')).toBe(false);
		}

		const asAgent = await receivedWhen(request, await login(request, agent.phone, agent.password), (rows) =>
			rows.some((r) => r.table === 'reminders' && r.data.id === reminderId)
		);
		for (const table of ['expenses', 'owner_statements', 'owner_statement_lines', 'owner_payouts', 'owner_statement_tokens']) {
			expect(
				asAgent.filter((r) => r.table === table),
				table
			).toEqual([]);
		}

		const b = await receivedOwn(request, await login(request, other.director.phone, other.director.password), other.id);
		for (const table of ['reminders', 'reminder_settings', 'expenses', 'owner_statements', 'owner_statement_lines', 'owner_payouts']) {
			expect(
				b.filter((r) => r.table === table && r.data.organization_id === agency.id),
				table
			).toEqual([]);
		}
	});
});
