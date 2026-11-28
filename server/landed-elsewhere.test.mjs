import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { branchLandsOn, checkoutFacts, currentBranch, pushCheckoutBranch } from "./workspace-project.ts";

let temporary;
let main;
let remote;

const env = { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" };
function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, "-c", "user.name=Landed Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function commit(directory, file, text, message) {
  writeFileSync(path.join(directory, file), text);
  git(directory, "add", file);
  git(directory, "commit", "-q", "-m", message);
  return git(directory, "rev-parse", "HEAD").trim();
}
/** A worktree on a new branch from `base`, as the dispatcher's workers get. */
function worktree(name, base = "main") {
  const directory = path.join(temporary, name);
  git(main, "worktree", "add", "-q", "-b", name, directory, base);
  return directory;
}

before(() => {
  temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-landed-")));
  main = path.join(temporary, "main");
  remote = path.join(temporary, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env });
  execFileSync("git", ["init", "-q", "-b", "main", main], { env });
  commit(main, "base.txt", "base\n", "base");
  git(main, "remote", "add", "origin", remote);
  git(main, "push", "-q", "-u", "origin", "main");
});
after(() => {
  assert.ok(path.basename(temporary).startsWith("paseo-landed-"));
  rmSync(temporary, { recursive: true, force: true });
});

test("a branch whose tip another branch contains is landed as-is", async () => {
  const side = worktree("side-contained");
  commit(side, "a.txt", "a\n", "a");
  git(main, "branch", "collect-contained", "side-contained");
  const facts = await checkoutFacts(side);
  assert.equal(facts.landed, "contains");
  assert.equal(facts.tipElsewhere, "refs/heads/collect-contained");
});

test("a cherry-picked branch counts as landed under other commit IDs", async () => {
  const side = worktree("side-picked");
  const picked = commit(side, "b.txt", "b\n", "b");
  const collect = worktree("collect-picked");
  commit(collect, "other.txt", "other\n", "other first, so the pick gets a new ID");
  git(collect, "cherry-pick", picked);
  const facts = await checkoutFacts(side);
  assert.equal(facts.landed, "patch");
  assert.equal(facts.tipElsewhere, "refs/heads/collect-picked");
});

test("a fix redone elsewhere and built on since counts as landed", async () => {
  const base = worktree("base-redone");
  commit(base, "g.txt", "one\ntwo\nthree\nfour\nfive\nsix\n", "a file to fix");
  const side = worktree("side-redone", "base-redone");
  commit(side, "g.txt", "one\nTWO\nthree\nfour\nfive\nsix\n", "fix");
  const collect = worktree("collect-redone", "base-redone");
  // Redone together with more work, so no commit there matches the fix's patch.
  commit(collect, "g.txt", "one\nTWO\nthree\nfour\nfive\nsix\nseven\n", "the same fix, redone with more");
  const facts = await checkoutFacts(side);
  assert.equal(facts.landed, "content");
  assert.equal(facts.tipElsewhere, "refs/heads/collect-redone");
});

test("a branch that conflicts with or adds to every other branch is not landed", async () => {
  const side = worktree("side-partial");
  commit(side, "h.txt", "h\n", "h");
  commit(side, "i.txt", "i\n", "i");
  const collect = worktree("collect-partial");
  commit(collect, "h.txt", "h\n", "only half of it");
  const facts = await checkoutFacts(side);
  assert.equal(facts.tipElsewhere, null);
  assert.equal(facts.landed, null);
});

test("a squashed or re-done fix counts as landed when the touched files match", async () => {
  const side = worktree("side-squashed");
  commit(side, "c.txt", "c1\n", "c step 1");
  commit(side, "c.txt", "c2\n", "c step 2");
  const collect = worktree("collect-squashed");
  commit(collect, "c.txt", "c2\n", "c in one go");
  const facts = await checkoutFacts(side);
  assert.equal(facts.landed, "content");
  assert.equal(facts.tipElsewhere, "refs/heads/collect-squashed");
});

test("work that is only on its branch is not landed, and can be pushed to origin", async () => {
  const side = worktree("side-alone");
  commit(side, "d.txt", "d\n", "d");
  const before = await checkoutFacts(side);
  assert.equal(before.tipElsewhere, null);
  assert.equal(before.landed, null);
  assert.equal(before.pushTo, "origin");

  await pushCheckoutBranch(side, { branch: "side-alone", remote: "origin" });
  const afterPush = await checkoutFacts(side);
  assert.equal(afterPush.landed, "contains");
  assert.equal(afterPush.tipElsewhere, "refs/remotes/origin/side-alone");
});

test("a push never overwrites a remote branch that moved on", async () => {
  const side = worktree("side-diverged");
  commit(side, "e.txt", "e\n", "e");
  // Someone else pushed a different commit under the same name.
  const elsewhere = worktree("elsewhere");
  commit(elsewhere, "f.txt", "f\n", "f");
  git(elsewhere, "push", "-q", "origin", "elsewhere:side-diverged");
  await assert.rejects(pushCheckoutBranch(side, { branch: "side-diverged", remote: "origin" }), /没有强推/);
});

test("a push refuses when the checkout moved to another branch", async () => {
  const side = worktree("side-moved");
  await assert.rejects(pushCheckoutBranch(side, { branch: "something-else", remote: "origin" }), /没有推送/);
});

test("branchLandsOn tells merged, cherry-picked and redone work from work still to merge", async () => {
  const landing = worktree("landing");
  const merged = worktree("task-merged", "landing");
  commit(merged, "m.txt", "m\n", "m");
  git(landing, "merge", "-q", "--no-ff", "-m", "merge m", "task-merged");
  const picked = worktree("task-picked", "landing");
  const pick = commit(picked, "p.txt", "p\n", "p");
  git(landing, "cherry-pick", pick);
  const open = worktree("task-open", "landing");
  commit(open, "o.txt", "o\n", "o");

  assert.equal(await currentBranch(landing), "landing");
  assert.equal(await branchLandsOn(main, "task-merged", "landing"), true);
  assert.equal(await branchLandsOn(main, "task-picked", "landing"), true);
  assert.equal(await branchLandsOn(main, "task-open", "landing"), false);
  assert.equal(await branchLandsOn(main, "no-such-branch", "landing"), null);
});
