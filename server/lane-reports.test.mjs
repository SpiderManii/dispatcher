import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { laneReports, reportHeadline, reportName, runningStatusFiles } from "./lane-reports.ts";
import { renderLedger } from "./core.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-reports-"));
after(() => {
  assert.ok(path.basename(dir).startsWith("paseo-reports-"));
  rmSync(dir, { recursive: true, force: true });
});

const row = (id, file) => `| ${id}（工作区 wks_1） | 商城 | /repo | feat | ${file} | 施工 | 等 |`;
const ledgerWith = (...rows) =>
  renderLedger({ id: "global", name: "全局调度员" }, { id: "l1", projects: [], summary: "x" }).replace(
    "|---|---|---|---|---|---|---|\n",
    `|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`,
  );

test("status files come from the running table's 状态文件 column, once each", () => {
  const ledger = ledgerWith(row("a", "/p/进度/前端-商品页-状态.md"), row("b", "`/p/进度/测试-商品页-状态.md`"), row("c", "/p/进度/前端-商品页-状态.md"));
  assert.deepEqual(runningStatusFiles(ledger), ["/p/进度/前端-商品页-状态.md", "/p/进度/测试-商品页-状态.md"]);
  assert.deepEqual(runningStatusFiles("| a | b | c | d | /x.md | f | g |"), []);
});

test("a report is named like its card", () => {
  assert.equal(reportName("/p/进度/前端-商品列表页打磨-状态.md"), "前端-商品列表页打磨");
  assert.equal(reportName("/p/进度/线上抽验-状态.md"), "线上抽验");
  assert.equal(reportName("/p/notes.md"), "notes");
});

test("the headline is the conclusion or status line, in any of the ways workers write it", () => {
  assert.equal(reportHeadline("# 线上抽验状态\n\n结论：单笔线上抽验通过，创建后立即删 key。"), "结论：单笔线上抽验通过，创建后立即删 key。");
  assert.equal(reportHeadline("# 卡\n\n- **状态**：待验收\n- 分支：feat"), "状态：待验收");
  assert.equal(reportHeadline("| 键 | 值 |\n|---|---|\n| 状态 | 待验收 |\n| SHA | abc |"), "状态：待验收");
  assert.equal(reportHeadline("# 标题\n\n只写了一句说明"), "只写了一句说明");
  assert.equal(reportHeadline("# 只有标题"), null);
  assert.equal(reportHeadline(`结论：${"很".repeat(200)}`).length, 101);
});

test("a lane's newest reports come first; missing files are skipped", () => {
  const older = path.join(dir, "前端-商品页-状态.md");
  const newer = path.join(dir, "测试-商品页-状态.md");
  writeFileSync(older, "结论：改完了\n");
  writeFileSync(newer, "- 状态：测试通过 12/12\n");
  utimesSync(older, new Date("2026-11-16T00:00:00Z"), new Date("2026-11-16T00:00:00Z"));
  utimesSync(newer, new Date("2026-11-17T00:00:00Z"), new Date("2026-11-17T00:00:00Z"));
  const reports = laneReports(ledgerWith(row("a", older), row("b", path.join(dir, "不存在-状态.md")), row("c", newer)));
  assert.deepEqual(
    reports.map((item) => [item.name, item.headline]),
    [
      ["测试-商品页", "状态：测试通过 12/12"],
      ["前端-商品页", "结论：改完了"],
    ],
  );
});
