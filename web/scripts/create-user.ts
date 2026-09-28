import { randomBytes } from 'node:crypto';
import { password as bunPassword } from 'bun';
import postgres from 'postgres';

// Keep this lock in sync with the web registration transaction. The deployed
// image carries this CLI at /app/web/scripts, outside the web source tree.
const USER_CREATION_LOCK = 734512;
const rawLimit = process.env.MAX_USERS || '1';
const maxUsers = Number(rawLimit);
if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(maxUsers) || maxUsers < 1) {
	throw new Error('MAX_USERS must be a positive integer');
}

const args = process.argv.slice(2);
function option(name: string): string | undefined {
	const inline = args.find((arg) => arg.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

const username = option('--username')?.trim();
const suppliedPassword = option('--password');
const password = suppliedPassword ?? randomBytes(18).toString('base64url');
const databaseUrl = process.env.DATABASE_URL;

if (!username || username.length < 3 || username.length > 31) {
	throw new Error('--username must be between 3 and 31 characters');
}
if (password.length < 8 || password.length > 255) {
	throw new Error('password must be between 8 and 255 characters');
}
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const passwordHash = await bunPassword.hash(password, {
	algorithm: 'argon2id',
	memoryCost: 19_456,
	timeCost: 2
});
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });

try {
	const action = await sql.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(${USER_CREATION_LOCK}, 1)`;
		const [existing] = await tx`select id from "user" where username = ${username}`;
		if (existing) {
			await tx`
				update "user"
				set password_hash = ${passwordHash},
					last_login = null
				where id = ${existing.id}
			`;
			await tx`delete from "session" where user_id = ${existing.id}`;
			return 'reset';
		}
		const [count] = await tx`select count(*)::int as total from "user"`;
		if (Number(count.total) >= maxUsers) {
			throw new Error(`MAX_USERS (${maxUsers}) reached; raise it to create another account`);
		}
		await tx`
			insert into "user" (id, username, password_hash)
			values (${randomBytes(18).toString('base64url')}, ${username}, ${passwordHash})
		`;
		return 'created';
	});

	console.log(`User ${username} ${action}.`);
	if (!suppliedPassword) console.log(`Temporary password: ${password}`);
	console.log('All existing sessions for this user were revoked.');
} finally {
	await sql.end();
}
