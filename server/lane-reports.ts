// What a lane's workers reported: their status files, newest first, each with the line that sums it up. The ledger's
// running table names the files; workers write them into the project's 进度 folder.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface LaneReport {
  path: string;
  /** The file's name without 「-状态.md」: workers name them 「角色-任务-状态.md」. */
  name: string;
  modifiedAt: string;
  /** 「结论：…」 or 「状态：…」 when the file has one, else its first line of text. */
  headline: string | null;
}

/** Status-file paths in the running table, in table order. */
export function runningStatusFiles(ledger: string): string[] {
  const found: string[] = [];
  let inRunning = false;
  let row = 0;
  for (const line of ledger.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      inRunning = line.includes("在跑");
      row = 0;
      continue;
    }
    if (!inRunning || !line.trim().startsWith("|")) continue;
    row += 1;
    if (row <= 2) continue;
    const cell = line.split("|").map((value) => value.trim())[5]?.replace(/^`|`$/g, "");
    if (cell && path.isAbsolute(cell) && !found.includes(cell)) found.push(cell);
  }
  return found;
}

const KEYED = /^(?:[-*]\s*)?(?:\*\*)?(结论|状态|结果)(?:\*\*)?\s*[：:]\s*(.+)$/;
const ROW = /^\|\s*(?:\*\*)?(结论|状态|结果)(?:\*\*)?\s*\|\s*([^|]+?)\s*\|/;
const plain = (text: string) => text.replace(/\*\*|__|`/g, "").trim();

/** The line that sums a status file up. */
export function reportHeadline(text: string, max = 100): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let picked: string | null = null;
  for (const line of lines) {
    const keyed = KEYED.exec(line) ?? ROW.exec(line);
    if (keyed) {
      picked = `${keyed[1]}：${plain(keyed[2])}`;
      break;
    }
  }
  picked ??= lines.map(plain).find((line) => line && !line.startsWith("#") && !line.startsWith("|") && !/^[-=]{3,}$/.test(line)) ?? null;
  if (!picked) return null;
  return [...picked].length > max ? `${[...picked].slice(0, max).join("")}…` : picked;
}

export function reportName(file: string): string {
  return path.basename(file).replace(/-?状态\.md$/, "").replace(/\.md$/, "") || path.basename(file);
}

/** The newest `limit` status files of a lane that exist on disk. Reads only the first few KB of each. */
export function laneReports(ledger: string, limit = 3): LaneReport[] {
  const files = runningStatusFiles(ledger).flatMap((file) => {
    try {
      if (!existsSync(file)) return [];
      const stat = statSync(file);
      return stat.isFile() ? [{ file, mtime: stat.mtime }] : [];
    } catch {
      return [];
    }
  });
  return files
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, limit)
    .map(({ file, mtime }) => {
      let headline: string | null = null;
      try {
        headline = reportHeadline(readFileSync(file, "utf8").slice(0, 4096));
      } catch {
        headline = null;
      }
      return { path: file, name: reportName(file), modifiedAt: mtime.toISOString(), headline };
    });
}
