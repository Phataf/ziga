/**
 * Sortie du locataire (lot 10 bis) en fonctions pures : préavis et dernier mois (D32), fin de bail et remise en état
 * (D14), état des lieux (« bon état » seul refusé), réparations, circuit d'accord, transfert de gestion (D16, règle 15).
 */
import { describe, expect, it } from 'vitest';
import { generateRentSchedule, type RentScheduleInput } from './rent-schedule.js';
import { isAvailable } from './properties.js';
import {
	agreementDecisionBlocker,
	agreementProposalBlocker,
	canTransitionInspection,
	compareInspections,
	DEFAULT_TENANT_REPAIRS,
	exitDueAdjustments,
	inspectionDescriptionBlocker,
	inspectionItemBlocker,
	inspectionSignedByBoth,
	leaseEndDue,
	managementTransferBlocker,
	managementTransferPlan,
	noticeBlocker,
	noticeChangesLease,
	noticeTerms,
	repairTransitionBlocker,
	technicalStatusAfterLeaseEnd,
	tenantRepairHints,
	type ExistingDue,
	type ManagementTransferInput,
	type NoticeLeaseTerms
} from './tenant-exit.js';

const lease = (extra: Partial<NoticeLeaseTerms> = {}): NoticeLeaseTerms => ({
	status: 'active',
	endsOn: null,
	rent: 75_000,
	noticeTenantFixedTermMonths: 2,
	noticeTenantOpenEndedMonths: 3,
	noticeLessorFixedTermMonths: 3,
	noticeLessorOpenEndedMonths: 3,
	reducedNoticeMonths: null,
	earlyTerminationIndemnityMonths: null,
	...extra
});
const TODAY = '2027-04-15';
const notice = (extra: Partial<Parameters<typeof noticeTerms>[1]> = {}) => ({
	origin: 'tenant' as const,
	notifiedOn: '2027-03-15',
	plannedExitOn: '2027-06-14',
	reducedNotice: false,
	today: TODAY,
	...extra
});

describe('préavis (D24, D32)', () => {
	it('délai du bail : 3 mois en durée indéterminée, 2 en durée déterminée ; fin la veille du même jour', () => {
		expect(noticeTerms(lease(), notice())).toMatchObject({ months: 3, noticeEndsOn: '2027-06-14', rentEndsOn: '2027-06-14' });
		expect(noticeTerms(lease({ endsOn: '2028-01-31' }), notice())).toMatchObject({ months: 2, noticeEndsOn: '2027-05-14' });
	});

	it('départ anticipé : loyer dû jusqu’à la fin du préavis, sauf préavis réduit ; indemnité prévue au bail', () => {
		expect(noticeTerms(lease(), notice({ plannedExitOn: '2027-04-30' })).rentEndsOn).toBe('2027-06-14');
		const reduced = lease({ reducedNoticeMonths: 1 });
		expect(noticeTerms(reduced, notice({ plannedExitOn: '2027-04-30', reducedNotice: true }))).toMatchObject({
			months: 1,
			noticeEndsOn: '2027-04-14',
			rentEndsOn: '2027-04-30'
		});
		const fixed = lease({ endsOn: '2027-12-31', earlyTerminationIndemnityMonths: 1 });
		expect(noticeTerms(fixed, notice()).earlyTerminationIndemnity).toBe(75_000);
		expect(noticeTerms({ ...fixed, earlyTerminationIndemnityMonths: null }, notice()).earlyTerminationIndemnity).toBe(0);
		// Au terme du bail, ou congé du bailleur : pas d'indemnité.
		expect(noticeTerms(fixed, notice({ plannedExitOn: '2027-12-31' })).earlyTerminationIndemnity).toBe(0);
		expect(noticeTerms(fixed, notice({ origin: 'lessor', plannedExitOn: '2027-07-31' })).earlyTerminationIndemnity).toBe(0);
	});

	it('refus : bail pas en vigueur, dates incohérentes, préavis réduit absent du bail, congé du bailleur trop court', () => {
		expect(noticeBlocker(lease(), notice())).toBeNull();
		expect(noticeBlocker(lease({ status: 'notice' }), notice())).toBe('NOTICE_LEASE_NOT_IN_FORCE');
		expect(noticeBlocker(lease(), notice({ notifiedOn: '2027-04-16' }))).toBe('NOTICE_DATE_IN_FUTURE');
		expect(noticeBlocker(lease(), notice({ plannedExitOn: '2027-03-01' }))).toBe('NOTICE_EXIT_BEFORE_NOTIFICATION');
		expect(noticeBlocker(lease(), notice({ reducedNotice: true }))).toBe('NOTICE_REDUCED_NOT_IN_LEASE');
		expect(noticeBlocker(lease({ reducedNoticeMonths: 1 }), notice({ origin: 'lessor', reducedNotice: true }))).toBe(
			'NOTICE_REDUCED_LESSOR'
		);
		expect(noticeBlocker(lease(), notice({ origin: 'lessor', plannedExitOn: '2027-06-13' }))).toBe('NOTICE_LESSOR_TOO_SHORT');
		expect(noticeBlocker(lease(), notice({ origin: 'lessor', plannedExitOn: '2027-06-14' }))).toBeNull();
	});

	it('une demande du locataire n’est jamais un congé : seul un congé enregistré met le bail en préavis', () => {
		expect(noticeChangesLease('requested')).toBe(false);
		expect(noticeChangesLease('declined')).toBe(false);
		expect(noticeChangesLease('recorded')).toBe(true);
	});
});

