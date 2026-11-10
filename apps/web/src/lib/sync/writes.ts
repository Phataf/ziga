/**
 * Écritures locales (lot 05, étape 3, docs/SYNC.md) : l'écran écrit dans la base de l'appareil, la file de PowerSync
 * envoie l'opération à l'API (POST /sync/upload), qui la valide et l'applique avec les mêmes règles que sa route.
 * Les valeurs écrites sont celles du schéma Zod partagé, déjà validées et normalisées (comme le serveur les
 * enregistrera) : l'écran affiche tout de suite ce que la synchronisation confirmera.
 */
import type { PowerSyncDatabase } from '@powersync/web';
import type { UpdateOrganizationOutput as OrganizationSettings } from '@ziga/shared/organizations';
import { commissionColumns, type CreateMandateData, type MandateTerms, type OwnerData } from '@ziga/shared/owners';

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
