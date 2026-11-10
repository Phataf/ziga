/**
 * Envoi des modifications locales (lot 05, étape 3) : POST /sync/upload.
 * Le client envoie, par lots, les opérations de sa file PowerSync ; l'API rejoue chacune avec les mêmes
 * validations, permissions, interrupteurs et audit (origine `sync`) que ses routes, et répond toujours 200 avec le
 * résultat de chaque opération : une opération refusée ne bloque jamais la file (docs/SYNC.md).
 */
import { z } from 'zod';

export const SYNC_OPERATIONS = ['PUT', 'PATCH', 'DELETE'] as const;
export type SyncOperationType = (typeof SYNC_OPERATIONS)[number];

/** Lot envoyé en une fois : au plus 100 opérations. */
export const SYNC_BATCH_MAX = 100;

export const syncOperationSchema = z.object({
	/** Clé d'idempotence : identifiant de la base locale et numéro de l'opération dans sa file. */
	key: z.string().min(8).max(200),
	op: z.enum(SYNC_OPERATIONS),
	table: z.string().min(1).max(64),
	/** Identifiant de la ligne (UUIDv7 pour une ligne créée sur l'appareil). */
	id: z.string().min(1).max(200),
	/** Colonnes écrites : toutes pour PUT, seulement celles qui ont changé pour PATCH, aucune pour DELETE. */
	data: z.record(z.string(), z.unknown()).nullish(),
	/**
	 * Organisation de la ligne, lue dans la base locale par le connecteur (lot 06) : un PATCH ne porte que les colonnes
	 * modifiées, jamais `organization_id`. Le serveur ne la croit pas sur parole : membre actif exigé, puis la ligne est
	 * cherchée sous la RLS de cette organisation (une organisation forgée ne mène qu'à un refus).
	 */
	organizationId: z.string().max(64).nullish()
});
export type SyncOperation = z.output<typeof syncOperationSchema>;

export const syncUploadSchema = z.object({ operations: z.array(syncOperationSchema).min(1).max(SYNC_BATCH_MAX) });
export type SyncUploadInput = z.input<typeof syncUploadSchema>;

export type SyncOperationStatus = 'applied' | 'rejected';

export interface SyncOperationResult {
	key: string;
	status: SyncOperationStatus;
	/** Opération déjà reçue : son premier résultat est renvoyé, rien n'est rejoué. */
	replayed: boolean;
	/**
	 * Organisation visée par l'opération, quand le serveur a pu la déterminer : l'appareil range un refus dans la
	 * liste « Modifications non acceptées » de cette organisation seulement (docs/SYNC.md).
	 */
	organizationId?: string;
	/** Refus : code de l'API (FORBIDDEN_ACTION, FEATURE_DISABLED, VALIDATION_ERROR…) et motif lisible. */
	code?: string;
	message?: string;
}

export interface SyncUploadResponse {
	results: SyncOperationResult[];
}
