/**
 * Organisations de la personne connectée et organisation active (lot 03). Chaque appel de gestion porte
 * l'en-tête X-Organization-Id de l'organisation active ; l'API vérifie l'appartenance à chaque requête.
 * Un retrait (403 NOT_A_MEMBER) renvoie vers le choix de l'espace, avec un message.
 */
import type { MembershipView } from '@ziga/shared/organizations';
import { memberProfile } from '@ziga/shared/permissions';
import { auth } from '../auth/auth.svelte';
import { ApiError, NetworkError, type Method } from '../auth/http';
import { clearMemberships, pickActive, readMemberships, writeMemberships } from './memberships';

const storage = (): Storage | undefined => {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage;
	} catch {
		return undefined;
	}
};

class Organizations {
	list = $state<MembershipView[]>([]);
	activeId = $state<string | null>(null);
	/** Liste lue en ligne pendant cette visite (sinon celle gardée sur l'appareil). */
	fresh = $state(false);
	/** Dernier retrait constaté, affiché sur le choix de l'espace. */
	removedNotice = $state(false);

	active = $derived(this.list.find((m) => m.organizationId === this.activeId) ?? null);
	profile = $derived(this.active ? memberProfile(this.active.type, this.active.role) : null);

	constructor() {
		auth.onSignOut(() => this.#reset());
	}

	#reset(): void {
		clearMemberships(storage());
		this.list = [];
		this.activeId = null;
		this.fresh = false;
	}

	#save(): void {
		if (auth.user) writeMemberships(storage(), { userId: auth.user.id, memberships: this.list, activeId: this.activeId });
	}

	/** Lit les appartenances : en ligne si possible, sinon celles gardées sur l'appareil. */
	async load(force = false): Promise<void> {
		if (!auth.user) return;
		const stored = readMemberships(storage(), auth.user.id);
		if (!this.fresh || force) {
			try {
				this.list = await auth.request<MembershipView[]>('GET', '/me/organizations');
				this.fresh = true;
				// L'organisation ouverte la dernière fois a disparu de la liste : la personne en a été retirée.
				const wanted = this.activeId ?? stored?.activeId ?? null;
				if (wanted && !this.list.some((m) => m.organizationId === wanted)) {
					this.removedNotice = true;
					this.activeId = null;
				}
			} catch (error) {
				if (!(error instanceof NetworkError)) throw error;
				this.list = stored?.memberships ?? this.list;
			}
		}
		this.activeId = pickActive(this.list, this.removedNotice ? this.activeId : (this.activeId ?? stored?.activeId ?? null));
		this.#save();
	}

	select(organizationId: string): void {
		this.activeId = pickActive(this.list, organizationId);
		this.removedNotice = false;
		this.#save();
	}

	/** Ajoute une organisation (création, invitation acceptée) et la rend active. */
	add(membership: MembershipView): void {
		this.list = [...this.list.filter((m) => m.organizationId !== membership.organizationId), membership];
		this.select(membership.organizationId);
	}

	/** Appel dans le contexte de l'organisation active. */
	async call<T>(method: Method, path: string, body?: unknown, file?: Blob): Promise<T> {
		const organization = this.activeId;
		try {
			return await auth.request<T>(method, path, body, { organization, file });
		} catch (error) {
			if (error instanceof ApiError && error.code === 'NOT_A_MEMBER' && organization) {
				this.list = this.list.filter((m) => m.organizationId !== organization);
				this.activeId = null;
				this.removedNotice = true;
				this.#save();
				location.assign('/espace');
			}
			throw error;
		}
	}
}

export const organizations = new Organizations();