describe('dernières échéances : dernier mois au prorata, suivantes abandonnées (D32)', () => {
	const base: RentScheduleInput = {
		billingMode: 'calendar_prorata',
		periodicity: 'monthly',
		startOn: '2027-01-01',
		endOn: '2027-12-31',
		duesStartOn: '2027-01-01',
		dueDay: 5,
		advanceMonths: 0,
		activatedOn: '2027-01-01',
		rates: [{ effectiveFrom: '2027-01-01', rent: 75_000, charges: 5_000, version: 1 }],
		until: '2027-12-31'
	};
	const existing = (input: RentScheduleInput, paid: Record<string, number> = {}): ExistingDue[] =>
		generateRentSchedule(input).map((d) => ({
			id: d.periodStart,
			periodStart: d.periodStart,
			periodEnd: d.periodEnd,
			status: d.periodStart <= '2027-06-01' ? 'due' : 'upcoming',
			amountPaid: paid[d.periodStart] ?? 0,
			rent: d.rent,
			charges: d.charges,
			amountDue: d.amountDue,
			leaseVersion: d.leaseVersion
		}));

	it('calendrier au prorata : sortie le 14 juin → juin au prorata (14 jours sur 30), juillet à décembre abandonnés', () => {
		const regenerated = generateRentSchedule({ ...base, endOn: '2027-06-14', until: '2027-06-14' });
		const adj = exitDueAdjustments(existing(base), regenerated, '2027-06-14');
		expect(adj.filter((a) => a.action === 'waive').map((a) => a.periodStart)).toEqual([
			'2027-07-01',
			'2027-08-01',
			'2027-09-01',
			'2027-10-01',
			'2027-11-01',
			'2027-12-01'
		]);
		expect(adj.find((a) => a.action === 'prorate')).toMatchObject({
			periodStart: '2027-06-01',
			periodEnd: '2027-06-14',
			rent: 35_000,
			charges: 2_333,
			amountDue: 37_333,
			excessPaid: 0
		});
	});

	it('déjà payé au-delà (juin payé en entier, juillet payé d’avance) : le surplus revient au crédit du bail', () => {
		const regenerated = generateRentSchedule({ ...base, endOn: '2027-06-14', until: '2027-06-14' });
		const adj = exitDueAdjustments(existing(base, { '2027-06-01': 80_000, '2027-07-01': 80_000 }), regenerated, '2027-06-14');
		expect(adj.find((a) => a.periodStart === '2027-06-01')!.excessPaid).toBe(80_000 - 37_333);
		expect(adj.find((a) => a.periodStart === '2027-07-01')).toMatchObject({ action: 'waive', excessPaid: 80_000 });
	});

	it('sortie en fin de mois : rien à proratiser ; mode anniversaire : la dernière période écourtée reste due en entier', () => {
		const regenerated = generateRentSchedule({ ...base, endOn: '2027-06-30', until: '2027-06-30' });
		expect(exitDueAdjustments(existing(base), regenerated, '2027-06-30').every((a) => a.action === 'waive')).toBe(true);
		const anniversary = {
			...base,
			billingMode: 'anniversary' as const,
			startOn: '2027-01-10',
			duesStartOn: '2027-01-10',
			activatedOn: '2027-01-10'
		};
		const adj = exitDueAdjustments(
			existing(anniversary),
			generateRentSchedule({ ...anniversary, endOn: '2027-06-20', until: '2027-06-20' }),
			'2027-06-20'
		);
		expect(adj.find((a) => a.periodStart === '2027-06-10')).toMatchObject({
			action: 'prorate',
			amountDue: 80_000,
			periodEnd: '2027-06-20'
		});
	});
});

