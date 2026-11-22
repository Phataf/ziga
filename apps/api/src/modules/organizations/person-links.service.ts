/**
 * Liaison d'une fiche (propriétaire ou locataire) au compte d'une personne (lot 10 ter, étape 2). Règle 15 de CLAUDE.md,
 * D13, D17 ; diagramme de liaison validé et réponses du porteur (journal du lot).
 *
 * - (a) L'organisation invite depuis la fiche : lien demandé, accepté d'avance par le membre qui invite ; jeton
 *   `<organisation>.<secret>` envoyé par WhatsApp ou SMS au numéro de la fiche. La personne le réclame avec son compte
 *   (au numéro de la fiche, sinon refus), puis reçoit un code SMS à ce numéro ; le code validé rend le lien actif.
 * - (b) La personne demande depuis son espace, auprès d'une agence vérifiée (réponse 1) : même réponse que la fiche
 *   existe ou non, limites par compte et par numéro ; code SMS au numéro de la fiche, puis acceptation par l'organisation.
 * - Bailleur particulier : sa propre fiche se lie à son compte si le numéro vérifié du compte est celui de la fiche et
 *   s'il en est le directeur (réponse 2), journalisé.
 * - Révocation par l'organisation ou par la personne, motivée ; rien n'est supprimé.
 *
 * Chaque lecture et écriture se fait dans une seule organisation (withOrganization) ; la seule lecture hors organisation
 * est celle des liens de la personne connectée (my_person_link_overview, SECURITY DEFINER), identifiants et nom de
 * l'organisation seulement. La base vérifie les mêmes règles en dernier rempart (migrations 0022 et 0023).
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { FeatureKey } from '@ziga/shared/features';
import { newId } from '@ziga/shared/ids';
import {
	canRequestLinkFrom,
	landlordSelfLinkEligible,
	LINK_REQUEST_LIMITS,
	linkPhoneBlocker,
	PERSON_LINK_INVITE_TTL_DAYS,
	type LinkRequestOrganization,
	type MyPersonLinkView,
	type PersonLinkInvitationPreview,
	type PersonLinkRecordType,
	type PersonLinkView
} from '@ziga/shared/person-links';
import type { OrganizationType, VerificationStatus } from '@ziga/shared/permissions';
import { and, desc, eq, isNull, lte, ne, sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { fromDatabaseError } from '../../common/db-errors.js';
import { RequestContext } from '../../common/request-context.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { users } from '../../db/schema/identity.js';
import { organizations } from '../../db/schema/organizations.js';
import { personLinks } from '../../db/schema/person-links.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { FeaturesService } from '../features/features.service.js';
import { AuthService } from '../identity/auth.service.js';
import { counterKey, sha256 } from '../identity/secrets.js';
import { ThrottleService } from '../identity/throttle.service.js';
import { SMS_SENDER, type SmsSender } from '../notifications/sms-sender.js';
import { invitationOrganization, maskPhone } from './organizations.service.js';
import { PersonLinkRecords } from './person-link-records.js';

type LinkRow = typeof personLinks.$inferSelect;

const DAY = 24 * 60 * 60_000;

/** Motif d'une invitation révoquée parce qu'elle a expiré sans être réclamée. */
const EXPIRED_INVITATION = 'Invitation expirée';

/** Motif de l'ancienne invitation quand l'organisation la renvoie. */
const RESENT_INVITATION = 'Invitation renvoyée';

/** Interrupteur de l'espace qui correspond au type de fiche (CLAUDE.md §8). */
export function spaceFeature(recordType: PersonLinkRecordType): FeatureKey {
	return recordType === 'owner' ? 'portals.owner_space' : 'portals.tenant_space';
}

