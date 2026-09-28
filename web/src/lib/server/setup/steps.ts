import { sql } from 'drizzle-orm';
import { db } from '../db';
import { trackTable } from '../schema';
import { deriveClusterCount, type KDerivation } from './derive-k';
import { createGeneration, inspectGeneration } from './generation';
import { runFullClustering } from '../clustering';
import { applyAutoNames, suggestClusterNames } from '../cluster-naming';
import { triggerLibrarySync } from '../ma-sync';
import { indexLibrary } from '../index-library';
import type { StepId } from './state';

export type StepOutcome = {
	/**
	 * `pending` means "runnable but not run yet" and is only ever returned by a
	 * probe, never by a runner. `waiting` means blocked on something outside the
	 * web process, so the runner should pause rather than fail.
	 */
	status: 'pending' | 'done' | 'failed' | 'skipped' | 'waiting';
	detail: string;
	/** Attached to state so later steps and the UI can use the result. */
	k?: KDerivation;
};

export type SetupStep = {
	id: StepId;
	title: string;
	/** What this step is for, in the user's terms. */
	blurb: string;
	/** Read-only. Safe to call on every page load. */
	probe(): Promise<StepOutcome>;
	/** Does the work. Only called from the runner. */
	run(): Promise<StepOutcome>;
};

/**
 * Embeddings needed before clustering is worth attempting. Below this the
 * derived k would be noise, and a first pass at a brand-new library legitimately
 * has almost none because the worker is still on its first tracks.
 */
const MIN_EMBEDDINGS_TO_CLUSTER = 200;

export type Counts = {
	total: number;
	eligible: number;
	embedded: number;
	clusterable: number;
	clusters: number;
	covered: number;
};

export async function counts(): Promise<Counts> {
	const [row] = await db
		.select({
			total: sql<number>`count(*)::int`,
			eligible: sql<number>`count(*) FILTER (WHERE COALESCE(skip, FALSE) = FALSE)::int`,
			// Embedded and not pruned: exactly the rows full clustering reads.
			clusterable: sql<number>`count(embedding_centered) FILTER (WHERE COALESCE(skip, FALSE) = FALSE)::int`,
			covered: sql<number>`count(*) FILTER (WHERE album_image IS NOT NULL)::int`,
			clusters: sql<number>`count(DISTINCT cluster_id) FILTER (WHERE cluster_id >= 0)::int`
		})
		.from(trackTable);
	return {
		total: row?.total ?? 0,
		eligible: row?.eligible ?? 0,
		// clusterable is already the embedded-and-not-skipped count.
		embedded: row?.clusterable ?? 0,
		clusterable: row?.clusterable ?? 0,
		clusters: row?.clusters ?? 0,
		covered: row?.covered ?? 0
	};
}

const environment: SetupStep = {
	id: 'environment',
	title: 'Check the environment',
	blurb: 'Confirms the database is reachable and pgvector is installed.',
	async probe() {
		if (!process.env.DATABASE_URL?.trim()) {
			return {
				status: 'failed',
				detail: 'DATABASE_URL is not set, so there is nowhere to store your library.'
			};
		}
		let pgvectorVersion: string | null = null;
		try {
			const rows = (await db.execute(sql`
				SELECT extversion FROM pg_extension WHERE extname = 'vector'
			`)) as unknown as Array<{ extversion: string }>;
			pgvectorVersion = rows[0]?.extversion ?? null;
			if (!pgvectorVersion) {
				return {
					status: 'failed',
					detail: 'The vector extension is missing. Setup will install it automatically.'
				};
			}
		} catch (error) {
			return {
				status: 'failed',
				detail: `Could not reach the database: ${String(error).slice(0, 120)}`
			};
		}

		const notes: string[] = [`pgvector ${pgvectorVersion}`];
		if (!process.env.MA_TOKEN?.trim()) notes.push('MA_TOKEN not set');
		return { status: 'done', detail: notes.join(' · ') };
	},
	async run() {
		const probed = await environment.probe();
		if (probed.status !== 'failed' || !probed.detail.startsWith('The vector extension')) {
			return probed;
		}
		// The app's database role can usually install the extension itself, so try
		// that before telling an operator to open a terminal. It is idempotent, and
		// a role without the privilege gets a message saying so rather than a raw
		// permission error.
		try {
			await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
		} catch (error) {
			return {
				status: 'failed',
				detail:
					'The vector extension is missing and this database role cannot install it. ' +
					`Ask whoever runs the database to run: bun run db:ensure-pgvector (${String(error).slice(0, 80)})`
			};
		}
		return environment.probe();
	}
};

