-- Lot 07 — référentiel géographique : communes et quartiers. Tables de la plateforme, sans organization_id ni RLS :
-- identiques pour tous, lues par toutes les organisations (app_api, lecture seule), synchronisées vers chaque appareil,
-- complétées par le back-office seul (app_admin, chaque ajout audité par le module du back-office). Rien n'est supprimé.
--
-- Données initiales : la liste des quartiers du porteur fait foi (noms, orthographe, commune). Le point central vient
-- d'OpenStreetMap (© les contributeurs d'OpenStreetMap, ODbL) quand un lieu y porte le même nom (comparé sans accents
-- ni casse) ou quand le porteur l'a désigné comme le même lieu (Kalgondé : « Kalgodin » ; Pagalayiri : « Paglayiri » ;
-- Zékounga : « Zékounga I » ; Tabtenga, rangé à Ouagadougou). Sinon le point est vide. Aucun point n'est vérifié sur
-- place : verified = false partout. Extraction : apps/api/scripts/osm-neighborhoods.mjs.
-- La vitrine ne publie jamais le point GPS d'un bien : seulement le centre du quartier, ou celui de la commune quand le
-- quartier n'a pas de point (publicLocation, packages/shared/src/geography.ts).

-- Clé de comparaison d'un nom : sans accents, sans casse, espaces réduits (comme normalize() du script et de shared).
CREATE FUNCTION geo_name_key(name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$
	SELECT btrim(regexp_replace(lower(translate(name,
		'ÀÂÄÁÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇÑàâäáãéèêëíìîïóòôöõúùûüçñ',
		'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn')), '\s+', ' ', 'g'))
$$;
--> statement-breakpoint

CREATE TABLE communes (
	id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	name text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 2 AND 80),
	-- Centre de la commune : toujours présent, c'est le repli de la vitrine pour un quartier sans point.
	lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
	lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
	osm_ref text CHECK (osm_ref ~ '^(node|way|relation)/[0-9]+$'),
	verified boolean NOT NULL DEFAULT false,
	updated_at timestamptz NOT NULL DEFAULT now(),
	updated_by uuid REFERENCES users (id)
);
--> statement-breakpoint
CREATE TABLE neighborhoods (
	id uuid PRIMARY KEY,
	commune_id text NOT NULL REFERENCES communes (id),
	name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 80 AND name = btrim(name)),
	-- Point central facultatif : les deux coordonnées ensemble, ou aucune.
	lat double precision CHECK (lat BETWEEN -90 AND 90),
	lng double precision CHECK (lng BETWEEN -180 AND 180),
	osm_ref text CHECK (osm_ref ~ '^(node|way|relation)/[0-9]+$'),
	verified boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	created_by uuid REFERENCES users (id),
	updated_at timestamptz NOT NULL DEFAULT now(),
	updated_by uuid REFERENCES users (id),
	CHECK ((lat IS NULL) = (lng IS NULL)),
	-- Un point vérifié sur place existe forcément.
	CHECK (NOT verified OR lat IS NOT NULL),
	-- Les biens référencent (commune_id, id) : un bien ne peut pas mêler le quartier d'une commune et une autre commune.
	UNIQUE (commune_id, id)
);
--> statement-breakpoint
-- Un nom par commune, accents et casse confondus (« Somgandé » et « Somgande » sont le même quartier).
CREATE UNIQUE INDEX neighborhoods_unique_name ON neighborhoods (commune_id, geo_name_key(name));
--> statement-breakpoint

