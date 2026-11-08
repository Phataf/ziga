/**
 * Profils, espaces et navigation (docs/UX.md §2). Chaque profil a son espace, ses onglets sur téléphone
 * (4 au plus) et son menu par sections sur ordinateur. Au lot 01, les écrans sont vides : chaque entrée
 * indique le lot qui la construit. Ce que chaque profil peut faire sera décidé par les permissions (lot 03)
 * et les interrupteurs (lot 04), vérifiés côté serveur.
 */
import {
	Building2,
	CalendarClock,
	ClipboardCheck,
	Ellipsis,
	FileText,
	HandCoins,
	History,
	House,
	KeyRound,
	LayoutDashboard,
	LifeBuoy,
	LogOut,
	Receipt,
	ScrollText,
	Settings,
	ShieldCheck,
	Stamp,
	ToggleRight,
	TrendingUp,
	TriangleAlert,
	Users,
	Wallet,
	Wrench
} from '@lucide/svelte';
import type { Path } from '$app/types';
import { fr } from './i18n/fr';

export type ProfileId = 'director' | 'manager' | 'field_agent' | 'viewer' | 'landlord' | 'owner' | 'tenant' | 'visitor' | 'admin';
export type Space = 'agency' | 'owner' | 'tenant' | 'public' | 'admin';

export interface NavItem {
	/** Chemin typé par SvelteKit (sans « / » initial), à passer à resolve(). */
	path: Path;
	/** Même chemin avec « / », pour comparer avec l'URL courante. */
	href: string;
	label: string;
	/** Libellé court de la barre d'onglets du téléphone. */
	short?: string;
	icon: typeof House;
	/** Section du menu latéral (ordinateur). */
	section?: string;
	/** Onglet du téléphone (4 au plus, « Plus » compris). */
	tab?: boolean;
	/** Entrée propre au téléphone (« Plus ») : absente du rail et du menu latéral. */
	phoneOnly?: boolean;
	/** Lot qui construit l'écran. */
	lot?: string;
}

export interface Profile {
	id: ProfileId;
	label: string;
	space: Space;
	/** Accueil de l'espace (chemin typé, à passer à resolve()). */
	home: Path;
	nav: NavItem[];
}

const n = fr.nav;

function item(i: Omit<NavItem, 'href'>): NavItem {
	return { ...i, href: `/${i.path}` };
}
const s = fr.sections;

function plus(base: 'app' | 'espace/proprietaire' | 'espace/locataire' | 'admin'): NavItem {
	return item({ path: `${base}/plus` as Path, label: fr.app.more, icon: Ellipsis, tab: true, phoneOnly: true });
}

/** Écrans d'organisation construits au lot 03 (équipe, paramètres, journal), selon le rôle. */
function organizationItems(opts: { team: boolean; settings: boolean }, section: string): NavItem[] {
	return [
		...(opts.team ? [item({ path: 'app/equipe', label: n.team, icon: Users, section })] : []),
		...(opts.settings
			? [
					item({ path: 'app/organisation', label: n.settingsLong, short: n.settings, icon: Settings, section }),
					item({ path: 'app/journal', label: n.journal, icon: ScrollText, section })
				]
			: [])
	];
}

function agencyNav(opts: { team: boolean; settings: boolean }): NavItem[] {
	return [
		item({ path: 'app', label: n.dashboard, short: n.home, icon: LayoutDashboard, section: s.steering, tab: true, lot: '09' }),
		item({ path: 'app/biens', label: n.propertiesLong, short: n.properties, icon: Building2, section: s.management, tab: true, lot: '07' }),
		item({ path: 'app/encaissements', label: n.payments, icon: Wallet, section: s.management, tab: true, lot: '09' }),
		item({ path: 'app/impayes', label: n.arrears, icon: TriangleAlert, section: s.management, lot: '10' }),
		item({ path: 'app/proprietaires', label: n.owners, icon: Users, section: s.management, lot: '06' }),
		item({ path: 'app/a-valider', label: n.toValidate, icon: ClipboardCheck, section: s.control, lot: '09' }),
		...organizationItems(opts, s.agency),
		plus('app')
	];
}

