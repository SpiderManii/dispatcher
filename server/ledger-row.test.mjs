// core.ts uses a parameter property, so run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderLedger, withRunningRow } from "./core.ts";

const row = (agentId = "a1") => ({ agentId, workspaceId: "wks_1", project: "商城", cwd: "/repo/wt", branch: "feat/x", statusFile: "/s/a|b.md" });
const fresh = renderLedger({ id: "global", name: "全局调度员" }, { id: "l1", projects: [], summary: null });

test("a dispatched worker lands in the 在跑执行会话 table, not in the next section", () => {
  const text = withRunningRow(fresh, row());
  const running = text.slice(text.indexOf("## 在跑执行会话"), text.indexOf("## 待用户拍板"));
  assert.match(running, /\| a1（工作区 wks_1） \| 商城 \| \/repo\/wt \| feat\/x \| \/s\/a\\\|b\.md \| 已派出（插件记录） \|/);
});

test("rows stay in dispatch order under the header", () => {
  const text = withRunningRow(withRunningRow(fresh, row("a1")), row("a2"));
  assert.ok(text.indexOf("a1（") < text.indexOf("a2（"));
  assert.ok(text.indexOf("a2（") < text.indexOf("## 待用户拍板"));
});

test("text the dispatcher wrote after the table is kept below the new row", () => {
  const ledger = fresh.replace("|---|---|---|---|---|---|---|\n", "|---|---|---|---|---|---|---|\n\n心跳 cb824ccb 已删。\n");
  const text = withRunningRow(ledger, row());
  assert.ok(text.indexOf("a1（") < text.indexOf("心跳 cb824ccb 已删。"));
});

test("an already listed session is not added twice", () => {
  assert.equal(withRunningRow(withRunningRow(fresh, row()), row()), null);
});

test("a ledger without the section or the table gets one", () => {
  assert.match(withRunningRow("# 台账\n\n## 最近完成\n", row()), /## 在跑执行会话\n\n\| 会话 ID[^\n]*\n\|---[^\n]*\n\| a1（/);
  assert.match(withRunningRow("# 台账\n\n## 在跑执行会话\n\n## 最近完成\n", row()), /## 在跑执行会话\n\n\| 会话 ID[^\n]*\n\|---[^\n]*\n\| a1（/);
});
