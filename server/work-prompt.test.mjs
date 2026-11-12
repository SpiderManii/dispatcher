import assert from "node:assert/strict";
import { test } from "node:test";
import { cardFeedback, mustBlock } from "./work-card-text.ts";

test("the card is never rewritten: feedback only points at what could go", () => {
  const sections = {
    任务: "在 worktree /tmp 上复跑。先核对 HEAD 是 bab8b09e，不符就停。\n写完就停。",
    改与不改: "只读，不改代码。",
    其他: "禁止再开子 agent。只读，不改代码。",
  };
  const note = cardFeedback(sections, "短");
  assert.match(note, /「必守」已有、不用再写：写完就停。 禁止再开子 agent。/);
  assert.match(note, /同一句写在了几栏里：「只读，不改代码。」（改与不改、其他）/);
  assert.match(note, /这张已照原文派出/);
  // A check that names a SHA is the dispatcher's to keep: not flagged as a repeat of 必守.
  assert.doesNotMatch(note, /bab8b09e/);
});

test("a clean, short card gets no feedback; a long one is told its length", () => {
  assert.equal(cardFeedback({ 任务: "做 A。", 改与不改: "只改 a.py。" }, "短"), null);
  assert.match(cardFeedback({ 任务: "做 A。" }, "字".repeat(1600)), /1600 字，偏长/);
});

test("必守 names the expected HEAD only when the card has one", () => {
  assert.match(mustBlock("bab8b09e"), /与本卡的 cwd、预期分支、预期 HEAD不符立即停/);
  assert.doesNotMatch(mustBlock(undefined), /预期 HEAD/);
  assert.match(mustBlock(undefined), /黑名单：全仓 find/);
});
