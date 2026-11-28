import assert from "node:assert/strict";
import { test } from "node:test";
import { laneNeeds, needRank } from "./needs.ts";

const idle = { status: "idle", pendingPermissions: 0, requiresAttention: false, attentionReason: null };
const lane = (over = {}) => ({ agent: idle, ledger: { decisions: [] }, stage: null, pendingHandoff: null, ...over });
const kinds = (input) => laneNeeds(lane(input)).map((need) => need.kind);

test("a quiet lane needs nothing, and Paseo's plain 「等你查看」 after a turn does not count", () => {
  assert.deepEqual(kinds({}), []);
  assert.deepEqual(kinds({ agent: { ...idle, requiresAttention: true, attentionReason: "finished" } }), []);
  assert.deepEqual(kinds({ stage: { step: "开发", waiting: false } }), []);
});

test("conflicts are told apart from ordinary decisions and come first", () => {
  const decisions = [{ text: "【冲突】两条线都改 a.ts" }, { text: "用哪个方案（推荐：A）" }, { text: "要不要加缓存" }];
  const needs = laneNeeds(lane({ ledger: { decisions } }));
  assert.deepEqual(needs.map((need) => [need.kind, need.label]), [
    ["conflict", "改动冲突 1"],
    ["decision", "待拍板 2"],
  ]);
});

test("the stage's gates are the user's: merge, deploy, archive; any other waiting stage is blocked", () => {
  assert.deepEqual(kinds({ stage: { step: "合回", waiting: true } }), ["merge"]);
  assert.deepEqual(kinds({ stage: { step: "部署", waiting: true } }), ["deploy"]);
  assert.deepEqual(kinds({ stage: { step: "推送", waiting: true } }), ["push"]);
  assert.deepEqual(kinds({ stage: { step: "完成", waiting: true } }), ["archive"]);
  assert.deepEqual(kinds({ stage: { step: "开发", waiting: true } }), ["blocked"]);
  assert.deepEqual(kinds({ stage: { step: "合回", waiting: false } }), []);
});

test("session trouble shows: errors, permission prompts, a vanished session, a written handoff", () => {
  assert.deepEqual(kinds({ agent: { ...idle, status: "error" } }), ["error"]);
  assert.deepEqual(kinds({ agent: { ...idle, pendingPermissions: 2 } }), ["permission"]);
  assert.deepEqual(kinds({ agent: null }), ["gone"]);
  assert.deepEqual(kinds({ pendingHandoff: { written: true } }), ["handoff"]);
  assert.deepEqual(kinds({ pendingHandoff: { written: false } }), []);
});

test("lanes sort by their most urgent need; lanes needing nothing go last", () => {
  const conflict = laneNeeds(lane({ ledger: { decisions: [{ text: "【冲突】x" }] } }));
  const deploy = laneNeeds(lane({ stage: { step: "部署", waiting: true } }));
  assert.ok(needRank(conflict) < needRank(deploy));
  assert.ok(needRank(deploy) < needRank([]));
});

const now = Date.parse("2026-11-17T12:00:00Z");
const quietLane = (agent, extra = {}) =>
  laneNeeds(lane({ agent: { ...idle, lastActivityAt: "2026-11-17T11:50:00Z", ...agent }, runningWorkers: 0, pendingNotices: 0, ...extra }), now).map(
    (need) => need.label,
  );

test("an idle dispatcher that ended its turn talking to the user, with nothing running, waits for a reply", () => {
  assert.deepEqual(quietLane({ requiresAttention: true, attentionReason: "finished" }), ["调度员在等你回话"]);
  // After a dispatch the dispatcher also ends its turn; with a worker running that is not waiting on the user.
  assert.deepEqual(quietLane({ requiresAttention: true, attentionReason: "finished" }, { runningWorkers: 1 }), []);
  assert.deepEqual(quietLane({ requiresAttention: true, attentionReason: "finished" }, { pendingNotices: 1 }), []);
  assert.deepEqual(quietLane({ requiresAttention: true, attentionReason: "finished", status: "running" }), []);
});

test("a lane quiet for over an hour, read and with nothing pending, has stalled", () => {
  assert.deepEqual(quietLane({ lastActivityAt: "2026-11-17T10:30:00Z" }), ["停了 1 小时"]);
  assert.deepEqual(quietLane({ lastActivityAt: "2026-11-14T12:00:00Z" }), ["停了 3 天"]);
  assert.deepEqual(quietLane({ lastActivityAt: "2026-11-17T11:30:00Z" }), []);
  // Finished, or already waiting on the user for something else: not stalled.
  assert.deepEqual(quietLane({ lastActivityAt: "2026-11-17T08:00:00Z" }, { stage: { step: "完成", waiting: true } }), ["已完成，可归档"]);
  assert.deepEqual(quietLane({ lastActivityAt: "2026-11-17T08:00:00Z" }, { ledger: { decisions: [{ text: "选哪个" }] } }), ["待拍板 1"]);
  // Paseo could not say what runs: never guessed as quiet.
  assert.deepEqual(quietLane({ lastActivityAt: "2026-11-17T08:00:00Z" }, { runningWorkers: null }), []);
});

test("a sensitive change unreviewed at 待合回 asks for the review instead of the merge", () => {
  const at = (review, stage = { step: "合回", waiting: true }) => laneNeeds(lane({ stage, review }));
  const needed = { state: "needed", kinds: ["迁移", "密钥"] };
  assert.deepEqual(at(needed).map((need) => [need.kind, need.label]), [["review", "缺审查：迁移、密钥"]]);
  assert.deepEqual(at({ ...needed, state: "running" }), [], "nothing for the user while the review runs");
  assert.deepEqual(at({ ...needed, state: "done" }).map((need) => need.kind), ["merge"]);
  assert.deepEqual(at({ ...needed, state: "waived" }).map((need) => need.kind), ["merge"]);
  assert.deepEqual(at(null).map((need) => need.kind), ["merge"]);
});

test("before 合回 a missing review is not the user's yet; after it, it stays in view next to the gate", () => {
  const needed = { state: "needed", kinds: ["鉴权"] };
  assert.deepEqual(laneNeeds(lane({ stage: { step: "开发", waiting: false }, review: needed })), []);
  assert.deepEqual(laneNeeds(lane({ stage: { step: "验收", waiting: false }, review: needed })), []);
  assert.deepEqual(laneNeeds(lane({ stage: { step: "部署", waiting: true }, review: needed })).map((need) => need.kind), ["review", "deploy"]);
  assert.ok(needRank(laneNeeds(lane({ stage: { step: "合回", waiting: true }, review: needed }))) < needRank([{ kind: "merge" }]));
});

test("a finished requirement waiting to be archived does not count as waiting on the user", async () => {
  const { needsUser } = await import("./needs.ts");
  assert.equal(needsUser([{ kind: "archive", label: "已完成，可归档", tone: "success" }]), false);
  assert.equal(needsUser([{ kind: "archive", label: "x", tone: "success" }, { kind: "decision", label: "y", tone: "warning" }]), true);
  assert.equal(needsUser([]), false);
});
