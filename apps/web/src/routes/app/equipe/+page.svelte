<script lang="ts">
	/**
	 * Équipe (lot 03) : membres actifs et invitations en attente. Le directeur invite (lien à envoyer par WhatsApp),
	 * change un rôle, retire un membre ou annule une invitation ; le gestionnaire voit la liste en lecture.
	 * Téléphone : cartes ; ordinateur : tableau avec menu d'actions (docs/UX.md §4).
	 * Lot 05 : les membres viennent de la base locale, sans appel réseau (ni leurs numéros, qui ne sont pas
	 * synchronisés) ; les invitations en attente, réservées au directeur, se lisent en ligne.
	 */
	import { onMount } from 'svelte';
	import { Copy, MessageCircle, UserPlus, UserMinus, UserCog } from '@lucide/svelte';
	import { formatDate } from '@ziga/shared/dates';
	import { inviteMemberSchema, ROLE_LABELS, type InvitationView } from '@ziga/shared/organizations';
	import { can, ORGANIZATION_ROLES, type OrganizationRole } from '@ziga/shared/permissions';
	import { formatPhone, waNumber } from '@ziga/shared/phone';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import PhoneField from '#lib/components/auth/PhoneField.svelte';
	import PageHeader from '#lib/components/PageHeader.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import ActionMenu from '#lib/components/ui/menu/ActionMenu.svelte';
	import Sheet from '#lib/components/ui/sheet/Sheet.svelte';
	import { messageOf, phoneOf } from '#lib/auth/forms.ts';
	import { device } from '#lib/device.svelte.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { auth } from '#lib/auth/auth.svelte.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';
	import { LOCAL_QUERIES } from '#lib/sync/queries.ts';
	import { sync } from '#lib/sync/sync.svelte.ts';
	import { toMember, type LocalMember } from '#lib/sync/views.ts';

	const t = fr.team;
	const role = $derived(organizations.active?.role);
	const allowed = $derived(can(role, 'member.read'));
	const manage = $derived(can(role, 'member.invite'));
	const landlord = $derived(organizations.active?.type === 'landlord');

	let members = $state<LocalMember[]>([]);
	let invitations = $state<InvitationView[]>([]);
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);

	// Invitation
	let inviteOpen = $state(false);
	let phone = $state('');
	let country = $state('226');
	let inviteRole = $state<OrganizationRole>('manager');
	let inviteError = $state<string | undefined>();
	let inviteMessage = $state<string | null>(null);
	let link = $state<string | null>(null);
	let linkPhone = $state('');
	let busy = $state(false);

	// Changement de rôle et retrait
	let roleTarget = $state<LocalMember | null>(null);
	let newRole = $state<OrganizationRole>('manager');
	let roleOpen = $state(false);
	let removeTarget = $state<LocalMember | null>(null);
	let removeOpen = $state(false);

	async function load() {
		message = null;
		try {
			invitations = manage ? await organizations.call<InvitationView[]>('GET', '/organization/invitations') : [];
		} catch (error) {
			message = messageOf(error);
		}
	}
	onMount(() => {
		if (!allowed) return;
		if (manage) void load();
		return sync.watch<Record<string, unknown>>(
			LOCAL_QUERIES.members,
			[organizations.activeId],
			(rows) => (members = rows.map((r) => toMember(r, auth.user?.id))),
			(error) => (message = messageOf(error))
		);
	});

	function openInvite() {
		phone = '';
		inviteRole = 'manager';
		inviteError = undefined;
		inviteMessage = null;
		link = null;
		inviteOpen = true;
	}

	async function invite(event: SubmitEvent) {
		event.preventDefault();
		inviteMessage = null;
		const number = phoneOf(phone, country);
		if ('error' in number) {
			inviteError = number.error;
			return;
		}
		inviteError = undefined;
		const input = inviteMemberSchema.parse({ phone: number.phone, role: inviteRole });
		busy = true;
		try {
			const r = await organizations.call<{ token: string }>('POST', '/organization/invitations', input);
			link = `${location.origin}/invitation/${r.token}`;
			linkPhone = number.phone;
			await load();
		} catch (error) {
			inviteMessage = messageOf(error);
		} finally {
			busy = false;
		}
	}

	const whatsappHref = $derived(
		link
			? `https://wa.me/${waNumber(linkPhone)}?text=${encodeURIComponent(t.whatsappText(organizations.active?.name ?? '', ROLE_LABELS[inviteRole].toLowerCase(), link))}`
			: ''
	);

	async function copyLink() {
		if (!link) return;
		try {
			await navigator.clipboard.writeText(link);
			inviteMessage = t.copied;
		} catch {
			inviteMessage = link;
		}
	}

	function askRole(m: LocalMember) {
		roleTarget = m;
		newRole = m.role;
		roleOpen = true;
	}

	async function changeRole(event: SubmitEvent) {
		event.preventDefault();
		if (!roleTarget) return;
		try {
			// La liste suit la base locale : la synchronisation apporte le nouveau rôle en quelques secondes.
			await organizations.call('PATCH', `/organization/members/${roleTarget.id}`, { role: newRole });
			roleOpen = false;
		} catch (error) {
			message = messageOf(error);
			roleOpen = false;
		}
	}

	function askRemove(m: LocalMember) {
		removeTarget = m;
		removeOpen = true;
	}

	async function remove() {
		if (!removeTarget) return;
		try {
			await organizations.call('DELETE', `/organization/members/${removeTarget.id}`);
			info = null;
			removeOpen = false;
			await load();
		} catch (error) {
			message = messageOf(error);
			removeOpen = false;
		}
	}

	async function revoke(i: InvitationView) {
		try {
			await organizations.call('DELETE', `/organization/invitations/${i.id}`);
			await load();
		} catch (error) {
			message = messageOf(error);
		}
	}

	const actionsOf = (m: LocalMember) => [
		{ label: t.changeRole, icon: UserCog, onclick: () => askRole(m) },
		{ label: t.remove, icon: UserMinus, tone: 'danger' as const, onclick: () => askRemove(m) }
	];
