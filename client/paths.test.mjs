// run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePastedPaths, resolveByName } from "./paths.ts";

test("pasted paths: one per line, quotes and file URLs handled, duplicates and blanks dropped", () => {
  const text = [
    "/Users/w/git/backend",
    "",
    "  '/Users/w/git/frontend/'  ",
    '"/Users/w/My Repo"',
    "file:///Users/w/git/%E7%BD%91%E5%85%B3",
    "/Users/w/git/backend",
  ].join("\n");
  assert.deepEqual(parsePastedPaths(text), [
    "/Users/w/git/backend",
    "/Users/w/git/frontend",
    "/Users/w/My Repo",
    "/Users/w/git/网关",
  ]);
  assert.deepEqual(parsePastedPaths("\n  \n"), []);
});

test("dropped folders: a full path is used as is, a bare name only when exactly one known folder matches", () => {
  const known = ["/Users/w/git/backend", "/Users/w/git/frontend", "/tmp/a/frontend", "/Users/w/git/shop/"];
  const result = resolveByName(
    [
      { name: "x", path: "/Users/w/x" },
      { name: "backend", path: null },
      { name: "frontend", path: null },
      { name: "shop", path: null },
      { name: "nowhere", path: null },
    ],
    known,
  );
  assert.deepEqual(result.paths, ["/Users/w/x", "/Users/w/git/backend", "/Users/w/git/shop/"]);
  assert.deepEqual(result.unresolved, ["frontend", "nowhere"]);
});
