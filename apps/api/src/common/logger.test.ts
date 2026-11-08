import type { IncomingMessage, ServerResponse } from 'node:http';
import { isUuidV7 } from '@ziga/shared/ids';
import { describe, expect, it } from 'vitest';
import { requestId } from './logger.js';

function call(header?: string) {
	const headers: Record<string, string> = {};
	const res = { setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as ServerResponse;
	const id = requestId({ headers: header ? { 'x-request-id': header } : {} } as IncomingMessage, res);
	return { id, headers };
}

describe('identifiant de requête', () => {
	it('reprend un identifiant reçu s’il est sûr et le renvoie dans la réponse', () => {
		expect(call('appel-1234-abcd')).toEqual({ id: 'appel-1234-abcd', headers: { 'x-request-id': 'appel-1234-abcd' } });
	});
	it('en crée un (UUIDv7) sinon, y compris pour une valeur douteuse', () => {
		expect(isUuidV7(call().id)).toBe(true);
		expect(isUuidV7(call('<script>').id)).toBe(true);
	});
});
