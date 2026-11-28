// The changes §9 of the rules calls 敏感 (鉴权、迁移、密钥、对外接口格式), read off the task cards the dispatcher sends
// out, and whether the one review §9 asks of them has happened. The dispatcher judges the 档位 itself and never writes
// it down; this is the plugin's own check, so a sensitive change cannot reach 待合回 unreviewed unless the user says so.

import { SENSITIVE_KINDS, type ReviewState, type SensitiveKind } from "../shared/review";

export { SENSITIVE_KINDS, type ReviewState, type SensitiveKind };

export interface SensitiveHit {
  kind: SensitiveKind;
  /** What matched, for the user and the dispatcher: a path, or the clause that said it. */
  text: string;
}

/** The parts of a task card a change is described in. Commands count: `git add` lists what gets committed. */
export interface CardText {
  title: string;
  task: string;
  scope: string;
  files: string;
  notes?: string;
  commitCommand?: string;
  /** What the dispatcher marked sensitive itself, for what the card's wording does not show. */
  sensitive?: readonly SensitiveKind[];
}

/** Roles that write no code of their own: reading, planning, testing and deploying are not what §9 reviews. */
const NOT_WRITING = new Set(["split", "review", "architect", "test", "deploy"]);
export const writesCode = (roleId: string, declared?: boolean) => declared ?? !NOT_WRITING.has(roleId);

// Words, matched in the card's own sentences.
const WORDS: { kind: SensitiveKind; re: RegExp; unless?: RegExp; unlessBefore?: RegExp }[] = [
  { kind: "迁移", re: /加列|新增列|新列|建表|新表|改表|表结构|ADD\s+COLUMN|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+(?:COLUMN|TABLE)/gi },
  // Auth tests run or kept as they are: 「鉴权专项」, 「保留鉴权语义」.
  { kind: "鉴权", re: /鉴权|登录校验|权限校验|权限控制|越权|\b(?:OAuth2?|SSO|JWT|SCIM|RBAC)\b/gi, unless: /^(?:专项|测试|用例|单测|回归|相关测试)/ },
  // A login session used to look at a page is not a change to auth: 「浏览器已有管理员登录态」, 「需要登录态才能看」.
  {
    kind: "鉴权",
    re: /登录态/g,
    unless: /^\s*(?:才能|才可|下|访问|查看|打开|截图|看页面|验证页面|进页面)/,
    unlessBefore: /(?:已有|现有|当前|已登录的?|浏览器(?:里|的|中)?|复用|带着?|保持|沿用|用|借用|需要|有)[^，。；、]{0,8}$/,
  },
  { kind: "接口格式", re: /接口格式|返回格式|响应格式|请求格式|返回结构|响应结构|请求结构|返回形态|响应形态|字段改名|改字段名|重命名字段|对外接口|接口契约|\bbreaking change\b/gi },
];

/**
 * 迁移 is said as often of running migrations as of writing one: 「关闭自动迁移」, 「在隔离库应用待迁移」, 「验证迁移」.
 * It counts when a new or changed migration is meant: 「新增迁移」, 「改 schema 与迁移」, 「迁移链新增…」, 「迁移文件」.
 */
const MIGRATION = /迁移/g;
const MIGRATION_WRITE_NEAR = /新增|新建|新|增加|添加|编写|写|生成|修改|改|补/;
const MIGRATION_WRITE_AFTER = /^\s*(?:文件|脚本|SQL|sql|目录|链)/;
const MIGRATION_RUN_BEFORE = /(?:应用|执行|跑|运行|关闭|打开|开启|禁用|验证|核对|检查|校验|只读|待|已|自动|pending|失败)[^，。；]{0,3}$/i;
const MIGRATION_REACH = 10;

/**
 * Keys and credentials are named all the time without being changed: 「用管理凭据登录」 to take a screenshot,
 * 「不打印密钥」, the key management pages' wording. They count only next to a change to how they are kept or entered.
 */
