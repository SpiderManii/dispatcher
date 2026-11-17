import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendLaneEvent, recentLaneEvents } from "./events.ts";

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "lane-events-"));

test("keeps a lane's events across reads, newest first", () => {
  const dir = tempDir();
  appendLaneEvent(dir, "l1", { at: "2026-11-17T01:00:00Z", kind: "dispatched", workerId: "w1", title: "部署-网关" });
  appendLaneEvent(dir, "l1", { at: "2026-11-17T01:10:00Z", kind: "ended", workerId: "w1", title: "部署-网关" });
  appendLaneEvent(dir, "l2", { at: "2026-11-17T01:05:00Z", kind: "answered", detail: "按推荐" });
  assert.deepEqual(
    recentLaneEvents(dir, "l1", 10).map((event) => event.kind),
    ["ended", "dispatched"],
  );
  assert.equal(recentLaneEvents(dir, "l2", 10)[0].detail, "按推荐");
  assert.deepEqual(recentLaneEvents(dir, "missing", 10), []);
});

test("returns only the newest events up to the limit and skips broken lines", () => {
  const dir = tempDir();
  for (let index = 0; index < 5; index += 1)
    appendLaneEvent(dir, "l1", { at: `2026-11-17T01:0${index}:00Z`, kind: "ended", workerId: `w${index}` });
  writeFileSync(path.join(dir, "l1.jsonl"), `${readFileSync(path.join(dir, "l1.jsonl"), "utf8")}not json\n`);
  assert.deepEqual(
    recentLaneEvents(dir, "l1", 2).map((event) => event.workerId),
    ["w4", "w3"],
  );
});
