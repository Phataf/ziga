/**
 * Espaces personnels (lot 10 ter, étape 2b) : le propriétaire voit tous ses biens, le locataire tout son historique,
 * quelle que soit l'organisation (D13, D17, règle 15 de CLAUDE.md). Lecture seule.
 *
 * - La seule lecture hors organisation : my_person_links(), les identifiants des liens actifs de la personne connectée.
 * - Puis chaque organisation, l'une après l'autre, dans sa propre transaction (withOrganization) : une ligne d'audit
 *   `portal.read` y est écrite (origine portal, la personne en acteur et en sujet), puis seule la fiche liée est lue,
 *   par les services publics des modules (properties, leases, payments, organizations). Aucune requête ne lit deux
 *   organisations ; une organisation suspendue reste lisible (réponse du porteur au lot 03).
 * - Interrupteurs : l'espace (`portals.owner_space`, `portals.tenant_space`) pour la personne, puis pour chaque
 *   organisation lue (une organisation qui l'a coupé n'est pas lue).
 * - Cache court (30 s) dans Redis : sa clé contient l'empreinte de l'ensemble des liens actifs. Une révocation change
 *   cet ensemble : la lecture suivante ne retrouve jamais l'ancienne réponse (point d) ; les clés de la personne sont
 *   aussi effacées dès qu'un de ses liens change. Une réponse servie par le cache a été lue et journalisée moins de
 *   30 secondes plus tôt.
 */
import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FeatureKey } from '@ziga/shared/features';
import { linkSetFingerprint, type ActivePersonLink, type PersonLinkRecordType } from '@ziga/shared/person-links';
import { sql } from 'drizzle-orm';
import { AppError } from '../../common/app-error.js';
import { RequestContext } from '../../common/request-context.js';
import { DatabaseService } from '../../db/database.module.js';
import type { Tx } from '../../db/database.js';
import { RedisService } from '../../redis/redis.module.js';
import { AuditService } from '../audit/audit.service.js';
import { FeaturesService } from '../features/features.service.js';
import { ExitService } from '../leases/exit.service.js';
import { LeasesService, type PartyCurrentLease, type PartyTenantLease } from '../leases/leases.service.js';
import { OwnersService } from '../owners/owners.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { PersonLinksService } from '../organizations/person-links.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { StatementsService } from '../collections/statements.service.js';
import { DocumentsService, type PartyDocument } from '../documents/documents.service.js';
import { DIRECT_PAYMENT_DISABLED_REASON, ownerIncome, type IncomeMonth, type IncomeProperty } from '@ziga/shared/portals';
import type { ContractStatus } from '@ziga/shared/contracts';
import { toIsoDate } from '@ziga/shared/dates';
import { PropertiesService, type PartyProperty } from '../properties/properties.service.js';

const CACHE_SECONDS = 30;
const PAGE_SIZE = 50;

export type PortalSpace = 'owner' | 'tenant';

const SPACE_FEATURE: Record<PortalSpace, FeatureKey> = { owner: 'portals.owner_space', tenant: 'portals.tenant_space' };
const SPACE_RECORD: Record<PortalSpace, PersonLinkRecordType> = { owner: 'owner', tenant: 'tenant' };

export interface PortalOrganization {
	organizationId: string;
	organizationName: string;
	organizationType: 'agency' | 'landlord';
	organizationPhone: string;
}

export interface OwnerAssetsView {
	organizations: (PortalOrganization & {
		managedBy: 'agency' | 'self';
		properties: (Omit<PartyProperty, 'units'> & { units: (PartyProperty['units'][number] & { lease: PartyCurrentLease | null })[] })[];
	})[];
}

export type HistoryItem = PortalOrganization & { kind: 'lease' | 'rent_due' | 'receipt' | 'deposit'; id: string; date: string } & Record<
		string,
		unknown
	>;

export interface TenantHistoryView {
	items: HistoryItem[];
	nextCursor: string | null;
}

@Injectable()
export class PortalsService implements OnModuleInit {
	constructor(
		private readonly database: DatabaseService,
		private readonly audit: AuditService,
		private readonly features: FeaturesService,
		private readonly redis: RedisService,
		private readonly organizations: OrganizationsService,
		private readonly links: PersonLinksService,
		private readonly properties: PropertiesService,
		private readonly leases: LeasesService,
		private readonly payments: PaymentsService,
		private readonly statements: StatementsService,
		private readonly documents: DocumentsService,
		private readonly exit: ExitService,
		private readonly owners: OwnersService
	) {}

