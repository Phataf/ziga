/**
 * Liens wa.me pré-remplis (aucune API, aucun coût — cadrage §6).
 */
import { formatDate, formatFCFA, formatMonth, waNumber } from './format';
import type { Agency, Civility } from './types';

export function waLink(phone: string, text: string): string {
	return `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;
}

const METHOD_TEXT = {
	cash: 'en espèces',
	orange_money: 'par Orange Money',
	moov_money: 'par Moov Money',
	transfer: 'par virement'
} as const;

export function receiptMessage(p: {
	civility: Civility;
	name: string;
	amount: number;
	method: keyof typeof METHOD_TEXT;
	date: string;
	unitLabel: string;
	periods: string[];
	receiptNumber: string;
	url: string;
	toReconcile: boolean;
	agency: Agency;
}): string {
	const periods = p.periods.length ? ` (loyer de ${p.periods.map(formatMonth).join(', ')})` : '';
	const reconcile = p.toReconcile
		? '\nVotre paiement Mobile Money sera confirmé dès sa vérification.'
		: '';
	return (
		`Bonjour ${p.civility} ${p.name},\n` +
		`Nous avons bien reçu ${formatFCFA(p.amount)} ${METHOD_TEXT[p.method]} le ${formatDate(p.date)} pour ${p.unitLabel}${periods}.\n` +
		`Reçu n° ${p.receiptNumber} : ${p.url}${reconcile}\n` +
		`Merci. ${p.agency.name}`
	);
}

export function reminderMessage(p: {
	civility: Civility;
	name: string;
	amount: number;
	periods: string[];
	oldestDueDate: string;
	unitLabel: string;
	agency: Agency;
}): string {
	const months = p.periods.map(formatMonth).join(', ');
	return (
		`Bonjour ${p.civility} ${p.name},\n` +
		`Sauf erreur de notre part, il reste ${formatFCFA(p.amount)} à régler pour ${p.unitLabel} (loyer de ${months}), ` +
		`la première échéance étant du ${formatDate(p.oldestDueDate)}.\n` +
		`Pourriez-vous nous indiquer quand le règlement pourra être fait ? ` +
		`Si vous avez déjà payé, merci de ne pas tenir compte de ce message.\n` +
		`Cordialement, ${p.agency.name} — ${p.agency.phone}`
	);
}

export function statementMessage(p: {
	civility: Civility;
	name: string;
	period: string;
	net: number;
	url: string;
	agency: Agency;
}): string {
	return (
		`Bonjour ${p.civility} ${p.name},\n` +
		`Votre relevé de ${formatMonth(p.period)} est disponible : ${p.url}\n` +
		`Net à reverser : ${formatFCFA(p.net)}.\n` +
		`Cordialement, ${p.agency.name}`
	);
}

export function listingMessage(p: { title: string; rent: number; url: string }): string {
	return (
		`Bonjour, je suis intéressé(e) par votre annonce « ${p.title} » à ${formatFCFA(p.rent)} par mois (${p.url}). ` +
		`Est-elle toujours disponible ? Peut-on organiser une visite ?`
	);
}
