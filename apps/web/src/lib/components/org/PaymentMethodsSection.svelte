<script lang="ts">
	/**
	 * Moyens de paiement acceptés (D18) : un réglage de l'organisation, jamais un interrupteur de la plateforme.
	 * La dernière case cochée ne peut pas être décochée (au moins un moyen actif, vérifié aussi par l'API et la base).
	 */
	import { Check } from '@lucide/svelte';
	import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type OrganizationView, type PaymentMethod } from '@ziga/shared/organizations';
	import FormAlert from '#lib/components/auth/FormAlert.svelte';
	import { messageOf } from '#lib/auth/forms.ts';
	import { fr } from '#lib/i18n/fr.ts';
	import { organizations } from '#lib/org/organizations.svelte.ts';

	let { view = $bindable(), editable }: { view: OrganizationView; editable: boolean } = $props();
	const t = fr.orgSettings;
	let message = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);

	async function toggle(method: PaymentMethod, checked: boolean) {
		message = null;
		info = null;
		const next = checked ? [...view.acceptedPaymentMethods, method] : view.acceptedPaymentMethods.filter((m) => m !== method);
		busy = true;
		try {
			view = await organizations.call<OrganizationView>('PUT', '/organization/payment-methods', { methods: next });
			info = t.paymentMethodsSaved;
		} catch (error) {
			message = messageOf(error);
		} finally {
			busy = false;
		}
	}
</script>

<section class="space-y-3 rounded-2xl border bg-card p-4 md:p-6" aria-labelledby="titre-moyens" data-testid="moyens-paiement">
	<h2 id="titre-moyens" class="text-lg font-semibold">{t.paymentMethods}</h2>
	<p class="text-base text-muted-foreground">{t.paymentMethodsHint}</p>
	<FormAlert {message} />
	<ul class="space-y-2">
		{#each PAYMENT_METHODS as method (method)}
			{@const checked = view.acceptedPaymentMethods.includes(method)}
			{@const last = checked && view.acceptedPaymentMethods.length === 1}
			<li>
				<!-- La case couvre toute la ligne (48 px) : la cible tactile est la case elle-même ; le carré est dessiné. -->
				<label
					class="relative flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border-2 border-input px-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70"
				>
					<input
						type="checkbox"
						class="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed"
						{checked}
						disabled={!editable || busy || last}
						onchange={(e) => toggle(method, e.currentTarget.checked)}
					/>
					<span
						class="flex size-5 shrink-0 items-center justify-center rounded border-2 border-input text-primary-foreground peer-checked:border-primary peer-checked:bg-primary [&>svg]:invisible peer-checked:[&>svg]:visible"
						aria-hidden="true"
					>
						<Check class="size-4" />
					</span>
					<span class="text-base">{PAYMENT_METHOD_LABELS[method]}</span>
				</label>
			</li>
		{/each}
	</ul>
	<FormAlert message={info} tone="info" />
</section>
