import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { LaneProject, Registry } from "./core";

const exec = promisify(execFile);
const canonical = (value: string) => {
  const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  const resolved = path.resolve(expanded);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
};
const inside = (root: string, directory: string) => {
  const relative = path.relative(root, directory);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
  return env;
}

async function git(directory: string, args: string[], timeout = 5000): Promise<string> {
  return (await exec("git", ["-C", directory, ...args], { env: gitEnv(), timeout, maxBuffer: 1024 * 1024 })).stdout;
}

async function commonDirectory(directory: string): Promise<string | null> {
  if (!existsSync(directory)) return null;
  try {
    return canonical((await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
  } catch (error) {
    if (/not a git repository/.test(String((error as { stderr?: string }).stderr))) return null;
    throw new Error(`无法核实工作目录的 Git 归属：${directory}；${(error as Error).message}`);
  }
}

interface RegisteredProject {
  projectId: string;
  projectRootPath: string;
}

/** Resolve affiliation before creating a workspace; remote project keys are deliberately irrelevant. */
export async function directoryWorkspaceSource(input: {
  directory: string;
  projects: readonly RegisteredProject[];
  registry: Pick<Registry, "projects">;
  dispatcherId: string;
  laneProjects: readonly LaneProject[];
}): Promise<{ kind: "directory"; path: string; projectId: string }> {
  const directory = canonical(input.directory);
  const allowed = new Set<string>();
  for (const held of input.laneProjects) {
    const project = input.registry.projects.find((item) => item.id === held.key);
    if (project?.owner === input.dispatcherId) {
      for (const repo of project.repos) allowed.add(canonical(repo));
    } else if (!project && held.key === `dir:${canonical(held.path)}`) {
      allowed.add(canonical(held.path));
    }
  }

  const common = await commonDirectory(directory);
  let mainRoot: string | undefined;
  if (common) {
    // Worktrees outside the main directory are allowed only when they share an assigned repository.
    let belongs = false;
    for (const root of allowed) {
      if ((await commonDirectory(root)) === common) {
        belongs = true;
        break;
      }
    }
    if (!belongs) throw new Error(`工作目录不属于本会话线获准派单的仓库：${directory}`);
    // Git lists the main worktree first; unlike dirname(.git), this also handles separate Git dirs.
    const first = (await git(directory, ["worktree", "list", "--porcelain", "-z"])).split("\0", 1)[0];
    if (!first.startsWith("worktree ")) throw new Error(`无法识别 Git 主仓库目录：${directory}`);
    const candidate = canonical(first.slice("worktree ".length));
    if ((await commonDirectory(candidate)) !== common)
      throw new Error(`无法核实 Git 主仓库目录：${candidate}`);
    mainRoot = canonical((await git(candidate, ["rev-parse", "--show-toplevel"])).trim());
  } else {
    // Preserve explicitly assigned non-Git directory work, without registering a new project implicitly.
    mainRoot = [...allowed].filter((root) => inside(root, directory)).sort((a, b) => b.length - a.length)[0];
    if (!mainRoot) throw new Error(`工作目录不属于本会话线获准派单的目录：${directory}`);
  }

  const matches = new Set(
    input.projects.filter((project) => canonical(project.projectRootPath) === mainRoot).map((project) => project.projectId),
  );
  if (matches.size === 0)
    throw new Error(`主项目尚未在 Paseo 登记：${mainRoot}。请先登记该主目录；没有创建工作区或新项目。`);
  if (matches.size !== 1)
    throw new Error(`主目录对应多个 Paseo 项目：${mainRoot}（${[...matches].join("、")}）；没有创建工作区，请先消除重复登记。`);
  return { kind: "directory", path: directory, projectId: [...matches][0] };
}

export interface BranchInfo {
  name: string;
  /** Where it is checked out, if anywhere. */
  worktree: string | null;
  current: boolean;
}

export interface ResolvedBranch {
  name: string;
  /** Set when the branch is to be created from this one. */
  base: string | null;
  worktree: string | null;
}

async function worktreesByBranch(directory: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let worktree: string | null = null;
  for (const line of (await git(directory, ["worktree", "list", "--porcelain"])).split("\n")) {
    if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length);
    const branch = /^branch refs\/heads\/(.+)$/.exec(line)?.[1];
    // A deleted worktree stays listed until pruned, and is no use to anyone.
    if (branch && worktree && existsSync(worktree)) found.set(branch, canonical(worktree));
  }
  return found;
}

export interface CheckoutFacts {
  /** null when HEAD is detached. */
  branch: string | null;
  /** A linked worktree, as opposed to the repository's main checkout. */
  linkedWorktree: boolean;
  uncommitted: number;
  /** A ref other than this branch that holds HEAD's work; null when its commits exist nowhere else. */
  tipElsewhere: string | null;
  /**
   * How `tipElsewhere` holds it: "contains" has HEAD itself; "patch" has the same changes under other commit IDs (a
   * cherry-pick or rebase); "content" would not change if HEAD were merged into it (a squash or a re-done fix).
   */
  landed: "contains" | "patch" | "content" | null;
  /** The remote a push would save HEAD's branch to; null when there is no branch or no remote. Set even when landed. */
  pushTo: string | null;
  /** Ignored paths someone may miss. Things a build or install recreates are left out. null when the scan didn't finish. */
  ignored: string[] | null;
}

/** A worktree with node_modules can take this long, and more on a slow disk. */
const STATUS_TIMEOUT_MS = 30_000;

const REBUILDABLE = /(^|\/)(node_modules|\.next|dist|build|out|coverage|target|__pycache__|\.venv|venv|\.turbo|\.cache|\.pytest_cache|\.ruff_cache|\.mypy_cache)(\/|$)|\.tsbuildinfo$|\.pyc$|(^|\/)\.DS_Store$/;

/** What would be lost if this directory went away. Read-only; null outside Git. */
export async function checkoutFacts(directory: string): Promise<CheckoutFacts | null> {
  const common = await commonDirectory(directory);
  if (!common) return null;
  const [gitDir, status, ignoredStatus, head, symbolic] = await Promise.all([
    git(directory, ["rev-parse", "--absolute-git-dir"]),
    // Must answer: this is the check that protects uncommitted work.
    git(directory, ["status", "--porcelain"], STATUS_TIMEOUT_MS),
    // Walks everything ignored, node_modules included, so it may not finish in time. The caller warns instead.
    git(directory, ["status", "--porcelain", "--ignored"], STATUS_TIMEOUT_MS).catch(() => null),
    git(directory, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => ""),
    git(directory, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
  ]);
  const ignored =
    ignoredStatus === null
      ? null
      : ignoredStatus
          .split("\n")
          .filter((line) => line.startsWith("!! "))
          .map((line) => line.slice(3).replace(/^"|"$/g, "").replace(/\/$/, ""))
          .filter((item) => !REBUILDABLE.test(item));
  const branch = symbolic.trim() || null;
  const own = (ref: string) => !!ref && ref !== `refs/heads/${branch}` && ref !== "refs/stash";
  let tipElsewhere: string | null = null;
  let landed: CheckoutFacts["landed"] = null;
  if (head.trim()) {
    const refs = await git(directory, ["for-each-ref", "--contains", head.trim(), "--format=%(refname)"]);
    tipElsewhere = refs.split("\n").filter(own)[0] ?? null;
    if (tipElsewhere) landed = "contains";
    else {
      const found = await landedElsewhere(directory, head.trim(), branch, own);
      if (found) ({ ref: tipElsewhere, how: landed } = found);
    }
  }
  return {
    branch,
    linkedWorktree: canonical(gitDir.trim()) !== common,
    uncommitted: status.split("\n").filter(Boolean).length,
    tipElsewhere,
    landed,
    pushTo: branch ? await pushRemote(directory, branch) : null,
    ignored,
  };
}

/** Enough to cover the branches a task fans out into, without walking a repository's whole history of branches. */
const LANDED_CANDIDATES = 30;

/**
 * HEAD's commits exist on no other ref, but their changes may: a cherry-pick, a rebase or a squash leaves the work in
 * another branch under new commit IDs. Only refs that share HEAD's fork point are tried, most recent first. A ref
 * counts only if every one of HEAD's own commits is patch-equivalent there, or merging HEAD into it would change nothing.
 */
async function landedElsewhere(
  directory: string,
  head: string,
  branch: string | null,
  own: (ref: string) => boolean,
): Promise<{ ref: string; how: "patch" | "content" } | null> {
  // HEAD's own commits: reachable from it and from no other branch.
  const exclude = branch ? [`--exclude=${branch}`] : [];
  const unique = (await git(directory, ["rev-list", head, "--not", ...exclude, "--branches", "--remotes"])).split("\n").filter(Boolean);
  if (unique.length === 0) return null;
  const fork = (await git(directory, ["rev-parse", `${unique[unique.length - 1]}^`]).catch(() => "")).trim();
  if (!fork) return null;
  const candidates = (
    await git(directory, ["for-each-ref", "--contains", fork, "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"])
  )
    .split("\n")
    .filter((ref) => own(ref) && !ref.endsWith("/HEAD"))
    .slice(0, LANDED_CANDIDATES);
  if (candidates.length === 0) return null;
  for (const ref of candidates) {
    // `git cherry` marks each commit missing from the ref with "+", equivalent ones with "-".
    const cherry = await git(directory, ["cherry", ref, head, fork]).catch(() => null);
    if (cherry !== null && cherry.trim() && !cherry.split("\n").some((line) => line.startsWith("+"))) return { ref, how: "patch" };
    // Merging HEAD into the ref would change nothing: the work is there, squashed or redone and perhaps built on since.
    // A conflict exits 1 and counts as not landed. Writes the merged tree's objects, which `git gc` later drops.
    const merged = await git(directory, ["merge-tree", "--write-tree", "--no-messages", ref, head]).catch(() => null);
    const tree = await git(directory, ["rev-parse", `${ref}^{tree}`]).catch(() => null);
    if (merged && tree && merged.split("\n")[0].trim() === tree.trim()) return { ref, how: "content" };
  }
  return null;
}

/** The checked-out commit's full SHA; null outside Git or before the first commit. */
export async function headCommit(directory: string): Promise<string | null> {
  if (!(await commonDirectory(directory))) return null;
  return (await git(directory, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() || null;
}

/** The checked-out branch; null when detached or outside Git. */
export async function currentBranch(directory: string): Promise<string | null> {
  if (!(await commonDirectory(directory))) return null;
  return (await git(directory, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim() || null;
}

/** Both directories are checkouts of one repository, so they share branches. */
export async function sameRepository(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([commonDirectory(a).catch(() => null), commonDirectory(b).catch(() => null)]);
  return !!left && left === right;
}

/**
 * Whether `branch`'s work is already on the local `target` branch: contained, cherry-picked, or redone so that merging
 * it would change nothing. null when either branch is gone, which leaves nothing to merge.
 */
export async function branchLandsOn(directory: string, branch: string, target: string): Promise<boolean | null> {
  const resolve = (name: string) => git(directory, ["rev-parse", "--verify", "-q", `refs/heads/${name}^{commit}`]).then((out) => out.trim(), () => "");
  const [tip, onto] = await Promise.all([resolve(branch), resolve(target)]);
  if (!tip || !onto) return null;
  const contained = await git(directory, ["merge-base", "--is-ancestor", tip, onto]).then(() => true, () => false);
  if (contained) return true;
  const cherry = await git(directory, ["cherry", onto, tip]).catch(() => null);
  if (cherry !== null && cherry.trim() && !cherry.split("\n").some((line) => line.startsWith("+"))) return true;
  const merged = await git(directory, ["merge-tree", "--write-tree", "--no-messages", onto, tip]).catch(() => null);
  const tree = await git(directory, ["rev-parse", `${onto}^{tree}`]).catch(() => null);
  return !!merged && !!tree && merged.split("\n")[0].trim() === tree.trim();
}

/** The branch's upstream remote, else origin, else the only remote. */
async function pushRemote(directory: string, branch: string): Promise<string | null> {
  const upstream = (await git(directory, ["config", "--get", `branch.${branch}.remote`]).catch(() => "")).trim();
  if (upstream && upstream !== ".") return upstream;
  const remotes = (await git(directory, ["remote"]).catch(() => "")).split("\n").filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : null;
}

/**
 * Saves the checked-out branch to its remote under the same name, so archiving can't take its only copy. Never forced:
 * a remote that moved on is reported, not overwritten. Re-reads the branch so a stale page can't push something else.
 */
export async function pushCheckoutBranch(directory: string, expected: { branch: string; remote: string }): Promise<void> {
  const branch = (await git(directory, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();
  if (branch !== expected.branch) throw new Error(`当前分支已变成 ${branch || "游离 HEAD"}，没有推送`);
  try {
    await git(directory, ["push", "--porcelain", "-u", expected.remote, `refs/heads/${branch}:refs/heads/${branch}`], 120_000);
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    const why = /non-fast-forward|fetch first|rejected/.test(stderr)
      ? `远端的 ${branch} 有本地没有的提交，没有强推，请先合并远端`
      : stderr.split("\n").filter(Boolean).slice(-1)[0] || (error as Error).message.split("\n")[0];
    throw new Error(`推送 ${branch} 到 ${expected.remote} 失败：${why}`);
  }
}

/** Local branches, the checked-out one first, then most recently committed. Read-only; [] outside Git. */
export async function listBranches(directory: string): Promise<BranchInfo[]> {
  if (!(await commonDirectory(directory))) return [];
  const [refs, worktrees, head] = await Promise.all([
    git(directory, ["for-each-ref", "--sort=-committerdate", "--count=200", "--format=%(refname)", "refs/heads"]),
    worktreesByBranch(directory),
    // A repository with no commits has no HEAD to name.
    git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
  ]);
  const current = head.trim();
  const branches = refs
    .split("\n")
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/heads\//, ""))
    .map((name) => ({ name, worktree: worktrees.get(name) ?? null, current: name === current }));
  return [...branches.filter((item) => item.current), ...branches.filter((item) => !item.current)];
}

async function branchExists(directory: string, name: string): Promise<boolean> {
  try {
    await git(directory, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** Rechecks the page's choice against the repository, which may have moved on since the list was fetched. */
export async function resolveBranchChoice(
  directory: string,
  choice: { name: string; base?: string },
): Promise<ResolvedBranch> {
  const { name, base } = choice;
  if (base === undefined) {
    if (!(await branchExists(directory, name))) throw new Error(`分支「${name}」不存在，可能已被删除，请重新选择`);
    return { name, base: null, worktree: (await worktreesByBranch(directory)).get(name) ?? null };
  }
  const invalid = () => new Error(`新分支名「${name}」不合法`);
  if (name.startsWith("-")) throw invalid();
  await git(directory, ["check-ref-format", "--branch", name]).catch(() => {
    throw invalid();
  });
  if (await branchExists(directory, name)) throw new Error(`分支「${name}」已存在，请直接选择它`);
  if (!(await branchExists(directory, base))) throw new Error(`基线分支「${base}」不存在，请重新选择`);
  return { name, base, worktree: null };
}