function toView(l: LinkRow): PersonLinkView {
	return {
		id: l.id,
		recordType: l.recordType,
		recordId: (l.ownerId ?? l.tenantId)!,
		status: l.status,
		origin: l.origin,
		phoneVerified: l.phoneVerifiedAt !== null,
		accepted: l.acceptedBy !== null,
		claimed: l.claimedAt !== null,
		inviteExpiresAt: l.inviteExpiresAt?.toISOString() ?? null,
		createdAt: l.createdAt.toISOString(),
		acceptedAt: l.acceptedAt?.toISOString() ?? null,
		revokedAt: l.revokedAt?.toISOString() ?? null,
		revokedByParty: l.revokedByParty,
		revocationReason: l.revocationReason
	};
}

/** Ce que le journal garde d'un lien : jamais le jeton, jamais le numéro en entier. */
function auditView(l: LinkRow) {
	return {
		recordType: l.recordType,
		ownerId: l.ownerId,
		tenantId: l.tenantId,
		status: l.status,
		origin: l.origin,
		phone: maskPhone(l.phone),
		phoneVerified: l.phoneVerifiedAt !== null,
		accepted: l.acceptedBy !== null
	};
}

const invalidInvitation = () => new AppError('PERSON_LINK_INVITATION_INVALID', 'Ce lien d’invitation n’est plus valable.', 404);
const linkNotFound = () => new AppError('PERSON_LINK_NOT_FOUND', 'Liaison introuvable.', 404);

@Injectable()
export class PersonLinksService {
	constructor(
		private readonly database: DatabaseService,
		private readonly audit: AuditService,
		private readonly auth: AuthService,
		private readonly features: FeaturesService,
		private readonly throttle: ThrottleService,
		private readonly records: PersonLinkRecords,
		@Inject(SMS_SENDER) private readonly sms: SmsSender,
		@Inject(APP_CONFIG) private readonly config: AppConfig
	) {}

	readonly #listeners: ((userId: string) => Promise<void> | void)[] = [];

	/** Un lien d'une personne a changé (activé, révoqué) : le module portals efface ses réponses en cache. */
	onLinkChanged(listener: (userId: string) => Promise<void> | void): void {
		this.#listeners.push(listener);
	}

	/** Après la validation de la transaction en cours (ou tout de suite hors transaction de requête). */
	private changed(userId: string | null): void {
		if (!userId) return;
		RequestContext.afterCommit(async () => {
			for (const l of this.#listeners) await l(userId);
		});
	}

	/** Hors transaction de requête (routes de la personne) : une fois la transaction de l'organisation validée. */
	private async notify(userId: string): Promise<void> {
		for (const l of this.#listeners) await l(userId);
	}

	/** La base a refusé : son code métier (dernier rempart), sinon l'erreur telle quelle. */
	private async guard<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			throw fromDatabaseError(error) ?? error;
		}
	}

	private webUrl(): string {
		return (this.config.WEB_PUBLIC_URL ?? this.config.CORS_ORIGINS[0]!).replace(/\/$/, '');
	}

	private async organizationOf(tx: Tx, organizationId: string) {
		const [o] = await tx
			.select({
				id: organizations.id,
				type: organizations.type,
				name: sql<string>`coalesce(${organizations.tradeName}, ${organizations.legalName})`,
				planId: organizations.planId,
				verificationStatus: organizations.verificationStatus
			})
			.from(organizations)
			.where(eq(organizations.id, organizationId))
			.limit(1);
		if (!o) throw linkNotFound();
		return o;
	}

	private async assertSpace(tx: Tx, recordType: PersonLinkRecordType, userId: string, organizationId: string, planId: string) {
		await this.features.assertEnabled(
			spaceFeature(recordType),
			userId,
			await this.features.organizationContext(organizationId, planId, tx)
		);
	}

	private async account(userId: string) {
		const [u] = await this.database.db
			.select({ id: users.id, phone: users.phone, status: users.status, phoneVerifiedAt: users.phoneVerifiedAt })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		if (!u || u.status !== 'active') throw new AppError('UNAUTHORIZED', 'Authentification requise.', 401);
		return u;
	}