export const profiles: Record<ProfileId, Profile> = {
	director: { id: 'director', label: fr.profiles.director, space: 'agency', home: 'app', nav: agencyNav({ team: true, settings: true }) },
	// Le gestionnaire voit l'équipe en lecture (affectation des agents au lot 07).
	manager: { id: 'manager', label: fr.profiles.manager, space: 'agency', home: 'app', nav: agencyNav({ team: true, settings: false }) },
	viewer: { id: 'viewer', label: fr.profiles.viewer, space: 'agency', home: 'app', nav: agencyNav({ team: false, settings: false }) },
	field_agent: {
		id: 'field_agent',
		label: fr.profiles.field_agent,
		space: 'agency',
		home: 'app',
		nav: [
			item({ path: 'app', label: n.myRound, short: n.round, icon: CalendarClock, section: s.field, tab: true, lot: '09' }),
			item({ path: 'app/biens', label: n.myProperties, short: n.properties, icon: Building2, section: s.field, tab: true, lot: '07' }),
			item({ path: 'app/encaissements', label: n.myPayments, short: n.payments, icon: Wallet, section: s.field, tab: true, lot: '09' }),
			item({ path: 'app/impayes', label: n.late, icon: TriangleAlert, section: s.field, lot: '10' }),
			plus('app')
		]
	},
	landlord: {
		id: 'landlord',
		label: fr.profiles.landlord,
		space: 'agency',
		home: 'app',
		nav: [
			item({ path: 'app', label: n.home, icon: LayoutDashboard, section: s.myHomes, tab: true, lot: '09' }),
			item({ path: 'app/biens', label: n.myHomes, short: n.homes, icon: House, section: s.myHomes, tab: true, lot: '07' }),
			item({ path: 'app/encaissements', label: n.rentsReceived, short: n.rents, icon: Wallet, section: s.myHomes, tab: true, lot: '09' }),
			item({ path: 'app/impayes', label: n.late, icon: TriangleAlert, section: s.myHomes, lot: '10' }),
			// Le bailleur est directeur de son organisation : ses paramètres (logo des reçus) et son journal.
			...organizationItems({ team: false, settings: true }, s.myHomes),
			plus('app')
		]
	},
	owner: {
		id: 'owner',
		label: fr.profiles.owner,
		space: 'owner',
		home: 'espace/proprietaire',
		nav: [
			item({
				path: 'espace/proprietaire',
				label: n.myAssets,
				short: n.assets,
				icon: Building2,
				section: s.myAssets,
				tab: true,
				lot: '10 ter'
			}),
			item({ path: 'espace/proprietaire/revenus', label: n.income, icon: TrendingUp, section: s.myAssets, tab: true, lot: '10 ter' }),
			item({ path: 'espace/proprietaire/releves', label: n.statements, icon: FileText, section: s.myAssets, tab: true, lot: '10 ter' }),
			item({ path: 'espace/proprietaire/reversements', label: n.payouts, icon: HandCoins, section: s.myAssets, lot: '10 ter' }),
			item({ path: 'espace/proprietaire/approbations', label: n.approvals, icon: Stamp, section: s.myAssets, lot: '10 ter' }),
			plus('espace/proprietaire')
		]
	},
	tenant: {
		id: 'tenant',
		label: fr.profiles.tenant,
		space: 'tenant',
		home: 'espace/locataire',
		nav: [
			item({
				path: 'espace/locataire',
				label: n.myHousing,
				short: n.housing,
				icon: KeyRound,
				section: s.mySpace,
				tab: true,
				lot: '10 ter'
			}),
			item({ path: 'espace/locataire/historique', label: n.history, icon: History, section: s.mySpace, lot: '10 ter' }),
			item({ path: 'espace/locataire/recus', label: n.receipts, icon: Receipt, section: s.mySpace, tab: true, lot: '10 ter' }),
			item({
				path: 'espace/locataire/caution',
				label: n.depositLong,
				short: n.deposit,
				icon: ShieldCheck,
				section: s.mySpace,
				tab: true,
				lot: '10 ter'
			}),
			item({ path: 'espace/locataire/signalements', label: n.requests, icon: Wrench, section: s.mySpace, lot: '10 ter' }),
			item({ path: 'espace/locataire/preavis', label: n.notice, icon: LogOut, section: s.mySpace, lot: '10 ter' }),
			plus('espace/locataire')
		]
	},
	visitor: {
		id: 'visitor',
		label: fr.profiles.visitor,
		space: 'public',
		home: '',
		nav: [
			item({ path: 'louer', label: n.rent, icon: KeyRound, lot: '12' }),
			item({ path: 'acheter', label: n.buy, icon: House, lot: '12' })
		]
	},
	admin: {
		id: 'admin',
		label: fr.profiles.admin,
		space: 'admin',
		home: 'admin',
		nav: [
			item({ path: 'admin', label: n.organizations, icon: Building2, section: s.platform, tab: true, lot: '04' }),
			item({ path: 'admin/formules', label: n.plansLong, short: n.plans, icon: Wallet, section: s.platform, tab: true, lot: '04' }),
			item({ path: 'admin/fonctionnalites', label: n.features, icon: ToggleRight, section: s.platform, tab: true, lot: '04' }),
			item({ path: 'admin/journal', label: n.journal, icon: ScrollText, section: s.control, lot: '04' }),
			item({ path: 'admin/assistance', label: n.support, icon: LifeBuoy, section: s.control, lot: '04' }),
			plus('admin')
		]
	}
};