describe('fin de bail et remise en état (D14, règle 13)', () => {
	it('le bail se termine à la date de sortie, pas avant', () => {
		expect(leaseEndDue({ status: 'notice', exitOn: '2027-06-30' }, '2027-06-29')).toBe(false);
		expect(leaseEndDue({ status: 'notice', exitOn: '2027-06-30' }, '2027-06-30')).toBe(true);
		expect(leaseEndDue({ status: 'active', exitOn: null }, '2027-06-30')).toBe(false);
	});

	it('une unité prête passe à remettre en état ; elle n’est jamais disponible avant d’être déclarée prête', () => {
		for (const current of ['ready', 'to_refurbish', 'under_works', 'unavailable'] as const) {
			const after = technicalStatusAfterLeaseEnd(current, 'tenant_exit');
			expect(after).not.toBe('ready');
			expect(isAvailable({ recordStatus: 'active', occupancy: 'free', technicalStatus: after })).toBe(false);
		}
		expect(technicalStatusAfterLeaseEnd('ready', 'tenant_exit')).toBe('to_refurbish');
		expect(isAvailable({ recordStatus: 'active', occupancy: 'free', technicalStatus: 'ready' })).toBe(true);
		// Transfert de gestion : le locataire reste, l'état technique ne change pas.
		expect(technicalStatusAfterLeaseEnd('ready', 'management_transfer')).toBe('ready');
	});
});

describe('état des lieux (article 9)', () => {
	it('« bon état » seul est refusé, sous toutes ses formes ; une description précise est admise', () => {
		for (const vague of ['bon état', 'Bon état.', 'BON ETAT', 'en bon état', 'RAS', 'Bon état général, RAS', 'ok', 'Neuf !']) {
			expect(inspectionDescriptionBlocker(vague), vague).toBe('INSPECTION_DESCRIPTION_VAGUE');
		}
		expect(inspectionDescriptionBlocker('fissuré')).toBe('INSPECTION_DESCRIPTION_TOO_SHORT');
		expect(inspectionDescriptionBlocker('Bon état, peinture blanche sans trace')).toBeNull();
		expect(inspectionDescriptionBlocker('Porte en bois, serrure à deux clés, fonctionne')).toBeNull();
	});

	it('à la sortie, un constat par élément ; à l’entrée, aucun', () => {
		const d = 'Vitre de la fenêtre fendue sur 20 cm';
		expect(inspectionItemBlocker('exit', { description: d, finding: null })).toBe('INSPECTION_FINDING_REQUIRED');
		expect(inspectionItemBlocker('exit', { description: d, finding: 'tenant_damage' })).toBeNull();
		expect(inspectionItemBlocker('entry', { description: d, finding: 'normal_wear' })).toBe('INSPECTION_FINDING_ON_ENTRY');
		expect(inspectionItemBlocker('entry', { description: 'bon état', finding: null })).toBe('INSPECTION_DESCRIPTION_VAGUE');
	});

	it('signé des deux parties : scan déposé, ou case cochée par chacune ; un état signé ne change plus', () => {
		expect(inspectionSignedByBoth({ organizationSignedAt: 'x', tenantSignedAt: null, scanDocumentId: null })).toBe(false);
		expect(inspectionSignedByBoth({ organizationSignedAt: 'x', tenantSignedAt: 'y', scanDocumentId: null })).toBe(true);
		expect(inspectionSignedByBoth({ organizationSignedAt: null, tenantSignedAt: null, scanDocumentId: 'scan' })).toBe(true);
		expect(canTransitionInspection('draft', 'disputed')).toBe(true);
		expect(canTransitionInspection('disputed', 'signed_both')).toBe(true);
		expect(canTransitionInspection('signed_both', 'draft')).toBe(false);
		expect(canTransitionInspection('signed_both', 'disputed')).toBe(false);
	});

	it('comparaison entrée et sortie, élément par élément, sans tenir compte des accents ni de la casse', () => {
		const item = (id: string, room: string, element: string) => ({ id, room, element, description: '…', finding: null });
		const rows = compareInspections(
			[item('e1', 'Salon', 'door'), item('e2', 'Cuisine', 'taps'), item('e3', 'Cour', 'door')],
			[item('x1', 'Cuisine', 'taps'), item('x2', 'salon', 'door'), item('x3', 'Chambre', 'windows')]
		);
		expect(rows.map((r) => [r.entry?.id ?? null, r.exit?.id ?? null])).toEqual([
			['e2', 'x1'],
			['e1', 'x2'],
			[null, 'x3'],
			['e3', null]
		]);
	});

	it('la liste des réparations du locataire guide le constat, elle ne le décide pas', () => {
		expect(DEFAULT_TENANT_REPAIRS).toHaveLength(7);
		expect(tenantRepairHints('windows').map((h) => h.key)).toEqual(['broken_glass']);
		expect(tenantRepairHints('door').map((h) => h.key)).toEqual(['keys_locks', 'doors_cupboards']);
		expect(tenantRepairHints('floor')).toEqual([]);
		// Une liste modifiée par l'organisation remplace celle par défaut.
		expect(tenantRepairHints('floor', [{ key: 'tiles', label: 'Carreaux cassés', elements: ['floor'] }])).toHaveLength(1);
	});
});