	private async link(tx: Tx, id: string): Promise<LinkRow> {
		const [l] = await tx.select().from(personLinks).where(eq(personLinks.id, id)).limit(1).for('update');
		if (!l) throw linkNotFound();
		return l;
	}

	/**
	 * Invitations de l'organisation expirées et jamais réclamées d'une fiche : révoquées par le serveur, motif « Invitation
	 * expirée », une ligne d'audit chacune, dans la transaction de l'écriture qui suit (réinviter, demande de la personne,
	 * liaison automatique du bailleur). Sinon l'index « un lien non révoqué par fiche » bloquerait la fiche pour toujours.
	 * Une invitation déjà réclamée (sa personne posée), même expirée, reste en l'état : elle appartient à cette personne.
	 * Auteur : `revoked_by_party = system`, sans personne (comme les révocations à un changement de numéro, migration 0022).
	 */
	private async revokeExpiredInvitations(
		tx: Tx,
		organizationId: string,
		recordType: PersonLinkRecordType,
		recordId: string
	): Promise<void> {
		const column = recordType === 'owner' ? personLinks.ownerId : personLinks.tenantId;
		const expired = await tx
			.update(personLinks)
			.set({ status: 'revoked', revokedAt: new Date(), revokedBy: null, revokedByParty: 'system', revocationReason: EXPIRED_INVITATION })
			.where(
				and(
					eq(column, recordId),
					eq(personLinks.origin, 'organization_invite'),
					eq(personLinks.status, 'requested'),
					isNull(personLinks.userId),
					lte(personLinks.inviteExpiresAt, sql`now()`)
				)
			)
			.returning();
		for (const l of expired) {
			await this.audit.record(tx, {
				actor: { type: 'system' },
				organizationId,
				action: 'person_link.revoke',
				objectType: 'person_link',
				objectId: l.id,
				before: { status: 'requested', inviteExpiresAt: l.inviteExpiresAt?.toISOString() ?? null },
				after: { ...auditView(l), revokedByParty: 'system', cause: 'invitation_expired', reason: EXPIRED_INVITATION }
			});
		}
	}

	// ---------------------------------------------------------------- organisation (route @OrganizationScoped)

	private memberActor(): Extract<AuditActor, { type: 'user' }> {
		const ctx = RequestContext.get()!;
		return { type: 'user', userId: ctx.userId!, role: RequestContext.organization().role };
	}

	/** Liens d'une fiche, du plus récent au plus ancien (section « Compte lié » de la fiche). */
	async listForRecord(recordType: PersonLinkRecordType, recordId: string): Promise<PersonLinkView[]> {
		const tx = RequestContext.tx();
		const column = recordType === 'owner' ? personLinks.ownerId : personLinks.tenantId;
		const rows = await tx.select().from(personLinks).where(eq(column, recordId)).orderBy(desc(personLinks.createdAt), desc(personLinks.id));
		return rows.map(toView);
	}

