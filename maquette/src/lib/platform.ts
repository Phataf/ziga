/**
 * Back-office de la plateforme (lot 04, maquetté au lot 00 ter) : organisations, formules et abonnements,
 * interrupteurs de fonctionnalités, accès d'assistance motivé, journal.
 * Données fictives et règles pures ; la spécification fait foi dans docs/FEATURE-FLAGS.md.
 */
import type { OrganizationKind } from './types';

export type PlanId = 'discovery' | 'essential' | 'pro';

export interface Plan {
	id: PlanId;
	label: string;
	monthly: number;
	yearly: number;
	maxUnits: number;
	target: string;
}

/** Prix du cadrage (§7), hypothèse à tester en entretien. */
export const plans: Plan[] = [
	{ id: 'discovery', label: 'Découverte', monthly: 0, yearly: 0, maxUnits: 10, target: 'Bailleur ou petite agence' },
	{ id: 'essential', label: 'Essentiel', monthly: 15000, yearly: 150000, maxUnits: 60, target: 'Agence jusqu’à 60 unités' },
	{ id: 'pro', label: 'Pro', monthly: 35000, yearly: 350000, maxUnits: 250, target: 'Agence jusqu’à 250 unités' }
];

export type SubscriptionStatus = 'up_to_date' | 'reminder' | 'free';

export interface PlatformOrganization {
	id: string;
	name: string;
	kind: OrganizationKind;
	plan: PlanId;
	verified: boolean;
	members: number;
	since: string;
	subscription: { status: SubscriptionStatus; paidUntil?: string; lastPayment?: string };
}

/** Organisations vues par la plateforme : jamais leurs baux ni leurs paiements, seulement le compte. */
export const platformOrganizations: PlatformOrganization[] = [
	{ id: 'agency-demo', name: 'Immo Démo', kind: 'agency', plan: 'essential', verified: true, members: 3, since: '2026-09-01', subscription: { status: 'up_to_date', paidUntil: '2026-11-30', lastPayment: '2026-11-02' } },
	{ id: 'agency-horizon', name: 'Horizon Immo', kind: 'agency', plan: 'discovery', verified: true, members: 2, since: '2026-10-01', subscription: { status: 'reminder', paidUntil: '2026-10-31', lastPayment: '2026-10-03' } },
	{ id: 'landlord-sawadogo', name: 'Issouf Sawadogo', kind: 'landlord', plan: 'discovery', verified: true, members: 1, since: '2026-10-02', subscription: { status: 'free' } }
];

export const subscriptionLabel: Record<SubscriptionStatus, string> = {
	up_to_date: 'À jour',
	reminder: 'Rappel envoyé',
	free: 'Gratuite'
};

export type GlobalMode = 'disabled' | 'restricted' | 'enabled';

export const modeLabel: Record<GlobalMode, string> = {
	disabled: 'Coupée pour tous',
	restricted: 'Ouverte sur liste',
	enabled: 'Ouverte à tous'
};

export interface Feature {
	key: string;
	label: string;
	/** Formules qui l'incluent ; vide si la fonctionnalité n'est pas liée aux formules. */
	plans: PlanId[];
	mode: GlobalMode;
}

/** Catalogue (docs/FEATURE-FLAGS.md §5), état de la démonstration. */
export const features: Feature[] = [
	{ key: 'payments.registry', label: 'Saisie des encaissements et reçus', plans: [], mode: 'enabled' },
	{ key: 'payments.direct', label: 'Paiement Mobile Money initié depuis la plateforme (lot 14)', plans: ['pro'], mode: 'disabled' },
	{ key: 'listings.publication', label: 'Publier des annonces sur la vitrine', plans: [], mode: 'enabled' },
	{ key: 'listings.featured', label: 'Mise en avant d’annonces', plans: ['pro'], mode: 'restricted' },
	{ key: 'field_agents', label: 'Agent de terrain et validation des espèces', plans: ['essential', 'pro'], mode: 'enabled' },
	{ key: 'collections.owner_statements', label: 'Relevés propriétaires', plans: [], mode: 'enabled' },
	{ key: 'imports.excel', label: 'Import Excel', plans: [], mode: 'enabled' },
	{ key: 'portals.owner_space', label: 'Espace propriétaire regroupant toutes les organisations', plans: [], mode: 'enabled' },
	{ key: 'portals.tenant_space', label: 'Espace locataire regroupant tout son historique', plans: [], mode: 'enabled' },
	{ key: 'media.virtual_tour_360', label: 'Visites 360° (phase 4)', plans: ['pro'], mode: 'disabled' }
];

