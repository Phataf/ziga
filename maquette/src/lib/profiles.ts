/**
 * Profils de la démo. Chaque profil a son espace, sa navigation et son périmètre de données.
 * Dans le produit, le profil découle du compte (rôle d'agence, lien propriétaire ou locataire) ;
 * ici, un sélecteur « Voir en tant que » permet de les parcourir pendant les entretiens.
 */
import {
	Building2,
	CalendarClock,
	ClipboardCheck,
	Ellipsis,
	FileText,
	History,
	House,
	KeyRound,
	LayoutDashboard,
	LifeBuoy,
	LogOut,
	MessageCircle,
	Receipt,
	ScrollText,
	Search,
	ShieldCheck,
	ToggleRight,
	TrendingUp,
	TriangleAlert,
	Users,
	Wallet,
	Wrench
} from '@lucide/svelte';

export type ProfileId = 'director' | 'manager' | 'field_agent' | 'landlord' | 'owner' | 'tenant' | 'visitor' | 'admin';

/** Espace applicatif : chaque espace a sa propre coque et ses propres routes. */
export type Space = 'agency' | 'owner' | 'tenant' | 'public' | 'admin';

export interface NavItem {
	href: string;
	label: string;
	/** Libellé court pour la barre d'onglets du téléphone. */
	short?: string;
	icon: typeof House;
	/** Préfixes d'URL qui rendent l'entrée active. */
	match: string[];
	/** Section du menu latéral sur ordinateur. */
	section?: string;
	/** Visible dans la barre d'onglets du téléphone (4 au plus). */
	tab?: boolean;
	/** Entrée propre au téléphone (« Plus ») : absente du rail et du menu latéral. */
	phoneOnly?: boolean;
}

export interface Profile {
	id: ProfileId;
	label: string;
	/** Qui c'est, en une ligne, pour le sélecteur. */
	description: string;
	space: Space;
	home: string;
	nav: NavItem[];
}

const agencyNav = (opts: { owners: boolean; team: boolean; validate: boolean; exits?: boolean }): NavItem[] => [
	{ href: '/', label: 'Tableau de bord', short: 'Accueil', icon: LayoutDashboard, match: ['/'], section: 'Pilotage', tab: true },
	{ href: '/biens', label: 'Biens et unités', short: 'Biens', icon: Building2, match: ['/biens'], section: 'Gestion', tab: true },
	{
		href: '/encaissements',
		label: 'Encaissements',
		icon: Wallet,
		match: ['/encaissements', '/encaisser', '/recus'],
		section: 'Gestion',
		tab: true
	},
	{ href: '/impayes', label: 'Impayés', icon: TriangleAlert, match: ['/impayes'], section: 'Gestion' },
	...(opts.exits !== false ? [{ href: '/sorties', label: 'Préavis et sorties', icon: LogOut, match: ['/sorties'], section: 'Gestion' }] : []),
	...(opts.owners
		? [{ href: '/proprietaires', label: 'Propriétaires', icon: Users, match: ['/proprietaires'], section: 'Gestion' }]
		: []),
	...(opts.validate
		? [{ href: '/encaissements?filtre=a_valider', label: 'À valider', icon: ClipboardCheck, match: [], section: 'Contrôle' }]
		: []),
	...(opts.team ? [{ href: '/plus', label: 'Agence et équipe', short: 'Plus', icon: Users, match: ['/plus'], section: 'Agence' }] : [])
];