const SECRET = /密钥|凭据|凭证|私钥|密码|AK\s*\/\s*SK|\b[A-Z0-9_]*(?:ACCESS_KEY|SECRET_KEY)[A-Z0-9_]*\b|\bapi[\s_-]?key\b|\bcredentials?\b/gi;
const SECRET_CHANGE = /新增|新建|增加|添加|修改|改成|改为|改造|填写|保存|存储|存入|写入|录入|输入|表单|加密|掩码|脱敏|轮换|生成|校验|删除|字段/;
const SECRET_REACH = 12;
/** The keys page and its wording: 「此密钥已禁用」, 「密钥详情页」, 「不指向『密钥』的措辞」. */
const SECRET_AS_UI_BEFORE = /[此该]\s*$/;
/** Using a key that exists, or making one at run time: 「改为用本机已有的支付凭证」, 「新建一把专用密钥」. */
const SECRET_IN_USE_BEFORE = /(?:用|使用|拿|借用|沿用)[^，。；、]{0,8}$|[一这那]把[^，。；、]{0,3}$/;
const SECRET_AS_UI_AFTER = /^[」』"'”]?\s*(?:的)?[^，。；、\s]{0,4}?(?:页|列表|详情|文案|措辞|字样|提示语|样式|标题|副标题|标签|tab|禁用文案)/i;

// Paths, matched on a lowercased path whose camelCase is split (SSOSettings → sso_settings, ReAuth → re_auth).
const PATHS: { kind: SensitiveKind; re: RegExp }[] = [
  { kind: "迁移", re: /(^|\/)migrations?\// },
  { kind: "迁移", re: /(^|\/)schema\.prisma$/ },
  { kind: "迁移", re: /(^|\/)(alembic|flyway|liquibase)(\/|$)/ },
  { kind: "迁移", re: /(^|\/)db\/migrate\// },
  // A .sql file elsewhere is often a read-only check (db_scripts/verify_stock_fields.sql): only migration-like names count.
  { kind: "迁移", re: /(^|\/)(migration|schema|ddl)[^/]*\.sql$/ },
  { kind: "迁移", re: /(^|\/)\d{8,14}_[^/]*\/[^/]+\.sql$/ },
  { kind: "密钥", re: /(^|[^a-z])(secrets?|credentials?|vault)(?![a-z])/ },
  { kind: "鉴权", re: /(^|[^a-z])(auth|sso|oauth2?|jwt|rbac|scim)(?![a-z])/ },
  { kind: "接口格式", re: /(openapi|swagger)/ },
  { kind: "接口格式", re: /\.proto$/ },
  { kind: "接口格式", re: /(^|\/)_types\.py$/ },
  { kind: "接口格式", re: /(^|\/)api\/schemas?\// },
];

/** Pictures and styles: a login page's background is not 鉴权. */
const ASSET = /\.(png|jpe?g|gif|svg|webp|ico|css|scss|less|woff2?|ttf)$/;

/**
 * Shortly before, these take back what follows: 「不改：迁移、鉴权」, 「只读参考 auth.py」. Not a bare 参考 or 不,
 * which sit in 「参考商品」 and 「不同规格」.
 */
const NEGATION =
  /不改|不动|不碰|不涉及|不含|不包括|不包含|不新增|不新建|不加|不做|不需要|不用|不要|不得|不写|不打印|不输出|不落盘|不记录|不在|无需|没有|未涉及|禁止|别动|别改|勿|只读|仅参考|只参考|参考(?:实现|写法|代码|文件|现有)|对照(?:实现|写法|现有)|保留|沿用|保持|无(?=\s*(?:迁移|schema|表|密钥|鉴权|接口))/g;
const NEGATION_REACH = 40;
/** 「不改：A、B、C……」 governs the whole list after the colon, however long. */
const NEGATED_LIST = /(?:不改|不动|不碰|不涉及|不包括|不包含|禁止)\s*[:：]/;
/** Right after, these say it stays as it is or is only read: 「接口格式不变」, 「从 .env 读取」. */
const NEGATED_AFTER = /^\s*(?:都|也|均)?\s*(?:不变|保持不变|不改|不动|不受影响|无变化|没变|不打印|不输出|不落盘|不记录|只读|读取|读出)/;

const PATH_TOKEN = /[A-Za-z0-9_.@~\/-]*[\/.][A-Za-z0-9_.@~\/-]+/g;

const normalizePath = (token: string) =>
  token
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[.,;:)）]+$/, "");

const short = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Sentences of a card field. Not split on 、, which only lists what one 「不改」 governs. */
const clauses = (text: string) => text.split(/[。；;\n，,]+/).map((item) => item.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, "")).filter((item) => item.trim());

function clauseHits(clause: string, paths: boolean): SensitiveHit[] {
  const negations = [...clause.matchAll(NEGATION)].map((match) => match.index ?? 0);
  const list = clause.search(NEGATED_LIST);
  const kept = (index: number, length: number) =>
    !(list >= 0 && list < index) &&
    !negations.some((at) => at < index && index - at <= NEGATION_REACH) &&
    !NEGATED_AFTER.test(clause.slice(index + length, index + length + 10));
  const hits: SensitiveHit[] = [];
  for (const { kind, re, unless, unlessBefore } of WORDS) {
    for (const match of clause.matchAll(re)) {
      const end = (match.index ?? 0) + match[0].length;
      if (unless?.test(clause.slice(end))) continue;
      if (unlessBefore?.test(clause.slice(0, match.index ?? 0))) continue;
      if (kept(match.index ?? 0, match[0].length)) {
        hits.push({ kind, text: short(clause) });
        break;
      }
    }
  }
  if (!hits.some((hit) => hit.kind === "迁移")) {
    for (const match of clause.matchAll(MIGRATION)) {
      const index = match.index ?? 0;
      const end = index + match[0].length;
      const before = clause.slice(0, index);
      if (MIGRATION_RUN_BEFORE.test(before) || !kept(index, match[0].length)) continue;
      const near = before.slice(-MIGRATION_REACH) + "\0" + clause.slice(end, end + MIGRATION_REACH);
      if (!MIGRATION_WRITE_NEAR.test(near) && !MIGRATION_WRITE_AFTER.test(clause.slice(end))) continue;
      hits.push({ kind: "迁移", text: short(clause) });
      break;
    }
  }
  for (const match of clause.matchAll(SECRET)) {
    const index = match.index ?? 0;
    const end = index + match[0].length;
    const near = clause.slice(Math.max(0, index - SECRET_REACH), index) + "\0" + clause.slice(end, end + SECRET_REACH);
    if (!SECRET_CHANGE.test(near) || !kept(index, match[0].length)) continue;
    const before = clause.slice(0, index);
    if (SECRET_AS_UI_BEFORE.test(before) || SECRET_IN_USE_BEFORE.test(before) || SECRET_AS_UI_AFTER.test(clause.slice(end))) continue;
    hits.push({ kind: "密钥", text: short(clause) });
    break;
  }
  if (!paths) return hits;
  for (const match of clause.matchAll(PATH_TOKEN)) {
    const token = match[0];
    const path = normalizePath(token);
    if (!path.includes("/") && !path.includes(".")) continue;
    if (ASSET.test(path) || !kept(match.index ?? 0, token.length)) continue;
    for (const { kind, re } of PATHS) if (re.test(path)) hits.push({ kind, text: short(token.replace(/[.,;:)）]+$/, "")) });
  }
  return hits;
}

