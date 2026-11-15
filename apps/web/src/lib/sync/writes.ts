/**
 * Écritures locales (lot 05, étape 3, docs/SYNC.md) : l'écran écrit dans la base de l'appareil, la file de PowerSync
 * envoie l'opération à l'API (POST /sync/upload), qui la valide et l'applique avec les mêmes règles que sa route.
 * Les valeurs écrites sont celles du schéma Zod partagé, déjà validées et normalisées (comme le serveur les
 * enregistrera) : l'écran affiche tout de suite ce que la synchronisation confirmera.
 */
import type { PowerSyncDatabase } from '@powersync/web';
import type { UpdateOrganizationOutput as OrganizationSettings } from '@ziga/shared/organizations';
import { newId } from '@ziga/shared/ids';
import { commissionColumns, type CreateMandateData, type MandateTerms, type OwnerData } from '@ziga/shared/owners';
import type {
	CreateDepositAccountData,
	CreateLeaseData,
	CreateTenantData,
	DepositHolderChangeData,
	DepositReceiptData,
	LeaseTerms,
	TenantData,
	TenantIdentity
} from '@ziga/shared/leases';
import type {
	CreateMediaData,
	CreatePropertyData,
	CreateUnitData,
	PropertyData,
	TechnicalStatusData,
	UnitData
} from '@ziga/shared/properties';

/** Paramètres de l'organisation : une transaction locale ; seuls les champs modifiés partent (PATCH). */
export async function saveOrganizationSettings(db: PowerSyncDatabase, organizationId: string, s: OrganizationSettings): Promise<void> {
	await db.writeTransaction(async (tx) => {
		await tx.execute(
			`UPDATE organizations SET legal_name = ?, trade_name = ?, phone = ?, address = ?, commune = ?, po_box = ?, rccm = ?, ifu = ? WHERE id = ?`,
			[
				s.legalName,
				s.tradeName ?? null,
				s.phone,
				s.address ?? null,
				s.commune,
				s.poBox ?? null,
				s.rccm ?? null,
				s.ifu ?? null,
				organizationId
			]
		);
		const r = s.representative;
		// Représentant légal : synchronisé pour le directeur seulement ; sans sa ligne, rien à écrire.
		if (r) {
			await tx.execute(
				`UPDATE organization_representatives SET rep_name = ?, rep_title = ?, rep_profession = ?, rep_address = ?, rep_nationality = ?,
				rep_id_type = ?, rep_id_type_other = ?, rep_id_number = ?, rep_id_issued_on = ?, rep_id_issued_by = ? WHERE id = ?`,
				[
					r.name,
					r.title,
					r.profession,
					r.address,
					r.nationality,
					r.idType,
					r.idTypeOther,
					r.idNumber,
					r.idIssuedOn,
					r.idIssuedBy,
					organizationId
				]
			);
		}
	});
}

// ---------------------------------------------------------------- lot 06 : propriétaires et mandats

type Execute = { execute(sql: string, params?: unknown[]): Promise<unknown> };

const b = (v: boolean) => (v ? 1 : 0);

function ownerColumns(o: OwnerData) {
	return {
		type: o.type,
		name: o.name,
		phone: o.phone,
		email: o.email,
		address: o.address,
		country: o.country,
		representative_name: o.representative?.name ?? null,
		representative_phone: o.representative?.phone ?? null,
		notes: o.notes
	};
}

function termColumns(t: MandateTerms) {
	return {
		starts_on: t.startsOn,
		ends_on: t.endsOn,
		...commissionColumns(t.commission),
		can_publish: b(t.canPublish),
		can_take_photos: b(t.canTakePhotos),
		can_collect_funds: b(t.canCollectFunds),
		can_sign_leases: b(t.canSignLeases),
		exclusive: b(t.exclusive)
	};
}

async function insert(tx: Execute, table: string, row: Record<string, unknown>): Promise<void> {
	const columns = Object.keys(row);
	await tx.execute(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, Object.values(row));
}

async function update(tx: Execute, table: string, id: string, organizationId: string, row: Record<string, unknown>): Promise<void> {
	const columns = Object.keys(row);
	await tx.execute(`UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND organization_id = ?`, [
		...Object.values(row),
		id,
		organizationId
	]);
}

/**
 * Mandat créé sur l'appareil : actif, en version 1, comme le serveur le créera ; seules les colonnes que le serveur
 * accepte depuis l'appareil sont écrites (docs/SYNC.md §5).
 */
