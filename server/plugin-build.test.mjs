import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readPluginBuild } from "./plugin-build.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("reports the loaded commit and whether tracked files differ from it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-build-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "a.ts"), "1");
  git(dir, "add", "a.ts");
  git(dir, "commit", "-qm", "one");
  const now = new Date("2026-11-17T05:00:00Z");
  assert.deepEqual(readPluginBuild(dir, now), { commit: git(dir, "rev-parse", "--short", "HEAD"), dirty: false, loadedAt: now.toISOString() });
  writeFileSync(path.join(dir, "untracked.ts"), "x");
  assert.equal(readPluginBuild(dir, now).dirty, false);
  writeFileSync(path.join(dir, "a.ts"), "2");
  assert.equal(readPluginBuild(dir, now).dirty, true);
});

test("outside Git there is no commit, and nothing throws", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-build-"));
  assert.equal(readPluginBuild(dir).commit, null);
  assert.equal(readPluginBuild(null).commit, null);
});
