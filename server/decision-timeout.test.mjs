import assert from "node:assert/strict";
import { test } from "node:test";
import { DECISION_TIMEOUT_MS, dueDecisions, pruneClock, userOnly } from "./decision-timeout.ts";
import { markDecisions } from "./core.ts";

const item = (text) => ({ line: `- [ ] ${text}`, text, hasRecommendation: text.includes("推荐") });
const T = DECISION_TIMEOUT_MS;

test("an item is due only after 10 minutes, counted from when it was first seen", () => {
  const clock = {};
  const open = [item("用哪个方案（推荐：A）")];
  assert.deepEqual(dueDecisions(clock, "l1", open, 0).recommend, []);
  assert.deepEqual(dueDecisions(clock, "l1", open, T - 1).recommend, []);
  assert.deepEqual(dueDecisions(clock, "l1", open, T).recommend, open);
});

test("without a recommendation the architect is asked once", () => {
  const clock = {};
  const open = [item("要不要拆表")];
  dueDecisions(clock, "l1", open, 0);
  assert.deepEqual(dueDecisions(clock, "l1", open, T).architect, open);
  assert.deepEqual(dueDecisions(clock, "l1", open, T * 2).architect, []);
});

test("an edited question gets a fresh 10 minutes", () => {
  const clock = {};
  dueDecisions(clock, "l1", [item("要不要拆表")], 0);
  const edited = [item("要不要拆表（推荐：拆）")];
  assert.deepEqual(dueDecisions(clock, "l1", edited, T).recommend, []);
  assert.deepEqual(dueDecisions(clock, "l1", edited, T * 2).recommend, edited);
});

test("what rule 1.3 reserves for the user waits however long it takes", () => {
  for (const text of ["先 push 到远程吗（推荐：推）", "合入 dev（推荐：合）", "部署到生产（推荐：部署）", "删远程分支 x（推荐：删）", "改 AGENTS.md（推荐：改）"]) {
    assert.ok(userOnly(text), text);
    const clock = {};
    dueDecisions(clock, "l1", [item(text)], 0);
    const due = dueDecisions(clock, "l1", [item(text)], T * 10);
    assert.deepEqual([...due.recommend, ...due.architect], [], text);
  }
  assert.equal(userOnly("先补单测还是先做 V3（推荐：先单测）"), false);
});

test("a blocker only the user can clear on their side waits too", () => {
  for (const text of [
    "Docker 仍未启动，是否重派（推荐：重派）",
    "E0 失败，等你确认 Colima 跑起来再重派？（推荐：先停）",
    "需要你登录 codeup 再继续（推荐：等）",
    "预览要用 VPN（推荐：先停）",
    "环境没起来（等用户）（推荐：先停）",
  ])
    assert.ok(userOnly(text), text);
});

test("items no longer open are dropped from the clock", () => {
  const clock = {};
  dueDecisions(clock, "l1", [item("a"), item("b")], 0);
  pruneClock(clock, new Map([["l1", [item("b")]]]));
  assert.equal(Object.keys(clock).length, 1);
});

test("an automatic answer is marked as such in the ledger", () => {
  const ledger = "## 待用户拍板\n\n- [ ] 用哪个（推荐：A）\n";
  const marked = markDecisions(ledger, ["- [ ] 用哪个（推荐：A）"], "按推荐（10 分钟未答）", new Date(2026, 10, 12), "自动");
  assert.match(marked, /- \[x\] 用哪个（推荐：A） → 自动：按推荐（10 分钟未答）（11-12）/);
});
