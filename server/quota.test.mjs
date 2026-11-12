import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuotas, quotaState } from "./quota.ts";

const QUOTAS = parseQuotas({
  data: [
    { provider: "codex", windows: [{ name: "5 hours", used: 63, remaining: 37 }, { name: "7 days", used: 47, remaining: 53 }] },
    { provider: "grok", windows: [{ name: "7 days", used: 100, remaining: 0, resetsAt: "2026-11-17T02:38:58Z" }] },
    {
      provider: "antigravity",
      windows: [
        { name: "Gemini · 7 days", used: 80, remaining: 20, pool: "Gemini" },
        { name: "Claude & GPT · 7 days", used: 100, remaining: 0, pool: "Claude & GPT" },
      ],
    },
    { provider: "claude", windows: [{ name: "5 hours", used: 45, remaining: 55 }, { name: "7 days · Fable", used: 100, remaining: 0 }] },
    { provider: "broken" },
  ],
});

test("a used-up family is blocked until reset", () => {
  const state = quotaState(QUOTAS, "grok", "cursor/grok-4.7");
  assert.match(state.blocked, /grok 额度已用完（7 days，2026-11-17T02:38:58Z 重置）/);
});

test("a pool only covers its own models", () => {
  assert.equal(quotaState(QUOTAS, "antigravity", "antigravity/gemini-3.8-flash-high").blocked, null);
  assert.match(quotaState(QUOTAS, "antigravity", "antigravity/gemini-3.8-flash-high").low, /剩余 20%（Gemini · 7 days），不接长活/);
  assert.ok(quotaState(QUOTAS, "antigravity", "antigravity/claude-sonnet").blocked);
});

test("a window named for one model doesn't block the others", () => {
  assert.deepEqual(quotaState(QUOTAS, "claude", "claude-host/sonnet"), { blocked: null, low: null });
  assert.ok(quotaState(QUOTAS, "claude", "claude-host/fable").blocked);
});

test("plenty left, or an untracked family, passes silently", () => {
  assert.deepEqual(quotaState(QUOTAS, "codex", "codex/gpt-6.1-sol"), { blocked: null, low: null });
  assert.deepEqual(quotaState(QUOTAS, null, "pi/x"), { blocked: null, low: null });
  assert.deepEqual(quotaState(QUOTAS, "copilot", "copilot/x"), { blocked: null, low: null });
});

test("a malformed body yields nothing to check", () => {
  assert.deepEqual(parseQuotas(null), []);
  assert.deepEqual(parseQuotas({ data: "x" }), []);
  assert.equal(QUOTAS.find((entry) => entry.provider === "broken"), undefined);
});