async function insertMandate(tx: Execute, organizationId: string, m: CreateMandateData): Promise<void> {
	await insert(tx, 'mandates', {
		id: m.id,
		organization_id: organizationId,
		owner_id: m.ownerId,
		type: m.type,
		...termColumns(m),
		status: 'active',
		version: 1
	});
}

/** Création rapide : la fiche et, s'il y en a un, son mandat, dans une seule transaction locale. */
export async function createOwnerWithMandate(
	db: PowerSyncDatabase,
	organizationId: string,
	owner: OwnerData & { id: string },
	mandate: CreateMandateData | null
): Promise<void> {
	await db.writeTransaction(async (tx) => {
		await insert(tx, 'owners', { id: owner.id, organization_id: organizationId, ...ownerColumns(owner), status: 'active' });
		if (mandate) await insertMandate(tx, organizationId, mandate);
	});
}

/** Coordonnées modifiées : seules les colonnes changées partent (PATCH). */
export async function saveOwner(db: PowerSyncDatabase, organizationId: string, id: string, owner: OwnerData): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'owners', id, organizationId, ownerColumns(owner)));
}

/** Archivage demandé : le serveur le refuse si un mandat est encore actif ; la valeur du serveur revient alors. */
export async function archiveOwner(db: PowerSyncDatabase, organizationId: string, id: string): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'owners', id, organizationId, { status: 'archived' }));
}

export async function createMandate(db: PowerSyncDatabase, organizationId: string, m: CreateMandateData): Promise<void> {
	await db.writeTransaction((tx) => insertMandate(tx, organizationId, m));
}

/** Conditions modifiées : le serveur en fait la version suivante (la version locale suit à la synchronisation). */
export async function saveMandateTerms(db: PowerSyncDatabase, organizationId: string, id: string, terms: MandateTerms): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'mandates', id, organizationId, termColumns(terms)));
}

/** Révocation : statut, motif et autorisations retirées ; la date et la version viennent du serveur. */
export async function revokeMandate(db: PowerSyncDatabase, organizationId: string, id: string, reason: string): Promise<void> {
	await db.writeTransaction((tx) =>
		update(tx, 'mandates', id, organizationId, {
			status: 'revoked',
			revocation_reason: reason,
			can_publish: 0,
			can_take_photos: 0,
			can_collect_funds: 0,
			can_sign_leases: 0
		})
	);
}

// ---------------------------------------------------------------- lot 07 : biens, unités, photos

/** Tableau écrit dans la base locale : texte JSON, comme PowerSync le reçoit du serveur. */
const json = (v: unknown[]) => JSON.stringify(v);

function propertyColumns(p: PropertyData) {
	return {
		owner_id: p.ownerId,
		type: p.type,
		operation: p.operation,
		name: p.name,
		commune_id: p.communeId,
		neighborhood_id: p.neighborhoodId,
		address_hint: p.addressHint,
		gps_lat: p.gps?.lat ?? null,
		gps_lng: p.gps?.lng ?? null,
		gps_accuracy_m: p.gps?.accuracyM ?? null,
		declared_land_documents: json(p.declaredLandDocuments),
		notes: p.notes
	};
}

function unitColumns(u: UnitData) {
	return {
		type: u.type,
		label: u.label,
		bedrooms: u.rooms.bedrooms,
		living_rooms: u.rooms.livingRooms,
		kitchens: u.rooms.kitchens,
		bathrooms: u.rooms.bathrooms,
		terraces: u.rooms.terraces,
		laundries: u.rooms.laundries,
		surface_m2: u.surfaceM2,
		land_area_m2: u.landAreaM2,
		usage: u.usage,
		furnished: b(u.furnished),
		amenities: json(u.amenities),
		rent: u.rent,
		charges: u.charges,
		deposit_amount: u.depositAmount,
		advance_months: u.advanceMonths
	};
}

/**
 * Bien créé sur l'appareil, en brouillon, comme le serveur le créera ; avec, s'il y en a un, le mandat qui le couvre
 * (portée sur le bien entier : la base pose celles des unités). Une seule transaction locale.
 */
