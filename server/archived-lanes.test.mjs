// core.ts uses a parameter property, so run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { allLanes, endedLaneKeys, endedLaneParents, releaseArchivedLanes, startedByLane } from "./core.ts";

const NOW = new Date("2026-11-09T09:00:00.000Z");
const lane = (id, agentId, pendingHandoff = null) => ({ id, agentId, pendingHandoff, projects: [{ key: id, name: id, path: "" }] });
const stateWith = (...lanes) => ({
  dispatchers: {
    global: {
      lanes,
      history: lanes.map((item) => ({ agentId: item.agentId, laneId: item.id, startedAt: "2026-11-09T08:00:00.000Z", endedAt: null, reason: "新建" })),
    },
  },
});

test("an archived session gives back its seat and projects", () => {
  const state = stateWith(lane("a", "agent-a"), lane("b", "agent-b"));
  const released = releaseArchivedLanes(state, new Set(["agent-a"]), NOW);
  assert.deepEqual(released.map((item) => item.id), ["a"]);
  assert.deepEqual(allLanes(state).map(({ lane: item }) => item.id), ["b"]);
  const history = state.dispatchers.global.history;
  assert.equal(history.find((item) => item.agentId === "agent-a").endedAt, NOW.toISOString());
  assert.equal(history.find((item) => item.agentId === "agent-b").endedAt, null);
});

test("nothing archived changes nothing", () => {
  const state = stateWith(lane("a", "agent-a"));
  assert.deepEqual(releaseArchivedLanes(state, new Set(), NOW), []);
  assert.equal(allLanes(state).length, 1);
});

test("a lane waiting on a handoff stays, because the successor still needs it", () => {
  const state = stateWith(lane("a", "agent-a", { fromAgentId: "agent-a" }));
  assert.deepEqual(releaseArchivedLanes(state, new Set(["agent-a"]), NOW), []);
  assert.equal(allLanes(state).length, 1);
});

test("the sessions of an ended lane are parents, including the one it took over from", () => {
  const state = stateWith(lane("a", "agent-new"));
  state.dispatchers.global.history.unshift({ agentId: "agent-old", laneId: "a", startedAt: "2026-11-09T07:00:00.000Z", endedAt: "2026-11-09T08:00:00.000Z", reason: "新建" });
  releaseArchivedLanes(state, new Set(["agent-new"]), NOW);
  assert.deepEqual(endedLaneParents(state, "agent-new").sort(), ["agent-new", "agent-old"]);
  assert.deepEqual(endedLaneParents(state, "agent-old").sort(), ["agent-new", "agent-old"]);
});

test("workers stay while their lane lives on, so archiving an old session after a handoff leaves them", () => {
  const state = stateWith(lane("a", "agent-new"));
  state.dispatchers.global.history.unshift({ agentId: "agent-old", laneId: "a", startedAt: "2026-11-09T07:00:00.000Z", endedAt: "2026-11-09T08:00:00.000Z", reason: "新建" });
  assert.equal(endedLaneParents(state, "agent-old"), null);
  assert.equal(endedLaneParents(state, "agent-new"), null);
});

test("sessions the plugin never dispatched for are not its business", () => {
  assert.equal(endedLaneParents(stateWith(lane("a", "agent-a")), "someone-else"), null);
});

test("a session from before lanes existed only speaks for itself", () => {
  const state = stateWith();
  state.dispatchers.global.history.push({ agentId: "legacy", startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-02T00:00:00.000Z", reason: "启动" });
  assert.deepEqual(endedLaneParents(state, "legacy"), ["legacy"]);
});

test("an ended lane whose sessions are all archived is listed by dispatcher and lane", () => {
  const state = stateWith(lane("live", "agent-live"));
  state.dispatchers.global.history.push({ agentId: "old", laneId: "gone", startedAt: "x", endedAt: "y", reason: "新建" });
  assert.deepEqual([...endedLaneKeys(state, new Set(["old"]))], ["global/gone"]);
  assert.deepEqual([...endedLaneKeys(state, new Set())], []);
  assert.deepEqual([...endedLaneKeys(state, new Set(["agent-live"]))], []);
});

test("workers are matched by lane label, but a dispatcher session never is", () => {
  const keys = new Set(["global/gone"]);
  const worker = { "dispatch-center/work-role": "backend", "dispatch-center/dispatcher": "global", "dispatch-center/lane": "gone" };
  assert.equal(startedByLane(worker, keys), true);
  assert.equal(startedByLane({ ...worker, "dispatch-center/lane": "other" }, keys), false);
  assert.equal(startedByLane({ "dispatch-center/dispatcher": "global", "dispatch-center/lane": "gone" }, keys), false);
  assert.equal(startedByLane(worker, new Set()), false);
});