const library: SetupStep = {
	id: 'library',
	title: 'Connect to Music Assistant',
	blurb: 'Asks Music Assistant to refresh its providers so new downloads show up.',
	async probe() {
		if (!process.env.MA_TOKEN?.trim()) {
			return {
				status: 'failed',
				detail: 'MA_TOKEN is not set, so there is no way to read your library.'
			};
		}
		const c = await counts();
		return {
			status: 'done',
			detail: c.total
				? `${c.total.toLocaleString()} tracks known`
				: 'Connected, but no tracks indexed yet'
		};
	},
	async run() {
		if (!process.env.MA_TOKEN?.trim()) {
			return { status: 'failed', detail: 'MA_TOKEN is not set.' };
		}
		try {
			const result = await triggerLibrarySync();
			return {
				status: 'done',
				detail:
					typeof result === 'object' && result !== null && 'skipped' in result
						? 'Sync skipped'
						: 'Asked Music Assistant to refresh its providers'
			};
		} catch (error) {
			return { status: 'failed', detail: `Sync failed: ${String(error).slice(0, 140)}` };
		}
	}
};

const index: SetupStep = {
	id: 'index',
	title: 'Index the library',
	blurb: 'Pulls track titles, artists, albums and cover art from Music Assistant.',
	async probe() {
		const c = await counts();
		if (c.total === 0) return { status: 'waiting', detail: 'No tracks indexed yet' };
		return { status: 'done', detail: `${c.total.toLocaleString()} tracks indexed` };
	},
	async run() {
		try {
			const result = await indexLibrary();
			const parts = [`${result.added.toLocaleString()} new`];
			if (result.failed) parts.push(`${result.failed} failed`);
			return { status: 'done', detail: parts.join(' · ') };
		} catch (error) {
			return { status: 'failed', detail: `Indexing failed: ${String(error).slice(0, 140)}` };
		}
	}
};

const embed: SetupStep = {
	id: 'embed',
	title: 'Wait for audio analysis',
	blurb:
		'The embedding worker turns 60 seconds of each track into a vector. This is the slow part.',
	async probe() {
		const c = await counts();
		if (c.total === 0) return { status: 'waiting', detail: 'Nothing to analyse yet' };
		if (c.eligible === 0) return { status: 'waiting', detail: 'No tracks are eligible for analysis' };
		if (c.embedded === 0) {
			return {
				status: 'waiting',
				detail: `0 of ${c.eligible.toLocaleString()} eligible tracks analysed — the worker picks these up automatically`
			};
		}
		if (c.embedded < MIN_EMBEDDINGS_TO_CLUSTER && c.embedded < c.eligible) {
			return {
				status: 'waiting',
				detail: `${c.embedded.toLocaleString()} of ${c.eligible.toLocaleString()} eligible tracks analysed — waiting for at least ${MIN_EMBEDDINGS_TO_CLUSTER}, or all eligible tracks`
			};
		}
		const pending = c.eligible - c.embedded;
		return {
			status: 'done',
			detail: pending
				? `${c.embedded.toLocaleString()} analysed · ${pending.toLocaleString()} still going, they will be sorted in later`
				: `${c.embedded.toLocaleString()} tracks analysed`
		};
	},
	async run() {
		// Embedding belongs to the worker container, not the web process. This
		// step only reports; the runner pauses here and resumes on a later poll.
		return embed.probe();
	}
};

