import type { PersonLinkView } from '@ziga/shared/person-links';
import { describe, expect, it } from 'vitest';
import { linkState, toMaintenanceRequest } from './links.ts';

function link(over: Partial<PersonLinkView>): PersonLinkView {
	return {
		id: 'l1',
		recordType: 'tenant',
		recordId: 't1',
		status: 'requested',
		origin: 'organization_invite',
		phoneVerified: false,
		accepted: true,
		claimed: false,
		inviteExpiresAt: '2026-12-01T00:00:00.000Z',
		createdAt: '2026-11-22T00:00:00.000Z',
		acceptedAt: '2026-11-22T00:00:00.000Z',
		revokedAt: null,
		revokedByParty: null,
		revocationReason: null,
		...over
	};
}

const NOW = new Date('2026-11-25T00:00:00.000Z');

describe('section « Compte lié » d’une fiche (lot 10 ter)', () => {
	it('aucun lien (ou seulement des liens révoqués) : inviter', () => {
		expect(linkState([], NOW)).toMatchObject({ kind: 'none', canInvite: true, canResend: false, canRevoke: false });
		expect(linkState([link({ status: 'revoked' })], NOW)).toMatchObject({ kind: 'none', canInvite: true });
	});

	it('invitation en attente : renvoyer l’invitation ; expirée : aussi ; ouverte par la personne : ni l’un ni l’autre', () => {
		expect(linkState([link({})], NOW)).toMatchObject({ kind: 'invited', canResend: true, canRevoke: true, canInvite: false });
		expect(linkState([link({ inviteExpiresAt: '2026-11-24T00:00:00.000Z' })], NOW)).toMatchObject({
			kind: 'invite_expired',
			canResend: true
		});
		expect(linkState([link({ claimed: true })], NOW)).toMatchObject({ kind: 'claimed', canResend: false, canRevoke: true });
	});

	it('demande de la personne : accepter, une fois ; code validé ou non', () => {
		const request = { origin: 'person_request' as const, accepted: false, inviteExpiresAt: null };
		expect(linkState([link({ ...request })], NOW)).toMatchObject({ kind: 'requested_unverified', canAccept: true });
		expect(linkState([link({ ...request, phoneVerified: true })], NOW)).toMatchObject({ kind: 'requested_verified', canAccept: true });
		expect(linkState([link({ ...request, accepted: true })], NOW)).toMatchObject({ canAccept: false });
	});

	it('lien actif : révoquer seulement ; le plus récent non révoqué l’emporte', () => {
		expect(linkState([link({ status: 'active', phoneVerified: true })], NOW)).toMatchObject({
			kind: 'active',
			canRevoke: true,
			canInvite: false,
			canResend: false
		});
		expect(linkState([link({ id: 'new', status: 'active' }), link({ id: 'old', status: 'revoked' })], NOW).link?.id).toBe('new');
	});
});

describe('signalements lus sur l’appareil (fiche du bail)', () => {
	it('ligne SQLite → vue ; statut inconnu lu comme « reçu » ; champs vides à null', () => {
		expect(
			toMaintenanceRequest({
				id: 'm1',
				lease_id: 'l1',
				title: 'Fuite',
				description: 'Robinet',
				status: 'planned',
				planned_on: '2026-12-02',
				status_note: '',
				created_at: '2026-11-22T10:00:00Z'
			})
		).toEqual({
			id: 'm1',
			leaseId: 'l1',
			title: 'Fuite',
			description: 'Robinet',
			status: 'planned',
			plannedOn: '2026-12-02',
			statusNote: null,
			createdAt: '2026-11-22T10:00:00Z'
		});
		expect(toMaintenanceRequest({ id: 'm2', lease_id: 'l1', status: 'autre' }).status).toBe('received');
	});
});
