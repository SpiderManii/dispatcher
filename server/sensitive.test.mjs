import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewViewOf, sensitiveHits, withDispatchRecord, withReviewerOutcome, writesCode } from "./sensitive.ts";

const card = (fields) => ({ title: "后端-x-y", task: "做 x", scope: "只改 x", files: "无", ...fields });
const kinds = (fields) => [...new Set(sensitiveHits(card(fields)).map((hit) => hit.kind))];

test("migrations show by path in all three projects, and by the words a card uses for them", () => {
  assert.deepEqual(kinds({ files: "shop-extras/shop_extras/migrations/20260101120000_add_discount/migration.sql" }), ["迁移"]);
  assert.deepEqual(kinds({ files: "schema.prisma、server/schema.prisma" }), ["迁移"]);
  assert.deepEqual(kinds({ files: "migrations/sql/2026_01_05_store_quota.sql" }), ["迁移"]);
  assert.deepEqual(kinds({ task: "给 ProductTable 加列 discount，迁移单独成单" }), ["迁移"]);
  assert.deepEqual(kinds({ scope: "ALTER TABLE product ADD COLUMN discount" }), ["迁移"]);
});

test("keys and credentials show by the words and by where secret code lives", () => {
  assert.deepEqual(kinds({ title: "后端-支付凭据保存-支付设置" }), ["密钥"]);
  assert.deepEqual(kinds({ task: "页面填写并保存 PAYMENT_ACCESS_KEY、PAYMENT_SECRET_KEY" }), ["密钥"]);
  assert.deepEqual(kinds({ files: "app/secret_managers/main.py" }), ["密钥"]);
  assert.deepEqual(kinds({ files: "server/integrations/outbound_credentials/store.py" }), ["密钥"]);
  assert.deepEqual(kinds({ files: "plugins/secrets_plugins/aws.py" }), ["密钥"]);
  assert.deepEqual(kinds({ files: ".env、.env.development" }), [], ".env is local and not committed");
});

test("auth shows by its modules and pages, camelCase included", () => {
  assert.deepEqual(kinds({ files: "server/auth/api_key_auth.py" }), ["鉴权"]);
  assert.deepEqual(kinds({ files: "web/src/components/Settings/SSOSettings/index.tsx" }), ["鉴权"]);
  assert.deepEqual(kinds({ files: "app/api/routers/admin/auth.py" }), ["鉴权"]);
  assert.deepEqual(kinds({ files: "src/components/ReAuth/index.ts" }), ["鉴权"]);
  assert.deepEqual(kinds({ task: "补上权限校验，防止越权" }), ["鉴权"]);
});

test("API formats show by the files that define them and by what the card says it changes", () => {
  assert.deepEqual(kinds({ files: "server/_types.py" }), ["接口格式"]);
  assert.deepEqual(kinds({ files: "app/api/schemas/store_directory.py" }), ["接口格式"]);
  assert.deepEqual(kinds({ scope: "列表接口的返回格式改成分页结构" }), ["接口格式"]);
  assert.deepEqual(kinds({ task: "在 1a2b3c4d 上补订单 v2 返回形态测试，必要时只修时间格式" }), ["接口格式"]);
});

test("what a card says it leaves alone is not counted, a whole 「不改」 list included", () => {
  assert.deepEqual(kinds({ scope: "改商品详情页样式；不改：迁移、鉴权、密钥、接口" }), []);
  assert.deepEqual(kinds({ scope: "不改 schema.prisma 和 server/auth/handler.py" }), []);
  assert.deepEqual(kinds({ task: "确认无迁移、无 schema 变化" }), []);
  assert.deepEqual(kinds({ scope: "接口格式不变，只改展示" }), []);
  assert.deepEqual(kinds({ files: "只读参考 server/auth/handler.py" }), []);
});

test("ordinary words around them do not cancel a real one", () => {
  assert.deepEqual(kinds({ task: "按不同分类设置折扣需要加列" }), ["迁移"]);
  assert.deepEqual(kinds({ task: "参考库存上限预扣要新建表" }), ["迁移"]);
});

test("ordinary changes find nothing: pricing words, tokens, pictures, look-alike names", () => {
  assert.deepEqual(kinds({ title: "前端-分档价格每档一行-订单详情", files: "web/src/components/order_prices.tsx" }), []);
  assert.deepEqual(kinds({ task: "按件数和档位计价，会员按半价" }), []);
  assert.deepEqual(kinds({ files: "src/assets/login/bg.png、docs/authors.md" }), []);
  assert.deepEqual(kinds({ task: "参考商品单独计价，按不同规格" }), []);
});

