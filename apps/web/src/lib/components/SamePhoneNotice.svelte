<script lang="ts">
	/**
	 * « Une autre fiche porte ce numéro » (lot 11, dette du lot 10 ter) : sur la fiche d'un locataire ou d'un
	 * propriétaire, les autres fiches actives de la même organisation au même numéro, avec un lien vers chacune. Lu sur
	 * l'appareil (règle 15 : jamais d'une autre organisation). Même nom : doublon probable ; nom différent : colocataire
	 * ou parent. Aucune fusion.
	 */
	import { Users } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { otherRecordsWithSamePhone, type PhoneRecord } from '@ziga/shared/same-phone';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';

	let { kind, record }: { kind: 'tenant' | 'owner'; record: PhoneRecord } = $props();
	const t = fr.samePhone;

	let rows = $state<PhoneRecord[]>([]);
	// Abonnement par numéro, jamais renouvelé à chaque modification de la fiche.
	const phone = $derived(record.phone);

	$effect(() => {
		if (!phone) {
			rows = [];
			return;
		}
		return sync.watch<Record<string, unknown>>(
			kind === 'tenant' ? LOCAL_QUERIES.tenantsSamePhone : LOCAL_QUERIES.ownersSamePhone,
			[organizations.activeId, phone],
			(r) =>
				(rows = r.map((x) => ({
					id: String(x.id),
					name: String(x.name ?? ''),
					phone: String(x.phone ?? ''),
					status: String(x.status ?? '')
				})))
		);
	});

	const others = $derived(otherRecordsWithSamePhone(record, rows));
</script>

{#if others.length}
	<section class="space-y-2 rounded-2xl border border-warning bg-warning-soft p-4 text-warning-foreground" data-testid="meme-numero">
		<h2 class="flex items-center gap-2 text-base font-semibold"><Users class="size-5 shrink-0" aria-hidden="true" />{t.title}</h2>
		<ul class="space-y-1">
			{#each others as o (o.id)}
				<li class="text-base">
					{#if kind === 'tenant'}
						<a class="font-medium underline" href={resolve('/app/locataires/[id]', { id: o.id })} data-testid="meme-numero-lien">{o.name}</a
						>
					{:else}
						<a class="font-medium underline" href={resolve('/app/proprietaires/[id]', { id: o.id })} data-testid="meme-numero-lien"
							>{o.name}</a
						>
					{/if}
					<span class="block text-sm">{o.sameName ? t.sameName : t.otherName}</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}
