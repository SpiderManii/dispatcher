import type { CheckoutFacts } from "./workspace-project";

const shortRef = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

export interface WorkspaceFacts {
  id: string;
  /** Paseo's workspaceKind. */
  kind: string;
  worktreeSlug: string | null;
  pinned: boolean;
  setupRunning: boolean;
  /** The lane using this workspace, if any. */
  laneId: string | null;
  dispatcherHome: boolean;
  liveSessions: number;
  runningSessions: number;
  /** Other unarchived workspaces on the same directory. */
  sharedWith?: number;
  /** null when the directory is not a Git checkout. */
  checkout: CheckoutFacts | null;
  /** Git could not answer. Never read as "nothing to lose". */
  checkoutError: string | null;
}

export interface WorkspaceAssessment {
  /** Any entry means it can't be archived from the page. */
  blockers: string[];
  /** Worth knowing before confirming, but no committed work is at risk. */
  warnings: string[];
  /** Archiving may delete this directory. */
  removesDirectory: boolean;
  /**
   * Set when the only blocker is a branch whose commits exist nowhere else, and pushing it to this remote would clear
   * it. Only an offer: the page pushes when the user asks, since a push is seen by everyone on the remote.
   */
  pushTo: string | null;
}

/**
 * Archiving a workspace may delete a Paseo-managed worktree, so a worktree is judged as if it will be: it passes only
 * when nothing would be lost. `keep` holds workspace IDs and branch names the user wants left alone, because a branch
 * still being worked on can look exactly like a finished one.
 */
export function assessWorkspace(facts: WorkspaceFacts, keep: ReadonlySet<string>): WorkspaceAssessment {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let pushTo: string | null = null;
  const { checkout } = facts;
  const branch = checkout?.branch ?? null;
  const removesDirectory = facts.kind === "worktree" || !!facts.worktreeSlug || !!checkout?.linkedWorktree;

  if (keep.has(facts.id) || (branch && keep.has(branch))) blockers.push("登记里标了保留");
  if (facts.pinned) blockers.push("已置顶");
  if (facts.laneId) blockers.push(`会话线 ${facts.laneId} 在用`);
  if (facts.dispatcherHome) blockers.push("调度员的公用工作区");
  // Archiving a main-checkout row deletes nothing, so a duplicate row can go. The last one on the directory is the project itself.
  if ((facts.kind === "checkout" || facts.kind === "local_checkout") && !facts.sharedWith) blockers.push("项目主目录");
  if (facts.setupRunning) blockers.push("正在初始化");
  if (facts.runningSessions > 0) blockers.push(`${facts.runningSessions} 个会话在跑`);
  const idleSessions = facts.liveSessions - facts.runningSessions;
  if (idleSessions > 0) blockers.push(`${idleSessions} 个会话未归档`);

  if (removesDirectory) {
    // Paseo removes a worktree only after its last workspace is archived, so sharing never deletes it under anyone.
    if (facts.sharedWith) warnings.push(`还有 ${facts.sharedWith} 个工作区共用这个目录，最后一个归档时目录才会删`);
    if (facts.checkoutError) blockers.push(`读不到 Git 状态：${facts.checkoutError}`);
    else if (checkout) {
      if (checkout.uncommitted > 0) blockers.push(`${checkout.uncommitted} 个文件未提交`);
      if (!checkout.tipElsewhere) {
        blockers.push(branch ? `分支 ${branch} 的提交只在这个分支上` : "当前提交没有其他分支包含");
        if (branch && checkout.pushTo) pushTo = checkout.pushTo;
      } else if (checkout.landed === "patch" || checkout.landed === "content") {
        warnings.push(`提交号不同，但改动已在 ${shortRef(checkout.tipElsewhere)} 里${checkout.landed === "content" ? "（文件内容一致）" : ""}`);
      }
      if (checkout.ignored === null) warnings.push("没查完被忽略的文件（如 .env），它们可能一起删除");
      else if (checkout.ignored.length > 0) {
        const shown = checkout.ignored.slice(0, 3).join("、");
        warnings.push(`被忽略的文件可能一起删除：${shown}${checkout.ignored.length > 3 ? ` 等 ${checkout.ignored.length} 项` : ""}`);
      }
    }
  }
  return { blockers, warnings, removesDirectory, pushTo: blockers.length === 1 ? pushTo : null };
}
