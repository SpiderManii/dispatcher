import assert from "node:assert/strict";
import { test } from "node:test";
import { newQueueId, planRoute, queueWait } from "./core.ts";

const limits = { sessions: 3, sessionsPerProject: 2, agents: 3, claudeAgents: 2 };
const gateway = { key: "gateway", name: "商城", path: "/repo/gw" };
const web = { key: "frontend", name: "前端", path: "/repo/web" };
const lane = (id, projects) => ({
  id,
  agentId: `agent-${id}`,
  workspaceId: null,
  projects,
  summary: null,
  ledgerPath: `/l/${id}.md`,
  startedAt: "2026-11-17T00:00:00.000Z",
  rulesHash: null,
  pendingHandoff: null,
});
const stateWith = (...lanes) => ({
  version: 1,
  dispatchers: { global: { workspaceId: null, lanes, lastError: null, pushableKept: [], history: [] } },
  queue: [],
});

test("a requirement waits while every lane is taken, and says how many run", () => {
  const state = stateWith(lane("a", [web]), lane("b", [web]), lane("c", [gateway]));
  assert.equal(queueWait(state, [gateway], limits), "等名额：3/3 个需求在并行");
});

test("a requirement waits for its own project only; another project's requirement may go first", () => {
  const state = stateWith(lane("a", [gateway]), lane("b", [gateway]));
  assert.equal(queueWait(state, [gateway], limits), "等「商城」空出来：同一项目最多 2 个需求");
  assert.equal(queueWait(state, [web], limits), null);
  assert.equal(queueWait(state, [web, gateway], limits), "等「商城」空出来：同一项目最多 2 个需求");
});

test("whenever the queue says it fits, the route for a new lane agrees", () => {
  const states = [stateWith(), stateWith(lane("a", [gateway])), stateWith(lane("a", [gateway]), lane("b", [web]))];
  for (const state of states)
    for (const projects of [[gateway], [web], [gateway, web]]) {
      if (queueWait(state, projects, limits) !== null) continue;
      const route = planRoute({ state, dispatcherId: "global", projects, limits, newLane: true, confirmIndependent: true });
      assert.equal(route.kind, "new");
    }
});

test("and whenever it says wait, the route refuses for the same reason", () => {
  const full = stateWith(lane("a", [gateway]), lane("b", [gateway]));
  assert.throws(
    () => planRoute({ state: full, dispatcherId: "global", projects: [gateway], limits, newLane: true, confirmIndependent: true }),
    (error) => error.code === "project-full",
  );
  const packed = stateWith(lane("a", [web]), lane("b", [web]), lane("c", [gateway]));
  assert.throws(
    () => planRoute({ state: packed, dispatcherId: "global", projects: [gateway], limits, newLane: true, confirmIndependent: true }),
    (error) => error.code === "sessions-full",
  );
});

test("queue IDs do not repeat, even within the same millisecond", () => {
  const now = new Date("2026-11-17T08:00:00.000Z");
  const state = stateWith();
  const first = newQueueId(state, now);
  state.queue.push({ id: first });
  const second = newQueueId(state, now);
  assert.notEqual(first, second);
  assert.match(first, /^q[0-9a-z]{6}$/);
  assert.equal(typeof newQueueId({ version: 1, dispatchers: {} }, now), "string");
});
