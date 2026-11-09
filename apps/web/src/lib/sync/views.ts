/**
 * Lignes de la base locale → vues des écrans (lot 05). Fonctions pures, testées sans navigateur (views.test.ts).
 * Les vues sont celles que renvoyait l'API : les écrans n'ont pas à savoir d'où vient la donnée.
 */
import type { FeatureOverride, FeatureState, ResolutionData } from '@ziga/shared/features';
import type { OrganizationView, PaymentMethod } from '@ziga/shared/organizations';
import type { OrganizationRole } from '@ziga/shared/permissions';

type Row = Record<string, unknown>;

const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';

/** Tableau PostgreSQL synchronisé en texte JSON (« ["cash","bank_transfer"] »). */
export function jsonArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String);
	if (typeof v !== 'string' || !v) return [];
	try {
		const parsed: unknown = JSON.parse(v);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

/** Fiche locale de l'organisation (LOCAL_QUERIES.organization) ; le logo en place est celui de `logo_id`. */
export function toOrganizationView(row: Row, apiBase: string): OrganizationView {
	const id = String(row.id);
	const logoId = text(row.logo_id);
	const base = apiBase.replace(/\/$/, '');
	return {
		id,
		type: row.type as OrganizationView['type'],
		legalName: String(row.legal_name ?? ''),
		tradeName: text(row.trade_name),
		phone: String(row.phone ?? ''),
		address: text(row.address),
		commune: String(row.commune ?? ''),
		poBox: text(row.po_box),
		rccm: text(row.rccm),
		ifu: text(row.ifu),
		representative: {
			name: text(row.rep_name),
			title: text(row.rep_title),
			profession: text(row.rep_profession),
			address: text(row.rep_address),
			nationality: text(row.rep_nationality),
			idType: text(row.rep_id_type) as OrganizationView['representative']['idType'],
			idTypeOther: text(row.rep_id_type_other),
			idNumber: text(row.rep_id_number),
			idIssuedOn: text(row.rep_id_issued_on),
			idIssuedBy: text(row.rep_id_issued_by)
		},
		verificationStatus: row.verification_status as OrganizationView['verificationStatus'],
		logo: logoId
			? { id: logoId, status: 'ready', webUrl: `${base}/logos/${id}/${logoId}/web.webp`, pdfUrl: `${base}/logos/${id}/${logoId}/print.png` }
			: null,
		planId: String(row.plan_id ?? 'discovery'),
		acceptedPaymentMethods: jsonArray(row.accepted_payment_methods) as PaymentMethod[],
		createdAt: '',
		updatedAt: String(row.updated_at ?? '')
	};
}

export interface LocalMember {
	id: string;
	userId: string;
	name: string;
	role: OrganizationRole;
	joinedAt: string;
	current: boolean;
}

export function toMember(row: Row, currentUserId: string | null | undefined): LocalMember {
	return {
		id: String(row.id),
		userId: String(row.user_id),
		name: String(row.display_name ?? ''),
		role: row.role as OrganizationRole,
		joinedAt: String(row.joined_at ?? ''),
		current: row.user_id === currentUserId
	};
}

/** Données de résolution des fonctionnalités, lues dans la base locale (même fonction pure que le serveur, lot 04). */
export function toResolutionData(features: Row[], planFeatures: Row[], overrides: Row[]): ResolutionData {
	const states: Record<string, FeatureState> = {};
	for (const f of features) {
		states[String(f.id)] = {
			key: String(f.id),
			globalMode: f.global_mode as FeatureState['globalMode'],
			planBound: bool(f.plan_bound),
			requires: jsonArray(f.requires)
		};
	}
	const byPlan: Record<string, string[]> = {};
	for (const p of planFeatures) (byPlan[String(p.plan_id)] ??= []).push(String(p.feature_key));
	const list: FeatureOverride[] = overrides.map((o) => ({
		featureKey: String(o.feature_key),
		scope: o.scope as FeatureOverride['scope'],
		targetId: String(o.scope === 'organization' ? o.organization_id : o.user_id),
		value: bool(o.value),
		reason: '',
		startsAt: new Date(String(o.starts_at)),
		endsAt: text(o.ends_at) ? new Date(String(o.ends_at)) : null
	}));
	return { features: states, planFeatures: byPlan, overrides: list };
}

/** Clés désactivées par le directeur pour son organisation. */
export function disabledKeys(settings: Row[]): string[] {
	return settings.filter((s) => bool(s.disabled_by_organization)).map((s) => String(s.feature_key));
}
