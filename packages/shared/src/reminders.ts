/**
 * Relances (lot 10) : modèles de messages, rendu, lien WhatsApp et schémas. Aucun envoi automatique au MVP : le
 * bouton « Relancer » ouvre WhatsApp (`wa.me`) avec un message pré-rempli, et la relance est enregistrée au retour
 * dans l'application.
 */
import { z } from 'zod';
import { formatDate } from './dates.js';
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from './expenses.js';
import { idSchema } from './ids.js';
import { formatFcfa, type Fcfa } from './money.js';
import type { Action } from './permissions.js';
import { waNumber } from './phone.js';
import { monthLabel, monthOfDate } from './statements.js';

export const REMINDER_CHANNELS = ['whatsapp_link', 'sms', 'call', 'visit'] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

/** Permission de chaque canal : un message passe par `reminder.send` ; l'agent de terrain note ses visites et appels. */
export const REMINDER_CHANNEL_ACTION: Record<ReminderChannel, Action> = {
	whatsapp_link: 'reminder.send',
	sms: 'reminder.send',
	call: 'reminder.record_visit',
	visit: 'reminder.record_visit'
};

/** Les trois niveaux de modèle : rappel courtois, deuxième rappel, dernier rappel. */
export const REMINDER_LEVELS = [1, 2, 3] as const;
export type ReminderLevel = (typeof REMINDER_LEVELS)[number];

/** Variables d'un modèle. */
export const REMINDER_VARIABLES = ['nom', 'montant', 'periode', 'organisation', 'telephone'] as const;
export type ReminderVariable = (typeof REMINDER_VARIABLES)[number];

/** Modèles par défaut, polis ; chaque organisation les adapte (directeur). */
export const DEFAULT_REMINDER_TEMPLATES: readonly [string, string, string] = [
	'Bonjour {nom},\n\nNous vous rappelons qu’un montant de {montant} reste à régler pour : {periode}. Merci de bien vouloir effectuer le paiement dès que possible.\n\nSi vous avez déjà payé, merci de ne pas tenir compte de ce message.\n\n{organisation}',
	'Bonjour {nom},\n\nSauf erreur de notre part, la somme de {montant} reste impayée malgré notre premier rappel ({periode}). Merci de régulariser votre situation ou de nous appeler au {telephone} pour en parler.\n\n{organisation}',
	'Bonjour {nom},\n\nMalgré nos rappels, la somme de {montant} reste due ({periode}). Nous vous demandons de la régler au plus vite, ou de nous appeler au {telephone} pour convenir ensemble d’une solution.\n\n{organisation}'
];

/** Seuils par défaut : une échéance non soldée est proposée à J+5, puis J+15, puis J+30. */
export const DEFAULT_REMINDER_OFFSETS: readonly [number, number, number] = [5, 15, 30];

const VARIABLE = /\{([a-z_]+)\}/g;

/** Variables inconnues d'un modèle. */
export function unknownReminderVariables(template: string): string[] {
	return [...template.matchAll(VARIABLE)].map((m) => m[1]!).filter((v) => !(REMINDER_VARIABLES as readonly string[]).includes(v));
}

/** Remplace les variables connues ; une variable sans valeur devient une chaîne vide. */
export function renderReminder(template: string, values: Partial<Record<ReminderVariable, string>>): string {
	return template.replace(VARIABLE, (whole, name: string) =>
		(REMINDER_VARIABLES as readonly string[]).includes(name) ? (values[name as ReminderVariable] ?? '') : whole
	);
}

/** Ce que couvre une relance : des échéances (mois) et des dépenses réclamées. */
export interface ReminderSubject {
	dues: readonly { periodStart: string }[];
	claims: readonly { category: ExpenseCategory; date: string }[];
}

function joinFrench(parts: readonly string[]): string {
	if (parts.length <= 1) return parts.join('');
	return `${parts.slice(0, -1).join(', ')} et ${parts.at(-1)}`;
}

/**
 * Période d'une relance, groupe nominal sans article (les modèles l'écrivent après « pour : » ou entre parenthèses) :
 * « loyer de mars 2027 », « loyers de février et mars 2027 », « loyers de janvier à avril 2027 » (mois consécutifs),
 * et les dépenses réclamées (« dépense de plomberie du 12/03/2027 »).
 */
