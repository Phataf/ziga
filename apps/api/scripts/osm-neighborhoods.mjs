/**
 * Référentiel géographique (lot 07) : quartiers de Ouagadougou et de Saaba tirés d'OpenStreetMap
 * (© les contributeurs d'OpenStreetMap, licence ODbL). Lancé une fois, sur une machine qui a accès à Internet ;
 * le fichier produit est relu, puis versionné : la migration du référentiel en est générée, et l'application
 * n'appelle jamais OpenStreetMap.
 *
 * Usage (depuis la racine du dépôt) :
 *   node apps/api/scripts/osm-neighborhoods.mjs
 *   node apps/api/scripts/osm-neighborhoods.mjs --from reponse-overpass.json   (réponse déjà enregistrée, sans réseau)
 *
 * Produit apps/api/src/db/data/osm-neighborhoods.json et affiche la liste par commune, avec le type de lieu.
 * Chaque centre est marqué verified = false : il est à vérifier sur place, depuis le back-office.
 *
 * Quartiers : nœuds, et zones (way, relation) avec leur centre ; un même nom en nœud et en zone dans une commune ne
 * donne qu'un quartier, au centre de la zone. Commune de chaque lieu : le marqueur que la requête place avant chaque
 * bloc ; à défaut (réponse exportée d'overpass-turbo), l'étiquette is_in:department ; à défaut, le centre de commune le
 * plus proche, signalé dans la liste (« commune devinée »).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUTPUT = resolve(import.meta.dirname, '../src/db/data/osm-neighborhoods.json');

/** Serveurs Overpass essayés dans l'ordre (le premier qui répond). */
const ENDPOINTS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.kumi.systems/api/interpreter',
	'https://overpass.private.coffee/api/interpreter'
];

/** Communes du lancement (D08) et types de lieux OSM retenus comme quartiers. */
export const COMMUNES = [
	{ slug: 'ouagadougou', name: 'Ouagadougou', centerPlaces: ['city'] },
	{ slug: 'saaba', name: 'Saaba', centerPlaces: ['town', 'village', 'city'] }
];
export const NEIGHBORHOOD_PLACES = ['suburb', 'quarter', 'neighbourhood', 'village', 'hamlet'];
/** Rectangle qui contient les deux communes (sud, ouest, nord, est). */
export const BBOX = '12.10,-1.80,12.60,-1.15';

/**
 * Requête : dans le rectangle, chaque commune par sa zone administrative (un rectangle seul ramènerait les villages
 * des communes voisines), nœuds et zones avec leur centre ; un marqueur `commune` avant chaque bloc dit à quelle commune
 * appartiennent les lieux qui suivent.
 */
export function overpassQuery() {
	const places = NEIGHBORHOOD_PLACES.join('|');
	const areas = COMMUNES.map((c, i) => `area["name"="${c.name}"]["boundary"="administrative"]->.c${i};`).join('\n');
	const blocks = COMMUNES.map(
		(c, i) => `make commune slug="${c.slug}";\nout;\nnwr(area.c${i})["place"~"^(${places})$"]["name"];\nout center tags;`
	).join('\n');
	const centers = `make commune slug="centres";\nout;\nnode["place"~"^(city|town|village)$"]["name"~"^(${COMMUNES.map((c) => c.name).join('|')})$"];\nout center tags;`;
	return `[out:json][timeout:120][bbox:${BBOX}];\n${areas}\n${blocks}\n${centers}`;
}