-- ---------------------------------------------------------------- droits
-- app_api lit ; app_admin (back-office) ajoute des quartiers et corrige points et vérification ; personne ne supprime.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON communes, neighborhoods FROM app_api;
--> statement-breakpoint
-- app_admin n'a que la lecture par défaut (0004) : droits d'écriture explicites, colonne par colonne.
GRANT INSERT (id, commune_id, name, lat, lng, osm_ref, verified, created_by, updated_by) ON neighborhoods TO app_admin;
--> statement-breakpoint
GRANT UPDATE (name, lat, lng, osm_ref, verified, updated_at, updated_by) ON neighborhoods TO app_admin;
--> statement-breakpoint
GRANT UPDATE (lat, lng, osm_ref, verified, updated_at, updated_by) ON communes TO app_admin;
--> statement-breakpoint
REVOKE ALL ON FUNCTION geo_name_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION geo_name_key(text) TO app_api, app_admin;
--> statement-breakpoint

-- ---------------------------------------------------------------- données initiales (D08 : Ouagadougou et Saaba)
INSERT INTO communes (id, name, lat, lng, osm_ref) VALUES
	('ouagadougou', 'Ouagadougou', 12.368187, -1.527094, 'node/27565002'),
	('saaba', 'Saaba', 12.376944, -1.420833, 'node/902867125');
