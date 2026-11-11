// core.ts uses a parameter property, so run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { laneTitle, withoutDispatcherPrefix } from "./core.ts";

const project = (name) => ({ key: name, name, path: "" });

test("a lane is named by its projects and need, with no role prefix", () => {
  assert.equal(laneTitle({ id: "a", projects: [project("商城网关")], summary: "订单导出" }), "商城网关-订单导出");
  assert.equal(laneTitle({ id: "a", projects: [project("后端"), project("前端")], summary: null }), "后端+前端");
  assert.equal(laneTitle({ id: "a", projects: [], summary: "只有需求" }), "只有需求");
});

test("a long need is cut so the sidebar row stays short", () => {
  assert.equal(laneTitle({ id: "a", projects: [], summary: "一二三四五六七八九十一二三四五六七" }), "一二三四五六七八九十一二三四五六…");
});

test("an empty lane still gets a readable name", () => {
  assert.equal(laneTitle({ id: "l0axp2", projects: [], summary: null }), "会话线-l0axp2");
});

test("old titles lose the prefix; anything else is left alone", () => {
  assert.equal(withoutDispatcherPrefix("调度员-shop-从dev分支切"), "shop-从dev分支切");
  assert.equal(withoutDispatcherPrefix("shop-订单导出"), null);
  assert.equal(withoutDispatcherPrefix("调度员-"), null);
  assert.equal(withoutDispatcherPrefix("调度员"), null);
});
