import assert from "node:assert/strict";
import { test } from "node:test";
import { RETIRE_AFTER_MS, finishedWorkers } from "./worker-retire.ts";

const T = 10_000_000;
const worker = (id, over = {}) => ({ id, status: "idle", archived: false, updatedAt: T - RETIRE_AFTER_MS, ...over });

test("an idle worker is archived once it has been quiet for 5 minutes", () => {
  assert.deepEqual(finishedWorkers([worker("a")], new Set(), T), ["a"]);
  assert.deepEqual(finishedWorkers([worker("a", { updatedAt: T - RETIRE_AFTER_MS + 1 })], new Set(), T), []);
});

test("running, archived and unknown-age workers stay", () => {
  const list = [worker("r", { status: "running" }), worker("x", { archived: true }), worker("u", { updatedAt: null }), worker("e", { status: "error" })];
  assert.deepEqual(finishedWorkers(list, new Set(), T), []);
});

test("a worker whose result has not reached the dispatcher yet stays", () => {
  assert.deepEqual(finishedWorkers([worker("a"), worker("b")], new Set(["a"]), T), ["b"]);
});

test("closed workers go too", () => {
  assert.deepEqual(finishedWorkers([worker("c", { status: "closed" })], new Set(), T), ["c"]);
});
