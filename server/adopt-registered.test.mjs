import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { adoptRegistered, holdersOf } from "./core.ts";

const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "adopt-")));
const lane = (id, projects) => ({ id, projects });
const state = (lanes) => ({ version: 1, queue: [], dispatchers: { global: { lanes } } });
const registry = { projects: [{ id: "sync", name: "示例项目", repos: [folder] }] };

test("a lane that took a folder before it was registered moves onto the project's ID and sees its neighbour", () => {
  const s = state([
    lane("old", [{ key: `dir:${folder}`, name: "folder-name", path: folder, branch: "dev" }]),
    lane("new", [{ key: "sync", name: "示例项目", path: folder }]),
  ]);
  assert.equal(holdersOf(s, "sync", "new").length, 0);
  assert.deepEqual(adoptRegistered(s, registry), ["会话线 old：folder-name → 登记项目 sync"]);
  assert.deepEqual(s.dispatchers.global.lanes[0].projects, [{ key: "sync", name: "示例项目", path: folder, branch: "dev" }]);
  assert.deepEqual(holdersOf(s, "sync", "new").map(({ lane }) => lane.id), ["old"]);
  assert.deepEqual(adoptRegistered(s, registry), []);
});

test("a lane holding both forms keeps one entry, and folders still unregistered stay as they are", () => {
  const other = path.join(folder, "..", "never-registered");
  const s = state([
    lane("both", [
      { key: "sync", name: "示例项目", path: folder },
      { key: `dir:${folder}`, name: "folder-name", path: folder, branch: "feat" },
      { key: `dir:${other}`, name: "other", path: other },
    ]),
  ]);
  adoptRegistered(s, registry);
  assert.deepEqual(s.dispatchers.global.lanes[0].projects, [
    { key: "sync", name: "示例项目", path: folder, branch: "feat" },
    { key: `dir:${other}`, name: "other", path: other },
  ]);
});