/**
 * What on this card is sensitive, at most three findings per kind. Paths count only where a card names what it changes
 * (改与不改, 点名文件, the commit command): a task also names what to read, run or log in with.
 */
export function sensitiveHits(card: CardText): SensitiveHit[] {
  const fields: [string, boolean][] = [
    [card.title, false],
    [card.task, false],
    [card.scope, true],
    [card.files, true],
    [card.notes ?? "", false],
    [card.commitCommand ?? "", true],
  ];
  const seen = new Set<string>();
  const perKind = new Map<SensitiveKind, number>();
  const found: SensitiveHit[] = [...new Set(card.sensitive ?? [])].map((kind) => ({ kind, text: "调度员在任务卡上标的" }));
  for (const [field, paths] of fields) {
    for (const clause of clauses(field)) {
      for (const hit of clauseHits(clause, paths)) {
        const key = `${hit.kind}\0${hit.text}`;
        if (seen.has(key) || (perKind.get(hit.kind) ?? 0) >= 3) continue;
        seen.add(key);
        perKind.set(hit.kind, (perKind.get(hit.kind) ?? 0) + 1);
        found.push(hit);
      }
    }
  }
  return found.sort((a, b) => SENSITIVE_KINDS.indexOf(a.kind) - SENSITIVE_KINDS.indexOf(b.kind));
}

// ---------------------------------------------------------------------------
// What the lane keeps: the findings, the review cards sent for them, and the user's 「不用审查」.

export interface ReviewHit extends SensitiveHit {
  /** The card it was found on. */
  card: string;
  at: string;
}

export type ReviewerOutcome = "ended" | "failed" | "canceled" | "gone";

export interface Reviewer {
  agentId: string;
  at: string;
  /** null while it runs. */
  outcome: ReviewerOutcome | null;
  endedAt: string | null;
}

export interface LaneReview {
  hits: ReviewHit[];
  reviewers: Reviewer[];
  waived: { at: string } | null;
  /** Start of the current round: findings, review cards and 「不用审查」 from before it belong to an earlier requirement. */
  since?: string | null;
  /** Requirement IDs the last finished (or waived) round covered. Unknown means R1, the lane's only one back then. */
  covered?: string[] | null;
}

