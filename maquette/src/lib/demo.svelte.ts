/**
 * État de la démo. Les données fictives sont recalculées à partir de la date du jour ;
 * seules les actions faites pendant la démo (encaissements, publications, relevés envoyés)
 * sont gardées dans le navigateur, pour survivre à un rechargement.
 */
import { buildDataset, receiptNumber } from './fixtures';
import { isoToday } from './format';
import { allocateOldestFirst, initialStatus, publicationBlockers } from './rules';
import type { Dataset, Payment, PaymentMethod, Visibility } from './types';
import { leaseView } from './views';

const STORAGE_KEY = 'immo-demo-v1';

interface DemoLog {
	payments: Payment[];
	visibility: Record<string, Visibility>;
	sentStatements: Record<string, string>;
	reminders: Record<string, string>;
}

const emptyLog = (): DemoLog => ({ payments: [], visibility: {}, sentStatements: {}, reminders: {} });

function load(): DemoLog {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
		if (!raw) return emptyLog();
		return { ...emptyLog(), ...(JSON.parse(raw) as Partial<DemoLog>) };
	} catch {
		return emptyLog();
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

	data: Dataset = $derived.by(() => {
		const base = this.base;
		const log = this.log;
		return {
			...base,
			units: base.units.map((u) => ({ ...u, visibility: log.visibility[u.id] ?? u.visibility })),
			payments: [...base.payments, ...log.payments]
		};
	});

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
		const last = this.data.payments
			.map((p) => Number(p.receiptNumber.split('-')[2]))
			.reduce((a, b) => Math.max(a, b), 0);
		const payment: Payment = {
			id: newId(),
			leaseId: input.leaseId,
			date: this.today,
			amount: input.amount,
			method: input.method,
			reference: input.reference?.trim() || undefined,
			status: initialStatus(input.method),
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
