// Run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideApproval } from "./auto-approve.ts";

const ask = (over) => decideApproval({ kind: "tool", inDispatcherDir: true, text: "ls -la", ...over });

test("a plain tool call in a dispatcher session is approved", () => {
  assert.equal(ask({}), "allow");
  assert.equal(ask({ text: "paseo ls --json | head -c 8000" }), "allow");
  assert.equal(ask({ text: "rg -n worktree PROJECT.md" }), "allow");
});

test("anything outside a dispatcher directory is left to the user", () => {
  assert.equal(ask({ inDispatcherDir: false }), "ask");
});

test("questions, plans and mode switches are never approved for the user", () => {
  for (const kind of ["question", "plan", "mode", "other"]) assert.equal(ask({ kind }), "ask");
});

test("commands that destroy work or leave the machine stay with the user", () => {
  for (const text of [
    "rm -rf /tmp/x",
    "rm -fr build",
    "git push origin feat/x",
    "git push --force",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git checkout -- .",
    "git branch -D old",
    "git worktree remove .worktrees/a",
    "paseo delete abc",
    "paseo project delete prj_1",
    "psql -c 'DROP TABLE users'",
  ])
    assert.equal(ask({ text }), "ask", text);
});

test("look-alikes are not caught: a path or word that merely contains the letters", () => {
  assert.equal(ask({ text: "cat docs/pushing.md" }), "allow");
  assert.equal(ask({ text: "git status && git log --oneline" }), "allow");
  assert.equal(ask({ text: "rm notes.txt" }), "allow");
});
