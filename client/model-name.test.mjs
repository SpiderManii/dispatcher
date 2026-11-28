import assert from "node:assert/strict";
import { test } from "node:test";
import { modelName } from "./model-name.ts";

const cases = [
  ["规划（codex/gpt-6.1-sol high）", "GPT 6.1 Sol", "高"],
  ["后端（codex/gpt-6.1-sol medium）", "GPT 6.1 Sol", "中"],
  ["claude-sandbox/sonnet high", "Claude Sonnet", "高"],
  ["claude-sandbox/opus high", "Claude Opus", "高"],
  ["测试（antigravity/gemini-3.8-flash-high）", "Gemini 3.8 Flash", "高"],
  ["备用（cursor/grok-4.7 high）", "Grok 4.7", "高"],
  ["antigravity/gemini-3.8-flash-medium", "Gemini 3.8 Flash", "中"],
  ["codex/gpt-6.1-sol", "GPT 6.1 Sol", null],
  ['调度员（hosted/["hub","vendor/model-name-fast"] high）', "Model Name Fast", "高"],
  ["cursor", "Cursor", null],
];
for (const [label, name, effort] of cases) {
  test(label, () => assert.deepEqual(modelName(label), { name, effort }));
}
