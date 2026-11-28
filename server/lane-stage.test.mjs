import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceLine, deriveStage, parseAcceptance, parseByRecommendation, parseNext, parseStage, stageAfterDispatch, withAcceptance, withRecentDone, withStage } from "./lane-stage.ts";
import { assignmentPrompt, renderLedger } from "./core.ts";

const fresh = renderLedger({ id: "global", name: "全局调度员" }, { id: "l1", projects: [{ key: "p", name: "商城", path: "/r" }], summary: "改商品页" });

test("a new ledger starts at 计划 with a 下一步 line", () => {
  assert.deepEqual(parseStage(fresh), { step: "计划", waiting: false, word: "计划", note: null, source: "ledger" });
  assert.ok(parseNext(fresh));
});

test("the words the rules ask for map onto the pipeline; 待… means the user moves next", () => {
  const at = (word) => parseStage(`- 阶段：${word}`);
  assert.equal(at("待合回").step, "合回");
  assert.equal(at("待合回").waiting, true);
  assert.equal(at("合回中").waiting, false);
  assert.equal(at("待部署").step, "部署");
  assert.equal(at("部署中").step, "部署");
  assert.equal(at("已完成").step, "完成");
  assert.equal(at("已完成").waiting, true);
});

test("a stage line written before the vocabulary still reads: the headline word wins over the narrative", () => {
  const real =
    "- 阶段（2026-01-16 13:20 UTC）：**准备归档**。两条冻结分支已进 dev 并随 abc12345 部署 api/web；本线 WIP（样式兼容）已提交";
  const stage = parseStage(`# 台账\n\n- 需求：x\n${real}\n\n## 改动范围\n`);
  assert.equal(stage.step, "完成");
  assert.match(stage.note, /^两条冻结分支/);
  assert.equal(parseStage("- 阶段：开发完成，待验收").step, "开发");
});

test("a blocked stage waits for the user whatever the step", () => {
  const stage = parseStage("- 阶段：开发（阻塞：等用户登录 VPN）");
  assert.equal(stage.step, "开发");
  assert.equal(stage.waiting, true);
});

test("no line, or a line with no stage word, reads as unknown", () => {
  assert.equal(parseStage("# 台账\n\n## 改动范围\n"), null);
  assert.equal(parseStage("- 阶段：看情况"), null);
});

test("table cells named 阶段 or 下一步 are not the lane's", () => {
  const table = "| 会话 ID | 阶段 | 下一步 |\n|---|---|---|\n| a | 开发 | 等 |";
  assert.equal(parseStage(table), null);
  assert.equal(parseNext(table), null);
  assert.equal(parseNext("- 下一步：等测试会话回报 S5"), "等测试会话回报 S5");
});

