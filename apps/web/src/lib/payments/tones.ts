/**
 * Couleur des pastilles des encaissements (lot 09, docs/UX.md §5) : vert pour l'argent confirmé, ambre pour « à
 * rapprocher », bleu pour « à valider » ; toujours avec le mot.
 */
import type { LocalPaymentStatus } from './views';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'secondary';

export function statusTone(status: LocalPaymentStatus): Tone {
	if (status === 'confirmed') return 'success';
	if (status === 'to_reconcile') return 'warning';
	if (status === 'to_validate') return 'info';
	if (status === 'failed') return 'danger';
	return 'secondary';
}