const cluster: SetupStep = {
	id: 'cluster',
	title: 'Group tracks into vibes',
	blurb:
		'Sorts every analysed track into a cluster, sized so each one has enough tracks to name and play from.',
	async probe() {
		const generation = await inspectGeneration();
		if (generation.exists) {
			return {
				status: 'done',
				detail: `Already grouped into ${generation.k ?? '?'} vibes — left untouched`
			};
		}
		const c = await counts();
		if (c.clusterable === 0) return { status: 'waiting', detail: 'No analysed tracks to group' };
		const d = deriveClusterCount(c.clusterable);
		return { status: 'pending', detail: d.explanation, k: d };
	},
	async run() {
		const generation = await inspectGeneration();
		if (generation.exists) {
			// Renumbering now would strand every stored name on the wrong
			// cluster. Setup is a first-run tool; re-clustering is a deliberate
			// operation that belongs to the clustering flow.
			return {
				status: 'skipped',
				detail: `A generation of ${generation.k ?? '?'} vibes already exists (run #${generation.runId}). Re-grouping renumbers every cluster, so it is left to Manage.`
			};
		}

		const c = await counts();
		if (c.clusterable === 0) {
			return { status: 'waiting', detail: 'No analysed tracks to group yet' };
		}
		const d = deriveClusterCount(c.clusterable);
		if (d.k === 0) return { status: 'waiting', detail: d.explanation };

		const result = await runFullClustering(d.k);
		if (result.tracks === 0) {
			return { status: 'failed', detail: 'Clustering produced no assignments.' };
		}
		await createGeneration(result.k, result.tracks, d);

		const sizeNote = `smallest ${result.smallest}, largest ${result.largest}`;
		return {
			status: 'done',
			detail: `${result.tracks.toLocaleString()} tracks into ${result.k} vibes · ${sizeNote}`,
			k: { ...d, k: result.k, meanPerCluster: Math.round(result.tracks / result.k) }
		};
	}
};

const name: SetupStep = {
	id: 'name',
	title: 'Name the vibes',
	blurb: 'Labels each cluster after the artists that dominate it. Every name stays editable.',
	async probe() {
		const generation = await inspectGeneration();
		if (!generation.exists) return { status: 'pending', detail: 'No clusters yet' };
		if (generation.named === 0) {
			return { status: 'pending', detail: `${generation.k ?? '?'} clusters are unnamed` };
		}
		// Partly named is still runnable: the runner fills only the gaps.
		if (generation.named < (generation.k ?? 0)) {
			return {
				status: 'pending',
				detail: `${generation.named} of ${generation.k} named — the rest can be filled in`
			};
		}
		return {
			status: 'done',
			detail: `${generation.named} of ${generation.k ?? '?'} named`
		};
	},
	async run() {
		const generation = await inspectGeneration();
		if (!generation.exists) return { status: 'skipped', detail: 'No clusters to name' };
		if (generation.named === generation.k) {
			return {
				status: 'done',
				detail: `All ${generation.named} vibes already have names`
			};
		}

		// Only fill the gaps. applyAutoNames overwrites display_name for every id
		// it is given, so handing it the full set would replace names a person
		// chose or edited with machine-derived ones.
		const suggestions = await suggestClusterNames();
		const unnamed = suggestions.filter((s) => !s.named).map((s) => s.clusterId);
		if (unnamed.length === 0) {
			return { status: 'done', detail: `All ${generation.named} vibes already have names` };
		}

		const applied = await applyAutoNames(unnamed);
		return {
			status: 'done',
			detail:
				applied > 0
					? `Named ${applied} of ${generation.k} vibes from their top artists, left ${generation.named} you had already named`
					: 'Clusters already carry names'
		};
	}
};

const covers: SetupStep = {
	id: 'covers',
	title: 'Check cover art',
	blurb: 'Counts how many tracks have artwork. This is a report, not a fetch.',
	async probe() {
		const c = await counts();
		if (c.total === 0) return { status: 'pending', detail: 'No tracks yet' };
		if (c.covered === 0) {
			return {
				status: 'skipped',
				detail:
					'No cover art stored. Music Assistant only returns it on a fresh index, so existing tracks need a re-index from Manage.'
			};
		}
		const pct = Math.round((c.covered / c.total) * 100);
		return {
			status: 'done',
			detail: `${c.covered.toLocaleString()} of ${c.total.toLocaleString()} tracks (${pct}%) have artwork`
		};
	},
	async run() {
		return covers.probe();
	}
};

export const STEPS: readonly SetupStep[] = [
	environment,
	library,
	index,
	embed,
	cluster,
	name,
	covers
] as const;

export function stepById(id: StepId): SetupStep | undefined {
	return STEPS.find((step) => step.id === id);
}