	/**
	 * (a) Invitation depuis la fiche : le lien naît demandé et accepté par le membre ; le jeton n'est rendu qu'ici (il
	 * part par WhatsApp depuis l'écran, ou par SMS si demandé). La fiche doit avoir un numéro (point b).
	 */
	async invite(input: { id: string; recordType: PersonLinkRecordType; recordId: string; sendSms: boolean }) {
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		const actor = this.memberActor();
		await this.assertSpace(tx, input.recordType, actor.userId, scope.organizationId, scope.planId);
		const record = await this.records.resolver(input.recordType).byId(tx, input.recordId);
		if (!record) throw new AppError(input.recordType === 'owner' ? 'OWNER_NOT_FOUND' : 'TENANT_NOT_FOUND', 'Fiche introuvable.', 404);
		if (!record.phone) {
			throw new AppError('LINK_RECORD_NO_PHONE', 'Renseignez d’abord le numéro de la fiche : l’invitation part à ce numéro.', 409);
		}
		await this.revokeExpiredInvitations(tx, scope.organizationId, input.recordType, record.id);
		const token = `${scope.organizationId}.${randomBytes(32).toString('base64url')}`;
		const now = new Date();
		const [row] = await this.guard(() =>
			tx
				.insert(personLinks)
				.values({
					id: input.id,
					organizationId: scope.organizationId,
					userId: null,
					recordType: input.recordType,
					ownerId: input.recordType === 'owner' ? record.id : null,
					tenantId: input.recordType === 'tenant' ? record.id : null,
					status: 'requested',
					origin: 'organization_invite',
					phone: record.phone!,
					requestedBy: actor.userId,
					acceptedBy: actor.userId,
					acceptedAt: now,
					inviteTokenHash: sha256(token),
					inviteExpiresAt: new Date(now.getTime() + PERSON_LINK_INVITE_TTL_DAYS * DAY)
				})
				.returning()
		);
		await this.audit.record(tx, {
			actor,
			organizationId: scope.organizationId,
			action: 'person_link.invite',
			objectType: 'person_link',
			objectId: row!.id,
			after: { ...auditView(row!), sentBySms: input.sendSms }
		});
		const url = `${this.webUrl()}/lier/${token}`;
		if (input.sendSms) {
			const name = (await this.organizationOf(tx, scope.organizationId)).name;
			const r = await this.throttle.hit(counterKey('link-invite-sms', record.phone), 3, DAY);
			if (!r.allowed) throw new AppError('TOO_MANY_REQUESTS', 'Trop d’invitations envoyées à ce numéro aujourd’hui.', 429);
			RequestContext.afterCommit(() =>
				this.sms.send(record.phone!, `${name} vous invite à retrouver vos logements et vos documents sur Ziga : ${url}`)
			);
		}
		return { link: toView(row!), token, url };
	}

	/**
	 * « Renvoyer l'invitation » (jeton perdu, invitation expirée) : en une action, l'ancienne invitation est révoquée (motif
	 * « Invitation renvoyée ») et une nouvelle part, avec un nouveau jeton. Jamais pour une invitation déjà ouverte par une
	 * personne (elle demande un nouveau code depuis son espace), ni pour un lien actif.
	 */
	async resend(id: string, sendSms: boolean) {
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		const actor = this.memberActor();
		const l = await this.link(tx, id);
		if (l.origin !== 'organization_invite' || l.status !== 'requested') {
			throw new AppError('PERSON_LINK_STATUS', 'Seule une invitation en attente se renvoie.', 409);
		}
		if (l.userId) {
			throw new AppError(
				'PERSON_LINK_CLAIMED',
				'La personne a déjà ouvert l’invitation : elle peut demander un nouveau code depuis son espace.',
				409
			);
		}
		const [row] = await this.guard(() =>
			tx
				.update(personLinks)
				.set({
					status: 'revoked',
					revokedAt: new Date(),
					revokedBy: actor.userId,
					revokedByParty: 'organization',
					revocationReason: RESENT_INVITATION
				})
				.where(eq(personLinks.id, id))
				.returning()
		);
		await this.audit.record(tx, {
			actor,
			organizationId: scope.organizationId,
			action: 'person_link.revoke',
			objectType: 'person_link',
			objectId: id,
			before: auditView(l),
			after: { ...auditView(row!), revokedByParty: 'organization', reason: RESENT_INVITATION }
		});
		return this.invite({ id: newId(), recordType: l.recordType, recordId: (l.ownerId ?? l.tenantId)!, sendSms });
	}

