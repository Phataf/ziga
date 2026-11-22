/**
 * Démonstration, suite (lot 10 ter, étape 3e ; CLAUDE.md §10) : fiches, mandats, biens, unités, baux, échéances,
 * encaissements, reçus, un relevé émis avec son reversement, un bail terminé avec son décompte proposé, et les liens
 * des deux comptes personnels, pour que le choix de l'espace et les deux espaces aient du contenu.
 *
 * Tout passe par l'API elle-même, démarrée dans ce processus sur un port local : gardes, schémas, RLS
 * (withOrganization), déclencheurs, audit (origine app), comme une vraie saisie. Deux exceptions, en mémoire, par les
 * mêmes services que l'application : la tâche du jour des baux (fin du bail terminé), et le crochet de création d'un
 * bailleur particulier (sa fiche et son mandat self_managed), si son organisation a été créée par la première partie
 * du seed. Les codes SMS sont lus dans l'expéditeur en mémoire de ce processus.
 *
 * Rejouable : chaque objet a un identifiant fixe, et chaque étape regarde d'abord ce qui existe (rien n'est recréé).
 *
 * - Propriétaire : Mariam Zongo (gestionnaire de A et bailleur particulier), un bien dans A, un dans B, un chez elle.
 * - Locataire : Moussa Nikiéma, bail terminé dans A (décompte proposé), bail en cours dans B.
 */
import { addDays, addMonths, monthDay, toIsoDate } from '@ziga/shared/dates';
import { newReceiptToken, provisionalReceiptNumber } from '@ziga/shared/payments';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.factory.js';
import { RequestContext } from '../common/request-context.js';
import type { AppConfig } from '../config/env.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { ExitHooks } from '../modules/leases/exit-hooks.js';
import { runLeasesDaily } from '../modules/leases/leases-daily.js';
import { RentDueEvents } from '../modules/leases/rent-due-events.js';
import { SMS_SENDER, type MemorySmsSender } from '../modules/notifications/sms-sender.js';
import { OrganizationCreationHooks } from '../modules/organizations/organization-hooks.js';
import { DatabaseService } from './database.module.js';
import { DEMO_ORGANIZATIONS, DEMO_PEOPLE } from './seed.js';
import { organizations } from './schema/organizations.js';

const [ORG_A, ORG_B, ORG_L] = DEMO_ORGANIZATIONS.map((o) => o.id) as [string, string, string];
const phoneOf = (key: string) => DEMO_PEOPLE.find((p) => p.key === key)!.phone;
export const DEMO_OWNER = 'a.manager';
export const DEMO_TENANT = 'person';

/** Quartiers de la migration 0009 (identifiants fixes). */
const TAMPOUY = '01a1c6fa-54af-7223-a25d-9ca0f6ab7fb3';
const OUAGA_2000 = '01a1c6fa-54af-7223-a25d-7737242c4eb6';
const BADNOGO = '01a1c6fa-54af-7223-a25d-bd3d979119d6';

/** Identifiants fixes des objets de démonstration (rejouable). */
export const DEMO_IDS = {
	a: {
		owner: '01a204f1-e34d-71bb-b980-8fe07f3a0d44',
		mandate: '01a204f1-e350-7462-a537-5fed27427867',
		scope: '01a204f1-e350-7462-a537-6328106e6eb1',
		property: '01a204f1-e351-7249-a505-b79d390215cf',
		unit: '01a204f1-e351-7249-a505-b92b63192862',
		tenant: '01a204f1-e351-7249-a505-bea7bc5fc0cc',
		lease: '01a204f1-e351-7249-a505-c325d6f73fed',
		deposit: '01a204f1-e351-7249-a505-c4f433043cf8',
		notice: '01a204f1-e351-7249-a505-cbad565fff89',
		payout: '01a204f1-e351-7249-a505-cffbb3d10046',
		ownerLink: '01a204f1-e351-7249-a505-d168edad3a9d',
		tenantLink: '01a204f1-e351-7249-a505-d4bfab883139'
	},
	b: {
		owner: '01a204f1-e351-7249-a505-d866c91351b8',
		mandate: '01a204f1-e351-7249-a505-df0b585ee828',
		scope: '01a204f1-e351-7249-a505-e340af160f7e',
		property: '01a204f1-e351-7249-a505-e7c5e992927a',
		unit: '01a204f1-e351-7249-a505-eb423353e10a',
		tenant: '01a204f1-e351-7249-a505-ee16b8935eef',
		lease: '01a204f1-e351-7249-a505-f36c682da5bd',
		deposit: '01a204f1-e351-7249-a505-f4e487db0b74',
		ownerLink: '01a204f1-e351-7249-a505-f803e9dcb574',
		tenantLink: '01a204f1-e351-7249-a505-fc71e2f8a9d4'
	},
	l: {
		property: '01a204f1-e351-7249-a506-0093fed8b8ba',
		unit: '01a204f1-e351-7249-a506-072ad3963778'
	}
} as const;

