import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WORKTREE_REMINDER_AT, laneWorktrees, worktreeNote } from "./lane-worktrees.ts";
import { linkedWorktrees } from "./workspace-project.ts";

const root = "/repo/.worktrees";
const trees = ["a", "a-integ", "b", "c", "d"].map((name) => `${root}/${name}`);

test("a lane holds the worktrees its ledgers name, as whole paths only", () => {
  const ledger = `| x | p | ${root}/a-integ | feat/a-integ |\n- worktree：\`${root}/b\``;
  const archive = `| y | p | ${root}/c | feat/c |`;
  assert.deepEqual(laneWorktrees(trees, [ledger, archive]), [`${root}/a-integ`, `${root}/b`, `${root}/c`]);
  const home = "/Users/u";
  const mine = ["/Users/u/git/r/.worktrees/a", "/Users/u/git/r/.worktrees/b"];
  assert.deepEqual(laneWorktrees(mine, ["- worktree：`~/git/r/.worktrees/a`"], home), [mine[0]], "the ~ form counts");
});

test("a new worktree is flagged only once the lane already holds the reminder count", () => {
  const held = trees.slice(0, WORKTREE_REMINDER_AT);
  const fresh = `${root}/d`;
  const note = worktreeNote(fresh, trees, held);
  assert.match(note, /已经有 3 个 worktree（a、a-integ、b）/);
  assert.match(note, /最多再开 2 个/);
  assert.equal(worktreeNote(held[0], trees, held), null, "reusing one it holds says nothing");
  assert.equal(worktreeNote(fresh, trees, held.slice(0, 2)), null, "below the count says nothing");
  assert.equal(worktreeNote("/repo", trees, held), null, "the main checkout is not a worktree");
});

test("linkedWorktrees lists a repository's existing worktrees without the main checkout", async () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lane-worktrees-")));
  try {
    const repo = path.join(dir, "repo");
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", "-b", "x", path.join(repo, ".worktrees", "x"));
    git("worktree", "add", "-q", "-b", "y", path.join(repo, ".worktrees", "y"));
    rmSync(path.join(repo, ".worktrees", "y"), { recursive: true });
    assert.deepEqual(await linkedWorktrees(repo), [path.join(repo, ".worktrees", "x")], "the deleted one is left out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outside Git there are no worktrees", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lane-worktrees-plain-"));
  try {
    assert.deepEqual(await linkedWorktrees(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
