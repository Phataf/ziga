/**
 * Outils de schéma internes à packages/shared.
 *
 * Zod 4 garde les valeurs par défaut sous `.partial()` : une modification qui n'envoie que le nom remettrait le pays,
 * les équipements ou les pièces à leur valeur par défaut. Une forme « modification » se construit donc ici : chaque
 * champ facultatif, sans sa valeur par défaut.
 */
import { z } from 'zod';

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;

export type PatchShape<T extends z.ZodRawShape> = { [K in keyof T]: z.ZodOptional<WithoutDefault<T[K]>> };

export function patchShape<T extends z.ZodRawShape>(shape: T): PatchShape<T> {
	return Object.fromEntries(
		Object.entries(shape).map(([key, field]) => [key, z.optional(field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field)])
	) as PatchShape<T>;
}
