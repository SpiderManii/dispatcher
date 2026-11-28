// Keeps lanes on one project out of each other's files. Pure text logic: the service reads the ledgers and decides
// what to refuse. Only node built-ins, so it can be tested on its own.

import os from "node:os";
import path from "node:path";

export const SCOPE_HEADING = "## 改动范围";

/** Roles that only read: they may go out before the lane's scope is known, and never claim files. */
export const READ_ONLY_ROLES = new Set(["split", "review", "architect"]);

/** Decisions marked this way wait for the user however long it takes; see decision-timeout. */
export const CONFLICT_MARK = "【冲突】";

const SECTION_END = /^##\s/;

/** The 改动范围 section's body, without the template's HTML comment. */
export function scopeText(ledger: string): string {
  const lines = ledger.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === SCOPE_HEADING);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && SECTION_END.test(line));
  return lines
    .slice(start + 1, end < 0 ? lines.length : end)
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

/** Working directories in the running table's cwd column, to turn absolute worktree paths back into repo paths. */
export function runningCwds(ledger: string): string[] {
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
    const cwd = line.split("|").map((cell) => cell.trim())[3];
    if (cwd && path.isAbsolute(cwd.replace(/^`|`$/g, ""))) found.push(cwd.replace(/^`|`$/g, ""));
  }
  return found;
}

const SPLIT = /[\s`'"“”‘’，、；;,()（）「」『』<>|]+/;
const CJK = /[　-鿿＀-￯]/;

const expand = (value: string) => (value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value);

/**
 * Path-like tokens in free text, made relative to whichever root they sit under (the project or one of its worktrees),
 * so `/wt/feat-x/src/a.ts` and `src/a.ts` compare equal. Globs are cut at the first `*`, line numbers dropped.
 */
export function scopePaths(text: string, roots: readonly string[] = []): string[] {
  const sorted = [...new Set(roots.map((root) => path.resolve(expand(root))))].sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  for (const raw of text.split(SPLIT)) {
    let token = raw.replace(/^[-*>•]+/, "").replace(/[。.:：]+$/, "").replace(/:\d+(-\d+)?$/, "");
    if (!token || token.includes("://") || CJK.test(token)) continue;
    const star = token.indexOf("*");
    if (star >= 0) token = token.slice(0, star);
    const looksLikePath = token.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(token);
    if (!looksLikePath) continue;
    if (token.startsWith("/") || token.startsWith("~")) {
      const absolute = path.resolve(expand(token));
      const root = sorted.find((item) => absolute === item || absolute.startsWith(`${item}/`));
      token = root ? path.relative(root, absolute) : absolute;
    }
    token = token.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!token || token === "." || /^\.+$/.test(token)) continue;
    found.add(path.posix.normalize(token));
  }
  return [...found];
}

/** Pairs that touch: the same file, or one is a directory holding the other. */
export function overlapping(mine: readonly string[], theirs: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const a of mine)
    for (const b of theirs) if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) pairs.push([a, b]);
  return pairs;
}

/**
 * Cards in the same lane that are running right now and name a file this card also names. Other lanes are checked
 * against their 改动范围; inside a lane only running cards count, since the lane's own 改动范围 lists every card it
 * ever sent, and a card that has finished hands its files on to the next one.
 */
export function laneClashes(
  mine: readonly string[],
  running: readonly { id: string; title: string | null; files: readonly string[] }[],
): { id: string; title: string | null; pairs: [string, string][] }[] {
  return running.flatMap((card) => {
    const pairs = overlapping(mine, card.files);
    return pairs.length > 0 ? [{ id: card.id, title: card.title, pairs }] : [];
  });
}

/**
 * Adds a card's files to the lane's 改动范围, so the other lanes on the project see them before they dispatch.
 * Only paths not yet listed; creates the section when an older ledger has none.
 */
export function withScopePaths(ledger: string, paths: readonly string[], title: string): string {
  const listed = new Set(scopePaths(scopeText(ledger)));
  const fresh = paths.filter((item) => !listed.has(item));
  if (fresh.length === 0) return ledger;
  const line = `- ${fresh.map((item) => `\`${item}\``).join("、")}（${title}）`;
  const lines = ledger.split("\n");
  const start = lines.findIndex((item) => item.trim() === SCOPE_HEADING);
  if (start < 0) return `${ledger.replace(/\n*$/, "")}\n\n${SCOPE_HEADING}\n\n${line}\n`;
  let end = lines.findIndex((item, index) => index > start && SECTION_END.test(item));
  if (end < 0) end = lines.length;
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === "") at -= 1;
  lines.splice(at, 0, ...(at === start + 1 ? ["", line] : [line]));
  return lines.join("\n");
}
