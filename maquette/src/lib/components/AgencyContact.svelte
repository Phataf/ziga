<script lang="ts">
	/** Carte de contact de l'agence, vue par le propriétaire et le locataire. */
	import { MessageCircle, Phone, ShieldCheck } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { demo } from '$lib/demo.svelte';
	import { formatPhone } from '$lib/format';
	import { waLink } from '$lib/whatsapp';

	let { message = '' }: { message?: string } = $props();
	const agency = $derived(demo.data.agency);
</script>

<section class="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="titre-agence-contact">
	<p class="flex items-center gap-2 text-base text-muted-foreground">
		<ShieldCheck class="size-5 text-primary" aria-hidden="true" /> Votre agence gestionnaire
	</p>
	<div>
		<h2 id="titre-agence-contact" class="text-lg font-semibold">{agency.name}</h2>
		<p class="text-muted-foreground">{agency.address}</p>
		<p class="text-muted-foreground tabular-nums">{formatPhone(agency.phone)}</p>
	</div>
	<div class="grid grid-cols-2 gap-2">
		<Button variant="whatsapp" target="_blank" rel="noopener" href={waLink(agency.phone, message)}>
			<MessageCircle aria-hidden="true" /> WhatsApp
		</Button>
		<Button variant="outline" href="tel:{agency.phone}"><Phone aria-hidden="true" /> Appeler</Button>
	</div>
</section>
