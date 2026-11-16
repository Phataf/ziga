/** Couleur des pastilles des contrats (lot 08 bis) : statut et alertes. */
import type { ContractAlert } from '@ziga/shared/contracts';
import type { LeaseContractState } from './views';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'secondary';

export function contractTone(state: LeaseContractState): Tone {
	if (state === 'signed') return 'success';
	if (state === 'ready_to_sign') return 'info';
	if (state === 'none') return 'warning';
	return 'secondary';
}

export function alertTone(alert: ContractAlert | 'contract_unsigned'): Tone {
	if (alert === 'term_reached_without_notice' || alert === 'contract_outdated') return 'danger';
	if (alert === 'renewed_automatically' || alert === 'amendment_pending') return 'info';
	return 'warning';
}
