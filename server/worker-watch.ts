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

/** "reply" is not about a worker: it carries the user's answer from the page, sharing the queue's idle wait and delivery check. */
export type NoticeKind = "ended" | "interrupted" | "failed" | "stuck" | "gone" | "reply";

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
  /** The turn was opened by the user typing to the worker, not by the dispatcher: not a delivery to check. */
  byUser?: boolean;
  /** Set on the last send attempt, so a retry can first check whether that attempt got through after all. */
  messageId?: string;
  /** When a reply was queued; it waits REPLY_BATCH_MS so answers given one after another go out together. */
  queuedAt?: number;
}

export interface WatchState {
  workers: Record<string, WatchedWorker>;
  notices: PendingNotice[];
  /** When each worker last finished a turn, to catch one that keeps waking up. */
  endings?: Record<string, number[]>;
  /**
   * What is known about a worker beyond its current turn. `workers` forgets a worker once its turn is reported, so
   * without this a rework round or a question from the user came back as a stranger: no title, no status file.
   */
  known?: Record<string, KnownWorker>;
}

export interface KnownWorker {
  title: string | null;
  statusFile: string | null;
  /** Turns already reported. */
  settled: number;
  at: number;
}

/** A week is far longer than any task card; older entries only grow the file. */
export const KNOWN_TTL_MS = 7 * 24 * 60 * 60_000;

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
  /**
   * Resolves once the dispatcher has started a turn on the message; throws when it didn't, so the notice stays
   * queued. `messageId` is recorded on the message in the dispatcher's timeline.
   */
  send(agentId: string, text: string, messageId: string): Promise<void>;
  /**
   * The worker's last reply, for telling a real finish from a turn the provider cut off: Cursor reports a dropped
   * connection as a completed turn whose reply is "Error: RetriableError: …". null when it can't be read.
   */
  lastReply?(workerId: string): Promise<string | null>;
  /** Whether the dispatcher already worked on this message: its timeline has replies in the turn the message opened. */
  answered?(agentId: string, messageId: string): Promise<boolean>;
  newMessageId(): string;
  /**
   * Whether the dispatcher already dealt with an answer: the items it ticked are no longer in the lane ledger
   * (moved to the decision record). Such an answer is dropped instead of arriving late and twice.
   */
  replyHandled?(laneAgentId: string, detail: string): Promise<boolean>;
  /** null when the file isn't there or can't be read. */
  readStatusFile(file: string): Promise<string | null>;
  /**
   * Who sent the message that opened the worker's last turn: "agent" when Paseo marks it as sent by another session
   * (the dispatcher, a launch), "user" when someone typed it. null when it can't be read.
   */
  turnOpener?(workerId: string): Promise<"agent" | "user" | null>;
  log(line: string): void;
  now(): number;
}

export const SCAN_MS = 15_000;
export const STUCK_MS = 60 * 60_000;
export const MAX_SEND_ATTEMPTS = 5;
export const REPLY_BATCH_MS = 20_000;
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
      return notice.byUser
        ? "本轮已结束。这一轮是用户直接发消息给它触发的，不是你派的活：看它答了什么，影响台账的再更新，不当成交付核验"
        : "本轮已结束";
    case "interrupted":
      return `被网络或服务中断，这一轮没做完（${(notice.detail ?? "").slice(0, 200)}）。直接给它发消息让它接着做，不用重派`;
    case "failed":
      return `失败：${(notice.detail ?? "原因未知").slice(0, 300)}`;
    case "stuck":
      return "疑似卡死，约 60 分钟没有活动";
    case "gone":
      return "会话已不存在";
    case "reply":
      return notice.detail ?? "";
  }
}

function noticeLine(notice: PendingNotice, statuses: ReadonlyMap<string, string>): string {
  const warning = notice.finalRepeat
    ? `。30 分钟内已结束 ${MAX_ENDED_NOTICES} 次，之后不再通知。不要再给它发消息；已验收的不用再管，反复醒来不是你发的就报告用户`
    : "";
  // Only dispatch_work records a status file, so this worker was dispatched on this lane by the plugin itself.
  const origin = notice.statusFile ? "（本线 dispatch_work 派出，插件已核对归属）" : "";
  const line = `- ${name(notice)}${origin}：${describe(notice)}${warning}`;
  const content = notice.statusFile ? statuses.get(notice.statusFile) : undefined;
  return content ? `${line}\n  状态文件 ${notice.statusFile}（内容已附，不用再读）：\n${content.trim()}` : line;
}

