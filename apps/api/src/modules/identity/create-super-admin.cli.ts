/**
 * Création du premier super administrateur, en ligne de commande seulement (jamais par l'interface) :
 *   pnpm --filter @ziga/api admin:create-super-admin --phone "+226 70 12 34 56" --name "Nom"
 * Le mot de passe est demandé deux fois, sans écho dans un vrai terminal (PowerShell, cmd, Linux, macOS).
 * Dans Git Bash sous Windows (mintty), Node ne voit pas de terminal : la saisie reste visible, faute de mieux.
 * Pour un script : variable SUPER_ADMIN_PASSWORD. Une personne déjà inscrite est promue super administrateur.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { passwordSchema, personNameSchema } from '@ziga/shared/auth';
import { phoneSchema } from '@ziga/shared/phone';
import { createDatabase, createPool } from '../../db/database.js';
import { createSuperAdmin } from './super-admin.js';

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

/** Saisie masquée caractère par caractère (mode brut) : fonctionne aussi dans PowerShell et cmd. */
function askHidden(question: string): Promise<string> {
	const stdin = process.stdin;
	process.stdout.write(question);
	return new Promise((resolve) => {
		let value = '';
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n' || char === '\u0004') {
					stdin.setRawMode(false);
					stdin.pause();
					stdin.off('data', onData);
					process.stdout.write('\n');
					resolve(value);
					return;
				}
				if (char === '\u0003') {
					stdin.setRawMode(false);
					process.stdout.write('\n');
					process.exit(130);
				}
				if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
				else if (char >= ' ') value += char;
			}
		};
		stdin.on('data', onData);
	});
}

/** Lignes lues sur l'entrée standard quand ce n'est pas un terminal (Git Bash, redirection). */
const lines = (() => {
	let reader: AsyncIterator<string> | undefined;
	return async (question: string): Promise<string> => {
		process.stdout.write(question);
		reader ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
		const next = await reader.next();
		return next.done ? '' : next.value;
	};
})();

async function askPassword(): Promise<string> {
	const fromEnv = process.env.SUPER_ADMIN_PASSWORD;
	if (fromEnv !== undefined) {
		const parsed = passwordSchema.safeParse(fromEnv);
		if (!parsed.success) fail(`SUPER_ADMIN_PASSWORD : ${parsed.error.issues[0]?.message}`);
		return parsed.data;
	}
	const tty = !!process.stdin.isTTY;
	if (!tty) {
		process.stdout.write(
			'Ce terminal ne permet pas de masquer la saisie (Git Bash sous Windows) : le mot de passe restera visible.\n' +
				'Pour le masquer, lancez la commande depuis PowerShell, ou passez-le dans SUPER_ADMIN_PASSWORD.\n'
		);
	}
	const ask = tty ? askHidden : lines;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const first = await ask('Mot de passe (8 caractères au moins) : ');
		const parsed = passwordSchema.safeParse(first);
		if (!parsed.success) {
			process.stdout.write(`${parsed.error.issues[0]?.message}\n`);
			continue;
		}
		const second = await ask('Confirmez le mot de passe : ');
		if (second !== first) {
			process.stdout.write('Les deux saisies sont différentes.\n');
			continue;
		}
		return parsed.data;
	}
	fail('Mot de passe non saisi : rien n’a été créé. Il peut aussi être passé dans la variable SUPER_ADMIN_PASSWORD.');
}

const { values } = parseArgs({
	// Un « -- » transmis par pnpm (habitude de npm) est ignoré.
	args: process.argv.slice(2).filter((arg) => arg !== '--'),
	options: { phone: { type: 'string' }, name: { type: 'string' } }
});
const phone = phoneSchema.safeParse(values.phone ?? '');
if (!phone.success) fail('Numéro manquant ou invalide : --phone "+226 70 12 34 56".');
const name = personNameSchema.safeParse(values.name ?? '');
if (!name.success) fail('Nom manquant : --name "Nom Prénom".');
const url = process.env.DATABASE_URL;
if (!url) fail('DATABASE_URL manquante (copiez .env.example en .env).');
const password = await askPassword();

const pool = createPool({ url, max: 1, connectionTimeoutMs: 5_000, applicationName: 'ziga-cli' });
try {
	const result = await createSuperAdmin(createDatabase(pool), { phone: phone.data, name: name.data, password });
	process.stdout.write(
		result === 'created'
			? `Super administrateur créé : ${name.data} (${phone.data}).\n`
			: `${phone.data} est maintenant super administrateur.\n`
	);
} finally {
	await pool.end();
}
