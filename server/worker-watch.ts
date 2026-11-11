/**
 * Watches workers without involving a model: each scan compares Paseo's running list with what was
 * running before, and only a real change wakes the dispatcher. The state is plain JSON so a pending
 * notice survives a plugin reload.
 */

export interface TurnOutcome {
  kind: "completed" | "failed" | "canceled";
  message?: string;
  at: string;
}

export interface WatchedWorker {
  provider: string;
  parentAgentId: string;
  title: string | null;
  lastActivityAt: string | null;
  stuckNotified: boolean;
  /** How the last turn ended, when the turn hook reported it. Status alone can't tell a cancel from a finish. */
  outcome: TurnOutcome | null;
  statusFailures: number;
  /** Known when the worker came through dispatch_work; its content rides along in the notice. */
  statusFile?: string | null;
}

export type NoticeKind = "ended" | "failed" | "stuck" | "gone";

export interface PendingNotice {
  workerId: string;
  title: string | null;
  provider: string;
  parentAgentId: string;
  kind: NoticeKind;
  detail: string | null;
  attempts: number;
  statusFile?: string | null;
  /** The last notice this worker will get for now, because it keeps finishing. */
  finalRepeat?: boolean;
}

export interface WatchState {
  workers: Record<string, WatchedWorker>;
  notices: PendingNotice[];
  /** When each worker last finished a turn, to catch one that keeps waking up. */
  endings?: Record<string, number[]>;
}

export interface RunningWorker {
  id: string;
  provider: string;
  parentAgentId: string;
  title: string | null;
  lastActivityAt: string | null;
  turnStartedAt: string | null;
}

export interface NoticeTarget {
  key: string;
  /** The lane's current dispatcher, which is the successor if the parent has since handed off. */
  agentId: string;
  laneId: string;
  handoffPending: boolean;
}

export interface WatchIo {
  runningWorkers(): Promise<RunningWorker[]>;
  /** null when the worker no longer exists. Throws when that can't be determined right now. */
  workerStatus(id: string): Promise<{ status: string; lastError: string | null } | null>;
  /** The lane this parent works for; null when the parent is not a dispatcher, so the session is left alone. */
  findTarget(parentAgentId: string): Promise<NoticeTarget | null>;
  dispatcherStatus(agentId: string): Promise<string | null>;
  send(agentId: string, text: string): Promise<void>;
  /** null when the file isn't there or can't be read. */
  readStatusFile(file: string): Promise<string | null>;
  log(line: string): void;
  now(): number;
}

export const SCAN_MS = 15_000;
export const STUCK_MS = 60 * 60_000;
export const MAX_SEND_ATTEMPTS = 5;
export const MAX_STATUS_FAILURES = 4;
/** §5 caps a status file at about 40 lines, so anything longer is left for the dispatcher to open. */
export const MAX_INLINE_STATUS = 3_000;
/**
 * A worker that keeps finishing wakes the dispatcher each time, and if the dispatcher answers, the two pay for a loop.
 * Rework finishing a few times in half an hour is normal; more than that gets one warning, then silence.
 */
export const MAX_ENDED_NOTICES = 3;
export const REPEAT_WINDOW_MS = 30 * 60_000;

const BUSY = new Set(["initializing", "running"]);
/** "error" often means the model was briefly unavailable (503, no capacity). The message wakes it; dropping loses the news. */
const SENDABLE = new Set(["idle", "closed", "error"]);

export function emptyWatch(): WatchState {
  return { workers: {}, notices: [] };
}

function name(notice: { workerId: string; title: string | null; provider: string }): string {
  return `${notice.title ? `「${notice.title}」` : ""}${notice.workerId}（${notice.provider}）`;
}

function describe(notice: PendingNotice): string {
  switch (notice.kind) {
    case "ended":
      return "本轮已结束";
    case "failed":
      return `失败：${(notice.detail ?? "原因未知").slice(0, 300)}`;
    case "stuck":
      return "疑似卡死，约 60 分钟没有活动";
    case "gone":
      return "会话已不存在";
  }
}

function noticeLine(notice: PendingNotice, statuses: ReadonlyMap<string, string>): string {
  const warning = notice.finalRepeat
    ? `。30 分钟内已结束 ${MAX_ENDED_NOTICES} 次，之后不再通知。不要再给它发消息；已验收的不用再管，反复醒来不是你发的就报告用户`
    : "";
  const line = `- ${name(notice)}：${describe(notice)}${warning}`;
  const content = notice.statusFile ? statuses.get(notice.statusFile) : undefined;
  return content ? `${line}\n  状态文件 ${notice.statusFile}（内容已附，不用再读）：\n${content.trim()}` : line;
}

