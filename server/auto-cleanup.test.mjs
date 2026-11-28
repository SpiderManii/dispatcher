// Run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLEANUP_EVERY_MS, cleanupDue, parseCleanupRecord } from "./auto-cleanup.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

test("never run, or an unreadable time, is due", () => {
  assert.equal(cleanupDue(null, NOW), true);
  assert.equal(cleanupDue(undefined, NOW), true);
  assert.equal(cleanupDue("not a date", NOW), true);
});

test("due only once a full day has passed", () => {
  assert.equal(cleanupDue(ago(CLEANUP_EVERY_MS - 60_000), NOW), false);
  assert.equal(cleanupDue(ago(CLEANUP_EVERY_MS), NOW), true);
  assert.equal(cleanupDue(ago(CLEANUP_EVERY_MS + 3_600_000), NOW), true);
});

test("a last run in the future (clock moved back) counts as due", () => {
  assert.equal(cleanupDue(new Date(NOW + 3_600_000).toISOString(), NOW), true);
});

test("records survive a round trip, garbage reads as nothing", () => {
  const record = { lastRunAt: ago(1000), archived: 2, workspacesArchived: 1, kept: 0, running: 0, failed: 0 };
  assert.deepEqual(parseCleanupRecord(JSON.stringify(record)), record);
  assert.equal(parseCleanupRecord("{"), null);
  assert.equal(parseCleanupRecord("{}"), null);
});
