import assert from "node:assert/strict";
import { test } from "node:test";
import { statusFileProblem } from "./container-paths.ts";

const HOME = "/Users/me";
const RULES = [{ provider: "claude-container", dirs: ["~/work/shared-docs"], statusDir: "~/work/container-status" }];
const READ_ONLY_FILE = `${HOME}/work/shared-docs/进度/a.md`;

test("a container worker cannot write its status file under a read-only mount", () => {
  const problem = statusFileProblem(READ_ONLY_FILE, "claude-container/sonnet", RULES, HOME);
  assert.ok(problem);
  assert.match(problem, /work\/container-status/);
});

test("the tilde form is caught as well", () => {
  assert.ok(statusFileProblem("~/work/shared-docs/a.md", "claude-container", RULES, HOME));
});

test("a path that climbs back into the mount is caught", () => {
  assert.ok(statusFileProblem(`${HOME}/work/other/../shared-docs/a.md`, "claude-container", RULES, HOME));
});

test("a writable directory passes", () => {
  assert.equal(statusFileProblem(`${HOME}/work/container-status/a.md`, "claude-container", RULES, HOME), null);
});

test("a sibling that only shares the prefix passes", () => {
  assert.equal(statusFileProblem(`${HOME}/work/shared-docs-old/a.md`, "claude-container", RULES, HOME), null);
});

test("other providers are not affected", () => {
  assert.equal(statusFileProblem(READ_ONLY_FILE, "codex/gpt-6.1-sol", RULES, HOME), null);
});

test("no rules, no check", () => {
  assert.equal(statusFileProblem(READ_ONLY_FILE, "claude-container", [], HOME), null);
});

test("without statusDir the refusal still explains itself", () => {
  const problem = statusFileProblem(READ_ONLY_FILE, "claude-container", [{ provider: "claude-container", dirs: ["~/work/shared-docs"] }], HOME);
  assert.match(problem, /只读/);
});