export function noticeText(notices: PendingNotice[], statuses: ReadonlyMap<string, string> = new Map()): string {
  const replies = notices.filter((notice) => notice.kind === "reply");
  const workers = notices.filter((notice) => notice.kind !== "reply");
  const replyPart = replies.length
    ? [
        "【用户在调度员页面拍板】",
        ...replies.map((notice) => notice.detail ?? ""),
        "插件已在本线台账把这些条目标成 [x] 并写上答复。按答复继续；拍完的按第 13 节整理进决策记录。",
      ]
    : [];
  if (workers.length === 0) return replyPart.join("\n");
  return [
    ...(replyPart.length ? [...replyPart, ""] : []),
    "【执行会话状态通知】",
    ...workers.map((notice) => noticeLine(notice, statuses)),
    "标了「本线 dispatch_work 派出」的属于本线，台账里没有就补上，照常核验。其余的先确认在本线台账里，不在就回报用户，不要接管。",
    "被中断：发消息让它接着做，不重派、不算返修次数。已结束：看状态文件，按第 8 节核验后派下一步。失败、不存在或状态文件缺字段：按第 10 节处理或报阻塞。疑似卡死：按第 6 节看末尾几行再判断。不自己排查。",
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

function remember(state: WatchState, id: string, patch: Partial<KnownWorker>, io: WatchIo): KnownWorker {
  const known = Object.fromEntries(
    Object.entries(state.known ?? {}).filter(([, entry]) => io.now() - entry.at < KNOWN_TTL_MS),
  );
  const prior: KnownWorker | undefined = known[id];
  // An unknown title or status file in a later turn must not erase what an earlier one learned.
  const learned = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null && value !== undefined));
  const entry: KnownWorker = { ...(prior ?? { title: null, statusFile: null, settled: 0 }), ...learned, at: io.now() };
  state.known = { ...known, [id]: entry };
  return entry;
}

/** Fills in what an earlier turn taught about a worker the watch is meeting again. */
function recall(state: WatchState, id: string, worker: WatchedWorker): void {
  const known = state.known?.[id];
  if (!known) return;
  worker.title ??= known.title;
  worker.statusFile ??= known.statusFile;
}

/** Remembers where a worker from dispatch_work reports, so the notice can carry the report. */
export function recordDispatched(
  state: WatchState,
  worker: { id: string; provider: string; parentAgentId: string; title: string; statusFile: string },
  io: WatchIo,
): void {
  remember(state, worker.id, { title: worker.title, statusFile: worker.statusFile }, io);
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

/** Queues the user's answer for a lane; it goes out with the next delivery, once the dispatcher is idle. */
export function queueReply(state: WatchState, reply: { laneAgentId: string; text: string }, io: WatchIo): void {
  state.notices.push({
    workerId: `reply-${io.newMessageId()}`,
    title: null,
    provider: "",
    parentAgentId: reply.laneAgentId,
    kind: "reply",
    detail: reply.text,
    attempts: 0,
    queuedAt: io.now(),
  });
  io.log(`待送答复 lane-agent=${reply.laneAgentId}`);
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
    recall(state, event.workerId, state.workers[event.workerId]);
    io.log(`跟踪 ${event.workerId}（${event.provider}），来自轮次结束钩子`);
  }
  io.log(`钩子 ${event.provider} ${event.outcome.kind} worker=${event.workerId}`);
}

