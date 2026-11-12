// When the user leaves a 待用户拍板 item unanswered: after 10 minutes, the recommendation stands; with none, the
// dispatcher asks the architect. Pure logic; the service reads the ledgers and sends the replies.

import type { OpenDecision } from "./core";

export const DECISION_TIMEOUT_MS = 10 * 60_000;
export const DECISION_CHECK_MS = 60_000;

/**
 * Rule 1.3 makes these the user's call however long it takes: push, merging into dev, deleting remote branches,
 * changing AGENTS.md / CLAUDE.md, deploying, secrets and servers. They wait.
 */
const USER_ONLY = /push|推送|推到远[程端]|合入\s*dev|合\s*dev|合到\s*dev|部署|上线|删.{0,6}远[程端]|远[程端]分支.{0,6}删|AGENTS\.md|CLAUDE\.md|密钥|服务器|生产/i;

/**
 * Blocked on something only the user can do on their side: starting Docker, signing in, a password or a code, a manual
 * step on their machine. Answering for them just retries into the same wall. The dispatcher can say so with 「（等用户）」.
 */
const NEEDS_USER = /（等用户）|\(等用户\)|等你|你确认|你先|需要你|你手动|你本机|docker|colima|本机.{0,6}(启动|开|装|登录)|登录|验证码|二次验证|VPN|密码|账号/i;

export function userOnly(text: string): boolean {
  return USER_ONLY.test(text) || NEEDS_USER.test(text);
}

/** Per open item: when the plugin first saw it, and when it asked the architect. Keyed by lane and ledger line. */
export type DecisionClock = Record<string, { seenAt: number; architectAskedAt?: number }>;

const keyOf = (laneId: string, line: string) => `${laneId}\u0000${line}`;

export interface DueDecisions {
  /** Answer now with the recommendation. */
  recommend: OpenDecision[];
  /** No recommendation: ask the architect, once. */
  architect: OpenDecision[];
}

/**
 * Updates `clock` for one lane's open items and says which are due. An edited line is a new item: the dispatcher
 * changed the question, so the user gets a fresh 10 minutes. Call `pruneClock` after every lane is seen.
 */
export function dueDecisions(clock: DecisionClock, laneId: string, decisions: readonly OpenDecision[], now: number): DueDecisions {
  const due: DueDecisions = { recommend: [], architect: [] };
  for (const decision of decisions) {
    const key = keyOf(laneId, decision.line);
    const entry = (clock[key] ??= { seenAt: now });
    if (userOnly(decision.text) || now - entry.seenAt < DECISION_TIMEOUT_MS) continue;
    if (decision.hasRecommendation) due.recommend.push(decision);
    else if (entry.architectAskedAt === undefined) {
      entry.architectAskedAt = now;
      due.architect.push(decision);
    }
  }
  return due;
}

/** Drops items no longer open anywhere, so the clock doesn't grow forever. */
export function pruneClock(clock: DecisionClock, open: ReadonlyMap<string, readonly OpenDecision[]>): void {
  const live = new Set([...open].flatMap(([laneId, items]) => items.map((item) => keyOf(laneId, item.line))));
  for (const key of Object.keys(clock)) if (!live.has(key)) delete clock[key];
}

const itemText = (decision: OpenDecision) => `- ${decision.text}`;

export function recommendReply(decisions: readonly OpenDecision[]): string {
  return [
    "以下待拍板 10 分钟没有答复，按规则已按推荐答复（台账已打勾，记为自动）：",
    ...decisions.map(itemText),
    "用户答复：按推荐",
    "照推荐执行并写进决策记录，注明「10 分钟未答，按推荐」。用户之后改主意，以用户为准。",
  ].join("\n");
}

export function architectReply(decisions: readonly OpenDecision[]): string {
  return [
    "以下待拍板 10 分钟没有答复，也没有推荐：",
    ...decisions.map(itemText),
    "按规则问架构师：用 dispatch_work 派架构角色（architect），任务卡写清问题、可选方案和约束，要它给出推荐和理由，写完状态文件就停。",
    "拿到推荐后把台账这条改成 `- [x] 问题 → 按架构师意见：…（10 分钟未答）`，照它执行并写进决策记录。用户之后改主意，以用户为准。",
  ].join("\n");
}
