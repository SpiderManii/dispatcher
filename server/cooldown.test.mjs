import assert from "node:assert/strict";
import { test } from "node:test";
import { COOLDOWN_MS, MAX_COOLDOWN_MS, activeCooldown, cooldownFor, cooldownReason, resetTime, withCooldown } from "./cooldown.ts";

const now = Date.parse("2026-11-18T09:18:00.000Z");

test("the errors from the price lane cool their provider down", () => {
  const busy = cooldownFor("grok", "API error (attempt 5): UNAVAILABLE (code 503): No capacity available for model grok-4.7", now);
  assert.equal(busy.until - now, COOLDOWN_MS);
  assert.equal(busy.reason, "报 503 没容量");
  assert.equal(cooldownFor("codex", "429 Too Many Requests", now).reason, "被限流");
});

test("a used-up allowance waits for the reset time it names", () => {
  // 11:09 UTC (11:09 in London in winter): the reset is 41 minutes away.
  const at = Date.parse("2026-01-15T11:09:00.000Z");
  const claude = cooldownFor("claude", "Internal error: You've hit your 5-hour limit · resets 11:50am (Europe/London)", at);
  assert.equal(claude.until, Date.parse("2026-01-15T11:50:00.000Z"));
  assert.equal(claude.reason, "用量到上限");
  // Once 11:50 has passed there, the next one is a day out, beyond the cap: back after the cap instead.
  const late = Date.parse("2026-01-15T12:00:00.000Z");
  assert.equal(cooldownFor("claude", "You've hit your 5-hour limit · resets 11:50am (Europe/London)", late).until - late, MAX_COOLDOWN_MS);
  assert.equal(resetTime("resets 6:50am (Nowhere/Zone)", at), null, "an unknown zone is no reset time");
});

test("failures that say nothing about capacity leave the provider alone", () => {
  for (const detail of ["There was a network issue connecting to the server, please try again.", "kill EPERM", null])
    assert.equal(cooldownFor("grok", detail, now), null);
  assert.equal(cooldownFor(null, "No capacity available", now), null, "no family, nothing to skip");
});

test("one live entry per family; it ends on time", () => {
  const first = cooldownFor("grok", "No capacity available", now);
  const later = cooldownFor("grok", "No capacity available", now + 60_000);
  const list = withCooldown(withCooldown([], first, now), later, now + 60_000);
  assert.equal(list.length, 1);
  assert.equal(list[0].until, later.until);
  assert.ok(activeCooldown(list, "grok", now + 60_000));
  assert.equal(activeCooldown(list, "grok", later.until), null);
  assert.equal(activeCooldown(list, "codex", now), null);
  assert.match(cooldownReason(first, "UTC"), /09:18 刚报 503 没容量，插件到 09:48 前自动跳过这一家/);
});
