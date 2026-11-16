/**
 * Aides des tests de bout en bout des lots 08 et 08 bis, contre la vraie API et le vrai service PowerSync : agence neuve
 * (formule Pro), membres invités, appels à l'API, et ce que le flux PowerSync envoie réellement à une personne.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { newId } from '@ziga/shared/ids';
import { accounts, API_URL, registerViaApi } from './support';

export async function login(request: APIRequestContext, phoneNumber: string, password: string): Promise<string> {
	const r = await request.post(`${API_URL}/auth/login`, { data: { phone: phoneNumber, password } });
	expect(r.status()).toBe(200);
	return ((await r.json()) as { accessToken: string }).accessToken;
}

export type Person = Awaited<ReturnType<typeof registerViaApi>>;
export interface Agency {
	id: string;
	director: Person;
	headers: Record<string, string>;
}
export type Member = Person & { userId: string; headers: Record<string, string> };

export async function freshAgency(request: APIRequestContext, name: string): Promise<Agency> {
	const director = await registerViaApi(request, `Directrice ${name}`);
	const token = await login(request, director.phone, director.password);
	const id = newId();
	const created = await request.post(`${API_URL}/organizations`, {
		headers: { Authorization: `Bearer ${token}` },
		data: { id, type: 'agency', legalName: name, phone: '+22625300000', commune: 'Ouagadougou' }
	});
	expect(created.status()).toBe(201);
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const plan = await request.put(`${API_URL}/admin/organizations/${id}/plan`, {
		headers: { Authorization: `Bearer ${admin}` },
		data: { planId: 'pro', reason: 'Test de bout en bout : baux' }
	});
	expect(plan.status()).toBe(204);
	return { id, director, headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': id } };
}

export async function addMember(
	request: APIRequestContext,
	agency: Agency,
	role: 'manager' | 'field_agent' | 'viewer',
	name: string
): Promise<Member> {
	const person = await registerViaApi(request, name);
	const invitation = await request.post(`${API_URL}/organization/invitations`, {
		headers: agency.headers,
		data: { phone: person.phone, role }
	});
	expect(invitation.status()).toBe(201);
	const token = await login(request, person.phone, person.password);
	const { token: link } = (await invitation.json()) as { token: string };
	expect((await request.post(`${API_URL}/invitations/${link}/accept`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(
		200
	);
	const me = (await (await request.get(`${API_URL}/me`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { id: string };
	return { ...person, userId: me.id, headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': agency.id } };
}

export async function post(request: APIRequestContext, headers: Record<string, string>, path: string, data: Record<string, unknown>) {
	const r = await request.post(`${API_URL}${path}`, { headers, data });
	expect(r.status(), `${path} ${await r.text()}`).toBeLessThan(300);
	return r.json() as Promise<Record<string, unknown>>;
}

export async function get<T>(request: APIRequestContext, headers: Record<string, string>, path: string): Promise<T> {
	const r = await request.get(`${API_URL}${path}`, { headers });
	expect(r.status(), path).toBe(200);
	return r.json() as Promise<T>;
}

export type SyncedRow = { table: string; data: Record<string, unknown> };

/** Ce que le vrai service PowerSync envoie à cette personne, jusqu'au premier point de contrôle complet. */
export async function received(request: APIRequestContext, accessToken: string): Promise<SyncedRow[]> {
	const cred = await request.get(`${API_URL}/sync/credentials`, { headers: { Authorization: `Bearer ${accessToken}` } });
	expect(cred.status()).toBe(200);
	const { endpoint, token } = (await cred.json()) as { endpoint: string; token: string };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	const res = await fetch(`${endpoint}/sync/stream`, {
		method: 'POST',
		signal: controller.signal,
		headers: { authorization: `Token ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			buckets: [],
			include_checksum: true,
			raw_data: true,
			client_id: `e2e-${newId()}`,
			streams: { include_defaults: true, subscriptions: [] }
		})
	});
	expect(res.status).toBe(200);
	const rows = new Map<string, SyncedRow>();
	let buffer = '';
	try {
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += Buffer.from(chunk).toString();
			let nl: number;
			let done = false;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				const message = JSON.parse(line) as {
					data?: { data: { op: string; object_type: string; object_id: string; data?: string }[] };
					checkpoint_complete?: unknown;
				};
				for (const op of message.data?.data ?? []) {
					const key = `${op.object_type}/${op.object_id}`;
					if (op.op === 'PUT' && op.data) rows.set(key, { table: op.object_type, data: JSON.parse(op.data) });
					else rows.delete(key);
				}
				if (message.checkpoint_complete) done = true;
			}
			if (done) break;
		}
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	return [...rows.values()];
}
