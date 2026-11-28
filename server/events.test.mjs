import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendLaneEvent, laneEventStats, recentLaneEvents } from "./events.ts";

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "lane-events-"));

test("keeps a lane's events across reads, newest first", () => {
  const dir = tempDir();
  appendLaneEvent(dir, "l1", { at: "2026-11-17T01:00:00Z", kind: "dispatched", workerId: "w1", title: "部署-商城" });
  appendLaneEvent(dir, "l1", { at: "2026-11-17T01:10:00Z", kind: "ended", workerId: "w1", title: "部署-商城" });
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

test("a lane's totals count every dispatch and every card that failed, was interrupted or vanished", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-stats-"));
  try {
    assert.deepEqual(laneEventStats(dir, "l1"), { dispatched: 0, troubles: 0 });
    const at = "2026-11-17T00:00:00.000Z";
    for (const kind of ["dispatched", "dispatched", "ended", "failed", "dispatched", "gone", "answered", "canceled"])
      appendLaneEvent(dir, "l1", { at, kind });
    assert.deepEqual(laneEventStats(dir, "l1"), { dispatched: 3, troubles: 2 });
    appendLaneEvent(dir, "l1", { at, kind: "interrupted" });
    assert.deepEqual(laneEventStats(dir, "l1"), { dispatched: 3, troubles: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
