// core.ts uses a parameter property, so run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { laneProject, planRoute, sharedNotice, targetBlock } from "./core.ts";

const limits = { sessions: 5, sessionsPerProject: 2, agents: 3, claudeAgents: 2 };
const project = (branch) => ({ key: "shop", name: "网关", path: "/repo", ...(branch ? { branch } : {}) });
const lane = (id, branch) => ({
  id,
  agentId: `agent-${id}`,
  projects: [project(branch)],
  summary: null,
  ledgerPath: `/l/${id}.md`,
  startedAt: "2026-11-09T00:00:00.000Z",
  rulesHash: null,
  pendingHandoff: null,
});
const stateWith = (...lanes) => ({
  version: 1,
  dispatchers: { global: { workspaceId: null, lanes, lastError: null, history: [] } },
});
const route = (state, projects, extra) =>
  planRoute({ state, dispatcherId: "global", projects, limits, ...extra });

test("a new lane on a branch another lane holds needs confirmation, then goes ahead", () => {
  const state = stateWith(lane("a", "feature"));
  assert.throws(() => route(state, [project("feature")], { newLane: true }), (error) => error.code === "needs-confirm");
  const planned = route(state, [project("feature")], { newLane: true, confirmIndependent: true });
  assert.equal(planned.kind, "new");
  assert.deepEqual(planned.shared.map(({ holder }) => holder.lane.id), ["a"]);
});

test("a lane sharing a branch is told to work on a temporary branch and merge back", () => {
  const state = stateWith(lane("a", "feature"));
  const { shared } = route(state, [project("feature")], { newLane: true, confirmIndependent: true });
  const notice = sharedNotice(shared);
  assert.match(notice, /两条线都在分支 feature 上/);
  assert.match(notice, /临时分支 `feature-<本线 ID>`/);
  assert.match(notice, /squash 合回 feature/);
});

test("a lane on a different branch gets no temporary-branch instruction", () => {
  const state = stateWith(lane("a", "feature"));
  const { shared } = route(state, [project("other")], { newLane: true, confirmIndependent: true });
  assert.doesNotMatch(sharedNotice(shared), /临时分支/);
});

test("a different branch on the same project only needs the usual confirmation", () => {
  const state = stateWith(lane("a", "feature"));
  assert.throws(() => route(state, [project("other")], { newLane: true }), (error) => error.code === "needs-confirm");
  assert.equal(route(state, [project("other")], { newLane: true, confirmIndependent: true }).kind, "new");
});

test("sending to the lane that holds the branch is fine", () => {
  const state = stateWith(lane("a", "feature"));
  assert.equal(route(state, [project("feature")], { laneId: "a" }).kind, "send");
});

test("sending to a lane onto a branch another lane holds needs confirmation", () => {
  const state = stateWith(lane("a", "feature"), lane("b", "other"));
  assert.throws(() => route(state, [project("feature")], { laneId: "b" }), (error) => error.code === "needs-confirm");
  const planned = route(state, [project("feature")], { laneId: "b", confirmIndependent: true });
  assert.equal(planned.kind, "send");
  assert.deepEqual(planned.shared.map(({ holder }) => holder.lane.id), ["a"]);
});

test("the implicit route goes to the lane covering the project", () => {
  const state = stateWith(lane("a", "feature"), { ...lane("b"), projects: [] });
  assert.equal(route(state, [project("feature")], {}).kind, "send");
  const other = stateWith(lane("a", "other"), { ...lane("b", "feature"), projects: [{ ...project("feature"), key: "x" }] });
  assert.equal(route(other, [project("feature")], {}).kind, "send");
});

test("with no branch chosen nothing changes, including for lanes that never recorded one", () => {
  const state = stateWith(lane("a"));
  assert.equal(route(state, [project()], { newLane: true, confirmIndependent: true }).kind, "new");
  assert.equal(route(state, [project("feature")], { newLane: true, confirmIndependent: true }).kind, "new");
});

test("the project limit still applies", () => {
  const state = stateWith(lane("a", "x"), lane("b", "y"));
  assert.throws(() => route(state, [project("z")], { newLane: true, confirmIndependent: true }), (error) => error.code === "project-full");
});

test("a chosen branch is stored on the lane's project, and absent otherwise", () => {
  const target = { path: "/repo", name: "网关", projectId: "shop", owner: "global", projectDoc: null, statusDir: null };
  assert.equal(laneProject(target, "feature").branch, "feature");
  assert.equal("branch" in laneProject(target), false);
});

const registry = { dispatchers: [{ id: "global", name: "全局" }] };
const target = { path: "/repo", name: "网关", projectId: "shop", owner: "global", projectDoc: "/p.md", statusDir: null };

test("the dispatcher is told exactly which branch to use", () => {
  const block = (branch) => targetBlock(registry, [target], "global", new Map([["/repo", branch]]));
  assert.match(block({ name: "feature", base: null, worktree: "/wt" }), /分支 feature（worktree \/wt）/);
  assert.match(block({ name: "plain", base: null, worktree: null }), /分支 plain（还没有 worktree/);
  assert.match(block({ name: "feat/new", base: "dev", worktree: null }), /新建分支 feat\/new（基于 dev/);
});

test("with no branch chosen the block doesn't mention one", () => {
  assert.doesNotMatch(targetBlock(registry, [target], "global"), /分支/);
});
