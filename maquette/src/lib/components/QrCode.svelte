<script lang="ts">
	import QRCode from 'qrcode';

	let { value, size = 132 }: { value: string; size?: number } = $props();
	let svg = $state('');

	$effect(() => {
		QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then((s) => (svg = s));
	});
</script>

<div class="bg-white p-1" style:width="{size}px" style:height="{size}px" aria-label="QR code de vérification du reçu" role="img">
	{@html svg}
</div>
