<script lang="ts">
	/**
	 * Sortie du locataire (D15, règle 14) : préavis, état des lieux guidé pièce par pièce,
	 * décompte de caution (trois variantes du même décompte), validation.
	 * Brouillon enregistré à chaque étape. La validation ajoute des mouvements au compte de caution
	 * (ajout seul) et fait passer l'unité « à remettre en état », jamais directement « disponible ».
	 */
	import { page } from '$app/state';
	import { Camera, CircleAlert, CircleCheck, KeyRound, MessageCircle, Paperclip, ShieldCheck, TriangleAlert } from '@lucide/svelte';
	import AgreementCard from '$lib/components/AgreementCard.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Timeline from '$lib/components/Timeline.svelte';
	import { Button } from '$lib/components/ui/button';
	import ChoiceGroup from '$lib/components/ui/choice/ChoiceGroup.svelte';
	import { Input } from '$lib/components/ui/input';
	import Wizard from '$lib/components/wizard/Wizard.svelte';
	import { demo, settlementOf, type ExitRecord } from '$lib/demo.svelte';
	import { findingLabel, movementLabel, noticeEffectiveDate, remainingAfterOffsets, retentionErrors, variantLabel, type Agreement, type Finding, type Variant } from '$lib/deposit';
	import { addDays } from '$lib/fixtures';
	import { formatDate, formatFCFA, formatMonth, parseAmount } from '$lib/format';
	import { exitInspection, roomsOf } from '$lib/inspection';
	import { cn } from '$lib/utils';
	import { waLink } from '$lib/whatsapp';

	const lease = $derived(demo.data.leases.find((l) => l.id === page.params.leaseId));
	const unit = $derived(lease ? demo.data.units.find((u) => u.id === lease.unitId) : undefined);
	const property = $derived(unit ? demo.data.properties.find((p) => p.id === unit.propertyId) : undefined);
	const tenant = $derived(lease ? demo.data.tenants.find((t) => t.id === lease.tenantId) : undefined);
	const orgName = $derived(demo.full.agency.name);

	function initial(): ExitRecord | undefined {
		const l = demo.data.leases.find((x) => x.id === page.params.leaseId);
		const u = l ? demo.data.units.find((x) => x.id === l.unitId) : undefined;
		if (!l || !u) return undefined;
		const saved = demo.exitOf(l.id);
		if (saved) return structuredClone($state.snapshot(saved) as ExitRecord);
		const effective = l.notice?.effectiveDate ?? noticeEffectiveDate(demo.today, l.term ?? 'open');
		const lastMonth = effective.slice(0, 7);
		return {
			step: 0,
			notice: l.notice,
			keysReturnedOn: demo.today,
			items: exitInspection(l, u, demo.today),
			signedByTenant: false,
			signedByAgency: false,
			variant: 'refund',
			offsetAgreement: {
				kind: 'rent_offset',
				proposedBy: 'tenant',
				proposedOn: addDays(`${lastMonth}-01`, -10),
				text: `Je demande que ma caution serve à payer mon dernier loyer, celui de ${formatMonth(lastMonth)}.`,
				status: 'proposed'
			},
			repairAgreement: {
				kind: 'tenant_repair',
				proposedBy: 'tenant',
				proposedOn: demo.today,
				text: 'Je fais réparer moi-même, par mon artisan, ce qui m’est imputé, avant la contre-visite.',
				status: 'proposed'
			},
			recheckDone: false
		};
	}

	let exit = $state<ExitRecord | undefined>(initial());
	let step = $state(exit?.step ?? 0);
	let reached = $state(exit?.step ?? 0);
	let room = $state(0);
	let savedOn = $state<string | undefined>(demo.exitOf(page.params.leaseId ?? '') ? demo.today : undefined);

	// Préavis saisi pendant la sortie, si le bail n'en avait pas.
	let noticeBy = $state<'tenant' | 'landlord'>('tenant');
	let noticeReason = $state('');
	let noticeGivenOn = $state(demo.today);

	const finalized = $derived(!!demo.exitOf(page.params.leaseId ?? '')?.finalizedOn);
	const rooms = $derived(exit ? roomsOf(exit.items) : []);
	const result = $derived(exit ? settlementOf(demo.data, page.params.leaseId!, exit) : undefined);
	const st = $derived(result?.settlement);
	const settled = $derived(demo.data.settlements?.find((x) => x.leaseId === page.params.leaseId));
	const movements = $derived((demo.data.depositMovements ?? []).filter((m) => m.leaseId === page.params.leaseId).sort((a, b) => a.date.localeCompare(b.date)));

	const steps = [
		{ id: 'preavis', label: 'Préavis' },
		{ id: 'edl', label: 'État des lieux de sortie' },
		{ id: 'decompte', label: 'Décompte de caution' },
		{ id: 'validation', label: 'Validation' }
	];

	const canNext = $derived.by(() => {
		if (!exit) return false;
		if (step === 0) return !!exit.notice || noticeReason.trim().length > 3;
		if (step === 1) return exit.signedByTenant && exit.signedByAgency;
		if (step === 2) return !!st && (exit.variant !== 'tenant_repair' || exit.repairAgreement?.status !== 'proposed');
		return true;
	});

	function onstep(next: number) {
		if (!exit) return;
		if (step === 0 && !exit.notice && next > 0) {
			exit.notice = { givenOn: noticeGivenOn, by: noticeBy, reason: noticeReason.trim(), effectiveDate: noticeEffectiveDate(noticeGivenOn, lease?.term ?? 'open') };
		}
		exit.step = next;
		reached = Math.max(reached, next);
		demo.saveExit(page.params.leaseId!, exit);
		savedOn = demo.today;
	}

	function decide(kind: 'offsetAgreement' | 'repairAgreement', a: Agreement) {
		if (!exit) return;
		exit[kind] = a;
		demo.saveExit(page.params.leaseId!, exit);
	}

	function finish() {
		if (!exit) return;
		demo.finalizeExit(page.params.leaseId!, exit);
	}

	const findings = (Object.keys(findingLabel) as Finding[]).map((f) => ({ value: f, label: findingLabel[f] }));
	const variants = (Object.keys(variantLabel) as Variant[]).map((v) => ({
		value: v,
		label: variantLabel[v],
		hint: v === 'refund' ? 'Réparations retenues, puis le solde est rendu' : v === 'rent_offset' ? 'Sur accord écrit, daté avant le mois' : 'Lignes à 0 FCFA après contre-visite'
	}));

	function message() {
		if (!tenant || !settled) return '';
		return (
			`Bonjour ${tenant.civility} ${tenant.name},\n` +
			`Voici le décompte de votre caution (${property?.name} — ${unit?.label}) :\n` +
			`Caution reçue : ${formatFCFA(settled.deposit)}\n` +
			settled.lines.map((l) => `- ${l.label} : ${formatFCFA(l.amount)}${l.proof ? ` (${l.proof})` : ''}`).join('\n') +
			`\nÀ vous restituer : ${formatFCFA(settled.refund)}${settled.claim ? `\nReste à payer : ${formatFCFA(settled.claim)}` : ''}\n${orgName}`
		);
	}
