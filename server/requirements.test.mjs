import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRequirements, parseStage, stageAfterDispatch } from "./lane-stage.ts";
import { renderLedger } from "./core.ts";
import { needsNewRound, reviewViewOf, withDispatchRecord, withNewRound } from "./sensitive.ts";
import { laneNeeds } from "../shared/needs.ts";
import { focusRequirement } from "../shared/lane-text.ts";

const fresh = renderLedger({ id: "global", name: "全局调度员" }, { id: "l1", projects: [{ key: "p", name: "商城", path: "/r" }], summary: "改商品页" });

test("a ledger without a filled 需求清单 holds one requirement, read from its head", () => {
  assert.match(fresh, /## 需求清单/);
  assert.deepEqual(parseRequirements(fresh), [{ id: "R1", text: "改商品页", word: "计划", done: false, synthetic: true }]);
  assert.deepEqual(parseRequirements("# 台账\n\n- 阶段：开发\n"), []);
});

test("listed requirements keep their order, stage word and done mark; the head line no longer counts", () => {
  const ledger = fresh.replace(
    "## 需求清单\n",
    "## 需求清单\n\n- R1【已完成】订单状态显示修正\n- R2【开发中】详情页加状态说明\n* R3 [待合回] 筛选加「已退款」\n- 不是清单行\n",
  );
  assert.deepEqual(
    parseRequirements(ledger).map(({ id, word, done, synthetic }) => ({ id, word, done, synthetic })),
    [
      { id: "R1", word: "已完成", done: true, synthetic: false },
      { id: "R2", word: "开发", done: false, synthetic: false },
      { id: "R3", word: "待合回", done: false, synthetic: false },
    ],
  );
});

test("a building card sent while the lane waits to merge, deploy, push or archive reopens it at 开发", () => {
  const at = (word) => parseStage(`- 阶段：${word}\n`);
  assert.equal(stageAfterDispatch(at("待合回"), "backend"), "开发");
  assert.equal(stageAfterDispatch(at("已完成"), "frontend"), "开发");
  assert.equal(stageAfterDispatch(at("待推送"), "design"), "开发");
  // The user's clicks in flight are left alone, and so is everything that does not build.
  assert.equal(stageAfterDispatch(at("合回中"), "backend"), null);
  assert.equal(stageAfterDispatch(at("部署中"), "backend"), null);
  assert.equal(stageAfterDispatch(at("待合回"), "test"), null);
  assert.equal(stageAfterDispatch(at("已完成"), "review"), null);
  // Inside 计划 / 开发 / 验收 it moves as before.
  assert.equal(stageAfterDispatch(at("验收"), "backend"), "开发");
});

test("已完成 with open items on the list is not ready to archive, and can still be seen as stalled", () => {
  const idle = { status: "idle", pendingPermissions: 0, requiresAttention: false, attentionReason: null, lastActivityAt: "2026-11-26T00:00:00Z" };
  const lane = (requirements) => ({
    agent: idle,
    ledger: { decisions: [], requirements },
    stage: { step: "完成", waiting: true },
    pendingHandoff: null,
    runningWorkers: 0,
  });
  const now = Date.parse("2026-11-26T05:00:00Z");
  assert.deepEqual(laneNeeds(lane([{ done: true }, { done: true }]), now).map((need) => need.kind), ["archive"]);
  assert.deepEqual(laneNeeds(lane(undefined), now).map((need) => need.kind), ["archive"]);
  assert.deepEqual(laneNeeds(lane([{ done: true }, { done: false }]), now).map((need) => need.kind), ["stalled"]);
});

test("a requirement added after the review starts a new round; rework on the reviewed ones does not", () => {
  const hit = { kind: "鉴权", text: "改登录" };
  let review = withDispatchRecord(undefined, { card: "后端-登录", at: "2026-11-26T01:00:00Z", hits: [hit], reviewer: null });
  review = withDispatchRecord(review, { card: "审查", at: "2026-11-26T02:00:00Z", hits: [], reviewer: "rev1" });
  review = { ...review, reviewers: review.reviewers.map((item) => ({ ...item, outcome: "ended", endedAt: "2026-11-26T03:00:00Z" })) };
  assert.equal(reviewViewOf(review).state, "done");
  // Old lanes never recorded what was covered: their one requirement, R1.
  assert.equal(needsNewRound(review, ["R1"]), false);
  assert.equal(needsNewRound(review, ["R1", "R2"]), true);
  assert.equal(needsNewRound({ ...review, covered: ["R1", "R2"] }, ["R1", "R2"]), false);

  const next = withDispatchRecord(withNewRound(review, "2026-11-26T04:00:00Z"), {
    card: "后端-新需求",
    at: "2026-11-26T04:00:00Z",
    hits: [{ kind: "密钥", text: "加 key" }],
    reviewer: null,
  });
  const view = reviewViewOf(next);
  assert.equal(view.state, "needed");
  assert.deepEqual(view.kinds, ["密钥"]);
  // The old round's findings stay on record.
  assert.equal(next.hits.length, 2);
});

test("a waived round is cleared by a new one", () => {
  const base = withDispatchRecord(undefined, { card: "c", at: "2026-11-26T01:00:00Z", hits: [{ kind: "迁移", text: "改表" }], reviewer: null });
  const waived = { ...base, waived: { at: "2026-11-26T02:00:00Z" }, covered: ["R1"] };
  assert.equal(reviewViewOf(waived).state, "waived");
  assert.equal(needsNewRound(waived, ["R1", "R2"]), true);
  const next = withDispatchRecord(withNewRound(waived, "2026-11-26T03:00:00Z"), { card: "d", at: "2026-11-26T03:00:00Z", hits: [{ kind: "迁移", text: "再改表" }], reviewer: null });
  assert.equal(reviewViewOf(next).state, "needed");
});

test("the lane reads by the newest open requirement, and only when it holds several", () => {
  assert.equal(focusRequirement([{ id: "R1", done: false }]), null);
  assert.equal(focusRequirement(undefined), null);
  assert.equal(focusRequirement([{ id: "R1", done: false }, { id: "R2", done: false }, { id: "R3", done: true }]).id, "R2");
  assert.equal(focusRequirement([{ id: "R1", done: true }, { id: "R2", done: true }]).id, "R2");
});

test("a requirement's line takes a new stage word; a lane holding one has no line to move", async () => {
  const { withRequirementWord } = await import("./lane-stage.ts");
  const ledger = fresh.replace("## 需求清单\n", "## 需求清单\n\n- R1【待合回】状态显示\n- R2【开发】状态说明\n");
  const moved = withRequirementWord(ledger, "R1", "合回中");
  assert.match(moved, /- R1【合回中】状态显示/);
  assert.match(moved, /- R2【开发】状态说明/);
  assert.equal(withRequirementWord(ledger, "R9", "合回中"), null);
  assert.equal(withRequirementWord(fresh, "R1", "合回中"), null);
});

test("on a lane holding several, each waiting line gets its own button; a review in progress only holds the new ones", () => {
  const idle = { status: "idle", pendingPermissions: 0, requiresAttention: false, attentionReason: null };
  const rows = [
    { id: "R1", word: "待合回", done: false, synthetic: false },
    { id: "R2", word: "待部署", done: false, synthetic: false },
    { id: "R3", word: "开发", done: false, synthetic: false },
  ];
  const lane = (review) => ({ agent: idle, ledger: { decisions: [], requirements: rows }, stage: { step: "开发", waiting: false }, pendingHandoff: null, review });
  assert.deepEqual(
    laneNeeds(lane(null)).map(({ kind, req }) => `${kind}:${req}`),
    ["merge:R1", "deploy:R2"],
  );
  // R1 and R2 were covered by an earlier round; the current round is for R3, still in 开发.
  const newRound = { state: "needed", kinds: ["密钥"], covered: ["R1", "R2"] };
  assert.deepEqual(laneNeeds(lane(newRound)).map(({ kind, req }) => `${kind}:${req ?? ""}`), ["merge:R1", "deploy:R2"]);
  // R2 got past 验收 without the review it needed: missing, as on a lane holding one; R1 can still go.
  const r2Uncovered = { state: "needed", kinds: ["密钥"], covered: ["R1"] };
  assert.deepEqual(laneNeeds(lane(r2Uncovered)).map(({ kind, req }) => `${kind}:${req ?? ""}`), ["review:", "merge:R1", "deploy:R2"]);
  // Not covered: R1 waits for the review, which shows as missing.
  const uncovered = { state: "needed", kinds: ["密钥"], covered: [] };
  assert.deepEqual(laneNeeds(lane(uncovered)).map(({ kind, req }) => `${kind}:${req ?? ""}`), ["review:", "deploy:R2"]);
});

test("a review that covered R1 does not hold R1 back while R2's round is open", async () => {
  const { reviewHolds } = await import("./sensitive.ts");
  const view = { state: "needed", kinds: ["密钥"], hits: [], covered: ["R1"] };
  assert.equal(reviewHolds(view, "R1"), false);
  assert.equal(reviewHolds(view, "R2"), true);
  assert.equal(reviewHolds(view, null), true);
  assert.equal(reviewHolds({ ...view, state: "done" }, "R2"), false);
});

test("which requirement a card is for: needed once two are open; a build may not write the landing branch past another's 验收", async () => {
  const { requirementForCard } = await import("./lane-stage.ts");
  const row = (id, word) => ({ id, text: `需求${id}`, word, done: word === "已完成", synthetic: false });
  const card = (over = {}) => ({ roleId: "backend", branch: "feat-x", landings: ["feat-x"], ...over });
  // A lane holding one requirement (or none listed): nothing to say.
  assert.deepEqual(requirementForCard([{ ...row("R1", "开发"), synthetic: true }], card()), { req: null });
  // One open, one done: the open one, no req needed.
  assert.deepEqual(requirementForCard([row("R1", "已完成"), row("R2", "开发")], card()), { req: "R2" });
  // Two open: req is required, and must be on the list.
  assert.match(requirementForCard([row("R1", "开发"), row("R2", "计划")], card()).problem, /要填 req/);
  assert.match(requirementForCard([row("R1", "开发"), row("R2", "计划")], card({ req: "R7" })).problem, /没有 R7/);
  // R1 verified and waiting: R2's build may not go on the landing branch, but may on its own; R1's rework may.
  const waiting = [row("R1", "待合回"), row("R2", "计划")];
  assert.match(requirementForCard(waiting, card({ req: "R2" })).problem, /从 feat-x 拉 `feat-x-R2`/);
  assert.deepEqual(requirementForCard(waiting, card({ req: "R2", branch: "feat-x-R2" })), { req: "R2" });
  assert.deepEqual(requirementForCard(waiting, card({ req: "R1" })), { req: "R1" });
  // Tests and reviews do not write code: no branch rule.
  assert.deepEqual(requirementForCard(waiting, card({ req: "R2", roleId: "test" })), { req: "R2" });
});

test("a build card sent because of what the user typed must say which requirement it is for", async () => {
  const { requirementForCard } = await import("./lane-stage.ts");
  const synthetic = [{ id: "R1", text: "启动前后端", word: "已完成", done: true, synthetic: true }];
  const card = (over = {}) => ({ roleId: "backend", branch: "feat-x", landings: ["feat-x"], typedByUser: true, ...over });
  // 「启动前后端」 was done without a card; now 「改代码」: the dispatcher has to decide before the card goes out.
  assert.match(requirementForCard(synthetic, card()).problem, /要填 req/);
  // Rework on the only requirement: R1 on an empty list is fine.
  assert.deepEqual(requirementForCard(synthetic, card({ req: "R1" })), { req: null });
  // A new one has to be on the list first.
  assert.match(requirementForCard(synthetic, card({ req: "R2" })).problem, /还是空的，没有 R2/);
  const listed = [
    { id: "R1", text: "启动前后端", word: "已完成", done: true, synthetic: false },
    { id: "R2", text: "改代码", word: "计划", done: false, synthetic: false },
  ];
  assert.deepEqual(requirementForCard(listed, card({ req: "R2" })), { req: "R2" });
  // A plugin notice opened the turn (a fix after a failed test): no req needed, the open one is assumed.
  assert.deepEqual(requirementForCard(listed, card({ typedByUser: false })), { req: "R2" });
  // Tests and reviews are not building cards.
  assert.deepEqual(requirementForCard(listed, card({ roleId: "test" })), { req: "R2" });
});
