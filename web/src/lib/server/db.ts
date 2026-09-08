import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

type Db = ReturnType<typeof drizzle>;

let instance: Db | null = null;

function getDb(): Db {
	if (!instance) {
		if (!process.env.DATABASE_URL) {
			throw new Error('DATABASE_URL is not set');
		}
		instance = drizzle({ client: postgres(process.env.DATABASE_URL), logger: false });
	}
	return instance;
}

// Lazily created on first query so importing server modules (e.g. during
// SvelteKit build/route analysis) never requires DATABASE_URL to be set.
export const db: Db = new Proxy({} as Db, {
	get: (_target, prop) => (getDb() as unknown as Record<PropertyKey, unknown>)[prop]
});
