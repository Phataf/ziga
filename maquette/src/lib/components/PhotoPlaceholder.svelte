<script lang="ts">
	/** Photo de remplacement neutre (aucune vraie photo de bien dans la maquette). */
	let { index = 0, total = 1, label = '' }: { index?: number; total?: number; label?: string } = $props();

	const palettes = [
		['#d9e7dd', '#a9c6b2'],
		['#efe3cf', '#d8c3a0'],
		['#dfe6ef', '#b3c2d6'],
		['#eadfe6', '#ccb2c2'],
		['#e7ead6', '#c3c9a0']
	];
	const [bg, fg] = $derived(palettes[index % palettes.length]);
</script>

<svg viewBox="0 0 400 260" class="block h-full w-full" role="img" aria-label={`Photo ${index + 1} sur ${total} (illustration)`}>
	<rect width="400" height="260" fill={bg} />
	<g fill={fg}>
		<polygon points="120,150 200,85 280,150" />
		<rect x="140" y="150" width="120" height="70" />
	</g>
	<rect x="185" y="180" width="30" height="40" fill={bg} />
	<rect x="152" y="165" width="22" height="18" fill={bg} />
	<rect x="226" y="165" width="22" height="18" fill={bg} />
	<text x="200" y="248" text-anchor="middle" font-size="16" fill="#4b5563" font-family="system-ui, sans-serif">
		{label || `Photo ${index + 1}/${total}`}
	</text>
</svg>
