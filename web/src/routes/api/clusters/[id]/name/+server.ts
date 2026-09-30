import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { getActiveClusterMetadata } from '$lib/server/active-clusters';
import { clusterNameTable } from '$lib/server/schema';
import type { RequestHandler } from './$types';

const MAX_NAME_LENGTH = 120;

function readName(body: unknown): string | null | undefined {
	if (!body || typeof body !== 'object') return undefined;
	const value = (body as { name?: unknown }).name;
	if (value === null) return null;
	if (typeof value !== 'string') return undefined;
	const trimmed = value.replace(/\s+/g, ' ').trim();
	if (trimmed.length > MAX_NAME_LENGTH) {
		throw new RangeError(`name must be ${MAX_NAME_LENGTH} characters or fewer`);
	}
	return trimmed;
}

function parseClusterId(raw: string | undefined): number | null {
	const clusterId = Number(raw);
	return Number.isInteger(clusterId) && clusterId >= 0 ? clusterId : null;
}

export const GET: RequestHandler = async ({ params }) => {
	const clusterId = parseClusterId(params.id);
	if (clusterId === null) {
		return Response.json({ error: 'cluster id must be a non-negative integer' }, { status: 400 });
	}
	const metadata = await getActiveClusterMetadata();
	const runId = metadata.activeRun?.id ?? null;
	if (runId === null) {
		return Response.json({ error: 'no applied clustering run to name' }, { status: 409 });
	}
	if (!metadata.ids.includes(clusterId)) {
		return Response.json({ error: 'cluster is not part of the active run' }, { status: 404 });
	}
	const [row] = await db
		.select({ displayName: clusterNameTable.displayName })
		.from(clusterNameTable)
		.where(and(eq(clusterNameTable.runId, runId), eq(clusterNameTable.clusterId, clusterId)))
		.limit(1);
	return Response.json({ name: row?.displayName ?? '', runId });
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const clusterId = parseClusterId(params.id);
	if (clusterId === null) {
		return Response.json({ error: 'cluster id must be a non-negative integer' }, { status: 400 });
	}

	let name: string | null;
	try {
		const parsed = readName(await request.json());
		if (parsed === undefined) {
			return Response.json({ error: 'name must be a string or null' }, { status: 400 });
		}
		name = parsed;
	} catch (error) {
		if (error instanceof RangeError) {
			return Response.json({ error: error.message }, { status: 400 });
		}
		return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
	}

	try {
		const metadata = await getActiveClusterMetadata();
		const runId = metadata.activeRun?.id ?? null;
		if (runId === null) {
			return Response.json({ error: 'no applied clustering run to name' }, { status: 409 });
		}

		if (!metadata.ids.includes(clusterId)) {
			return Response.json({ error: 'cluster is not part of the active run' }, { status: 404 });
		}
		await db
			.insert(clusterNameTable)
			.values({ runId, clusterId, displayName: name ?? '', source: 'manual' })
			.onConflictDoUpdate({
				target: [clusterNameTable.runId, clusterNameTable.clusterId],
				set: { displayName: name ?? '', source: 'manual' }
			});
		return Response.json({ ok: true, name, runId });
	} catch (error) {
		console.error('Cluster rename failed:', error);
		return Response.json({ error: String(error) }, { status: 500 });
	}
};
