import assert from "node:assert/strict";
import { test } from "node:test";
import { laneClashes, overlapping, runningCwds, scopePaths, scopeText, withScopePaths } from "./scope-overlap.ts";
import { renderLedger } from "./core.ts";
import { dueDecisions, DECISION_TIMEOUT_MS } from "./decision-timeout.ts";

const ledger = renderLedger({ id: "d", name: "调度员" }, { id: "l1", projects: [], summary: "需求" });

test("the template's comment is not scope, so a fresh ledger has none", () => {
  assert.equal(scopeText(ledger), "");
  assert.deepEqual(scopePaths(scopeText(ledger)), []);
});

test("paths come out of free text; words, URLs and the not-a-path 无 stay out", () => {
  const text = "- 改 `src/api/usage.ts`、src/pages/Usage.vue（新增）\n- 不改 README.md 以外的文档；见 https://x.dev/a.ts\n- 无";
  assert.deepEqual(scopePaths(text).sort(), ["README.md", "src/api/usage.ts", "src/pages/Usage.vue"]);
});

test("absolute paths under the project or a worktree become repo paths; globs and line numbers are cut", () => {
  const roots = ["/repo/app", "/wt/app-feat"];
  assert.deepEqual(scopePaths("/wt/app-feat/src/a.ts:42 /repo/app/src/b/ src/c/*.ts ./d.json", roots).sort(), [
    "d.json",
    "src/a.ts",
    "src/b",
    "src/c",
  ]);
});

test("the same file, or a directory holding it, overlaps; siblings with a shared prefix do not", () => {
  assert.deepEqual(overlapping(["src/a.ts"], ["src/a.ts"]), [["src/a.ts", "src/a.ts"]]);
  assert.deepEqual(overlapping(["src/api/x.ts"], ["src/api"]), [["src/api/x.ts", "src/api"]]);
  assert.deepEqual(overlapping(["src/api"], ["src/api/x.ts"]), [["src/api", "src/api/x.ts"]]);
  assert.deepEqual(overlapping(["src/apiv2/x.ts"], ["src/api"]), []);
});

test("claimed files go into 改动范围 once, under the heading, before the next section", () => {
  const once = withScopePaths(ledger, ["src/a.ts", "src/b.ts"], "后端-接口");
  assert.deepEqual(scopePaths(scopeText(once)).sort(), ["src/a.ts", "src/b.ts"]);
  assert.match(once, /## 改动范围\n[\s\S]*- `src\/a\.ts`、`src\/b\.ts`（后端-接口）\n\n## 在跑执行会话/);
  const twice = withScopePaths(once, ["src/a.ts", "src/c.ts"], "前端-页面");
  assert.match(twice, /- `src\/c\.ts`（前端-页面）/);
  assert.doesNotMatch(twice, /`src\/a\.ts`（前端-页面）/);
  assert.equal(withScopePaths(twice, ["src/c.ts"], "again"), twice);
});

test("a ledger without the section gets one", () => {
  const out = withScopePaths("# 台账\n\n## 最近完成\n", ["x.ts"], "t");
  assert.deepEqual(scopePaths(scopeText(out)), ["x.ts"]);
});

test("worktree cwds are read from the running table", () => {
  const text = ledger.replace("|---|---|---|---|---|---|---|\n", "|---|---|---|---|---|---|---|\n| abc | app | /wt/app-feat | feat | /tmp/s.md | 施工 | 等 |\n");
  assert.deepEqual(runningCwds(text), ["/wt/app-feat"]);
});

test("a 【冲突】 decision waits for the user, recommendation or not", () => {
  const clock = {};
  const open = [{ line: "- [ ] 【冲突】两条线都改 src/a.ts（推荐：等 L1 合回）", text: "【冲突】两条线都改 src/a.ts（推荐：等 L1 合回）", hasRecommendation: true }];
  dueDecisions(clock, "l1", open, 0);
  const due = dueDecisions(clock, "l1", open, DECISION_TIMEOUT_MS * 3);
  assert.deepEqual(due, { recommend: [], architect: [] });
});

test("inside a lane, a card clashes only with running cards that name the same file or a folder around it", () => {
  const running = [
    { id: "w1", title: "后端-修状态", files: ["server/api/a.py", "tests/test_a.py"] },
    { id: "w2", title: "前端-筛选", files: ["ui/src/views"] },
  ];
  assert.deepEqual(laneClashes(["server/api/b.py"], running), []);
  assert.deepEqual(laneClashes(["tests/test_a.py", "ui/src/views/Log.tsx"], running), [
    { id: "w1", title: "后端-修状态", pairs: [["tests/test_a.py", "tests/test_a.py"]] },
    { id: "w2", title: "前端-筛选", pairs: [["ui/src/views/Log.tsx", "ui/src/views"]] },
  ]);
  assert.deepEqual(laneClashes(["a.py"], []), []);
});
