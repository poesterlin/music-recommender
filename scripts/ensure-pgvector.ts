import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error('DATABASE_URL is not set');
}

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
try {
	await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
	console.log('pgvector extension is ready');
} finally {
	await sql.end();
}
