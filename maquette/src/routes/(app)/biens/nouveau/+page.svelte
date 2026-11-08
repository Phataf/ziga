<script lang="ts">
	/**
	 * Assistant d'ajout de bien en cinq étapes (audit C2, docs/UX.md §10) :
	 * type et propriétaire, localisation, unités, médias, documents privés.
	 * Brouillon enregistré à chaque étape, reprise possible. Enregistrer n'est jamais publier (règle 7).
	 */
	import { goto } from '$app/navigation';
	import { Camera, Crosshair, FileLock2, Film, Globe, Lock, MapPin, Plus, RotateCcw, Trash2, TriangleAlert, View } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PhotoPlaceholder from '$lib/components/PhotoPlaceholder.svelte';
	import { Button } from '$lib/components/ui/button';
	import ChoiceGroup from '$lib/components/ui/choice/ChoiceGroup.svelte';
	import { Input } from '$lib/components/ui/input';
	import Wizard from '$lib/components/wizard/Wizard.svelte';
	import { demo } from '$lib/demo.svelte';
	import { depositWarning } from '$lib/deposit';
	import { formatDate, formatFCFA, parseAmount, toE164 } from '$lib/format';
	import type { Mandate, Owner, Property, Unit } from '$lib/types';
	import { cn } from '$lib/utils';

	type PropertyType = 'house' | 'building' | 'yard' | 'shop' | 'land';
	interface UnitDraft {
		label: string;
		kind: string;
		rooms: string;
		showers: string;
		furnished: 'no' | 'yes';
		rent: string;
		charges: string;
		depositMonths: string;
		advanceMonths: string;
	}
	interface Values {
		type: string;
		ownerChoice: string;
		ownerKind: 'person' | 'company' | 'joint';
		ownerName: string;
		ownerPhone: string;
		ownerRepresentative: string;
		name: string;
		city: 'Ouagadougou' | 'Saaba';
		district: string;
		landmark: string;
		gps: string;
		units: UnitDraft[];
		photos: number;
		documents: string[];
	}

	const isLandlord = $derived(demo.profileId === 'landlord');
	const typeLabel: Record<PropertyType, string> = {
		house: 'Villa ou maison',
		building: 'Immeuble d’appartements',
		yard: 'Cour commune',
		shop: 'Local commercial',
		land: 'Terrain'
	};
	const kindOfType: Record<PropertyType, string> = { house: 'Villa', building: 'Immeuble', yard: 'Cour commune', shop: 'Local commercial', land: 'Terrain' };
	const unitKinds = ['Entrée-coucher', 'Chambre-salon', 'Studio', 'Appartement', 'Villa', 'Boutique', 'Bureau'];

	const newUnit = (n: number, type: string): UnitDraft => ({
		label: type === 'house' ? 'Villa' : type === 'shop' ? 'Boutique' : `Unité ${n}`,
		kind: type === 'house' ? 'Villa' : type === 'shop' ? 'Boutique' : type === 'yard' ? 'Chambre-salon' : 'Appartement',
		rooms: '2',
		showers: '1',
		furnished: 'no',
		rent: '',
		charges: '0',
		depositMonths: '2',
		advanceMonths: '0'
	});

	const blank = (): Values => ({
		type: '',
		ownerChoice: isLandlord ? 'self' : '',
		ownerKind: 'person',
		ownerName: '',
		ownerPhone: '',
		ownerRepresentative: '',
		name: '',
		city: 'Ouagadougou',
		district: '',
		landmark: '',
		gps: '',
		units: [],
		photos: 0,
		documents: []
	});

	const draft = demo.log.propertyDraft;
	let resumeOffered = $state(!!draft);
	let values = $state<Values>(blank());
	let step = $state(0);
	let reached = $state(0);
	let savedOn = $state<string | undefined>(undefined);

	function resume() {
		if (!draft) return;
		values = { ...blank(), ...(draft.values as Partial<Values>) };
		step = draft.step;
		reached = draft.step;
		savedOn = draft.savedOn;
		resumeOffered = false;
	}
	function restart() {
		demo.clearDraft();
		resumeOffered = false;
	}

	const steps = [
		{ id: 'type', label: 'Type et propriétaire' },
		{ id: 'lieu', label: 'Localisation' },
		{ id: 'unites', label: 'Unités' },
		{ id: 'medias', label: 'Photos et médias' },
		{ id: 'documents', label: 'Documents privés' }
	];

	const ownerOk = $derived(
		values.ownerChoice === 'self' ||
			(values.ownerChoice === 'new'
				? values.ownerName.trim().length > 2 && !!toE164(values.ownerPhone) && (values.ownerKind !== 'joint' || values.ownerRepresentative.trim().length > 2)
				: demo.data.owners.some((o) => o.id === values.ownerChoice))
	);
	const unitsOk = $derived(
		values.type === 'land' ||
			(values.units.length > 0 && values.units.every((u) => u.label.trim() && (parseAmount(u.rent) ?? 0) > 0 && parseAmount(u.charges) !== null))
	);
	const canNext = $derived(
		[!!values.type && ownerOk, values.district.trim().length > 1 && values.name.trim().length > 2, unitsOk, true, true][step]
	);

	function onstep(next: number) {
		if (next === 2 && values.units.length === 0 && values.type && values.type !== 'land') values.units = [newUnit(1, values.type)];
		reached = Math.max(reached, next);
		demo.saveDraft(next, { ...values });
		savedOn = demo.today;
	}

	// Nom proposé : type et quartier.
	$effect(() => {
		if (step === 1 && !values.name && values.type && values.district.trim().length > 2) {
			values.name = `${kindOfType[values.type as PropertyType]} ${values.district.trim()}`;
		}
	});

	function takeGps() {
		// Maquette : point fictif. Dans le produit, la position du téléphone, prise sur place.
		values.gps = values.city === 'Saaba' ? '12,3833 ; -1,4167' : '12,3714 ; -1,5197';
	}

	const documentChoices = [
		{ id: 'title', label: 'Titre foncier' },
		{ id: 'puh', label: 'Permis urbain d’habiter (PUH)' },
		{ id: 'attribution', label: 'Attestation d’attribution' },
		{ id: 'mandate', label: 'Mandat de gestion signé' }
	];
	function toggleDoc(id: string) {
		values.documents = values.documents.includes(id) ? values.documents.filter((d) => d !== id) : [...values.documents, id];
	}

	const existingMandate = $derived(demo.data.mandates.find((m) => m.ownerId === values.ownerChoice));
	/** Fiche active seulement si un mandat existe (ou si le bailleur gère lui-même) ; sinon brouillon. */
	const willBeActive = $derived(values.ownerChoice === 'self' || !!existingMandate || values.documents.includes('mandate'));

	function finish() {
		const id = `np-${Math.random().toString(36).slice(2, 8)}`;
		let owner: Owner | undefined;
		let mandate: Mandate | undefined;
		let ownerId = values.ownerChoice;
		let mandateId = existingMandate?.id ?? '';
		if (values.ownerChoice === 'self') {
			ownerId = demo.data.owners[0].id;
			mandateId = demo.data.mandates.find((m) => m.ownerId === ownerId)!.id;
		} else if (values.ownerChoice === 'new') {
			ownerId = `${id}-owner`;
			owner = {
				id: ownerId,
				civility: 'M.',
				name: values.ownerKind === 'joint' ? `Indivision ${values.ownerName.trim()} (représentant : ${values.ownerRepresentative.trim()})` : values.ownerName.trim(),
				phone: toE164(values.ownerPhone)!,
				residence: 'Ouagadougou',
				kind: values.ownerKind
			};
			mandateId = `${id}-mandate`;
			const signed = values.documents.includes('mandate');
			mandate = {
				id: mandateId,
				ownerId,
				type: 'management',
				startDate: demo.today,
				endDate: `${+demo.today.slice(0, 4) + 1}${demo.today.slice(4)}`,
				commissionRate: 10,
				canPublish: signed,
				canPhotograph: true,
				canCollect: signed
			};
		}
		const property: Property = {
			id,
			ownerId,
			mandateId,
			name: values.name.trim(),
			kind: values.type ? kindOfType[values.type as PropertyType] : 'Bien',
			city: values.city,
			district: values.district.trim(),
			address: values.landmark.trim() || values.district.trim()
		};
		const units: Unit[] = values.units.map((u, i) => ({
			id: `${id}-u${i + 1}`,
			propertyId: id,
			label: u.label.trim(),
			kind: u.kind,
			rooms: Number(u.rooms) || 1,
			showers: Number(u.showers) || 0,
			furnished: u.furnished === 'yes',
			surface: 0,
			rent: parseAmount(u.rent) ?? 0,
			charges: parseAmount(u.charges) ?? 0,
			status: 'free',
			record: willBeActive ? 'active' : 'draft',
			technical: 'ready',
			photos: values.photos,
			features: [],
			description: '',
			visibility: 'internal'
		}));
		demo.addProperty({ property, units, owner, mandate, gps: values.gps, landmark: values.landmark, documents: values.documents, record: willBeActive ? 'active' : 'draft' });
		goto(`/biens/${id}?nouveau=1`);
	}
