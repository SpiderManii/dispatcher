// core.ts uses a parameter property, so run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { markDecisions, summarizeLedger } from "./core.ts";

const ledger = (body) => `# 台账\n\n## 在跑执行会话\n\n- 一行\n\n## 待用户拍板\n\n${body}\n\n## 最近完成\n\n- 完成的事\n`;
const open = (body) => summarizeLedger(ledger(body)).pendingDecisions;
const unmarked = (body) => summarizeLedger(ledger(body)).unmarkedDecisions;

test("only unchecked boxes are open decisions", () => {
  const summary = summarizeLedger(ledger("- [ ] 团队系数上限取多少？（推荐：1）\n- [x] 迁移单独成单 → 用户：按推荐（11-11）\n- [X] 已定"));
  assert.equal(summary.pendingDecisions, 1);
  assert.equal(summary.decisions[0].text, "团队系数上限取多少？（推荐：1）");
  assert.equal(summary.decisions[0].line, "- [ ] 团队系数上限取多少？（推荐：1）");
  assert.equal(summary.decisions[0].hasRecommendation, true);
  assert.equal(summary.unmarkedDecisions, 0);
});

test("the decided P1–P12 list that showed a stale 12 no longer counts as open", () => {
  const body = "2026-11-11 用户「按推荐」。\n\n" + Array.from({ length: 12 }, (_, i) => `- P${i + 1} 某条已拍板的决定`).join("\n");
  assert.equal(open(body), 0);
  assert.equal(unmarked(body), 12);
});

test("saying there is nothing pending is neither open nor unmarked", () => {
  for (const body of ["- 无", "- 无（2026-11-08 架构方案 4 项建议已全部拍板确认）", "- 暂无", "- 没有。", "* None", ""]) {
    assert.equal(open(body), 0);
    assert.equal(unmarked(body), 0);
  }
});

test("plain items are unmarked, including one that merely starts with 无", () => {
  assert.equal(unmarked("- 预算超限如何处理\n1. 视频分档表是否保留列头单位"), 2);
  assert.equal(unmarked("- 无法确定用哪个方案"), 1);
});

test("a repeated heading doesn't wipe out items in the earlier section", () => {
  const text = "## 待用户拍板\n\n- [ ] 选哪个方案\n\n## 最近完成\n\n- 完成的事\n\n## 待用户拍板\n\n## 最近完成\n";
  assert.equal(summarizeLedger(text).pendingDecisions, 1);
});

test("items in other sections are not decisions", () => {
  assert.equal(summarizeLedger("## 最近完成\n\n- [ ] 完成的事\n\n## 改动范围\n\n- 文件\n").pendingDecisions, 0);
});

test("details under a decision are not decisions of their own", () => {
  assert.equal(open("- [ ] 移植吗？\n  - [ ] 分支 a\n  - 是否授权？\n- [ ] 删分支吗？"), 2);
  assert.equal(unmarked("1. 移植吗？\n   - 分支 a\n2. 删分支吗？\n   - 这些：\n     - b"), 2);
});

test("a list indented as a whole still counts each item", () => {
  assert.equal(open("  - [ ] 第一项\n  - [ ] 第二项"), 2);
});

test("answering ticks the chosen items and records the answer beside each", () => {
  const text = ledger("- [ ] A？（推荐：甲）\n- [ ] B？\n- [ ] C？");
  const now = new Date(2026, 10, 11);
  const after = markDecisions(text, ["- [ ] A？（推荐：甲）", "- [ ] C？"], "按推荐\n第三条再等等", now);
  assert.match(after, /- \[x\] A？（推荐：甲） → 用户：按推荐 第三条再等等（11-11）/);
  assert.match(after, /- \[ \] B？/);
  assert.match(after, /- \[x\] C？ → 用户/);
  assert.equal(summarizeLedger(after).pendingDecisions, 1);
});

test("answering an item the dispatcher changed meanwhile is refused", () => {
  assert.throws(() => markDecisions(ledger("- [ ] A 改过了"), ["- [ ] A"], "好", new Date()), /已经变了/);
});
