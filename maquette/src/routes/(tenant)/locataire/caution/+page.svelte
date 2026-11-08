<script lang="ts">
	/** Caution et décompte (D15) : le compte de caution de chaque bail, avec les justificatifs de chaque retenue. */
	import { Paperclip, ShieldCheck } from '@lucide/svelte';
	import OrgTag from '$lib/components/OrgTag.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Timeline from '$lib/components/Timeline.svelte';
	import { demo } from '$lib/demo.svelte';
	import { depositBalance, movementLabel } from '$lib/deposit';
	import { formatDate, formatFCFA } from '$lib/format';

	const leases = $derived(demo.tenantLeases);
	const current = $derived(leases.find((l) => l.current));
</script>

<PageHeader title="Caution et décompte" subtitle="Ce que vous avez versé, ce qui a été retenu et pourquoi" />

<main class="page space-y-4 pt-3" data-testid="caution-locataire">
	{#if current}
		<section class="space-y-1 rounded-xl border border-primary/30 bg-success-soft p-4" aria-label="Caution en cours">
			<p class="flex items-center gap-2 text-base"><ShieldCheck class="size-5 text-primary" aria-hidden="true" /> Caution de votre logement actuel</p>
			<p class="text-3xl font-bold text-primary" data-testid="caution-en-cours">{formatFCFA(depositBalance(current.movements))}</p>
			<p class="text-base">Détenue par {current.depositHolder === 'owner' ? 'le propriétaire' : current.organization.name}. Elle vous sera rendue à la sortie, moins les réparations justifiées.</p>
		</section>
	{/if}

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
		{#each leases as l (l.leaseId)}
			<section class="space-y-3 rounded-xl border bg-card p-4" aria-label="Caution — {l.property.name}" data-testid="compte-caution">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h2 class="text-lg font-semibold">{l.property.name} — {l.unit.label}</h2>
					<OrgTag organization={l.organization} />
				</div>
				{#if l.settlement}
					<div class="space-y-2 rounded-lg bg-muted p-3" data-testid="decompte-passe">
						<p class="font-semibold">Décompte de sortie du {formatDate(l.settlement.date)}</p>
						<dl class="space-y-1 text-base">
							<div class="flex justify-between gap-3"><dt>Caution versée</dt><dd class="font-semibold tabular-nums">{formatFCFA(l.settlement.deposit)}</dd></div>
							{#each l.settlement.lines as x (x.label)}
								<div class="flex justify-between gap-3">
									<dt class="min-w-0">{x.label}{#if x.proof}<span class="flex items-center gap-1 text-muted-foreground"><Paperclip class="size-4" aria-hidden="true" />{x.proof}</span>{/if}</dt>
									<dd class="shrink-0 tabular-nums">− {formatFCFA(x.amount)}</dd>
								</div>
							{/each}
							<div class="flex justify-between gap-3 border-t pt-2 text-lg"><dt class="font-semibold">Restitué</dt><dd class="font-bold text-primary tabular-nums" data-testid="restitution">{formatFCFA(l.settlement.refund)}</dd></div>
						</dl>
					</div>
				{/if}
				<Timeline
					label="Mouvements de la caution"
					events={l.movements.map((m) => ({
						date: m.date,
						title: `${movementLabel[m.kind]} : ${formatFCFA(m.amount)}`,
						detail: m.label,
						attachment: m.proof,
						organization: l.organization.name,
						tone: m.kind === 'received' || m.kind === 'refund' ? 'success' : 'warning'
					}))}
				/>
			</section>
		{/each}
	</div>
	<p class="text-base text-muted-foreground">Aucune retenue sans constat de l’état des lieux et sans justificatif. En cas de désaccord, signalez-le à l’agence avant la restitution.</p>
</main>