export async function createProperty(
	db: PowerSyncDatabase,
	organizationId: string,
	property: CreatePropertyData,
	mandateId: string | null
): Promise<void> {
	await db.writeTransaction(async (tx) => {
		await insert(tx, 'properties', {
			id: property.id,
			organization_id: organizationId,
			...propertyColumns(property),
			record_status: 'draft'
		});
		if (mandateId) {
			await insert(tx, 'mandate_scopes', {
				id: newId(),
				organization_id: organizationId,
				mandate_id: mandateId,
				property_id: property.id
			});
		}
	});
}

/** Bien modifié (localisation, nom…) : seules les colonnes changées partent. */
export async function saveProperty(db: PowerSyncDatabase, organizationId: string, id: string, property: PropertyData): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'properties', id, organizationId, propertyColumns(property)));
}

/** Fiche du bien ou de l'unité : « active » ou « archived » ; le serveur applique ses règles (localisation, unités). */
export async function setRecordStatus(
	db: PowerSyncDatabase,
	organizationId: string,
	table: 'properties' | 'units',
	id: string,
	status: 'active' | 'archived'
): Promise<void> {
	await db.writeTransaction((tx) => update(tx, table, id, organizationId, { record_status: status }));
}

/** Unités créées sur l'appareil, en brouillon et prêtes, dans une seule transaction locale. */
export async function createUnits(db: PowerSyncDatabase, organizationId: string, units: CreateUnitData[]): Promise<void> {
	await db.writeTransaction(async (tx) => {
		for (const u of units) {
			await insert(tx, 'units', {
				id: u.id,
				organization_id: organizationId,
				property_id: u.propertyId,
				...unitColumns(u),
				record_status: 'draft',
				technical_status: 'ready'
			});
		}
	});
}

export async function saveUnit(db: PowerSyncDatabase, organizationId: string, id: string, unit: UnitData): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'units', id, organizationId, unitColumns(unit)));
}

/** État technique (le seul changement de statut ouvert à l'agent de terrain, sur ses unités). */
export async function setTechnicalStatus(db: PowerSyncDatabase, organizationId: string, id: string, s: TechnicalStatusData): Promise<void> {
	await db.writeTransaction((tx) =>
		update(tx, 'units', id, organizationId, {
			technical_status: s.technicalStatus,
			technical_reason: s.reason,
			technical_expected_on: s.expectedOn
		})
	);
}

export async function assignUnit(db: PowerSyncDatabase, organizationId: string, id: string, agentId: string | null): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'units', id, organizationId, { assigned_agent_id: agentId }));
}

/** Photo annoncée sur l'appareil (le fichier attend dans la file d'envoi) : en attente, comme le serveur la créera. */
export async function createMedia(db: PowerSyncDatabase, organizationId: string, m: CreateMediaData): Promise<void> {
	await db.writeTransaction((tx) =>
		insert(tx, 'media', {
			id: m.id,
			organization_id: organizationId,
			property_id: m.propertyId,
			unit_id: m.unitId,
			kind: 'photo',
			mime_type: m.mimeType,
			byte_size: m.byteSize,
			position: m.position,
			caption: m.caption,
			status: 'pending'
		})
	);
}

/** Nouvel ordre de la galerie : les positions changées, dans une seule transaction. */
export async function reorderMedia(
	db: PowerSyncDatabase,
	organizationId: string,
	moves: { id: string; position: number }[]
): Promise<void> {
	await db.writeTransaction(async (tx) => {
		for (const m of moves) await update(tx, 'media', m.id, organizationId, { position: m.position });
	});
}

export async function saveMediaCaption(db: PowerSyncDatabase, organizationId: string, id: string, caption: string | null): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'media', id, organizationId, { caption }));
}

/** Retrait : le serveur efface les fichiers ; la ligne quitte l'appareil à la synchronisation. */
export async function removeMedia(db: PowerSyncDatabase, organizationId: string, id: string): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'media', id, organizationId, { status: 'removed' }));
}

/**
 * Rattachement d'un bien entier à un mandat (assistant, étape des photos) : la portée part par la synchronisation et le
 * serveur la contrôle comme les autres (mandat en vigueur, propriétaire du bien, règle 12). Refusée, elle arrive dans
 * « Modifications non acceptées » et disparaît de l'appareil.
 */
export async function attachMandate(db: PowerSyncDatabase, organizationId: string, propertyId: string, mandateId: string): Promise<void> {
	await db.writeTransaction((tx) =>
		insert(tx, 'mandate_scopes', { id: newId(), organization_id: organizationId, mandate_id: mandateId, property_id: propertyId })
	);
}

