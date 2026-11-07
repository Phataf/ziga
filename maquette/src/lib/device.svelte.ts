/** Type d'appareil courant, réactif (voir device.ts). */
import { deviceOf, type DeviceKind } from './device';

export { deviceOf, DESKTOP_MIN, TABLET_MIN, type DeviceKind } from './device';

class Device {
	width = $state(typeof window === 'undefined' ? 360 : window.innerWidth);
	kind: DeviceKind = $derived(deviceOf(this.width));
	isPhone = $derived(this.kind === 'phone');
	isDesktop = $derived(this.kind === 'desktop');
	/** Vue liste-détail côte à côte : tablette en paysage (≥ 1024 px) et ordinateur. */
	twoPane = $derived(this.width >= 1024);

	constructor() {
		if (typeof window === 'undefined') return;
		window.addEventListener('resize', () => (this.width = window.innerWidth), { passive: true });
	}
}

export const device = new Device();
