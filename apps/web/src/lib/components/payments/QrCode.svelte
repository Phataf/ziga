<script lang="ts">
	/**
	 * QR code en SVG (lot 09) : la matrice vient d'uqr, la même bibliothèque que le PDF du serveur ; un seul chemin,
	 * lisible à l'écran comme à l'impression. Décoratif pour les lecteurs d'écran : l'adresse est écrite à côté.
	 */
	import { encode } from 'uqr';

	let { value, size = 128, label }: { value: string; size?: number; label: string } = $props();

	const qr = $derived(encode(value, { ecc: 'M', border: 2 }));
	const path = $derived.by(() => {
		let d = '';
		qr.data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
		return d;
	});
</script>

<svg
	width={size}
	height={size}
	viewBox={`0 0 ${qr.size} ${qr.size}`}
	shape-rendering="crispEdges"
	role="img"
	aria-label={label}
	data-testid="qr-code"
	data-value={value}
	class="bg-white"
>
	<rect width={qr.size} height={qr.size} fill="#fff" />
	<path d={path} fill="#000" />
</svg>