</script>

<PageHeader title={isLandlord ? 'Ajouter un logement' : 'Ajouter un bien'} back="/biens" backLabel={isLandlord ? 'Mes logements' : 'Biens'} />

<main class="page pt-3">
	{#if resumeOffered && draft}
		<section class="mb-4 space-y-3 rounded-xl border bg-info-soft p-4 text-info-foreground" aria-labelledby="titre-reprise" data-testid="reprise-brouillon">
			<h2 id="titre-reprise" class="text-lg font-semibold">Un brouillon du {formatDate(draft.savedOn)} vous attend</h2>
			<p class="text-base">Étape {draft.step + 1} sur 5 : {steps[draft.step].label}.</p>
			<div class="grid grid-cols-2 gap-2 md:flex">
				<Button onclick={resume}>Reprendre le brouillon</Button>
				<Button variant="outline" onclick={restart}><RotateCcw aria-hidden="true" /> Recommencer</Button>
			</div>
		</section>
	{/if}

	<Wizard
		{steps}
		bind:current={step}
		{reached}
		{canNext}
		{onstep}
		finishLabel="Enregistrer le bien"
		savedNote={savedOn ? `Brouillon enregistré le ${formatDate(savedOn)}` : undefined}
		onfinish={finish}
		testid="assistant-bien"
	>
		{#if step === 0}
			<div class="space-y-6 rounded-xl border bg-card p-4 md:p-6">
				<ChoiceGroup
					legend="Quel type de bien ?"
					name="type"
					bind:value={values.type}
					columns={3}
					options={(Object.keys(typeLabel) as PropertyType[]).map((t): { value: string; label: string; hint?: string } => ({ value: t, label: typeLabel[t], hint: t === 'land' ? 'Le plus souvent en vente, sans unité à louer' : undefined }))}
				/>
				<p class="text-base text-muted-foreground">« Meublé » n’est pas un type : c’est une caractéristique de chaque unité (étape 3).</p>

				{#if isLandlord}
					<p class="rounded-lg bg-muted p-3 text-base">Vous êtes le propriétaire : le logement est géré par vous, sans mandat ni commission.</p>
				{:else}
					<ChoiceGroup
						legend="À qui appartient-il ?"
						name="proprietaire"
						bind:value={values.ownerChoice}
						columns={2}
						options={[
							...demo.data.owners.map((o) => {
								const m = demo.data.mandates.find((x) => x.ownerId === o.id);
								return { value: o.id, label: `${o.civility} ${o.name}`, hint: m ? `Mandat jusqu’au ${formatDate(m.endDate)}` : 'Sans mandat' };
							}),
							{ value: 'new', label: 'Nouveau propriétaire', hint: 'Personne, société ou indivision' }
						]}
					/>
					{#if values.ownerChoice === 'new'}
						<div class="space-y-4 rounded-lg border p-3">
							<ChoiceGroup
								legend="Le propriétaire est"
								name="genre-proprietaire"
								bind:value={values.ownerKind}
								columns={3}
								options={[
									{ value: 'person', label: 'Une personne' },
									{ value: 'company', label: 'Une société' },
									{ value: 'joint', label: 'Des héritiers (indivision)' }
								]}
							/>
							<label class="block space-y-1">
								<span class="font-semibold">{values.ownerKind === 'company' ? 'Raison sociale' : values.ownerKind === 'joint' ? 'Nom de la famille' : 'Nom et prénom'}</span>
								<Input bind:value={values.ownerName} autocomplete="off" />
							</label>
							{#if values.ownerKind === 'joint'}
								<label class="block space-y-1">
									<span class="font-semibold">Représentant des indivisaires</span>
									<Input bind:value={values.ownerRepresentative} autocomplete="off" />
								</label>
							{/if}
							<label class="block space-y-1">
								<span class="font-semibold">Téléphone</span>
								<Input bind:value={values.ownerPhone} type="tel" inputmode="tel" placeholder="70 12 34 56" />
								{#if values.ownerPhone && !toE164(values.ownerPhone)}<span class="text-base text-destructive">Numéro burkinabè à 8 chiffres.</span>{/if}
							</label>
						</div>
					{/if}
				{/if}
			</div>
		{:else if step === 1}
			<div class="space-y-5 rounded-xl border bg-card p-4 md:p-6">
				<ChoiceGroup legend="Commune" name="commune" bind:value={values.city} options={[{ value: 'Ouagadougou', label: 'Ouagadougou' }, { value: 'Saaba', label: 'Saaba' }]} />
				<label class="block space-y-1">
					<span class="text-lg font-semibold">Quartier</span>
					<Input bind:value={values.district} placeholder="ex. Kalgondin" data-testid="quartier" />
				</label>
				<label class="block space-y-1">
					<span class="text-lg font-semibold">Repère</span>
					<Input bind:value={values.landmark} placeholder="ex. derrière la pharmacie du rond-point" />
				</label>
				<div class="space-y-2">
					<p class="text-lg font-semibold">Point GPS</p>
					<Button variant="outline" onclick={takeGps}><Crosshair aria-hidden="true" /> Prendre le point GPS ici</Button>
					{#if values.gps}
						<p class="flex items-center gap-2 text-base" role="status"><MapPin class="size-4 text-primary" aria-hidden="true" /> Point enregistré : {values.gps} (fictif dans la maquette)</p>
					{/if}
					<p class="flex items-center gap-2 text-base text-muted-foreground"><Lock class="size-4 shrink-0" aria-hidden="true" /> La vitrine n’affiche que le quartier, jamais le point exact ni le repère.</p>
				</div>
				<label class="block space-y-1">
					<span class="text-lg font-semibold">Nom du bien</span>
					<Input bind:value={values.name} placeholder="ex. Résidence Kalgondin" data-testid="nom-bien" />
				</label>
			</div>
		{:else if step === 2}
			<div class="space-y-4">
				{#if values.type === 'land'}
					<p class="rounded-xl border bg-card p-4 text-base">Un terrain n’a en général pas d’unité à louer. Vous pourrez l’annoncer à la vente avec un mandat de vente.</p>
				{/if}
				{#each values.units as u, i (i)}
					{@const rent = parseAmount(u.rent) ?? 0}
					{@const deposit = rent * (Number(u.depositMonths) || 0)}
					{@const warn = depositWarning(deposit, rent)}
					<section class="space-y-4 rounded-xl border bg-card p-4 md:p-6" aria-label="Unité {i + 1}" data-testid="unite-saisie">
						<div class="flex items-center justify-between gap-2">
							<h3 class="text-lg font-semibold">Unité {i + 1}</h3>
							{#if values.units.length > 1}
								<Button variant="ghost" onclick={() => (values.units = values.units.filter((_, j) => j !== i))}><Trash2 aria-hidden="true" /> Retirer</Button>
							{/if}
						</div>
						<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
							<label class="block space-y-1"><span class="font-semibold">Nom de l’unité</span><Input bind:value={u.label} /></label>
							<label class="block space-y-1">
								<span class="font-semibold">Type</span>
								<select bind:value={u.kind} class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base outline-none focus-visible:border-ring">
									{#each unitKinds as k (k)}<option value={k}>{k}</option>{/each}
								</select>
							</label>
							<label class="block space-y-1"><span class="font-semibold">Pièces</span><Input bind:value={u.rooms} inputmode="numeric" /></label>
							<label class="block space-y-1"><span class="font-semibold">Douches</span><Input bind:value={u.showers} inputmode="numeric" /></label>
						</div>
						<ChoiceGroup legend="Meublé ?" name="meuble-{i}" bind:value={u.furnished} options={[{ value: 'no', label: 'Non meublé' }, { value: 'yes', label: 'Meublé', hint: 'L’état des lieux comprendra l’inventaire des meubles' }]} />
						<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
							<label class="block space-y-1">
								<span class="font-semibold">Loyer mensuel (FCFA)</span>
								<Input bind:value={u.rent} inputmode="numeric" placeholder="ex. 75000" data-testid="loyer-unite" />
								{#if rent}<span class="text-base text-muted-foreground">soit {formatFCFA(rent)}</span>{/if}
							</label>
							<label class="block space-y-1"><span class="font-semibold">Charges mensuelles (FCFA)</span><Input bind:value={u.charges} inputmode="numeric" /></label>
							<label class="block space-y-1">
								<span class="font-semibold">Caution (mois de loyer)</span>
								<Input bind:value={u.depositMonths} inputmode="numeric" />
								{#if rent}<span class="text-base text-muted-foreground">soit {formatFCFA(deposit)}</span>{/if}
							</label>
							<label class="block space-y-1">
								<span class="font-semibold">Avance (mois de loyer)</span>
								<Input bind:value={u.advanceMonths} inputmode="numeric" />
								<span class="text-base text-muted-foreground">L’avance n’est pas une caution : elle paie les premiers loyers.</span>
							</label>
						</div>
						{#if warn}
							<p class="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-base text-warning-foreground" role="status">
								<TriangleAlert class="mt-0.5 size-5 shrink-0" aria-hidden="true" />{warn}
							</p>
						{/if}
					</section>
				{/each}
				{#if values.type !== 'land' && values.type !== 'house'}
					<Button variant="outline" class="w-full md:w-auto" onclick={() => (values.units = [...values.units, newUnit(values.units.length + 1, values.type)])}>
						<Plus aria-hidden="true" /> Ajouter une unité
					</Button>
				{/if}
			</div>
		{:else if step === 3}
			<div class="space-y-5 rounded-xl border bg-card p-4 md:p-6">
				<div class="space-y-2">
					<p class="text-lg font-semibold">Photos</p>
					<div class="grid grid-cols-3 gap-2 md:grid-cols-6">
						{#each Array.from({ length: values.photos }, (_, i) => i) as i (i)}
							<div class="aspect-square overflow-hidden rounded-lg"><PhotoPlaceholder index={i} total={values.photos} /></div>
						{/each}
					</div>
					<Button variant="outline" onclick={() => (values.photos += 1)} data-testid="ajouter-photo"><Camera aria-hidden="true" /> Prendre une photo</Button>
					<p class={cn('text-base', values.photos >= 3 ? 'text-primary' : 'text-muted-foreground')}>
						{values.photos} photo{values.photos > 1 ? 's' : ''} · il en faut au moins 3 pour publier une annonce plus tard.
					</p>
				</div>
				<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
					<Button variant="outline" disabled><Film aria-hidden="true" /> Courte vidéo (bientôt)</Button>
					<Button variant="outline" disabled><View aria-hidden="true" /> Lien de visite 360° (option)</Button>
				</div>
			</div>
		{:else}
			<div class="space-y-4 rounded-xl border bg-card p-4 md:p-6">
				<p class="flex items-start gap-2 rounded-lg bg-muted p-3 text-base">
					<FileLock2 class="mt-0.5 size-5 shrink-0" aria-hidden="true" /> Documents privés : jamais publiés, jamais mis en cache, ouverts seulement par lien signé de courte durée.
				</p>
				<ul class="space-y-2">
					{#each documentChoices.filter((d) => !(d.id === 'mandate' && (values.ownerChoice === 'self' || existingMandate))) as d (d.id)}
						{@const on = values.documents.includes(d.id)}
						<li>
							<button
								type="button"
								class={cn('flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border-2 px-3 text-left', on ? 'border-primary bg-secondary' : 'border-input hover:bg-accent')}
								aria-pressed={on}
								onclick={() => toggleDoc(d.id)}
							>
								<span class="font-medium">{d.label}</span>
								<span class="text-base text-muted-foreground">{on ? 'Joint' : 'Joindre'}</span>
							</button>
						</li>
					{/each}
				</ul>
				<div class={cn('rounded-lg p-3 text-base', willBeActive ? 'bg-success-soft' : 'bg-warning-soft text-warning-foreground')} data-testid="etat-fiche">
					{#if willBeActive}
						La fiche sera <strong>active</strong>. Rien ne sera publié : chaque unité se publie ensuite, quand ses conditions sont remplies.
					{:else}
						Sans mandat signé, la fiche reste en <strong>brouillon</strong>. Elle deviendra active quand le mandat sera joint.
					{/if}
				</div>
				<p class="flex items-center gap-2 text-base text-muted-foreground"><Globe class="size-4 shrink-0" aria-hidden="true" /> Enregistrer n’est jamais publier.</p>
			</div>
		{/if}
	</Wizard>
</main>
