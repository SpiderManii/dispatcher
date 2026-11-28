import os from "node:os";

// §5: one requirement keeps to one worktree; extra ones only for real parallel work, removed once merged back.
// The plugin does not refuse a new one, it only says so when a requirement already holds several.

/** At this many worktrees of one repository, a new one gets a reminder in the dispatch result. */
export const WORKTREE_REMINDER_AT = 3;

/** The repository's linked worktrees that this lane's ledgers (current and archived) mention. */
export function laneWorktrees(linked: readonly string[], ledgers: readonly string[], home = os.homedir()): string[] {
  const text = ledgers.join("\n");
  // Ledgers write paths both in full and as `~/…`.
  const short = (worktree: string) => (worktree.startsWith(`${home}/`) ? `~${worktree.slice(home.length)}` : null);
  return linked.filter((worktree) => mentions(text, worktree) || (short(worktree) !== null && mentions(text, short(worktree) as string)));
}

// A path counts only as a whole path, so `.worktrees/x` does not match inside `.worktrees/x-integ`.
function mentions(text: string, worktree: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(worktree, from);
    if (at < 0) return false;
    const next = text[at + worktree.length];
    if (next === undefined || !/[\w.-]/.test(next)) return true;
    from = at + 1;
  }
}

/** The note for a card that opens a worktree this lane has not used yet, or null when nothing needs saying. */
export function worktreeNote(directory: string, linked: readonly string[], held: readonly string[]): string | null {
  if (!linked.includes(directory) || held.includes(directory)) return null;
  if (held.length < WORKTREE_REMINDER_AT) return null;
  const names = held.map((item) => item.split("/").pop()).join("、");
  return [
    `注意：这条需求在这个仓库已经有 ${held.length} 个 worktree（${names}），这张卡又开了一个新的。`,
    "按第 5 节，按顺序做的卡轮流用收口分支那一个；只有真并行才另开，一条需求最多再开 2 个。",
    "已经合回收口分支、上面没有在跑会话的临时 worktree，按第 13 节先撤掉。",
  ].join("");
}
