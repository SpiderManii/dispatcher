import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type LaneEventKind =
  | "dispatched"
  | "ended"
  | "failed"
  | "interrupted"
  | "stuck"
  | "gone"
  | "canceled"
  | "answered"
  | "auto_answered"
  /** The plugin closed open decisions the lane's stage had made moot. */
  | "auto_stale"
  /** The user agreed to merge the lane's branches back, from the page. */
  | "merge_ok"
  /** The user asked for a deploy from the page: service and SHA in `detail`. */
  | "deploy_ok"
  /** The user set the stage by hand. */
  | "stage_set"
  /** The lane opened for a requirement that had been waiting in the queue. */
  | "queued_start"
  /** The user asked a quiet lane to carry on. */
  | "nudged"
  /** The user pushed the lane's work to the remote from the page. */
  | "pushed"
  /** A card the plugin found sensitive (§9) went out: the requirement needs one review before 合回. */
  | "review_needed"
  /** The user asked the dispatcher for that review, from the page. */
  | "review_requested"
  /** The user decided the requirement needs no review, from the page. */
  | "review_waived";

export interface LaneEvent {
  at: string;
  kind: LaneEventKind;
  workerId?: string;
  title?: string | null;
  detail?: string | null;
}

const MAX_FILE_BYTES = 512 * 1024;
const KEEP_ON_TRIM = 400;

const eventsFile = (dir: string, laneId: string) => path.join(dir, `${laneId}.jsonl`);

const parse = (text: string): LaneEvent[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as LaneEvent;
        return typeof event.at === "string" && typeof event.kind === "string" ? [event] : [];
      } catch {
        return [];
      }
    });

/** One line per event, so a lane keeps its story across plugin reloads and Paseo restarts. */
export function appendLaneEvent(dir: string, laneId: string, event: LaneEvent): void {
  mkdirSync(dir, { recursive: true });
  const file = eventsFile(dir, laneId);
  appendFileSync(file, `${JSON.stringify(event)}\n`);
  if (statSync(file).size <= MAX_FILE_BYTES) return;
  const kept = parse(readFileSync(file, "utf8")).slice(-KEEP_ON_TRIM);
  writeFileSync(file, kept.map((item) => JSON.stringify(item)).join("\n") + "\n");
}

export function recentLaneEvents(dir: string, laneId: string, limit: number): LaneEvent[] {
  const file = eventsFile(dir, laneId);
  if (!existsSync(file)) return [];
  return parse(readFileSync(file, "utf8")).slice(-limit).reverse();
}

export interface LaneEventStats {
  /** Cards sent out, by dispatch_work. */
  dispatched: number;
  /** Cards that failed, were interrupted or vanished. */
  troubles: number;
}

const TROUBLE = new Set<LaneEventKind>(["failed", "interrupted", "gone"]);
const statsCache = new Map<string, { mtimeMs: number; size: number; stats: LaneEventStats }>();

/** Counts over the lane's whole timeline. Re-read only when the file changed, as the page asks every few seconds. */
export function laneEventStats(dir: string, laneId: string): LaneEventStats {
  const file = eventsFile(dir, laneId);
  if (!existsSync(file)) return { dispatched: 0, troubles: 0 };
  const { mtimeMs, size } = statSync(file);
  const cached = statsCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.stats;
  const events = parse(readFileSync(file, "utf8"));
  const stats = {
    dispatched: events.filter((event) => event.kind === "dispatched").length,
    troubles: events.filter((event) => TROUBLE.has(event.kind)).length,
  };
  statsCache.set(file, { mtimeMs, size, stats });
  return stats;
}