test("setting the stage replaces the line in place, or adds it under 项目/需求", () => {
  const moved = withStage(fresh, "开发");
  assert.equal(parseStage(moved).word, "开发");
  assert.equal(moved.split("\n").filter((line) => line.startsWith("- 阶段")).length, 1);
  const bare = "# 台账\n\n- 项目：商城\n- 需求：x\n\n## 改动范围\n";
  const added = withStage(bare, "合回中", "用户在页面同意合回");
  assert.match(added, /- 需求：x\n- 阶段：合回中（用户在页面同意合回）\n\n## 改动范围/);
  assert.equal(parseStage(added).note, "用户在页面同意合回");
  assert.match(withStage("# 台账\n\n## 改动范围\n", "计划"), /^# 台账\n\n- 阶段：计划\n\n## 改动范围/);
});

test("dispatching moves the stage among 计划/开发/验收 only, both ways, and leaves later steps alone", () => {
  const at = (word) => parseStage(`- 阶段：${word}`);
  assert.equal(stageAfterDispatch(at("计划"), "backend"), "开发");
  assert.equal(stageAfterDispatch(at("开发"), "test"), "验收");
  assert.equal(stageAfterDispatch(at("验收"), "frontend"), "开发");
  assert.equal(stageAfterDispatch(at("开发"), "backend"), null);
  assert.equal(stageAfterDispatch(at("待合回"), "test"), null);
  assert.equal(stageAfterDispatch(at("部署中"), "review"), null);
  assert.equal(stageAfterDispatch(at("开发"), "deploy"), null);
  assert.equal(stageAfterDispatch(null, "split"), "计划");
});

test("without a line the stage is guessed from what runs, else 计划 for a lane that never dispatched", () => {
  assert.equal(deriveStage(["backend", "test"], true).step, "验收");
  assert.equal(deriveStage(["deploy"], true).step, "部署");
  assert.equal(deriveStage([], false).step, "计划");
  assert.equal(deriveStage([null], true), null);
  assert.equal(deriveStage([], true), null);
});

test("what was decided for the user without asking is read from its 按推荐 lines, newest last", () => {
  const ledger = [
    "## 最近完成",
    "",
    "- 按推荐：旧用例要不要一起清理 → 不清理，另列后续卡（用户可改）",
    "- 卡 A 已验收",
    "* 按推荐：**列表页分页**大小 → 20（用户可改）",
    "| 按推荐：表格里的不算 |",
  ].join("\n");
  assert.deepEqual(parseByRecommendation(ledger), {
    count: 2,
    recent: ["旧用例要不要一起清理 → 不清理，另列后续卡（用户可改）", "列表页分页大小 → 20（用户可改）"],
  });
  const many = Array.from({ length: 8 }, (_, index) => `- 按推荐：第 ${index + 1} 条`).join("\n");
  assert.deepEqual(parseByRecommendation(many).recent, ["第 4 条", "第 5 条", "第 6 条", "第 7 条", "第 8 条"]);
  assert.equal(parseByRecommendation(many).count, 8);
});

test("the user's 验收口径 goes into a new ledger on one line, and reads back for the card", () => {
  const ledger = renderLedger(
    { id: "global", name: "全局调度员" },
    { id: "l2", projects: [], summary: "商品按分类打折", acceptance: "1. 每个分类能单独设折扣\n2. 没设的按 1 算\n" },
  );
  assert.match(ledger, /- 需求：商品按分类打折\n- 验收口径：1\. 每个分类能单独设折扣；2\. 没设的按 1 算\n- 阶段：计划/);
  assert.equal(parseAcceptance(ledger), "1. 每个分类能单独设折扣；2. 没设的按 1 算");
  assert.equal(parseStage(ledger).word, "计划");
  assert.equal(acceptanceLine("  \n "), null);
  assert.doesNotMatch(renderLedger({ id: "g", name: "g" }, { id: "l3", projects: [], summary: "x" }), /验收口径/);
});

test("a 验收口径 given later is appended, once, and the first one stays", () => {
  const ledger = renderLedger({ id: "g", name: "g" }, { id: "l2", projects: [], summary: "x", acceptance: "列表页能按分类筛选" });
  const more = withAcceptance(ledger, "导出也要带折扣列");
  assert.equal(parseAcceptance(more), "列表页能按分类筛选；补充：导出也要带折扣列");
  assert.equal(withAcceptance(more, "导出也要带折扣列"), more);
  const none = renderLedger({ id: "g", name: "g" }, { id: "l3", projects: [], summary: "x" });
  assert.equal(parseAcceptance(withAcceptance(none, "能登录")), "能登录");
  assert.equal(withAcceptance(none, ""), none);
});

test("the dispatcher's first message carries the 验收口径 after the requirement", () => {
  const prompt = assignmentPrompt({
    registry: { version: 1, rulesFile: "x", dispatchers: [], projects: [] },
    targets: [],
    dispatcherId: "global",
    task: "商品按分类打折",
    acceptance: "每个分类能单独设折扣",
    fresh: true,
  });
  assert.match(prompt, /需求：\n商品按分类打折\n\n验收口径（用户写的，按它验收）：\n每个分类能单独设折扣$/);
  assert.doesNotMatch(assignmentPrompt({ registry: { version: 1, rulesFile: "x", dispatchers: [], projects: [] }, targets: [], dispatcherId: "g", task: "x", fresh: true }), /验收口径/);
});

test("待推送 waits for the user's push; a push is recorded at the top of 最近完成", () => {
  const stage = parseStage("- 阶段：待推送（api 部署验收通过）");
  assert.deepEqual([stage.step, stage.waiting, stage.note], ["推送", true, "api 部署验收通过"]);
  const ledger = renderLedger({ id: "g", name: "g" }, { id: "l1", projects: [], summary: "x" }).replace("## 最近完成\n", "## 最近完成\n\n- 卡 A 已验收\n");
  const done = withRecentDone(ledger, "- 已推送：商城 dev @ abc12345 → origin/dev");
  assert.match(done, /## 最近完成\n\n- 已推送：商城 dev @ abc12345 → origin\/dev\n- 卡 A 已验收/);
  assert.match(withRecentDone("# 台账\n\n## 最近完成\n", "- x"), /## 最近完成\n\n- x/);
  assert.match(withRecentDone("# 台账\n", "- x"), /## 最近完成\n\n- x\n$/);
});
