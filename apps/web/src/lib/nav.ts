import { resolve } from '$app/paths';
import type { Path, ResolvedPathname } from '$app/types';

/**
 * resolve() pour un chemin déjà typé (`Path`), venu d'une entrée de menu. Au-delà de 25 routes, TypeScript ne sait
 * plus étaler l'union des chemins dans les surcharges de resolve() ; le chemin reste vérifié par son type, et le
 * résultat est un `ResolvedPathname`, reconnu comme tel par la règle svelte/no-navigation-without-resolve.
 */
export function resolvePath(path: Path): ResolvedPathname {
	return (resolve as (p: Path) => ResolvedPathname)(path);
}
