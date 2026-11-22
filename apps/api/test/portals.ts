/**
 * Lot 10 ter : monde des tests des espaces personnels (module `portals`), écrit en SQL dans le contexte de chaque
 * organisation (propriétaire du schéma, sous la RLS) ; les personnes et les organisations sont créées par l'API.
 *
 * - Deux agences A et B, et l'organisation de bailleur L, dont la personne P est la directrice.
 * - P est propriétaire : fiche dans A (bien A1), dans B (bien B1) et dans L (sa propre fiche, gestion directe, bien L1).
 *   A et B ont aussi chacune un autre propriétaire, qui n'a rien à voir avec P.
 * - T est locataire : bail terminé dans A (unité de A1), puis bail en cours dans B (unité de B1) ; un loyer encaissé et
 *   son reçu dans chacune ; le contrat signé (scan) et sa pièce d'identité dans B.
 * - Les fiches de P et de T sont liées à leur compte (`person_links`, actifs : numéro vérifié et lien accepté), sauf
 *   indication contraire.
 */
import { newId } from '@ziga/shared/ids';
import pg from 'pg';
import { giveNotice, endLease, insertDocument } from './exit.js';
import { Client, signedUp, type TestApp } from './http.js';
import { insertDepositAccount, insertLease } from './leases.js';
import { createOrg, type Org } from './orgs.js';
import { confirmedCreditPayment, insertReceipt, receiveDeposit, validateReceipt } from './payments.js';
import { propertyWithUnit } from './properties.js';

export interface Person {
	client: Client;
	phone: string;
	userId: string;
}

/** Ce que contient une organisation du monde (identifiants). */
export interface OrgWorld {
	org: Org;
	/** Fiche propriétaire de P. */
	pOwner: string;
	pProperty: string;
	pUnit: string;
	/** Autre propriétaire de l'organisation (aucun lien avec P). */
	otherOwner?: string;
	otherProperty?: string;
	/** Fiche locataire de T (A et B). */
	tTenant?: string;
	tLease?: string;
	tPayment?: string;
	tReceipt?: string;
	/** Compte de caution de T (A seulement : 100 000 reçus pendant le bail). */
	tDepositAccount?: string;
	/** Contrat signé (scan) et pièce d'identité de T (B seulement). */
	tSignedLease?: string;
	tIdentity?: string;
	/** Liens actifs de P et de T. */
	pLink?: string;
	tLink?: string;
}

export interface PortalWorld {
	p: Person;
	t: Person;
	a: OrgWorld;
	b: OrgWorld;
	l: OrgWorld;
}

export async function migrationClient(): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
	await c.connect();
	return c;
}

/** Écrit et valide dans le contexte d'une organisation (propriétaire du schéma, sous la RLS : FORCE). */
export async function seedIn<T>(owner: pg.Client, organizationId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
	await owner.query('BEGIN');
	try {
		await owner.query(`select set_config('app.organization_id', $1, true)`, [organizationId]);
		const r = await fn(owner);
		await owner.query('COMMIT');
		return r;
	} catch (error) {
		await owner.query('ROLLBACK');
		throw error;
	}
}

export async function userIdOf(client: Client): Promise<string> {
	return ((await client.call('GET', '/me')).body as { id: string }).id;
}

export async function insertOwnerRecord(c: pg.Client, organizationId: string, name: string, phone: string): Promise<string> {
	const id = newId();
	await c.query(`insert into owners (id, organization_id, type, name, phone) values ($1, $2, 'person', $3, $4)`, [
		id,
		organizationId,
		name,
		phone
	]);
	return id;
}

export async function insertMandate(c: pg.Client, organizationId: string, ownerId: string): Promise<string> {
	const id = newId();
	await c.query(
		`insert into mandates (id, organization_id, owner_id, type, starts_on, commission_basis, commission_rate_bp)
		 values ($1, $2, $3, 'rental_management', '2026-01-01', 'percent_of_collected', 800)`,
		[id, organizationId, ownerId]
	);
	return id;
}

export async function insertTenantRecord(c: pg.Client, organizationId: string, name: string, phone: string | null): Promise<string> {
	const id = newId();
	await c.query(
		`insert into tenants (id, organization_id, full_name, phone, id_type, id_number, birth_date)
		 values ($1, $2, $3, $4, 'cnib', 'B1234567', '1990-04-12')`,
		[id, organizationId, name, phone]
	);
	return id;
}

/**
 * Lien d'une fiche à une personne, tel que la liaison l'écrit : demandé (numéro de la fiche), puis numéro vérifié et
 * lien accepté par un membre, s'il est actif.
 */
export async function insertLink(
	c: pg.Client,
	organizationId: string,
	l: {
		userId: string;
		phone: string;
		ownerId?: string;
		tenantId?: string;
		acceptedBy: string;
		status?: 'requested' | 'active';
		origin?: 'organization_invite' | 'person_request';
	}
): Promise<string> {
	const id = newId();
	await c.query(
		`insert into person_links (id, organization_id, user_id, record_type, owner_id, tenant_id, status, origin, phone, requested_by)
		 values ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9)`,
		[
			id,
			organizationId,
			l.userId,
			l.ownerId ? 'owner' : 'tenant',
			l.ownerId ?? null,
			l.tenantId ?? null,
			l.origin ?? 'organization_invite',
			l.phone,
			l.origin === 'person_request' ? l.userId : l.acceptedBy
		]
	);
	if ((l.status ?? 'active') === 'active') {
		await c.query(
			`update person_links set phone_verified_at = now(), accepted_by = $2, accepted_at = now(), status = 'active' where id = $1`,
			[id, l.acceptedBy]
		);
	}
	return id;
}

