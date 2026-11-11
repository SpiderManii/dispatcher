import assert from "node:assert/strict";
import { test } from "node:test";
import * as contracts from "./contracts.ts";

// defineRpc throws on a bad name when the module loads, which fails plugin reload. tsc can't see that.
test("every RPC loads with a valid name, and no two share one", () => {
  const names = Object.values(contracts).flatMap((value) => (typeof value?.name === "string" ? [value.name] : []));
  assert.ok(names.length > 10);
  for (const name of names) assert.match(name, /^[a-z][a-z0-9._-]*$/);
  assert.equal(new Set(names).size, names.length);
});
