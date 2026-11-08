/**
 * État de la démo. Les données fictives sont recalculées à partir de la date du jour ;
 * seules les actions faites pendant la démo (encaissements, publications, relevés envoyés, sorties,
 * biens ajoutés, réglages du back-office) sont gardées dans le navigateur, pour survivre à un rechargement.
 *
 * Trois organisations coexistent (D12), chacune avec ses propres lignes : Immo Démo, Horizon Immo et
 * le bailleur particulier Issouf Sawadogo. Un écran de gestion n'en affiche jamais qu'une ; seuls les
 * espaces personnels les lisent toutes, une à la fois (portals.ts).
 */
import { computeSettlement, settlementMovements, type Agreement, type InspectionItem, type Variant } from './deposit';
import { buildDataset, receiptNumber } from './fixtures';
import { buildHorizonDataset, buildLandlordDataset, memberships, OWNER_PERSON_ID, personLinks, persons, TENANT_PERSON_ID } from './fixtures-orgs';
import { isoToday } from './format';
import { auditSeed, features as featureSeed, overrides as overrideSeed, type AuditEntry, type FeatureOverride, type GlobalMode, type SupportAccess } from './platform';
import { ownerPortfolio, spacesOf, tenantHistory, type Organizations, type PortalRead } from './portals';
import { allocateOldestFirst, initialStatus, publicationBlockers } from './rules';
import type { ClosedSettlement, Dataset, Mandate, Notice, Owner, Payment, PaymentMethod, Property, TechnicalState, Unit, Visibility } from './types';
import { profiles, type ProfileId } from './profiles';
import { withUnitStatus } from './unit-status';
import { leaseView, scopeDataset } from './views';

const STORAGE_KEY = 'immo-demo-v1';
const PROFILE_KEY = 'immo-demo-profil';

/** Périmètres de la démo : biens affectés à l'agent, biens du propriétaire chez Immo Démo, bail du locataire. */
export const FIELD_AGENT_PROPERTIES = ['p3', 'p4', 'p9'];
export const OWNER_PORTAL_ID = 'o1';
export const TENANT_LEASE_ID = 'l9';
export const AGENCY_ID = 'agency-demo';
export const LANDLORD_ORG_ID = 'landlord-sawadogo';

/** Sortie d'un locataire en cours ou close : brouillon enregistré à chaque étape (docs/UX.md §10). */
export interface ExitRecord {
	step: number;
	notice?: Notice;
	keysReturnedOn: string;
	items: InspectionItem[];
	signedByTenant: boolean;
	signedByAgency: boolean;
	variant: Variant;
	offsetAgreement?: Agreement;
	repairAgreement?: Agreement;
	recheckDone: boolean;
	finalizedOn?: string;
}

/** Bien créé avec l'assistant pendant la démo. */
export interface CreatedProperty {
	organizationId: string;
	property: Property;
	/** Nouveau propriétaire saisi dans l'assistant, avec son mandat. */
	owner?: Owner;
	mandate?: Mandate;
	units: Unit[];
	gps?: string;
	landmark?: string;
	documents: string[];
	record: 'draft' | 'active';
}

export interface PropertyDraft {
	step: number;
	values: Record<string, unknown>;
	savedOn: string;
}

export interface TenantIssue {
	id: string;
	kind: string;
	details: string;
	createdOn: string;
	status: 'received' | 'planned' | 'done';
	plannedOn?: string;
	note?: string;
}

interface DemoLog {
	payments: Payment[];
	visibility: Record<string, Visibility>;
	sentStatements: Record<string, string>;
	reminders: Record<string, string>;
	/** Encaissements « à valider » validés par un gestionnaire pendant la démo. */
	validations: Record<string, string>;
	technical: Record<string, { state: TechnicalState; on: string }>;
	exits: Record<string, ExitRecord>;
	properties: CreatedProperty[];
	propertyDraft?: PropertyDraft;
	issues: TenantIssue[];
	featureModes: Record<string, GlobalMode>;
	overrides: FeatureOverride[];
	support: SupportAccess[];
	audit: AuditEntry[];
	subscriptionPayments: Record<string, string>;
}

