import assert from "node:assert/strict";
import { test } from "node:test";
import { requirementTitle } from "./lane-text.ts";

test("a numbered list reads as its first item plus a count", () => {
  assert.equal(
    requirementTitle("1.商品列表和详情页要调整；2.订单详情页去掉重复信息"),
    "商品列表和详情页要调整 等 2 项",
  );
  assert.equal(requirementTitle("一、接口加字段\n二、前端展示\n三、联调"), "接口加字段 等 3 项");
});

test("one sentence stays as it is; a long one is cut", () => {
  assert.equal(requirementTitle("订单页接入新接口"), "订单页接入新接口");
  const long = "店铺打折现在是全部商品统一打折，希望改成可以按分类单独设置折扣，并在后台列表里显示出来";
  assert.equal(requirementTitle(long), `${[...long].slice(0, 32).join("")}…`);
});

test("versions and decimals are not list numbers", () => {
  assert.equal(requirementTitle("升级到 1.2 版本"), "升级到 1.2 版本");
});

test("nothing to say gives null", () => {
  assert.equal(requirementTitle(null), null);
  assert.equal(requirementTitle("   "), null);
});