export interface ReviewView {
  state: ReviewState;
  kinds: SensitiveKind[];
  hits: { kind: SensitiveKind; text: string; card: string }[];
  /** Requirements an earlier, finished round already covered: the current round does not hold them back. */
  covered: string[];
}

const MAX_HITS = 12;

/** The first findings of each round are kept, as before rounds existed: earlier rounds' and the current round's apart. */
function capHits(hits: ReviewHit[], since: string): ReviewHit[] {
  return [...hits.filter((hit) => hit.at < since).slice(0, MAX_HITS), ...hits.filter((hit) => hit.at >= since).slice(0, MAX_HITS)];
}

/** Adds what one dispatch found, and the review card if it was one. Findings already kept are not added twice. */
export function withDispatchRecord(
  review: LaneReview | undefined,
  record: { card: string; at: string; hits: SensitiveHit[]; reviewer: string | null },
): LaneReview {
  const base: LaneReview = review ?? { hits: [], reviewers: [], waived: null };
  const known = new Set(base.hits.map((hit) => `${hit.kind}\0${hit.text}`));
  const fresh: ReviewHit[] = [];
  for (const hit of record.hits) {
    const key = `${hit.kind}\0${hit.text}`;
    if (known.has(key)) continue;
    known.add(key);
    fresh.push({ ...hit, card: record.card, at: record.at });
  }
  return {
    ...base,
    hits: capHits([...base.hits, ...fresh], base.since ?? ""),
    reviewers: record.reviewer ? [...base.reviewers, { agentId: record.reviewer, at: record.at, outcome: null, endedAt: null }] : base.reviewers,
  };
}

/**
 * §9 asks for one review per requirement. When a lane that finished (or waived) its review takes a sensitive card and
 * its 需求清单 now has a requirement the review did not cover, a new round starts: what came before stays on record
 * but no longer counts.
 */
export function needsNewRound(review: LaneReview | undefined | null, requirementIds: readonly string[]): boolean {
  const view = reviewViewOf(review);
  if (!review || !view || (view.state !== "done" && view.state !== "waived")) return false;
  const covered = new Set(review.covered ?? ["R1"]);
  return requirementIds.some((id) => !covered.has(id));
}

export function withNewRound(review: LaneReview, at: string): LaneReview {
  // What the finished round covered stays, so the requirements it reviewed can still be merged during the new one.
  return { ...review, since: at, covered: review.covered ?? ["R1"] };
}

/** Whether the review keeps this requirement (or, without one, the lane) from being merged back. */
export function reviewHolds(view: ReviewView | null, req?: string | null): boolean {
  if (!view || (view.state !== "needed" && view.state !== "running")) return false;
  return !(req && view.covered.includes(req));
}

/** A review card's worker finished, failed or went away; the first outcome sticks. Unchanged when it is not one. */
export function withReviewerOutcome(review: LaneReview | undefined, agentId: string, outcome: ReviewerOutcome, at: string): LaneReview | null {
  if (!review || !review.reviewers.some((item) => item.agentId === agentId && item.outcome === null)) return null;
  return {
    ...review,
    reviewers: review.reviewers.map((item) => (item.agentId === agentId && item.outcome === null ? { ...item, outcome, endedAt: at } : item)),
  };
}

/**
 * Where the review stands. Only a review sent after the first sensitive card counts: a review of the plan made before
 * any code is a different job. §9 asks for one review per requirement, so later sensitive cards (rework included) do
 * not ask for another.
 */
export function reviewViewOf(review: LaneReview | undefined | null): ReviewView | null {
  if (!review) return null;
  const since = review.since ?? "";
  const current = review.hits.filter((hit) => hit.at >= since);
  if (current.length === 0) return null;
  const kinds = SENSITIVE_KINDS.filter((kind) => current.some((hit) => hit.kind === kind));
  const hits = current.map(({ kind, text, card }) => ({ kind, text, card }));
  const first = current.reduce((min, hit) => (hit.at < min ? hit.at : min), current[0].at);
  const after = review.reviewers.filter((item) => item.at >= first);
  const state: ReviewState = after.some((item) => item.outcome === "ended")
    ? "done"
    : review.waived && review.waived.at >= since
      ? "waived"
      : after.some((item) => item.outcome === null)
        ? "running"
        : "needed";
  const covered = review.covered ?? (state === "done" || state === "waived" ? ["R1"] : []);
  return { state, kinds, hits, covered };
}
