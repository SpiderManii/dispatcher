import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { layoutFor, rulesPath, seedRegistry, seedRules } from "./core.ts";

const template = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "rules.md");

test("first run copies the rules template in, and never overwrites rules someone wrote", () => {
  const layout = layoutFor(mkdtempSync(path.join(os.tmpdir(), "rules-seed-")));
  const registry = seedRegistry();
  const written = seedRules(layout, registry, template);
  assert.equal(written, rulesPath(layout, registry));
  assert.equal(readFileSync(written, "utf8"), readFileSync(template, "utf8"));

  writeFileSync(written, "# 我自己的规则\n");
  assert.equal(seedRules(layout, registry, template), null);
  assert.equal(readFileSync(written, "utf8"), "# 我自己的规则\n");
});

test("without a template nothing is written", () => {
  const layout = layoutFor(mkdtempSync(path.join(os.tmpdir(), "rules-seed-")));
  assert.equal(seedRules(layout, seedRegistry(), null), null);
  assert.equal(seedRules(layout, seedRegistry(), path.join(layout.home, "missing.md")), null);
});

test("the template keeps the 14 numbered sections the plugin's prompts point to, and stays short", () => {
  const text = readFileSync(template, "utf8");
  const numbers = [...text.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
  assert.deepEqual(numbers, Array.from({ length: 14 }, (_, index) => index + 1));
  // Every dispatcher session carries the whole file in its context: growth here is paid on every session.
  assert.ok(text.length < 22_000, `模板 ${text.length} 字，偏长：每个调度员会话都要带上它`);
});
