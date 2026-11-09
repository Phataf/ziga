/**
 * Organisations (lot 03, D12) : création, paramètres (fiche, identifiants, représentant légal), équipe, invitations
 * et journal. Toute écriture passe par la transaction de l'organisation active (RequestContext.tx()) et écrit sa
 * ligne d'audit dans la même transaction, avec les valeurs avant et après.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { isUuid, newId } from '@ziga/shared/ids';
import {
	INVITATION_TTL_DAYS,
	type InvitationPreview,
	type InvitationView,
	type MemberView,
	type MembershipView,
	type OrganizationView,
	type PaymentMethod,
	type Representative,
	type UpdateOrganizationInput
} from '@ziga/shared/organizations';
import { formatPhone } from '@ziga/shared/phone';
import type { OrganizationRole, OrganizationType } from '@ziga/shared/permissions';
import type { AuditEntryView } from '@ziga/shared/organizations';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { users } from '../../db/schema/identity.js';
import { organizationInvitations, organizationLogos, organizationMembers, organizations } from '../../db/schema/organizations.js';
import { auditPage } from '../audit/audit-page.js';
import { AuditService, diff } from '../audit/audit.service.js';
import { FeaturesService } from '../features/features.service.js';
import { QuotasService } from '../features/quotas.service.js';
import { AuthService } from '../identity/auth.service.js';
import { sha256 } from '../identity/secrets.js';

type OrganizationRow = typeof organizations.$inferSelect;
type LogoRow = typeof organizationLogos.$inferSelect;

const DAY = 24 * 60 * 60 * 1000;
const invalidInvitation = () => new AppError('INVITATION_INVALID', 'Cette invitation n’est plus valable. Demandez-en une nouvelle.', 410);

/** Lien d'invitation : « <organization_id>.<secret> » ; seule l'empreinte du lien entier est gardée. */
export function newInvitationToken(organizationId: string): string {
	return `${organizationId}.${randomBytes(32).toString('base64url')}`;
}

export function invitationOrganization(token: string): string | null {
	const [organizationId, secret, extra] = token.split('.');
	if (extra !== undefined || !secret || secret.length < 40 || !isUuid(organizationId)) return null;
	return organizationId!;
}

/** « +226 70 •• •• 56 » : l'invitation montre à qui elle s'adresse sans afficher tout le numéro. */
export function maskPhone(phone: string): string {
	const parts = formatPhone(phone).split(/[\s\u00a0\u202f]+/u);
	return parts.map((p, i) => (i === 0 || i === 1 || i === parts.length - 1 ? p : '••')).join(' ');
}

function representativeOf(o: OrganizationRow): Representative {
	return {
		name: o.repName,
		title: o.repTitle,
		profession: o.repProfession,
		address: o.repAddress,
		nationality: o.repNationality,
		idType: o.repIdType,
		idTypeOther: o.repIdTypeOther,
		idNumber: o.repIdNumber,
		idIssuedOn: o.repIdIssuedOn,
		idIssuedBy: o.repIdIssuedBy
	};
}

/** Champs modifiables, à plat, pour comparer avant et après. */
function settingsOf(o: OrganizationRow) {
	return {
		legalName: o.legalName,
		tradeName: o.tradeName,
		phone: o.phone,
		address: o.address,
		commune: o.commune,
		poBox: o.poBox,
		rccm: o.rccm,
		ifu: o.ifu,
		representative: representativeOf(o)
	};
}

@Injectable()
export class OrganizationsService implements OnModuleInit {
	constructor(
		private readonly database: DatabaseService,
		private readonly audit: AuditService,
		@Inject(APP_CONFIG) private readonly config: AppConfig,
		private readonly features: FeaturesService,
		private readonly quotas: QuotasService,
		private readonly auth: AuthService
	) {}

	onModuleInit(): void {
		this.auth.onNameChange((userId, name) => this.renameMember(userId, name));
	}

	/** Nom affiché d'un membre (lot 05, D30) : recopié du compte, pour synchroniser l'équipe sans répliquer `users`. */
	private async nameOf(tx: Tx, userId: string): Promise<string> {
		const [row] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
		return row?.name ?? '';
	}

