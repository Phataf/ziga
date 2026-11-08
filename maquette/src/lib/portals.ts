/**
 * Espaces personnels (D13, D17, CLAUDE.md règle 15) : préfigure le module `portals`.
 *
 * C'est le SEUL code qui lit plusieurs organisations. Il parcourt les liens vérifiés d'une personne
 * (code SMS ET acceptation par l'organisation), puis lit chaque organisation l'une après l'autre,
 * dans son propre jeu de données, uniquement ce qui concerne cette personne, en lecture seule.
 * Chaque lecture est journalisée. Aucun écran de gestion n'utilise ces fonctions.
 */
import type { Membership, Person, PersonLink } from './fixtures-orgs';
import { summaryOfUnit, type UnitSummary } from './unit-status';
import type { Agency, ClosedSettlement, Dataset, DepositHolder, DepositMovement, Notice, Payment, Property } from './types';
import { leaseView, ownerStatement } from './views';

/** Organisations par identifiant. Chacune garde ses propres lignes. */
export type Organizations = Record<string, Dataset>;

/** Trace d'une lecture faite pour une personne, dans une organisation. */
export interface PortalRead {
	personId: string;
	organizationId: string;
	kind: 'owner' | 'tenant';
	recordId: string;
	at: string;
}

/** Un lien n'ouvre l'accès qu'une fois le téléphone vérifié et le lien accepté par l'organisation. */
export function isLinkActive(link: PersonLink): boolean {
	return !!link.verifiedOn && !!link.acceptedOn;
}

export function activeLinks(links: PersonLink[], personId: string, kind: PersonLink['kind']): PersonLink[] {
	return links.filter((l) => l.personId === personId && l.kind === kind && isLinkActive(l));
}

