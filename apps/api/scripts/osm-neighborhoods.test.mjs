/**
 * Extraction des quartiers depuis OpenStreetMap (lot 07) : sur des extraits des deux réponses d'Overpass fournies
 * par le porteur (nœuds seulement, puis nœuds et zones avec leur centre), et sur une réponse au format de la requête
 * du script (marqueurs de commune). © les contributeurs d'OpenStreetMap (ODbL).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BBOX, listing, overpassQuery, positionOf, toReferential } from './osm-neighborhoods.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const names = (ref, commune) => ref.neighborhoods.filter((n) => n.commune === commune).map((n) => n.name);

describe('requête Overpass', () => {
	it('nœuds et zones (nwr), centre des zones, rectangle des deux communes, un marqueur par commune', () => {
		const q = overpassQuery();
		expect(q).toContain(`[bbox:${BBOX}]`);
		expect(BBOX).toBe('12.10,-1.80,12.60,-1.15');
		expect(q.match(/nwr\(area\.c\d\)/g)).toHaveLength(2);
		expect(q.match(/out center tags;/g)).toHaveLength(3);
		expect(q).toContain('make commune slug="ouagadougou"');
		expect(q).toContain('make commune slug="saaba"');
	});
});

describe('réponse en nœuds seulement (reponse-overpass.json)', () => {
	const ref = toReferential(fixture('overpass-nodes.json'));

	it('centres des deux communes, à vérifier', () => {
		expect(ref.communes).toEqual([
			{ slug: 'ouagadougou', name: 'Ouagadougou', lat: 12.368187, lng: -1.527094, osmId: 'node/27565002', verified: false },
			{ slug: 'saaba', name: 'Saaba', lat: 12.376944, lng: -1.420833, osmId: 'node/902867125', verified: false }
		]);
	});

	it('commune : is_in:department d’abord, sinon le centre le plus proche, signalé « devinée »', () => {
		const gampela = ref.neighborhoods.find((n) => n.name === 'Gampéla');
		expect(gampela).toMatchObject({ commune: 'saaba', place: 'village', guessed: false });
		expect(ref.neighborhoods.find((n) => n.name === 'Bilbalogho')).toMatchObject({ commune: 'ouagadougou', guessed: true });
		expect(names(ref, 'ouagadougou')).toEqual(['Bilbalogho', 'Ouaga 2000', 'Somgande']);
		expect(ref.neighborhoods.every((n) => n.verified === false)).toBe(true);
	});
});

describe('réponse en nœuds et zones (reponse-overpass-v2.json)', () => {
	const ref = toReferential(fixture('overpass-nwr.json'));

	it('une zone (way) est un quartier, au centre de la zone', () => {
		expect(ref.neighborhoods.find((n) => n.name === 'Paspanga')).toMatchObject({
			commune: 'ouagadougou',
			place: 'neighbourhood',
			lat: 12.379097,
			lng: -1.520228,
			osmId: 'way/27895707',
			osmType: 'way'
		});
		expect(names(ref, 'ouagadougou')).toEqual(['1200 Logements', 'Karpala', 'Karpalin', 'Nonsin', 'Paspanga']);
		expect(positionOf({ type: 'way', id: 1 })).toBeNull();
	});

	it('même nom en nœud et en zone dans une commune : un seul quartier, au centre de la zone', () => {
		const response = fixture('overpass-nwr.json');
		// Le nœud « Paspanga » ajouté ici n'existe pas dans la réponse : il imite un quartier saisi deux fois.
		response.elements.unshift({ type: 'node', id: 1, lat: 12.38, lon: -1.52, tags: { name: 'paspanga', place: 'suburb' } });
		const merged = toReferential(response);
		expect(merged.neighborhoods.filter((n) => n.name.toLowerCase() === 'paspanga')).toEqual([
			expect.objectContaining({ osmId: 'way/27895707', lat: 12.379097 })
		]);
		expect(merged.duplicates).toEqual([{ commune: 'ouagadougou', name: 'paspanga', osmId: 'node/1', keptInstead: 'way/27895707' }]);
	});

	it('liste lisible : par commune puis par nom, avec le type de lieu et l’objet OSM', () => {
		const text = listing(ref);
		expect(text).toContain('Ouagadougou : 5 quartiers (suburb 3, neighbourhood 2)');
		expect(text).toContain('  - Paspanga [neighbourhood, way/27895707] (commune devinée à la distance)');
		expect(text).toContain('  - Gampéla [village, node/902962332]');
	});
});

describe('réponse de la requête du script (marqueurs de commune)', () => {
	it('chaque lieu prend la commune de son bloc, sans rien deviner', () => {
		const ref = toReferential({
			elements: [
				{ type: 'commune', id: 1, tags: { slug: 'ouagadougou' } },
				{ type: 'way', id: 10, center: { lat: 12.38, lon: -1.43 }, tags: { name: 'Tabtenga', place: 'suburb' } },
				{ type: 'commune', id: 2, tags: { slug: 'saaba' } },
				{ type: 'node', id: 11, lat: 12.43, lon: -1.38, tags: { name: 'Gampéla', place: 'village' } },
				{ type: 'commune', id: 3, tags: { slug: 'centres' } },
				{ type: 'node', id: 27565002, lat: 12.3681873, lon: -1.5270944, tags: { name: 'Ouagadougou', place: 'city' } },
				{ type: 'node', id: 902867125, lat: 12.376944, lon: -1.420833, tags: { name: 'Saaba', place: 'town' } }
			]
		});
		// Tabtenga est plus près du centre de Saaba, mais son bloc dit Ouagadougou : le marqueur l'emporte.
		expect(ref.neighborhoods).toEqual([
			expect.objectContaining({ commune: 'ouagadougou', name: 'Tabtenga', guessed: false }),
			expect.objectContaining({ commune: 'saaba', name: 'Gampéla', guessed: false })
		]);
	});
});