	/** (b) Demande d'une personne : le membre l'accepte ; active si le numéro est déjà vérifié par le code. */
	async accept(id: string): Promise<PersonLinkView> {
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		const actor = this.memberActor();
		const l = await this.link(tx, id);
		if (l.status !== 'requested') throw new AppError('PERSON_LINK_STATUS', 'Cette liaison n’est plus en attente.', 409);
		if (l.acceptedBy) throw new AppError('PERSON_LINK_ALREADY_ACCEPTED', 'Cette liaison est déjà acceptée.', 409);
		const now = new Date();
		const [row] = await this.guard(() =>
			tx
				.update(personLinks)
				.set({ acceptedBy: actor.userId, acceptedAt: now, status: l.phoneVerifiedAt ? 'active' : 'requested' })
				.where(eq(personLinks.id, id))
				.returning()
		);
		await this.audit.record(tx, {
			actor,
			organizationId: scope.organizationId,
			subjectUserId: l.userId,
			action: 'person_link.accept',
			objectType: 'person_link',
			objectId: id,
			before: auditView(l),
			after: auditView(row!)
		});
		this.changed(l.userId);
		return toView(row!);
	}

	async revokeByOrganization(id: string, reason: string): Promise<PersonLinkView> {
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		const actor = this.memberActor();
		const l = await this.link(tx, id);
		if (l.status === 'revoked') throw new AppError('PERSON_LINK_REVOKED', 'Cette liaison est déjà révoquée.', 409);
		const [row] = await this.guard(() =>
			tx
				.update(personLinks)
				.set({
					status: 'revoked',
					revokedAt: new Date(),
					revokedBy: actor.userId,
					revokedByParty: 'organization',
					revocationReason: reason
				})
				.where(eq(personLinks.id, id))
				.returning()
		);
		await this.audit.record(tx, {
			actor,
			organizationId: scope.organizationId,
			subjectUserId: l.userId,
			action: 'person_link.revoke',
			objectType: 'person_link',
			objectId: id,
			before: auditView(l),
			after: { ...auditView(row!), revokedByParty: 'organization', reason }
		});
		this.changed(l.userId);
		return toView(row!);
	}

	// ---------------------------------------------------------------- invitation reçue (publique, puis connectée)

	/** Invitation vue avant de se connecter : le jeton suffit ; jamais la fiche, le numéro masqué. */
	async previewInvitation(token: string): Promise<PersonLinkInvitationPreview> {
		const organizationId = invitationOrganization(token);
		if (!organizationId) throw invalidInvitation();
		return this.database.withOrganization(organizationId, async (tx) => {
			const [l] = await tx
				.select()
				.from(personLinks)
				.where(eq(personLinks.inviteTokenHash, sha256(token)))
				.limit(1);
			if (!l) throw invalidInvitation();
			const o = await this.organizationOf(tx, organizationId);
			return {
				organizationName: o.name,
				recordType: l.recordType,
				phone: maskPhone(l.phone),
				expiresAt: l.inviteExpiresAt!.toISOString(),
				usable: l.status === 'requested' && l.claimedAt === null && l.inviteExpiresAt!.getTime() > Date.now()
			};
		});
	}

