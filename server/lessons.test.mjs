import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { layoutFor, lessonsPath, MAX_LESSONS_IN_CONTEXT, readLessons, readRules, seedRegistry, syncFiles } from "./core.ts";

function home() {
  const layout = layoutFor(mkdtempSync(path.join(os.tmpdir(), "lessons-")));
  const registry = seedRegistry();
  writeFileSync(path.join(layout.home, registry.rulesFile), "# 规则\n");
  return { layout, registry };
}
const agentsFile = (layout) => readFileSync(path.join(layout.dispatcherDir("global"), "AGENTS.md"), "utf8");

test("sync creates an empty lessons file, and with no lessons the rules hash stays the rules' own", () => {
  const { layout, registry } = home();
  syncFiles(layout, registry);
  assert.match(readFileSync(lessonsPath(layout), "utf8"), /# 调度教训/);
  assert.deepEqual(readLessons(layout), []);
  assert.equal(readRules(layout, registry).hash, createHash("sha256").update("# 规则\n").digest("hex").slice(0, 12));
  assert.match(agentsFile(layout), /# 调度教训/);
  assert.match(agentsFile(layout), /（还没有）/);
});

test("a lesson changes the hash, so lanes see a rules update, and lands in AGENTS.md", () => {
  const { layout, registry } = home();
  syncFiles(layout, registry);
  const before = readRules(layout, registry).hash;
  appendFileSync(lessonsPath(layout), "- 2026-11-26 事故：测试卡派给了调度员配置 → 规则：测试角色不借调度员的备注\n");
  const after = readRules(layout, registry);
  assert.notEqual(after.hash, before);
  assert.equal(after.lessons.length, 1);
  syncFiles(layout, registry);
  assert.match(agentsFile(layout), /测试卡派给了调度员配置/);
  assert.doesNotMatch(agentsFile(layout), /（还没有）/);
});

test("only the newest lessons go into the context; the file keeps the rest", () => {
  const { layout, registry } = home();
  syncFiles(layout, registry);
  for (let index = 1; index <= MAX_LESSONS_IN_CONTEXT + 2; index += 1)
    appendFileSync(lessonsPath(layout), `- 第${index}条 事故：x → 规则：y\n`);
  syncFiles(layout, registry);
  const text = agentsFile(layout);
  assert.doesNotMatch(text, /- 第1条 /);
  assert.doesNotMatch(text, /- 第2条 /);
  assert.match(text, /- 第3条 /);
  assert.match(text, new RegExp(`- 第${MAX_LESSONS_IN_CONTEXT + 2}条 `));
  assert.match(text, /更早的 2 条在文件里/);
});