export const profiles: Record<ProfileId, Profile> = {
	director: {
		id: 'director',
		label: 'Directeur d’agence',
		description: 'Pilote l’agence, l’équipe et valide les encaissements',
		space: 'agency',
		home: '/',
		nav: agencyNav({ owners: true, team: true, validate: true })
	},
	manager: {
		id: 'manager',
		label: 'Gestionnaire',
		description: 'Gère les biens, encaisse et relance au quotidien',
		space: 'agency',
		home: '/',
		nav: agencyNav({ owners: true, team: false, validate: true })
	},
	field_agent: {
		id: 'field_agent',
		label: 'Agent de terrain',
		description: 'Encaisse en espèces et fait les visites de ses biens',
		space: 'agency',
		home: '/',
		nav: [
			{ href: '/', label: 'Ma tournée', short: 'Tournée', icon: CalendarClock, match: ['/'], section: 'Terrain', tab: true },
			{ href: '/biens', label: 'Mes biens', short: 'Biens', icon: Building2, match: ['/biens'], section: 'Terrain', tab: true },
			{
				href: '/encaissements',
				label: 'Mes encaissements',
				short: 'Encaissements',
				icon: Wallet,
				match: ['/encaissements', '/encaisser', '/recus'],
				section: 'Terrain',
				tab: true
			},
			{ href: '/impayes', label: 'Retards', icon: TriangleAlert, match: ['/impayes'], section: 'Terrain' }
		]
	},
	landlord: {
		id: 'landlord',
		label: 'Bailleur particulier',
		description: 'Issouf Sawadogo gère lui-même son immeuble de Larlé',
		space: 'agency',
		home: '/',
		nav: [
			{ href: '/', label: 'Accueil', icon: LayoutDashboard, match: ['/'], section: 'Mes logements', tab: true },
			{ href: '/biens', label: 'Mes logements', short: 'Logements', icon: House, match: ['/biens'], section: 'Mes logements', tab: true },
			{
				href: '/encaissements',
				label: 'Loyers reçus',
				short: 'Loyers',
				icon: Wallet,
				match: ['/encaissements', '/encaisser', '/recus'],
				section: 'Mes logements',
				tab: true
			},
			{ href: '/impayes', label: 'Retards', icon: TriangleAlert, match: ['/impayes'], section: 'Mes logements' },
			{ href: '/sorties', label: 'Préavis et sorties', icon: LogOut, match: ['/sorties'], section: 'Mes logements' }
		]
	},
	owner: {
		id: 'owner',
		label: 'Propriétaire',
		description: 'Issouf Sawadogo : biens chez deux agences et en gestion directe',
		space: 'owner',
		home: '/proprietaire',
		nav: [
			{ href: '/proprietaire', label: 'Mon patrimoine', short: 'Patrimoine', icon: Building2, match: ['/proprietaire', '/proprietaire/biens'], section: 'Mon patrimoine', tab: true },
			{ href: '/proprietaire/revenus', label: 'Revenus', icon: TrendingUp, match: ['/proprietaire/revenus'], section: 'Mon patrimoine', tab: true },
			{ href: '/proprietaire/releves', label: 'Relevés', icon: FileText, match: ['/proprietaire/releves'], section: 'Mon patrimoine', tab: true },
			{ href: '/proprietaire/plus', label: 'Mon compte et mes gestionnaires', short: 'Plus', icon: Ellipsis, match: ['/proprietaire/plus'], section: 'Compte', tab: true }
		]
	},
	tenant: {
		id: 'tenant',
		label: 'Locataire',
		description: 'Rodrigue Yaméogo : son logement et tout son historique',
		space: 'tenant',
		home: '/locataire',
		nav: [
			{ href: '/locataire', label: 'Mon logement', short: 'Logement', icon: KeyRound, match: ['/locataire'], section: 'Mon espace', tab: true },
			{ href: '/locataire/historique', label: 'Mon historique', icon: History, match: ['/locataire/historique'], section: 'Mon espace' },
			{ href: '/locataire/recus', label: 'Mes reçus', short: 'Reçus', icon: Receipt, match: ['/locataire/recus'], section: 'Mon espace', tab: true },
			{ href: '/locataire/caution', label: 'Caution et décompte', short: 'Caution', icon: ShieldCheck, match: ['/locataire/caution'], section: 'Mon espace', tab: true },
			{ href: '/locataire/signalements', label: 'Mes signalements', icon: Wrench, match: ['/locataire/signalements'], section: 'Mon espace' },
			{ href: '/locataire/contact', label: 'Contacter l’agence', icon: MessageCircle, match: ['/locataire/contact'], section: 'Mon espace' },
			{ href: '/locataire/plus', label: 'Plus', icon: Ellipsis, match: ['/locataire/plus'], tab: true, phoneOnly: true }
		]
	},
	visitor: {
		id: 'visitor',
		label: 'Visiteur ou acheteur',
		description: 'Cherche un logement à louer ou un bien à acheter',
		space: 'public',
		home: '/vitrine',
		nav: [{ href: '/vitrine', label: 'Rechercher', icon: Search, match: ['/vitrine', '/annonce'] }]
	},
	admin: {
		id: 'admin',
		label: 'Administrateur plateforme',
		description: 'Organisations, abonnements, interrupteurs, assistance',
		space: 'admin',
		home: '/admin',
		nav: [
			{ href: '/admin', label: 'Organisations', icon: Building2, match: ['/admin'], section: 'Plateforme', tab: true },
			{ href: '/admin/abonnements', label: 'Formules et abonnements', short: 'Abonnements', icon: Wallet, match: ['/admin/abonnements'], section: 'Plateforme', tab: true },
			{ href: '/admin/fonctionnalites', label: 'Fonctionnalités', icon: ToggleRight, match: ['/admin/fonctionnalites'], section: 'Plateforme', tab: true },
			{ href: '/admin/assistance', label: 'Accès d’assistance', short: 'Assistance', icon: LifeBuoy, match: ['/admin/assistance'], section: 'Contrôle', tab: true },
			{ href: '/admin/journal', label: 'Journal', icon: ScrollText, match: ['/admin/journal'], section: 'Contrôle' }
		]
	}
};

export const profileOrder: ProfileId[] = ['director', 'manager', 'field_agent', 'landlord', 'owner', 'tenant', 'visitor', 'admin'];

/** Groupes du sélecteur de profil. */
export const profileGroups: { label: string; ids: ProfileId[] }[] = [
	{ label: 'Agence', ids: ['director', 'manager', 'field_agent'] },
	{ label: 'Particulier', ids: ['landlord'] },
	{ label: 'Espaces personnels (compte vérifié par SMS)', ids: ['owner', 'tenant'] },
	{ label: 'Public', ids: ['visitor'] },
	{ label: 'Plateforme', ids: ['admin'] }
];

/** Entrée de navigation active : le préfixe le plus long qui correspond. */
export function activeNav(nav: NavItem[], pathname: string): NavItem | undefined {
	let best: NavItem | undefined;
	let bestLen = -1;
	for (const item of nav) {
		for (const m of item.match) {
			const hit = m === '/' ? pathname === '/' : pathname === m || pathname.startsWith(m + '/');
			if (hit && m.length > bestLen) {
				best = item;
				bestLen = m.length;
			}
		}
	}
	return best;
}

/** Espace auquel appartient une URL. */
export function spaceOfPath(pathname: string): Space {
	if (pathname.startsWith('/proprietaire') && !pathname.startsWith('/proprietaires')) return 'owner';
	if (pathname.startsWith('/locataire')) return 'tenant';
	if (pathname.startsWith('/vitrine') || pathname.startsWith('/annonce')) return 'public';
	if (pathname.startsWith('/admin')) return 'admin';
	return 'agency';
}
