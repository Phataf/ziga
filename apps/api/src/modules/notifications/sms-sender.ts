/**
 * Envoi de SMS derrière une interface (CLAUDE.md §4). Le vrai prestataire viendra plus tard (question ouverte) ;
 * en attendant, le développement et les tests utilisent des implémentations sans réseau.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SmsSender {
	send(to: string, text: string): Promise<void>;
}

export const SMS_SENDER = Symbol('SMS_SENDER');

/**
 * Développement : le SMS s'écrit sur la sortie standard, sur une ligne à part, hors des journaux pino de
 * l'application (qui ne contiennent jamais un code). Refusé en production par la configuration.
 */
export class ConsoleSmsSender implements SmsSender {
	async send(to: string, text: string): Promise<void> {
		process.stdout.write(`[SMS de développement] ${to} : ${text}\n`);
	}
}

/** Tests de bout en bout : chaque SMS est ajouté à un fichier (une ligne JSON), que Playwright relit. */
export class FileSmsSender implements SmsSender {
	constructor(private readonly path: string) {}

	async send(to: string, text: string): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await appendFile(this.path, `${JSON.stringify({ to, text, at: new Date().toISOString() })}\n`);
	}
}

/** Tests d'intégration : les SMS restent en mémoire. */
export class MemorySmsSender implements SmsSender {
	readonly messages: { to: string; text: string }[] = [];

	async send(to: string, text: string): Promise<void> {
		this.messages.push({ to, text });
	}

	/** Dernier code à 6 chiffres envoyé à un numéro. */
	lastCode(to: string): string | undefined {
		const message = [...this.messages].reverse().find((m) => m.to === to && /\b\d{6}\b/.test(m.text));
		return message?.text.match(/\b(\d{6})\b/)?.[1];
	}

	clear(): void {
		this.messages.length = 0;
	}
}