	/**
	 * Changement de nom d'une personne : son nom affiché suit dans chacune de ses organisations, une à la fois,
	 * chacune dans son propre contexte (règle 1).
	 */
	async renameMember(userId: string, name: string): Promise<void> {
		const memberships = await this.database.withUser(userId, (tx) =>
			tx
				.select({ organizationId: organizationMembers.organizationId })
				.from(organizationMembers)
				.where(eq(organizationMembers.userId, userId))
		);
		for (const { organizationId } of memberships) {
			await this.database.withOrganization(organizationId, (tx) =>
				tx
					.update(organizationMembers)
					.set({ displayName: name, updatedAt: new Date() })
					.where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
			);
		}
	}

	private actor() {
		const ctx = RequestContext.get();
		const scope = RequestContext.organization();
		return { type: 'user' as const, userId: ctx!.userId!, role: scope.role };
	}

	logoUrl(organizationId: string, logoId: string, variant: 'web.webp' | 'print.png'): string {
		return `${this.config.API_PUBLIC_URL.replace(/\/$/, '')}/logos/${organizationId}/${logoId}/${variant}`;
	}

	logoView(logo: LogoRow | null | undefined) {
		if (!logo) return null;
		const ready = logo.status === 'ready';
		return {
			id: logo.id,
			status: logo.status,
			webUrl: ready ? this.logoUrl(logo.organizationId, logo.id, 'web.webp') : null,
			pdfUrl: ready ? this.logoUrl(logo.organizationId, logo.id, 'print.png') : null
		};
	}

	// ------------------------------------------------------------ appartenances (contexte personnel)

	async listMine(userId: string): Promise<MembershipView[]> {
		const rows = await this.database.withUser(userId, (tx) =>
			tx
				.select({ m: organizationMembers, o: organizations })
				.from(organizationMembers)
				.innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
				.where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active')))
				.orderBy(organizations.legalName)
		);
		return rows.map(({ m, o }) => ({
			organizationId: o.id,
			type: o.type,
			name: o.tradeName ?? o.legalName,
			role: m.role,
			verificationStatus: o.verificationStatus
		}));
	}

	// ------------------------------------------------------------ création

