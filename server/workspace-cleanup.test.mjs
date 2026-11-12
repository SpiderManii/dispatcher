import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { assessWorkspace } from "./workspace-cleanup.ts";
import { checkoutFacts } from "./workspace-project.ts";

const checkout = (overrides = {}) => ({ branch: "feature", linkedWorktree: true, uncommitted: 0, tipElsewhere: "refs/heads/dev", landed: "contains", pushTo: null, ignored: [], ...overrides });
const facts = (overrides = {}) => ({
  id: "wks_1",
  kind: "directory",
  worktreeSlug: null,
  pinned: false,
  setupRunning: false,
  laneId: null,
  dispatcherHome: false,
  liveSessions: 0,
  runningSessions: 0,
  checkout: null,
  checkoutError: null,
  ...overrides,
});
const NONE = new Set();
const blockers = (overrides, keep = NONE) => assessWorkspace(facts(overrides), keep).blockers;

test("an unused plain directory can go and takes nothing with it", () => {
  assert.deepEqual(assessWorkspace(facts(), NONE), { blockers: [], warnings: [], removesDirectory: false, pushTo: null });
});

test("anything in use is blocked", () => {
  assert.equal(blockers({ laneId: "abc" }).length, 1);
  assert.equal(blockers({ dispatcherHome: true }).length, 1);
  assert.equal(blockers({ pinned: true }).length, 1);
  assert.equal(blockers({ setupRunning: true }).length, 1);
  assert.equal(blockers({ kind: "local_checkout" }).length, 1);
  assert.deepEqual(blockers({ liveSessions: 3, runningSessions: 1 }), ["1 个会话在跑", "2 个会话未归档"]);
});

test("a finished worktree can go, flagged as removing its directory", () => {
  const result = assessWorkspace(facts({ kind: "worktree", checkout: checkout() }), NONE);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.removesDirectory, true);
});

test("a directory workspace on a linked worktree is treated as a worktree", () => {
  assert.equal(assessWorkspace(facts({ checkout: checkout({ uncommitted: 1 }) }), NONE).blockers.length, 1);
});

test("work that exists nowhere else blocks a worktree", () => {
  assert.deepEqual(blockers({ kind: "worktree", checkout: checkout({ uncommitted: 2 }) }), ["2 个文件未提交"]);
  assert.deepEqual(blockers({ kind: "worktree", checkout: checkout({ tipElsewhere: null }) }), ["分支 feature 的提交只在这个分支上"]);
  // A push is offered only when it is all that stands in the way.
  assert.equal(assessWorkspace(facts({ kind: "worktree", checkout: checkout({ tipElsewhere: null, pushTo: "origin" }) }), NONE).pushTo, "origin");
  assert.equal(assessWorkspace(facts({ kind: "worktree", checkout: checkout({ tipElsewhere: null, pushTo: "origin", uncommitted: 1 }) }), NONE).pushTo, null);
  assert.equal(assessWorkspace(facts({ kind: "worktree", checkout: checkout({ pushTo: "origin" }) }), NONE).pushTo, null);
  assert.deepEqual(
    assessWorkspace(facts({ kind: "worktree", checkout: checkout({ landed: "patch", tipElsewhere: "refs/heads/collect" }) }), NONE).warnings,
    ["提交号不同，但改动已在 collect 里"],
  );
});

test("not being able to read Git blocks a worktree rather than passing it", () => {
  assert.equal(blockers({ kind: "worktree", checkoutError: "timeout" }).length, 1);
});

test("the main checkout's own dirt does not block an unrelated directory workspace", () => {
  assert.deepEqual(blockers({ checkout: checkout({ linkedWorktree: false, uncommitted: 5, tipElsewhere: null }) }), []);
});

test("the keep list wins even when the branch looks finished", () => {
  assert.deepEqual(blockers({ kind: "worktree", checkout: checkout({ branch: "feature-login" }) }, new Set(["feature-login"])), ["登记里标了保留"]);
  assert.deepEqual(blockers({ id: "wks_keep" }, new Set(["wks_keep"])), ["登记里标了保留"]);
});

test("ignored files warn but do not block", () => {
  const result = assessWorkspace(facts({ kind: "worktree", checkout: checkout({ ignored: [".env", "a", "b", "c"] }) }), NONE);
  assert.deepEqual(result.blockers, []);
  assert.match(result.warnings[0], /\.env.*等 4 项/);
});

let root;
let repo;
let worktree;
const git = (directory, ...args) => execFileSync("git", ["-C", directory, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" }).toString();

before(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cleanup-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "dev");
  writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "one");
  worktree = path.join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
});
after(() => rmSync(root, { recursive: true, force: true }));

test("an unfinished ignored-file scan warns rather than passing silently", () => {
  const result = assessWorkspace(facts({ kind: "worktree", checkout: checkout({ ignored: null }) }), NONE);
  assert.deepEqual(result.blockers, []);
  assert.match(result.warnings[0], /没查完/);
});

test("checkoutFacts reads a worktree whose tip is on another branch", async () => {
  assert.deepEqual(await checkoutFacts(worktree), {
    branch: "feature",
    linkedWorktree: true,
    uncommitted: 0,
    tipElsewhere: "refs/heads/dev",
    landed: "contains",
    pushTo: null,
    ignored: [],
  });
});

test("checkoutFacts sees the main checkout as not linked", async () => {
  const found = await checkoutFacts(repo);
  assert.equal(found.linkedWorktree, false);
  assert.equal(found.branch, "dev");
});

test("checkoutFacts counts dirt, ignores rebuildable files, and notices commits only on this branch", async () => {
  mkdirSync(path.join(worktree, "node_modules"));
  writeFileSync(path.join(worktree, "node_modules", "x"), "x");
  writeFileSync(path.join(worktree, ".env"), "x");
  writeFileSync(path.join(worktree, "new.txt"), "x");
  const dirty = await checkoutFacts(worktree);
  assert.equal(dirty.uncommitted, 1);
  assert.deepEqual(dirty.ignored, [".env"]);
  git(worktree, "add", "new.txt");
  git(worktree, "commit", "-qm", "two");
  const ahead = await checkoutFacts(worktree);
  assert.equal(ahead.uncommitted, 0);
  assert.equal(ahead.tipElsewhere, null);
});

test("checkoutFacts is null outside Git", async () => {
  assert.equal(await checkoutFacts(root), null);
  assert.equal(await checkoutFacts(path.join(root, "missing")), null);
});

test("sharing a worktree is a warning, not a blocker: Paseo deletes it with the last workspace", () => {
  const result = assessWorkspace(facts({ kind: "worktree", sharedWith: 30, checkout: checkout() }), NONE);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.warnings.length, 1);
});

test("a duplicate main-checkout row can go, the only one cannot", () => {
  assert.deepEqual(blockers({ kind: "local_checkout", sharedWith: 3 }), []);
  assert.deepEqual(blockers({ kind: "local_checkout", sharedWith: 0 }), ["项目主目录"]);
});