</script>

<PageHeader title={t.title} subtitle={t.subtitle}>
	{#snippet actions()}
		{#if manage && !landlord && !device.isPhone}<Button onclick={openInvite}><UserPlus aria-hidden="true" />{t.invite}</Button>{/if}
	{/snippet}
</PageHeader>

<main class="page space-y-4 pt-3 pb-10" data-testid="equipe">
	{#if !allowed}
		<FormAlert message={fr.app.notFound} />
	{:else}
		<FormAlert {message} />
		<FormAlert message={info} tone="info" />
		{#if landlord}<FormAlert message={t.landlordAlone} tone="info" />{:else if !manage}<FormAlert message={t.readOnly} tone="info" />{/if}
		{#if manage && !landlord && device.isPhone}
			<Button size="lg" class="w-full" onclick={openInvite}><UserPlus aria-hidden="true" />{t.invite}</Button>
		{/if}

		{#if device.isPhone}
			<ul class="space-y-3" data-testid="membres">
				{#each members as m (m.id)}
					<li class="space-y-2 rounded-xl border bg-card p-4" data-testid="membre">
						<div class="flex flex-wrap items-start justify-between gap-2">
							<div class="min-w-0">
								<p class="font-semibold break-words">
									{m.name}{#if m.current}<span class="text-muted-foreground"> · {t.you}</span>{/if}
								</p>
							</div>
							<span class="rounded-full bg-secondary px-3 py-1 text-sm font-medium text-secondary-foreground">{ROLE_LABELS[m.role]}</span>
						</div>
						<p class="text-base text-muted-foreground">{t.since(formatDate(m.joinedAt))}</p>
						{#if manage && !landlord}
							<div class="flex flex-wrap gap-2">
								<Button variant="outline" onclick={() => askRole(m)}><UserCog aria-hidden="true" />{t.changeRole}</Button>
								<Button variant="outline" class="text-destructive" onclick={() => askRemove(m)}
									><UserMinus aria-hidden="true" />{t.remove}</Button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<div class="overflow-x-auto rounded-xl border bg-card">
				<table class="w-full text-left text-base" data-testid="membres">
					<thead class="border-b text-muted-foreground">
						<tr>
							<th scope="col" class="px-4 py-3 font-medium">{t.member}</th>
							<th scope="col" class="px-4 py-3 font-medium">{t.role}</th>
							<th scope="col" class="px-4 py-3 font-medium">{fr.fields.status}</th>
							{#if manage && !landlord}<th scope="col" class="px-4 py-3"><span class="sr-only">{fr.app.actions}</span></th>{/if}
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each members as m (m.id)}
							<tr data-testid="membre">
								<td class="px-4 py-3 font-semibold"
									>{m.name}{#if m.current}<span class="font-normal text-muted-foreground"> · {t.you}</span>{/if}</td
								>
								<td class="px-4 py-3">{ROLE_LABELS[m.role]}</td>
								<td class="px-4 py-3 text-muted-foreground">{t.since(formatDate(m.joinedAt))}</td>
								{#if manage && !landlord}<td class="px-2 py-1 text-right"
										><ActionMenu actions={actionsOf(m)} label={`${fr.app.actions} : ${m.name}`} /></td
									>{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if manage && !landlord}
			<section class="space-y-2" aria-labelledby="titre-invitations">
				<h2 id="titre-invitations" class="text-lg font-semibold">{t.pending}</h2>
				<ul class="space-y-2" data-testid="invitations">
					{#each invitations as i (i.id)}
						<li class="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4" data-testid="invitation">
							<div class="min-w-0">
								<p class="font-semibold tabular-nums">{formatPhone(i.phone)} · {ROLE_LABELS[i.role]}</p>
								<p class="text-base text-muted-foreground">{t.expires(formatDate(i.expiresAt))}</p>
							</div>
							<Button variant="outline" onclick={() => revoke(i)}>{t.revoke}</Button>
						</li>
					{:else}
						<li class="text-base text-muted-foreground">{t.noPending}</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</main>

<Sheet bind:open={inviteOpen} labelledby="titre-inviter">
	<h2 id="titre-inviter" class="pr-10 text-xl font-bold">{t.inviteTitle}</h2>
	{#if !link}
		<form class="mt-4 space-y-4" onsubmit={invite} novalidate>
			<p class="text-base text-muted-foreground">{t.inviteHint}</p>
			<FormAlert message={inviteMessage} />
			<PhoneField bind:value={phone} bind:country error={inviteError} id="telephone-invite" />
			<div class="space-y-1">
				<label for="role-invite" class="block font-medium">{t.role}</label>
				<select id="role-invite" bind:value={inviteRole} class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base">
					{#each ORGANIZATION_ROLES as r (r)}<option value={r}>{ROLE_LABELS[r]}</option>{/each}
				</select>
			</div>
			<Button type="submit" size="lg" class="w-full" disabled={busy}
				><UserPlus aria-hidden="true" />{busy ? fr.auth.submitting : t.send}</Button
			>
		</form>
	{:else}
		<div class="mt-4 space-y-4" data-testid="lien-invitation">
			<p class="text-base">{t.linkReady}</p>
			<p class="rounded-lg bg-muted p-3 text-sm break-all" data-testid="lien">{link}</p>
			<!-- Lien externe vers WhatsApp (wa.me) : le bouton générique reçoit l'adresse telle quelle. -->
			<Button href={whatsappHref} target="_blank" rel="noopener" variant="whatsapp" size="lg" class="w-full" data-testid="whatsapp">
				<MessageCircle class="size-5" aria-hidden="true" />{t.whatsapp}
			</Button>
			<Button variant="outline" class="w-full" onclick={copyLink}><Copy aria-hidden="true" />{t.copy}</Button>
			{#if inviteMessage}<p role="status" class="text-base">{inviteMessage}</p>{/if}
		</div>
	{/if}
</Sheet>

<Sheet bind:open={roleOpen} labelledby="titre-role">
	<h2 id="titre-role" class="pr-10 text-xl font-bold">{t.changeRole}</h2>
	{#if roleTarget}
		<form class="mt-4 space-y-4" onsubmit={changeRole}>
			<p class="text-base">{roleTarget.name}</p>
			<div class="space-y-1">
				<label for="nouveau-role" class="block font-medium">{t.role}</label>
				<select id="nouveau-role" bind:value={newRole} class="min-h-12 w-full rounded-lg border-2 border-input bg-card px-3 text-base">
					{#each ORGANIZATION_ROLES as r (r)}<option value={r}>{ROLE_LABELS[r]}</option>{/each}
				</select>
			</div>
			<Button type="submit" size="lg" class="w-full">{t.changeRole}</Button>
		</form>
	{/if}
</Sheet>

<Sheet bind:open={removeOpen} labelledby="titre-retrait">
	<h2 id="titre-retrait" class="pr-10 text-xl font-bold">{t.remove}</h2>
	{#if removeTarget}
		<div class="mt-4 space-y-4">
			<p class="text-base">{t.removeConfirm(removeTarget.name)}</p>
			<div class="flex flex-wrap gap-2">
				<Button variant="destructive" onclick={remove}><UserMinus aria-hidden="true" />{t.removeAction}</Button>
				<Button variant="outline" onclick={() => (removeOpen = false)}>{t.cancel}</Button>
			</div>
		</div>
	{/if}
</Sheet>
