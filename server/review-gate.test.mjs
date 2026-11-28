import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The service picks its dispatch home when it loads, so the temporary one is set first.
const home = mkdtempSync(path.join(os.tmpdir(), "dispatch-review-"));
process.env.PASEO_DISPATCH_HOME = home;
const { landLane, requestReview, waiveReview } = await import("./service.ts");
const { layoutFor, loadState, renderLedger, saveState } = await import("./core.ts");

const layout = layoutFor(home);
const ledgerPath = path.join(home, "l1.md");
const hit = { kind: "迁移", text: "migrations/sql/2026_add_stock.sql", card: "后端-库存-商品页", at: "2026-11-17T01:00:00.000Z" };

function setUp(review, status = "idle") {
  writeFileSync(ledgerPath, renderLedger({ id: "global", name: "全局调度员" }, { id: "l1", projects: [], summary: "部门额度" }).replace("- 阶段：计划", "- 阶段：待合回"));
  saveState(layout, {
    version: 1,
    dispatchers: {
      global: {
        workspaceId: null,
        lanes: [
          {
            id: "l1",
            agentId: "dispatcher-1",
            workspaceId: null,
            projects: [],
            summary: "部门额度",
            ledgerPath,
            startedAt: "2026-11-17T00:00:00.000Z",
            rulesHash: null,
            pendingHandoff: null,
            review,
          },
        ],
        lastError: null,
        pushableKept: [],
        history: [],
      },
    },
    queue: [],
  });
  const sent = [];
  const paseo = {
    agents: {
      ref: (id) => ({
        refresh: async () => ({ agent: { id, status, archivedAt: null } }),
        send: async (text) => sent.push({ id, text }),
      }),
    },
  };
  return { paseo, sent };
}

const lane = { dispatcherId: "global", laneId: "l1" };
const events = () => {
  const file = path.join(path.dirname(layout.statePath), "events", "l1.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).kind) : [];
};

test("同意合回 is refused while a sensitive change has no review, and while its review runs", async () => {
  const { paseo, sent } = setUp({ hits: [hit], reviewers: [], waived: null });
  await assert.rejects(landLane(paseo, lane), /敏感改动（迁移），还没审查/);
  const running = setUp({ hits: [hit], reviewers: [{ agentId: "r1", at: "2026-11-17T02:00:00.000Z", outcome: null, endedAt: null }], waived: null });
  await assert.rejects(landLane(running.paseo, lane), /审查还在跑/);
  assert.equal(sent.length + running.sent.length, 0, "nothing reaches the dispatcher");
});

test("派审查 tells the dispatcher what was found and moves the stage back to 验收", async () => {
  const { paseo, sent } = setUp({ hits: [hit], reviewers: [], waived: null });
  assert.deepEqual(await requestReview(paseo, lane), { sent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "dispatcher-1");
  assert.match(sent[0].text, /迁移：migrations\/sql\/2026_add_stock\.sql（卡「后端-库存-商品页」）/);
  assert.match(sent[0].text, /dispatch_work 派 review 角色只读审查一次/);
  assert.match(readFileSync(ledgerPath, "utf8"), /- 阶段：验收（用户在页面要求审查）/);
  assert.ok(events().includes("review_requested"));
});

test("派审查 waits for a busy dispatcher, and is not offered twice", async () => {
  const busy = setUp({ hits: [hit], reviewers: [], waived: null }, "running");
  await assert.rejects(requestReview(busy.paseo, lane), /调度员正在执行/);
  const done = setUp({ hits: [hit], reviewers: [{ agentId: "r1", at: "2026-11-17T02:00:00.000Z", outcome: "ended", endedAt: "2026-11-17T03:00:00.000Z" }], waived: null });
  await assert.rejects(requestReview(done.paseo, lane), /已经审查过了/);
  const none = setUp(undefined);
  await assert.rejects(requestReview(none.paseo, lane), /没在这条需求的任务卡上认出敏感改动/);
});

test("不用审查 is kept in the state and the ledger, and lets 同意合回 through", async () => {
  const { paseo } = setUp({ hits: [hit], reviewers: [], waived: null });
  assert.deepEqual(await waiveReview(lane), { ok: true });
  assert.ok(loadState(layout).dispatchers.global.lanes[0].review.waived);
  assert.match(readFileSync(ledgerPath, "utf8"), /- 不审查：插件认出的敏感改动（迁移），用户在页面点了「不用审查」/);
  assert.ok(events().includes("review_waived"));
  // Nothing left to merge on a lane with no projects: no refusal, nothing sent.
  assert.deepEqual(await landLane(paseo, lane), { sent: false, unlanded: [], toIntegrate: [] });
});

test("a finished review lets 同意合回 through", async () => {
  const { paseo } = setUp({ hits: [hit], reviewers: [{ agentId: "r1", at: "2026-11-17T02:00:00.000Z", outcome: "ended", endedAt: "2026-11-17T03:00:00.000Z" }], waived: null });
  assert.deepEqual(await landLane(paseo, lane), { sent: false, unlanded: [], toIntegrate: [] });
});
