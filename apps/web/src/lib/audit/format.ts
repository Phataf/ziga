/**
 * Lecture d'une ligne du journal d'audit : valeurs en français (rôles, formules, moyens de paiement, modes, dates,
 * montants), objets aplatis, jamais d'identifiant technique brut. Partagé par le journal de l'organisation, l'activité
 * du compte et le journal du back-office.
 */
import { formatDate } from '@ziga/shared/dates';
import { GLOBAL_MODE_LABELS, type GlobalMode } from '@ziga/shared/features';
import { formatFcfa } from '@ziga/shared/money';
import { PAYMENT_METHOD_LABELS, ROLE_LABELS, type AuditEntryView } from '@ziga/shared/organizations';
import { formatPhone } from '@ziga/shared/phone';
import { fr } from '../i18n/fr';

const AMOUNTS = new Set(['amount', 'monthlyPrice', 'yearlyPrice']);

function label(key: string, value: string): string | null {
	if (key === 'role' && value in ROLE_LABELS) return ROLE_LABELS[value as keyof typeof ROLE_LABELS];
	if ((key === 'planId' || key === 'plan') && value in fr.plans) return fr.plans[value]!;
	if (key === 'mode' && value in GLOBAL_MODE_LABELS) return GLOBAL_MODE_LABELS[value as GlobalMode];
	if (key === 'verificationStatus' && value in fr.admin.verification) return fr.admin.verification[value]!;
	if (key === 'acceptedPaymentMethods' && value in PAYMENT_METHOD_LABELS)
		return PAYMENT_METHOD_LABELS[value as keyof typeof PAYMENT_METHOD_LABELS];
	return null;
}

export function showValue(key: string, value: unknown): string {
	if (value === null || value === undefined || value === '') return '—';
	if (typeof value === 'boolean') return value ? fr.admin.yes : fr.admin.no;
	if (typeof value === 'number' && AMOUNTS.has(key) && Number.isSafeInteger(value)) return formatFcfa(value);
	if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? (label(key, v) ?? v) : String(v))).join(', ') || '—';
	if (typeof value === 'object') {
		return (
			Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== null && v !== '')
				.map(([k, v]) => showValue(k, v))
				.join(', ') || '—'
		);
	}
	if (typeof value === 'string') {
		const named = label(key, value);
		if (named) return named;
		if (/^\+\d{8,15}$/.test(value)) return formatPhone(value);
		if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(value)) return formatDate(value);
	}
	return String(value);
}

/** Ce qui a changé, champ par champ, limité aux champs qui ont un libellé. */
export function auditChanges(e: Pick<AuditEntryView, 'before' | 'after'>): { key: string; before: string; after: string }[] {
	const before = (e.before ?? {}) as Record<string, unknown>;
	const after = (e.after ?? {}) as Record<string, unknown>;
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => k in fr.fields);
	return keys.map((k) => ({ key: k, before: k in before ? showValue(k, before[k]) : '', after: k in after ? showValue(k, after[k]) : '' }));
}
