/**
 * Écritures locales (lot 05, étape 3, docs/SYNC.md) : l'écran écrit dans la base de l'appareil, la file de PowerSync
 * envoie l'opération à l'API (POST /sync/upload), qui la valide et l'applique avec les mêmes règles que sa route.
 * Les valeurs écrites sont celles du schéma Zod partagé, déjà validées et normalisées (comme le serveur les
 * enregistrera) : l'écran affiche tout de suite ce que la synchronisation confirmera.
 */
import type { PowerSyncDatabase } from '@powersync/web';
import type { UpdateOrganizationOutput as OrganizationSettings } from '@ziga/shared/organizations';

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
