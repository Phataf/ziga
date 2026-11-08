/**
 * Erreur métier ou technique, renvoyée au client sous la forme uniforme `{ code, message, details }`.
 * `code` est stable (en anglais, MAJUSCULES) ; `message` est en français, lisible par l'utilisateur.
 */
export class AppError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status = 400,
		public readonly details?: unknown
	) {
		super(message);
		this.name = 'AppError';
	}
}

export interface ErrorBody {
	code: string;
	message: string;
	details?: unknown;
}
