// Renames the dispatch home's Chinese file and folder names to ASCII ones. Plain fs, so it can be tested with Node.
import { existsSync, lstatSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** [old name, new name], relative to the dispatch home. */
const HOME_NAMES: Array<[string, string]> = [
  ["项目登记.json", "registry.json"],
  ["调度员.md", "rules.md"],
  ["交接", "handoffs"],
  ["调度员", "dispatchers"],
];
/** Relative to each dispatcher's folder. */
const DISPATCHER_NAMES: Array<[string, string]> = [
  ["台账.md", "ledger.md"],
  ["台账", "ledgers"],
  ["会话线.md", "lanes.md"],
  ["附件", "attachments"],
];
/** Relative to a dispatcher's ledgers folder. */
const LEDGER_NAMES: Array<[string, string]> = [["归档", "archive"]];

const present = (file: string) => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** Moves `old` to `next` and leaves a symlink at the old name, so paths already handed to running sessions still open. */
function rename(dir: string, [old, next]: [string, string], moved: string[]): void {
  const from = path.join(dir, old);
  const to = path.join(dir, next);
  if (!present(from) || present(to) || lstatSync(from).isSymbolicLink()) return;
  renameSync(from, to);
  symlinkSync(next, from);
  moved.push(`${old} → ${next}`);
}

/** Idempotent. Returns what it renamed; a name that already has its new counterpart is left alone. */
export function migrateLayout(home: string): string[] {
  const moved: string[] = [];
  if (!existsSync(home)) return moved;
  for (const pair of HOME_NAMES) rename(home, pair, moved);
  const dispatchers = path.join(home, "dispatchers");
  if (!existsSync(dispatchers)) return moved;
  for (const entry of readdirSync(dispatchers, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(dispatchers, entry.name);
    for (const pair of DISPATCHER_NAMES) rename(dir, pair, moved);
    const ledgers = path.join(dir, "ledgers");
    if (existsSync(ledgers)) for (const pair of LEDGER_NAMES) rename(ledgers, pair, moved);
  }
  return moved;
}

/** An explicit setting wins; then an existing home; the old location is used as long as it is the only one. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PASEO_DISPATCH_HOME) return env.PASEO_DISPATCH_HOME;
  const fresh = path.join(env.PASEO_HOME || path.join(os.homedir(), ".paseo"), "dispatch-center");
  const legacy = path.join(os.homedir(), "Paseo调度中心");
  return !existsSync(fresh) && existsSync(legacy) ? legacy : fresh;
}
