/** Modèle simplifié de la maquette. Noms en anglais (glossaire CLAUDE.md §6). */

export type UnitStatus = 'free' | 'rented' | 'reserved' | 'unavailable';
export type Visibility = 'internal' | 'published';
export type PaymentMethod = 'cash' | 'orange_money' | 'moov_money' | 'transfer';
/** validated = validé ; to_reconcile = Mobile Money déclaré, à rapprocher (CLAUDE.md §5.6). */
export type PaymentStatus = 'validated' | 'to_reconcile';
export type Civility = 'M.' | 'Mme';

export interface Agency {
	id: string;
	name: string;
	phone: string;
	address: string;
}

export interface Owner {
	id: string;
	civility: Civility;
	name: string;
	phone: string;
	residence: string;
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
	status: UnitStatus;
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
}
