/**
 * Création du premier super administrateur, en ligne de commande seulement (jamais par l'interface) :
 *   pnpm --filter @ziga/api admin:create-super-admin -- --phone "+226 70 12 34 56" --name "Nom"
 * Le mot de passe est demandé sans écho (ou lu dans SUPER_ADMIN_PASSWORD pour un script). Une personne déjà inscrite
 * est promue super administrateur.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { passwordSchema, personNameSchema } from '@ziga/shared/auth';
import { phoneSchema } from '@ziga/shared/phone';
import { createDatabase, createPool } from '../../db/database.js';
import { createSuperAdmin } from './super-admin.js';

async function askHidden(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
	let prompted = false;
	(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
		if (!prompted) {
			write(s);
			prompted = true;
		}
	};
	return new Promise((resolve) =>
		rl.question(question, (answer) => {
			rl.close();
			process.stdout.write('\n');
			resolve(answer);
		})
	);
}

const { values } = parseArgs({ options: { phone: { type: 'string' }, name: { type: 'string' } } });
const phone = phoneSchema.parse(values.phone ?? '');
const name = personNameSchema.parse(values.name ?? '');
const password = passwordSchema.parse(process.env.SUPER_ADMIN_PASSWORD ?? (await askHidden('Mot de passe (8 caractères au moins) : ')));
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL manquante');

const pool = createPool({ url, max: 1, connectionTimeoutMs: 5_000, applicationName: 'ziga-cli' });
const result = await createSuperAdmin(createDatabase(pool), { phone, name, password });
process.stdout.write(
	result === 'created' ? `Super administrateur créé : ${name} (${phone}).\n` : `${phone} est maintenant super administrateur.\n`
);
await pool.end();