export const agencyProfiles: ProfileId[] = ['director', 'manager', 'field_agent', 'viewer', 'landlord'];

/** Onglets du téléphone : 4 au plus, dans l'ordre déclaré. */
export function tabsOf(profile: Profile): NavItem[] {
	return profile.nav.filter((i) => i.tab).slice(0, 4);
}

/** Entrées du rail (tablette) et du menu latéral (ordinateur) : tout sauf « Plus ». */
export function menuOf(profile: Profile): NavItem[] {
	return profile.nav.filter((i) => !i.phoneOnly);
}

/** Entrées sans onglet, rassemblées dans l'écran « Plus » du téléphone. */
export function moreOf(profile: Profile): NavItem[] {
	return profile.nav.filter((i) => !i.tab && !i.phoneOnly);
}

/** Entrées du menu latéral regroupées par section, dans l'ordre de déclaration. */
export function sectionsOf(profile: Profile): [string, NavItem[]][] {
	const map = new Map<string, NavItem[]>();
	for (const item of menuOf(profile)) map.set(item.section ?? '', [...(map.get(item.section ?? '') ?? []), item]);
	return [...map.entries()];
}

/** Entrée active : celle dont le chemin est le plus long préfixe du chemin courant. */
export function activeNav(nav: NavItem[], pathname: string): NavItem | undefined {
	let best: NavItem | undefined;
	for (const item of nav) {
		const hit = pathname === item.href || pathname.startsWith(`${item.href}/`);
		if (hit && (!best || item.href.length > best.href.length)) best = item;
	}
	return best;
}

/** Espace d'une URL. */
export function spaceOfPath(pathname: string): Space {
	if (pathname === '/app' || pathname.startsWith('/app/')) return 'agency';
	if (pathname.startsWith('/espace/proprietaire')) return 'owner';
	if (pathname.startsWith('/espace/locataire')) return 'tenant';
	if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
	return 'public';
}

/** Écran demandé dans la navigation d'un profil (écrans vides du lot 01). */
export function screenOf(profile: Profile, pathname: string): NavItem | undefined {
	const path = pathname.replace(/\/$/, '') || '/';
	return profile.nav.find((i) => i.href === path);
}

/** Tous les chemins déclarés par les navigations : un autre chemin répond 404. */
export const knownPaths = new Set(Object.values(profiles).flatMap((p) => p.nav.map((i) => i.href)));

export function normalizePath(pathname: string): string {
	return pathname.replace(/\/+$/, '') || '/';
}
