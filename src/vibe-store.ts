import { eq } from "drizzle-orm";
import { db } from "./db";
import { vibeScheduleTable, vibeStateTable } from "./schema";

export const DEFAULT_VIBE_CLUSTERS = [2, 4, 31, 38, 42, 3, 37, 41, 30, 46, 47];
const VIBE_IDS_KEY = "vibe_cluster_ids";

export type VibeSchedule = {
  id: number;
  name: string;
  startHour: number;
  endHour: number;
  clusterIds: number[];
  enabled: boolean | null;
};

function sanitizeIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  return ids.map(Number).filter((n) => Number.isInteger(n) && n >= -1 && n <= 999);
}

function sanitizeHour(h: unknown): number | null {
  const n = Number(h);
  if (!Number.isInteger(n) || n < 0 || n > 24) return null;
  return n;
}

export async function getVibeClusterIds(): Promise<number[]> {
  try {
    const [row] = await db.select().from(vibeStateTable).where(eq(vibeStateTable.key, VIBE_IDS_KEY));
    if (row) {
      const ids = sanitizeIds(JSON.parse(row.value));
      if (ids.length) return ids;
    }
  } catch (e) {
    console.warn("[vibe] read state failed, using default:", String(e));
  }
  return [...DEFAULT_VIBE_CLUSTERS];
}

export async function setVibeClusterIds(ids: number[]): Promise<number[]> {
  const clean = sanitizeIds(ids);
  if (!clean.length) throw new Error("clusterIds must be a non-empty array");
  const value = JSON.stringify([...new Set(clean)].sort((a, b) => a - b));
  try {
    await db
      .insert(vibeStateTable)
      .values({ key: VIBE_IDS_KEY, value })
      .onConflictDoUpdate({ target: vibeStateTable.key, set: { value } });
  } catch (e) {
    console.warn("[vibe] persist state failed:", String(e));
  }
  return JSON.parse(value);
}

export async function listSchedules(): Promise<VibeSchedule[]> {
  try {
    return await db.select().from(vibeScheduleTable);
  } catch {
    return [];
  }
}

export function hourMatches(s: { startHour: number; endHour: number }, hour: number): boolean {
  const { startHour: a, endHour: b } = s;
  if (a === b) return true; // covers whole day
  if (a < b) return hour >= a && hour < b;
  return hour >= a || hour < b; // overnight wrap, e.g. 22-6
}

export async function getActiveSchedule(now = new Date()): Promise<VibeSchedule | null> {
  const schedules = await listSchedules();
  const hour = now.getHours();
  return schedules.find((s) => s.enabled !== false && hourMatches(s, hour)) ?? null;
}

export async function createSchedule(input: {
  name: string;
  startHour: number;
  endHour: number;
  clusterIds: number[];
  enabled?: boolean;
}): Promise<VibeSchedule> {
  const name = input.name?.trim();
  if (!name) throw new Error("name is required");
  const startHour = sanitizeHour(input.startHour);
  const endHour = sanitizeHour(input.endHour);
  if (startHour === null || endHour === null) throw new Error("startHour/endHour must be 0-24");
  const clusterIds = sanitizeIds(input.clusterIds);
  if (!clusterIds.length) throw new Error("clusterIds must be non-empty");
  const [row] = await db
    .insert(vibeScheduleTable)
    .values({ name, startHour, endHour, clusterIds, enabled: input.enabled ?? true })
    .returning();
  return row;
}

export async function updateSchedule(
  id: number,
  input: Partial<{ name: string; startHour: number; endHour: number; clusterIds: number[]; enabled: boolean }>,
): Promise<VibeSchedule | null> {
  const patch: Partial<typeof vibeScheduleTable.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("name must be non-empty");
    patch.name = name;
  }
  if (input.startHour !== undefined) {
    const h = sanitizeHour(input.startHour);
    if (h === null) throw new Error("startHour must be 0-24");
    patch.startHour = h;
  }
  if (input.endHour !== undefined) {
    const h = sanitizeHour(input.endHour);
    if (h === null) throw new Error("endHour must be 0-24");
    patch.endHour = h;
  }
  if (input.clusterIds !== undefined) {
    const ids = sanitizeIds(input.clusterIds);
    if (!ids.length) throw new Error("clusterIds must be non-empty");
    patch.clusterIds = ids;
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  const [row] = await db
    .update(vibeScheduleTable)
    .set(patch)
    .where(eq(vibeScheduleTable.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSchedule(id: number): Promise<void> {
  await db.delete(vibeScheduleTable).where(eq(vibeScheduleTable.id, id));
}

// Seed defaults on first run: manual picks + 3 hour-range slots.
export async function ensureVibeSeeded(): Promise<void> {
  try {
    const [existing] = await db.select().from(vibeStateTable).where(eq(vibeStateTable.key, VIBE_IDS_KEY));
    if (!existing) {
      await db.insert(vibeStateTable).values({ key: VIBE_IDS_KEY, value: JSON.stringify(DEFAULT_VIBE_CLUSTERS) });
    }
    const schedules = await db.select({ id: vibeScheduleTable.id }).from(vibeScheduleTable).limit(1);
    if (!schedules.length) {
      await db.insert(vibeScheduleTable).values([
        { name: "Morning", startHour: 6, endHour: 10, clusterIds: [2, 10, 16, 26, 38, 54], enabled: true },
        { name: "Evening", startHour: 18, endHour: 22, clusterIds: [2, 20, 18, 47], enabled: true },
        { name: "Night", startHour: 22, endHour: 6, clusterIds: [41, 46, 50, 56], enabled: true },
      ]);
    }
  } catch (e) {
    console.warn("[vibe] seed failed (tables may not exist yet):", String(e));
  }
}