	/**
	 * Création par une personne connectée, qui en devient directrice (statut « en attente » de vérification).
	 * Elle se fait dans le contexte de la nouvelle organisation : aucune exception au cloisonnement.
	 */
	async create(
		userId: string,
		input: { id: string; type: OrganizationType; legalName: string; phone: string; commune: string }
	): Promise<MembershipView> {
		const exists = await this.database.withOrganization(input.id, (tx) =>
			tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, input.id)).limit(1)
		);
		if (exists.length) throw new AppError('CONFLICT', 'Cette organisation existe déjà.', 409);
		return this.database.withOrganization(input.id, async (tx) => {
			const [org] = await tx
				.insert(organizations)
				.values({
					id: input.id,
					type: input.type,
					legalName: input.legalName,
					phone: input.phone,
					commune: input.commune,
					createdBy: userId,
					verificationStatus: 'pending'
				})
				.returning();
			const memberId = newId();
			await tx
				.insert(organizationMembers)
				.values({
					id: memberId,
					organizationId: org!.id,
					userId,
					role: 'director',
					status: 'active',
					displayName: await this.nameOf(tx, userId)
				});
			const actor = { type: 'user' as const, userId, role: 'director' };
			await this.audit.record(tx, {
				actor,
				organizationId: org!.id,
				action: 'organization.create',
				objectType: 'organization',
				objectId: org!.id,
				after: {
					type: org!.type,
					legalName: org!.legalName,
					phone: org!.phone,
					commune: org!.commune,
					verificationStatus: org!.verificationStatus
				}
			});
			await this.audit.record(tx, {
				actor,
				organizationId: org!.id,
				action: 'member.create',
				objectType: 'organization_member',
				objectId: memberId,
				after: { userId, role: 'director', status: 'active' }
			});
			return {
				organizationId: org!.id,
				type: org!.type,
				name: org!.legalName,
				role: 'director',
				verificationStatus: org!.verificationStatus
			};
		});
	}

	// ------------------------------------------------------------ fiche et paramètres

	private async row(tx: Tx): Promise<OrganizationRow> {
		const [org] = await tx.select().from(organizations).limit(2);
		if (!org) throw new AppError('NOT_FOUND', 'Organisation introuvable.', 404);
		return org;
	}

	async view(tx: Tx = RequestContext.tx()): Promise<OrganizationView> {
		const org = await this.row(tx);
		const [logo] = org.logoId ? await tx.select().from(organizationLogos).where(eq(organizationLogos.id, org.logoId)).limit(1) : [];
		// Dernier envoi en cours ou en échec, s'il est plus récent que le logo actif : l'écran montre son état.
		const [latest] = await tx.select().from(organizationLogos).orderBy(desc(organizationLogos.createdAt)).limit(1);
		const shown = latest && latest.id !== logo?.id && latest.status !== 'ready' ? latest : logo;
		return {
			id: org.id,
			type: org.type,
			...settingsOf(org),
			verificationStatus: org.verificationStatus,
			logo: this.logoView(shown ?? null),
			planId: org.planId,
			acceptedPaymentMethods: org.acceptedPaymentMethods,
			createdAt: org.createdAt.toISOString(),
			updatedAt: org.updatedAt.toISOString()
		};
	}

	async update(input: UpdateOrganizationInput & Record<string, unknown>): Promise<OrganizationView> {
		const tx = RequestContext.tx();
		const org = await this.row(tx);
		const before = settingsOf(org);
		const after = { ...before, ...input } as typeof before;
		const changes = diff(before, input as Partial<typeof before>);
		if (!changes) return this.view(tx);
		const r = after.representative;
		await tx
			.update(organizations)
			.set({
				legalName: after.legalName,
				tradeName: after.tradeName,
				phone: after.phone,
				address: after.address,
				commune: after.commune,
				poBox: after.poBox,
				rccm: after.rccm,
				ifu: after.ifu,
				repName: r.name,
				repTitle: r.title,
				repProfession: r.profession,
				repAddress: r.address,
				repNationality: r.nationality,
				repIdType: r.idType,
				repIdTypeOther: r.idTypeOther,
				repIdNumber: r.idNumber,
				repIdIssuedOn: r.idIssuedOn,
				repIdIssuedBy: r.idIssuedBy,
				updatedAt: new Date()
			})
			.where(eq(organizations.id, org.id));
		await this.audit.record(tx, {
			actor: this.actor(),
			organizationId: org.id,
			action: 'organization.update',
			objectType: 'organization',
			objectId: org.id,
			...changes
		});
		return this.view(tx);
	}

	// ------------------------------------------------------------ équipe

	async members(): Promise<MemberView[]> {
		const tx = RequestContext.tx();
		const me = RequestContext.get()!.userId;
		const rows = await tx
			.select({ m: organizationMembers, name: users.name, phone: users.phone })
			.from(organizationMembers)
			.innerJoin(users, eq(users.id, organizationMembers.userId))
			.where(eq(organizationMembers.status, 'active'))
			.orderBy(organizationMembers.joinedAt);
		return rows.map(({ m, name, phone }) => ({
			id: m.id,
			userId: m.userId,
			name,
			phone,
			role: m.role,
			status: m.status,
			joinedAt: m.joinedAt.toISOString(),
			current: m.userId === me
		}));
	}

	private async activeMember(tx: Tx, memberId: string) {
		const [member] = await tx
			.select()
			.from(organizationMembers)
			.where(and(eq(organizationMembers.id, memberId), eq(organizationMembers.status, 'active')))
			.limit(1)
			.for('update');
		if (!member) throw new AppError('NOT_FOUND', 'Membre introuvable.', 404);
		return member;
	}

	/** Il reste un autre directeur actif ? (la base le vérifie aussi, sous verrou) */
	private async otherDirectors(tx: Tx, memberId: string): Promise<number> {
		const [row] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.status, 'active'),
					eq(organizationMembers.role, 'director'),
					sql`${organizationMembers.id} <> ${memberId}`
				)
			);
		return row?.n ?? 0;
	}

	async changeRole(memberId: string, role: OrganizationRole): Promise<MemberView[]> {
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		if (scope.organizationType === 'landlord' && role !== 'director') {
			throw new AppError('LANDLORD_SINGLE_MEMBER', 'Un bailleur particulier reste directeur de ses logements.', 409);
		}
		const member = await this.activeMember(tx, memberId);
		if (member.role === role) return this.members();
		if (member.role === 'director' && !(await this.otherDirectors(tx, memberId))) {
			throw new AppError('LAST_DIRECTOR', 'L’organisation doit garder au moins un directeur.', 409);
		}
		await tx.update(organizationMembers).set({ role, updatedAt: new Date() }).where(eq(organizationMembers.id, memberId));
		await this.audit.record(tx, {
			actor: this.actor(),
			organizationId: scope.organizationId,
			action: 'member.change_role',
			objectType: 'organization_member',
			objectId: memberId,
			before: { role: member.role },
			after: { role }
		});
		return this.members();
	}

	/** Retrait : la personne perd l'accès à sa prochaine requête (appartenance relue à chaque requête). */
	async remove(memberId: string): Promise<void> {
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		const member = await this.activeMember(tx, memberId);
		if (member.role === 'director' && !(await this.otherDirectors(tx, memberId))) {
			throw new AppError('LAST_DIRECTOR', 'L’organisation doit garder au moins un directeur.', 409);
		}
		const now = new Date();
		const by = RequestContext.get()!.userId!;
		await tx
			.update(organizationMembers)
			.set({ status: 'removed', removedAt: now, removedBy: by, updatedAt: now })
			.where(eq(organizationMembers.id, memberId));
		await this.audit.record(tx, {
			actor: this.actor(),
			organizationId: scope.organizationId,
			action: 'member.remove',
			objectType: 'organization_member',
			objectId: memberId,
			before: { role: member.role, status: 'active' },
			after: { role: member.role, status: 'removed' }
		});
	}

	// ------------------------------------------------------------ invitations

	async invitations(): Promise<InvitationView[]> {
		const tx = RequestContext.tx();
		const rows = await tx
			.select({ i: organizationInvitations, invitedBy: users.name })
			.from(organizationInvitations)
			.innerJoin(users, eq(users.id, organizationInvitations.invitedBy))
			.where(
				and(
					isNull(organizationInvitations.acceptedAt),
					isNull(organizationInvitations.revokedAt),
					gt(organizationInvitations.expiresAt, new Date())
				)
			)
			.orderBy(desc(organizationInvitations.createdAt));
		return rows.map(({ i, invitedBy }) => ({
			id: i.id,
			phone: i.phone,
			role: i.role,
			invitedBy,
			expiresAt: i.expiresAt.toISOString(),
			createdAt: i.createdAt.toISOString()
		}));
	}

	/** Invitation par téléphone : le lien (renvoyé une seule fois) est à envoyer par WhatsApp. */
	async invite(phone: string, role: OrganizationRole): Promise<{ invitation: InvitationView; token: string }> {
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		if (scope.organizationType === 'landlord') {
			throw new AppError('LANDLORD_SINGLE_MEMBER', 'Un bailleur particulier gère seul ses logements : pas de second membre.', 409);
		}
		const [already] = await tx
			.select({ id: organizationMembers.id })
			.from(organizationMembers)
			.innerJoin(users, eq(users.id, organizationMembers.userId))
			.where(and(eq(users.phone, phone), eq(organizationMembers.status, 'active')))
			.limit(1);
		if (already) throw new AppError('ALREADY_MEMBER', 'Cette personne est déjà membre de l’organisation.', 409);
		// Agent de terrain : fonctionnalité liée aux formules (Essentiel, Pro), vérifiée côté serveur.
		if (role === 'field_agent') {
			await this.features.assertEnabled(
				'field_agents',
				RequestContext.get()!.userId!,
				await this.features.organizationContext(scope.organizationId, scope.planId, tx)
			);
		}
		// Quota d'utilisateurs de la formule : membres actifs et invitations en attente (sauf celle de ce numéro, remplacée).
		await this.quotas.assert(scope.organizationId, scope.planId, 'users', await this.seatsUsed(tx, phone));
		const actor = this.actor();
		const now = new Date();
		// Une seule invitation en cours par numéro : la précédente est révoquée.
		const previous = await tx
			.update(organizationInvitations)
			.set({ revokedAt: now, revokedBy: actor.userId })
			.where(
				and(eq(organizationInvitations.phone, phone), isNull(organizationInvitations.acceptedAt), isNull(organizationInvitations.revokedAt))
			)
			.returning({ id: organizationInvitations.id });
		for (const p of previous) {
			await this.audit.record(tx, {
				actor,
				organizationId: scope.organizationId,
				action: 'invitation.revoke',
				objectType: 'organization_invitation',
				objectId: p.id,
				after: { reason: 'replaced' }
			});
		}
		const token = newInvitationToken(scope.organizationId);
		const id = newId();
		const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * DAY);
		await tx
			.insert(organizationInvitations)
			.values({ id, organizationId: scope.organizationId, phone, role, tokenHash: sha256(token), invitedBy: actor.userId, expiresAt });
		await this.audit.record(tx, {
			actor,
			organizationId: scope.organizationId,
			action: 'invitation.create',
			objectType: 'organization_invitation',
			objectId: id,
			after: { phone, role, expiresAt: expiresAt.toISOString() }
		});
		const [inviter] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId)).limit(1);
		return {
			invitation: { id, phone, role, invitedBy: inviter?.name ?? '', expiresAt: expiresAt.toISOString(), createdAt: now.toISOString() },
			token
		};
	}

	/** Places occupées : membres actifs et invitations en attente encore valables (hors `exceptPhone`). */
	private async seatsUsed(tx: Tx, exceptPhone?: string): Promise<number> {
		const [members] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(organizationMembers)
			.where(eq(organizationMembers.status, 'active'));
		const [pending] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(organizationInvitations)
			.where(
				and(
					isNull(organizationInvitations.acceptedAt),
					isNull(organizationInvitations.revokedAt),
					gt(organizationInvitations.expiresAt, new Date()),
					exceptPhone ? sql`${organizationInvitations.phone} <> ${exceptPhone}` : undefined
				)
			);
		return (members?.n ?? 0) + (pending?.n ?? 0);
	}

	/** Moyens de paiement acceptés (D18) : réglage de l'organisation, au moins un actif (contrainte en base aussi). */
	async setPaymentMethods(methods: PaymentMethod[]): Promise<OrganizationView> {
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		const org = await this.row(tx);
		if (JSON.stringify(org.acceptedPaymentMethods) !== JSON.stringify(methods)) {
			await tx.update(organizations).set({ acceptedPaymentMethods: methods, updatedAt: new Date() }).where(eq(organizations.id, org.id));
			await this.audit.record(tx, {
				actor: this.actor(),
				organizationId: scope.organizationId,
				action: 'organization.payment_methods',
				objectType: 'organization',
				objectId: org.id,
				before: { acceptedPaymentMethods: org.acceptedPaymentMethods },
				after: { acceptedPaymentMethods: methods }
			});
		}
		return this.view(tx);
	}

	async revokeInvitation(invitationId: string): Promise<void> {
		const tx = RequestContext.tx();
		const scope = RequestContext.organization();
		const actor = this.actor();
		const revoked = await tx
			.update(organizationInvitations)
			.set({ revokedAt: new Date(), revokedBy: actor.userId })
			.where(
				and(
					eq(organizationInvitations.id, invitationId),
					isNull(organizationInvitations.acceptedAt),
					isNull(organizationInvitations.revokedAt)
				)
			)
			.returning({ id: organizationInvitations.id, phone: organizationInvitations.phone, role: organizationInvitations.role });
		if (!revoked.length) throw new AppError('NOT_FOUND', 'Invitation introuvable.', 404);
		await this.audit.record(tx, {
			actor,
			organizationId: scope.organizationId,
			action: 'invitation.revoke',
			objectType: 'organization_invitation',
			objectId: invitationId,
			before: { phone: revoked[0]!.phone, role: revoked[0]!.role, status: 'pending' },
			after: { status: 'revoked' }
		});
	}

	/** Invitation valable lue par son lien, dans le contexte de son organisation (le lien la désigne). */
	private async invitationByToken(tx: Tx, token: string) {
		const [row] = await tx
			.select({ i: organizationInvitations, o: organizations, invitedBy: users.name })
			.from(organizationInvitations)
			.innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
			.innerJoin(users, eq(users.id, organizationInvitations.invitedBy))
			.where(eq(organizationInvitations.tokenHash, sha256(token)))
			.limit(1)
			.for('update', { of: organizationInvitations });
		if (!row || row.i.acceptedAt || row.i.revokedAt || row.i.expiresAt.getTime() <= Date.now()) throw invalidInvitation();
		return row;
	}

	async previewInvitation(token: string): Promise<InvitationPreview> {
		const organizationId = invitationOrganization(token);
		if (!organizationId) throw invalidInvitation();
		return this.database.withOrganization(organizationId, async (tx) => {
			const { i, o, invitedBy } = await this.invitationByToken(tx, token);
			return {
				organizationName: o.tradeName ?? o.legalName,
				organizationType: o.type,
				role: i.role,
				invitedBy,
				phone: maskPhone(i.phone),
				expiresAt: i.expiresAt.toISOString()
			};
		});
	}

	/**
	 * Acceptation : seulement par la personne dont le numéro vérifié est celui de l'invitation
	 * (un lien transféré ne sert à rien). Une ancienne appartenance retirée est réactivée.
	 */
	async acceptInvitation(token: string, userId: string): Promise<MembershipView> {
		const organizationId = invitationOrganization(token);
		if (!organizationId) throw invalidInvitation();
		const [person] = await this.database.db.select().from(users).where(eq(users.id, userId)).limit(1);
		if (!person || person.status !== 'active') throw new AppError('UNAUTHORIZED', 'Authentification requise.', 401);
		return this.database.withOrganization(organizationId, async (tx) => {
			const { i, o } = await this.invitationByToken(tx, token);
			if (i.phone !== person.phone) {
				throw new AppError(
					'INVITATION_OTHER_PHONE',
					`Cette invitation est destinée au ${maskPhone(i.phone)}. Connectez-vous avec ce numéro.`,
					403
				);
			}
			const now = new Date();
			const [existing] = await tx.select().from(organizationMembers).where(eq(organizationMembers.userId, userId)).limit(1).for('update');
			const actor = { type: 'user' as const, userId, role: i.role };
			let memberId: string;
			if (existing?.status === 'active') {
				throw new AppError('ALREADY_MEMBER', 'Vous êtes déjà membre de cette organisation.', 409);
			} else if (existing) {
				memberId = existing.id;
				await tx
					.update(organizationMembers)
					.set({
						status: 'active',
						role: i.role,
						removedAt: null,
						removedBy: null,
						invitedBy: i.invitedBy,
						joinedAt: now,
						updatedAt: now,
						displayName: await this.nameOf(tx, userId)
					})
					.where(eq(organizationMembers.id, existing.id));
			} else {
				memberId = newId();
				await tx.insert(organizationMembers).values({
					id: memberId,
					organizationId,
					userId,
					role: i.role,
					status: 'active',
					invitedBy: i.invitedBy,
					displayName: await this.nameOf(tx, userId)
				});
			}
			await tx.update(organizationInvitations).set({ acceptedAt: now, acceptedBy: userId }).where(eq(organizationInvitations.id, i.id));
			await this.audit.record(tx, {
				actor,
				organizationId,
				action: 'invitation.accept',
				objectType: 'organization_invitation',
				objectId: i.id,
				before: { status: 'pending' },
				after: { status: 'accepted' }
			});
			await this.audit.record(tx, {
				actor,
				organizationId,
				action: existing ? 'member.reactivate' : 'member.create',
				objectType: 'organization_member',
				objectId: memberId,
				before: existing ? { role: existing.role, status: existing.status } : null,
				after: { userId, role: i.role, status: 'active' }
			});
			return { organizationId, type: o.type, name: o.tradeName ?? o.legalName, role: i.role, verificationStatus: o.verificationStatus };
		});
	}

	// ------------------------------------------------------------ back-office (transaction app_admin fournie par le module admin)

	/** Annuaire des organisations : compte seulement (fonction platform_organization_directory). */
	async directory(tx: Tx) {
		const result = await tx.execute(sql`select * from platform_organization_directory() order by created_at desc`);
		return (result.rows as Record<string, unknown>[]).map((r) => ({
			id: r.id as string,
			type: r.type as OrganizationType,
			legalName: r.legal_name as string,
			name: ((r.trade_name as string | null) ?? r.legal_name) as string,
			phone: r.phone as string,
			commune: r.commune as string,
			verificationStatus: r.verification_status as 'pending' | 'verified' | 'suspended',
			suspendedReason: (r.suspended_reason as string | null) ?? null,
			planId: r.plan_id as string,
			members: Number(r.members),
			createdAt: new Date(r.created_at as string).toISOString()
		}));
	}

	async directoryMembers(tx: Tx, organizationId: string) {
		const result = await tx.execute(sql`select * from platform_organization_members(${organizationId}::uuid)`);
		return (result.rows as Record<string, unknown>[]).map((r) => ({
			userId: r.user_id as string,
			name: r.name as string,
			phone: r.phone as string,
			role: r.role as OrganizationRole,
			joinedAt: new Date(r.joined_at as string).toISOString()
		}));
	}

	async membershipsOfPerson(tx: Tx, userId: string) {
		const result = await tx.execute(sql`select * from platform_user_memberships(${userId}::uuid)`);
		return (result.rows as Record<string, unknown>[]).map((r) => ({
			organizationId: r.organization_id as string,
			name: r.name as string,
			type: r.type as OrganizationType,
			role: r.role as OrganizationRole,
			planId: r.plan_id as string
		}));
	}

	/** Validation, suspension, réintégration (transaction app_admin dans le contexte de l'organisation). */
	async setVerification(
		tx: Tx,
		actor: { type: 'user'; userId: string; role: string },
		organizationId: string,
		status: 'verified' | 'suspended' | 'reinstated',
		reason: string | null
	) {
		const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1).for('update');
		if (!org) throw new AppError('NOT_FOUND', 'Organisation introuvable.', 404);
		const now = new Date();
		let values: Partial<typeof organizations.$inferInsert>;
		if (status === 'verified') {
			if (org.verificationStatus === 'suspended')
				throw new AppError('ORGANIZATION_SUSPENDED', 'Réintégrez d’abord l’organisation suspendue.', 409);
			if (org.type === 'agency' && (!org.rccm || !org.ifu)) {
				throw new AppError(
					'VERIFICATION_INCOMPLETE',
					'Une agence n’est vérifiée qu’avec son RCCM et son IFU, à renseigner dans ses paramètres.',
					409
				);
			}
			values = { verificationStatus: 'verified', verifiedAt: now };
		} else if (status === 'suspended') {
			values = { verificationStatus: 'suspended', suspendedAt: now, suspendedReason: reason };
		} else {
			if (org.verificationStatus !== 'suspended') throw new AppError('NOT_SUSPENDED', 'Cette organisation n’est pas suspendue.', 409);
			values = { verificationStatus: org.verifiedAt ? 'verified' : 'pending', suspendedAt: null, suspendedReason: null };
		}
		await tx
			.update(organizations)
			.set({ ...values, updatedAt: now })
			.where(eq(organizations.id, organizationId));
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: status === 'verified' ? 'organization.verify' : status === 'suspended' ? 'organization.suspend' : 'organization.reinstate',
			objectType: 'organization',
			objectId: organizationId,
			before: { verificationStatus: org.verificationStatus },
			after: { verificationStatus: values.verificationStatus, ...(reason ? { reason } : {}) },
			origin: 'admin'
		});
	}

	/** Changement de formule (rôle sales), journalisé chez l'organisation. */
	async setPlan(tx: Tx, actor: { type: 'user'; userId: string; role: string }, organizationId: string, planId: string, reason: string) {
		const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1).for('update');
		if (!org) throw new AppError('NOT_FOUND', 'Organisation introuvable.', 404);
		if (org.planId === planId) return false;
		await tx.update(organizations).set({ planId, updatedAt: new Date() }).where(eq(organizations.id, organizationId));
		await this.audit.record(tx, {
			actor,
			organizationId,
			action: 'organization.change_plan',
			objectType: 'organization',
			objectId: organizationId,
			before: { planId: org.planId },
			after: { planId, reason },
			origin: 'admin'
		});
		return true;
	}

	// ------------------------------------------------------------ journal

	/** Journal de l'organisation, du plus récent au plus ancien, par curseur (identifiant UUIDv7, ordonné dans le temps). */
	async auditPage(cursor: string | undefined, limit = 50): Promise<{ entries: AuditEntryView[]; next: string | null }> {
		const tx = RequestContext.tx();
		return auditPage(tx, cursor, limit, []);
	}
}