	onModuleInit(): void {
		// Un lien qui change (révocation, activation) : les réponses en cache de la personne sont effacées aussitôt.
		this.links.onLinkChanged((userId) => this.forget(userId));
	}

	// ---------------------------------------------------------------- liens et cache

	/** La seule lecture hors organisation : identifiants des liens actifs de la personne connectée. */
	private async activeLinks(userId: string): Promise<ActivePersonLink[]> {
		const r = await this.database.withUser(userId, (tx) =>
			tx.execute<{
				link_id: string;
				organization_id: string;
				record_type: PersonLinkRecordType;
				owner_id: string | null;
				tenant_id: string | null;
			}>(sql`select link_id, organization_id, record_type, owner_id, tenant_id from my_person_links()`)
		);
		return r.rows.map((l) => ({
			linkId: l.link_id,
			organizationId: l.organization_id,
			recordType: l.record_type,
			recordId: (l.owner_id ?? l.tenant_id)!
		}));
	}

	private async client() {
		const c = this.redis.client;
		if (c.status === 'wait' || c.status === 'end') await c.connect();
		return c;
	}

	private cacheKey(userId: string, route: string, links: readonly ActivePersonLink[]): string {
		const fingerprint = createHash('sha256').update(linkSetFingerprint(links)).digest('hex').slice(0, 32);
		return `ziga:portal:${userId}:${route}:${fingerprint}`;
	}

	private async cached<T>(key: string, read: () => Promise<T>): Promise<T> {
		try {
			const hit = await (await this.client()).get(key);
			if (hit) return JSON.parse(hit) as T;
		} catch {
			// Redis indisponible : la base reste la source, sans cache.
			return read();
		}
		const value = await read();
		try {
			await (await this.client()).set(key, JSON.stringify(value), 'EX', CACHE_SECONDS);
		} catch {
			// Sans cache : la réponse est juste.
		}
		return value;
	}

	/** Efface les réponses en cache d'une personne (un de ses liens a changé). */
	async forget(userId: string): Promise<void> {
		try {
			const c = await this.client();
			let cursor = '0';
			do {
				const [next, keys] = await c.scan(cursor, 'MATCH', `ziga:portal:${userId}:*`, 'COUNT', 100);
				if (keys.length) await c.del(...keys);
				cursor = next;
			} while (cursor !== '0');
		} catch {
			// La clé contient l'empreinte des liens : une révocation ne retrouve jamais l'ancienne réponse.
		}
	}

	// ---------------------------------------------------------------- lecture organisation par organisation

	private async assertSpace(space: PortalSpace, userId: string): Promise<void> {
		await this.features.assertEnabled(SPACE_FEATURE[space], userId, null);
	}

