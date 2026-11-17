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
  | "auto_answered";

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