--> statement-breakpoint
-- Ouagadougou : 39 quartiers (21 avec point, 18 sans), dans l'ordre de la liste du porteur ; Saaba : 27 villages.
INSERT INTO neighborhoods (id, commune_id, name, lat, lng, osm_ref) VALUES
	('01a1c6fa-54ad-7465-9101-b3d8373bb2a9', 'ouagadougou', '1200 Logements', 12.365882, -1.497268, 'way/153976450'),
	('01a1c6fa-54ae-71ca-8513-81f48ceefb6f', 'ouagadougou', 'Bendogo', NULL, NULL, NULL),
	('01a1c6fa-54ae-71ca-8513-8561bddd20f7', 'ouagadougou', 'Bilbalogho', 12.359982, -1.534424, 'node/1593087898'),
	('01a1c6fa-54ae-71ca-8513-8a470de2c944', 'ouagadougou', 'Boassa', 12.295151, -1.618371, 'node/5109140611'),
	('01a1c6fa-54ae-71ca-8513-8c716d448e77', 'ouagadougou', 'Cissin', NULL, NULL, NULL),
	('01a1c6fa-54ae-71ca-8513-92a3fe398f48', 'ouagadougou', 'Dagnoën', NULL, NULL, NULL),
	('01a1c6fa-54ae-71ca-8513-9613f9758555', 'ouagadougou', 'Dapoya', NULL, NULL, NULL),
	('01a1c6fa-54ae-71ca-8513-988475689cd9', 'ouagadougou', 'Dassasgho', NULL, NULL, NULL),
	('01a1c6fa-54ae-71ca-8513-9d6b4f0a8273', 'ouagadougou', 'Gounghin Nord', 12.361791, -1.550809, 'node/3793832332'),
	('01a1c6fa-54af-7223-a25d-45bb5bf183cd', 'ouagadougou', 'Gounghin Sud', 12.353235, -1.54548, 'node/3793832333'),
	('01a1c6fa-54af-7223-a25d-48622aae4205', 'ouagadougou', 'Hamdalaye', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-4d472ab2c875', 'ouagadougou', 'Kalgondé', 12.356231, -1.503364, 'node/3350189466'),
	('01a1c6fa-54af-7223-a25d-50e4720ed431', 'ouagadougou', 'Kamsonghin', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-5656a3aecce7', 'ouagadougou', 'Karpala', 12.33134, -1.484621, 'way/27863585'),
	('01a1c6fa-54af-7223-a25d-5bd47663bc31', 'ouagadougou', 'Karpalin', 12.29038, -1.475408, 'node/3448394447'),
	('01a1c6fa-54af-7223-a25d-5fcae98a9097', 'ouagadougou', 'Kossodo', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-6109bbc901ec', 'ouagadougou', 'Koulouba', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-67d6710cf4fa', 'ouagadougou', 'Kouritinga', 12.318511, -1.549521, 'node/5490677412'),
	('01a1c6fa-54af-7223-a25d-6bb13612d213', 'ouagadougou', 'Larlé', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-6f11968c78ba', 'ouagadougou', 'Nemnin', 12.381626, -1.530726, 'way/27895692'),
	('01a1c6fa-54af-7223-a25d-70604a4bae06', 'ouagadougou', 'Nonsin', 12.375942, -1.562687, 'way/27895577'),
	('01a1c6fa-54af-7223-a25d-7737242c4eb6', 'ouagadougou', 'Ouaga 2000', 12.306073, -1.502859, 'node/3448836389'),
	('01a1c6fa-54af-7223-a25d-78ae02600520', 'ouagadougou', 'Pagalayiri', 12.333399, -1.531094, 'node/3296496974'),
	('01a1c6fa-54af-7223-a25d-7fbe64c50218', 'ouagadougou', 'Paspanga', 12.379097, -1.520228, 'way/27895707'),
	('01a1c6fa-54af-7223-a25d-81a564b9ac7b', 'ouagadougou', 'Patte d''Oie', 12.327551, -1.515315, 'node/3445213338'),
	('01a1c6fa-54af-7223-a25d-85895b3b04fe', 'ouagadougou', 'Pissy', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-88ad5f2bb427', 'ouagadougou', 'Rimkiéta', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-8f5fc0dcef6a', 'ouagadougou', 'Samandin', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-91caafed29c7', 'ouagadougou', 'Silmissin', 12.344687, -1.502702, 'node/3233239040'),
	('01a1c6fa-54af-7223-a25d-94dc25521030', 'ouagadougou', 'Somgandé', 12.412142, -1.494332, 'node/5676552380'),
	('01a1c6fa-54af-7223-a25d-9b5e918a4352', 'ouagadougou', 'Tabtenga', 12.370574, -1.454679, 'node/903015666'),
	('01a1c6fa-54af-7223-a25d-9ca0f6ab7fb3', 'ouagadougou', 'Tampouy', 12.389868, -1.576925, 'node/3423523579'),
	('01a1c6fa-54af-7223-a25d-a2c549395a1d', 'ouagadougou', 'Tanghin', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-a7c63ef19137', 'ouagadougou', 'Wayalghin', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-a802773acd7f', 'ouagadougou', 'Wemtenga', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-ad1800ed4217', 'ouagadougou', 'Yagma', 12.41636, -1.628054, 'node/9587569259'),
	('01a1c6fa-54af-7223-a25d-b0fbc1b65cde', 'ouagadougou', 'Zékounga', 12.389787, -1.648786, 'node/12915364746'),
	('01a1c6fa-54af-7223-a25d-b57d0d9babb2', 'ouagadougou', 'Zogona', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-bb7e01e341ad', 'ouagadougou', 'Zone du Bois', NULL, NULL, NULL),
	('01a1c6fa-54af-7223-a25d-bd3d979119d6', 'saaba', 'Badnogo 1', 12.469211, -1.298698, 'node/3229707564'),
	('01a1c6fa-54af-7223-a25d-c36b274b2026', 'saaba', 'Badnogo 2', 12.270588, -1.370185, 'node/6211057665'),
	('01a1c6fa-54af-7223-a25d-c54535d3b0fd', 'saaba', 'Bagayiri', 12.477361, -1.272059, 'node/903015054'),
	('01a1c6fa-54af-7223-a25d-c87074047f87', 'saaba', 'Baossom', 12.486862, -1.299943, 'node/5806794096'),
	('01a1c6fa-54af-7223-a25d-cd00f3a24849', 'saaba', 'Barogo', 12.411855, -1.419994, 'node/5221168816'),
	('01a1c6fa-54af-7223-a25d-d2c65f547cc3', 'saaba', 'Boudtenga', 12.480095, -1.273545, 'node/4469884780'),
	('01a1c6fa-54af-7223-a25d-d62dd1b4b9cd', 'saaba', 'Boudtenga-Peulh', 12.487749, -1.263059, 'node/902962299'),
	('01a1c6fa-54af-7223-a25d-d9ebaadac5d3', 'saaba', 'Gampéla', 12.427635, -1.383234, 'node/902962332'),
	('01a1c6fa-54af-7223-a25d-dd74f19e702a', 'saaba', 'Goguen', 12.302179, -1.362605, 'node/6085506428'),
	('01a1c6fa-54af-7223-a25d-e23763479ad9', 'saaba', 'Gonsé', 12.461855, -1.312751, 'node/1893912606'),
	('01a1c6fa-54af-7223-a25d-e7cc5291c720', 'saaba', 'Komkaga', 12.422778, -1.27355, 'node/902962368'),
	('01a1c6fa-54af-7223-a25d-e9ebf83d8164', 'saaba', 'Kouada', 12.494157, -1.356726, 'node/5810672526'),
	('01a1c6fa-54af-7223-a25d-ee47e86ab81b', 'saaba', 'Kouidi', 12.459221, -1.322691, 'node/902962405'),
	('01a1c6fa-54af-7223-a25d-f3a8bd596c42', 'saaba', 'Le Massili', 12.440918, -1.357677, 'node/919530802'),
	('01a1c6fa-54af-7223-a25d-f71ab053b7b2', 'saaba', 'Manegsombo', 12.499866, -1.323498, 'node/5806794098'),
	('01a1c6fa-54af-7223-a25d-f9198e1a03d8', 'saaba', 'Mogden', 12.333076, -1.392784, 'node/4895241248'),
	('01a1c6fa-54af-7223-a25d-fe85d404119b', 'saaba', 'Nakomestenga-Peulh', 12.32815, -1.384436, 'node/5955180501'),
	('01a1c6fa-54af-7223-a25e-011317e6a0ab', 'saaba', 'Nong-Warbin', 12.451721, -1.432798, 'node/5831891633'),
	('01a1c6fa-54af-7223-a25e-073ab8d69307', 'saaba', 'Séloguen', 12.319469, -1.371628, 'node/5957615889'),
	('01a1c6fa-54af-7223-a25e-09e5b2625e9b', 'saaba', 'Tangséga', 12.309296, -1.397552, 'node/5958633790'),
	('01a1c6fa-54af-7223-a25e-0f2a390aa71b', 'saaba', 'Tanguen', 12.346322, -1.367637, 'node/5891434018'),
	('01a1c6fa-54af-7223-a25e-10c1cfed598e', 'saaba', 'Tanlarghin', 12.30103, -1.388805, 'node/902962513'),
	('01a1c6fa-54af-7223-a25e-177c8a4be992', 'saaba', 'Tanlarkouri', 12.30068, -1.397785, 'node/5965077694'),
	('01a1c6fa-54af-7223-a25e-1be195c31a78', 'saaba', 'Tanlarogo', 12.505009, -1.330872, 'node/5810359697'),
	('01a1c6fa-54af-7223-a25e-1feaada81475', 'saaba', 'Toéssen', 12.333813, -1.36651, 'node/5955180500'),
	('01a1c6fa-54af-7223-a25e-21c552f0087a', 'saaba', 'Wassoudi', 12.295319, -1.382075, 'node/6206681654'),
	('01a1c6fa-54af-7223-a25e-2430fe8ad10b', 'saaba', 'Zaken', 12.35763, -1.373245, 'node/5892631715');
--> statement-breakpoint

-- ---------------------------------------------------------------- synchronisation (docs/SYNC.md §3)
-- Tables sans RLS (non cloisonnées) : pas de politique sync_read ; le stream geography les envoie à tous.
GRANT SELECT ON communes, neighborhoods TO app_sync;
--> statement-breakpoint
ALTER PUBLICATION powersync ADD TABLE communes, neighborhoods;