	/**
	 * Lit chaque organisation des liens de la personne pour cet espace, l'une après l'autre, dans sa propre transaction :
	 * ligne d'audit `portal.read`, puis `read` avec la fiche liée. Une organisation qui a coupé l'espace n'est pas lue.
	 */
	private async eachOrganization<T>(
		userId: string,
		space: PortalSpace,
		route: string,
		links: readonly ActivePersonLink[],
		read: (tx: Tx, org: PortalOrganization, recordIds: string[]) => Promise<T>
	): Promise<T[]> {
		const byOrg = new Map<string, ActivePersonLink[]>();
		for (const l of links.filter((x) => x.recordType === SPACE_RECORD[space]))
			byOrg.set(l.organizationId, [...(byOrg.get(l.organizationId) ?? []), l]);
		const out: T[] = [];
		for (const [organizationId, orgLinks] of byOrg) {
			const result = await this.database.withOrganization(organizationId, (tx) =>
				RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, async () => {
					const o = await this.organizations.partyOrganization(tx, organizationId);
					if (!o) return null;
					const orgContext = await this.features.organizationContext(organizationId, o.planId, tx);
					if (!(await this.features.resolve(SPACE_FEATURE[space], userId, orgContext)).enabled) return null;
					await this.audit.record(tx, {
						actor: { type: 'user', userId },
						organizationId,
						subjectUserId: userId,
						action: 'portal.read',
						objectType: 'person_link',
						objectId: orgLinks[0]!.linkId,
						after: { space, route, links: orgLinks.map((l) => l.linkId) },
						origin: 'portal'
					});
					return read(
						tx,
						{ organizationId, organizationName: o.name, organizationType: o.type, organizationPhone: o.phone },
						orgLinks.map((l) => l.recordId)
					);
				})
			);
			if (result !== null) out.push(result);
		}
		return out;
	}

	/** Espaces ouverts à la personne (choix de l'espace) : un lien actif du bon type et l'interrupteur ouvert. */
	async spaces(userId: string): Promise<Record<PortalSpace, boolean>> {
		const links = await this.activeLinks(userId);
		const out = { owner: false, tenant: false };
		for (const space of ['owner', 'tenant'] as const) {
			out[space] =
				links.some((l) => l.recordType === SPACE_RECORD[space]) &&
				(await this.features.resolve(SPACE_FEATURE[space], userId, null)).enabled;
		}
		return out;
	}

	// ---------------------------------------------------------------- espace du propriétaire

	/** Patrimoine : tous ses biens, groupés par gestionnaire ; disponibilité, loyer, bail en cours (nom du locataire seul). */
	async ownerAssets(userId: string): Promise<OwnerAssetsView> {
		await this.assertSpace('owner', userId);
		const links = await this.activeLinks(userId);
		return this.cached(this.cacheKey(userId, 'owner-assets', links), async () => ({
			organizations: await this.eachOrganization(userId, 'owner', 'owner/assets', links, async (tx, org, ownerIds) => {
				const properties = (await Promise.all(ownerIds.map((id) => this.properties.partyOwnerAssets(tx, org.organizationId, id)))).flat();
				const current = await this.leases.partyCurrentLeases(
					tx,
					org.organizationId,
					properties.flatMap((p) => p.units.map((u) => u.id))
				);
				return {
					...org,
					managedBy: org.organizationType === 'landlord' ? ('self' as const) : ('agency' as const),
					properties: properties.map((p) => ({ ...p, units: p.units.map((u) => ({ ...u, lease: current.get(u.id) ?? null })) }))
				};
			})
		}));
	}

	/** Biens, unités et baux du propriétaire dans l'organisation de la transaction (périmètre de ses documents). */
	private async ownerScope(tx: Tx, organizationId: string, ownerIds: string[]) {
		const properties = (await Promise.all(ownerIds.map((id) => this.properties.partyOwnerAssets(tx, organizationId, id)))).flat();
		const unitIds = properties.flatMap((p) => p.units.map((u) => u.id));
		return {
			properties,
			unitProperty: new Map(properties.flatMap((p) => p.units.map((u) => [u.id, p.id] as const))),
			scope: {
				ownerIds,
				propertyIds: properties.map((p) => p.id),
				unitIds,
				leaseIds: await this.leases.partyLeaseIdsOfUnits(tx, organizationId, unitIds)
			}
		};
	}

	/** Relevés émis de chaque organisation, avec reversé et reste. */
	async ownerStatements(userId: string) {
		await this.assertSpace('owner', userId);
		const links = await this.activeLinks(userId);
		return this.cached(this.cacheKey(userId, 'owner-statements', links), async () =>
			(
				await this.eachOrganization(userId, 'owner', 'owner/statements', links, async (tx, org, ownerIds) =>
					(await Promise.all(ownerIds.map((id) => this.statements.partyStatements(tx, org.organizationId, id))))
						.flat()
						.map(({ unitTotals: _u, expenseLines: _e, ...st }) => ({ ...org, ...st }))
				)
			)
				.flat()
				.sort((a, b) => (a.month === b.month ? (a.id < b.id ? 1 : -1) : a.month < b.month ? 1 : -1))
		);
	}

	/** Revenus par mois et par bien (12 derniers mois), rendement net ÷ encaissé (packages/shared/portals). */
	async ownerIncome(userId: string): Promise<{ months: IncomeMonth[]; properties: IncomeProperty[] }> {
		await this.assertSpace('owner', userId);
		const links = await this.activeLinks(userId);
		return this.cached(this.cacheKey(userId, 'owner-income', links), async () => {
			const perOrg = await this.eachOrganization(userId, 'owner', 'owner/income', links, async (tx, org, ownerIds) => {
				const { unitProperty } = await this.ownerScope(tx, org.organizationId, ownerIds);
				const statements = (await Promise.all(ownerIds.map((id) => this.statements.partyStatements(tx, org.organizationId, id)))).flat();
				return { org, unitProperty, statements };
			});
			const unitProperty = new Map(perOrg.flatMap((o) => [...o.unitProperty]));
			return ownerIncome(
				perOrg.flatMap((o) => o.statements.map((s) => ({ ...s, organizationId: o.org.organizationId }))),
				unitProperty,
				toIsoDate().slice(0, 7)
			);
		});
	}

	/** Documents de ses biens et de leurs baux que la matrice ouvre au propriétaire (D22). */
	async ownerDocuments(userId: string): Promise<(PortalOrganization & PartyDocument)[]> {
		await this.assertSpace('owner', userId);
		const links = await this.activeLinks(userId);
		return this.cached(this.cacheKey(userId, 'owner-documents', links), async () =>
			(
				await this.eachOrganization(userId, 'owner', 'owner/documents', links, async (tx, org, ownerIds) => {
					const { scope } = await this.ownerScope(tx, org.organizationId, ownerIds);
					return (await this.documents.partyDocuments(tx, org.organizationId, 'owner', scope)).map((d) => ({ ...org, ...d }));
				})
			).flat()
		);
	}

	/** PDF d'un relevé émis (URL signée), journalisé dans l'organisation. */
	async ownerStatementPdf(userId: string, organizationId: string, statementId: string) {
		await this.assertSpace('owner', userId);
		const ownerIds = (await this.activeLinks(userId))
			.filter((l) => l.recordType === 'owner' && l.organizationId === organizationId)
			.map((l) => l.recordId);
		if (!ownerIds.length) throw new AppError('STATEMENT_NOT_FOUND', 'Relevé introuvable.', 404);
		return this.database.withOrganization(organizationId, (tx) =>
			RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, () =>
				this.statements.partyStatementPdfUrl(tx, organizationId, ownerIds, statementId, userId)
			)
		);
	}

	/** Téléchargement d'un document permis par la matrice, pour l'espace donné (URL signée, journalisée). */
	async downloadDocument(userId: string, space: PortalSpace, organizationId: string, documentId: string) {
		await this.assertSpace(space, userId);
		const recordIds = (await this.activeLinks(userId))
			.filter((l) => l.recordType === SPACE_RECORD[space] && l.organizationId === organizationId)
			.map((l) => l.recordId);
		if (!recordIds.length) throw new AppError('DOCUMENT_NOT_FOUND', 'Document introuvable.', 404);
		return this.database.withOrganization(organizationId, (tx) =>
			RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, async () => {
				if (space === 'owner') {
					const { scope } = await this.ownerScope(tx, organizationId, recordIds);
					return this.documents.partyDownload(tx, organizationId, documentId, 'owner', scope, userId);
				}
				return this.documents.partyDownload(
					tx,
					organizationId,
					documentId,
					'tenant',
					await this.tenantDocumentScope(tx, organizationId, recordIds),
					userId
				);
			})
		);
	}

	// ---------------------------------------------------------------- espace du locataire

	private async tenantTimeline(userId: string, links: readonly ActivePersonLink[]): Promise<HistoryItem[]> {
		const perOrg = await this.eachOrganization(userId, 'tenant', 'tenant/history', links, async (tx, org, tenantIds) => {
			const leases = (await Promise.all(tenantIds.map((id) => this.leases.partyTenantLeases(tx, org.organizationId, id)))).flat();
			const labels = await this.properties.partyUnitLabels(
				tx,
				org.organizationId,
				leases.map((l) => l.unitId)
			);
			const receipts = await this.payments.partyReceipts(
				tx,
				org.organizationId,
				leases.map((l) => l.id)
			);
			const items: HistoryItem[] = [];
			for (const l of leases) {
				const place = labels.get(l.unitId);
				items.push({
					...org,
					kind: 'lease',
					id: l.id,
					date: l.startsOn,
					status: l.status,
					startsOn: l.startsOn,
					endsOn: l.endsOn,
					exitOn: l.exitOn,
					rent: l.rent,
					charges: l.charges,
					unitLabel: place?.unitLabel ?? null,
					propertyName: place?.propertyName ?? null
				});
				for (const d of l.dues) items.push({ ...org, ...d, kind: 'rent_due', date: d.dueOn, leaseId: l.id });
				if (l.deposit) items.push({ ...org, ...l.deposit, kind: 'deposit', date: l.startsOn, leaseId: l.id });
			}
			for (const r of receipts) items.push({ ...org, kind: 'receipt', date: r.issuedOn ?? r.paidOn, ...r });
			return items;
		});
		// Chronologie unique, la plus récente d'abord ; ordre stable (date, puis identifiant).
		return perOrg.flat().sort((x, y) => (x.date === y.date ? (x.id < y.id ? 1 : -1) : x.date < y.date ? 1 : -1));
	}

	/** Historique, toutes agences confondues, par pages (curseur : date et identifiant du dernier élément). */
	async tenantHistory(userId: string, cursor: string | null): Promise<TenantHistoryView> {
		await this.assertSpace('tenant', userId);
		const links = await this.activeLinks(userId);
		const all = await this.cached(this.cacheKey(userId, 'tenant-history', links), () => this.tenantTimeline(userId, links));
		let start = 0;
		if (cursor) {
			const [date, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
			start = all.findIndex((i) => i.date < date! || (i.date === date && i.id < id!));
			if (start < 0) start = all.length;
		}
		const items = all.slice(start, start + PAGE_SIZE);
		const last = items.at(-1);
		return {
			items,
			nextCursor: last && start + PAGE_SIZE < all.length ? Buffer.from(`${last.date}|${last.id}`).toString('base64url') : null
		};
	}

	/** Critère d'acceptation : le reçu d'un loyer, payé à une organisation où la personne est (ou a été) locataire liée. */
	async tenantReceiptPdf(userId: string, organizationId: string, receiptId: string) {
		await this.assertSpace('tenant', userId);
		const links = (await this.activeLinks(userId)).filter((l) => l.recordType === 'tenant' && l.organizationId === organizationId);
		if (!links.length) throw new AppError('RECEIPT_NOT_FOUND', 'Reçu introuvable.', 404);
		return this.database.withOrganization(organizationId, (tx) =>
			RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, async () => {
				const leases = (await Promise.all(links.map((l) => this.leases.partyTenantLeases(tx, organizationId, l.recordId)))).flat();
				return this.payments.partyReceiptPdfUrl(
					tx,
					organizationId,
					receiptId,
					leases.map((l) => l.id),
					userId
				);
			})
		);
	}

	// ---------------------------------------------------------------- espace du locataire : logement, contrats, caution (2b-3)

	private async tenantLeasesIn(tx: Tx, organizationId: string, tenantIds: readonly string[]): Promise<PartyTenantLease[]> {
		return (await Promise.all(tenantIds.map((id) => this.leases.partyTenantLeases(tx, organizationId, id)))).flat();
	}

	/** Périmètre des documents du locataire : sa fiche, ses baux ; un projet de contrat se lit à partir de « prêt à signer ». */
	private async tenantDocumentScope(tx: Tx, organizationId: string, tenantIds: readonly string[]) {
		const leaseIds = (await this.tenantLeasesIn(tx, organizationId, tenantIds)).map((l) => l.id);
		const contracts = new Map(
			[...(await this.leases.partyContracts(tx, organizationId, leaseIds)).values()].flat().map((c) => [c.id, c.status])
		);
		return {
			tenantIds,
			leaseIds,
			contractStatus: (d: { leaseContractId: string | null }) =>
				d.leaseContractId ? ((contracts.get(d.leaseContractId) as ContractStatus | undefined) ?? null) : null
		};
	}

	/** Logement actuel : solde, prochaine échéance, contact de l'organisation ; paiement direct selon son interrupteur. */
	async tenantHome(userId: string) {
		await this.assertSpace('tenant', userId);
		const links = await this.activeLinks(userId);
		return this.cached(this.cacheKey(userId, 'tenant-home', links), async () => ({
			homes: (
				await this.eachOrganization(userId, 'tenant', 'tenant/home', links, async (tx, org, tenantIds) => {
					const current = (await this.tenantLeasesIn(tx, org.organizationId, tenantIds)).filter(
						(l) => l.status === 'active' || l.status === 'notice'
					);
					if (!current.length) return [];
					const labels = await this.properties.partyUnitLabels(
						tx,
						org.organizationId,
						current.map((l) => l.unitId)
					);
					const o = await this.organizations.partyOrganization(tx, org.organizationId);
					const direct = (
						await this.features.resolve(
							'payments.direct',
							userId,
							await this.features.organizationContext(org.organizationId, o!.planId, tx)
						)
					).enabled;
					return current.map((l) => {
						const open = l.dues
							.filter((d) => d.amountDue > d.amountPaid && d.status !== 'waived')
							.sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
						return {
							...org,
							leaseId: l.id,
							status: l.status,
							unitLabel: labels.get(l.unitId)?.unitLabel ?? null,
							propertyName: labels.get(l.unitId)?.propertyName ?? null,
							rent: l.rent,
							charges: l.charges,
							balance: open.reduce((sum, d) => sum + (d.amountDue - d.amountPaid), 0),
							nextDue: open[0] ? { id: open[0].id, dueOn: open[0].dueOn, remaining: open[0].amountDue - open[0].amountPaid } : null,
							directPayment: { enabled: direct, reason: direct ? null : DIRECT_PAYMENT_DISABLED_REASON }
						};
					});
				})
			).flat()
		}));
	}

	/** Contrats : en vigueur, à signer, terminés ; organisation, bailleur désigné, dates, loyer, caution, statuts. */
	async tenantContracts(userId: string) {
		await this.assertSpace('tenant', userId);
		const links = await this.activeLinks(userId);
		return this.cached(this.cacheKey(userId, 'tenant-contracts', links), async () =>
			(
				await this.eachOrganization(userId, 'tenant', 'tenant/contracts', links, async (tx, org, tenantIds) => {
					const leases = await this.tenantLeasesIn(tx, org.organizationId, tenantIds);
					const labels = await this.properties.partyUnitLabels(
						tx,
						org.organizationId,
						leases.map((l) => l.unitId)
					);
					const owners = await this.owners.partyOwnerNames(
						tx,
						[...labels.values()].map((v) => v.ownerId)
					);
					const contracts = await this.leases.partyContracts(
						tx,
						org.organizationId,
						leases.map((l) => l.id)
					);
					return leases.map((l) => {
						const place = labels.get(l.unitId);
						const docs = contracts.get(l.id) ?? [];
						const base = docs.find((d) => d.kind === 'contract') ?? null;
						const group = l.status === 'ended' ? 'ended' : base?.status === 'ready_to_sign' ? 'to_sign' : 'in_force';
						const next = l.dues
							.filter((d) => d.amountDue > d.amountPaid && d.status !== 'waived')
							.sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1))[0];
						return {
							...org,
							leaseId: l.id,
							group,
							leaseStatus: l.status,
							contractStatus: base?.status ?? null,
							signed: !!base?.signedDocumentId,
							amendments: docs.filter((d) => d.kind === 'amendment').map((d) => ({ id: d.id, status: d.status })),
							unitLabel: place?.unitLabel ?? null,
							propertyName: place?.propertyName ?? null,
							lessorType: l.lessorType,
							lessorName:
								l.lessorType === 'organization' ? org.organizationName : ((place && owners.get(place.ownerId)) ?? org.organizationName),
							startsOn: l.startsOn,
							endsOn: l.endsOn,
							exitOn: l.exitOn,
							rent: l.rent,
							charges: l.charges,
							deposit: l.deposit
								? { agreedAmount: l.deposit.agreedAmount, holder: l.deposit.holder, holderName: l.deposit.holderName }
								: null,
							nextDueOn: next?.dueOn ?? null
						};
					});
				})
			).flat()
		);
	}

	/** Caution et décompte de chaque bail : montant convenu, détenteur, décompte et ses lignes. */
	async tenantDeposits(userId: string) {
		await this.assertSpace('tenant', userId);
		const links = await this.activeLinks(userId);
		return this.cached(this.cacheKey(userId, 'tenant-deposits', links), async () =>
			(
				await this.eachOrganization(userId, 'tenant', 'tenant/deposits', links, async (tx, org, tenantIds) => {
					const leases = (await this.tenantLeasesIn(tx, org.organizationId, tenantIds)).filter((l) => l.deposit);
					const settlements = await this.exit.partySettlements(
						tx,
						org.organizationId,
						leases.map((l) => l.id)
					);
					return leases.map((l) => ({ ...org, leaseId: l.id, ...l.deposit!, settlement: settlements.get(l.id) ?? null }));
				})
			).flat()
		);
	}

	/** Documents permis par la matrice : son contrat signé, ses avenants, sa pièce d'identité, ses états des lieux. */
	async tenantDocuments(userId: string) {
		await this.assertSpace('tenant', userId);
		const links = await this.activeLinks(userId);
		return this.cached(this.cacheKey(userId, 'tenant-documents', links), async () =>
			(
				await this.eachOrganization(userId, 'tenant', 'tenant/documents', links, async (tx, org, tenantIds) => {
					const scope = await this.tenantDocumentScope(tx, org.organizationId, tenantIds);
					return (await this.documents.partyDocuments(tx, org.organizationId, 'tenant', scope)).map((d) => ({
						...org,
						...d
					}));
				})
			).flat()
		);
	}

	/** Signalements suivis (reçu, planifié, fait). */
	async tenantRequests(userId: string) {
		await this.assertSpace('tenant', userId);
		const links = await this.activeLinks(userId);
		return (
			await this.eachOrganization(userId, 'tenant', 'tenant/requests', links, async (tx, org, tenantIds) => {
				const leases = await this.tenantLeasesIn(tx, org.organizationId, tenantIds);
				return (
					await this.leases.partyMaintenanceRequests(
						tx,
						org.organizationId,
						leases.map((l) => l.id)
					)
				).map((r) => ({
					...org,
					...r,
					createdAt: r.createdAt.toISOString(),
					doneAt: r.doneAt?.toISOString() ?? null
				}));
			})
		).flat();
	}

	/** Une écriture de la personne dans l'organisation d'un de ses baux (demande à traiter), puis ses réponses en cache effacées. */
	private async tenantWrite<T>(userId: string, organizationId: string, fn: (tx: Tx, tenantIds: string[]) => Promise<T>): Promise<T> {
		await this.assertSpace('tenant', userId);
		const tenantIds = (await this.activeLinks(userId))
			.filter((l) => l.recordType === 'tenant' && l.organizationId === organizationId)
			.map((l) => l.recordId);
		if (!tenantIds.length) throw new AppError('LEASE_NOT_FOUND', 'Bail introuvable.', 404);
		const result = await this.database.withOrganization(organizationId, (tx) =>
			RequestContext.run({ ...RequestContext.get(), origin: 'portal', userId }, async () => {
				const o = await this.organizations.partyOrganization(tx, organizationId);
				if (
					!o ||
					!(
						await this.features.resolve(
							'portals.tenant_space',
							userId,
							await this.features.organizationContext(organizationId, o.planId, tx)
						)
					).enabled
				) {
					throw new AppError('FEATURE_DISABLED', 'Cet espace n’est pas ouvert par cette organisation.', 403);
				}
				return fn(tx, tenantIds);
			})
		);
		await this.forget(userId);
		return result;
	}

	createMaintenanceRequest(
		userId: string,
		input: { organizationId: string; id: string; leaseId: string; title: string; description: string }
	) {
		return this.tenantWrite(userId, input.organizationId, async (tx, tenantIds) => {
			const leases = await this.tenantLeasesIn(tx, input.organizationId, tenantIds);
			return this.leases.partyCreateMaintenanceRequest(
				tx,
				input.organizationId,
				leases.map((l) => l.id),
				userId,
				input
			);
		});
	}

	requestNotice(userId: string, input: { organizationId: string; leaseId: string; plannedExitOn: string; reason: string }) {
		return this.tenantWrite(userId, input.organizationId, async (tx, tenantIds) => {
			const leases = await this.tenantLeasesIn(tx, input.organizationId, tenantIds);
			return this.exit.partyNoticeRequest(
				tx,
				input.organizationId,
				leases.map((l) => l.id),
				userId,
				input
			);
		});
	}

	settlementObservation(userId: string, organizationId: string, settlementId: string, observations: string) {
		return this.tenantWrite(userId, organizationId, async (tx, tenantIds) => {
			const leases = await this.tenantLeasesIn(tx, organizationId, tenantIds);
			return this.exit.partySettlementObservation(
				tx,
				organizationId,
				leases.map((l) => l.id),
				settlementId,
				userId,
				observations
			);
		});
	}
}
