/**
 * Schéma Drizzle. Les tables métier (à partir du lot 03) portent `organization_id`, leur politique RLS
 * dans la même migration (CLAUDE.md §6) et un test d'accès croisé entre organisations (règle 1).
 */
export * from './identity.js';
export * from './organizations.js';
export * from './platform.js';
export * from './geography.js';