export interface FeatureOverride {
	id: string;
	key: string;
	organizationId: string;
	value: boolean;
	reason: string;
	endsOn?: string;
}

export const overrides: FeatureOverride[] = [
	{ id: 'ov1', key: 'listings.featured', organizationId: 'agency-horizon', value: true, reason: 'Essai demandé par l’agence pour ses villas', endsOn: '2026-12-31' }
];

export interface Resolution {
	enabled: boolean;
	reason: string;
}

/**
 * Résolution simplifiée pour une organisation (docs/FEATURE-FLAGS.md §3, étapes 1, 3, 4, 5, 7) :
 * arrêt d'urgence, exception de l'organisation, mode restreint, formule.
 */
export function resolveFeature(feature: Feature, org: Pick<PlatformOrganization, 'id' | 'plan'>, all: FeatureOverride[], today: string): Resolution {
	if (feature.mode === 'disabled') return { enabled: false, reason: 'Non — coupée pour tous' };
	const ov = all.find((o) => o.key === feature.key && o.organizationId === org.id && (!o.endsOn || o.endsOn >= today));
	if (ov) return { enabled: ov.value, reason: `${ov.value ? 'Oui' : 'Non'} — exception${ov.endsOn ? ` jusqu’au ${ov.endsOn.split('-').reverse().join('/')}` : ''}` };
	if (feature.mode === 'restricted') return { enabled: false, reason: 'Non — ouverte sur liste' };
	if (feature.plans.length && !feature.plans.includes(org.plan)) {
		return { enabled: false, reason: `Non — formule ${plans.find((p) => p.id === org.plan)!.label}` };
	}
	return { enabled: true, reason: 'Oui' };
}

/** Nombre d'organisations qui perdraient la fonctionnalité si on la coupait pour tous. */
export function affectedByCut(feature: Feature, orgs: PlatformOrganization[], all: FeatureOverride[], today: string): number {
	return orgs.filter((o) => resolveFeature(feature, o, all, today).enabled).length;
}

export interface SupportAccess {
	id: string;
	organizationId: string;
	agent: string;
	reason: string;
	startedAt: string;
	minutes: number;
}

export const supportDurations = [30, 60, 120] as const;

/** Un accès d'assistance est en lecture seule, motivé et limité dans le temps ; l'organisation le voit dans son journal. */
export function supportAccessErrors(input: { organizationId: string; reason: string; minutes: number }): string[] {
	const errors: string[] = [];
	if (!input.organizationId) errors.push('Choisissez l’organisation.');
	if (input.reason.trim().length < 15) errors.push('Le motif doit expliquer la demande (15 caractères au moins).');
	if (!supportDurations.includes(input.minutes as (typeof supportDurations)[number])) errors.push('Durée de 2 heures au plus.');
	return errors;
}

export function isAccessActive(a: SupportAccess, now: Date): boolean {
	const start = new Date(a.startedAt).getTime();
	return now.getTime() >= start && now.getTime() < start + a.minutes * 60_000;
}

export interface AuditEntry {
	id: string;
	at: string;
	actor: string;
	organization: string;
	action: string;
	before?: string;
	after?: string;
	origin: 'back-office' | 'application' | 'synchronisation';
	/** Action qui touche toutes les organisations : couleur d'alerte distincte. */
	global?: boolean;
}

export const auditSeed: AuditEntry[] = [
	{ id: 'a3', at: '2026-11-06T15:42:00Z', actor: 'Awa Traoré (assistance)', organization: 'Horizon Immo', action: 'Accès d’assistance en lecture, 30 minutes : « import Excel bloqué à la ligne 42, demande du 06/11 »', origin: 'back-office' },
	{ id: 'a2', at: '2026-11-03T09:10:00Z', actor: 'Admin plateforme', organization: 'Horizon Immo', action: 'Exception listings.featured', before: 'aucune', after: 'Oui jusqu’au 31/12/2026', origin: 'back-office' },
	{ id: 'a1', at: '2026-11-02T08:30:00Z', actor: 'Admin plateforme (finances)', organization: 'Immo Démo', action: 'Paiement d’abonnement enregistré : 15 000 FCFA, novembre 2026', origin: 'back-office' }
];