test("from real cards: logging in with a key, not printing one and the keys page's wording are not key changes", () => {
  assert.deepEqual(kinds({ task: "打开 http://127.0.0.1:3000，用预览管理凭据登录（凭据从本 worktree .env 内存读取）" }), []);
  assert.deepEqual(kinds({ task: "记录 store_id 与两个商品名，密钥不打印不落盘" }), []);
  assert.deepEqual(kinds({ scope: "不输出密钥；登录用户名密码只从现有本地 .env 读取" }), []);
  assert.deepEqual(kinds({ task: "`notice.disabled_for_key`（「此密钥已禁用」）：商品页使用时用通用文案" }), []);
  assert.deepEqual(kinds({ task: "副标题在商品页写「此密钥关联的店铺」→ 改成不指向「密钥」的通用措辞（zh/en 同步）" }), []);
  assert.deepEqual(kinds({ task: "确保密钥详情页语义仍正确" }), []);
  assert.deepEqual(kinds({ files: "web/src/components/store/ObjectPermissionsView.tsx" }), []);
  assert.deepEqual(kinds({ task: "启动前读 schema.prisma 生成 client，环境用 .env.development" }), [], "paths in the task are what it reads or runs");
});

test("from real cards: entering and saving keys is a key change", () => {
  assert.deepEqual(kinds({ task: "在支付设置卡片上增加 PAYMENT_ACCESS_KEY 与 PAYMENT_SECRET_KEY 的录入与保存" }), ["密钥"]);
  assert.deepEqual(kinds({ scope: "隐藏 Access Key 与密钥输入框和保存凭证按钮" }), ["密钥"]);
  assert.deepEqual(kinds({ title: "前端-支付凭据表单-支付设置" }), ["密钥"]);
});

test("from real cards: running, applying or checking migrations is not writing one", () => {
  assert.deepEqual(kinds({ task: "预览必须关闭自动迁移" }), []);
  assert.deepEqual(kinds({ task: "让迁移只发生在这个空的隔离库上，不在共用库上迁移" }), []);
  assert.deepEqual(kinds({ task: "在预览隔离库应用待迁移并起服务：列出 pending 迁移、checksum 状态、是否有失败迁移" }), []);
  assert.deepEqual(kinds({ task: "在隔离库验证迁移 20260101120000_add_discount/migration.sql" }), []);
  assert.deepEqual(kinds({ title: "后端-隔离库迁移检查-界面" }), []);
  assert.deepEqual(kinds({ scope: "不改：鉴权快照选择与扣款链路、UI 与 gen:api、schema.prisma/迁移" }), []);
});

test("a login session used to look at a page is not an auth change", () => {
  // A frontend re-check card said the browser was already logged in, and the lane was sent for a review.
  assert.deepEqual(kinds({ title: "前端-分类折扣卡-视觉复查", task: "浏览器已有管理员登录态，打开商品页截图核对折扣卡" }), []);
  assert.deepEqual(kinds({ task: "需要登录态才能看商品页" }), []);
  assert.deepEqual(kinds({ task: "修复登录态过期后不跳转登录页的问题" }), ["鉴权"]);
  assert.deepEqual(kinds({ task: "新增登录校验：未登录访问商品页返回 401" }), ["鉴权"]);
});

test("a read-only .sql check is no migration; migration-like .sql files still are", () => {
  // A read-only query was taken for a migration and the lane was asked for a review.
  assert.deepEqual(kinds({ title: "backend-库存只读查询-Q1", files: "db_scripts/verify_stock_fields.sql" }), []);
  assert.deepEqual(kinds({ files: "db/20260101090000_add_stock/up.sql" }), ["迁移"]);
  assert.deepEqual(kinds({ files: "sql/schema_v2.sql" }), ["迁移"]);
  assert.deepEqual(kinds({ files: "deploy/ddl_stock.sql" }), ["迁移"]);
});

test("from real cards: writing a migration is", () => {
  assert.deepEqual(kinds({ task: "在 shop-extras 迁移链新增只加该列的前向 SQL" }), ["迁移"]);
  assert.deepEqual(kinds({ scope: "允许按点名文件改 schema 与迁移" }), ["迁移"]);
  assert.deepEqual(kinds({ task: "新迁移目录 `20260101120000_add_discount/migration.sql`，只做 ALTER TABLE ADD COLUMN" }), ["迁移"]);
});

test("from real cards: auth tests run, auth kept, keys used or made at run time are not changes", () => {
  assert.deepEqual(kinds({ task: "修完重跑任务卡全部命令（11 个后端文件 + 鉴权专项 + 前端两个 vitest）" }), []);
  assert.deepEqual(kinds({ scope: "GET 保留鉴权/归属/响应语义" }), []);
  assert.deepEqual(kinds({ task: "改为用本机已有的支付凭证" }), []);
  assert.deepEqual(kinds({ task: "只在隔离库经 8080 管理接口新建一把专用密钥" }), []);
  assert.deepEqual(kinds({ task: "不新建凭据" }), []);
  assert.deepEqual(kinds({ task: "鉴权阶段先解析规范对外商品名" }), ["鉴权"]);
  assert.deepEqual(kinds({ task: "不能传别的 store_id 越权" }), ["鉴权"]);
});