const emptyLog = (): DemoLog => ({
	payments: [],
	visibility: {},
	sentStatements: {},
	reminders: {},
	validations: {},
	technical: {},
	exits: {},
	properties: [],
	issues: [],
	featureModes: {},
	overrides: [],
	support: [],
	audit: [],
	subscriptionPayments: {}
});

function load(): DemoLog {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
		if (!raw) return emptyLog();
		return { ...emptyLog(), ...(JSON.parse(raw) as Partial<DemoLog>) };
	} catch {
		return emptyLog();
	}
}

function loadProfile(): ProfileId {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PROFILE_KEY) : null;
		return raw && raw in profiles ? (raw as ProfileId) : 'manager';
	} catch {
		return 'manager';
	}
}

function save(log: DemoLog): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
	} catch {
		// Stockage indisponible (navigation privée) : la démo reste en mémoire.
	}
}

function newId(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Décompte d'une sortie d'après son brouillon (le même calcul sert à l'écran et à la validation). */
export function settlementOf(data: Dataset, leaseId: string, exit: ExitRecord) {
	const lease = data.leases.find((l) => l.id === leaseId)!;
	const v = leaseView(data, leaseId)!;
	// Variante B : la caution couvre le dernier loyer, celui du mois où finit le préavis, s'il n'est pas payé.
	const finalPeriod = (exit.notice ?? lease.notice)?.effectiveDate.slice(0, 7) ?? data.today.slice(0, 7);
	const lastDue = v.dues.find((d) => d.period === finalPeriod && d.balance > 0);
	const useOffset = exit.variant === 'rent_offset' && !!lastDue;
	const offsets = useOffset ? [{ period: lastDue!.period, amount: lastDue!.balance }] : [];
	const unpaid = v.dues
		.filter((d) => d.balance > 0 && d.dueDate <= data.today && !(useOffset && d.id === lastDue!.id))
		.map((d) => ({ period: d.period, amount: d.balance }));
	// Variante C : le locataire propose de faire lui-même toutes les réparations qui lui sont imputables.
	const repairedBy = exit.variant === 'tenant_repair' ? ('tenant' as const) : ('owner' as const);
	const items = exit.items.map((i) => (i.finding === 'tenant' ? { ...i, repairedBy } : i));
	return {
		lease,
		lastDue,
		offsets,
		settlement: computeSettlement({
			deposit: lease.deposit,
			items,
			unpaid,
			offsets,
			offsetAgreement: exit.variant === 'rent_offset' ? exit.offsetAgreement : undefined,
			repairAgreement: exit.variant === 'tenant_repair' ? exit.repairAgreement : undefined,
			recheckDone: exit.recheckDone
		})
	};
}

/** Applique les actions de la démo à une organisation, sans jamais mélanger ses lignes avec celles d'une autre. */
function applyLog(base: Dataset, log: DemoLog): Dataset {
	const orgId = base.agency.id;
	const created = log.properties.filter((c) => c.organizationId === orgId);
	const properties = [...base.properties, ...created.map((c) => c.property)];
	const owners = [...base.owners, ...created.flatMap((c) => (c.owner ? [c.owner] : []))];
	const mandates = [...base.mandates, ...created.flatMap((c) => (c.mandate ? [c.mandate] : []))];
	const units = [...base.units, ...created.flatMap((c) => c.units)].map((u) => ({
		...u,
		visibility: log.visibility[u.id] ?? u.visibility,
		technical: log.technical[u.id]?.state ?? u.technical
	}));
	const leases = base.leases.map((l) => {
		const exit = log.exits[l.id];
		if (!exit) return l;
		return { ...l, notice: exit.notice ?? l.notice, ...(exit.finalizedOn ? { endDate: exit.keysReturnedOn } : {}) };
	});
	const leaseIds = new Set(leases.map((l) => l.id));
	const payments = [...base.payments, ...log.payments.filter((p) => leaseIds.has(p.leaseId))].map((p) =>
		p.status === 'to_validate' && log.validations[p.id] ? { ...p, status: 'validated' as const } : p
	);
	let data: Dataset = { ...base, owners, mandates, properties, units, leases, payments };

	// Sorties validées : mouvements du compte de caution (ajout seul) et décompte clos.
	const movements = [...(base.depositMovements ?? [])];
	const settlements: ClosedSettlement[] = [...(base.settlements ?? [])];
	for (const [leaseId, exit] of Object.entries(log.exits)) {
		if (!exit.finalizedOn || !leaseIds.has(leaseId)) continue;
		const { settlement } = settlementOf({ ...data, today: exit.finalizedOn }, leaseId, exit);
		movements.push(...settlementMovements(leaseId, settlement, exit.finalizedOn));
		settlements.push({
			leaseId,
			date: exit.finalizedOn,
			inspectionDate: exit.keysReturnedOn,
			deposit: settlement.deposit,
			lines: settlement.lines.map((l) => ({ label: l.label, amount: l.amount, proof: l.proof })),
			refund: settlement.refund,
			claim: settlement.claim,
			refundMethod: 'Espèces'
		});
	}
	data = { ...data, depositMovements: movements, settlements };
	return withUnitStatus(data);
}

class DemoStore {
	today = $state(isoToday());
	log = $state<DemoLog>(load());

	profileId = $state<ProfileId>(loadProfile());
	profile = $derived(profiles[this.profileId]);

	/** Les trois organisations, chacune avec ses seules lignes. */
	orgs: Organizations = $derived.by(() => {
		const log = this.log;
		return {
			[AGENCY_ID]: applyLog(buildDataset(this.today), log),
			'agency-horizon': applyLog(buildHorizonDataset(this.today), log),
			[LANDLORD_ORG_ID]: applyLog(buildLandlordDataset(this.today), log)
		};
	});

	/** Organisation de l'espace de gestion ouvert : jamais deux à la fois. */
	organizationId = $derived(this.profileId === 'landlord' ? LANDLORD_ORG_ID : AGENCY_ID);

	/** Toutes les données de l'organisation ouverte, sans restriction de profil. */
	full: Dataset = $derived(this.orgs[this.organizationId]);

	/** Bail du locataire de la démo (Rodrigue Yaméogo, chez Immo Démo). */
	tenantLeaseId = TENANT_LEASE_ID;

	/** Données vues par le profil actif (préfigure les règles de synchronisation). */
	data: Dataset = $derived.by(() => {
		const full = this.full;
		switch (this.profileId) {
			case 'field_agent':
				return scopeDataset(full, { propertyIds: FIELD_AGENT_PROPERTIES });
			case 'owner':
				return scopeDataset(full, { propertyIds: full.properties.filter((p) => p.ownerId === OWNER_PORTAL_ID).map((p) => p.id) });
			case 'tenant':
				return scopeDataset(full, { leaseId: this.tenantLeaseId });
			default:
				return full;
		}
	});

	/** Espace propriétaire : lectures par le module portals, une organisation après l'autre. */
	ownerReads: PortalRead[] = $derived.by(() => {
		const journal: PortalRead[] = [];
		ownerPortfolio(OWNER_PERSON_ID, personLinks, this.orgs, [], journal);
		return journal;
	});
	ownerPerson = persons.find((p) => p.id === OWNER_PERSON_ID)!;
	tenantPerson = persons.find((p) => p.id === TENANT_PERSON_ID)!;

	portfolio(periods: string[]) {
		return ownerPortfolio(OWNER_PERSON_ID, personLinks, this.orgs, periods);
	}

	tenantLeases = $derived(tenantHistory(TENANT_PERSON_ID, personLinks, this.orgs));

	/** Personne affichée par le choix de l'espace : celle du profil actif. */
	person = $derived(this.profileId === 'tenant' ? this.tenantPerson : this.ownerPerson);
	spaces = $derived(spacesOf(this.person, personLinks, memberships, this.orgs));

	/** Nom affiché en tête de l'espace de travail. */
	workspaceName = $derived.by(() => {
		if (this.profileId === 'admin') return 'Plateforme';
		return this.full.agency.name;
	});

	setProfile(id: ProfileId) {
		this.profileId = id;
		try {
			localStorage.setItem(PROFILE_KEY, id);
		} catch {
			// navigation privée : le profil reste en mémoire
		}
	}

	/** Le gestionnaire ou le directeur valide un encaissement saisi par un agent de terrain. */
	validate(paymentId: string) {
		this.log.validations[paymentId] = this.today;
		this.persist();
	}

	private persist() {
		save($state.snapshot(this.log) as DemoLog);
	}

	/** Enregistre un encaissement, imputé sur l'échéance la plus ancienne. */
	collect(input: { leaseId: string; amount: number; method: PaymentMethod; reference?: string }): Payment {
		const view = leaseView(this.data, input.leaseId);
		if (!view) throw new Error('Bail introuvable');
		const open = view.dues.filter((d) => d.balance > 0);
		const { allocations } = allocateOldestFirst(input.amount, open);
		const year = this.today.slice(0, 4);
		// Numérotation continue et sans trou, propre à chaque organisation (règle 9).
		const last = this.full.payments
			.filter((p) => p.receiptNumber.startsWith(`R-${year}-`))
			.map((p) => Number(p.receiptNumber.split('-')[2]))
			.reduce((a, b) => Math.max(a, b), 0);
		const payment: Payment = {
			id: newId(),
			leaseId: input.leaseId,
			date: this.today,
			amount: input.amount,
			method: input.method,
			reference: input.reference?.trim() || undefined,
			status: initialStatus(input.method, this.profileId === 'field_agent'),
			receiptNumber: receiptNumber(year, last + 1),
			allocations
		};
		this.log.payments.push(payment);
		this.persist();
		return payment;
	}

	/** Publie une unité si les conditions sont remplies ; renvoie les raisons du refus sinon. */
	publish(unitId: string): string[] {
		const unit = this.data.units.find((u) => u.id === unitId);
		if (!unit) return ['Unité introuvable.'];
		const property = this.data.properties.find((p) => p.id === unit.propertyId)!;
		const mandate = this.data.mandates.find((m) => m.id === property.mandateId)!;
		const blockers = publicationBlockers(unit, mandate, this.today);
		if (blockers.length) return blockers;
		this.log.visibility[unitId] = 'published';
		this.persist();
		return [];
	}

	unpublish(unitId: string) {
		this.log.visibility[unitId] = 'internal';
		this.persist();
	}

	/** État technique saisi (à remettre en état, en travaux, prête) ; l'occupation, elle, reste calculée. */
	setTechnical(unitId: string, state: TechnicalState) {
		this.log.technical[unitId] = { state, on: this.today };
		this.persist();
	}

	markStatementSent(ownerId: string, period: string) {
		this.log.sentStatements[`${ownerId}:${period}`] = this.today;
		this.persist();
	}

	statementSentOn(ownerId: string, period: string): string | undefined {
		return this.log.sentStatements[`${ownerId}:${period}`];
	}

	markReminded(leaseId: string) {
		this.log.reminders[leaseId] = this.today;
		this.persist();
	}

	remindedOn(leaseId: string): string | undefined {
		return this.log.reminders[leaseId];
	}

	// --- Sortie du locataire -------------------------------------------------

	exitOf(leaseId: string): ExitRecord | undefined {
		return this.log.exits[leaseId];
	}

	saveExit(leaseId: string, exit: ExitRecord) {
		this.log.exits[leaseId] = $state.snapshot(exit) as ExitRecord;
		this.persist();
	}

	/** Valide le décompte : fin du bail, mouvements du compte de caution, unité « à remettre en état ». */
	finalizeExit(leaseId: string, exit: ExitRecord) {
		const lease = this.full.leases.find((l) => l.id === leaseId);
		if (!lease) return;
		this.log.exits[leaseId] = { ...($state.snapshot(exit) as ExitRecord), finalizedOn: this.today };
		this.log.technical[lease.unitId] = { state: 'to_refurbish', on: this.today };
		this.persist();
	}

	// --- Assistant d'ajout de bien --------------------------------------------

	saveDraft(step: number, values: object) {
		this.log.propertyDraft = { step, values: $state.snapshot(values) as Record<string, unknown>, savedOn: this.today };
		this.persist();
	}

	clearDraft() {
		this.log.propertyDraft = undefined;
		this.persist();
	}

	addProperty(created: Omit<CreatedProperty, 'organizationId'>): string {
		this.log.properties.push({ ...created, organizationId: this.organizationId });
		this.log.propertyDraft = undefined;
		this.persist();
		return created.property.id;
	}

	// --- Espace locataire : signalements suivis -------------------------------

	reportIssue(kind: string, details: string) {
		this.log.issues.unshift({ id: newId(), kind, details, createdOn: this.today, status: 'received' });
		this.persist();
	}

	// --- Back-office -----------------------------------------------------------

	featureMode(key: string): GlobalMode {
		return this.log.featureModes[key] ?? featureSeed.find((f) => f.key === key)!.mode;
	}

	features = $derived(featureSeed.map((f) => ({ ...f, mode: this.log.featureModes[f.key] ?? f.mode })));
	overrides = $derived([...overrideSeed, ...this.log.overrides]);
	audit = $derived([...this.log.audit, ...auditSeed]);

	private writeAudit(entry: Omit<AuditEntry, 'id' | 'at' | 'origin'>) {
		this.log.audit.unshift({ ...entry, id: newId(), at: new Date().toISOString(), origin: 'back-office' });
	}

	setFeatureMode(key: string, mode: GlobalMode, reason: string) {
		const before = this.featureMode(key);
		this.log.featureModes[key] = mode;
		this.writeAudit({ actor: 'Admin plateforme', organization: 'Toutes les organisations', action: `Interrupteur ${key} — motif : ${reason}`, before, after: mode, global: true });
		this.persist();
	}

	addOverride(o: Omit<FeatureOverride, 'id'>, orgName: string) {
		this.log.overrides.push({ ...o, id: newId() });
		this.writeAudit({ actor: 'Admin plateforme', organization: orgName, action: `Exception ${o.key} — motif : ${o.reason}`, before: 'aucune', after: o.value ? 'Oui' : 'Non' });
		this.persist();
	}

	openSupportAccess(a: Omit<SupportAccess, 'id' | 'startedAt'>, orgName: string): SupportAccess {
		const access = { ...a, id: newId(), startedAt: new Date().toISOString() };
		this.log.support.unshift(access);
		this.writeAudit({ actor: `${a.agent} (assistance)`, organization: orgName, action: `Accès d’assistance en lecture, ${a.minutes} minutes : « ${a.reason} »` });
		this.persist();
		return access;
	}

	recordSubscriptionPayment(orgId: string, orgName: string, amount: string) {
		this.log.subscriptionPayments[orgId] = this.today;
		this.writeAudit({ actor: 'Admin plateforme (finances)', organization: orgName, action: `Paiement d’abonnement enregistré : ${amount}` });
		this.persist();
	}

	reset() {
		this.log = emptyLog();
		this.today = isoToday();
		try {
			localStorage.removeItem(STORAGE_KEY);
		} catch {
			// rien à faire
		}
	}
}

export const demo = new DemoStore();
