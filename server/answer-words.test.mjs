import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeAnswer } from "./answer-words.ts";

test("answers: 按推荐, an option, a bare number", () => {
  for (const text of ["按推荐", "照推荐做", "选①", "选 2", "方案B", "1", "①", "A", "第2条同意", "已过时，不用了", "先停"])
    assert.equal(looksLikeAnswer(text), true, text);
});

test("chatter and new tasks are not answers", () => {
  for (const text of ["", "  ", "现在进度怎么样", "帮我看一下登录页的样式", "继续"]) assert.equal(looksLikeAnswer(text), false, text);
});