	/**
	 * La personne réclame l'invitation avec son compte : seulement au numéro de la fiche (un lien transféré ne sert à
	 * rien). Le code part ensuite au numéro de la fiche.
	 */
	async claimInvitation(userId: string, token: string): Promise<{ organizationId: string; linkId: string }> {
		const organizationId = invitationOrganization(token);
		if (!organizationId) throw invalidInvitation();
		const person = await this.account(userId);
		const linkId = await this.database.withOrganization(organizationId, (tx) =>
			RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, async () => {
				const [l] = await tx
					.select()
					.from(personLinks)
					.where(eq(personLinks.inviteTokenHash, sha256(token)))
					.limit(1)
					.for('update');
				if (!l || l.status !== 'requested' || l.inviteExpiresAt!.getTime() <= Date.now()) throw invalidInvitation();
				if (l.userId && l.userId !== userId) throw invalidInvitation();
				const o = await this.organizationOf(tx, organizationId);
				await this.assertSpace(tx, l.recordType, userId, organizationId, o.planId);
				if (person.phone !== l.phone) {
					throw new AppError(
						'LINK_PHONE_MISMATCH',
						`Cette invitation est destinée au ${maskPhone(l.phone)}. Connectez-vous avec ce numéro ; si le vôtre a changé, demandez à ${o.name} de corriger la fiche.`,
						409
					);
				}
				if (!l.userId) {
					const [row] = await this.guard(() =>
						tx.update(personLinks).set({ userId, claimedAt: new Date() }).where(eq(personLinks.id, l.id)).returning()
					);
					await this.audit.record(tx, {
						actor: { type: 'user', userId },
						organizationId,
						subjectUserId: userId,
						action: 'person_link.claim',
						objectType: 'person_link',
						objectId: l.id,
						before: auditView(l),
						after: auditView(row!),
						origin: 'portal'
					});
				}
				return l.id;
			})
		);
		await this.auth.sendLinkCode(userId, person.phone, linkId);
		return { organizationId, linkId };
	}

	// ---------------------------------------------------------------- personne (son espace)

	/**
	 * Ses liens en cours et actifs, avec le nom de chaque organisation. La propre fiche d'un bailleur particulier se lie
	 * d'abord, si elle peut l'être (réponse 2).
	 */
	async mine(userId: string, landlordDirectorOf: readonly string[]): Promise<MyPersonLinkView[]> {
		for (const organizationId of landlordDirectorOf) await this.linkLandlordSelf(userId, organizationId);
		const rows = await this.database.withUser(userId, (tx) =>
			tx.execute<{
				link_id: string;
				organization_id: string;
				organization_name: string;
				record_type: PersonLinkRecordType;
				status: 'requested' | 'active';
				phone_verified: boolean;
				accepted: boolean;
				created_at: string | Date;
			}>(sql`select * from my_person_link_overview()`)
		);
		return rows.rows.map((r) => ({
			id: r.link_id,
			organizationId: r.organization_id,
			organizationName: r.organization_name,
			recordType: r.record_type,
			status: r.status,
			phoneVerified: r.phone_verified,
			accepted: r.accepted,
			createdAt: new Date(r.created_at).toISOString()
		}));
	}

	/** Réponse 2 : la propre fiche du bailleur, à son numéro vérifié, par son directeur ; journalisé. Idempotent. */
	private async linkLandlordSelf(userId: string, organizationId: string): Promise<void> {
		const person = await this.account(userId);
		await this.database.withOrganization(organizationId, (tx) =>
			RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, async () => {
				const o = await this.organizationOf(tx, organizationId);
				const self = await this.records.resolver('owner').selfManaged!(tx);
				if (!self) return;
				const eligible = landlordSelfLinkEligible({
					organizationType: o.type as OrganizationType,
					isDirector: true,
					isSelfRecord: true,
					recordPhone: self.phone,
					accountPhone: person.phone,
					accountPhoneVerified: person.phoneVerifiedAt !== null
				});
				if (!eligible) return;
				await this.revokeExpiredInvitations(tx, organizationId, 'owner', self.id);
				const [existing] = await tx
					.select({ id: personLinks.id })
					.from(personLinks)
					.where(and(eq(personLinks.ownerId, self.id), ne(personLinks.status, 'revoked')))
					.limit(1);
				if (existing) return;
				// Révoquée par la personne : jamais reliée sans elle (elle refait la liaison si elle le veut).
				const [revokedByPerson] = await tx
					.select({ id: personLinks.id })
					.from(personLinks)
					.where(and(eq(personLinks.ownerId, self.id), eq(personLinks.revokedByParty, 'person'), eq(personLinks.userId, userId)))
					.limit(1);
				if (revokedByPerson) return;
				const now = new Date();
				const [row] = await this.guard(() =>
					tx
						.insert(personLinks)
						.values({
							id: newId(),
							organizationId,
							userId,
							recordType: 'owner',
							ownerId: self.id,
							status: 'active',
							origin: 'landlord_self',
							phone: person.phone,
							phoneVerifiedAt: person.phoneVerifiedAt,
							requestedBy: userId,
							acceptedBy: userId,
							acceptedAt: now
						})
						.returning()
				);
				await this.audit.record(tx, {
					actor: { type: 'user', userId, role: 'director' },
					organizationId,
					subjectUserId: userId,
					action: 'person_link.auto_link',
					objectType: 'person_link',
					objectId: row!.id,
					after: auditView(row!),
					origin: 'portal'
				});
			})
		);
	}

	/** Réponse 1 : les agences vérifiées, noms seulement. */
	async requestOrganizations(userId: string): Promise<LinkRequestOrganization[]> {
		const r = await this.database.withUser(userId, (tx) =>
			tx.execute<{ id: string; name: string }>(sql`select id, name from link_request_organizations()`)
		);
		return r.rows.map((o) => ({ id: o.id, name: o.name }));
	}

	/**
	 * (b) Demande depuis l'espace de la personne : la fiche est cherchée au numéro du compte dans cette agence seulement.
	 * Même réponse qu'elle existe ou non (aucune information sur les fiches de l'agence) ; si elle existe et n'est pas
	 * déjà liée, le lien naît demandé et le code part au numéro de la fiche.
	 */
	async request(userId: string, input: { id: string; organizationId: string; recordType: PersonLinkRecordType }): Promise<void> {
		const person = await this.account(userId);
		const windowMs = LINK_REQUEST_LIMITS.windowSeconds * 1000;
		for (const [key, limit] of [
			[counterKey('link-request-user', userId), LINK_REQUEST_LIMITS.perUser],
			[counterKey('link-request-phone', person.phone), LINK_REQUEST_LIMITS.perPhone]
		] as const) {
			const r = await this.throttle.hit(key, limit, windowMs);
			if (!r.allowed) {
				throw new AppError(
					'TOO_MANY_REQUESTS',
					'Trop de demandes de liaison aujourd’hui. Réessayez demain.',
					429,
					{ retryAfter: r.retryAfterSeconds },
					{ 'Retry-After': String(r.retryAfterSeconds) }
				);
			}
		}
		const created = await this.database.withOrganization(input.organizationId, (tx) =>
			RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, async () => {
				const [o] = await tx
					.select({ type: organizations.type, verificationStatus: organizations.verificationStatus, planId: organizations.planId })
					.from(organizations)
					.where(eq(organizations.id, input.organizationId))
					.limit(1);
				if (
					!o ||
					!canRequestLinkFrom({ type: o.type as OrganizationType, verificationStatus: o.verificationStatus as VerificationStatus })
				) {
					throw new AppError('PERSON_LINK_REQUEST_ORGANIZATION', 'Une demande de liaison ne vise qu’une agence vérifiée.', 409);
				}
				await this.assertSpace(tx, input.recordType, userId, input.organizationId, o.planId);
				if (
					linkPhoneBlocker({ recordPhone: person.phone, accountPhone: person.phone, accountPhoneVerified: person.phoneVerifiedAt !== null })
				) {
					return null;
				}
				// Plusieurs fiches au même numéro (doublon d'import) : la plus récemment modifiée, puis le plus grand identifiant
				// (ordre déterministe) ; les autres sont nommées au journal pour que l'agence corrige le doublon.
				const [record, ...duplicates] = await this.records.resolver(input.recordType).byPhone(tx, person.phone);
				if (!record) return null;
				await this.revokeExpiredInvitations(tx, input.organizationId, input.recordType, record.id);
				const column = input.recordType === 'owner' ? personLinks.ownerId : personLinks.tenantId;
				const [existing] = await tx
					.select()
					.from(personLinks)
					.where(and(eq(column, record.id), ne(personLinks.status, 'revoked')))
					.limit(1);
				// Déjà demandée par elle (code perdu) : un nouveau code ; liée à une autre personne ou déjà active : rien.
				if (existing) return existing.userId === userId && existing.status === 'requested' ? existing.id : null;
				const [row] = await this.guard(() =>
					tx
						.insert(personLinks)
						.values({
							id: input.id,
							organizationId: input.organizationId,
							userId,
							recordType: input.recordType,
							ownerId: input.recordType === 'owner' ? record.id : null,
							tenantId: input.recordType === 'tenant' ? record.id : null,
							status: 'requested',
							origin: 'person_request',
							phone: person.phone,
							requestedBy: userId
						})
						.returning()
				);
				await this.audit.record(tx, {
					actor: { type: 'user', userId },
					organizationId: input.organizationId,
					subjectUserId: userId,
					action: 'person_link.request',
					objectType: 'person_link',
					objectId: row!.id,
					after: { ...auditView(row!), ...(duplicates.length ? { otherRecordsWithSamePhone: duplicates.map((d) => d.id) } : {}) },
					origin: 'portal'
				});
				return row!.id;
			})
		);
		if (created) await this.auth.sendLinkCode(userId, person.phone, created);
	}

	/** Un nouveau code pour un lien demandé par elle (code perdu ou expiré). */
	async resendCode(userId: string, linkId: string, organizationId: string): Promise<void> {
		const person = await this.account(userId);
		await this.database.withOrganization(organizationId, async (tx) => {
			const l = await this.link(tx, linkId);
			if (l.userId !== userId || l.status !== 'requested' || l.phoneVerifiedAt) throw linkNotFound();
		});
		await this.auth.sendLinkCode(userId, person.phone, linkId);
	}

	/**
	 * Le code reçu au numéro de la fiche : le numéro est vérifié ; le lien devient actif s'il est déjà accepté par
	 * l'organisation (invitation), sinon il attend son acceptation (demande). Code faux, expiré ou épuisé : refusé.
	 */
	async verify(userId: string, linkId: string, input: { organizationId: string; code: string }, ip: string): Promise<MyPersonLinkView> {
		const person = await this.account(userId);
		if (!(await this.auth.consumeLinkCode(userId, person.phone, linkId, input.code, ip))) {
			throw new AppError('INVALID_CODE', 'Code invalide ou expiré. Demandez un nouveau code.', 400);
		}
		await this.database.withOrganization(input.organizationId, (tx) =>
			RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, async () => {
				const l = await this.link(tx, linkId);
				if (l.userId !== userId || l.status !== 'requested') throw linkNotFound();
				const [row] = await this.guard(() =>
					tx
						.update(personLinks)
						.set({ phoneVerifiedAt: new Date(), status: l.acceptedBy ? 'active' : 'requested' })
						.where(eq(personLinks.id, linkId))
						.returning()
				);
				await this.audit.record(tx, {
					actor: { type: 'user', userId },
					organizationId: input.organizationId,
					subjectUserId: userId,
					action: 'person_link.verify',
					objectType: 'person_link',
					objectId: linkId,
					before: auditView(l),
					after: auditView(row!),
					origin: 'portal'
				});
			})
		);
		await this.notify(userId);
		const mine = await this.mine(userId, []);
		const view = mine.find((m) => m.id === linkId);
		if (!view) throw linkNotFound();
		return view;
	}

	/** La personne révoque l'un de ses liens, motivé ; rien n'est supprimé dans l'organisation. */
	async revokeByPerson(userId: string, linkId: string, input: { organizationId: string; reason: string }): Promise<void> {
		await this.database.withOrganization(input.organizationId, (tx) =>
			RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, async () => {
				const l = await this.link(tx, linkId);
				if (l.userId !== userId || l.status === 'revoked') throw linkNotFound();
				const [row] = await this.guard(() =>
					tx
						.update(personLinks)
						.set({ status: 'revoked', revokedAt: new Date(), revokedBy: userId, revokedByParty: 'person', revocationReason: input.reason })
						.where(eq(personLinks.id, linkId))
						.returning()
				);
				await this.audit.record(tx, {
					actor: { type: 'user', userId },
					organizationId: input.organizationId,
					subjectUserId: userId,
					action: 'person_link.revoke',
					objectType: 'person_link',
					objectId: linkId,
					before: auditView(l),
					after: { ...auditView(row!), revokedByParty: 'person', reason: input.reason },
					origin: 'portal'
				});
			})
		);
		await this.notify(userId);
	}
}
