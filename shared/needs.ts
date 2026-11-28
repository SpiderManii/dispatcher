// What a requirement needs from the user right now, most urgent first. Shared by the page (order, chips, buttons) and
// the server's light count for the sidebar badge, so both say the same thing.

export type NeedKind =
  | "conflict"
  | "error"
  | "permission"
  | "gone"
  | "decision"
  | "reply"
  | "blocked"
  | "stalled"
  | "handoff"
  | "review"
  | "merge"
  | "deploy"
  | "push"
  | "archive";

export type NeedTone = "danger" | "warning" | "accent" | "success";

export interface Need {
  kind: NeedKind;
  label: string;
  tone: NeedTone;
  /** For a lane holding several requirements: which one a 合回 / 部署 / 推送 is for. */
  req?: string;
}

/** The parts of a lane this looks at; LaneView has them all. */
export interface NeedsInput {
  agent: {
    status: string | null;
    pendingPermissions: number;
    requiresAttention: boolean;
    attentionReason: string | null;
    lastActivityAt?: string | null;
  } | null;
  ledger: {
    decisions: readonly { text: string }[];
    /** The lane's requirements; absent from older callers, which then count as one requirement following 阶段. */
    requirements?: readonly { done: boolean; id?: string; word?: string | null; synthetic?: boolean }[];
  };
  stage: { step: string; waiting: boolean } | null;
  pendingHandoff: { written: boolean } | null;
  /** Workers running for the lane; null or absent when Paseo could not say, which never counts as quiet. */
  runningWorkers?: number | null;
  /** Worker notices queued for the dispatcher, not yet delivered. */
  pendingNotices?: number;
  /** §9's sensitive changes found on the lane's cards and where their review stands; null when none were found. */
  review?: { state: string; kinds: readonly string[]; covered?: readonly string[] } | null;
}

/** Quiet this long, with nothing running and nothing waiting on anyone, and the lane has stopped. */
export const STALL_MS = 60 * 60_000;

const IDLE = new Set(["idle", "closed"]);
/** From 合回 on, a sensitive change still unreviewed is the user's to settle: send the review, or say none is needed. */
const REVIEW_DUE = new Set(["合回", "部署", "推送", "完成"]);

const since = (iso: string, now: number) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes} 分钟` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} 小时` : `${Math.floor(minutes / 1440)} 天`;
};

const CONFLICT = "【冲突】";

/** A 需求清单 line's word that puts a button on the page, and the button. */
const ROW_GATE: Record<string, "merge" | "deploy" | "push"> = { 待合回: "merge", 待部署: "deploy", 待推送: "push" };
const GATE_LABEL = { merge: "等你同意合回", deploy: "等你部署", push: "等你推送" } as const;

/**
 * Paseo's 「等你查看」 alone does not count: a dispatcher ends a turn after each dispatch, so it would mark every lane.
 * It counts only when nothing runs and nothing is on its way to the dispatcher, which is when its last turn was for
 * the user: a report or a question in the chat.
 */