export function noticeText(notices: PendingNotice[], statuses: ReadonlyMap<string, string> = new Map()): string {
  return [
    "【执行会话状态通知】",
    ...notices.map((notice) => noticeLine(notice, statuses)),
    "先确认它们在本线台账里，不在就回报用户，不要接管。",
    "已结束：看状态文件，按第 8 节核验后派下一步。失败、不存在或状态文件缺字段：按第 10 节处理或报阻塞。疑似卡死：按第 6 节看末尾几行再判断。不自己排查。",
  ].join("\n");
}

async function readStatuses(notices: PendingNotice[], io: WatchIo): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  for (const { statusFile } of notices) {
    if (!statusFile || statuses.has(statusFile)) continue;
    try {
      const content = await io.readStatusFile(statusFile);
      if (content && content.length <= MAX_INLINE_STATUS) statuses.set(statusFile, content);
    } catch {
      // The dispatcher can still open the file itself; a notice must not fail because of this.
    }
  }
  return statuses;
}

/** Remembers where a worker from dispatch_work reports, so the notice can carry the report. */
export function recordDispatched(
  state: WatchState,
  worker: { id: string; provider: string; parentAgentId: string; title: string; statusFile: string },
  io: WatchIo,
): void {
  const known = state.workers[worker.id];
  if (known) known.statusFile = worker.statusFile;
  else {
    state.workers[worker.id] = {
      provider: worker.provider,
      parentAgentId: worker.parentAgentId,
      title: worker.title,
      lastActivityAt: null,
      stuckNotified: false,
      outcome: null,
      statusFailures: 0,
      statusFile: worker.statusFile,
    };
    io.log(`跟踪 ${worker.id}（${worker.provider}），来自 dispatch_work`);
  }
}

/** The turn hook sees a worker the instant it stops, including one too short-lived for any scan to catch. */
export async function recordTurnEnd(
  state: WatchState,
  event: { workerId: string; parentAgentId: string | null; provider: string; outcome: Omit<TurnOutcome, "at"> },
  io: WatchIo,
): Promise<void> {
  if (!event.parentAgentId || !(await io.findTarget(event.parentAgentId))) return;
  const outcome = { ...event.outcome, at: new Date(io.now()).toISOString() };
  const known = state.workers[event.workerId];
  if (known) known.outcome = outcome;
  else {
    state.workers[event.workerId] = {
      provider: event.provider,
      parentAgentId: event.parentAgentId,
      title: null,
      lastActivityAt: null,
      stuckNotified: false,
      outcome,
      statusFailures: 0,
    };
    io.log(`跟踪 ${event.workerId}（${event.provider}），来自轮次结束钩子`);
  }
  io.log(`钩子 ${event.provider} ${event.outcome.kind} worker=${event.workerId}`);
}

function queue(state: WatchState, id: string, worker: WatchedWorker, kind: NoticeKind, detail: string | null, io: WatchIo) {
  let finalRepeat = false;
  if (kind === "ended") {
    const endings: Record<string, number[]> = {};
    for (const [other, times] of Object.entries(state.endings ?? {})) {
      const live = times.filter((at) => io.now() - at < REPEAT_WINDOW_MS);
      if (live.length > 0) endings[other] = live;
    }
    const recent = [...(endings[id] ?? []), io.now()];
    endings[id] = recent;
    state.endings = endings;
    if (recent.length > MAX_ENDED_NOTICES) return io.log(`不通知：${id} 30 分钟内已结束 ${recent.length} 次`);
    finalRepeat = recent.length === MAX_ENDED_NOTICES;
  }
  state.notices.push({
    workerId: id,
    title: worker.title,
    provider: worker.provider,
    parentAgentId: worker.parentAgentId,
    kind,
    detail,
    attempts: 0,
    statusFile: worker.statusFile ?? null,
    ...(finalRepeat ? { finalRepeat } : {}),
  });
  io.log(`待通知 ${kind} ${worker.provider} worker=${id}`);
}