// ---------------------------------------------------------------- lot 08 : locataires, baux, cautions

/**
 * Colonnes d'un locataire. L'état civil et la pièce d'identité vont dans `tenant_identities` (stream réservé au
 * directeur et au gestionnaire) : deux tables locales, donc deux opérations, comme l'organisation et son représentant.
 */
function tenantColumns(t: TenantData) {
	return {
		civility: t.civility,
		full_name: t.fullName,
		phone: t.phone,
		secondary_phone: t.secondaryPhone,
		nationality: t.nationality,
		profession: t.profession,
		previous_address: t.previousAddress,
		emergency_contact_name: t.emergencyContactName,
		emergency_contact_phone: t.emergencyContactPhone,
		notes: t.notes
	};
}

function identityColumns(i: TenantIdentity) {
	return {
		birth_date: i.birthDate,
		birth_place: i.birthPlace,
		id_type: i.idType,
		id_type_other: i.idTypeOther,
		id_number: i.idNumber,
		id_issued_on: i.idIssuedOn,
		id_issued_by: i.idIssuedBy
	};
}

/** Conditions et paramètres du bail (D24), tels que le serveur les acceptera ; jamais d'occupation. */
function leaseTermColumns(t: Omit<LeaseTerms, 'billingMode'> & { billingMode?: LeaseTerms['billingMode'] }) {
	return {
		starts_on: t.startsOn,
		ends_on: t.endsOn,
		duration_months: t.durationMonths,
		dues_start_on: t.duesStartOn,
		rent: t.rent,
		charges: t.charges,
		periodicity: t.periodicity,
		due_day: t.dueDay,
		...(t.billingMode ? { billing_mode: t.billingMode } : {}),
		advance_months: t.advanceMonths,
		lessor_type: t.lessorType,
		payment_terms: t.paymentTerms,
		penalty_rate_bp: t.penaltyRateBp,
		penalty_grace_days: t.penaltyGraceDays,
		penalty_beneficiary: t.penaltyBeneficiary,
		notice_tenant_fixed_term_months: t.noticeTenantFixedTermMonths,
		notice_tenant_open_ended_months: t.noticeTenantOpenEndedMonths,
		notice_lessor_fixed_term_months: t.noticeLessorFixedTermMonths,
		notice_lessor_open_ended_months: t.noticeLessorOpenEndedMonths,
		reduced_notice_months: t.reducedNoticeMonths,
		reduced_notice_cases: t.reducedNoticeCases,
		early_termination_indemnity_months: t.earlyTerminationIndemnityMonths,
		renewal_mode: t.renewalMode,
		deposit_refund_days: t.depositRefundDays
	};
}

/** Nouveau locataire (et son état civil, s'il est saisi), dans une seule transaction locale. */
export async function createTenant(
	db: PowerSyncDatabase,
	organizationId: string,
	tenant: CreateTenantData,
	identity: TenantIdentity | null
): Promise<void> {
	await db.writeTransaction(async (tx) => {
		await insert(tx, 'tenants', { id: tenant.id, organization_id: organizationId, ...tenantColumns(tenant), status: 'active' });
		if (identity && Object.values(identity).some((v) => v !== null)) {
			await insert(tx, 'tenant_identities', { id: tenant.id, organization_id: organizationId, ...identityColumns(identity) });
		}
	});
}

export async function saveTenant(db: PowerSyncDatabase, organizationId: string, id: string, tenant: TenantData): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'tenants', id, organizationId, tenantColumns(tenant)));
}

/** État civil : la ligne existe si elle a été reçue (directeur, gestionnaire) ; sinon elle est créée. */
export async function saveTenantIdentity(
	db: PowerSyncDatabase,
	organizationId: string,
	id: string,
	identity: TenantIdentity,
	exists: boolean
): Promise<void> {
	await db.writeTransaction((tx) =>
		exists
			? update(tx, 'tenant_identities', id, organizationId, identityColumns(identity))
			: insert(tx, 'tenant_identities', { id, organization_id: organizationId, ...identityColumns(identity) })
	);
}

/**
 * Bail en brouillon, créé sur l'appareil (assistant, étape des conditions). Le découpage est celui choisi dans
 * l'assistant (recopié du réglage de l'organisation) ; le serveur le figera à la validation.
 */