export function laneNeeds(lane: NeedsInput, now: number = Date.now()): Need[] {
  const needs: Need[] = [];
  const conflicts = lane.ledger.decisions.filter((item) => item.text.includes(CONFLICT)).length;
  const decisions = lane.ledger.decisions.length - conflicts;
  const agent = lane.agent;
  if (conflicts > 0) needs.push({ kind: "conflict", label: `改动冲突 ${conflicts}`, tone: "danger" });
  if (agent && (agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error")))
    needs.push({ kind: "error", label: "出错了", tone: "danger" });
  if (agent && agent.pendingPermissions > 0) needs.push({ kind: "permission", label: `待授权 ${agent.pendingPermissions}`, tone: "warning" });
  if (!agent) needs.push({ kind: "gone", label: "会话不见了", tone: "warning" });
  if (decisions > 0) needs.push({ kind: "decision", label: `待拍板 ${decisions}`, tone: "warning" });
  if (lane.pendingHandoff?.written) needs.push({ kind: "handoff", label: "交接就绪", tone: "accent" });
  const stage = lane.stage;
  // 已完成 on the head line while the 需求清单 still has open items: the lane is not done, the next one is under way.
  const openRequirements = (lane.ledger.requirements ?? []).filter((item) => !item.done).length;
  const finished = stage?.step === "完成" && openRequirements === 0;
  const review = lane.review ?? null;
  // Several requirements on the 需求清单: 合回 / 部署 / 推送 are per line, each its own button.
  const listed = (lane.ledger.requirements ?? []).filter((item) => !item.synthetic && item.id);
  if (listed.length >= 2) {
    const holds = (id: string) => !!review && (review.state === "needed" || review.state === "running") && !(review.covered ?? []).includes(id);
    const due = listed.filter((item) => !!item.word && ROW_GATE[item.word] !== undefined);
    if (review?.state === "needed" && due.some((item) => holds(item.id!)))
      needs.push({ kind: "review", label: `缺审查：${review.kinds.join("、")}`, tone: "warning" });
    for (const item of due) {
      const kind = ROW_GATE[item.word!];
      if (kind === "merge" && holds(item.id!)) continue;
      needs.push({ kind, label: `${item.id} ${GATE_LABEL[kind]}`, tone: "accent", req: item.id });
    }
    if (openRequirements === 0) needs.push({ kind: "archive", label: "已完成，可归档", tone: "success" });
    else if (stage?.waiting && !["合回", "部署", "推送", "完成"].includes(stage.step))
      needs.push({ kind: "blocked", label: "卡住了，等你", tone: "warning" });
  }
  const reviewDue = listed.length < 2 && !!review && !!stage && REVIEW_DUE.has(stage.step);
  if (reviewDue && review.state === "needed") needs.push({ kind: "review", label: `缺审查：${review.kinds.join("、")}`, tone: "warning" });
  // Merging waits for the review: the plugin refuses 同意合回 while one is missing or still running.
  const mergeBlocked = reviewDue && (review.state === "needed" || review.state === "running");
  if (listed.length < 2 && stage?.waiting) {
    if (stage.step === "合回") {
      if (!mergeBlocked) needs.push({ kind: "merge", label: "等你同意合回", tone: "accent" });
    } else if (stage.step === "部署") needs.push({ kind: "deploy", label: "等你部署", tone: "accent" });
    else if (stage.step === "推送") needs.push({ kind: "push", label: "等你推送", tone: "accent" });
    else if (finished) needs.push({ kind: "archive", label: "已完成，可归档", tone: "success" });
    else if (stage.step !== "完成") needs.push({ kind: "blocked", label: "卡住了，等你", tone: "warning" });
  }
  // A quiet lane: its dispatcher idle, no worker running, no notice on its way to it, nothing else asked of the user.
  const quiet =
    needs.length === 0 &&
    !!agent?.status &&
    IDLE.has(agent.status) &&
    lane.runningWorkers === 0 &&
    (lane.pendingNotices ?? 0) === 0 &&
    !finished;
  if (quiet && agent.requiresAttention && agent.attentionReason === "finished") {
    // It ended its turn talking to the user (a report, a question in chat) and the user has not opened it since.
    needs.push({ kind: "reply", label: "调度员在等你回话", tone: "accent" });
  } else if (quiet && !agent.requiresAttention && agent.lastActivityAt && now - Date.parse(agent.lastActivityAt) > STALL_MS) {
    needs.push({ kind: "stalled", label: `停了 ${since(agent.lastActivityAt, now)}`, tone: "warning" });
  }
  return needs;
}

/**
 * Whether the lane belongs in the 「等你处理」 count. A finished requirement waiting to be archived still shows its
 * chip and button on the page, but nothing is blocked on the user, so it does not keep the badge lit.
 */
export function needsUser(needs: readonly Need[]): boolean {
  return needs.some((need) => need.kind !== "archive");
}

const RANK: Record<NeedKind, number> = {
  conflict: 0,
  error: 1,
  permission: 2,
  gone: 3,
  decision: 4,
  reply: 5,
  blocked: 6,
  stalled: 7,
  handoff: 8,
  review: 9,
  merge: 10,
  deploy: 11,
  push: 12,
  archive: 13,
};

/** Sort key: lanes that need the user come first, the most urgent need deciding; the rest keep their order. */
export function needRank(needs: readonly Need[]): number {
  return needs.length === 0 ? 100 : Math.min(...needs.map((need) => RANK[need.kind]));
}
