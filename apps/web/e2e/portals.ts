/**
 * Aides des tests de bout en bout des espaces personnels (lot 10 ter, étape 3) : fiche liée à un compte par le vrai
 * parcours (invitation par SMS, réclamée par la personne, code validé), biens d'un propriétaire, bailleur particulier.
 */
import { readFileSync } from 'node:fs';
import { expect, type APIRequestContext } from '@playwright/test';
import { addDays, toIsoDate } from '@ziga/shared/dates';
import { newId } from '@ziga/shared/ids';
import { login, post, type Agency, type Person } from './agency';
import { accounts, API_URL, lastCode, SMS_FILE } from './support';

/** Dernier lien d'invitation (`/lier/<jeton>`) envoyé par SMS à ce numéro. */
export function lastInvitationToken(to: string): string {
	const lines = readFileSync(SMS_FILE, 'utf8').trim().split('\n').reverse();
	for (const line of lines) {
		const sms = JSON.parse(line) as { to: string; text: string };
		const token = sms.to === to ? /\/lier\/([A-Za-z0-9_.-]+)/.exec(sms.text)?.[1] : undefined;
		if (token) return token;
	}
	throw new Error(`Aucune invitation envoyée à ${to}`);
}

export async function personHeaders(request: APIRequestContext, person: Person) {
	return { Authorization: `Bearer ${await login(request, person.phone, person.password)}` };
}

/** Liaison complète d'une fiche : l'organisation invite par SMS, la personne réclame l'invitation et valide son code. */
export async function linkRecord(
	request: APIRequestContext,
	agency: Agency,
	person: Person,
	recordType: 'owner' | 'tenant',
	recordId: string
): Promise<void> {
	await post(request, agency.headers, '/person-links', { id: newId(), recordType, recordId, sendSms: true });
	const headers = await personHeaders(request, person);
	const claim = await request.post(`${API_URL}/person-link-invitations/${lastInvitationToken(person.phone)}/claim`, { headers });
	expect(claim.status(), await claim.text()).toBe(200);
	const { linkId } = (await claim.json()) as { linkId: string };
	const verify = await request.post(`${API_URL}/me/person-links/${linkId}/verify`, {
		headers,
		data: { organizationId: agency.id, code: lastCode(person.phone) }
	});
	expect(verify.status(), await verify.text()).toBe(200);
}

async function neighborhood(request: APIRequestContext): Promise<string> {
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const geo = (await (await request.get(`${API_URL}/admin/geography`, { headers: { Authorization: `Bearer ${admin}` } })).json()) as {
		neighborhoods: { id: string; name: string }[];
	};
	return geo.neighborhoods.find((n) => n.name === 'Tampouy')!.id;
}

/** Un bien actif avec une unité active, à ce propriétaire (fiche existante, mandat déjà posé ou self_managed). */
export async function propertyOf(
	request: APIRequestContext,
	agency: Agency,
	ownerId: string,
	names: { property: string; unit: string },
	mandateId?: string
) {
	const propertyId = newId();
	await post(request, agency.headers, '/properties', {
		id: propertyId,
		ownerId,
		type: 'apartment_building',
		name: names.property,
		communeId: 'ouagadougou',
		neighborhoodId: await neighborhood(request)
	});
	await post(request, agency.headers, `/properties/${propertyId}/status`, { status: 'active' });
	if (mandateId) await post(request, agency.headers, `/mandates/${mandateId}/scopes`, { id: newId(), propertyId });
	const unitId = newId();
	await post(request, agency.headers, '/units', {
		id: unitId,
		propertyId,
		type: 'apartment',
		label: names.unit,
		rent: 75000,
		charges: 5000,
		depositAmount: 150000,
		advanceMonths: 1
	});
	await post(request, agency.headers, `/units/${unitId}/status`, { status: 'active' });
	return { propertyId, unitId };
}

/** Fiche propriétaire au numéro de la personne, sous mandat de gestion locative, avec un bien et une unité. */
export async function ownerInAgency(request: APIRequestContext, agency: Agency, person: Person, names: { property: string; unit: string }) {
	const ownerId = newId();
	const mandateId = newId();
	await post(request, agency.headers, '/owners', { id: ownerId, type: 'person', name: 'Rasmané Compaoré', phone: person.phone });
	await post(request, agency.headers, '/mandates', {
		id: mandateId,
		ownerId,
		type: 'rental_management',
		startsOn: addDays(toIsoDate(), -90),
		commission: { basis: 'percent_of_collected', rateBp: 1000 },
		canCollectFunds: true,
		canTakePhotos: true
	});
	return { ownerId, ...(await propertyOf(request, agency, ownerId, names, mandateId)) };
}

/** La personne crée son organisation de bailleur particulier (formule Pro) ; sa fiche propriétaire naît avec elle. */
export async function ownLandlord(request: APIRequestContext, person: Person, legalName: string) {
	const headers = await personHeaders(request, person);
	const id = newId();
	const created = await request.post(`${API_URL}/organizations`, {
		headers,
		data: { id, type: 'landlord', legalName, phone: person.phone, commune: 'Ouagadougou' }
	});
	expect(created.status()).toBe(201);
	const admin = await login(request, accounts.admin.phone, accounts.admin.password);
	const plan = await request.put(`${API_URL}/admin/organizations/${id}/plan`, {
		headers: { Authorization: `Bearer ${admin}` },
		data: { planId: 'pro', reason: 'Test de bout en bout : espaces personnels' }
	});
	expect(plan.status()).toBe(204);
	const agency: Agency = { id, director: person, headers: { ...headers, 'X-Organization-Id': id } };
	const owners = (await (await request.get(`${API_URL}/owners`, { headers: agency.headers })).json()) as { id: string }[];
	return { agency, ownerId: owners[0]!.id };
}
