/** Libellés français de la maquette. */
import type { BadgeVariant } from './components/ui/badge';
import type { PaymentMethod, PaymentStatus, UnitStatus, Visibility } from './types';

export const unitStatusLabel: Record<UnitStatus, string> = {
	free: 'Libre',
	rented: 'Louée',
	reserved: 'Réservée',
	unavailable: 'Indisponible'
};

export const unitStatusVariant: Record<UnitStatus, BadgeVariant> = {
	free: 'info',
	rented: 'success',
	reserved: 'warning',
	unavailable: 'outline'
};

export const visibilityLabel: Record<Visibility, string> = {
	internal: 'Non publiée',
	published: 'Publiée'
};

export const methodLabel: Record<PaymentMethod, string> = {
	cash: 'Espèces',
	orange_money: 'Orange Money',
	moov_money: 'Moov Money',
	transfer: 'Virement'
};

export const paymentStatusLabel: Record<PaymentStatus, string> = {
	validated: 'Validé',
	to_reconcile: 'À rapprocher'
};

export const paymentStatusVariant: Record<PaymentStatus, BadgeVariant> = {
	validated: 'success',
	to_reconcile: 'warning'
};
