import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_ENDED_NOTICES,
  MAX_INLINE_STATUS,
  MAX_SEND_ATTEMPTS,
  MAX_STATUS_FAILURES,
  REPEAT_WINDOW_MS,
  STUCK_MS,
  emptyWatch,
  noticeText,
  recordDispatched,
  recordTurnEnd,
  scanWorkers,
} from "./worker-watch.ts";

const T0 = Date.parse("2026-11-09T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function world(overrides = {}) {
  const io = {
    running: [],
    statuses: {},
    dispatcher: "idle",
    targets: { dispatcher: { key: "global:l1", agentId: "dispatcher", laneId: "l1", handoffPending: false } },
    sent: [],
    logs: [],
    time: T0,
    sendError: null,
    runningWorkers: async () => io.running,
    workerStatus: async (id) => {
      const value = io.statuses[id];
      if (value instanceof Error) throw value;
      return value ?? null;
    },
    findTarget: async (parent) => io.targets[parent] ?? null,
    dispatcherStatus: async () => io.dispatcher,
    send: async (agentId, text) => {
      if (io.sendError) throw new Error(io.sendError);
      io.sent.push({ agentId, text });
    },
    files: {},
    readStatusFile: async (file) => {
      const value = io.files[file];
      if (value instanceof Error) throw value;
      return value ?? null;
    },
    log: (line) => io.logs.push(line),
    now: () => io.time,
    ...overrides,
  };
  return io;
}

const worker = (overrides = {}) => ({
  id: "w1",
  provider: "claude-container",
  parentAgentId: "dispatcher",
  title: "前端-修复-页面",
  lastActivityAt: iso(T0),
  turnStartedAt: iso(T0),
  ...overrides,
});
const idle = { status: "idle", lastError: null };

test("a running worker wakes nobody", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 0);
  assert.ok(state.workers.w1);
});

test("a worker that stops is reported to its dispatcher on the next scan", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 1);
  assert.equal(io.sent[0].agentId, "dispatcher");
  assert.match(io.sent[0].text, /w1.*本轮已结束/);
  assert.deepEqual(state.workers, {});
  assert.deepEqual(state.notices, []);
});

test("every provider is watched, not only the container", async () => {
  const io = world({ running: [worker({ provider: "antigravity" })] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 1);
});

test("an unreadable running list changes nothing, so no worker is falsely reported as ended", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  const before = JSON.stringify(state);
  io.runningWorkers = async () => {
    throw new Error("daemon busy");
  };
  await assert.rejects(scanWorkers(state, io), /daemon busy/);
  assert.equal(JSON.stringify(state), before);
  assert.equal(io.sent.length, 0);
});

test("a busy dispatcher is not interrupted, and the notice goes out once it is idle", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = idle;
  io.dispatcher = "running";
  await scanWorkers(state, io);
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 0);
  assert.equal(state.notices.length, 1);
  io.dispatcher = "idle";
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 1);
  assert.equal(state.notices.length, 0);
});

test("a pending notice and a watched worker survive a reload", async () => {
  const io = world({ running: [worker(), worker({ id: "w2" })] });
  let state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [worker({ id: "w2" })];
  io.statuses.w1 = idle;
  io.dispatcher = "running";
  await scanWorkers(state, io);
  state = JSON.parse(JSON.stringify(state));
  io.dispatcher = "idle";
  await scanWorkers(state, io);
  assert.match(io.sent[0].text, /w1/);
  assert.ok(state.workers.w2);
});

test("workers ending together on one lane produce a single wake-up", async () => {
  const io = world({ running: [worker(), worker({ id: "w2" })] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = idle;
  io.statuses.w2 = idle;
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 1);
  assert.match(io.sent[0].text, /w1/);
  assert.match(io.sent[0].text, /w2/);
});

test("a dispatcher that has handed off is never woken", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.targets.dispatcher.handoffPending = true;
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 0);
  assert.equal(state.notices.length, 0);
  assert.ok(io.logs.some((line) => line.includes("换班中")));
});

test("the notice reaches the lane's successor rather than the retired parent", async () => {
  const io = world({ running: [worker()] });
  io.targets.dispatcher.agentId = "successor";
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  assert.equal(io.sent[0].agentId, "successor");
});

test("sessions not started by a dispatcher are left alone", async () => {
  const io = world({ running: [worker({ parentAgentId: "someone-else" })] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  assert.deepEqual(state, emptyWatch());
  assert.equal(io.logs.length, 0);
});

test("a canceled worker is not reported", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  await recordTurnEnd(state, { workerId: "w1", parentAgentId: "dispatcher", provider: "claude-container", outcome: { kind: "canceled" } }, io);
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 0);
});

