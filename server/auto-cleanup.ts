export const CLEANUP_EVERY_MS = 24 * 60 * 60_000;
/** How often to look at the clock. The run itself happens at most once per CLEANUP_EVERY_MS. */
export const CLEANUP_CHECK_MS = 30 * 60_000;

export interface CleanupRecord {
  lastRunAt: string;
  archived: number;
  workspacesArchived: number;
  kept: number;
  running: number;
  failed: number;
}

/** True when there has never been a run, the record is unreadable, or a full period has passed since the last one. */
export function cleanupDue(lastRunAt: string | null | undefined, now: number, everyMs = CLEANUP_EVERY_MS): boolean {
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (Number.isNaN(last)) return true;
  // A clock that moved backwards must not freeze the cleanup for days.
  if (last > now) return true;
  return now - last >= everyMs;
}

export function parseCleanupRecord(text: string): CleanupRecord | null {
  try {
    const value = JSON.parse(text) as Partial<CleanupRecord>;
    return typeof value.lastRunAt === "string" ? (value as CleanupRecord) : null;
  } catch {
    return null;
  }
}
