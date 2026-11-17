/** Relances (lot 10) : modèles, période, message et lien WhatsApp encodé. */
import { describe, expect, it } from 'vitest';
import {
	createReminderSchema,
	DEFAULT_REMINDER_TEMPLATES,
	reminderMessage,
	reminderPeriodText,
	reminderSettingsSchema,
	renderReminder,
	unknownReminderVariables,
	waMeLink
} from './reminders.js';

const ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f';

describe('lien WhatsApp', () => {
	it('numéro E.164 sans « + », accents, montant formaté et retours à la ligne encodés', () => {
		const text = reminderMessage(DEFAULT_REMINDER_TEMPLATES[0], {
			tenantName: 'Aïcha Zongo',
			amount: 75_000,
			subject: { dues: [{ periodStart: '2027-03-01' }], claims: [] },
			organizationName: 'Agence Kanazoé',
			organizationPhone: '+226 25 30 00 00'
		});
		const link = waMeLink('+22670112233', text);
		expect(link.startsWith('https://wa.me/22670112233?text=')).toBe(true);
		const encoded = link.slice(link.indexOf('=') + 1);
		// « Aïcha » : ï en UTF-8 ; « 75 000 FCFA » : espace fine insécable U+202F puis espace insécable U+00A0.
		expect(encoded).toContain('A%C3%AFcha');
		expect(encoded).toContain('75%E2%80%AF000%C2%A0FCFA');
		expect(encoded).toContain('%0A%0A');
		expect(encoded).toContain('Kanazo%C3%A9');
		expect(encoded).not.toMatch(/[\s\n]/);
		expect(decodeURIComponent(encoded)).toBe(text);
		expect(text).toContain('Nous vous rappelons qu’un montant de 75\u202f000\u00a0FCFA reste à régler pour : loyer de mars 2027.');
	});

	it('refuse un numéro qui n’est pas en E.164', () => {
		expect(() => waMeLink('70112233', 'x')).toThrow(/E\.164/);
		expect(() => waMeLink('+12', 'x')).toThrow(/E\.164/);
	});
});

describe('modèles', () => {
	it('variables remplacées ; une variable inconnue est signalée et laissée telle quelle', () => {
		expect(renderReminder('Bonjour {nom}, {montant} {inconnu}', { nom: 'Awa', montant: '5 FCFA' })).toBe('Bonjour Awa, 5 FCFA {inconnu}');
		expect(unknownReminderVariables('{nom} {date} {montant}')).toEqual(['date']);
		for (const t of DEFAULT_REMINDER_TEMPLATES) expect(unknownReminderVariables(t)).toEqual([]);
	});

	it('réglages : trois modèles valides et trois délais croissants', () => {
		const ok = { templates: [...DEFAULT_REMINDER_TEMPLATES], offsets: [5, 15, 30] };
		expect(reminderSettingsSchema.safeParse(ok).success).toBe(true);
		expect(reminderSettingsSchema.safeParse({ ...ok, offsets: [5, 5, 30] }).success).toBe(false);
		expect(reminderSettingsSchema.safeParse({ ...ok, templates: ['Bonjour {nom} {date}', ok.templates[1], ok.templates[2]] }).success).toBe(
			false
		);
	});
});

describe('période d’une relance', () => {
	const dues = (...months: string[]) => ({ dues: months.map((m) => ({ periodStart: `${m}-01` })), claims: [] });
	it('un mois, deux mois, mois consécutifs, années différentes, dépense réclamée', () => {
		expect(reminderPeriodText(dues('2027-03'))).toBe('loyer de mars 2027');
		expect(reminderPeriodText(dues('2027-02', '2027-03'))).toBe('loyers de février et mars 2027');
		expect(reminderPeriodText(dues('2027-01', '2027-02', '2027-03', '2027-04'))).toBe('loyers de janvier à avril 2027');
		expect(reminderPeriodText(dues('2027-01', '2027-03', '2027-04'))).toBe('loyers de janvier, mars et avril 2027');
		expect(reminderPeriodText(dues('2026-12', '2027-01'))).toBe('loyers de décembre 2026 et janvier 2027');
		expect(reminderPeriodText({ dues: [{ periodStart: '2027-03-01' }], claims: [{ category: 'plumbing', date: '2027-03-12' }] })).toBe(
			'loyer de mars 2027 et dépense de plomberie du 12/03/2027'
		);
	});
});

describe('enregistrement d’une relance', () => {
	it('un message porte son modèle ; un appel ou une visite n’en a pas ; au moins une échéance ou une dépense', () => {
		const base = { id: ID, tenantId: ID, rentDueIds: [ID] };
		expect(createReminderSchema.safeParse({ ...base, channel: 'whatsapp_link', templateLevel: 1 }).success).toBe(true);
		expect(createReminderSchema.safeParse({ ...base, channel: 'whatsapp_link' }).success).toBe(false);
		expect(createReminderSchema.safeParse({ ...base, channel: 'visit', note: 'Absent, voisin prévenu' }).success).toBe(true);
		expect(createReminderSchema.safeParse({ ...base, channel: 'call', templateLevel: 2 }).success).toBe(false);
		expect(createReminderSchema.safeParse({ id: ID, tenantId: ID, channel: 'call' }).success).toBe(false);
	});
});
