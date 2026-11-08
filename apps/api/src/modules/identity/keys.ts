/**
 * Clés de signature des jetons d'accès (Ed25519, algorithme EdDSA), avec un identifiant de clé (`kid`) :
 * la première clé signe, toutes vérifient, et toutes sont publiées en JWKS. Pour changer de clé, on ajoute
 * la nouvelle en tête, puis on retire l'ancienne quand ses jetons ont expiré (15 minutes).
 * En développement et en test, sans AUTH_JWT_KEYS, une clé éphémère est créée au démarrage.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { exportJWK, type JWK } from 'jose';

export interface SigningKey {
	kid: string;
	privateKey: KeyObject;
	publicKey: KeyObject;
}

export class KeyRing {
	constructor(readonly keys: SigningKey[]) {
		if (!keys.length) throw new Error('Aucune clé de signature.');
	}

	get current(): SigningKey {
		return this.keys[0]!;
	}

	find(kid: string | undefined): SigningKey | undefined {
		return this.keys.find((k) => k.kid === kid);
	}

	async jwks(): Promise<{ keys: JWK[] }> {
		return {
			keys: await Promise.all(this.keys.map(async (k) => ({ ...(await exportJWK(k.publicKey)), kid: k.kid, alg: 'EdDSA', use: 'sig' })))
		};
	}
}

/** « kid1:base64,kid2:base64 » (PKCS#8 DER en base64) → trousseau. */
export function parseKeys(value: string): KeyRing {
	const keys = value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [kid, der] = entry.split(':');
			if (!kid || !der || !/^[A-Za-z0-9._-]{1,64}$/.test(kid)) throw new Error('AUTH_JWT_KEYS : entrée « kid:clé » invalide.');
			const privateKey = createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' });
			if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`AUTH_JWT_KEYS : la clé ${kid} n'est pas Ed25519.`);
			return { kid, privateKey, publicKey: createPublicKey(privateKey) };
		});
	return new KeyRing(keys);
}

export function generateKey(kid: string): { ring: KeyRing; env: string } {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
	return { ring: new KeyRing([{ kid, privateKey, publicKey }]), env: `${kid}:${der}` };
}
