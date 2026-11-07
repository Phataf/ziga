/**
 * Type d'appareil d'après la largeur de la fenêtre (docs/UX.md §3).
 * Les composants qui changent de forme selon l'appareil (tableau ou cartes, menu latéral ou onglets)
 * s'affichent avec {#if}, pas en masquant l'autre version : un seul arbre, accessible et léger.
 */
export type DeviceKind = 'phone' | 'tablet' | 'desktop';

export const TABLET_MIN = 768; // 48 rem, préfixe Tailwind md:
export const DESKTOP_MIN = 1280; // 80 rem, préfixe Tailwind xl:

export function deviceOf(width: number): DeviceKind {
	if (width >= DESKTOP_MIN) return 'desktop';
	if (width >= TABLET_MIN) return 'tablet';
	return 'phone';
}
