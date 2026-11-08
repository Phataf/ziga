/** <FeatureGate> (lot 04) : rendu réel du composant (rendu serveur de Svelte 5), selon l'état des fonctionnalités. */
import { render } from 'svelte/server';
import { afterEach, describe, expect, it } from 'vitest';
import { features } from '../features/features.svelte';
import GateProbe from './__tests__/GateProbe.svelte';

const status = (enabled: boolean) =>
	({
		enabled,
		step: enabled ? 'default' : 'global_disabled',
		stepNumber: enabled ? 7 : 1,
		reason: enabled ? 'Oui' : 'Non — coupée pour tous'
	}) as const;

afterEach(() => features.set(null));

describe('<FeatureGate>', () => {
	it('affiche le contenu quand la fonctionnalité est ouverte', () => {
		features.set({ 'listings.publication': status(true) });
		expect(render(GateProbe, { props: { key: 'listings.publication' } }).body).toContain('Publier l’annonce');
	});

	it('masque le contenu quand elle est fermée', () => {
		features.set({ 'listings.publication': status(false) });
		const { body } = render(GateProbe, { props: { key: 'listings.publication' } });
		expect(body).not.toContain('Publier l’annonce');
		expect(body).not.toContain('data-testid="contenu"');
	});

	it('masque aussi une clé inconnue ou pas encore chargée', () => {
		features.set(null);
		expect(render(GateProbe, { props: { key: 'listings.publication' } }).body).not.toContain('Publier');
		features.set({});
		expect(render(GateProbe, { props: { key: 'cle.inconnue' } }).body).not.toContain('Publier');
	});

	it('affiche le texte de remplacement quand il est fourni', () => {
		features.set({ 'payments.direct': status(false) });
		const { body } = render(GateProbe, { props: { key: 'payments.direct', withFallback: true } });
		expect(body).toContain('Bientôt disponible');
		expect(body).not.toContain('Payer par Mobile Money');
	});
});