export function reminderPeriodText(subject: ReminderSubject): string {
	const months = [...new Set(subject.dues.map((d) => monthOfDate(d.periodStart)))].sort();
	const parts: string[] = [];
	if (months.length === 1) parts.push(`loyer de ${monthLabel(months[0]!)}`);
	else if (months.length > 1) {
		const consecutive = months.every((m, i) => i === 0 || nextMonthOf(months[i - 1]!) === m);
		const first = monthLabel(months[0]!);
		const last = monthLabel(months.at(-1)!);
		const sameYear = months[0]!.slice(0, 4) === months.at(-1)!.slice(0, 4);
		const short = (m: string) => (sameYear ? monthLabel(m).split(' ')[0]! : monthLabel(m));
		if (consecutive && months.length > 2) parts.push(`loyers de ${sameYear ? first.split(' ')[0] : first} à ${last}`);
		else parts.push(`loyers de ${joinFrench([...months.slice(0, -1).map(short), last])}`);
	}
	for (const c of subject.claims) parts.push(`dépense de ${EXPENSE_CATEGORY_LABELS[c.category].toLowerCase()} du ${formatDate(c.date)}`);
	return joinFrench(parts);
}

function nextMonthOf(month: string): string {
	const y = Number(month.slice(0, 4));
	const m = Number(month.slice(5, 7));
	return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Message d'une relance, à partir du modèle de l'organisation. */
export function reminderMessage(
	template: string,
	ctx: { tenantName: string; amount: Fcfa; subject: ReminderSubject; organizationName: string; organizationPhone: string | null }
): string {
	return renderReminder(template, {
		nom: ctx.tenantName,
		montant: formatFcfa(ctx.amount),
		periode: reminderPeriodText(ctx.subject),
		organisation: ctx.organizationName,
		telephone: ctx.organizationPhone ?? ''
	});
}

/**
 * Lien WhatsApp pré-rempli : `https://wa.me/<numéro E.164 sans « + »>?text=<message encodé>`. `encodeURIComponent`
 * encode les accents (UTF-8), l'espace fine insécable des montants (`%E2%80%AF`) et les retours à la ligne (`%0A`).
 */
export function waMeLink(phoneE164: string, text: string): string {
	const digits = phoneE164.startsWith('+') ? waNumber(phoneE164) : null;
	if (!digits) throw new RangeError(`Numéro E.164 attendu : ${phoneE164}`);
	return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------- schémas

const templateSchema = z
	.string()
	.trim()
	.min(10, { error: 'Le message est trop court.' })
	.max(1000, { error: 'Le message est trop long (1 000 caractères au plus).' })
	.refine((t) => unknownReminderVariables(t).length === 0, {
		error: `Variables possibles : ${REMINDER_VARIABLES.map((v) => `{${v}}`).join(', ')}.`
	});

export const reminderSettingsSchema = z.object({
	templates: z.tuple([templateSchema, templateSchema, templateSchema]),
	offsets: z.tuple([z.number().int(), z.number().int(), z.number().int()]).refine(([a, b, c]) => a >= 1 && a < b && b < c && c <= 365, {
		error: 'Trois délais croissants, de 1 à 365 jours.'
	})
});
export type ReminderSettingsData = z.output<typeof reminderSettingsSchema>;

export const createReminderSchema = z
	.object({
		id: idSchema,
		tenantId: idSchema,
		rentDueIds: z.array(idSchema).max(60).default([]),
		expenseIds: z.array(idSchema).max(60).default([]),
		channel: z.enum(REMINDER_CHANNELS),
		/** Modèle utilisé (message), `null` pour un appel ou une visite. */
		templateLevel: z
			.union([z.literal(1), z.literal(2), z.literal(3)])
			.nullish()
			.transform((v) => v ?? null),
		note: z
			.string()
			.trim()
			.max(500, { error: 'Note trop longue.' })
			.nullish()
			.transform((v) => (v ? v : null))
	})
	.superRefine((r, ctx) => {
		const message = r.channel === 'whatsapp_link' || r.channel === 'sms';
		if (message && r.templateLevel === null) ctx.addIssue({ code: 'custom', path: ['templateLevel'], message: 'Choisissez le modèle.' });
		if (!message && r.templateLevel !== null)
			ctx.addIssue({ code: 'custom', path: ['templateLevel'], message: 'Pas de modèle pour un appel ou une visite.' });
		if (r.rentDueIds.length + r.expenseIds.length === 0) {
			ctx.addIssue({ code: 'custom', path: ['rentDueIds'], message: 'Une relance concerne au moins une échéance ou une dépense.' });
		}
	});
export type CreateReminderInput = z.input<typeof createReminderSchema>;
export type CreateReminderData = z.output<typeof createReminderSchema>;

export interface ReminderView {
	id: string;
	tenantId: string;
	rentDueIds: string[];
	expenseIds: string[];
	channel: ReminderChannel;
	templateLevel: ReminderLevel | null;
	note: string | null;
	sentAt: string;
	sentBy: string | null;
}

export interface ReminderSettingsView extends ReminderSettingsData {
	updatedAt: string | null;
}
