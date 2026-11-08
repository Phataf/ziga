/** Création ou promotion du super administrateur (appelée par la ligne de commande seulement, jamais par l'API). */
import { newId } from '@ziga/shared/ids';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database.js';
import { users } from '../../db/schema/identity.js';
import { hashPassword } from './passwords.js';

export async function createSuperAdmin(
	db: Database,
	input: { phone: string; name: string; password: string }
): Promise<'created' | 'promoted'> {
	const now = new Date();
	const passwordHash = await hashPassword(input.password);
	const [existing] = await db.select().from(users).where(eq(users.phone, input.phone)).limit(1);
	if (existing) {
		await db
			.update(users)
			.set({
				platformRole: 'super_admin',
				status: 'active',
				phoneVerifiedAt: existing.phoneVerifiedAt ?? now,
				passwordHash,
				passwordChangedAt: now,
				updatedAt: now
			})
			.where(eq(users.id, existing.id));
		return 'promoted';
	}
	await db.insert(users).values({
		id: newId(),
		phone: input.phone,
		name: input.name,
		passwordHash,
		status: 'active',
		phoneVerifiedAt: now,
		platformRole: 'super_admin'
	});
	return 'created';
}