/** Le monde complet (voir l'en-tête). Les liens actifs sont posés si `links` (par défaut). */
export async function portalWorld(t: TestApp, owner: pg.Client, options: { links?: boolean } = {}): Promise<PortalWorld> {
	const links = options.links ?? true;
	const orgA = await createOrg(t, 'agency', 'Agence Wend-Panga');
	const orgB = await createOrg(t, 'agency', 'Agence Nong-Taaba');
	const orgL = await createOrg(t, 'landlord', 'Rasmané Compaoré');
	const p: Person = { client: orgL.director.client, phone: orgL.director.phone, userId: orgL.director.userId };
	const tAccount = await signedUp(t);
	const tp: Person = { client: tAccount.client, phone: tAccount.phone, userId: await userIdOf(tAccount.client) };

	const agency = async (org: Org, tenantLeaseEnded: boolean): Promise<OrgWorld> =>
		seedIn(owner, org.id, async (c) => {
			await c.query(`update organizations set receipt_prefix = $2 where id = $1`, [org.id, org.id === orgA.id ? 'AGA' : 'AGB']);
			const pOwner = await insertOwnerRecord(c, org.id, 'Rasmané Compaoré', p.phone);
			await insertMandate(c, org.id, pOwner);
			const pPlace = await propertyWithUnit(c, org.id, pOwner);
			const otherOwner = await insertOwnerRecord(c, org.id, 'Mariam Zongo', '+22670998877');
			await insertMandate(c, org.id, otherOwner);
			const other = await propertyWithUnit(c, org.id, otherOwner);
			const tTenant = await insertTenantRecord(c, org.id, 'Salif Traoré', tp.phone);
			const tLease = await insertLease(
				c,
				org.id,
				pPlace.unit,
				tTenant,
				tenantLeaseEnded ? { startsOn: '2025-01-01' } : { startsOn: '2026-06-01' }
			);
			const tPayment = await confirmedCreditPayment(c, org.id, tLease, org.director.userId);
			const tReceipt = await insertReceipt(c, org.id, tPayment);
			await validateReceipt(c, org.id, tReceipt);
			let tDepositAccount: string | undefined;
			if (tenantLeaseEnded) {
				// Caution de 100 000 reçue pendant le bail (avant sa fin : la base n'ouvre plus de compte sur un bail terminé).
				tDepositAccount = await insertDepositAccount(c, org.id, tLease, { agreed: 100_000 });
				await receiveDeposit(c, org.id, tDepositAccount, 100_000);
				await giveNotice(c, org.id, tLease, org.director.userId, { notifiedOn: '2026-01-15', exitOn: '2026-04-30' });
				await endLease(c, tLease);
			}
			const w: OrgWorld = {
				org,
				pOwner,
				pProperty: pPlace.property,
				pUnit: pPlace.unit,
				otherOwner,
				otherProperty: other.property,
				tTenant,
				tLease,
				tPayment,
				tReceipt,
				tDepositAccount
			};
			if (!tenantLeaseEnded) {
				w.tSignedLease = await insertDocument(c, org.id, org.director.userId, { type: 'signed_lease_scan', leaseId: tLease });
				const identity = newId();
				await c.query(
					`insert into documents (id, organization_id, type, tenant_id, file_name, mime_type, byte_size, storage_key, status, uploaded_by)
					 values ($1, $2, 'tenant_identity', $3, 'cnib.pdf', 'application/pdf', 1000, $4, 'pending', $5)`,
					[identity, org.id, tTenant, `documents/${org.id}/${identity}`, org.director.userId]
				);
				await c.query(`update documents set status = 'active', sha256 = $2, activated_at = now() where id = $1`, [
					identity,
					'b'.repeat(64)
				]);
				w.tIdentity = identity;
			}
			if (links) {
				w.pLink = await insertLink(c, org.id, { userId: p.userId, phone: p.phone, ownerId: pOwner, acceptedBy: org.director.userId });
				w.tLink = await insertLink(c, org.id, { userId: tp.userId, phone: tp.phone, tenantId: tTenant, acceptedBy: org.director.userId });
			}
			return w;
		});

	const a = await agency(orgA, true);
	const b = await agency(orgB, false);
	const l = await seedIn(owner, orgL.id, async (c) => {
		// Sa propre fiche (créée avec l'organisation, au numéro de l'organisation) : le bailleur la met à son numéro.
		const self = await c.query(
			`select o.id from owners o join mandates m on m.organization_id = o.organization_id and m.owner_id = o.id and m.type = 'self_managed'
			 where o.organization_id = $1`,
			[orgL.id]
		);
		const pOwner = self.rows[0].id as string;
		await c.query(`update owners set phone = $2 where id = $1`, [pOwner, p.phone]);
		const place = await propertyWithUnit(c, orgL.id, pOwner);
		const w: OrgWorld = { org: orgL, pOwner, pProperty: place.property, pUnit: place.unit };
		if (links) w.pLink = await insertLink(c, orgL.id, { userId: p.userId, phone: p.phone, ownerId: pOwner, acceptedBy: p.userId });
		return w;
	});
	return { p, t: tp, a, b, l };
}