describe('réparations', () => {
	const r = {
		status: 'planned' as const,
		performedBy: 'organization' as const,
		finding: 'tenant_damage' as const,
		actualAmount: null,
		invoiceDocumentId: null,
		selfRepairAgreed: false
	};
	it('faite par l’organisation : montant réel et facture ; par le locataire : sur accord, puis contre-visite', () => {
		expect(repairTransitionBlocker(r, 'done')).toBe('REPAIR_INVOICE_REQUIRED');
		expect(repairTransitionBlocker({ ...r, actualAmount: 9_000, invoiceDocumentId: 'f' }, 'done')).toBeNull();
		expect(repairTransitionBlocker(r, 'verified')).toBe('REPAIR_TRANSITION_FORBIDDEN');
		expect(repairTransitionBlocker({ ...r, finding: 'normal_wear' }, 'done')).toBe('REPAIR_NOT_TENANT_DAMAGE');
		const tenant = { ...r, performedBy: 'tenant' as const };
		expect(repairTransitionBlocker(tenant, 'done')).toBe('REPAIR_SELF_REPAIR_NOT_AGREED');
		expect(repairTransitionBlocker({ ...tenant, selfRepairAgreed: true }, 'done')).toBeNull();
		expect(repairTransitionBlocker({ ...tenant, selfRepairAgreed: true, status: 'done' }, 'verified')).toBeNull();
	});
});

describe('circuit d’accord (docs/UX.md §10)', () => {
	const proposal = {
		type: 'deposit_applied_to_rent' as const,
		status: 'proposed' as const,
		proposedBy: 'tenant' as const,
		decidedBy: 'organization' as const,
		decision: 'accepted' as const,
		reason: null,
		documentId: 'accord-ecrit',
		months: ['2027-05-01', '2027-06-01'],
		decidedOn: '2027-04-20'
	};
	it('imputation sur loyer : mois nommés et à venir ; acceptée par écrit, avant ces mois', () => {
		expect(agreementProposalBlocker({ type: 'deposit_applied_to_rent', months: [] }, TODAY)).toBe('AGREEMENT_MONTHS_REQUIRED');
		expect(agreementProposalBlocker({ type: 'deposit_applied_to_rent', months: ['2027-04-01'] }, TODAY)).toBe('AGREEMENT_MONTH_STARTED');
		expect(agreementProposalBlocker({ type: 'deposit_applied_to_rent', months: ['2027-05-01'] }, TODAY)).toBeNull();
		expect(agreementDecisionBlocker(proposal)).toBeNull();
		expect(agreementDecisionBlocker({ ...proposal, documentId: null })).toBe('AGREEMENT_DOCUMENT_REQUIRED');
		expect(agreementDecisionBlocker({ ...proposal, decidedOn: '2027-05-02' })).toBe('AGREEMENT_MONTH_STARTED');
	});

	it('refus motivé ; jamais décidé deux fois ni par la partie qui propose', () => {
		expect(agreementDecisionBlocker({ ...proposal, decision: 'refused' })).toBe('AGREEMENT_REASON_REQUIRED');
		expect(agreementDecisionBlocker({ ...proposal, decision: 'refused', reason: 'Dégâts visibles à la visite' })).toBeNull();
		expect(agreementDecisionBlocker({ ...proposal, status: 'accepted' })).toBe('AGREEMENT_ALREADY_DECIDED');
		expect(agreementDecisionBlocker({ ...proposal, decidedBy: 'tenant' })).toBe('AGREEMENT_SAME_PARTY');
		expect(agreementDecisionBlocker({ ...proposal, type: 'tenant_self_repair', documentId: null, months: [] })).toBeNull();
	});
});

