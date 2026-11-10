/**
 * Base locale synchronisée (lot 05, D07, D30) : une base SQLite dans le navigateur, tenue à jour par PowerSync.
 * - Ouverte au premier écran de gestion, jamais côté serveur (le SDK est chargé à la demande).
 * - Une seule personne par base : si une autre personne se connecte sur ce navigateur, la base est vidée d'abord.
 * - Vidée à la déconnexion, ou quand l'API refuse la session (401) : rien ne reste sur l'appareil.
 * - Les écrans lisent par `watch` : la requête est relancée à chaque changement des tables qu'elle lit.
 * - Une modification refusée par le serveur est gardée dans « Modifications non acceptées » et notifiée (étape 4).
 */
import type { PowerSyncDatabase, SyncStatus } from '@powersync/web';
import { auth } from '../auth/auth.svelte';
import { acknowledgeRejection, noticeOf, recordRejections, rejectionRows, type RejectionNotice } from './rejections';
import { syncState, type SyncState } from './status';

const OWNER_KEY = 'ziga:base-locale';
const DB_FILE = 'ziga.db';

function storage(): Storage | undefined {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

class Sync {
	/** Base ouverte (écrans de gestion) ; null avant ou après une déconnexion. */
	db = $state<PowerSyncDatabase | null>(null);
	online = $state(typeof navigator === 'undefined' ? true : navigator.onLine);
	connected = $state(false);
	hasSynced = $state(false);
	downloading = $state(false);
	pending = $state(0);
	state = $derived<SyncState>(
		syncState({
			online: this.online,
			connected: this.connected,
			hasSynced: this.hasSynced,
			downloading: this.downloading,
			pending: this.pending
		})
	);
	/** Dernier envoi dont des modifications ont été refusées : notification jusqu'à ce que la personne la ferme. */
	notice = $state<RejectionNotice | null>(null);
	#opening: Promise<PowerSyncDatabase> | null = null;
	#stopListening: (() => void)[] = [];

	constructor() {
		auth.onSignOut(() => void this.clear());
		// Tests de bout en bout seulement : constante fixée au build (PUBLIC_E2E=1). Absente, ce code et le module
		// e2e-hook disparaissent de la version construite.
		if (__ZIGA_E2E__ && typeof window !== 'undefined') {
			void import('./e2e-hook').then((m) => m.installE2EHook(() => this.db, DB_FILE));
		}
		if (typeof window !== 'undefined') {
			window.addEventListener('online', () => (this.online = true));
			window.addEventListener('offline', () => (this.online = false));
		}
	}

	/** Ouvre la base de la personne connectée et lance la synchronisation (sans attendre la première). */
	start(): Promise<PowerSyncDatabase> {
		this.#opening ??= this.#open().catch((error) => {
			this.#opening = null;
			throw error;
		});
		return this.#opening;
	}

	async #open(): Promise<PowerSyncDatabase> {
		const userId = auth.user?.id;
		if (!userId) throw new Error('Synchronisation sans personne connectée.');
		const [{ PowerSyncDatabase }, { AppSchema }, { ZigaConnector }] = await Promise.all([
			import('@powersync/web'),
			import('./schema'),
			import('./connector')
		]);
		const db = new PowerSyncDatabase({ schema: AppSchema, database: { dbFilename: DB_FILE } });
		await db.init();
		// Autre personne que la dernière sur ce navigateur : rien de ses données ne doit rester visible.
		const owner = storage()?.getItem(OWNER_KEY);
		if (owner && owner !== userId) await db.disconnectAndClear();
		try {
			storage()?.setItem(OWNER_KEY, userId);
		} catch {
			// stockage refusé : la base sera vidée à la déconnexion de toute façon
		}
		this.#follow(db);
		this.db = db;
		void db.connect(
			new ZigaConnector(async (database, rejected) => {
				await recordRejections(database, rejectionRows(rejected));
				this.notice = noticeOf(rejected);
			})
		);
		return db;
	}

	#follow(db: PowerSyncDatabase): void {
		const apply = (s: SyncStatus) => {
			this.connected = s.connected;
			this.hasSynced = s.hasSynced ?? false;
			this.downloading = s.dataFlowStatus.downloading;
		};
		apply(db.currentStatus);
		this.#stopListening.push(db.registerListener({ statusChanged: apply }));
		const controller = new AbortController();
		db.watch(
			'SELECT count(*) AS n FROM ps_crud',
			[],
			{ onResult: (r) => (this.pending = Number(r.rows?._array[0]?.n ?? 0)) },
			{ signal: controller.signal }
		);
		this.#stopListening.push(() => controller.abort());
	}

	/**
	 * Lecture locale surveillée : `onRows` reçoit les lignes maintenant, puis à chaque changement des tables lues.
	 * Renvoie la fonction qui arrête la surveillance (à appeler quand l'écran se ferme).
	 */
	watch<T>(sql: string, params: unknown[], onRows: (rows: T[]) => void, onError?: (error: Error) => void): () => void {
		const controller = new AbortController();
		void this.start().then(
			(db) => {
				if (controller.signal.aborted) return;
				db.watch(sql, params, { onResult: (r) => onRows((r.rows?._array ?? []) as T[]), onError }, { signal: controller.signal });
			},
			(error: Error) => onError?.(error)
		);
		return () => controller.abort();
	}

	/** Ferme la notification des modifications refusées (elles restent dans la liste). */
	dismissNotice(): void {
		this.notice = null;
	}

	/** « J'ai compris » : retire un refus de la liste « Modifications non acceptées » de l'appareil. */
	async acknowledgeRejection(id: string): Promise<void> {
		const db = this.db ?? (await this.start());
		await acknowledgeRejection(db, id);
	}

	/** Déconnexion : synchronisation arrêtée et base locale vidée (lot 05, point 9). */
	async clear(): Promise<void> {
		const opening = this.#opening;
		this.#opening = null;
		for (const stop of this.#stopListening.splice(0)) stop();
		let db = this.db ?? (await opening?.catch(() => null)) ?? null;
		this.db = null;
		// Base remplie lors d'une visite précédente et pas encore ouverte dans cet onglet : on l'ouvre pour la vider.
		const owner = storage()?.getItem(OWNER_KEY);
		if (!db && owner && typeof window !== 'undefined') {
			const [{ PowerSyncDatabase }, { AppSchema }] = await Promise.all([import('@powersync/web'), import('./schema')]);
			db = new PowerSyncDatabase({ schema: AppSchema, database: { dbFilename: DB_FILE } });
		}
		this.connected = false;
		this.hasSynced = false;
		this.downloading = false;
		this.pending = 0;
		this.notice = null;
		try {
			storage()?.removeItem(OWNER_KEY);
		} catch {
			// rien
		}
		if (db) {
			await db.disconnectAndClear();
			await db.close();
		}
	}
}

export const sync = new Sync();