/** Lit chaque organisation liée, une à la fois, et journalise la lecture. */
function readEach<T>(
	personId: string,
	kind: PersonLink['kind'],
	links: PersonLink[],
	orgs: Organizations,
	read: (data: Dataset, recordId: string) => T | undefined,
	journal?: PortalRead[]
): T[] {
	const out: T[] = [];
	for (const link of activeLinks(links, personId, kind)) {
		const data = orgs[link.organizationId];
		if (!data) continue;
		journal?.push({ personId, organizationId: link.organizationId, kind, recordId: link.recordId, at: data.today });
		const value = read(data, link.recordId);
		if (value !== undefined) out.push(value);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Propriétaire : patrimoine regroupé par gestionnaire
// ---------------------------------------------------------------------------

export interface OwnerUnitView {
	id: string;
	label: string;
	kind: string;
	rooms: number;
	rent: number;
	summary: UnitSummary;
	technicalReason?: string;
	/** Bail en cours, sans l'identité ni les coordonnées du locataire. */
	lease?: { since: string; notice?: Notice; deposit: number; depositHolder?: DepositHolder; balanceDue: number };
	from?: string;
	until?: string;
}

export interface OwnerPropertyView {
	organizationId: string;
	id: string;
	name: string;
	kind: string;
	district: string;
	city: string;
	commissionRate: number;
	selfManaged: boolean;
	mandateEnd: string;
	units: OwnerUnitView[];
	/** Loyers attendus par mois quand tout est loué. */
	potentialRent: number;
	/** Loyers des unités louées. */
	currentRent: number;
	expenses: { date: string; label: string; amount: number }[];
	/** Loyers encaissés sur les trois derniers mois, par mois. */
	collectedByMonth: { period: string; amount: number }[];
}

export interface OwnerGroup {
	organization: Agency;
	managedBy: 'agency' | 'self';
	properties: OwnerPropertyView[];
	/** Relevé du mois : loyers encaissés, commission, dépenses, net. */
	months: { period: string; received: number; commission: number; expenses: number; net: number }[];
}

function readOwner(data: Dataset, ownerId: string, periods: string[]): OwnerGroup | undefined {
	const owner = data.owners.find((o) => o.id === ownerId);
	if (!owner) return undefined;
	const props: Property[] = data.properties.filter((p) => p.ownerId === ownerId);
	const selfManaged = data.agency.kind === 'landlord';
	const properties = props.map((p): OwnerPropertyView => {
		const mandate = data.mandates.find((m) => m.id === p.mandateId)!;
		const units = data.units
			.filter((u) => u.propertyId === p.id)
			.map((u): OwnerUnitView => {
				const s = summaryOfUnit(data, u);
				const current = s.occupancy === 'occupied' || s.occupancy === 'notice' ? s.lease : undefined;
				const v = current ? leaseView(data, current.id) : undefined;
				return {
					id: u.id,
					label: u.label,
					kind: u.kind,
					rooms: u.rooms,
					rent: u.rent,
					summary: { label: s.label, variant: s.variant, available: s.available },
					technicalReason: u.technicalReason,
					lease: current
						? { since: current.startDate, notice: current.notice, deposit: current.deposit, depositHolder: current.depositHolder, balanceDue: v?.balanceDue ?? 0 }
						: undefined,
					from: s.from,
					until: s.until
				};
			});
		const leaseIds = new Set(data.leases.filter((l) => units.some((u) => u.id === l.unitId)).map((l) => l.id));
		return {
			organizationId: data.agency.id,
			id: p.id,
			name: p.name,
			kind: p.kind,
			district: p.district,
			city: p.city,
			commissionRate: mandate.commissionRate,
			selfManaged: !!mandate.selfManaged,
			mandateEnd: mandate.endDate,
			units,
			potentialRent: units.reduce((s, u) => s + u.rent, 0),
			currentRent: units.filter((u) => u.lease).reduce((s, u) => s + u.rent, 0),
			expenses: data.expenses.filter((e) => e.propertyId === p.id).map((e) => ({ date: e.date, label: e.label, amount: e.amount })),
			collectedByMonth: periods.map((period) => ({
				period,
				amount: data.payments.filter((x) => leaseIds.has(x.leaseId) && x.date.startsWith(period)).reduce((s, x) => s + x.amount, 0)
			}))
		};
	});
	const months = periods.map((period) => {
		const st = ownerStatement(data, ownerId, period)!;
		return { period, ...st.totals };
	});
	return { organization: data.agency, managedBy: selfManaged ? 'self' : 'agency', properties, months };
}

/** Tous les biens d'une personne, dans chaque organisation liée, regroupés par gestionnaire. */
export function ownerPortfolio(personId: string, links: PersonLink[], orgs: Organizations, periods: string[], journal?: PortalRead[]): OwnerGroup[] {
	const groups = readEach(personId, 'owner', links, orgs, (data, id) => readOwner(data, id, periods), journal);
	// Les agences d'abord, la gestion directe ensuite.
	return groups.sort((a, b) => (a.managedBy === b.managedBy ? a.organization.name.localeCompare(b.organization.name, 'fr') : a.managedBy === 'agency' ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Locataire : tout son historique, toutes agences confondues
// ---------------------------------------------------------------------------

export interface TenantLeaseHistory {
	organization: Agency;
	leaseId: string;
	current: boolean;
	startDate: string;
	endDate?: string;
	notice?: Notice;
	rent: number;
	deposit: number;
	depositHolder?: DepositHolder;
	unit: { label: string; kind: string };
	property: { name: string; district: string; city: string };
	balanceDue: number;
	payments: Payment[];
	movements: DepositMovement[];
	settlement?: ClosedSettlement;
}

function readTenant(data: Dataset, tenantId: string): TenantLeaseHistory[] {
	return data.leases
		.filter((l) => l.tenantId === tenantId)
		.map((lease) => {
			const unit = data.units.find((u) => u.id === lease.unitId)!;
			const property = data.properties.find((p) => p.id === unit.propertyId)!;
			const ended = !!lease.endDate && lease.endDate <= data.today;
			const v = leaseView(data, lease.id)!;
			return {
				organization: data.agency,
				leaseId: lease.id,
				current: !ended,
				startDate: lease.startDate,
				endDate: lease.endDate,
				notice: lease.notice,
				rent: lease.rent,
				deposit: lease.deposit,
				depositHolder: lease.depositHolder,
				unit: { label: unit.label, kind: unit.kind },
				property: { name: property.name, district: property.district, city: property.city },
				balanceDue: ended ? 0 : v.balanceDue,
				payments: v.payments,
				movements: (data.depositMovements ?? []).filter((m) => m.leaseId === lease.id).sort((a, b) => a.date.localeCompare(b.date)),
				settlement: data.settlements?.find((x) => x.leaseId === lease.id)
			};
		});
}

/** Historique complet d'un locataire : chaque bail indique l'organisation concernée. */
export function tenantHistory(personId: string, links: PersonLink[], orgs: Organizations, journal?: PortalRead[]): TenantLeaseHistory[] {
	return readEach(personId, 'tenant', links, orgs, readTenant, journal)
		.flat()
		.sort((a, b) => b.startDate.localeCompare(a.startDate));
}

// ---------------------------------------------------------------------------
// Choix de l'espace
// ---------------------------------------------------------------------------

export interface SpaceChoice {
	id: 'owner' | 'tenant' | 'landlord' | 'member';
	organizationId?: string;
	label: string;
	detail: string;
	href: string;
}

/** Les espaces d'une personne : ses espaces personnels, puis chaque organisation dont elle est membre. */
export function spacesOf(person: Person, links: PersonLink[], members: Membership[], orgs: Organizations): SpaceChoice[] {
	const spaces: SpaceChoice[] = [];
	const owner = activeLinks(links, person.id, 'owner');
	if (owner.length) {
		const names = owner.map((l) => orgs[l.organizationId]?.agency).filter((a): a is Agency => !!a);
		spaces.push({
			id: 'owner',
			label: 'Mon patrimoine',
			detail: `Propriétaire · ${names.length} gestionnaire${names.length > 1 ? 's' : ''} : ${names.map((a) => (a.kind === 'landlord' ? 'gestion directe' : a.name)).join(', ')}`,
			href: '/proprietaire'
		});
	}
	const tenant = activeLinks(links, person.id, 'tenant');
	if (tenant.length) {
		spaces.push({ id: 'tenant', label: 'Mon logement', detail: `Locataire · historique dans ${tenant.length} organisation${tenant.length > 1 ? 's' : ''}`, href: '/locataire' });
	}
	for (const m of members.filter((x) => x.personId === person.id)) {
		const org = orgs[m.organizationId]?.agency;
		if (!org) continue;
		spaces.push(
			m.role === 'landlord'
				? { id: 'landlord', organizationId: org.id, label: 'Mes logements', detail: 'Bailleur particulier · gestion directe de vos logements', href: '/' }
				: { id: 'member', organizationId: org.id, label: org.name, detail: 'Membre de l’agence', href: '/' }
		);
	}
	return spaces;
}