test("the dispatcher's own mark counts when the wording shows nothing", () => {
  assert.deepEqual(sensitiveHits(card({ sensitive: ["接口格式"] })), [{ kind: "接口格式", text: "调度员在任务卡上标的" }]);
});

test("a commit command's git add counts as files", () => {
  assert.deepEqual(kinds({ commitCommand: "git add server/auth/rotate.py && git commit -m x" }), ["鉴权"]);
});

test("only code-writing roles are reviewed", () => {
  assert.equal(writesCode("backend"), true);
  assert.equal(writesCode("frontend"), true);
  for (const role of ["split", "review", "architect", "test", "deploy"]) assert.equal(writesCode(role), false);
});

const hit = { kind: "迁移", text: "migrations/x.sql" };

test("a lane with no sensitive card needs no review", () => {
  assert.equal(reviewViewOf(undefined), null);
  assert.equal(reviewViewOf(withDispatchRecord(undefined, { card: "前端-x", at: "2026-11-17T01:00:00Z", hits: [], reviewer: null })), null);
});

test("a sensitive card asks for one review: needed, running, then done", () => {
  let review = withDispatchRecord(undefined, { card: "后端-迁移-x", at: "2026-11-17T01:00:00Z", hits: [hit], reviewer: null });
  assert.deepEqual(reviewViewOf(review), { state: "needed", kinds: ["迁移"], hits: [{ ...hit, card: "后端-迁移-x" }], covered: [] });
  review = withDispatchRecord(review, { card: "审查-迁移-x", at: "2026-11-17T02:00:00Z", hits: [], reviewer: "r1" });
  assert.equal(reviewViewOf(review).state, "running");
  review = withReviewerOutcome(review, "r1", "ended", "2026-11-17T03:00:00Z");
  assert.equal(reviewViewOf(review).state, "done");
  // §9: one review per requirement, so a later sensitive card does not ask again.
  review = withDispatchRecord(review, { card: "后端-返修-x", at: "2026-11-17T04:00:00Z", hits: [{ kind: "密钥", text: "凭据" }], reviewer: null });
  assert.equal(reviewViewOf(review).state, "done");
  assert.deepEqual(reviewViewOf(review).kinds, ["迁移", "密钥"]);
});

test("a review that failed leaves it needed; a plan review from before the code does not count", () => {
  const early = withDispatchRecord(undefined, { card: "审查-计划-x", at: "2026-11-17T00:00:00Z", hits: [], reviewer: "plan" });
  let review = withReviewerOutcome(early, "plan", "ended", "2026-11-17T00:30:00Z");
  review = withDispatchRecord(review, { card: "后端-迁移-x", at: "2026-11-17T01:00:00Z", hits: [hit], reviewer: null });
  assert.equal(reviewViewOf(review).state, "needed");
  review = withDispatchRecord(review, { card: "审查-迁移-x", at: "2026-11-17T02:00:00Z", hits: [], reviewer: "r1" });
  review = withReviewerOutcome(review, "r1", "failed", "2026-11-17T02:10:00Z");
  assert.equal(reviewViewOf(review).state, "needed");
  assert.equal(withReviewerOutcome(review, "r1", "ended", "2026-11-17T02:20:00Z"), null, "the first outcome sticks");
  assert.equal(withReviewerOutcome(review, "someone-else", "ended", "2026-11-17T02:20:00Z"), null);
});

test("the user's 不用审查 settles it; the same finding is kept once", () => {
  const review = withDispatchRecord(undefined, { card: "后端-迁移-x", at: "2026-11-17T01:00:00Z", hits: [hit, hit], reviewer: null });
  assert.equal(review.hits.length, 1);
  assert.equal(withDispatchRecord(review, { card: "后端-迁移-y", at: "2026-11-17T01:05:00Z", hits: [hit], reviewer: null }).hits.length, 1);
  assert.equal(reviewViewOf({ ...review, waived: { at: "2026-11-17T02:00:00Z" } }).state, "waived");
});

test("a role can say for itself whether it writes code", async () => {
  const { writesCode } = await import("./sensitive.ts");
  assert.equal(writesCode("backend"), true);
  assert.equal(writesCode("deploy"), false);
  assert.equal(writesCode("ops", false), false, "a custom role declared as not writing");
  assert.equal(writesCode("deploy", true), true, "a declaration beats the built-in list");
});
