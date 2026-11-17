import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEP_DONE_DECISIONS, KEEP_RECENT, archiveBlock, runningTableAgents, slimLedger } from "./ledger-slim.ts";

const A = "6db64ca6-e692-42c5-a9fd-207f35b4f578";
const B = "8f1456da-0aae-4cea-bd0c-a34f66d88c42";

const ledger = (parts) =>
  [
    "# 台账：会话线 l1",
    "",
    "> 每次派单后更新。",
    "",
    "## 在跑执行会话",
    "",
    "| 会话 ID | 项目 | cwd | 分支 | 状态文件 | 阶段 | 下一步 |",
    "|---|---|---|---|---|---|---|",
    ...(parts.rows ?? []),
    "",
    "- 下一步：等验收。",
    "",
    "## 待用户拍板",
    "",
    ...(parts.decisions ?? []),
    "",
    "## 最近完成",
    "",
    ...(parts.done ?? []),
    "",
  ].join("\n");

const options = { finished: new Set(), archiveDecisions: true, archivePath: "台账/归档/l1.md" };

test("drops rows of finished sessions and stale placeholders, keeps running ones and the notes", () => {
  const text = ledger({
    rows: [
      "| （无在跑会话） | — | — | — | — | 旧阶段 | — |",
      `| ${A}（工作区 w1） | p | c | b | s | 已派出 | 等 |`,
      `| ${B}（工作区 w2） | p | c | b | s | 已派出 | 等 |`,
    ],
  });
  assert.deepEqual(runningTableAgents(text), [A, B]);
  const result = slimLedger(text, { ...options, finished: new Set([A]) });
  assert.ok(result.ledger.includes(B));
  assert.ok(!result.ledger.includes(A));
  assert.ok(!result.ledger.includes("旧阶段"));
  assert.ok(result.ledger.includes("- 下一步：等验收。"));
  assert.deepEqual(result.archived, [{ heading: "在跑执行会话（已结束）", lines: [`| ${A}（工作区 w1） | p | c | b | s | 已派出 | 等 |`] }]);
  assert.match(result.ledger, /^> 每次派单后更新。\n> 更早的记录已由插件移到 台账\/归档\/l1\.md/m);
});

test("an emptied table keeps one placeholder row", () => {
  const text = ledger({ rows: [`| ${A}（工作区 w1） | p | c | b | s | 已派出 | 等 |`] });
  const result = slimLedger(text, { ...options, finished: new Set([A]) });
  assert.match(result.ledger, /\|---\|---\|---\|---\|---\|---\|---\|\n\| （无在跑会话） \|/);
});

test("archives answered decisions beyond the newest few, with their continuation lines, and never open ones", () => {
  const answered = Array.from({ length: KEEP_DONE_DECISIONS + 2 }, (_, index) => `- [x] 问题 ${index} → 用户：好`);
  const text = ledger({ decisions: [answered[0], "  - 补充说明 0", "- [ ] 还没答？（推荐：是）", ...answered.slice(1)] });
  const result = slimLedger(text, options);
  const moved = result.archived.find((part) => part.heading === "待用户拍板（已答复）").lines;
  assert.deepEqual(moved, [answered[0], "  - 补充说明 0", answered[1]]);
  assert.ok(result.ledger.includes("- [ ] 还没答？（推荐：是）"));
  for (const line of answered.slice(2)) assert.ok(result.ledger.includes(line));
});

test("leaves answered decisions alone while an answer is still queued", () => {
  const answered = Array.from({ length: KEEP_DONE_DECISIONS + 2 }, (_, index) => `- [x] 问题 ${index} → 用户：好`);
  const result = slimLedger(ledger({ decisions: answered }), { ...options, archiveDecisions: false });
  assert.equal(result.archived.length, 0);
});

test("keeps only the newest completions", () => {
  const done = Array.from({ length: KEEP_RECENT + 3 }, (_, index) => `- 完成 ${index}`);
  const result = slimLedger(ledger({ done }), options);
  assert.deepEqual(result.archived[0].lines, done.slice(0, 3));
  assert.ok(result.ledger.includes(`- 完成 ${KEEP_RECENT + 2}`));
});

test("changes nothing when there is nothing to move, and adds the pointer only once", () => {
  const text = ledger({ rows: [`| ${A}（工作区 w1） | p | c | b | s | 已派出 | 等 |`], done: ["- 完成 0"] });
  assert.deepEqual(slimLedger(text, options), { ledger: text, archived: [] });
  const once = slimLedger(ledger({ done: Array.from({ length: KEEP_RECENT + 1 }, (_, i) => `- d${i}`) }), options).ledger;
  const twice = slimLedger(`${once}\n- d99`, options).ledger;
  assert.equal(twice.split("台账/归档/l1.md").length - 1, 1);
});

test("archive block is dated and grouped by section", () => {
  const block = archiveBlock([{ heading: "最近完成（更早）", lines: ["- 完成 0"] }], new Date("2026-11-17T04:00:00Z"));
  assert.equal(block, "## 2026-11-17 04:00 自动归档\n\n### 最近完成（更早）\n\n- 完成 0\n");
});
