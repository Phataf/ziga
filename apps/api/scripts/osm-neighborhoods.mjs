/**
 * Référentiel géographique (lot 07) : quartiers de Ouagadougou et de Saaba tirés d'OpenStreetMap
 * (© les contributeurs d'OpenStreetMap, licence ODbL). Lancé une fois, sur une machine qui a accès à Internet ;
 * le fichier produit est relu, puis versionné : la migration du référentiel en est générée, et l'application
 * n'appelle jamais OpenStreetMap.
 *
 * Usage (depuis la racine du dépôt) :
 *   node apps/api/scripts/osm-neighborhoods.mjs
 *   node apps/api/scripts/osm-neighborhoods.mjs --from reponse-overpass.json   (sans réseau, réponse déjà enregistrée)
 *
 * Produit apps/api/src/db/data/osm-neighborhoods.json et affiche le décompte par commune et par type de lieu.
 * Chaque centre est marqué verified = false : il est à vérifier sur place, depuis le back-office.
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

export function overpassQuery() {
	const places = NEIGHBORHOOD_PLACES.join('|');
	const areas = COMMUNES.map((c, i) => `area["name"="${c.name}"]["boundary"="administrative"]->.c${i};`).join('\n');
	const inside = COMMUNES.map((c, i) => `  node(area.c${i})["place"~"^(${places})$"]["name"];`).join('\n');
	const centers = `  node["place"~"^(city|town|village)$"]["name"~"^(${COMMUNES.map((c) => c.name).join('|')})$"];`;
	return `[out:json][timeout:120];\n${areas}\n(\n${inside}\n${centers}\n);\nout body;`;
}

/** Nom comparé sans accents, sans casse, espaces réduits : deux nœuds de même nom dans une commune n'en font qu'un. */
export function normalize(name) {
	return name
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

const round = (x) => Math.round(x * 1e6) / 1e6;

/**
 * Réponse d'Overpass → référentiel : centre de chaque commune, quartiers rangés par commune (un nœud est rangé dans
 * la commune dont il est le plus proche du centre, ce qui départage un nœud renvoyé pour les deux zones).
 */
export function toReferential(response) {
	const elements = (response.elements ?? []).filter(
		(e) => e.type === 'node' && e.tags?.name && Number.isFinite(e.lat) && Number.isFinite(e.lon)
	);
	const communes = COMMUNES.map((c) => {
		const center = elements.find((e) => e.tags.name === c.name && c.centerPlaces.includes(e.tags.place));
		if (!center) throw new Error(`Centre de la commune introuvable dans la réponse : ${c.name}`);
		return { slug: c.slug, name: c.name, lat: round(center.lat), lng: round(center.lon), osmId: `node/${center.id}`, verified: false };
	});
	const distance = (e, c) => (e.lat - c.lat) ** 2 + (e.lon - c.lng) ** 2;
	const centerIds = new Set(communes.map((c) => c.osmId));
	const seen = new Map();
	const duplicates = [];
	for (const e of elements) {
		if (!NEIGHBORHOOD_PLACES.includes(e.tags.place) || centerIds.has(`node/${e.id}`)) continue;
		const commune = communes.reduce((best, c) => (distance(e, c) < distance(e, best) ? c : best));
		const key = `${commune.slug}:${normalize(e.tags.name)}`;
		if (seen.has(key)) {
			duplicates.push({ commune: commune.slug, name: e.tags.name, osmId: `node/${e.id}` });
			continue;
		}
		seen.set(key, {
			commune: commune.slug,
			name: e.tags.name.trim(),
			place: e.tags.place,
			lat: round(e.lat),
			lng: round(e.lon),
			osmId: `node/${e.id}`,
			verified: false
		});
	}
	const neighborhoods = [...seen.values()].sort((a, b) => a.commune.localeCompare(b.commune) || a.name.localeCompare(b.name, 'fr'));
	return { communes, neighborhoods, duplicates };
}

/** Décompte affiché après l'extraction : par commune, puis par type de lieu. */
export function summary(referential) {
	const lines = [];
	for (const c of referential.communes) {
		const mine = referential.neighborhoods.filter((n) => n.commune === c.slug);
		const byPlace = NEIGHBORHOOD_PLACES.map((p) => [p, mine.filter((n) => n.place === p).length]).filter(([, n]) => n > 0);
		lines.push(
			`${c.name} : ${mine.length} quartier${mine.length > 1 ? 's' : ''} (${byPlace.map(([p, n]) => `${p} ${n}`).join(', ') || 'aucun'}) ; centre ${c.lat}, ${c.lng}`
		);
	}
	if (referential.duplicates.length) lines.push(`Doublons de nom écartés : ${referential.duplicates.length}`);
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
	const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
	const { endpoint, response } = from
		? { endpoint: `fichier ${from}`, response: JSON.parse(readFileSync(from, 'utf8')) }
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
	console.log(summary(referential));
	console.log(`Écrit : ${OUTPUT}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('osm-neighborhoods.mjs')) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
