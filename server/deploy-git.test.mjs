import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { branchHead, onBranch } from "./workspace-project.ts";

let temporary;
let repo;
const env = { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=Deploy Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
const commit = (file, message) => {
  writeFileSync(path.join(repo, file), `${message}\n`);
  git("add", file);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD").trim();
};

let base;
let tip;
let side;

before(() => {
  temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-deploy-")));
  repo = path.join(temporary, "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", repo], { env });
  base = commit("a.txt", "base");
  tip = commit("b.txt", "feat: 商品按分类打折设置");
  git("checkout", "-q", "-b", "feature", base);
  side = commit("c.txt", "wip");
  git("checkout", "-q", "dev");
});
after(() => {
  assert.ok(path.basename(temporary).startsWith("paseo-deploy-"));
  rmSync(temporary, { recursive: true, force: true });
});

test("the landing branch's tip comes with its full SHA and subject", async () => {
  const head = await branchHead(repo, "dev");
  assert.equal(head.sha, tip);
  assert.equal(head.subject, "feat: 商品按分类打折设置");
  assert.ok(Date.parse(head.committedAt) > 0);
});

test("a missing branch or a plain folder has no head", async () => {
  assert.equal(await branchHead(repo, "nope"), null);
  assert.equal(await branchHead(temporary, "dev"), null);
});

test("only commits the landing branch contains may be deployed from the page", async () => {
  assert.equal(await onBranch(repo, tip, "dev"), true);
  assert.equal(await onBranch(repo, base, "dev"), true);
  assert.equal(await onBranch(repo, side, "dev"), false);
  assert.equal(await onBranch(repo, "0".repeat(40), "dev"), false);
  assert.equal(await onBranch(repo, tip, "nope"), false);
});
