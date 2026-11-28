import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { branchPushState, hasLocalBranch, pushBranch } from "./workspace-project.ts";

let temporary;
let remote;
let mine;
let theirs;
const env = { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (directory, ...args) =>
  execFileSync("git", ["-C", directory, "-c", "user.name=Push Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
const commit = (directory, file, message) => {
  writeFileSync(path.join(directory, file), `${message}\n`);
  git(directory, "add", file);
  git(directory, "commit", "-q", "-m", message);
};

before(() => {
  temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-push-")));
  remote = path.join(temporary, "remote.git");
  mine = path.join(temporary, "mine");
  theirs = path.join(temporary, "theirs");
  execFileSync("git", ["init", "-q", "--bare", "-b", "dev", remote], { env });
  execFileSync("git", ["init", "-q", "-b", "dev", mine], { env });
  commit(mine, "a.txt", "base");
  git(mine, "remote", "add", "origin", remote);
  git(mine, "push", "-q", "-u", "origin", "dev");
  execFileSync("git", ["clone", "-q", remote, theirs], { env });
});
after(() => {
  assert.ok(path.basename(temporary).startsWith("paseo-push-"));
  rmSync(temporary, { recursive: true, force: true });
});

test("a local branch is found by name; a remote-only one or a plain folder is not", async () => {
  assert.equal(await hasLocalBranch(mine, "dev"), true);
  assert.equal(await hasLocalBranch(mine, "main"), false);
  assert.equal(await hasLocalBranch(temporary, "dev"), false);
});

test("the push state counts what would go, newest first, and the push sends it", async () => {
  commit(mine, "b.txt", "feat: 商品按分类打折");
  commit(mine, "c.txt", "fix: 折扣为空按 1");
  const state = await branchPushState(mine, "dev");
  assert.equal(state.remote, "origin");
  assert.equal(state.ahead, 2);
  assert.equal(state.behind, 0);
  assert.deepEqual(state.commits.map((item) => item.subject), ["fix: 折扣为空按 1", "feat: 商品按分类打折"]);
  assert.equal(state.fetchError, null);
  await pushBranch(mine, "dev", "origin");
  assert.equal(git(remote, "rev-parse", "dev").trim(), git(mine, "rev-parse", "dev").trim());
  assert.equal((await branchPushState(mine, "dev")).ahead, 0);
});

test("when the remote moved on, the state says so after a fetch and the push is refused, never forced", async () => {
  git(theirs, "pull", "-q", "origin", "dev");
  commit(theirs, "d.txt", "同事的提交");
  git(theirs, "push", "-q", "origin", "dev");
  commit(mine, "e.txt", "本机的提交");
  const state = await branchPushState(mine, "dev");
  assert.equal(state.behind, 1);
  assert.equal(state.ahead, 1);
  await assert.rejects(() => pushBranch(mine, "dev", "origin"), /有本机没有的提交，没有强推/);
  assert.match(git(remote, "log", "-1", "--format=%s", "dev"), /同事的提交/);
});

test("a branch the remote does not have yet counts everything not on the remote as ahead", async () => {
  git(mine, "checkout", "-q", "-b", "feature/x");
  commit(mine, "f.txt", "新功能");
  git(mine, "checkout", "-q", "dev");
  const state = await branchPushState(mine, "feature/x");
  assert.equal(state.fetchError, null);
  assert.equal(state.ahead, 2);
  assert.equal(state.behind, 0);
  await pushBranch(mine, "feature/x", "origin");
  assert.equal(git(remote, "rev-parse", "feature/x").trim(), git(mine, "rev-parse", "feature/x").trim());
});
