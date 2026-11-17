// Keeps a lane ledger short enough to read every turn: rows for sessions that are gone, decisions answered long ago
// and old completions move to an archive file the dispatcher opens only when it needs history. Pure text in, text out.

const RUNNING = "## 在跑执行会话";
const DECISIONS = "## 待用户拍板";
const DONE = "## 最近完成";
const PLACEHOLDER = /^\|\s*（无在跑会话）/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const KEEP_DONE_DECISIONS = 3;
export const KEEP_RECENT = 8;

export interface SlimOptions {
  /** Sessions in the running table that Paseo reports archived or gone. */
  finished: ReadonlySet<string>;
  /** False while an answer to this lane is still queued: the queue checks those ticked lines are in the ledger. */
  archiveDecisions: boolean;
  archivePath: string;
}

export interface SlimResult {
  ledger: string;
  /** Moved-out text per section heading; empty when nothing moved. */
  archived: { heading: string; lines: string[] }[];
}

function sectionRange(lines: readonly string[], heading: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return { start, end: next < 0 ? lines.length : next };
}

/** Top-level `- ` bullets with their indented continuation lines, as line-index ranges inside the section. */
function bullets(lines: readonly string[], start: number, end: number): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = [];
  for (let index = start + 1; index < end; index += 1) {
    if (lines[index].startsWith("- ")) found.push({ from: index, to: index + 1 });
    else if (found.length > 0 && /^\s+\S/.test(lines[index]) && found[found.length - 1].to === index)
      found[found.length - 1].to = index + 1;
  }
  return found;
}

/** Session IDs in the running table's first column. */
export function runningTableAgents(ledger: string): string[] {
  const lines = ledger.split("\n");
  const range = sectionRange(lines, RUNNING);
  if (!range) return [];
  return lines
    .slice(range.start + 1, range.end)
    .filter((line) => line.startsWith("|"))
    .flatMap((line) => line.split("|")[1]?.match(UUID)?.[0] ?? []);
}

export function slimLedger(ledger: string, options: SlimOptions): SlimResult {
  const lines = ledger.split("\n");
  const drop = new Set<number>();
  const archived: SlimResult["archived"] = [];
  const take = (heading: string, indexes: number[]) => {
    if (indexes.length === 0) return;
    indexes.forEach((index) => drop.add(index));
    archived.push({ heading, lines: indexes.map((index) => lines[index]) });
  };

  const running = sectionRange(lines, RUNNING);
  let placeholderAt: number | null = null;
  if (running) {
    const separator = lines.findIndex(
      (line, index) => index > running.start && index < running.end && /^\|\s*-{3}/.test(line.trim()),
    );
    if (separator >= 0) {
      const rows: number[] = [];
      for (let index = separator + 1; index < running.end && lines[index].startsWith("|"); index += 1) rows.push(index);
      const gone = rows.filter((index) => {
        const id = lines[index].split("|")[1]?.match(UUID)?.[0];
        return PLACEHOLDER.test(lines[index]) || (id !== undefined && options.finished.has(id));
      });
      take("在跑执行会话（已结束）", gone.filter((index) => !PLACEHOLDER.test(lines[index])));
      gone.forEach((index) => drop.add(index));
      if (gone.length > 0 && gone.length === rows.length) placeholderAt = rows[0];
    }
  }

  const decisions = sectionRange(lines, DECISIONS);
  if (decisions && options.archiveDecisions) {
    const answered = bullets(lines, decisions.start, decisions.end).filter((item) => /^- \[x\]/i.test(lines[item.from]));
    const old = answered.slice(0, Math.max(0, answered.length - KEEP_DONE_DECISIONS));
    take("待用户拍板（已答复）", old.flatMap((item) => range(item.from, item.to)));
  }

  const done = sectionRange(lines, DONE);
  if (done) {
    const items = bullets(lines, done.start, done.end);
    const old = items.slice(0, Math.max(0, items.length - KEEP_RECENT));
    take("最近完成（更早）", old.flatMap((item) => range(item.from, item.to)));
  }

  if (drop.size === 0) return { ledger, archived: [] };
  const kept = lines.flatMap((line, index) =>
    index === placeholderAt ? ["| （无在跑会话） | — | — | — | — | — | — |"] : drop.has(index) ? [] : [line],
  );
  return { ledger: withPointer(kept, options.archivePath).join("\n"), archived };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => from + offset);

function withPointer(lines: string[], archivePath: string): string[] {
  const pointer = `> 更早的记录已由插件移到 ${archivePath}，需要查历史时再读。`;
  if (lines.some((line) => line.includes(archivePath))) return lines;
  const quote = lines.findIndex((line) => line.startsWith("> "));
  const at = quote >= 0 ? quote + 1 : Math.min(1, lines.length);
  return [...lines.slice(0, at), pointer, ...lines.slice(at)];
}

/** One dated block per slimming, appended to the archive file. */
export function archiveBlock(archived: SlimResult["archived"], now: Date): string {
  return [
    `## ${now.toISOString().slice(0, 16).replace("T", " ")} 自动归档`,
    "",
    ...archived.flatMap((part) => [`### ${part.heading}`, "", ...part.lines, ""]),
  ].join("\n");
}
