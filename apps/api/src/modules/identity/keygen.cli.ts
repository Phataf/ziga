/** `pnpm --filter @ziga/api auth:keygen` : génère une clé Ed25519 à placer dans AUTH_JWT_KEYS (jamais dans le code). */
import { randomBytes } from 'node:crypto';
import { generateKey } from './keys.js';

const kid = `ziga-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
process.stdout.write(`AUTH_JWT_KEYS=${generateKey(kid).env}\nAUTH_OTP_SECRET=${randomBytes(32).toString('base64url')}\n`);
