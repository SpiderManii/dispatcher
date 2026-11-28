// Execution sessions that finished their card stay open and idle in Paseo, and the provider only allows so many open
// sessions at once. Once the dispatcher has the result and the session has been quiet a few minutes, it is archived.
// Only the session: its workspace and branch are left alone, since a rework round may still use them.

export const RETIRE_AFTER_MS = 5 * 60_000;

export interface RetireCandidate {
  id: string;
  status: string;
  archived: boolean;
  /** Last time anything happened in the session (epoch ms); null when unknown, which never retires it. */
  updatedAt: number | null;
}

/**
 * Workers to archive now. `held` are workers the dispatcher has not heard about yet, or that the watch still follows:
 * their result must reach the dispatcher first.
 */
export function finishedWorkers(candidates: readonly RetireCandidate[], held: ReadonlySet<string>, now: number): string[] {
  return candidates
    .filter(
      (worker) =>
        !worker.archived &&
        (worker.status === "idle" || worker.status === "closed") &&
        !held.has(worker.id) &&
        worker.updatedAt !== null &&
        now - worker.updatedAt >= RETIRE_AFTER_MS,
    )
    .map((worker) => worker.id);
}
