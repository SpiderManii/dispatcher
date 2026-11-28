import assert from "node:assert/strict";
import { test } from "node:test";
import { staleDecisions, staleReason } from "./stale-decisions.ts";

const item = (text) => ({ line: `- [ ] ${text}`, text, hasRecommendation: false });

test("a finished requirement has nothing left to decide", () => {
  assert.ok(staleReason("用哪个方案", "完成"));
  assert.equal(staleDecisions([item("a"), item("【冲突】b")], { step: "完成" }).length, 2);
});

test("a gate question is moot once the lane is past that gate", () => {
  assert.ok(staleReason("是否同意合回 dev", "部署"));
  assert.ok(staleReason("要不要部署 api", "推送"));
  assert.equal(staleReason("要不要部署 api", "部署"), null);
  assert.equal(staleReason("要不要部署 api", "开发"), null);
});

test("a question that mentions a gate still ahead stays open", () => {
  assert.equal(staleReason("合回后是否部署", "部署"), null);
});

test("questions about no gate, or a lane with no stage, are left to the dispatcher", () => {
  assert.equal(staleReason("用哪个方案", "推送"), null);
  assert.deepEqual(staleDecisions([item("合回？")], null), []);
});
