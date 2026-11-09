/**
 * Service PowerSync des tests de bout en bout (lot 05) : la configuration du dépôt (infra/powersync), branchée sur la
 * base `ziga_e2e` (rôle app_sync), un stockage `ziga_e2e_powersync` recréé par e2e-server.mjs, et le JWKS de l'API de
 * test. Lancé par apps/web/playwright.config.ts ; attend que l'API soit prête (base migrée, clés publiées).
 *
 * Deux façons de lancer le service :
 *   - par défaut, l'image Docker (CI, et développement avec Docker) ;
 *   - E2E_POWERSYNC_NODE (Node 24 au moins) et E2E_POWERSYNC_ENTRY (lib/entry.js du paquet @powersync/service-image) :
 *     sans Docker, depuis le paquet npm installé hors du dépôt.
 * Jamais en production.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dirname, '../../..');
const file = join(root, '.env');
const base = { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...process.env };
for (const key of ['DATABASE_SYNC_URL', 'POWERSYNC_STORAGE_URL']) {
	if (!base[key]) throw new Error(`Tests de bout en bout : ${key} manquante.`);
}

const IMAGE = 'journeyapps/powersync-service:1.28.1';
const apiPort = base.E2E_API_PORT || '3100';
const port = base.E2E_POWERSYNC_PORT || '8180';
const name = 'ziga_e2e';
const withDatabase = (url, database) => {
	const u = new URL(url);
	u.pathname = `/${database}`;
	return u;
};

// L'API de test crée la base, la migre (rôle app_sync, publication) et publie ses clés : on l'attend.
const deadline = Date.now() + 170_000;
for (;;) {
	try {
		if ((await fetch(`http://localhost:${apiPort}/health/ready`)).ok) break;
	} catch {
		// pas encore démarrée
	}
	if (Date.now() > deadline) throw new Error('PowerSync : l’API de test ne répond pas.');
	await new Promise((r) => setTimeout(r, 500));
}

const docker = !base.E2E_POWERSYNC_NODE;
// Dans Docker hors Linux, la machine hôte s'appelle host.docker.internal ; sous Linux, le réseau de l'hôte est partagé.
const host = docker && process.platform !== 'linux' ? 'host.docker.internal' : 'localhost';
const source = withDatabase(base.DATABASE_SYNC_URL, name);
const storage = withDatabase(base.POWERSYNC_STORAGE_URL, `${name}_powersync`);
source.hostname = host;
storage.hostname = host;
const env = {
	PS_SOURCE_URI: source.toString(),
	PS_STORAGE_URI: storage.toString(),
	PS_SSLMODE: 'disable',
	PS_JWKS_URI: `http://${host}:${apiPort}/.well-known/jwks.json`,
	PS_PORT: port
};

const config = join(root, 'infra/powersync');
const child = docker
	? spawn(
			'docker',
			[
				'run',
				'--rm',
				'--init',
				...(process.platform === 'linux'
					? ['--network', 'host']
					: ['-p', `${port}:${port}`, '--add-host', 'host.docker.internal:host-gateway']),
				'-v',
				`${config}:/config:ro`,
				...Object.entries({ ...env, POWERSYNC_CONFIG_PATH: '/config/service.yaml' }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
				IMAGE,
				'start',
				'-r',
				'unified'
			],
			{ stdio: 'inherit' }
		)
	: spawn(base.E2E_POWERSYNC_NODE, [base.E2E_POWERSYNC_ENTRY, 'start', '-r', 'unified', '-c', join(config, 'service.yaml')], {
			// Dossier de travail hors du dépôt : le service y écrit ses sondes de santé (.probes).
			cwd: join(base.E2E_SMS_FILE ? resolve(base.E2E_SMS_FILE, '..') : root),
			env: { ...process.env, ...env },
			stdio: 'inherit'
		});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
