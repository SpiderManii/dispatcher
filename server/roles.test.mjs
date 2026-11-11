// core.ts uses a parameter property, so run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { layoutFor, updateRegistry } from "./core.ts";
import { autoConfig, availability, DEFAULT_ROLES, pickCandidate, resolveCandidate } from "./roles.ts";

const model = (id, extra = {}) => ({ id, label: id, isDefault: false, thinking: [], defaultThinking: null, ...extra });
const provider = (id, extra = {}) => ({
  id,
  label: id,
  enabled: true,
  status: "ready",
  models: [],
  modes: [],
  defaultModeId: null,
  ...extra,
});
const CATALOG = [
  provider("claude", { enabled: false }),
  provider("codex", { models: [model("gpt-a"), model("gpt-b", { isDefault: true, defaultThinking: "medium" })] }),
  provider("pi", { status: "error" }),
];
const role = (candidates) => ({ id: "backend", name: "后端", when: "x", candidates });

test("built-in roles name no Paseo Agent configs", () => {
  for (const item of DEFAULT_ROLES) assert.deepEqual(item.candidates, []);
});

test("availability reports a missing, disabled or broken provider and an unknown model", () => {
  assert.match(availability("nope/x", CATALOG), /没有 provider/);
  assert.match(availability("claude/opus", CATALOG), /没有启用/);
  assert.match(availability("pi", CATALOG), /不可用/);
  assert.match(availability("codex/gpt-z", CATALOG), /没有模型/);
  assert.equal(availability("codex/gpt-a", CATALOG), null);
  assert.equal(availability("codex", CATALOG), null);
});

test("without a catalog nothing is refused", () => {
  assert.equal(availability("anything/at-all", null), null);
});

test("a model ID with its own slash is still matched", () => {
  const catalog = [provider("codex", { models: [model("auto/grok-4.7")] })];
  assert.equal(availability("codex/auto/grok-4.7", catalog), null);
});

test("auto picks the first ready provider on its default model and thinking", () => {
  const chosen = autoConfig(CATALOG);
  assert.equal(chosen.provider, "codex/gpt-b");
  assert.equal(chosen.thinkingOptionId, "medium");
  assert.match(chosen.label, /^自动/);
});

test("auto honours avoid", () => {
  assert.equal(autoConfig(CATALOG, ["codex"]), null);
});

test("a role with no candidates runs on auto", () => {
  const { chosen } = pickCandidate(role([]), [], [], CATALOG);
  assert.equal(chosen.provider, "codex/gpt-b");
});

test("an unavailable direct candidate is skipped for the next one", () => {
  const { chosen, skipped } = pickCandidate(
    role([{ provider: "claude/opus" }, { provider: "codex/gpt-a", thinkingOptionId: "high" }]),
    [],
    [],
    CATALOG,
  );
  assert.equal(chosen.provider, "codex/gpt-a");
  assert.equal(chosen.thinkingOptionId, "high");
  assert.equal(skipped.length, 1);
});

test("a role whose candidates all fail does not fall back to auto", () => {
  const { chosen } = pickCandidate(role([{ provider: "claude/opus" }]), [], [], CATALOG);
  assert.equal(chosen, null);
});

test("a profile on a disabled provider is reported", () => {
  const resolved = resolveCandidate({ profile: "审查" }, [{ id: "p1", name: "审查", provider: "claude", model: "opus" }], CATALOG);
  assert.match(resolved.problem, /审查：.*没有启用/);
});

test("updateRegistry keeps unknown fields and refuses an invalid change", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dispatch-roles-"));
  const layout = layoutFor(home);
  const base = { version: 1, rulesFile: "r.md", dispatchers: [{ id: "global", name: "g" }], projects: [], extra: 1 };
  writeFileSync(layout.registryPath, JSON.stringify(base));
  updateRegistry(layout, (raw) => {
    raw.roles = [{ id: "backend", name: "后端", when: "x", candidates: [{ provider: "codex/gpt-a" }] }];
  });
  const saved = JSON.parse(readFileSync(layout.registryPath, "utf8"));
  assert.equal(saved.extra, 1);
  assert.equal(saved.roles[0].candidates[0].provider, "codex/gpt-a");
  assert.throws(
    () => updateRegistry(layout, (raw) => (raw.roles = [{ id: "Bad ID", name: "x", when: "x", candidates: [] }])),
    /没有保存/,
  );
  assert.equal(JSON.parse(readFileSync(layout.registryPath, "utf8")).roles[0].id, "backend");
});
