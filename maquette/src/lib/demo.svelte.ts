/**
 * État de la démo. Les données fictives sont recalculées à partir de la date du jour ;
 * seules les actions faites pendant la démo (encaissements, publications, relevés envoyés)
 * sont gardées dans le navigateur, pour survivre à un rechargement.
 */
import { buildDataset, receiptNumber } from './fixtures';
import { isoToday } from './format';
import { allocateOldestFirst, initialStatus, publicationBlockers } from './rules';
import type { Dataset, Payment, PaymentMethod, Visibility } from './types';
import { profiles, type ProfileId } from './profiles';
import { arrears, leaseView, scopeDataset } from './views';

const STORAGE_KEY = 'immo-demo-v1';
const PROFILE_KEY = 'immo-demo-profil';

/** Périmètres de la démo : biens affectés à l'agent, logements du bailleur, biens du propriétaire. */
export const FIELD_AGENT_PROPERTIES = ['p3', 'p4', 'p9'];
export const LANDLORD_OWNER_ID = 'o3';
export const OWNER_PORTAL_ID = 'o1';

interface DemoLog {
	payments: Payment[];
	visibility: Record<string, Visibility>;
	sentStatements: Record<string, string>;
	reminders: Record<string, string>;
	/** Encaissements « à valider » validés par un gestionnaire pendant la démo. */
	validations: Record<string, string>;
}

const emptyLog = (): DemoLog => ({ payments: [], visibility: {}, sentStatements: {}, reminders: {}, validations: {} });

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

class DemoStore {
	today = $state(isoToday());
	log = $state<DemoLog>(load());

	base = $derived(buildDataset(this.today));

	profileId = $state<ProfileId>(loadProfile());
	profile = $derived(profiles[this.profileId]);

	/** Toutes les données de l'agence, sans restriction de profil. */
	full: Dataset = $derived.by(() => {
		const base = this.base;
		const log = this.log;
		return {
			...base,
			units: base.units.map((u) => ({ ...u, visibility: log.visibility[u.id] ?? u.visibility })),
			payments: [...base.payments, ...log.payments].map((p) =>
				p.status === 'to_validate' && log.validations[p.id] ? { ...p, status: 'validated' as const } : p
			)
		};
	});

	/** Bail du locataire de la démo : le premier en retard, sinon le premier bail. */
	tenantLeaseId = $derived(arrears(this.full)[0]?.lease.id ?? this.full.leases[0].id);

	/** Données vues par le profil actif (préfigure les règles de synchronisation). */
	data: Dataset = $derived.by(() => {
		const full = this.full;
		switch (this.profileId) {
			case 'field_agent':
				return scopeDataset(full, { propertyIds: FIELD_AGENT_PROPERTIES });
			case 'landlord':
				return scopeDataset(full, { propertyIds: full.properties.filter((p) => p.ownerId === LANDLORD_OWNER_ID).map((p) => p.id) });
			case 'owner':
				return scopeDataset(full, { propertyIds: full.properties.filter((p) => p.ownerId === OWNER_PORTAL_ID).map((p) => p.id) });
			case 'tenant':
				return scopeDataset(full, { leaseId: this.tenantLeaseId });
			default:
				return full;
		}
	});

	/** Nom affiché en tête de l'espace de travail. */
	workspaceName = $derived.by(() => {
		if (this.profileId === 'landlord') {
			const o = this.full.owners.find((x) => x.id === LANDLORD_OWNER_ID)!;
			return `${o.civility} ${o.name}`;
		}
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
		const last = this.full.payments
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
