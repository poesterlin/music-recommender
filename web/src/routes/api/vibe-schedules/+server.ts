import {
	createSchedule,
	deleteSchedule,
	getActiveSchedule,
	listSchedules,
	updateSchedule
} from '$lib/server/vibe-store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const [schedules, active] = await Promise.all([listSchedules(), getActiveSchedule()]);
	return Response.json({ success: true, schedules, activeSchedule: active });
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as {
			name?: string;
			startHour?: number;
			endHour?: number;
			clusterIds?: number[];
			enabled?: boolean;
		};
		const row = await createSchedule({
			name: body.name ?? '',
			startHour: Number(body.startHour),
			endHour: Number(body.endHour),
			clusterIds: body.clusterIds ?? [],
			enabled: body.enabled
		});
		return Response.json({ success: true, schedule: row });
	} catch (error) {
		return Response.json({ success: false, error: String(error) }, { status: 400 });
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as {
			id?: number;
			name?: string;
			startHour?: number;
			endHour?: number;
			clusterIds?: number[];
			enabled?: boolean;
		};
		if (!Number.isInteger(body.id))
			return Response.json({ success: false, error: 'id is required' }, { status: 400 });
		const row = await updateSchedule(body.id as number, {
			name: body.name,
			startHour: body.startHour !== undefined ? Number(body.startHour) : undefined,
			endHour: body.endHour !== undefined ? Number(body.endHour) : undefined,
			clusterIds: body.clusterIds,
			enabled: body.enabled
		});
		if (!row) return Response.json({ success: false, error: 'Not found' }, { status: 404 });
		return Response.json({ success: true, schedule: row });
	} catch (error) {
		return Response.json({ success: false, error: String(error) }, { status: 400 });
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	const id = Number(url.searchParams.get('id'));
	if (!Number.isInteger(id))
		return Response.json({ success: false, error: 'id is required' }, { status: 400 });
	await deleteSchedule(id);
	return Response.json({ success: true });
};