/** Nom comparé sans accents, sans casse, espaces réduits : deux lieux de même nom dans une commune n'en font qu'un. */
export function normalize(name) {
	return name
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

const round = (x) => Math.round(x * 1e6) / 1e6;

/** Coordonnées d'un lieu : celles du nœud, ou le centre de la zone. */
export function positionOf(e) {
	if (e.type === 'node' && Number.isFinite(e.lat) && Number.isFinite(e.lon)) return { lat: e.lat, lon: e.lon };
	if (e.center && Number.isFinite(e.center.lat) && Number.isFinite(e.center.lon)) return { lat: e.center.lat, lon: e.center.lon };
	return null;
}

const isArea = (e) => e.type === 'way' || e.type === 'relation';

/**
 * Réponse d'Overpass → référentiel : centre de chaque commune ; quartiers rangés par commune, sans doublon de nom
 * (la zone l'emporte sur le nœud) ; les lieux dont la commune a été devinée à la distance sont marqués `guessed`.
 */
export function toReferential(response) {
	let current = null;
	const located = [];
	for (const e of response.elements ?? []) {
		if (e.type === 'commune') {
			current = e.tags?.slug ?? null;
			continue;
		}
		const position = positionOf(e);
		if (!e.tags?.name || !position) continue;
		located.push({ element: e, position, block: current });
	}

	const communes = COMMUNES.map((c) => {
		const center = located.find(({ element: e }) => e.type === 'node' && e.tags.name === c.name && c.centerPlaces.includes(e.tags.place));
		if (!center) throw new Error(`Centre de la commune introuvable dans la réponse : ${c.name}`);
		return {
			slug: c.slug,
			name: c.name,
			lat: round(center.position.lat),
			lng: round(center.position.lon),
			osmId: `node/${center.element.id}`,
			verified: false
		};
	});
	const centerIds = new Set(communes.map((c) => c.osmId));
	const bySlug = new Map(COMMUNES.map((c) => [c.slug, c]));
	const distance = (p, c) => (p.lat - c.lat) ** 2 + (p.lon - c.lng) ** 2;

	/** Commune d'un lieu : marqueur, puis is_in:department, puis le centre le plus proche (deviné). */
	function communeOf({ element: e, position, block }) {
		if (block && bySlug.has(block)) return { slug: block, guessed: false };
		const department = e.tags['is_in:department'];
		const tagged = department && COMMUNES.find((c) => normalize(c.name) === normalize(department));
		if (tagged) return { slug: tagged.slug, guessed: false };
		const nearest = communes.reduce((best, c) => (distance(position, c) < distance(position, best) ? c : best));
		return { slug: nearest.slug, guessed: true };
	}

	const kept = new Map();
	const duplicates = [];
	for (const item of located) {
		const { element: e, position } = item;
		if (!NEIGHBORHOOD_PLACES.includes(e.tags.place) || centerIds.has(`${e.type}/${e.id}`)) continue;
		if (item.block === 'centres') continue;
		const { slug, guessed } = communeOf(item);
		const key = `${slug}:${normalize(e.tags.name)}`;
		const entry = {
			commune: slug,
			name: e.tags.name.trim(),
			place: e.tags.place,
			lat: round(position.lat),
			lng: round(position.lon),
			osmId: `${e.type}/${e.id}`,
			osmType: e.type,
			guessed,
			verified: false
		};
		const previous = kept.get(key);
		if (!previous) {
			kept.set(key, entry);
			continue;
		}
		// Même nom dans la même commune : la zone l'emporte sur le nœud ; sinon, le premier reste.
		if (isArea(e) && previous.osmType === 'node') {
			kept.set(key, entry);
			duplicates.push({ commune: slug, name: previous.name, osmId: previous.osmId, keptInstead: entry.osmId });
		} else {
			duplicates.push({ commune: slug, name: entry.name, osmId: entry.osmId, keptInstead: previous.osmId });
		}
	}
	const neighborhoods = [...kept.values()].sort((a, b) => a.commune.localeCompare(b.commune) || a.name.localeCompare(b.name, 'fr'));
	return { communes, neighborhoods, duplicates };
}

/** Liste lisible : par commune, puis par nom, avec le type de lieu, l'objet OSM et la commune devinée. */
export function listing(referential) {
	const lines = [];
	for (const c of referential.communes) {
		const mine = referential.neighborhoods.filter((n) => n.commune === c.slug);
		const byPlace = NEIGHBORHOOD_PLACES.map((p) => [p, mine.filter((n) => n.place === p).length]).filter(([, n]) => n > 0);
		lines.push(
			`${c.name} : ${mine.length} quartier${mine.length > 1 ? 's' : ''} (${byPlace.map(([p, n]) => `${p} ${n}`).join(', ') || 'aucun'}) ; centre ${c.lat}, ${c.lng}`
		);
		for (const n of mine) lines.push(`  - ${n.name} [${n.place}, ${n.osmId}]${n.guessed ? ' (commune devinée à la distance)' : ''}`);
	}
	if (referential.duplicates.length) {
		lines.push(`Doublons de nom écartés : ${referential.duplicates.length}`);
		for (const d of referential.duplicates) lines.push(`  - ${d.name} (${d.commune}) : ${d.osmId} écarté, ${d.keptInstead} gardé`);
	}
	return lines.join('\n');
}

async function fetchOverpass(query) {
	const errors = [];
	for (const endpoint of ENDPOINTS) {
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ziga-referentiel/1.0' },
				body: new URLSearchParams({ data: query }),
				signal: AbortSignal.timeout(150_000)
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return { endpoint, response: await res.json() };
		} catch (error) {
			errors.push(`${endpoint} : ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`Aucun serveur Overpass n'a répondu :\n${errors.join('\n')}`);
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes('--query')) {
		console.log(overpassQuery());
		return;
	}
	const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
	const { endpoint, response } = from
		? { endpoint: `fichier ${from.split(/[\\/]/).at(-1)}`, response: JSON.parse(readFileSync(from, 'utf8')) }
		: await fetchOverpass(overpassQuery());
	const referential = toReferential(response);
	const output = {
		source: '© les contributeurs d’OpenStreetMap (ODbL), via Overpass',
		fetchedAt: new Date().toISOString(),
		osmTimestamp: response.osm3s?.timestamp_osm_base ?? null,
		endpoint,
		...referential
	};
	mkdirSync(dirname(OUTPUT), { recursive: true });
	writeFileSync(OUTPUT, `${JSON.stringify(output, null, '\t')}\n`);
	console.log(listing(referential));
	console.log(`Écrit : ${OUTPUT}`);
}

if (process.argv[1]?.endsWith('osm-neighborhoods.mjs')) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