/** Encaissements : identifiant fixe par bail et par rang (l'encaissement, son reçu). */
const PAYMENT_IDS = [
	'01a204f1-e351-7249-a506-0a29fec72232',
	'01a204f1-e351-7249-a506-0fa140f94687',
	'01a204f1-e351-7249-a506-135e50a977bf',
	'01a204f1-e351-7249-a506-14dccc72e760',
	'01a204f1-e351-7249-a506-19bf36835590',
	'01a204f1-e352-71e3-8d1a-4362a5db8f2b',
	'01a204f1-e352-71e3-8d1a-467317187e29',
	'01a204f1-e352-71e3-8d1a-4a64638c8431',
	'01a204f1-e352-71e3-8d1a-4e1e2c52d16a',
	'01a204f1-e352-71e3-8d1a-50b291f1c41e'
];
const RECEIPT_IDS = [
	'01a204f3-7fe0-77bf-bedd-d657749e641a',
	'01a204f3-7fe3-758b-9304-a723d297dbc9',
	'01a204f3-7fe3-758b-9304-a8b223a6da98',
	'01a204f3-7fe3-758b-9304-aff8200fb5a6',
	'01a204f3-7fe3-758b-9304-b0acb8138caf',
	'01a204f3-7fe3-758b-9304-b43faeb62715',
	'01a204f3-7fe3-758b-9304-bb6a17d31739',
	'01a204f3-7fe3-758b-9304-bd8975c8fb18',
	'01a204f3-7fe3-758b-9304-c33cc110fcf9',
	'01a204f3-7fe3-758b-9304-c65e56a1d1dd'
];

interface Reply<T> {
	status: number;
	body: T;
}

/** Client de l'API : jeton d'accès, organisation active, origine du web (comme le navigateur). */
class Api {
	token: string | undefined;
	constructor(
		private readonly base: string,
		private readonly origin: string,
		readonly organizationId?: string
	) {}

	as(organizationId: string): Api {
		const a = new Api(this.base, this.origin, organizationId);
		a.token = this.token;
		return a;
	}

	async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
		const headers: Record<string, string> = { origin: this.origin, 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' };
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		if (this.organizationId) headers['x-organization-id'] = this.organizationId;
		const res = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await res.text();
		return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
	}

