import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateLayout, resolveHome } from "./layout-migrate.ts";

function oldHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "layout-"));
  const dir = path.join(home, "调度员", "global");
  mkdirSync(path.join(dir, "台账", "归档"), { recursive: true });
  mkdirSync(path.join(home, "交接"));
  writeFileSync(path.join(home, "项目登记.json"), "{}");
  writeFileSync(path.join(home, "调度员.md"), "rules");
  writeFileSync(path.join(dir, "会话线.md"), "board");
  writeFileSync(path.join(dir, "台账", "l1.md"), "ledger");
  writeFileSync(path.join(dir, "台账", "归档", "l1.md"), "old");
  return home;
}

test("old Chinese names move to ASCII ones and keep a link at the old name", () => {
  const home = oldHome();
  const moved = migrateLayout(home);
  assert.ok(moved.length >= 7);
  assert.equal(readFileSync(path.join(home, "registry.json"), "utf8"), "{}");
  assert.equal(readFileSync(path.join(home, "rules.md"), "utf8"), "rules");
  assert.equal(readFileSync(path.join(home, "dispatchers", "global", "lanes.md"), "utf8"), "board");
  assert.equal(readFileSync(path.join(home, "dispatchers", "global", "ledgers", "l1.md"), "utf8"), "ledger");
  assert.equal(readFileSync(path.join(home, "dispatchers", "global", "ledgers", "archive", "l1.md"), "utf8"), "old");
  assert.ok(lstatSync(path.join(home, "项目登记.json")).isSymbolicLink());
  assert.equal(readFileSync(path.join(home, "调度员", "global", "台账", "l1.md"), "utf8"), "ledger", "an old absolute path still opens");
});

test("a second run changes nothing, and a name that already has its new counterpart is left alone", () => {
  const home = oldHome();
  migrateLayout(home);
  assert.deepEqual(migrateLayout(home), []);
  const other = oldHome();
  writeFileSync(path.join(other, "registry.json"), "new");
  migrateLayout(other);
  assert.equal(readFileSync(path.join(other, "registry.json"), "utf8"), "new");
  assert.ok(!lstatSync(path.join(other, "项目登记.json")).isSymbolicLink());
  const missing = path.join(os.tmpdir(), "no-such-home-x");
  assert.ok(!existsSync(missing));
  assert.deepEqual(migrateLayout(missing), []);
});

test("the home is the setting, else ~/.paseo/dispatch-center", () => {
  assert.equal(resolveHome({ PASEO_DISPATCH_HOME: "/x/y" }), "/x/y");
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-"));
  const home = resolveHome({ PASEO_HOME: root });
  assert.ok(home === path.join(root, "dispatch-center") || home.endsWith("Paseo调度中心"));
});
