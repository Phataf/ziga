import { assertKnownPath } from '#lib/route-guard.ts';

export const load = ({ url }: { url: URL }) => {
	assertKnownPath(url);
};