</script>

{#if !lease || !unit || !property || !tenant || !exit}
	<PageHeader title="Sortie" back="/sorties" backLabel="Préavis et sorties" />
	<p class="p-4">Bail introuvable.</p>
{:else}
	<PageHeader title="Sortie de {tenant.civility} {tenant.name}" subtitle="{property.name} — {unit.label} · caution {formatFCFA(lease.deposit)}" back="/sorties" backLabel="Préavis et sorties" />

	<main class="page pt-3" data-testid="sortie-locataire">
		{#if finalized && settled}
			<div class="space-y-4 md:grid md:grid-cols-[minmax(0,1fr)_22rem] md:items-start md:gap-6 md:space-y-0">
				<section class="space-y-4 rounded-xl border bg-card p-4 md:p-6" aria-labelledby="titre-close" data-testid="sortie-close">
					<div class="flex items-center gap-3">
						<CircleCheck class="size-10 shrink-0 text-primary" aria-hidden="true" />
						<div>
							<h2 id="titre-close" class="text-xl font-bold">Sortie close le {formatDate(settled.date)}</h2>
							<p class="text-base text-muted-foreground">Le bail est terminé. L’unité passe « à remettre en état » : elle ne redevient disponible qu’après les travaux.</p>
						</div>
					</div>
					<p class="text-base text-muted-foreground">À restituer à {tenant.civility} {tenant.name}</p>
					<p class="text-3xl font-bold text-primary" data-testid="restitue">{formatFCFA(settled.refund)}</p>
					<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
						<Button variant="whatsapp" href={waLink(tenant.phone, message())} target="_blank" rel="noopener"><MessageCircle aria-hidden="true" /> Envoyer le décompte</Button>
						<Button variant="outline" href="/biens/{property.id}/{unit.id}">Voir l’unité</Button>
					</div>
				</section>
				<aside class="space-y-2 rounded-xl border bg-card p-4" aria-labelledby="titre-compte-caution">
					<h2 id="titre-compte-caution" class="flex items-center gap-2 text-lg font-semibold"><ShieldCheck class="size-5" aria-hidden="true" /> Compte de caution</h2>
					<p class="text-base text-muted-foreground">Mouvements en ajout seul : rien n’est modifié ni effacé.</p>
					<Timeline
						label="Mouvements du compte de caution"
						testid="mouvements-caution"
						events={movements.map((m) => ({
							date: m.date,
							title: `${movementLabel[m.kind]} : ${formatFCFA(m.amount)}`,
							detail: m.label,
							attachment: m.proof,
							author: orgName,
							tone: m.kind === 'received' ? 'success' : m.kind === 'refund' ? 'success' : 'warning'
						}))}
					/>
				</aside>
			</div>
		{:else}
			<Wizard
				{steps}
				bind:current={step}
				{reached}
				{canNext}
				{onstep}
				finishLabel="Valider et restituer {st ? formatFCFA(st.refund) : ''}"
				savedNote={savedOn ? `Brouillon enregistré le ${formatDate(savedOn)}` : undefined}
				onfinish={finish}
				testid="assistant-sortie"
			>
				{#if step === 0}
					<div class="space-y-4 rounded-xl border bg-card p-4 md:p-6">
						{#if exit.notice}
							<dl class="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="preavis-recap">
								<div class="rounded-lg bg-muted p-3"><dt class="text-base text-muted-foreground">Préavis donné le</dt><dd class="text-lg font-semibold">{formatDate(exit.notice.givenOn)}</dd></div>
								<div class="rounded-lg bg-muted p-3"><dt class="text-base text-muted-foreground">Par</dt><dd class="text-lg font-semibold">{exit.notice.by === 'tenant' ? 'Le locataire' : 'Le bailleur'}</dd></div>
								<div class="rounded-lg bg-muted p-3"><dt class="text-base text-muted-foreground">Fin du préavis</dt><dd class="text-lg font-semibold">{formatDate(exit.notice.effectiveDate)}</dd></div>
							</dl>
							<p class="text-base">Motif : {exit.notice.reason}.</p>
							<p class="text-base text-muted-foreground">Délai appliqué : {lease.term === 'fixed' ? 'deux mois (bail à durée déterminée quitté avant terme)' : 'trois mois (bail à durée indéterminée)'}, lecture des articles 45 et 46 à confirmer par un juriste.</p>
						{:else}
							<ChoiceGroup legend="Qui donne le préavis ?" name="origine" bind:value={noticeBy} options={[{ value: 'tenant', label: 'Le locataire' }, { value: 'landlord', label: 'Le bailleur' }]} />
							<label class="block space-y-1"><span class="font-semibold">Date du préavis</span><Input type="date" bind:value={noticeGivenOn} /></label>
							<label class="block space-y-1"><span class="font-semibold">Motif</span><Input bind:value={noticeReason} placeholder="ex. déménagement" /></label>
							<p class="rounded-lg bg-muted p-3 text-base">Fin du préavis : <strong>{formatDate(noticeEffectiveDate(noticeGivenOn, lease.term ?? 'open'))}</strong></p>
						{/if}
						<p class="flex items-center gap-2 rounded-lg bg-info-soft p-3 text-base text-info-foreground">
							<KeyRound class="size-5 shrink-0" aria-hidden="true" /> Remise des clés et état des lieux de sortie : aujourd’hui, {formatDate(exit.keysReturnedOn)}. Les loyers restent dus jusqu’à la fin du préavis.
						</p>
					</div>
				{:else if step === 1}
					<div class="space-y-4">
						<!-- Pièce par pièce : pastilles qui défilent sur téléphone, toutes visibles sur grand écran. -->
						<div class="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Pièces">
							{#each rooms as r, i (r)}
								{@const flagged = exit.items.some((x) => x.room === r && x.finding === 'tenant')}
								<button
									type="button"
									class={cn('min-h-11 shrink-0 rounded-full border-2 px-4 font-medium', room === i ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card hover:bg-accent')}
									aria-pressed={room === i}
									onclick={() => (room = i)}
								>
									{r}{flagged ? ' · à retenir' : ''}
								</button>
							{/each}
						</div>
						<section class="space-y-4" aria-label="Pièce : {rooms[room]}" data-testid="piece">
							<h3 class="text-lg font-semibold">Pièce {room + 1} sur {rooms.length} : {rooms[room]}</h3>
							{#each exit.items.filter((x) => x.room === rooms[room]) as item (item.id)}
								{@const errors = item.finding === 'tenant' ? retentionErrors(item) : []}
								<article class="space-y-3 rounded-xl border bg-card p-4" data-testid="element-{item.id}">
									<div>
										<p class="font-semibold">{item.element}</p>
										<p class="text-base text-muted-foreground">À l’entrée : {item.entry}</p>
									</div>
									<ChoiceGroup legend="Constat — {item.element}" hideLegend name="constat-{item.id}" bind:value={item.finding} options={findings} columns={2} />
									{#if item.finding !== 'as_entry'}
										<label class="block space-y-1"><span class="font-semibold">Observation</span><Input bind:value={item.note} placeholder="ex. robinet qui fuit" /></label>
									{/if}
									{#if item.finding === 'tenant'}
										<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
											<label class="block space-y-1">
												<span class="font-semibold">Montant de la réparation (FCFA)</span>
												<Input
													inputmode="numeric"
													value={item.amount ? String(item.amount) : ''}
													oninput={(e) => (item.amount = parseAmount((e.currentTarget as HTMLInputElement).value) ?? undefined)}
													data-testid="montant-{item.id}"
												/>
											</label>
											<div class="space-y-1">
												<p class="font-semibold">Justificatif</p>
												{#if item.proof}
													<p class="flex min-h-12 items-center gap-2"><Paperclip class="size-4" aria-hidden="true" /> {item.proof}
														<Button variant="ghost" onclick={() => (item.proof = undefined)}>Retirer</Button></p>
												{:else}
													<Button variant="outline" onclick={() => (item.proof = `Photo datée du ${formatDate(demo.today)}`)}><Camera aria-hidden="true" /> Joindre une photo ou un devis</Button>
												{/if}
											</div>
										</div>
										{#if errors.length}
											<p class="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-base text-destructive" role="alert">
												<CircleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" /> Aucune retenue possible : {errors.join(' ')}
											</p>
										{/if}
									{:else if item.finding === 'normal_wear' || item.finding === 'owner'}
										<p class="text-base text-muted-foreground">Le locataire ne répond ni de l’usure normale ni de la vétusté : aucune retenue (article 20).</p>
									{/if}
								</article>
							{/each}
							<div class="flex gap-2">
								<Button variant="outline" disabled={room === 0} onclick={() => (room -= 1)}>Pièce précédente</Button>
								<Button variant="outline" disabled={room === rooms.length - 1} onclick={() => (room += 1)} data-testid="piece-suivante">Pièce suivante</Button>
							</div>
						</section>
						<fieldset class="space-y-2 rounded-xl border bg-card p-4">
							<legend class="px-1 font-semibold">Signatures de l’état des lieux</legend>
							<label class="flex min-h-11 items-center gap-3"><input type="checkbox" class="size-5 accent-[var(--color-primary)]" bind:checked={exit.signedByTenant} /> Signé par {tenant.civility} {tenant.name}</label>
							<label class="flex min-h-11 items-center gap-3"><input type="checkbox" class="size-5 accent-[var(--color-primary)]" bind:checked={exit.signedByAgency} /> Signé par {orgName}</label>
							<p class="text-base text-muted-foreground">État des lieux écrit, daté et signé des deux parties (articles 8 et 9). En cas de désaccord, le décompte passe en contestation.</p>
						</fieldset>
					</div>
				{:else if step === 2 && st && result}
					<div class="space-y-4 xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start xl:gap-6 xl:space-y-0">
						<div class="space-y-4">
							<div class="rounded-xl border bg-card p-4 md:p-6">
								<ChoiceGroup legend="Comment la caution est-elle utilisée ?" name="variante" bind:value={exit.variant} options={variants} columns={1} />
							</div>
							{#if exit.variant === 'rent_offset' && exit.offsetAgreement}
								{#if result.lastDue}
									<p class="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-base text-warning-foreground" role="status" data-testid="reste-degats">
										<TriangleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" />
										Si la caution paie le loyer de {formatMonth(result.lastDue.period)} ({formatFCFA(result.lastDue.balance)}), il restera {formatFCFA(remainingAfterOffsets(lease.deposit, result.offsets))} pour couvrir les dégâts.
									</p>
								{:else}
									<p class="rounded-lg bg-muted p-3 text-base">Le dernier loyer est déjà payé : rien à imputer.</p>
								{/if}
								<AgreementCard agreement={exit.offsetAgreement} proposer="{tenant.civility} {tenant.name}" decider={orgName} today={demo.today} ondecide={(a) => decide('offsetAgreement', a)} testid="accord-imputation" />
							{:else if exit.variant === 'tenant_repair' && exit.repairAgreement}
								<AgreementCard agreement={exit.repairAgreement} proposer="{tenant.civility} {tenant.name}" decider={orgName} today={demo.today} ondecide={(a) => decide('repairAgreement', a)} testid="accord-reparation" />
								{#if exit.repairAgreement.status === 'accepted'}
									<label class="flex min-h-11 items-center gap-3 rounded-xl border bg-card p-4">
										<input type="checkbox" class="size-5 accent-[var(--color-primary)]" bind:checked={exit.recheckDone} />
										Contre-visite faite le {formatDate(demo.today)} : réparations conformes
									</label>
								{/if}
							{/if}
							{#if st.errors.length}
								<ul class="space-y-1 rounded-lg bg-danger-soft p-3 text-base text-destructive" data-testid="refus-retenues">
									{#each st.errors as e (e)}<li class="flex items-start gap-2"><CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{e}</li>{/each}
								</ul>
							{/if}
						</div>

						<section class="space-y-3 rounded-xl border bg-card p-4 md:p-6 xl:sticky xl:top-20" aria-labelledby="titre-decompte" data-testid="decompte">
							<h3 id="titre-decompte" class="text-lg font-semibold">Décompte de sortie</h3>
							<dl class="space-y-2 text-base">
								<div class="flex justify-between gap-3"><dt>Caution reçue</dt><dd class="font-semibold tabular-nums">{formatFCFA(st.deposit)}</dd></div>
								{#each st.lines as l, i (i)}
									<div class="flex justify-between gap-3" data-testid="ligne-decompte">
										<dt class="min-w-0">{l.label}{#if l.proof}<span class="block text-muted-foreground">{l.proof}</span>{/if}</dt>
										<dd class="shrink-0 tabular-nums">− {formatFCFA(l.amount)}</dd>
									</div>
								{/each}
							</dl>
							<div class="border-t pt-3">
								{#if st.claim > 0}
									<p class="text-base text-muted-foreground">Complément à réclamer</p>
									<p class="text-3xl font-bold text-destructive" data-testid="a-reclamer">{formatFCFA(st.claim)}</p>
								{/if}
								<p class="text-base text-muted-foreground">À restituer au locataire</p>
								<p class="text-3xl font-bold text-primary" data-testid="a-restituer">{formatFCFA(st.refund)}</p>
							</div>
							<p class="text-base text-muted-foreground">Caution détenue par {lease.depositHolder === 'owner' ? 'le propriétaire' : orgName}.</p>
						</section>
					</div>
				{:else if step === 3 && st}
					<div class="space-y-4 rounded-xl border bg-card p-4 md:p-6" data-testid="recapitulatif">
						<p class="text-base">En validant :</p>
						<ul class="list-disc space-y-1 pl-5 text-base">
							<li>le bail de {tenant.civility} {tenant.name} se termine le {formatDate(exit.keysReturnedOn)} ;</li>
							<li>le compte de caution reçoit {st.lines.filter((l) => l.amount > 0).length} retenue{st.lines.filter((l) => l.amount > 0).length > 1 ? 's' : ''} et une restitution de {formatFCFA(st.refund)}, sans rien effacer ;</li>
							<li>{unit.label} passe « à remettre en état » ; elle ne sera de nouveau disponible qu’après les travaux.</li>
						</ul>
						<p class="text-3xl font-bold text-primary">{formatFCFA(st.refund)} à restituer</p>
					</div>
				{/if}
			</Wizard>
		{/if}
	</main>
{/if}
