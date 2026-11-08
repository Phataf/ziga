/** Store `device` : type d'appareil courant, réactif à la largeur de la fenêtre. */
import { innerWidth } from 'svelte/reactivity/window';
import { deviceOf, TWO_PANE_MIN, type DeviceKind } from './device';

class Device {
	/** Côté serveur (vitrine), la largeur est inconnue : on rend la forme téléphone, la plus légère. */
	width = $derived(innerWidth.current ?? 360);
	kind: DeviceKind = $derived(deviceOf(this.width));
	isPhone = $derived(this.kind === 'phone');
	isTablet = $derived(this.kind === 'tablet');
	isDesktop = $derived(this.kind === 'desktop');
	twoPane = $derived(this.width >= TWO_PANE_MIN);
}

export const device = new Device();
