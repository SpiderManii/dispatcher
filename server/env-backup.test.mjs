// Run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { backupEnvFiles, envFilesOf, safeSegment } from "./env-backup.ts";

test("only env files are picked, not templates, folders or build output", () => {
  const picked = envFilesOf([".env", "ui/.env.local", ".env.example", "rust-core/target", "src/environment.py", ".envrc", "a/.env.production"]);
  assert.deepEqual(picked, [".env", "ui/.env.local", "a/.env.production"]);
});

test("copies keep their relative paths, content and owner-only mode", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "envbk-"));
  const source = path.join(tmp, "wt");
  mkdirSync(path.join(source, "ui"), { recursive: true });
  writeFileSync(path.join(source, ".env"), "A=1\n");
  writeFileSync(path.join(source, "ui", ".env.local"), "B=2\n");
  const result = backupEnvFiles(source, [".env", "ui/.env.local"], path.join(tmp, "bk"), "run1");
  assert.deepEqual(result.files, [".env", "ui/.env.local"]);
  assert.equal(readFileSync(path.join(tmp, "bk", "run1", "ui", ".env.local"), "utf8"), "B=2\n");
  assert.equal(statSync(path.join(tmp, "bk", "run1", ".env")).mode & 0o777, 0o600);
});

test("nothing to copy gives null, and a file that vanished is skipped", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "envbk-"));
  assert.equal(backupEnvFiles(tmp, [".env"], path.join(tmp, "bk"), "run"), null);
  assert.equal(backupEnvFiles(tmp, [], path.join(tmp, "bk"), "run"), null);
});

test("a symlink is never followed out of the directory", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "envbk-"));
  const source = path.join(tmp, "wt");
  mkdirSync(source);
  writeFileSync(path.join(tmp, "secret"), "X=1\n");
  symlinkSync(path.join(tmp, "secret"), path.join(source, ".env"));
  assert.equal(backupEnvFiles(source, [".env"], path.join(tmp, "bk"), "run"), null);
});

test("a branch name becomes one folder name", () => {
  assert.equal(safeSegment("feat/new-billing"), "feat__new-billing");
  assert.equal(safeSegment("..hidden"), "_hidden");
  assert.equal(safeSegment(""), "_");
});

test("the same branch with unchanged files is not copied again; a change is", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "envbk-"));
  const source = path.join(tmp, "wt");
  mkdirSync(source);
  writeFileSync(path.join(source, ".env"), "A=1\n");
  const root = path.join(tmp, "bk");
  const first = backupEnvFiles(source, [".env"], root, "proj/feat__x/20261110-100000");
  assert.equal(first.unchanged, false);
  const again = backupEnvFiles(source, [".env"], root, "proj/feat__x/20261110-110000");
  assert.equal(again.unchanged, true);
  assert.equal(again.directory, first.directory);
  writeFileSync(path.join(source, ".env"), "A=2\n");
  const changed = backupEnvFiles(source, [".env"], root, "proj/feat__x/20261110-120000");
  assert.equal(changed.unchanged, false);
  assert.equal(readFileSync(path.join(root, "proj", "feat__x", "20261110-120000", ".env"), "utf8"), "A=2\n");
  const other = backupEnvFiles(source, [".env"], root, "proj/other/20261110-130000");
  assert.equal(other.unchanged, false);
});
