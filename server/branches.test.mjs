import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { listBranches, resolveBranchChoice } from "./workspace-project.ts";

let root;
let repo;
let worktree;
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();

before(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "branches-")));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "dev");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
  git("branch", "plain");
  worktree = path.join(root, "wt");
  git("worktree", "add", "-q", "-b", "feature", worktree);
});
after(() => rmSync(root, { recursive: true, force: true }));

test("branches come back with the checked-out one first and their worktrees", async () => {
  const branches = await listBranches(repo);
  assert.equal(branches[0].name, "dev");
  assert.equal(branches[0].current, true);
  assert.equal(branches[0].worktree, repo);
  assert.deepEqual(new Set(branches.map((item) => item.name)), new Set(["dev", "plain", "feature"]));
  assert.equal(branches.find((item) => item.name === "plain").worktree, null);
  assert.equal(branches.find((item) => item.name === "feature").worktree, worktree);
});

test("listing from a worktree sees the same branches, with its own as current", async () => {
  const branches = await listBranches(worktree);
  assert.equal(branches[0].name, "feature");
  assert.equal(branches.length, 3);
});

test("a folder outside Git has no branches rather than an error", async () => {
  const plain = path.join(root, "plain-dir");
  mkdirSync(plain);
  assert.deepEqual(await listBranches(plain), []);
  assert.deepEqual(await listBranches(path.join(root, "missing")), []);
});

test("listing changes nothing in the repository", async () => {
  const before = git("status", "--porcelain=v2", "--branch");
  await listBranches(repo);
  assert.equal(git("status", "--porcelain=v2", "--branch"), before);
});

test("an existing branch resolves with its worktree", async () => {
  assert.deepEqual(await resolveBranchChoice(repo, { name: "feature" }), { name: "feature", base: null, worktree });
  assert.deepEqual(await resolveBranchChoice(repo, { name: "plain" }), { name: "plain", base: null, worktree: null });
});

test("a branch deleted since the list was fetched is refused", async () => {
  await assert.rejects(resolveBranchChoice(repo, { name: "gone" }), /不存在/);
});

test("a new branch resolves with its base and creates nothing", async () => {
  assert.deepEqual(await resolveBranchChoice(repo, { name: "feat/new", base: "dev" }), {
    name: "feat/new",
    base: "dev",
    worktree: null,
  });
  assert.equal((await listBranches(repo)).some((item) => item.name === "feat/new"), false);
});

test("a new branch can't reuse a name, use a bad name, or start from nothing", async () => {
  await assert.rejects(resolveBranchChoice(repo, { name: "plain", base: "dev" }), /已存在/);
  await assert.rejects(resolveBranchChoice(repo, { name: "has space", base: "dev" }), /不合法/);
  await assert.rejects(resolveBranchChoice(repo, { name: "--upload-pack=x", base: "dev" }), /不合法/);
  await assert.rejects(resolveBranchChoice(repo, { name: "ok", base: "gone" }), /基线分支/);
});