	/** Appel qui doit réussir ; sinon, le seed s'arrête avec la réponse de l'API. */
	async ok<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
		const r = await this.call<T>(method, path, body);
		if (r.status >= 300) throw new Error(`Démonstration : ${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
		return r.body;
	}

	async exists(path: string): Promise<boolean> {
		const r = await this.call('GET', path);
		if (r.status === 200) return true;
		if (r.status === 404) return false;
		throw new Error(`Démonstration : GET ${path} → ${r.status} ${JSON.stringify(r.body)}`);
	}
}

type Dues = {
	status: string;
	rentDues: { id: string; periodStart: string; dueOn: string; amountDue: number; amountPaid: number; status: string }[];
};

export interface DemoRecordsResult {
	created: string[];
}

/**
 * `config` : celle de l'application (DATABASE_URL du rôle app_api, Redis, stockage). L'API de ce processus envoie ses
 * SMS en mémoire, sans limite d'envoi ni de connexion (elle ne sert qu'au seed et s'arrête à la fin).
 */
export async function seedDemoRecords(config: AppConfig, password: string, today = toIsoDate()): Promise<DemoRecordsResult> {
	const app = await createApp({
		...config,
		SMS_DRIVER: 'memory',
		OTP_SEND_INTERVAL_SECONDS: 0,
		OTP_SEND_PER_PHONE_PER_HOUR: 1000,
		RATE_LIMIT_LOGIN_PER_PHONE_PER_MINUTE: 1000,
		RATE_LIMIT_PER_IP_PER_MINUTE: 5000
	});
	await app.listen(0, '127.0.0.1');
	const created: string[] = [];
	try {
		const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
		const sms = app.get<MemorySmsSender>(SMS_SENDER);
		const origin = config.CORS_ORIGINS[0]!;
		const login = async (key: string) => {
			const api = new Api(base, origin);
			const r = await api.ok<{ accessToken: string }>('POST', '/auth/login', { phone: phoneOf(key), password });
			api.token = r.accessToken;
			return api;
		};
		const a = (await login('a.director')).as(ORG_A);
		const b = (await login('b.director')).as(ORG_B);
		const owner = await login(DEMO_OWNER);
		const tenant = await login(DEMO_TENANT);
		const l = owner.as(ORG_L);
		const [y, m] = today.split('-').map(Number) as [number, number];
		const firstOfMonth = monthDay(y, m, 0, 1);
		const endOfPreviousMonth = addDays(firstOfMonth, -1);
		const previousMonth = endOfPreviousMonth.slice(0, 7);

		// ---------------------------------------------------------------- fiches, mandats, biens (A et B)
		const managed = async (
			api: Api,
			ids: (typeof DEMO_IDS)['a' | 'b'],
			place: { property: string; unit: string; neighborhood: string }
		) => {
			if (!(await api.exists(`/owners/${ids.owner}`))) {
				await api.ok('POST', '/owners', { id: ids.owner, type: 'person', name: 'Mariam Zongo', phone: phoneOf(DEMO_OWNER) });
				await api.ok('POST', '/mandates', {
					id: ids.mandate,
					ownerId: ids.owner,
					type: 'rental_management',
					startsOn: monthDay(y, m, -8, 1),
					commission: { basis: 'percent_of_collected', rateBp: 1000 },
					canCollectFunds: true,
					canTakePhotos: true
				});
				created.push(`fiche propriétaire et mandat (${api.organizationId})`);
			}
			if (!(await api.exists(`/properties/${ids.property}`))) {
				await api.ok('POST', '/properties', {
					id: ids.property,
					ownerId: ids.owner,
					type: 'apartment_building',
					name: place.property,
					communeId: 'ouagadougou',
					neighborhoodId: place.neighborhood
				});
				await api.ok('POST', `/properties/${ids.property}/status`, { status: 'active' });
				await api.ok('POST', `/mandates/${ids.mandate}/scopes`, { id: ids.scope, propertyId: ids.property });
				created.push(`bien ${place.property}`);
			}
			if (!(await api.exists(`/units/${ids.unit}`))) {
				await api.ok('POST', '/units', {
					id: ids.unit,
					propertyId: ids.property,
					type: 'apartment',
					label: place.unit,
					rent: 75000,
					charges: 5000,
					depositAmount: 150000,
					advanceMonths: 1
				});
				await api.ok('POST', `/units/${ids.unit}/status`, { status: 'active' });
				created.push(`unité ${place.unit}`);
			}
			if (!(await api.exists(`/tenants/${ids.tenant}`))) {
				await api.ok('POST', '/tenants', { id: ids.tenant, fullName: 'Moussa Nikiéma', phone: phoneOf(DEMO_TENANT) });
				created.push(`fiche locataire (${api.organizationId})`);
			}
		};
		await managed(a, DEMO_IDS.a, { property: 'Immeuble Wend-Panga, Tampouy', unit: 'Appartement A1', neighborhood: TAMPOUY });
		await managed(b, DEMO_IDS.b, { property: 'Résidence Nong-Taaba, Ouaga 2000', unit: 'Appartement B2', neighborhood: OUAGA_2000 });

		// ---------------------------------------------------------------- encaissements
		let paymentRank = 0;
		const pay = async (api: Api, leaseId: string, amount: number, paidOn: string, extra: Record<string, unknown> = {}) => {
			const id = PAYMENT_IDS[paymentRank]!;
			const receiptId = RECEIPT_IDS[paymentRank]!;
			paymentRank++;
			if (await api.exists(`/payments/${id}`)) return;
			await api.ok('POST', '/payments', {
				payments: [
					{
						id,
						leaseId,
						purpose: 'rent',
						amount,
						method: 'cash',
						paidOn,
						receiptId,
						provisionalNumber: provisionalReceiptNumber(receiptId),
						verificationToken: newReceiptToken(),
						shareToken: newReceiptToken(),
						...extra
					}
				]
			});
			created.push(`encaissement de ${amount} FCFA`);
		};
		/** Chaque échéance passée de ce bail payée à sa date (un encaissement, un reçu), dans l'ordre. */
		const payDues = async (api: Api, leaseId: string, before: string, slots: number) => {
			const lease = await api.ok<Dues>('GET', `/leases/${leaseId}`);
			const open = lease.rentDues
				.filter((d) => d.status !== 'waived' && d.periodStart < before)
				.sort((x, z) => (x.dueOn < z.dueOn ? -1 : 1));
			for (let i = 0; i < slots; i++) {
				const d = open[i];
				if (!d) {
					paymentRank++;
					continue;
				}
				const remaining = d.amountDue - d.amountPaid;
				if (remaining > 0) await pay(api, leaseId, remaining, d.dueOn < today ? d.dueOn : today);
				else paymentRank++;
			}
		};

		// ---------------------------------------------------------------- A : bail terminé, décompte proposé
		const leaseA = DEMO_IDS.a.lease;
		if (!(await a.exists(`/leases/${leaseA}`))) {
			await a.ok('POST', '/leases', {
				id: leaseA,
				unitId: DEMO_IDS.a.unit,
				tenantId: DEMO_IDS.a.tenant,
				startsOn: monthDay(y, m, -6, 1),
				rent: 75000,
				charges: 5000,
				lessorType: 'owner'
			});
			await a.ok('POST', '/deposit-accounts', {
				id: DEMO_IDS.a.deposit,
				leaseId: leaseA,
				type: 'security_deposit',
				agreedAmount: 150000,
				holder: 'organization'
			});
			created.push('bail terminé de Moussa Nikiéma (A)');
		}
		// Caution versée à l'entrée, puis les loyers de chaque mois passé.
		await pay(a, leaseA, 150000, monthDay(y, m, -6, 1), { purpose: 'deposit', depositAccountId: DEMO_IDS.a.deposit });
		await payDues(a, leaseA, firstOfMonth, 6);
		const exitA = await a.ok<{ status: string; notices: { id: string }[]; settlements: { id: string; status: string }[] }>(
			'GET',
			`/leases/${leaseA}/exit`
		);
		if (!exitA.notices.length) {
			await a.ok('POST', `/leases/${leaseA}/notice`, {
				id: DEMO_IDS.a.notice,
				origin: 'tenant',
				deliveryMode: 'hand_delivery',
				notifiedOn: addMonths(endOfPreviousMonth, -4),
				plannedExitOn: endOfPreviousMonth
			});
			created.push('congé du locataire (A)');
		}
		if ((await a.ok<{ status: string }>('GET', `/leases/${leaseA}`)).status !== 'ended') {
			// La vraie tâche du jour termine le bail à sa date de sortie (dernier mois au prorata, unité à remettre en état).
			await runLeasesDaily(app.get(DatabaseService), app.get(AuditService), today, app.get(ExitHooks), app.get(RentDueEvents));
			created.push('fin du bail par la tâche du jour (A)');
		}
		const ended = await a.ok<Dues>('GET', `/leases/${leaseA}`);
		const owed = ended.rentDues.filter((d) => d.status !== 'waived').reduce((s, d) => s + d.amountDue - d.amountPaid, 0);
		if (owed > 0) await pay(a, leaseA, owed, today);
		else paymentRank++;
		const exitNow = await a.ok<{ settlements: { id: string; status: string }[] }>('GET', `/leases/${leaseA}/exit`);
		let settlement = exitNow.settlements[0];
		if (!settlement) {
			settlement = await a.ok<{ id: string; status: string }>('POST', `/deposit-accounts/${DEMO_IDS.a.deposit}/settlement`, {});
			created.push('décompte de sortie (A)');
		}
		if (settlement.status === 'draft') {
			await a.ok('POST', `/deposit-settlements/${settlement.id}/propose`, {});
			created.push('décompte proposé au locataire (A)');
		}

		// ---------------------------------------------------------------- A : relevé émis et reversé
		// Relevé du mois dernier : celui qui existe déjà (rejouable), sinon préparé puis émis.
		const existing = await a.ok<{ items: { id: string; status: string; revision: string }[] }>(
			'GET',
			`/owner-statements?ownerId=${DEMO_IDS.a.owner}&month=${previousMonth}`
		);
		const statement =
			existing.items[0] ??
			(await a.ok<{ id: string; status: string; revision: string }>('POST', '/owner-statements/generate', {
				ownerId: DEMO_IDS.a.owner,
				month: previousMonth
			}));
		if (statement.status === 'draft') {
			await a.ok('POST', `/owner-statements/${statement.id}/issue`, { revision: statement.revision });
			created.push(`relevé de ${previousMonth} émis (A)`);
		}
		const detail = await a.ok<{ remaining: number }>('GET', `/owner-statements/${statement.id}`);
		const payouts = await a.ok<unknown[]>('GET', `/owner-statements/${statement.id}/payouts`);
		if (detail.remaining > 0 && !payouts.length) {
			await a.ok('POST', '/owner-payouts', {
				id: DEMO_IDS.a.payout,
				statementId: statement.id,
				amount: detail.remaining,
				paidOn: today,
				method: 'mobile_money'
			});
			created.push('reversement au propriétaire (A)');
		}

		// ---------------------------------------------------------------- B : bail en cours
		const leaseB = DEMO_IDS.b.lease;
		if (!(await b.exists(`/leases/${leaseB}`))) {
			await b.ok('POST', '/leases', {
				id: leaseB,
				unitId: DEMO_IDS.b.unit,
				tenantId: DEMO_IDS.b.tenant,
				startsOn: firstOfMonth,
				rent: 80000,
				charges: 5000,
				lessorType: 'owner'
			});
			await b.ok('POST', '/deposit-accounts', {
				id: DEMO_IDS.b.deposit,
				leaseId: leaseB,
				type: 'security_deposit',
				agreedAmount: 160000,
				holder: 'organization'
			});
			created.push('bail en cours de Moussa Nikiéma (B)');
		}
		await pay(b, leaseB, 160000, firstOfMonth < today ? firstOfMonth : today, { purpose: 'deposit', depositAccountId: DEMO_IDS.b.deposit });
		await payDues(b, leaseB, addDays(today, 1), 1);

		// ---------------------------------------------------------------- bailleur particulier : sa fiche, son bien
		const own = await l.ok<{ id: string }[]>('GET', '/owners');
		if (!own.length) {
			// Organisation créée par la première partie du seed : le crochet de création n'avait pas tourné.
			const db = app.get(DatabaseService);
			const userId = (await owner.ok<{ id: string }>('GET', '/me')).id;
			await db.withOrganization(ORG_L, async (tx) => {
				const [o] = await tx.select().from(organizations).where(eq(organizations.id, ORG_L));
				await RequestContext.run({ origin: 'job', userId }, () =>
					app.get(OrganizationCreationHooks).run(tx, {
						organizationId: ORG_L,
						type: 'landlord',
						legalName: o!.legalName,
						phone: o!.phone,
						userId
					})
				);
			});
			created.push('fiche et mandat du bailleur particulier');
		}
		const [self] = await l.ok<{ id: string }[]>('GET', '/owners');
		if (!(await l.exists(`/properties/${DEMO_IDS.l.property}`))) {
			await l.ok('POST', '/properties', {
				id: DEMO_IDS.l.property,
				ownerId: self!.id,
				type: 'shared_compound',
				name: 'Cour familiale, Badnogo',
				communeId: 'saaba',
				neighborhoodId: BADNOGO
			});
			await l.ok('POST', `/properties/${DEMO_IDS.l.property}/status`, { status: 'active' });
			await l.ok('POST', '/units', {
				id: DEMO_IDS.l.unit,
				propertyId: DEMO_IDS.l.property,
				type: 'room_lounge',
				label: 'Chambre-salon 1',
				rent: 35000,
				charges: 0,
				depositAmount: 70000,
				advanceMonths: 1
			});
			await l.ok('POST', `/units/${DEMO_IDS.l.unit}/status`, { status: 'active' });
			created.push('bien du bailleur particulier');
		}

		// ---------------------------------------------------------------- liens des deux comptes personnels
		const mine = async (person: Api) =>
			person.ok<{ organizationId: string; recordType: string; status: string }[]>('GET', '/me/person-links');
		const link = async (org: Api, person: Api, personKey: string, recordType: 'owner' | 'tenant', recordId: string, id: string) => {
			const current = await mine(person);
			if (current.some((x) => x.organizationId === org.organizationId && x.recordType === recordType && x.status === 'active')) return;
			const invite = await org.call('POST', '/person-links', { id, recordType, recordId, sendSms: true });
			if (invite.status >= 300 && invite.status !== 409)
				throw new Error(`Démonstration : invitation → ${invite.status} ${JSON.stringify(invite.body)}`);
			if (invite.status === 409) {
				await org.ok('POST', `/person-links/${id}/resend`, { sendSms: true });
			}
			const text = [...sms.messages].reverse().find((s) => s.to === phoneOf(personKey) && s.text.includes('/lier/'))?.text ?? '';
			const token = /\/lier\/([A-Za-z0-9_.-]+)/.exec(text)?.[1];
			if (!token) throw new Error('Démonstration : invitation sans lien.');
			const claim = await person.ok<{ linkId: string; organizationId: string }>('POST', `/person-link-invitations/${token}/claim`);
			await person.ok('POST', `/me/person-links/${claim.linkId}/verify`, {
				organizationId: claim.organizationId,
				code: sms.lastCode(phoneOf(personKey))
			});
			created.push(`liaison ${recordType} (${org.organizationId})`);
		};
		await link(a, owner, DEMO_OWNER, 'owner', DEMO_IDS.a.owner, DEMO_IDS.a.ownerLink);
		await link(b, owner, DEMO_OWNER, 'owner', DEMO_IDS.b.owner, DEMO_IDS.b.ownerLink);
		await link(a, tenant, DEMO_TENANT, 'tenant', DEMO_IDS.a.tenant, DEMO_IDS.a.tenantLink);
		await link(b, tenant, DEMO_TENANT, 'tenant', DEMO_IDS.b.tenant, DEMO_IDS.b.tenantLink);
		// Sa propre fiche de bailleur se lie d'elle-même à la lecture de ses liens (réponse 2 du lot 10 ter).
		const links = await mine(owner);
		if (!links.some((x) => x.organizationId === ORG_L && x.status === 'active'))
			throw new Error('Démonstration : fiche du bailleur non liée.');
		return { created };
	} finally {
		await app.close();
	}
}