function queue(
  state: WatchState,
  id: string,
  worker: WatchedWorker,
  kind: NoticeKind,
  detail: string | null,
  io: WatchIo,
  byUser = false,
) {
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
    ...(byUser ? { byUser } : {}),
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
    recall(state, running.id, state.workers[running.id]);
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

/**
 * A "completed" turn whose last reply is a provider error. Retriable ones (dropped connection, canceled stream,
 * TLS) only need a nudge to carry on; any other error is a failure.
 */
export function endedWithError(reply: string | null): { kind: "interrupted" | "failed"; detail: string } | null {
  const line = reply?.trim().split("\n")[0]?.trim() ?? "";
  if (!/^Error:/i.test(line)) return null;
  const detail = line.replace(/^Error:\s*/i, "");
  return { kind: /RetriableError/i.test(detail) ? "interrupted" : "failed", detail };
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
  const before = remember(state, id, { title: worker.title, statusFile: worker.statusFile ?? null }, io);
  remember(state, id, { settled: before.settled + 1 }, io);
  if (worker.outcome?.kind === "canceled") return io.log(`不通知：${id} 被取消`);
  if (!result) return queue(state, id, worker, "gone", null, io);
  if (result.status === "archived") return io.log(`不通知：${id} 已归档`);
  if (worker.outcome?.kind === "failed") return queue(state, id, worker, "failed", worker.outcome.message ?? null, io);
  if (worker.outcome?.kind === "completed") {
    const cutOff = endedWithError(io.lastReply ? await io.lastReply(id).catch(() => null) : null);
    if (cutOff) return queue(state, id, worker, cutOff.kind, cutOff.detail, io);
    // A first turn is always the launch. Later ones come from the dispatcher (rework) or from the user typing to it.
    const opener = before.settled > 0 && io.turnOpener ? await io.turnOpener(id).catch(() => null) : null;
    return queue(state, id, worker, "ended", null, io, opener === "user");
  }
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
    if (notice.kind === "reply" && io.replyHandled && (await io.replyHandled(notice.parentAgentId, notice.detail ?? "").catch(() => false))) {
      drop("调度员已在台账里处理过这条答复");
      continue;
    }
    if (!target) drop("会话线已不在");
    // A dispatcher that has handed off must not be woken to carry on; its successor checks the ledger.
    else if (target.handoffPending) drop("会话线换班中");
    else {
      const group = byLane.get(target.key) ?? { target, notices: [] };
      group.notices.push(notice);
      byLane.set(target.key, group);
    }
  }
  for (let { target, notices } of byLane.values()) {
    const status = await io.dispatcherStatus(target.agentId);
    if (status && BUSY.has(status)) continue;
    // An answer just given may be followed by more; wait so they reach the dispatcher as one message.
    if (notices.some((notice) => notice.kind === "reply" && io.now() - (notice.queuedAt ?? 0) < REPLY_BATCH_MS)) continue;
    const ids = () => notices.map((notice) => notice.workerId).join(",");
    const remove = () => {
      state.notices = state.notices.filter((notice) => !notices.includes(notice));
    };
    if (!status || !SENDABLE.has(status)) {
      remove();
      io.log(`未发送 ${ids()}：调度员状态 ${status ?? "不存在"}`);
      continue;
    }
    // A send reported as failed may still have been worked on (Paseo can report an error while the turn runs).
    // Those are done; resending would only make the dispatcher handle them twice.
    const delivered: PendingNotice[] = [];
    if (io.answered) {
      for (const messageId of new Set(notices.flatMap((notice) => (notice.messageId ? [notice.messageId] : [])))) {
        const yes = await io.answered(target.agentId, messageId).catch(() => false);
        if (yes) delivered.push(...notices.filter((notice) => notice.messageId === messageId));
      }
    }
    if (delivered.length > 0) {
      state.notices = state.notices.filter((notice) => !delivered.includes(notice));
      io.log(`已送到（重发前核对）${target.agentId}：${delivered.map((notice) => notice.workerId).join(",")}`);
    }
    const pending = notices.filter((notice) => !delivered.includes(notice));
    if (pending.length === 0) continue;
    notices = pending;
    const messageId = io.newMessageId();
    for (const notice of notices) notice.messageId = messageId;
    try {
      await io.send(target.agentId, noticeText(notices, await readStatuses(notices, io)), messageId);
      remove();
      io.log(`已通知 ${target.agentId} lane=${target.laneId}：${ids()}`);
    } catch (error) {
      for (const notice of notices) notice.attempts += 1;
      if (notices[0].attempts >= MAX_SEND_ATTEMPTS) {
        remove();
        io.log(`放弃通知 ${ids()}，交给心跳：${(error as Error).message}`);
      } else io.log(`发送失败，下次重试 ${ids()}：${(error as Error).message}`);
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
