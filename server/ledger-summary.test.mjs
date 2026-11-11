// core.ts uses a parameter property, so run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeLedger } from "./core.ts";

const count = (body) => summarizeLedger(`# 台账\n\n## 在跑执行会话\n\n- 一行\n\n## 待用户拍板\n\n${body}\n\n## 最近完成\n\n- 完成的事\n`).pendingDecisions;

test("saying there is nothing pending counts as nothing", () => {
  assert.equal(count("- 无"), 0);
  assert.equal(count("- 无（2026-11-08 架构方案 4 项建议已全部拍板确认）"), 0);
  assert.equal(count("- 暂无"), 0);
  assert.equal(count("- 没有。"), 0);
  assert.equal(count("* None"), 0);
  assert.equal(count(""), 0);
});

test("real items count, including one that merely starts with 无", () => {
  assert.equal(count("- 预算超限如何处理\n1. 视频分档表是否保留列头单位"), 2);
  assert.equal(count("- 无法确定用哪个方案"), 1);
});

test("a repeated heading doesn't wipe out items in the earlier section", () => {
  const text = "## 待用户拍板\n\n- 选哪个方案\n\n## 最近完成\n\n- 完成的事\n\n## 待用户拍板\n\n## 最近完成\n";
  assert.equal(summarizeLedger(text).pendingDecisions, 1);
});

test("items in other sections are not decisions", () => {
  assert.equal(summarizeLedger("## 最近完成\n\n- 完成的事\n\n## 改动范围\n\n- 文件\n").pendingDecisions, 0);
});

test("the real ledgers that produced a false 2 now read as 0", () => {
  assert.equal(summarizeLedger("## 待用户拍板\n- 无（2026-11-08 架构方案 4 项建议已全部拍板确认）\n").pendingDecisions, 0);
  assert.equal(summarizeLedger("## 待用户拍板\n\n- 无\n").pendingDecisions, 0);
});

test("details under a decision are not decisions of their own", () => {
  assert.equal(count("1. 移植吗？\n   - 分支 a\n   - 是否授权？\n2. 删分支吗？\n   - 这些：\n     - b\n     - c\n3. 清理吗？\n   - 是否清理 d？"), 3);
  assert.equal(count("- 第一项\n  - 细节\n- 第二项"), 2);
});

test("a list indented as a whole still counts each item", () => {
  assert.equal(count("  - 第一项\n  - 第二项"), 2);
});