test("a failed turn is reported with its message", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  await recordTurnEnd(state, { workerId: "w1", parentAgentId: "dispatcher", provider: "claude-container", outcome: { kind: "failed", message: "boom" } }, io);
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  assert.match(io.sent[0].text, /失败：boom/);
});

test("without the hook, an error status or lastError still counts as failed", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = { status: "idle", lastError: "bridge lost" };
  await scanWorkers(state, io);
  assert.match(io.sent[0].text, /失败：bridge lost/);
});

test("a stale error does not override a turn the hook saw complete", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  await recordTurnEnd(state, { workerId: "w1", parentAgentId: "dispatcher", provider: "claude-container", outcome: { kind: "completed" } }, io);
  io.running = [];
  io.statuses.w1 = { status: "idle", lastError: "old error" };
  await scanWorkers(state, io);
  assert.match(io.sent[0].text, /本轮已结束/);
});

test("a worker too short-lived for any scan is still caught through the hook", async () => {
  const io = world();
  const state = emptyWatch();
  await recordTurnEnd(state, { workerId: "w9", parentAgentId: "dispatcher", provider: "claude-container", outcome: { kind: "completed" } }, io);
  io.statuses.w9 = idle;
  await scanWorkers(state, io);
  assert.match(io.sent[0].text, /w9/);
});

test("the hook ignores sessions no dispatcher started", async () => {
  const io = world();
  const state = emptyWatch();
  await recordTurnEnd(state, { workerId: "w9", parentAgentId: null, provider: "x", outcome: { kind: "completed" } }, io);
  await recordTurnEnd(state, { workerId: "w9", parentAgentId: "someone-else", provider: "x", outcome: { kind: "completed" } }, io);
  assert.deepEqual(state, emptyWatch());
});

test("a worker still shown as running when the hook fires is not reported until it really stops", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.time = T0 + 1000;
  await recordTurnEnd(state, { workerId: "w1", parentAgentId: "dispatcher", provider: "claude-container", outcome: { kind: "completed" } }, io);
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 0);
  assert.ok(state.workers.w1.outcome);
});

test("a worker sent back to work drops the old outcome, so a canceled turn doesn't silence the next one", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.time = T0 + 1000;
  await recordTurnEnd(state, { workerId: "w1", parentAgentId: "dispatcher", provider: "claude-container", outcome: { kind: "canceled" } }, io);
  io.running = [worker({ turnStartedAt: iso(T0 + 5000) })];
  await scanWorkers(state, io);
  assert.equal(state.workers.w1.outcome, null);
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 1);
});

test("a vanished worker is reported as gone", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  await scanWorkers(state, io);
  assert.match(io.sent[0].text, /会话已不存在/);
});

test("an archived worker was dealt with by someone, so it is not reported", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = { status: "archived", lastError: null };
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 0);
});

test("a momentary status error keeps the worker watched; repeated errors count as gone", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = new Error("timeout");
  for (let i = 1; i < MAX_STATUS_FAILURES; i += 1) {
    await scanWorkers(state, io);
    assert.ok(state.workers.w1);
    assert.equal(io.sent.length, 0);
  }
  await scanWorkers(state, io);
  assert.match(io.sent[0].text, /会话已不存在/);
});

test("a worker with no activity for an hour is flagged once, and again only after it moved", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.time = T0 + STUCK_MS;
  await scanWorkers(state, io);
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 1);
  assert.match(io.sent[0].text, /疑似卡死/);
  io.running = [worker({ lastActivityAt: iso(T0 + STUCK_MS) })];
  await scanWorkers(state, io);
  assert.equal(state.workers.w1.stuckNotified, false);
  io.time = T0 + 2 * STUCK_MS;
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 2);
});

test("a failed send retries on later scans, then gives up and leaves it to the heartbeat", async () => {
  const io = world({ running: [worker()], sendError: "bridge down" });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = idle;
  for (let i = 1; i < MAX_SEND_ATTEMPTS; i += 1) {
    await scanWorkers(state, io);
    assert.equal(state.notices.length, 1);
  }
  await scanWorkers(state, io);
  assert.equal(state.notices.length, 0);
  assert.ok(io.logs.some((line) => line.includes("交给心跳")));
});

test("a retry that succeeds delivers the notice", async () => {
  const io = world({ running: [worker()], sendError: "bridge down" });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  io.sendError = null;
  await scanWorkers(state, io);
  assert.equal(io.sent.length, 1);
  assert.equal(state.notices.length, 0);
});

async function dispatchedAndEnded(io) {
  const state = emptyWatch();
  recordDispatched(state, { id: "w1", provider: "claude-container", parentAgentId: "dispatcher", title: "前端-修复-页面", statusFile: "/s/a.md" }, io);
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  return state;
}

