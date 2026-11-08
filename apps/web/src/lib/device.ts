/**
 * Type d'appareil d'après la largeur (docs/UX.md §3). Une forme différente selon l'appareil
 * s'affiche avec {#if} sur ce type, jamais en masquant l'autre version en CSS.
 */
export type DeviceKind = 'phone' | 'tablet' | 'desktop';

export const TABLET_MIN = 768; // md:
export const TWO_PANE_MIN = 1024; // lg: liste et détail côte à côte
export const DESKTOP_MIN = 1280; // xl:

export function deviceOf(width: number): DeviceKind {
	if (width >= DESKTOP_MIN) return 'desktop';
	if (width >= TABLET_MIN) return 'tablet';
	return 'phone';
}