export async function createLeaseDraft(
	db: PowerSyncDatabase,
	organizationId: string,
	lease: CreateLeaseData & { billingMode: LeaseTerms['billingMode'] }
): Promise<void> {
	await db.writeTransaction((tx) =>
		insert(tx, 'leases', {
			id: lease.id,
			organization_id: organizationId,
			unit_id: lease.unitId,
			tenant_id: lease.tenantId,
			...leaseTermColumns(lease),
			status: 'draft',
			version: 1
		})
	);
}

/** Conditions d'un brouillon modifiées (seules les colonnes changées partent). */
export async function saveLeaseDraft(
	db: PowerSyncDatabase,
	organizationId: string,
	id: string,
	terms: LeaseTerms,
	tenantId?: string
): Promise<void> {
	await db.writeTransaction((tx) =>
		update(tx, 'leases', id, organizationId, { ...leaseTermColumns(terms), ...(tenantId ? { tenant_id: tenantId } : {}) })
	);
}

/**
 * Demande de validation : l'appareil montre le statut attendu (signé à venir, ou en vigueur) ; le serveur décide,
 * vérifie les garde-fous et génère les échéances. Refusée (unité déjà louée…), elle arrive dans « Modifications non
 * acceptées » et le bail redevient un brouillon sur l'appareil.
 */
export async function requestLeaseValidation(
	db: PowerSyncDatabase,
	organizationId: string,
	id: string,
	startsOn: string,
	today: string
): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'leases', id, organizationId, { status: startsOn > today ? 'signed' : 'active' }));
}

export async function cancelLease(db: PowerSyncDatabase, organizationId: string, id: string, reason: string): Promise<void> {
	await db.writeTransaction((tx) => update(tx, 'leases', id, organizationId, { status: 'cancelled', cancellation_reason: reason }));
}

/** Changement de loyer : la version envoyée est la suivante ; celle d'avant est la version attendue par le serveur. */
export async function changeRent(
	db: PowerSyncDatabase,
	organizationId: string,
	id: string,
	change: { rent: number; charges: number; effectiveFrom: string; currentVersion: number }
): Promise<void> {
	await db.writeTransaction((tx) =>
		update(tx, 'leases', id, organizationId, {
			rent: change.rent,
			charges: change.charges,
			rent_effective_from: change.effectiveFrom,
			version: change.currentVersion + 1
		})
	);
}

/** Compte de caution (ou de garantie des factures) : détenteur obligatoire ; statut calculé par le serveur. */
export async function createDepositAccount(db: PowerSyncDatabase, organizationId: string, a: CreateDepositAccountData): Promise<void> {
	await db.writeTransaction((tx) =>
		insert(tx, 'deposit_accounts', {
			id: a.id,
			organization_id: organizationId,
			lease_id: a.leaseId,
			type: a.type,
			agreed_amount: a.agreedAmount,
			agreed_months: a.agreedMonths,
			holder: a.holder,
			status: 'pending'
		})
	);
}

/** Montant convenu, tant que le bail est un brouillon. */
export async function saveDepositAgreed(
	db: PowerSyncDatabase,
	organizationId: string,
	id: string,
	agreedAmount: number,
	agreedMonths: number | null
): Promise<void> {
	await db.writeTransaction((tx) =>
		update(tx, 'deposit_accounts', id, organizationId, { agreed_amount: agreedAmount, agreed_months: agreedMonths })
	);
}

/** Versement reçu : un mouvement en ajout seul. */
export async function recordDepositReceipt(db: PowerSyncDatabase, organizationId: string, r: DepositReceiptData): Promise<void> {
	await db.writeTransaction((tx) =>
		insert(tx, 'deposit_movements', {
			id: r.id,
			organization_id: organizationId,
			account_id: r.accountId,
			type: 'received',
			amount: r.amount,
			occurred_on: r.occurredOn,
			reason: r.reason
		})
	);
}

/** Changement de détenteur : un mouvement motivé, jamais une modification du compte. */
export async function changeDepositHolder(
	db: PowerSyncDatabase,
	organizationId: string,
	c: DepositHolderChangeData & { previousHolder: 'organization' | 'owner' }
): Promise<void> {
	await db.writeTransaction((tx) =>
		insert(tx, 'deposit_movements', {
			id: c.id,
			organization_id: organizationId,
			account_id: c.accountId,
			type: 'holder_changed',
			amount: 0,
			previous_holder: c.previousHolder,
			new_holder: c.newHolder,
			occurred_on: c.occurredOn,
			reason: c.reason
		})
	);
}
