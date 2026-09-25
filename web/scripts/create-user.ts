import { randomBytes } from 'node:crypto';
import { password as bunPassword } from 'bun';
import postgres from 'postgres';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
	const inline = args.find((arg) => arg.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

const username = option('--username')?.trim();
const emailOption = option('--email');
const email = emailOption?.trim() || null;
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
	const [existing] = await sql`select id, email from "user" where username = ${username}`;
	let action: 'created' | 'reset';
	if (existing) {
		await sql.begin(async (tx) => {
			await tx`
				update "user"
				set password_hash = ${passwordHash},
					email = ${emailOption === undefined ? existing.email : email},
					last_login = null
				where id = ${existing.id}
			`;
			await tx`delete from "session" where user_id = ${existing.id}`;
		});
		action = 'reset';
	} else {
		await sql`
			insert into "user" (id, username, email, password_hash)
			values (${randomBytes(18).toString('base64url')}, ${username}, ${email}, ${passwordHash})
		`;
		action = 'created';
	}

	console.log(`User ${username} ${action}.`);
	if (!suppliedPassword) console.log(`Temporary password: ${password}`);
	console.log('All existing sessions for this user were revoked.');
} finally {
	await sql.end();
}
