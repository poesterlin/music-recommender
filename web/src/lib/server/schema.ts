import {
	index,
	uniqueIndex,
	vector,
	pgTable,
	text,
	timestamp,
	boolean,
	integer,
	serial,
	jsonb,
	real
} from 'drizzle-orm/pg-core';

const authCascade = { onDelete: 'cascade', onUpdate: 'cascade' } as const;

export const userTable = pgTable('user', {
	id: text('id').primaryKey(),
	email: text('email').unique(),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
	lastLogin: timestamp('last_login', { withTimezone: true, mode: 'date' }),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull()
});

export type User = typeof userTable.$inferSelect;

export const sessionTable = pgTable('session', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => userTable.id, authCascade),
	expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull()
});

export type Session = typeof sessionTable.$inferSelect;

export type ApiKeyScope = 'worker' | 'playback';

export const apiKeyTable = pgTable(
	'api_key',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => userTable.id, authCascade),
		name: text('name').notNull(),
		scope: text('scope').$type<ApiKeyScope>().notNull(),
		keyPrefix: text('key_prefix').notNull(),
		keyHash: text('key_hash').notNull().unique(),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
		expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
		revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' })
	},
	(table) => [index('apiKeyUserIdx').on(table.userId)]
);

export type ApiKey = typeof apiKeyTable.$inferSelect;

export const trackTable = pgTable(
	'track',
	{
		uri: text('uri').primaryKey(),
		name: text('name').notNull(),
		artist: text('artist').array().notNull(),
		album: text('album').notNull(),
		// Music Assistant imageproxy path (no host, no size query). Stored so
		// the UI can render cover art without a live MA round trip per tile.
		albumImage: text('album_image'),
		embedding: vector('embedding', { dimensions: 512 }),
		embeddingCentered: vector('embedding_centered', { dimensions: 512 }),
		embeddingSpaceVersion: integer('embedding_space_version'),
		createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
		updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow(),
		skip: boolean('skip').default(false),
		clusterId: integer('cluster_id').default(-1)
	},
	(table) => [
		index('embeddingIndex').using('hnsw', table.embedding.op('vector_cosine_ops')),
		index('embeddingCenteredIndex').using('hnsw', table.embeddingCentered.op('vector_cosine_ops'))
	]
);

export const skippedSongsTable = pgTable('skipped_songs', {
	uri: text('uri').primaryKey(),
	source: text('source').default('default')
});

export const likedSongsTable = pgTable('liked_songs', {
	uri: text('uri').primaryKey(),
	likedAt: timestamp('liked_at', { mode: 'string' }).defaultNow(),
	hour: integer('hour'), // Hour of the day (0-23)
	source: text('source') // e.g. "vibe", "manual", "debug"
});

export const skippedArtistsTable = pgTable('skipped_artists', {
	name: text('name').primaryKey()
});

// Versioned centering space for OpenL3 embeddings. Raw embeddings are kept
// unchanged; retrieval and clustering use the L2-normalized centered vector.
export const embeddingSpaceTable = pgTable('embedding_space', {
	version: integer('version').primaryKey(),
	model: text('model').notNull(),
	meanEmbedding: vector('mean_embedding', { dimensions: 512 }).notNull(),
	trackCount: integer('track_count').notNull(),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
});

// Frozen centroids for stable incremental clustering.
// Computed once from current assignments (see backfill), then only
// new tracks are assigned to the nearest centroid - existing
// cluster_ids never move, so names/schedules stay valid.
export const clusterCentroidTable = pgTable('cluster_centroid', {
	clusterId: integer('cluster_id').primaryKey(),
	embedding: vector('embedding', { dimensions: 512 }),
	embeddingSpaceVersion: integer('embedding_space_version').notNull().default(1),
	trackCount: integer('track_count').default(0),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

// Rust/CLI benchmark runs and their explicit apply audit. Assignment artifacts
// remain external until a confirmed apply records the live transition.
export const clusterRunTable = pgTable('cluster_run', {
	id: serial('id').primaryKey(),
	status: text('status').notNull().default('completed'),
	mode: text('mode').notNull().default('benchmark'),
	config: jsonb('config').notNull(),
	report: jsonb('report'),
	reportPath: text('report_path'),
	assignmentsPath: text('assignments_path'),
	trackCount: integer('track_count'),
	dimensions: integer('dimensions'),
	error: text('error'),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	completedAt: timestamp('completed_at', { mode: 'string' }),
	appliedAt: timestamp('applied_at', { mode: 'string' })
});

export const clusterRunAssignmentTable = pgTable(
	'cluster_run_assignment',
	{
		id: serial('id').primaryKey(),
		runId: integer('run_id').notNull(),
		uri: text('uri').notNull(),
		clusterId: integer('cluster_id').notNull(),
		previousClusterId: integer('previous_cluster_id'),
		createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
	},
	(table) => [uniqueIndex('cluster_run_assignment_run_uri_idx').on(table.runId, table.uri)]
);

export const clusterCentroidBackupTable = pgTable(
	'cluster_centroid_backup',
	{
		id: serial('id').primaryKey(),
		runId: integer('run_id').notNull(),
		clusterId: integer('cluster_id').notNull(),
		embedding: vector('embedding', { dimensions: 512 }),
		trackCount: integer('track_count'),
		embeddingSpaceVersion: integer('embedding_space_version'),
		createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
	},
	(table) => [
		uniqueIndex('cluster_centroid_backup_run_cluster_idx').on(table.runId, table.clusterId)
	]
);

export const clusterRunMatchTable = pgTable(
	'cluster_run_match',
	{
		id: serial('id').primaryKey(),
		runId: integer('run_id').notNull(),
		clusterId: integer('cluster_id').notNull(),
		legacyClusterId: integer('legacy_cluster_id').notNull(),
		legacyName: text('legacy_name').notNull(),
		displayName: text('display_name').notNull(),
		overlapCount: integer('overlap_count').notNull(),
		newClusterCount: integer('new_cluster_count').notNull(),
		legacyClusterCount: integer('legacy_cluster_count').notNull(),
		confidence: real('confidence').notNull(),
		relatedLegacyIds: integer('related_legacy_ids').array().notNull(),
		createdAt: timestamp('created_at', { mode: 'string' }).defaultNow()
	},
	(table) => [uniqueIndex('cluster_run_match_run_cluster_idx').on(table.runId, table.clusterId)]
);

// Singleton key-value store for persisted UI state (e.g. vibe picks)
export const vibeStateTable = pgTable('vibe_state', {
	key: text('key').primaryKey(),
	value: text('value').notNull(), // JSON-encoded
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});

// Run history for library jobs (index / sync-favorites / analyze) so results
// survive toasts and navigation — Manage shows the last run per job.
export const jobRunTable = pgTable('job_run', {
	id: serial('id').primaryKey(),
	job: text('job').notNull(),
	startedAt: timestamp('started_at', { mode: 'string' }).defaultNow(),
	finishedAt: timestamp('finished_at', { mode: 'string' }),
	ok: boolean('ok'),
	detail: text('detail')
});

// Hour-range schedules mapping time-of-day -> cluster picks.
// startHour inclusive, endHour exclusive, 0-24. Wraps overnight when startHour > endHour.
export const vibeScheduleTable = pgTable('vibe_schedule', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
	startHour: integer('start_hour').notNull(),
	endHour: integer('end_hour').notNull(),
	clusterIds: integer('cluster_ids').array().notNull(),
	enabled: boolean('enabled').default(true),
	createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
	updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow()
});