test("the status file rides along in the notice, so the dispatcher has nothing to read", async () => {
  const io = world();
  io.files["/s/a.md"] = "状态: 待验收\nSHA: abc123\n";
  await dispatchedAndEnded(io);
  assert.match(io.sent[0].text, /不用再读/);
  assert.match(io.sent[0].text, /SHA: abc123/);
});

test("a missing or unreadable status file still sends the notice, without promising content", async () => {
  for (const value of [undefined, new Error("EACCES")]) {
    const io = world();
    if (value) io.files["/s/a.md"] = value;
    await dispatchedAndEnded(io);
    assert.equal(io.sent.length, 1);
    assert.doesNotMatch(io.sent[0].text, /不用再读/);
  }
});

test("an oversized status file is left for the dispatcher to open", async () => {
  const io = world();
  io.files["/s/a.md"] = "x".repeat(MAX_INLINE_STATUS + 1);
  await dispatchedAndEnded(io);
  assert.doesNotMatch(io.sent[0].text, /不用再读/);
  assert.ok(io.sent[0].text.length < MAX_INLINE_STATUS);
});

test("a scan seeing the worker first keeps the status file recorded afterwards", async () => {
  const io = world({ running: [worker()] });
  io.files["/s/a.md"] = "状态: 待验收";
  const state = emptyWatch();
  await scanWorkers(state, io);
  recordDispatched(state, { id: "w1", provider: "claude-container", parentAgentId: "dispatcher", title: "t", statusFile: "/s/a.md" }, io);
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
  assert.match(io.sent[0].text, /状态: 待验收/);
});

test("the notice tells the dispatcher to verify, not investigate", () => {
  const text = noticeText([{ workerId: "w1", title: null, provider: "x", parentAgentId: "p", kind: "ended", detail: null, attempts: 0 }]);
  assert.match(text, /第 8 节/);
  assert.match(text, /本线台账/);
  assert.match(text, /不自己排查/);
});

test("a dispatcher knocked into error by a brief outage still gets the notice", async () => {
  const io = world({ running: [worker()] });
  const state = emptyWatch();
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = idle;
  io.dispatcher = "error";
  await scanWorkers(state, io);
  assert.equal(state.notices.length, 0);
  assert.equal(io.sent.length, 1);
});

async function finishTurn(state, io) {
  io.running = [worker()];
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = idle;
  await scanWorkers(state, io);
}

test("a worker that keeps finishing stops waking the dispatcher, after one warning", async () => {
  const io = world();
  const state = emptyWatch();
  for (let i = 0; i < MAX_ENDED_NOTICES + 4; i += 1) await finishTurn(state, io);
  assert.equal(io.sent.length, MAX_ENDED_NOTICES);
  assert.doesNotMatch(io.sent[MAX_ENDED_NOTICES - 2].text, /不再通知/);
  assert.match(io.sent[MAX_ENDED_NOTICES - 1].text, /不再通知/);
  assert.ok(io.logs.some((line) => line.startsWith("不通知：w1 30 分钟内已结束")));
});

test("the count starts over once the window has passed, so later rework is reported", async () => {
  const io = world();
  const state = emptyWatch();
  for (let i = 0; i < MAX_ENDED_NOTICES + 1; i += 1) await finishTurn(state, io);
  assert.equal(io.sent.length, MAX_ENDED_NOTICES);
  io.time += REPEAT_WINDOW_MS + 1;
  await finishTurn(state, io);
  assert.equal(io.sent.length, MAX_ENDED_NOTICES + 1);
});

test("old endings are forgotten, so the state file doesn't grow forever", async () => {
  const io = world();
  const state = emptyWatch();
  await finishTurn(state, io);
  io.time += REPEAT_WINDOW_MS + 1;
  io.running = [worker({ id: "w2" })];
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w2 = idle;
  await scanWorkers(state, io);
  assert.deepEqual(Object.keys(state.endings), ["w2"]);
});

test("one worker's repeats don't silence another", async () => {
  const io = world();
  const state = emptyWatch();
  for (let i = 0; i < MAX_ENDED_NOTICES + 1; i += 1) await finishTurn(state, io);
  io.running = [worker({ id: "w2" })];
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w2 = idle;
  await scanWorkers(state, io);
  assert.equal(io.sent.length, MAX_ENDED_NOTICES + 1);
});

test("a failure is always reported, however often the worker has finished", async () => {
  const io = world();
  const state = emptyWatch();
  for (let i = 0; i < MAX_ENDED_NOTICES + 1; i += 1) await finishTurn(state, io);
  io.running = [worker()];
  await scanWorkers(state, io);
  io.running = [];
  io.statuses.w1 = { status: "error", lastError: "boom" };
  await scanWorkers(state, io);
  assert.equal(io.sent.length, MAX_ENDED_NOTICES + 1);
  assert.match(io.sent.at(-1).text, /失败/);
});
