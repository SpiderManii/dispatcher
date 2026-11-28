import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "./map-limit.ts";

test("keeps input order and never runs more than the limit at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapLimit([30, 10, 20, 5, 15], 2, async (ms) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, ms));
    inFlight -= 1;
    return ms * 2;
  });
  assert.deepEqual(results, [60, 20, 40, 10, 30]);
  assert.equal(peak, 2);
});

test("handles an empty list", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