function updateRunning(state: WatchState, running: RunningWorker, io: WatchIo): void {
  const known = state.workers[running.id];
  if (!known) {
    state.workers[running.id] = {
      provider: running.provider,
      parentAgentId: running.parentAgentId,
      title: running.title,
      lastActivityAt: running.lastActivityAt,
      stuckNotified: false,
      outcome: null,
      statusFailures: 0,
    };
    io.log(`跟踪 ${running.id}（${running.provider}）`);
    return;
  }
  known.title = running.title ?? known.title;
  known.statusFailures = 0;
  // A turn started after the recorded outcome means the worker was sent back to work, so that outcome is stale.
  if (known.outcome && running.turnStartedAt && Date.parse(running.turnStartedAt) > Date.parse(known.outcome.at))
    known.outcome = null;
  if (running.lastActivityAt !== known.lastActivityAt) {
    known.lastActivityAt = running.lastActivityAt;
    known.stuckNotified = false;
  }
  const since = Date.parse(known.lastActivityAt ?? "");
  if (!known.stuckNotified && Number.isFinite(since) && io.now() - since >= STUCK_MS) {
    known.stuckNotified = true;
    queue(state, running.id, known, "stuck", null, io);
  }
}

async function settleStopped(state: WatchState, id: string, worker: WatchedWorker, io: WatchIo): Promise<void> {
  let result: Awaited<ReturnType<WatchIo["workerStatus"]>>;
  try {
    result = await io.workerStatus(id);
  } catch (error) {
    worker.statusFailures += 1;
    if (worker.statusFailures < MAX_STATUS_FAILURES) return;
    io.log(`连续查不到 ${id} 的状态，按不存在处理：${(error as Error).message}`);
    result = null;
  }
  if (result && BUSY.has(result.status)) return;
  delete state.workers[id];
  if (worker.outcome?.kind === "canceled") return io.log(`不通知：${id} 被取消`);
  if (!result) return queue(state, id, worker, "gone", null, io);
  if (result.status === "archived") return io.log(`不通知：${id} 已归档`);
  if (worker.outcome?.kind === "failed") return queue(state, id, worker, "failed", worker.outcome.message ?? null, io);
  if (worker.outcome?.kind === "completed") return queue(state, id, worker, "ended", null, io);
  if (result.status === "error" || result.lastError) return queue(state, id, worker, "failed", result.lastError, io);
  queue(state, id, worker, "ended", null, io);
}

async function deliverNotices(state: WatchState, io: WatchIo): Promise<void> {
  const byLane = new Map<string, { target: NoticeTarget; notices: PendingNotice[] }>();
  for (const notice of [...state.notices]) {
    const target = await io.findTarget(notice.parentAgentId);
    const drop = (reason: string) => {
      state.notices.splice(state.notices.indexOf(notice), 1);
      io.log(`未发送 ${notice.workerId}：${reason}`);
    };
    if (!target) drop("会话线已不在");
    // A dispatcher that has handed off must not be woken to carry on; its successor checks the ledger.
    else if (target.handoffPending) drop("会话线换班中");
    else {
      const group = byLane.get(target.key) ?? { target, notices: [] };
      group.notices.push(notice);
      byLane.set(target.key, group);
    }
  }
  for (const { target, notices } of byLane.values()) {
    const status = await io.dispatcherStatus(target.agentId);
    if (status && BUSY.has(status)) continue;
    const ids = notices.map((notice) => notice.workerId).join(",");
    const remove = () => {
      state.notices = state.notices.filter((notice) => !notices.includes(notice));
    };
    if (!status || !SENDABLE.has(status)) {
      remove();
      io.log(`未发送 ${ids}：调度员状态 ${status ?? "不存在"}`);
      continue;
    }
    try {
      await io.send(target.agentId, noticeText(notices, await readStatuses(notices, io)));
      remove();
      io.log(`已通知 ${target.agentId} lane=${target.laneId}：${ids}`);
    } catch (error) {
      for (const notice of notices) notice.attempts += 1;
      if (notices[0].attempts >= MAX_SEND_ATTEMPTS) {
        remove();
        io.log(`放弃通知 ${ids}，交给心跳：${(error as Error).message}`);
      } else io.log(`发送失败，下次重试 ${ids}：${(error as Error).message}`);
    }
  }
}

/** One pass. If the running list can't be read this throws before changing anything, so no worker is reported as ended by mistake. */
export async function scanWorkers(state: WatchState, io: WatchIo): Promise<void> {
  const running = await io.runningWorkers();
  const seen = new Set<string>();
  for (const worker of running) {
    if (!(await io.findTarget(worker.parentAgentId))) continue;
    seen.add(worker.id);
    updateRunning(state, worker, io);
  }
  for (const [id, worker] of Object.entries(state.workers)) {
    if (!seen.has(id)) await settleStopped(state, id, worker, io);
  }
  await deliverNotices(state, io);
}
