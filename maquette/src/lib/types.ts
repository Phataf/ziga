/** Modèle simplifié de la maquette. Noms en anglais (glossaire CLAUDE.md §6). */

export type UnitStatus = 'free' | 'rented' | 'reserved' | 'unavailable';
export type Visibility = 'internal' | 'published';
export type PaymentMethod = 'cash' | 'orange_money' | 'moov_money' | 'transfer';
/**
 * validated = validé ; to_reconcile = Mobile Money déclaré, à rapprocher ;
 * to_validate = espèces saisies par un agent de terrain, à valider (CLAUDE.md §5.6).
 */
export type PaymentStatus = 'validated' | 'to_reconcile' | 'to_validate';
export type Civility = 'M.' | 'Mme';

/** Organisation (D12) : une agence, ou un bailleur particulier qui gère lui-même ses logements. */
export type OrganizationKind = 'agency' | 'landlord';

export interface Agency {
	id: string;
	name: string;
	phone: string;
	address: string;
	/** Type d'organisation ; une agence par défaut. */
	kind?: OrganizationKind;
}

/** Statut d'une unité en quatre dimensions (D14). */
export type RecordState = 'draft' | 'active' | 'archived';
/** Occupation : calculée à partir des baux, jamais saisie. */
export type Occupancy = 'free' | 'reserved' | 'occupied' | 'notice';
/** État technique : saisi (état des lieux, gestionnaire). */
export type TechnicalState = 'ready' | 'to_refurbish' | 'works' | 'unavailable';
export type ListingState = 'unpublished' | 'published' | 'suspended';
export type DepositHolder = 'agency' | 'owner';

export interface Owner {
	id: string;
	civility: Civility;
	name: string;
	phone: string;
	residence: string;
	/** Personne (par défaut), société ou groupe d'indivisaires avec un représentant (D16). */
	kind?: 'person' | 'company' | 'joint';
}

export interface Mandate {
	id: string;
	ownerId: string;
	type: 'management';
	startDate: string;
	endDate: string;
	/** Commission de gestion en pourcentage entier des loyers encaissés. */
	commissionRate: number;
	canPublish: boolean;
	canPhotograph: boolean;
	canCollect: boolean;
	/** Bien géré par son propriétaire lui-même (bailleur particulier) : pas de commission. */
	selfManaged?: boolean;
}

export interface Property {
	id: string;
	ownerId: string;
	mandateId: string;
	name: string;
	kind: string;
	city: 'Ouagadougou' | 'Saaba';
	district: string;
	address: string;
}

export interface Unit {
	id: string;
	propertyId: string;
	label: string;
	kind: string;
	rooms: number;
	surface: number;
	rent: number;
	charges: number;
	/** Statut simplifié du lot 00, déduit de l'occupation (libre, louée, réservée). */
	status: UnitStatus;
	/** Fiche : brouillon, active (par défaut), archivée. */
	record?: RecordState;
	/** Calculée à partir des baux (voir unit-status.ts). */
	occupancy?: Occupancy;
	/** État technique, prête par défaut. */
	technical?: TechnicalState;
	technicalReason?: string;
	furnished?: boolean;
	showers?: number;
	photos: number;
	features: string[];
	description: string;
	visibility: Visibility;
}

export interface Tenant {
	id: string;
	civility: Civility;
	name: string;
	phone: string;
}

export interface Lease {
	id: string;
	unitId: string;
	tenantId: string;
	startDate: string;
	rent: number;
	charges: number;
	deposit: number;
	/** Jour d'échéance dans le mois. */
	dueDay: number;
	/** Durée indéterminée (par défaut) ou déterminée. */
	term?: 'open' | 'fixed';
	/** Fin effective du bail (remise des clés). Le bail est terminé à partir de cette date. */
	endDate?: string;
	notice?: Notice;
	/** Qui détient la caution : l'agence ou le propriétaire. */
	depositHolder?: DepositHolder;
}

/** Préavis : date, origine, motif, date de fin (articles 45 et 46, lecture à confirmer). */
export interface Notice {
	givenOn: string;
	by: 'tenant' | 'landlord';
	reason: string;
	effectiveDate: string;
}

/** Mouvement du compte de caution, en ajout seul (D15). */
export type DepositMovementKind = 'received' | 'retention' | 'rent_offset' | 'refund' | 'claim' | 'holder_change';

export interface DepositMovement {
	id: string;
	leaseId: string;
	date: string;
	kind: DepositMovementKind;
	amount: number;
	label: string;
	/** Justificatif (devis, facture, photo, accord écrit). */
	proof?: string;
	/** Ligne d'état des lieux classée « imputable au locataire » (obligatoire pour une retenue). */
	inspectionItemId?: string;
}

export interface RentDue {
	id: string;
	leaseId: string;
	/** « aaaa-mm » */
	period: string;
	dueDate: string;
	amount: number;
}

export interface Allocation {
	rentDueId: string;
	period: string;
	amount: number;
}

export interface Payment {
	id: string;
	leaseId: string;
	date: string;
	amount: number;
	method: PaymentMethod;
	reference?: string;
	status: PaymentStatus;
	receiptNumber: string;
	allocations: Allocation[];
}

export interface Expense {
	id: string;
	propertyId: string;
	date: string;
	label: string;
	amount: number;
}

export interface Dataset {
	today: string;
	/** L'organisation (agence ou bailleur particulier) à qui appartiennent toutes ces lignes. */
	agency: Agency;
	owners: Owner[];
	mandates: Mandate[];
	properties: Property[];
	units: Unit[];
	tenants: Tenant[];
	leases: Lease[];
	dues: RentDue[];
	payments: Payment[];
	expenses: Expense[];
	/** Baux signés qui commencent plus tard (unités réservées) et leurs locataires. */
	upcomingLeases?: Lease[];
	upcomingTenants?: Tenant[];
	depositMovements?: DepositMovement[];
	/** Décomptes de sortie déjà clos. */
	settlements?: ClosedSettlement[];
}

/** Décompte de sortie clos, avec l'état des lieux qui le justifie. */
export interface ClosedSettlement {
	leaseId: string;
	date: string;
	inspectionDate: string;
	deposit: number;
	lines: { label: string; amount: number; proof?: string }[];
	refund: number;
	claim: number;
	refundMethod: string;
}
