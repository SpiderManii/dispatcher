import assert from "node:assert/strict";
import { test } from "node:test";
import { splitDecision } from "./decision-text.ts";

test("splits the recommendation off the question", () => {
  assert.deepEqual(splitDecision("要不要合 dev？（推荐：先不合，等验收）"), { question: "要不要合 dev？", recommendation: "先不合，等验收" });
  assert.deepEqual(splitDecision("用哪个端口？(推荐: 4101)"), { question: "用哪个端口？", recommendation: "4101" });
});

test("a question without a recommendation stays whole", () => {
  assert.deepEqual(splitDecision("  要不要删旧分支？ "), { question: "要不要删旧分支？", recommendation: null });
});