describe('transfert de gestion (D16, règles 12 et 15)', () => {
	const input = (extra: Partial<ManagementTransferInput> = {}): ManagementTransferInput => ({
		target: { propertyId: 'p1', unitId: null },
		mandate: { id: 'm1', status: 'active', scopes: [{ id: 's1', propertyId: 'p1', unitId: null }] },
		transferOn: '2027-04-01',
		today: TODAY,
		newManagerName: 'Agence Faso Habitat',
		handedOverOn: '2027-04-01',
		handedOverItems: ['Bail signé', 'État des lieux d’entrée'],
		leasesInForce: [
			{ id: 'l1', unitId: 'u1' },
			{ id: 'l2', unitId: 'u2' }
		],
		depositAccounts: [
			{ id: 'd1', leaseId: 'l1', holder: 'organization', held: 150_000, status: 'held' },
			{ id: 'd2', leaseId: 'l2', holder: 'owner', held: 150_000, status: 'held' }
		],
		...extra
	});

	it('mandat terminé, baux de A terminés, caution détenue par A remise au nouveau gestionnaire nommé en texte', () => {
		expect(managementTransferBlocker(input())).toBeNull();
		expect(managementTransferPlan(input())).toEqual({
			mandateAction: 'end_mandate',
			scopeIds: ['s1'],
			leaseIds: ['l1', 'l2'],
			holderChanges: [{ accountId: 'd1', previousHolder: 'organization', newHolder: 'third_party', newHolderName: 'Agence Faso Habitat' }]
		});
	});

	it('une seule unité d’un mandat plus large : seules ses portées prennent fin', () => {
		const plan = managementTransferPlan(
			input({
				target: { propertyId: 'p1', unitId: 'u2' },
				mandate: {
					id: 'm1',
					status: 'active',
					scopes: [
						{ id: 's1', propertyId: 'p1', unitId: 'u1' },
						{ id: 's2', propertyId: 'p1', unitId: 'u2' }
					]
				}
			})
		);
		expect(plan).toMatchObject({ mandateAction: 'end_scopes', scopeIds: ['s2'], leaseIds: ['l2'], holderChanges: [] });
	});

	it('refus : pas géré par A, date future, nouveau gestionnaire ou dossier remis manquant', () => {
		expect(managementTransferBlocker(input({ mandate: null }))).toBe('TRANSFER_NOT_MANAGED');
		expect(managementTransferBlocker(input({ mandate: { id: 'm1', status: 'revoked', scopes: [] } }))).toBe('TRANSFER_NOT_MANAGED');
		expect(managementTransferBlocker(input({ target: { propertyId: 'p9', unitId: null } }))).toBe('TRANSFER_NOT_MANAGED');
		expect(managementTransferBlocker(input({ transferOn: '2027-05-01' }))).toBe('TRANSFER_DATE_IN_FUTURE');
		expect(managementTransferBlocker(input({ newManagerName: ' ' }))).toBe('TRANSFER_NEW_MANAGER_REQUIRED');
		expect(managementTransferBlocker(input({ handedOverItems: [] }))).toBe('TRANSFER_HANDOVER_REQUIRED');
	});

	it('règle 15 : le nouveau gestionnaire n’est qu’un nom, jamais une organisation ni une ligne à copier', () => {
		const plan = managementTransferPlan(input());
		expect(Object.keys(plan)).toEqual(['mandateAction', 'scopeIds', 'leaseIds', 'holderChanges']);
		expect(Object.keys(plan.holderChanges[0]!)).toEqual(['accountId', 'previousHolder', 'newHolder', 'newHolderName']);
	});
});
