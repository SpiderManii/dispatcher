import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  AgentInfo,
  CandidateInput,
  DispatcherView,
  LaneView,
  Overview,
  ProviderCatalog,
  TargetView,
  WorkspaceItem,
} from "../shared/contracts";
import { statusFileProblem } from "./container-paths";
import { parseQuotas, quotaState, type QuotaEntry } from "./quota";
import { ensureProjects } from "./project-bootstrap";
import { looksLikeAnswer } from "./answer-words";
import {
  MAX_LISTED_DECISIONS,
  SCAN_MS,
  emptyWatch,
  queueReply,
  recordDispatched,
  recordTurnEnd,
  scanWorkers,
  type NoticeTarget,
  type WatchIo,
  type WatchState,
} from "./worker-watch";
import {
  endedLaneKeys,
  LABEL_DISPATCHER,
  startedByLane,
  LABEL_ROLE,
  WORK_ROLE_LABEL,
  agentsFileStale,
  allLanes,
  endedLaneParents,
  laneTitle,
  withoutDispatcherPrefix,
  releaseArchivedLanes,
  assignmentPrompt,
  bootstrapPrompt,
  checkImages,
  imagesNote,
  type PromptImage,
  saveImages,
  canonical,
  defaultHome,
  dispatcherForCwd,
  expandHome,
  handoffInstruction,
  handoffPathFor,
  handoffWritten,
  holdersOf,
  isGitRoot,
  isInside,
  laneByAgent,
  laneOf,
  laneProject,
  layoutFor,
  ledgerInfo,
  limitsOf,
  listDirectory,
  loadRegistry,
  loadState,
  newLaneId,
  newQueueId,
  queueWait,
  type Queued,
  planRoute,
  readDocument,
  readRules,
  recordLaneAgent,
  releaseLane,
  renderLaneIndex,
  renderLedger,
  resolveTarget,
  rulesPath,
  saveState,
  sharedNotice,
  stateOf,
  successorPrompt,
  suggestLead,
  seedRules,
  syncFiles,
  writeAtomic,
  type DispatcherDef,
  type Lane,
  type LaneProject,
  type Registry,
  type DispatcherState,
  type State,
  adoptRegistered,
  markDecisions,
  summarizeLedger,
  updateRegistry,
  withRunningRow,
} from "./core";
import { migrateLayout } from "./layout-migrate";
import {
  autoConfig,
  checkCard,
  familyOf,
  pickCandidate,
  renderRoleGuide,
  renderWorkPrompt,
  cardFeedback,
  resolveCandidate,
  rolesOf,
  type Profile,
  type ResolvedConfig,
  type WorkCard,
} from "./roles";

import {
  branchLandsOn,
  checkoutFacts,
  type CheckoutFacts,
  currentBranch,
  directoryWorkspaceSource,
  headCommit,
  listBranches,
  pushCheckoutBranch,
  resolveBranchChoice,
  type ResolvedBranch,
  sameRepository,
  branchHead,
  branchPushState,
  hasLocalBranch,
  onBranch,
  pushBranch,
  linkedWorktrees,
} from "./workspace-project";
import { laneWorktrees, worktreeNote } from "./lane-worktrees";
import { activeCooldown, cooldownFor, cooldownReason, withCooldown, type Cooldown } from "./cooldown";
import { laneNeeds, needsUser } from "../shared/needs";
import { requirementTitle } from "../shared/lane-text";
import { decideApproval } from "./auto-approve";
import { CLEANUP_CHECK_MS, cleanupDue, parseCleanupRecord, type CleanupRecord } from "./auto-cleanup";
import { backupEnvFiles, envFilesOf, safeSegment } from "./env-backup";
import { assessWorkspace } from "./workspace-cleanup";
import { mapLimit } from "./map-limit";
import { appendLaneEvent, laneEventStats, recentLaneEvents, type LaneEventKind } from "./events";
import { archiveBlock, runningTableAgents, slimLedger } from "./ledger-slim";
import { readPluginBuild } from "./plugin-build";
import {
  requirementForCard,
  requirementStage,
  withRequirementWord,
  deriveStage,
  parseRequirements,
  parseStage,
  stageAfterDispatch,
  stepForRole,
  withAcceptance, withRecentDone, withStage, type StageWord } from "./lane-stage";
import {
  needsNewRound,
  reviewHolds,
  reviewViewOf,
  sensitiveHits,
  withDispatchRecord,
  withNewRound,
  withReviewerOutcome,
  writesCode,
  type ReviewerOutcome,
} from "./sensitive";
import { laneReports } from "./lane-reports";
import { CONFLICT_MARK, READ_ONLY_ROLES, laneClashes, overlapping, runningCwds, scopePaths, scopeText, withScopePaths } from "./scope-overlap";
import { fileURLToPath } from "node:url";
import {
  architectReply,
  DECISION_CHECK_MS,
  type DecisionClock,
  dueDecisions,
  pruneClock,
  recommendReply,
} from "./decision-timeout";
import { staleDecisions } from "./stale-decisions";
import { finishedWorkers } from "./worker-retire";

type PaseoApi = PluginHandlerContext["paseo"];

const layout = layoutFor(defaultHome());
try {
  migrateLayout(layout.home);
} catch {
  // A failed rename leaves the old names in place; the plugin then reports the missing files itself.
}
const ALIVE = new Set(["initializing", "idle", "running"]);
const BUSY = new Set(["initializing", "running"]);

let chain: Promise<unknown> = Promise.resolve();
/** Serializes every read-modify-write of the state file. */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

/** The lane the plugin is launching an agent for right now, keyed by dispatcher ID. */
const launching = new Map<string, { laneId: string; ledgerPath: string }>();

function requireRegistry(): Registry {
  const { registry, problems } = loadRegistry(layout);
  if (!registry) throw new Error(problems.join("；"));
  return registry;
}

function requireDispatcher(registry: Registry, id: string): DispatcherDef {
  const found = registry.dispatchers.find((dispatcher) => dispatcher.id === id);
  if (!found) {
    const known = registry.dispatchers.map((dispatcher) => dispatcher.id).join("、");
    throw new Error(`未登记的调度员：${id}。已登记：${known}`);
  }
  return found;
}

async function agentSnapshot(paseo: PaseoApi, agentId: string): Promise<AgentInfo | null> {
  try {
    const result = await paseo.agents.ref(agentId).refresh();
    if (!result) return null;
    const agent = result.agent;
    return {
      id: agent.id,
      status: agent.archivedAt ? "archived" : agent.status,
      title: agent.title ?? null,
      provider: agent.provider ?? null,
      model: agent.model ?? null,
      createdAt: agent.createdAt ?? null,
      lastActivityAt: agent.lastUserMessageAt ?? agent.updatedAt ?? null,
      runningSince: agent.activeTurn?.startedAt ?? null,
      requiresAttention: agent.requiresAttention ?? false,
      attentionReason: agent.attentionReason ?? null,
      pendingPermissions: agent.pendingPermissions?.length ?? 0,
      lastError: agent.lastError ?? null,
    };
  } catch {
    return null;
  }
}

async function agentStatus(paseo: PaseoApi, agentId: string): Promise<string | null> {
  return (await agentSnapshot(paseo, agentId))?.status ?? null;
}

/** Retired sessions change rarely; cache their status so the 5s overview poll stays cheap. */
const retiredStatusCache = new Map<string, { at: number; status: string | null }>();
/** Sessions whose cascade the page's archive button runs itself, so the archived hook doesn't run a second one. */
const cascadeOwned = new Set<string>();
const ARCHIVE_CONCURRENCY = 4;
const RETIRED_TTL_MS = 60_000;

async function retiredStatus(paseo: PaseoApi, agentId: string): Promise<string | null> {
  const cached = retiredStatusCache.get(agentId);
  if (cached && Date.now() - cached.at < RETIRED_TTL_MS) return cached.status;
  const status = await agentStatus(paseo, agentId);
  retiredStatusCache.set(agentId, { at: Date.now(), status });
  return status;
}

function asProfiles(value: unknown): Profile[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Profile =>
      typeof item === "object" && item !== null && typeof item.id === "string" && typeof item.provider === "string",
  );
}

function profilesFrom(config: unknown): Profile[] {
  if (typeof config !== "object" || config === null) return [];
  const record = config as Record<string, unknown>;
  const daemon = record.daemon;
  const nested =
    typeof daemon === "object" && daemon !== null ? (daemon as Record<string, unknown>).agentProfiles : undefined;
  return asProfiles(nested ?? record.agentProfiles);
}

async function loadProfiles(paseo: PaseoApi): Promise<Profile[]> {
  try {
    const found = profilesFrom((await paseo.config.get()).config);
    if (found.length > 0) return found;
  } catch {
    // Fall back to the config file below.
  }
  const file = path.join(process.env.PASEO_HOME || path.join(os.homedir(), ".paseo"), "config.json");
  if (!existsSync(file)) return [];
  return profilesFrom(JSON.parse(readFileSync(file, "utf8")));
}

let catalogCache: { at: number; providers: ProviderCatalog } | null = null;
const CATALOG_TTL_MS = 30_000;

type SnapshotEntry = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>["entries"][number];
type SnapshotModel = NonNullable<SnapshotEntry["models"]>[number];

function catalogModel(model: SnapshotModel): ProviderCatalog[number]["models"][number] {
  return {
    id: model.id,
    label: model.label || model.id,
    isDefault: Boolean(model.isDefault),
    thinking: (model.thinkingOptions ?? []).map((option) => ({ id: option.id, label: option.label || option.id })),
    defaultThinking:
      model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id ?? null,
  };
}

/**
 * Providers, models, thinking levels and modes the daemon can launch, for the role editor and for checking
 * fallbacks before a dispatch. A ready provider whose snapshot carries no models gets its list fetched directly.
 */
async function loadCatalog(paseo: PaseoApi, refresh = false): Promise<ProviderCatalog> {
  if (!refresh && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.providers;
  const snapshot = refresh ? await paseo.providers.refresh().then(() => paseo.providers.snapshot()) : await paseo.providers.snapshot();
  const providers = await Promise.all(
    snapshot.entries.map(async (entry) => {
      let models = (entry.models ?? []).filter((model) => model.isSelectable !== false);
      if (models.length === 0 && entry.enabled && entry.status === "ready") {
        models = ((await paseo.providers.listModels(entry.provider).catch(() => null))?.models ?? []).filter(
          (model) => model.isSelectable !== false,
        );
      }
      return {
        id: entry.provider,
        label: entry.label || entry.provider,
        enabled: entry.enabled,
        status: entry.status,
        models: models.map(catalogModel),
        modes: (entry.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label || mode.id })),
        defaultModeId: entry.defaultModeId ?? null,
      };
    }),
  );
  catalogCache = { at: Date.now(), providers };
  return providers;
}

/** Null when the daemon would not say; callers then skip the availability checks instead of refusing work. */
async function tryCatalog(paseo: PaseoApi): Promise<ProviderCatalog | null> {
  try {
    return await loadCatalog(paseo);
  } catch {
    return null;
  }
}

export async function providerCatalogView(paseo: PaseoApi, input: { refresh?: boolean }) {
  try {
    return { providers: await loadCatalog(paseo, input.refresh), error: null };
  } catch (error) {
    return { providers: [], error: (error as Error).message };
  }
}

const QUOTA_TTL_MS = 5 * 60_000;
let quotaCache: { url: string; at: number; entries: QuotaEntry[] } | null = null;

/** Null when no endpoint is set or it can't be read: then nothing is prechecked, as §4 says. */
async function loadQuotas(url: string | undefined): Promise<QuotaEntry[] | null> {
  if (!url) return null;
  if (quotaCache && quotaCache.url === url && Date.now() - quotaCache.at < QUOTA_TTL_MS) return quotaCache.entries;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const entries = parseQuotas(await response.json());
    quotaCache = { url, at: Date.now(), entries };
    return entries;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const syncRules = (registry: Registry) => syncFiles(layout, registry, new Date());

/**
 * Registers folders the registry does not know and drafts PROJECT.md where a project has none, so the dispatcher
 * does not have to stop and ask the user. Never blocks the caller: a folder that cannot be completed stays as it was.
 * A folder an existing lane already holds as unregistered keeps that key, so the lane's bookkeeping does not move.
 */
async function completeProjects(registry: Registry, folders: readonly string[], dispatcherId: string) {
  const held = new Set(
    allLanes(loadState(layout)).flatMap(({ lane }) => lane.projects.filter((item) => item.key.startsWith("dir:")).map((item) => canonical(item.path))),
  );
  try {
    const result = await ensureProjects(
      layout,
      registry,
      folders.filter((folder) => !held.has(canonical(folder))),
      dispatcherId,
    );
    if (result.registered.length > 0 || result.drafted.length > 0) {
      syncRules(registry);
      for (const item of result.registered) console.log(`[调度员] 已登记新项目 ${item.id}：${item.path}`);
      for (const item of result.drafted) console.log(`[调度员] 已为项目 ${item.id} 生成项目说明草稿：${item.doc}`);
    }
    for (const item of result.skipped) if (item.reason.startsWith("补齐失败")) console.error(`[调度员] ${item.path}：${item.reason}`);
    return result;
  } catch (error) {
    console.error(`[调度员] 补齐项目登记失败：${(error as Error).message}`);
    return null;
  }
}

function describeLaunch(registry: Registry, dispatcher: DispatcherDef): string {
  if (dispatcher.provider) return dispatcher.provider;
  const profileId = dispatcher.profileId ?? registry.defaultProfileId;
  return profileId ? `档案 ${profileId}` : "自动（第一个就绪的 provider）";
}

/** How a dispatcher launches: its own `provider`, else its Agent config, else the first ready provider. */
async function resolveLaunch(
  paseo: PaseoApi,
  registry: Registry,
  dispatcher: DispatcherDef,
  profiles?: Profile[],
): Promise<ResolvedConfig> {
  if (dispatcher.provider) {
    return {
      label: dispatcher.thinkingOptionId ? `${dispatcher.provider} ${dispatcher.thinkingOptionId}` : dispatcher.provider,
      provider: dispatcher.provider,
      modeId: dispatcher.modeId,
      thinkingOptionId: dispatcher.thinkingOptionId,
      family: null,
      profileId: null,
    };
  }
  const profileId = dispatcher.profileId ?? registry.defaultProfileId;
  if (profileId) {
    const profile = (profiles ?? (await loadProfiles(paseo))).find((item) => item.id === profileId);
    if (!profile)
      throw new Error(`找不到 Paseo Agent 配置「${profileId}」，在「Agent 分工」→「设置」里给调度员直接选模型，或在 Paseo 设置里创建它`);
    const provider = profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
    const thinking = dispatcher.thinkingOptionId ?? profile.thinkingOptionId;
    return {
      label: `${profile.name ?? profile.id}（${thinking ? `${provider} ${thinking}` : provider}）`,
      provider,
      modeId: dispatcher.modeId ?? profile.modeId,
      thinkingOptionId: thinking,
      featureValues: profile.featureValues,
      family: null,
      profileId: profile.id,
    };
  }
  const auto = autoConfig(await tryCatalog(paseo));
  if (!auto) throw new Error(`调度员 ${dispatcher.id} 没有设置模型，也没有就绪的 provider 可用`);
  return { ...auto, modeId: dispatcher.modeId ?? auto.modeId };
}

async function launchConfig(paseo: PaseoApi, registry: Registry, dispatcher: DispatcherDef) {
  const config = await resolveLaunch(paseo, registry, dispatcher);
  return {
    provider: config.provider,
    modeId: config.modeId,
    thinkingOptionId: config.thinkingOptionId,
    featureValues: config.featureValues,
  };
}

/** Rewrites every dispatcher's lanes.md; lane counts are global, so all boards change together. */
function writeBoards(registry: Registry, state: State): void {
  const stamp = new Date().toISOString();
  for (const dispatcher of registry.dispatchers) {
    try {
      writeAtomic(layout.laneIndexPath(dispatcher.id), renderLaneIndex(registry, dispatcher, state, stamp));
    } catch (error) {
      console.error(`[dispatch-center] 写会话线看板失败：${(error as Error).message}`);
    }
  }
}

function summarize(task: string | undefined): string | null {
  const line = task?.trim().split(/\r?\n/)[0]?.trim();
  if (!line) return null;
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/**
 * Every lane gets its own workspace so it shows as its own sidebar row. A successor or relaunch stays in the
 * lane's workspace while that is still active. `owned` is false only for the fallback to the directory's
 * shared workspace, which release must not archive.
 */
async function placeLane(paseo: PaseoApi, directory: string, workspaceId: string | null, title: string) {
  if (workspaceId) {
    const existing = paseo.workspaces.ref(workspaceId);
    const current = await existing.refresh().catch(() => null);
    if (current && !current.archivingAt) return { workspace: existing, owned: true, notice: null };
  }
  try {
    const workspace = await paseo.workspaces.create({ source: { kind: "directory", path: directory }, title });
    return { workspace, owned: true, notice: null };
  } catch (error) {
    return {
      workspace: await paseo.workspaces.open(directory),
      owned: false,
      notice: `「${title}」没能开出独立工作区（${(error as Error).message}），暂时和其他会话线共用一个工作区`,
    };
  }
}

function retitleLane(paseo: PaseoApi, lane: Lane): Promise<unknown> | undefined {
  if (!lane.workspaceId) return undefined;
  return paseo.workspaces
    .ref(lane.workspaceId)
    .setTitle(laneTitle(lane))
    .catch((error: Error) => console.error(`[dispatch-center] 更新工作区标题失败：${error.message}`));
}

function laneIntro(lane: { id: string; ledgerPath: string }, dispatcherId: string): string {
  return `你是会话线 ${lane.id}。本线台账 ${lane.ledgerPath}，会话线看板 ${layout.laneIndexPath(dispatcherId)}。`;
}

/**
 * The lane ends on the branch it started from. `launchLane` tells every new agent on the lane (start, relaunch,
 * successor) and `assign` tells a running one when it changes, so no lane closes with
 * its work spread over temporary branches and worktrees. Archiving the lane from the page checks it.
 */
function landingNote(projects: readonly LaneProject[]): string {
  const held = projects.filter((project) => landingOf(project));
  if (held.length === 0) return "";
  const list = held.map((project) => `「${project.name}」→ ${landingOf(project)}`).join("，");
  return `收口分支：${list}。按顺序派的卡都在收口分支的 worktree 上做，集成和预览也用它；只有真并行才另开临时分支和 worktree（一条需求最多再开 2 个，见第 5 节）。临时分支验收后合回收口分支（合回前仍按第 13 节请用户点头，有冲突停下报告），合回后马上撤它的 worktree，本地分支收尾时再删；本线收尾时这些项目只剩收口分支。任务卡的预期分支可以是临时分支，但交付终点是收口分支。`;
}

/** Lanes from before landing branches were recorded fall back to the branch picked on the page. */
function landingOf(project: LaneProject): string | undefined {
  return project.landing ?? project.branch;
}

/** The landing branch for projects that don't have one yet: the picked branch, else what the directory is on. */
async function withLanding(projects: LaneProject[]): Promise<LaneProject[]> {
  return Promise.all(
    projects.map(async (project) => {
      if (project.landing) return project;
      const landing = project.branch ?? (await currentBranch(project.path).catch(() => null));
      return landing ? { ...project, landing } : project;
    }),
  );
}

/** Paseo takes only the bytes and the type; the name stays in the saved file's path. */
function paseoImages(images: PromptImage[]) {
  return images.map(({ data, mimeType }) => ({ data, mimeType }));
}

/**
 * Launches a dispatcher agent for a lane. A lane spec without an existing entry is created; an existing
 * lane (handoff successor, relaunch after its agent died) keeps its ID, projects and ledger.
 */
async function launchLane(
  paseo: PaseoApi,
  registry: Registry,
  dispatcher: DispatcherDef,
  spec: { id: string; workspaceId: string | null; projects: LaneProject[]; summary: string | null; ledgerPath: string; acceptance?: string | null },
  prompt: string,
  reason: string,
  images: PromptImage[] = [],
): Promise<{ agentId: string; workspaceId: string; laneId: string }> {
  const sync = syncRules(registry);
  if (!sync.hashes[dispatcher.id]) throw new Error(sync.problems.join("；") || "生成调度规则失败");
  if (!existsSync(spec.ledgerPath)) writeAtomic(spec.ledgerPath, renderLedger(dispatcher, spec));
  const config = await launchConfig(paseo, registry, dispatcher);
  const title = laneTitle(spec);
  const placed = await placeLane(paseo, layout.dispatcherDir(dispatcher.id), spec.workspaceId, title);
  const workspace = placed.workspace;
  launching.set(dispatcher.id, { laneId: spec.id, ledgerPath: spec.ledgerPath });
  try {
    const agent = await workspace.agents.create({
      config,
      title,
      prompt: [prompt, landingNote(spec.projects)].filter(Boolean).join("\n\n"),
      ...(images.length > 0 ? { images: paseoImages(images) } : {}),
      labels: { [LABEL_ROLE]: "dispatcher", [LABEL_DISPATCHER]: dispatcher.id, "dispatch-center/lane": spec.id },
    });
    const state = loadState(layout);
    const entry = stateOf(state, dispatcher.id);
    let lane = laneOf(entry, spec.id);
    if (!lane) {
      lane = {
        id: spec.id,
        agentId: agent.id,
        workspaceId: null,
        projects: spec.projects,
        summary: spec.summary,
        ledgerPath: spec.ledgerPath,
        startedAt: new Date().toISOString(),
        rulesHash: null,
        pendingHandoff: null,
      };
      entry.lanes.push(lane);
    }
    recordLaneAgent(entry, lane, agent.id, reason, new Date());
    lane.rulesHash = sync.hashes[dispatcher.id] ?? null;
    let notice = placed.notice;
    const current = lane;
    // A daemon that hands back an occupied workspace would make archiving this lane take the others with it.
    const reused =
      placed.owned &&
      (workspace.id === entry.workspaceId ||
        entry.lanes.some((other) => other.id !== current.id && other.workspaceId === workspace.id));
    if (reused) {
      for (const other of entry.lanes) if (other.workspaceId === workspace.id) other.workspaceId = null;
      notice = `Paseo 把「${title}」放回了已有的工作区 ${workspace.id}，这几条会话线在侧边栏里仍叠在一起`;
    }
    lane.workspaceId = placed.owned && !reused ? workspace.id : null;
    if (!placed.owned) entry.workspaceId = workspace.id;
    entry.lastError = notice;
    saveState(layout, state);
    writeBoards(registry, state);
    return { agentId: agent.id, workspaceId: workspace.id, laneId: lane.id };
  } finally {
    launching.delete(dispatcher.id);
  }
}

function newLaneSpec(state: State, dispatcherId: string, projects: LaneProject[], task?: string) {
  const id = newLaneId(state);
  return {
    id,
    workspaceId: null,
    projects,
    summary: summarize(task),
    ledgerPath: layout.laneLedgerPath(dispatcherId, id),
  };
}

/** Running workers per parent agent; null when Paseo can't say, so the page shows "unknown" rather than a guess. */
interface RunningCard {
  id: string;
  title: string | null;
  since: string | null;
  provider: string;
  /** dispatch_work's role label; null for cards started some other way. */
  role: string | null;
}

async function workerCountsByParent(paseo: PaseoApi): Promise<Map<string, RunningCard[]> | null> {
  try {
    const byParent = new Map<string, RunningCard[]>();
    for (const agent of await runningChildren(paseo)) {
      const parent = agent.labels[PARENT_LABEL];
      const card = {
        id: agent.id,
        title: agent.title ?? null,
        since: agent.activeTurn?.startedAt ?? null,
        provider: agent.provider,
        role: agent.labels[WORK_ROLE_LABEL] ?? null,
      };
      byParent.set(parent, [...(byParent.get(parent) ?? []), card]);
    }
    return byParent;
  } catch {
    return null;
  }
}

/** Worker notices queued per dispatcher agent: while one is on its way, that lane is not quiet. */
function pendingNoticesByAgent(): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    for (const notice of loadWatch().notices) counts.set(notice.parentAgentId, (counts.get(notice.parentAgentId) ?? 0) + 1);
  } catch {
    // No watch state yet: nothing is queued.
  }
  return counts;
}

/** A lane's own session and its predecessors: workers started by any of them belong to the lane. */
function laneParents(lane: Lane, history: readonly { agentId: string; laneId?: string | null }[]): Set<string> {
  return new Set([lane.agentId, ...history.filter((item) => item.laneId === lane.id).map((item) => item.agentId)]);
}

async function laneView(
  paseo: PaseoApi,
  registry: Registry,
  lane: Lane,
  history: { agentId: string; laneId?: string | null }[],
  workerCounts: Map<string, RunningCard[]> | null,
  pendingByAgent: ReadonlyMap<string, number>,
): Promise<LaneView> {
  // A worker can outlive the dispatcher that started it, so predecessors on this lane count too.
  const parents = laneParents(lane, history);
  const nameOf = (key: string, fallback: string) => registry.projects.find((p) => p.id === key)?.name ?? fallback;
  const { stage: declared, ...ledger } = ledgerInfo(lane.ledgerPath);
  const running = workerCounts ? [...parents].flatMap((parent) => workerCounts.get(parent) ?? []) : [];
  const events = recentLaneEvents(eventsDir(), lane.id, 8);
  return {
    id: lane.id,
    agentId: lane.agentId,
    agent: await agentSnapshot(paseo, lane.agentId),
    projects: lane.projects.map((project) => ({ ...project, name: nameOf(project.key, project.name) })),
    summary: lane.summary,
    startedAt: lane.startedAt,
    rulesHash: lane.rulesHash,
    ledger,
    stage:
      declared ??
      (workerCounts
        ? deriveStage(
            running.map((card) => card.role),
            events.some((event) => event.kind === "dispatched"),
          )
        : null),
    runningWorkers: workerCounts
      ? [...parents].reduce((sum, parent) => sum + (workerCounts.get(parent)?.length ?? 0), 0)
      : null,
    running,
    pendingNotices: [...parents].reduce((sum, parent) => sum + (pendingByAgent.get(parent) ?? 0), 0),
    effort: laneEventStats(eventsDir(), lane.id),
    reports: laneReports(readText(lane.ledgerPath)),
    events: events.map((event) => ({
      at: event.at,
      kind: event.kind,
      workerId: event.workerId ?? null,
      title: event.title ?? null,
      detail: event.detail ?? null,
    })),
    pendingHandoff: lane.pendingHandoff
      ? { ...lane.pendingHandoff, written: handoffWritten(lane.pendingHandoff.handoffPath) }
      : null,
    review: reviewViewOf(lane.review),
  };
}

/** Archiving can happen anywhere in Paseo, so every count of lanes first drops the ones whose session is archived. Call inside `exclusive`. */
async function settleArchivedLanes(paseo: PaseoApi, registry: Registry, state: State): Promise<void> {
  const lanes = allLanes(state);
  const statuses = await Promise.all(lanes.map(({ lane }) => agentStatus(paseo, lane.agentId)));
  const archived = new Set(lanes.filter((_, index) => statuses[index] === "archived").map(({ lane }) => lane.agentId));
  const released = releaseArchivedLanes(state, archived, new Date());
  if (released.length === 0) return;
  saveState(layout, state);
  writeBoards(registry, state);
  // The lane's own sidebar row goes with it, under the same checks as the cleanup list. Failing here must not break the caller.
  const owned = released.flatMap((lane) => (lane.workspaceId ? [lane.workspaceId] : []));
  if (owned.length === 0) return;
  const counts = newCascadeCounts();
  await archiveSafeWorkspaces(paseo, new Set(owned), counts).catch((error) => logWatch(`归档会话线自己的工作区失败：${(error as Error).message}`));
  logWatch(`释放会话线 ${released.map((lane) => lane.id).join("、")}：工作区 ${counts.workspacesArchived}，留下 ${counts.workspacesKept.length}，失败 ${counts.failed}`);
}

/** Sidebar rows named before the prefix was dropped. Only dispatcher directories: a business workspace may use the word. */
let oldTitlesRenamed = false;
async function renameOldTitles(paseo: PaseoApi, registry: Registry, state: State): Promise<void> {
  if (oldTitlesRenamed) return;
  const directories = new Set(registry.dispatchers.map((dispatcher) => layout.dispatcherDir(dispatcher.id)));
  const lanes = new Map(allLanes(state).map(({ lane }) => [lane.workspaceId, lane]));
  try {
    let cursor: string | undefined;
    do {
      const result = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const workspace of result.entries) {
        const current = workspace.title ?? workspace.name;
        const renamed = withoutDispatcherPrefix(current);
        if (!renamed || !directories.has(workspace.workspaceDirectory)) continue;
        const lane = lanes.get(workspace.id);
        await paseo.workspaces.ref(workspace.id).setTitle(lane ? laneTitle(lane) : renamed);
        logWatch(`工作区改名 ${workspace.id}：${current}`);
      }
      cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
    oldTitlesRenamed = true;
  } catch (error) {
    logWatch(`工作区改名失败：${(error as Error).message}`);
  }
}

/**
 * Read-only, so it does not queue behind the lock: dispatch_work holds that lock while Paseo creates a session, which
 * took up to a minute and timed the page's 5-second poll out. Only releasing an archived lane writes, and that takes
 * the lock briefly.
 */
export function overview(paseo: PaseoApi): Promise<Overview> {
  return (async () => {
    const timings: [string, number][] = [];
    let mark = Date.now();
    const lap = (label: string) => {
      timings.push([label, Date.now() - mark]);
      mark = Date.now();
    };
    const { registry, problems } = loadRegistry(layout);
    const base = {
      home: layout.home,
      registryPath: layout.registryPath,
      checkedAt: new Date().toISOString(),
      watch: watchHealth(),
      plugin: pluginBuild,
    };
    if (!registry)
      return {
        ...base,
        rulesFile: null,
        rulesHash: null,
        limits: { sessions: 0, sessionsPerProject: 0 },
        problems,
        dispatchers: [],
        queue: [],
      };
    let rules: { text: string; hash: string } | null = null;
    try {
      rules = readRules(layout, registry);
    } catch (error) {
      problems.push(`读取规则原文失败（${rulesPath(layout, registry)}）：${(error as Error).message}`);
    }
    let state = loadState(layout);
    lap("读登记与规则");
    const laneStatuses = await Promise.all(allLanes(state).map(({ lane }) => agentStatus(paseo, lane.agentId)));
    if (laneStatuses.includes("archived")) {
      state = await exclusive(async () => {
        const fresh = loadState(layout);
        await settleArchivedLanes(paseo, registry, fresh);
        return fresh;
      });
    }
    lap("核对归档会话线");
    await renameOldTitles(paseo, registry, state);
    lap("改旧标题");
    const workerCounts = await workerCountsByParent(paseo);
    const pendingByAgent = pendingNoticesByAgent();
    lap("在跑工位");
    const dispatchers: DispatcherView[] = await Promise.all(
      registry.dispatchers.map(async (dispatcher) => {
        const entry = stateOf(state, dispatcher.id);
        const lanes = await Promise.all(
          entry.lanes.map((lane) => laneView(paseo, registry, lane, entry.history, workerCounts, pendingByAgent)),
        );
        const live = new Map(lanes.map((lane) => [lane.agentId, lane.agent?.status ?? null]));
        const history = await Promise.all(
          [...entry.history]
            .reverse()
            .map(async (item) => ({
              ...item,
              laneId: item.laneId ?? null,
              status: live.has(item.agentId)
                ? (live.get(item.agentId) ?? null)
                : await retiredStatus(paseo, item.agentId),
            })),
        );
        return {
          id: dispatcher.id,
          name: dispatcher.name,
          directory: layout.dispatcherDir(dispatcher.id),
          workspaceId: entry.workspaceId,
          launch: describeLaunch(registry, dispatcher),
          projects: registry.projects
            .filter((project) => project.owner === dispatcher.id)
            .map((project) => ({
              id: project.id,
              name: project.name,
              repos: project.repos,
              projectDoc: project.projectDoc,
              docExists: project.projectDoc !== null && existsSync(expandHome(project.projectDoc)),
              statusDir: project.statusDir ?? null,
              note: project.note ?? null,
            })),
          lanes,
          rulesStale: rules ? agentsFileStale(layout, registry, dispatcher, rules) : false,
          agentsPath: path.join(layout.dispatcherDir(dispatcher.id), "AGENTS.md"),
          boardPath: layout.laneIndexPath(dispatcher.id),
          lastError: entry.lastError,
          pushableKept: entry.lastError ? entry.pushableKept : [],
          history,
        };
      }),
    );
    lap("会话线与历史");
    const total = timings.reduce((sum, [, ms]) => sum + ms, 0);
    if (total > 1500) logWatch(`总览慢 ${total}ms：${timings.map(([label, ms]) => `${label} ${ms}`).join("，")}`);
    const queue = queueView(registry, state);
    // A slot freed up somewhere Paseo did not tell us about: start the waiting requirement now, not at the next minute.
    if (queue.some((item) => item.ready)) void tickQueue(paseo).catch((error) => logWatch(`排队检查出错：${(error as Error).message}`));
    return {
      ...base,
      rulesFile: rulesPath(layout, registry),
      rulesHash: rules?.hash ?? null,
      limits: limitsOf(registry),
      problems,
      dispatchers,
      queue,
    };
  })();
}

export function sync() {
  return exclusive(async () => {
    const { registry, problems } = loadRegistry(layout);
    if (!registry) return { written: [], problems };
    const result = syncRules(registry);
    const state = loadState(layout);
    for (const [id, hash] of Object.entries(result.hashes))
      for (const lane of stateOf(state, id).lanes) lane.rulesHash = hash;
    saveState(layout, state);
    writeBoards(registry, state);
    return { written: result.written, problems: [...problems, ...result.problems] };
  });
}

/** Opens a new lane with no projects bound (used by /dispatch). */
export function start(paseo: PaseoApi, input: { dispatcherId: string; task?: string }) {
  return exclusive(async () => {
    const registry = requireRegistry();
    const dispatcher = requireDispatcher(registry, input.dispatcherId);
    const state = loadState(layout);
    await settleArchivedLanes(paseo, registry, state);
    const limits = limitsOf(registry);
    const total = allLanes(state).length;
    if (total >= limits.sessions)
      throw new Error(`已有 ${total} 条会话线（上限 ${limits.sessions}），请先归档一条，或在「指派任务」里发给现有会话线`);
    const spec = newLaneSpec(state, dispatcher.id, [], input.task);
    const task = input.task?.trim();
    const prompt = [
      laneIntro(spec, dispatcher.id),
      task
        ? `开工：按 AGENTS.md 读本线台账，然后处理本次需求：\n\n${task}`
        : "开工：按 AGENTS.md 读本线台账，简短回报，然后等待指令。",
    ].join("\n\n");
    return launchLane(paseo, registry, dispatcher, spec, prompt, "新建会话线");
  });
}

function targetViews(registry: Registry, state: State, paths: string[]): TargetView[] {
  const nameOf = (id: string) => registry.dispatchers.find((item) => item.id === id)?.name ?? id;
  const seen = new Set<string>();
  const views: TargetView[] = [];
  for (const folder of paths) {
    const target = resolveTarget(registry, folder);
    if (seen.has(target.path)) continue;
    seen.add(target.path);
    views.push({
      path: target.path,
      name: target.name,
      projectId: target.projectId,
      owner: target.owner,
      ownerName: target.owner ? nameOf(target.owner) : null,
      configured: target.projectDoc !== null,
      isGit: isGitRoot(target.path),
      exists: existsSync(target.path),
      holders: holdersOf(state, laneProject(target).key).map(({ dispatcherId, lane }) => ({
        dispatcherId,
        laneId: lane.id,
        agentId: lane.agentId,
        summary: lane.summary,
        branch: lane.projects.find((item) => item.key === laneProject(target).key)?.branch ?? null,
      })),
    });
  }
  return views;
}

export async function resolveTargets(input: { paths: string[] }) {
  const registry = requireRegistry();
  // Folders added to the page get registered to the dispatcher that would lead them, so 「未登记」 never shows up.
  const lead = suggestLead(
    registry,
    input.paths.map((folder) => resolveTarget(registry, folder)),
  ) ?? registry.dispatchers[0]?.id;
  if (lead) await completeProjects(registry, input.paths, lead);
  const state = loadState(layout);
  const targets = targetViews(registry, state, input.paths);
  const suggested = suggestLead(
    registry,
    targets.map((target) => resolveTarget(registry, target.path)),
  );
  return { targets, suggestedDispatcherId: suggested ?? registry.dispatchers[0]?.id ?? null };
}

/**
 * Delivers a task bound to one or more folders. Routing (see planRoute): to the lane already holding
 * all of them, to a lane the user picked, or to a new lane — within the session limits.
 */
export async function targetBranches(input: { path: string }) {
  return { branches: await listBranches(canonical(input.path)) };
}

/**
 * The picked folders as the projects a new or existing lane would hold. Checks they exist and are not the dispatch
 * home, and resolves the branch picked for each. A lane only holds projects it may dispatch for: its own
 * dispatcher's, or unregistered folders.
 */
async function resolveAssignment(
  registry: Registry,
  dispatcher: DispatcherDef,
  paths: readonly string[],
  choices?: Record<string, { name: string; base?: string }>,
) {
  const unique = [...new Set(paths.map((folder) => canonical(folder)))];
  const missing = unique.filter((folder) => !existsSync(folder));
  if (missing.length > 0) throw new Error(`文件夹不存在：${missing.join("、")}`);
  for (const folder of unique)
    if (isInside(canonical(layout.home), folder)) throw new Error(`不能把调度目录当作目标项目：${folder}`);
  await completeProjects(registry, unique, dispatcher.id);
  const targets = unique.map((folder) => resolveTarget(registry, folder));
  const heldTargets = targets.filter((target) => !target.owner || target.owner === dispatcher.id);
  const branches = new Map<string, ResolvedBranch>();
  for (const target of heldTargets) {
    const choice = choices?.[target.path];
    if (choice) branches.set(target.path, await resolveBranchChoice(target.path, choice));
  }
  const held = await withLanding(heldTargets.map((target) => laneProject(target, branches.get(target.path)?.name)));
  return { targets, held, branches };
}

/** Opens a lane for a new requirement. `savedImages` are files already on disk (a queued requirement's). */
async function openNewLane(
  paseo: PaseoApi,
  registry: Registry,
  dispatcher: DispatcherDef,
  state: State,
  plan: Awaited<ReturnType<typeof resolveAssignment>> & {
    task?: string;
    acceptance?: string;
    shared: ReturnType<typeof planRoute>["shared"];
    images: PromptImage[];
    savedImages?: string[];
    reason: string;
  },
) {
  const spec = { ...newLaneSpec(state, dispatcher.id, plan.held, plan.task), acceptance: plan.acceptance?.trim() || null };
  const files = plan.savedImages ?? saveImages(layout, dispatcher.id, spec.id, plan.images);
  const prompt = [
    laneIntro(spec, dispatcher.id),
    assignmentPrompt({
      registry,
      targets: plan.targets,
      dispatcherId: dispatcher.id,
      task: plan.task,
      acceptance: plan.acceptance,
      fresh: true,
      branches: plan.branches,
    }),
    sharedNotice(plan.shared),
    imagesNote(files),
  ]
    .filter(Boolean)
    .join("\n\n");
  return launchLane(paseo, registry, dispatcher, spec, prompt, plan.reason, plan.images);
}

export function assign(
  paseo: PaseoApi,
  input: {
    paths: string[];
    dispatcherId: string;
    task?: string;
    acceptance?: string;
    branches?: Record<string, { name: string; base?: string }>;
    laneId?: string;
    newLane?: boolean;
    confirmIndependent?: boolean;
    images?: PromptImage[];
  },
) {
  const images = input.images ?? [];
  checkImages(images);
  return exclusive(async () => {
    const registry = requireRegistry();
    const dispatcher = requireDispatcher(registry, input.dispatcherId);
    const { targets, held, branches } = await resolveAssignment(registry, dispatcher, input.paths, input.branches);

    const state = loadState(layout);
    await settleArchivedLanes(paseo, registry, state);
    const route = planRoute({
      state,
      dispatcherId: dispatcher.id,
      projects: held,
      limits: limitsOf(registry),
      laneId: input.laneId,
      newLane: input.newLane,
      confirmIndependent: input.confirmIndependent,
    });

    let result: { agentId: string; workspaceId: string | null; laneId: string; delivery: "sent" | "started" };
    if (route.kind === "send") {
      const entry = stateOf(state, dispatcher.id);
      const lane = laneOf(entry, route.laneId)!;
      if (lane.pendingHandoff) throw new Error(`会话线 ${lane.id} 正在换班，等接班后再交任务`);
      const status = await agentStatus(paseo, lane.agentId);
      if (status && BUSY.has(status))
        throw new Error(`会话线 ${lane.id} 正在执行，等本轮结束再交任务，或新开一条会话线`);
      const added = held.filter((project) => !lane.projects.some((item) => item.key === project.key));
      const titleBefore = laneTitle(lane);
      lane.projects.push(...added);
      const landingBefore = landingNote(lane.projects);
      for (const project of held) {
        const item = lane.projects.find((existing) => existing.key === project.key);
        if (item && project.branch) item.branch = item.landing = project.branch;
        else if (item) item.landing ??= project.landing;
      }
      const landingNow = landingNote(lane.projects);
      lane.summary ??= summarize(input.task);
      if (input.acceptance?.trim() && existsSync(lane.ledgerPath)) {
        const before = readFileSync(lane.ledgerPath, "utf8");
        const after = withAcceptance(before, input.acceptance);
        if (after !== before) writeAtomic(lane.ledgerPath, after);
      }
      if (laneTitle(lane) !== titleBefore) await retitleLane(paseo, lane);
      const body = assignmentPrompt({
        registry,
        targets,
        dispatcherId: dispatcher.id,
        task: input.task,
        acceptance: input.acceptance,
        fresh: !(status === "idle" || status === "closed"),
        branches,
      });
      const notice = sharedNotice(route.shared);
      const extra = [
        added.length > 0 ? `本线新增项目：${added.map((project) => project.name).join("、")}，请同步到台账。` : "",
        landingNow !== landingBefore ? landingNow : "",
      ]
        .filter(Boolean)
        .join("\n");
      const attached = imagesNote(saveImages(layout, dispatcher.id, lane.id, images));
      const prompt = [body, extra, notice, attached].filter(Boolean).join("\n\n");
      if (status === "idle" || status === "closed") {
        saveState(layout, state);
        writeBoards(registry, state);
        await paseo.agents.ref(lane.agentId).send(prompt, images.length > 0 ? { images: paseoImages(images) } : undefined);
        result = {
          agentId: lane.agentId,
          workspaceId: lane.workspaceId ?? entry.workspaceId,
          laneId: lane.id,
          delivery: "sent",
        };
      } else {
        // The lane's agent is gone or broken: relaunch on the same lane, it recovers from the lane ledger.
        saveState(layout, state);
        const launched = await launchLane(
          paseo,
          registry,
          dispatcher,
          lane,
          [laneIntro(lane, dispatcher.id), prompt].join("\n\n"),
          "会话线重启",
          images,
        );
        result = { ...launched, delivery: "started" };
      }
    } else {
      const launched = await openNewLane(paseo, registry, dispatcher, state, {
        targets,
        held,
        branches,
        task: input.task,
        acceptance: input.acceptance,
        shared: route.shared,
        images,
        reason: "指派项目",
      });
      result = { ...launched, delivery: "started" };
    }

    return { dispatcherId: dispatcher.id, ...result };
  });
}

export async function browse(paseo: PaseoApi, input: { path?: string; showHidden?: boolean }) {
  const home = os.homedir();
  const listing = listDirectory(input.path ? expandHome(input.path) : home, input.showHidden ?? false);
  const shortcuts: { label: string; path: string; source: "registry" | "paseo" | "home" }[] = [
    { label: "主目录", path: home, source: "home" },
  ];
  const seen = new Set<string>([canonical(home)]);
  const push = (label: string, folder: string, source: "registry" | "paseo") => {
    const key = canonical(folder);
    if (seen.has(key) || !existsSync(key) || isInside(canonical(layout.home), key)) return;
    seen.add(key);
    shortcuts.push({ label, path: key, source });
  };
  const { registry } = loadRegistry(layout);
  for (const project of registry?.projects ?? [])
    for (const repo of project.repos)
      push(project.repos.length > 1 ? `${project.name} · ${path.basename(repo)}` : project.name, repo, "registry");
  try {
    const known = await paseo.projects.list();
    for (const project of known.projects) push(project.projectDisplayName, project.projectRootPath, "paseo");
  } catch {
    // Paseo's project list is a convenience; browsing still works without it.
  }
  return { ...listing, home, shortcuts };
}

export function readDoc(input: { path: string }) {
  // Workers' status files live in each registered project's 进度 folder, outside the dispatch home.
  const { registry } = loadRegistry(layout);
  const statusDirs = (registry?.projects ?? []).flatMap((project) => (project.statusDir ? [expandHome(project.statusDir)] : []));
  return readDocument(layout, input.path, statusDirs);
}

function findLane(state: State, input: { dispatcherId?: string; laneId?: string; agentId?: string }) {
  if (input.agentId) {
    const found = laneByAgent(state, input.agentId);
    if (!found) throw new Error("当前会话不是登记在岗的调度员会话线");
    return found;
  }
  if (!input.dispatcherId) throw new Error("需要指定调度员");
  const entry = stateOf(state, input.dispatcherId);
  if (input.laneId) {
    const lane = laneOf(entry, input.laneId);
    if (!lane) throw new Error(`会话线 ${input.laneId} 已不存在`);
    return { dispatcherId: input.dispatcherId, lane };
  }
  if (entry.lanes.length === 1) return { dispatcherId: input.dispatcherId, lane: entry.lanes[0] };
  throw new Error(entry.lanes.length === 0 ? "没有在岗的会话线" : "有多条会话线，请指定换哪一条");
}

export function handoff(paseo: PaseoApi, input: { dispatcherId?: string; laneId?: string; agentId?: string }) {
  return exclusive(async () => {
    const registry = requireRegistry();
    const state = loadState(layout);
    const { dispatcherId, lane } = findLane(state, input);
    requireDispatcher(registry, dispatcherId);
    const entry = stateOf(state, dispatcherId);
    if (lane.pendingHandoff) throw new Error(`会话线 ${lane.id} 已在换班，交接文件：${lane.pendingHandoff.handoffPath}`);
    const status = await agentStatus(paseo, lane.agentId);
    if (status === "running" || status === "initializing") throw new Error("调度员正在执行，等本轮结束再换班");
    if (status !== "idle" && status !== "closed")
      throw new Error(`旧调度员不可用（${status ?? "已不存在"}），直接在「指派任务」里发给这条线，会从台账重启`);
    const now = new Date();
    const handoffPath = handoffPathFor(layout, dispatcherId, now, lane.id);
    lane.pendingHandoff = { fromAgentId: lane.agentId, handoffPath, requestedAt: now.toISOString() };
    entry.lastError = null;
    saveState(layout, state);
    try {
      await paseo.agents.ref(lane.agentId).send(handoffInstruction(handoffPath, lane.ledgerPath));
    } catch (error) {
      lane.pendingHandoff = null;
      entry.lastError = `发送换班指令失败：${(error as Error).message}`;
      saveState(layout, state);
      throw error;
    }
    return { dispatcherId, laneId: lane.id, fromAgentId: lane.agentId, handoffPath };
  });
}

/** A turn ending only validates the handoff; a human must explicitly launch its successor. */
export function onTurnEnded(_paseo: PaseoApi, agentId: string, outcome: string) {
  return exclusive(async () => {
    if (!existsSync(layout.statePath)) return;
    const state = loadState(layout);
    const match = allLanes(state).find(({ lane }) => lane.pendingHandoff?.fromAgentId === agentId);
    if (!match) return;
    const { dispatcherId, lane } = match;
    const entry = stateOf(state, dispatcherId);
    if (outcome === "canceled" || !handoffWritten(lane.pendingHandoff!.handoffPath)) {
      entry.lastError = outcome === "canceled"
        ? `会话线 ${lane.id} 交接被中止，旧调度员继续在岗`
        : `会话线 ${lane.id} 未写出交接文件 ${lane.pendingHandoff!.handoffPath}，请重新准备交接`;
      lane.pendingHandoff = null;
      saveState(layout, state);
    }
  });
}

const askedAboutDecisions = new Map<string, string>();

/**
 * The user answered a 待拍板 in the dispatcher's conversation, not on the page: the dispatcher goes ahead but often
 * leaves the item open, and the page keeps asking. After a turn the user opened, with items still open in the ledger,
 * it is asked once to tick the ones that reply settled. A reminder it opens itself never triggers another.
 */
export async function remindOpenDecisions(paseo: PaseoApi, agentId: string, outcome: string): Promise<void> {
  if (outcome !== "completed" || !existsSync(layout.statePath)) return;
  const found = laneByAgent(loadState(layout), agentId);
  if (!found || found.lane.pendingHandoff || !existsSync(found.lane.ledgerPath)) return;
  const { decisions } = summarizeLedger(readFileSync(found.lane.ledgerPath, "utf8"));
  if (decisions.length === 0) return;
  const opener = await typedOpener(paseo, agentId);
  // Only a reply that reads as an answer is worth a turn; anything else is the user talking about something else.
  if (!opener || !looksLikeAnswer(opener)) return;
  const key = `${opener}\u0000${decisions.map((item) => item.line).join("\n")}`;
  if (askedAboutDecisions.get(agentId) === key) return;
  askedAboutDecisions.set(agentId, key);
  const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 80)}…` : text);
  const text = [
    "【插件提醒：台账里还有待拍板没收口】",
    ...decisions.slice(0, MAX_LISTED_DECISIONS).map((item) => `- ${clip(item.text)}`),
    ...(decisions.length > MAX_LISTED_DECISIONS ? [`- …另 ${decisions.length - MAX_LISTED_DECISIONS} 条见台账`] : []),
    "用户刚在对话里回复了你。这次回复已经答了哪条，就在台账改成 `- [x] … → 用户：原话`（照原话摘，不改写）；已经做完或被取代的改成 `- [x] … → 已过时：原因`；用户没说到的不动。只改台账，不用回复用户这条提醒。",
  ].join("\n");
  await sendConfirmed(paseo, agentId, text, randomUUID());
  logWatch(`会话线 ${found.lane.id} 用户在对话里回复后还有 ${decisions.length} 条待拍板没收口，已提醒调度员`);
}

/** The message that opened the agent's last turn, when the user typed it; null for the plugin's or another session's. */
async function typedOpener(paseo: PaseoApi, agentId: string): Promise<string | null> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200 });
  const opener = [...(page.entries ?? [])].reverse().find((entry) => entry.item.type === "user_message")?.item;
  if (!opener || opener.type !== "user_message") return null;
  // What one session sends another arrives wrapped; only something typed counts.
  if (/^\s*<paseo-system\b[^>]*\bkind="agent-message"/.test(opener.text)) return null;
  // The plugin's own messages to the dispatcher all open with a 【…】 heading.
  if (opener.text.trimStart().startsWith("【")) return null;
  return opener.text;
}

/** A lane's agent, or the lane a since-retired agent worked for, so a worker's notice reaches its successor. */
function noticeTarget(parentAgentId: string): Promise<NoticeTarget | null> {
  return exclusive(async () => {
    if (!existsSync(layout.statePath)) return null;
    const state = loadState(layout);
    const found =
      laneByAgent(state, parentAgentId) ??
      allLanes(state).find(({ dispatcherId, lane }) =>
        stateOf(state, dispatcherId).history.some((item) => item.agentId === parentAgentId && item.laneId === lane.id),
      );
    if (!found) return null;
    return {
      key: `${found.dispatcherId}:${found.lane.id}`,
      agentId: found.lane.agentId,
      laneId: found.lane.id,
      handoffPending: !!found.lane.pendingHandoff,
    };
  });
}

const watchDir = () => path.dirname(layout.statePath);

const pluginRoot = (() => {
  try {
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
})();
const pluginBuild = readPluginBuild(pluginRoot);
const eventsDir = () => path.join(watchDir(), "events");

function laneEvent(laneId: string, kind: LaneEventKind, fields: { workerId?: string; title?: string | null; detail?: string | null } = {}) {
  try {
    appendLaneEvent(eventsDir(), laneId, { at: new Date().toISOString(), kind, ...fields });
  } catch (error) {
    logWatch(`记会话线事件失败 ${laneId}：${(error as Error).message}`);
  }
}

function logWatch(line: string): void {
  try {
    mkdirSync(watchDir(), { recursive: true });
    appendFileSync(path.join(watchDir(), "worker-watch.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The log only helps diagnose; watching must not fail because of it.
  }
}

function loadWatch(): WatchState {
  try {
    const parsed = JSON.parse(readFileSync(path.join(watchDir(), "worker-watch.json"), "utf8"));
    return {
      workers: parsed.workers ?? {},
      notices: parsed.notices ?? [],
      endings: parsed.endings ?? {},
      known: parsed.known ?? {},
    };
  } catch {
    return emptyWatch();
  }
}

const DELIVERY_TIMEOUT_MS = 40_000;
const DELIVERY_POLL_MS = 1_500;

/**
 * Sends and waits until the dispatcher has actually started a turn on it. Paseo's send resolves before the turn
 * starts, and when the provider still holds the previous turn the start fails in the background (Paseo retries for
 * about half a minute, then gives up). Throwing here keeps the notice queued for the next scan.
 */
async function sendConfirmed(paseo: PaseoApi, agentId: string, text: string, messageId: string): Promise<void> {
  const ref = paseo.agents.ref(agentId);
  const sentAt = Date.now();
  await ref.send(text, { messageId });
  let lastError: string | null = null;
  while (Date.now() - sentAt < DELIVERY_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_POLL_MS));
    const agent = (await ref.refresh().catch(() => null))?.agent;
    if (!agent) continue;
    if (agent.activeTurn || BUSY.has(agent.status)) return;
    lastError = agent.lastError ?? lastError;
    // A turn short enough to start and finish between two polls is caught by its replies.
    if (await answeredInTimeline(paseo, agentId, messageId).catch(() => false)) return;
  }
  throw new Error(`调度员没开始处理这条通知${lastError ? `（${lastError}）` : ""}`);
}

/**
 * Whether the message opened a turn that produced anything: reasoning, a tool call or a reply. Paseo's own
 * "[System Error]" lines carry no turn, so a message that only drew errors counts as not answered.
 */
async function answeredInTimeline(paseo: PaseoApi, agentId: string, messageId: string): Promise<boolean> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200 });
  const entries = page.entries ?? [];
  const message = entries.find((entry) => entry.item.type === "user_message" && entry.item.messageId === messageId);
  if (!message?.turnId) return false;
  return entries.some((entry) => entry.turnId === message.turnId && entry.item.type !== "user_message");
}

const REVIEW_OUTCOMES = new Set(["ended", "failed", "canceled", "gone"]);

/** A review card's worker finished or went away; that decides whether the lane's sensitive change counts as reviewed. */
const cooldownPath = () => path.join(path.dirname(layout.statePath), "cooldowns.json");

function loadCooldowns(): Cooldown[] {
  try {
    const parsed = JSON.parse(readFileSync(cooldownPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.family === "string" && typeof item.until === "number") : [];
  } catch {
    return [];
  }
}

/** A worker failed for want of capacity, a rate limit or a used-up allowance: its provider sits out the next cards. */
function noteCooldown(provider: string, detail: string | null) {
  const now = Date.now();
  const next = cooldownFor(familyOf(provider), detail, now);
  if (!next) return;
  try {
    writeAtomic(cooldownPath(), `${JSON.stringify(withCooldown(loadCooldowns(), next, now), null, 2)}\n`);
    logWatch(`暂停派给 ${next.family}：${next.reason}，到 ${new Date(next.until).toISOString()}`);
  } catch (error) {
    logWatch(`记暂停出错：${(error as Error).message}`);
  }
}

function recordReviewerOutcome(laneId: string, workerId: string, outcome: ReviewerOutcome) {
  return exclusive(async () => {
    const state = loadState(layout);
    const lane = allLanes(state).find((item) => item.lane.id === laneId)?.lane;
    if (!lane) return;
    const next = withReviewerOutcome(lane.review, workerId, outcome, new Date().toISOString());
    if (!next) return;
    // The requirements this review covered, so one added afterwards gets its own (§9: one per requirement).
    if (reviewViewOf(next)?.state === "done" && reviewViewOf(lane.review)?.state !== "done") next.covered = requirementIds(lane);
    lane.review = next;
    saveState(layout, state);
    logWatch(`会话线 ${laneId} 的审查 ${workerId}：${outcome}`);
  });
}

function watchIo(paseo: PaseoApi): WatchIo {
  return {
    runningWorkers: async () =>
      (await runningChildren(paseo)).map((agent) => ({
        id: agent.id,
        provider: agent.provider,
        parentAgentId: agent.labels[PARENT_LABEL],
        title: agent.title ?? null,
        lastActivityAt: agent.updatedAt ?? null,
        turnStartedAt: agent.activeTurn?.startedAt ?? null,
      })),
    workerStatus: async (id) => {
      const result = await paseo.agents.ref(id).refresh();
      if (!result) return null;
      return {
        status: result.agent.archivedAt ? "archived" : result.agent.status,
        lastError: result.agent.lastError ?? null,
      };
    },
    findTarget: noticeTarget,
    openDecisions: async (laneId) => {
      const lane = allLanes(loadState(layout)).find(({ lane }) => lane.id === laneId)?.lane;
      if (!lane || !existsSync(lane.ledgerPath)) return [];
      return summarizeLedger(readFileSync(lane.ledgerPath, "utf8")).decisions.map((item) => item.text);
    },
    event: (parentAgentId, event) => {
      if (event.kind === "failed" || event.kind === "interrupted") noteCooldown(event.provider ?? "", event.detail);
      void noticeTarget(parentAgentId)
        .then((target) => {
          if (target)
            laneEvent(target.laneId, event.kind as LaneEventKind, {
              workerId: event.workerId,
              title: event.title,
              detail: event.detail ? event.detail.slice(0, 300) : null,
            });
          if (target && event.workerId && REVIEW_OUTCOMES.has(event.kind))
            void recordReviewerOutcome(target.laneId, event.workerId, event.kind as ReviewerOutcome).catch(() => undefined);
        })
        .catch(() => undefined);
    },
    readStatusFile: async (file) => {
      const resolved = expandHome(file);
      return existsSync(resolved) ? readFileSync(resolved, "utf8") : null;
    },
    statusFileWrittenAt: async (file) => {
      const resolved = expandHome(file);
      return existsSync(resolved) ? statSync(resolved).mtimeMs : null;
    },
    dispatcherStatus: (agentId) => agentStatus(paseo, agentId),
    send: (agentId, text, messageId) => sendConfirmed(paseo, agentId, text, messageId),
    turnOpener: async (workerId) => {
      const page = await paseo.agents.ref(workerId).timeline.refetch({ direction: "tail", limit: 200 });
      const opener = [...(page.entries ?? [])].reverse().find((entry) => entry.item.type === "user_message")?.item;
      if (!opener || opener.type !== "user_message") return null;
      // Paseo wraps a message one session sends another; what someone types arrives as plain text.
      return /^\s*<paseo-system\b[^>]*\bkind="agent-message"/.test(opener.text) ? "agent" : "user";
    },
    lastReply: async (workerId) => {
      const page = await paseo.agents.ref(workerId).timeline.refetch({ direction: "tail", limit: 30 });
      const replies = (page.entries ?? []).filter(
        (entry) => entry.item.type === "assistant_message" && !entry.item.text.startsWith("[System Error]"),
      );
      const last = replies[replies.length - 1]?.item;
      return last && last.type === "assistant_message" ? last.text : null;
    },
    answered: (agentId, messageId) => answeredInTimeline(paseo, agentId, messageId),
    newMessageId: () => randomUUID(),
    replyHandled: async (laneAgentId, detail) => {
      const found = laneByAgent(loadState(layout), laneAgentId);
      if (!found || !existsSync(found.lane.ledgerPath)) return false;
      const ledger = readFileSync(found.lane.ledgerPath, "utf8").split("\n").filter((line) => /\[x\]/i.test(line));
      const items = detail.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
      return items.length > 0 && items.every((item) => !ledger.some((line) => line.includes(item)));
    },
    log: logWatch,
    now: () => Date.now(),
  };
}

/** Paseo is only handed to hooks and RPCs, so the watch starts at the first one and keeps the newest handle. */
let watchPaseo: PaseoApi | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchChain: Promise<unknown> = Promise.resolve();
let lastWatchError: string | null = null;
let watchStartedAt: number | null = null;
let lastScanAt: number | null = null;

/** For the page: the watch replaces heartbeats, so a stalled watch must be visible. */
export function watchHealth(): { startedAt: string | null; lastScanAt: string | null; error: string | null } {
  const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
  return { startedAt: iso(watchStartedAt), lastScanAt: iso(lastScanAt), error: lastWatchError };
}

async function scanAndMark(state: WatchState, io: WatchIo): Promise<void> {
  await scanWorkers(state, io);
  lastScanAt = Date.now();
}

function runWatch(work: (state: WatchState, io: WatchIo) => Promise<void>): Promise<void> {
  const next = watchChain.then(async () => {
    if (!watchPaseo) return;
    const state = loadWatch();
    const before = JSON.stringify(state);
    try {
      await work(state, watchIo(watchPaseo));
      lastWatchError = null;
    } catch (error) {
      const message = (error as Error).message;
      if (message !== lastWatchError) logWatch(`巡检出错：${message}`);
      lastWatchError = message;
    } finally {
      if (JSON.stringify(state) !== before) {
        mkdirSync(watchDir(), { recursive: true });
        writeAtomic(path.join(watchDir(), "worker-watch.json"), `${JSON.stringify(state, null, 2)}\n`);
      }
    }
  });
  watchChain = next.catch(() => undefined);
  return next;
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
const cleanupFile = () => path.join(watchDir(), "auto-cleanup.json");

/**
 * Once a day, the same cleanup as 「清理它们留下的会话和工作区」: workers and workspaces left behind by archived
 * dispatchers, under the same checks (nothing running is touched, worktrees need a clean tree and no unpushed commits).
 * The time of the last run is on disk, so reloading the plugin neither skips a day nor repeats one.
 */
async function autoCleanup(): Promise<void> {
  const paseo = watchPaseo;
  if (!paseo) return;
  let previous: CleanupRecord | null = null;
  try {
    previous = parseCleanupRecord(readFileSync(cleanupFile(), "utf8"));
  } catch {
    // No record yet: the first run happens now.
  }
  if (!cleanupDue(previous?.lastRunAt, Date.now())) return;
  try {
    const counts = await archiveLeftoverWorkers(paseo);
    const record: CleanupRecord = {
      lastRunAt: new Date().toISOString(),
      archived: counts.archived,
      workspacesArchived: counts.workspacesArchived,
      kept: counts.workspacesKept.length,
      running: counts.running,
      failed: counts.failed,
    };
    mkdirSync(watchDir(), { recursive: true });
    writeAtomic(cleanupFile(), `${JSON.stringify(record, null, 2)}\n`);
    logWatch(`每日自动清理完成：会话 ${record.archived}，工作区 ${record.workspacesArchived}，留下 ${record.kept}，在跑 ${record.running}，失败 ${record.failed}`);
  } catch (error) {
    // Not recorded as a run, so the next check tries again.
    logWatch(`每日自动清理失败：${(error as Error).message}`);
  }
}

const SLIM_EVERY_MS = 10 * 60_000;
let lastSlimAt = 0;

/** True only when Paseo says the session is archived or no longer exists; a failed lookup is not an answer. */
async function sessionFinished(paseo: PaseoApi, agentId: string): Promise<boolean> {
  try {
    const result = await paseo.agents.ref(agentId).refresh();
    return !result || Boolean(result.agent.archivedAt);
  } catch {
    return false;
  }
}

/**
 * The dispatcher reads its whole ledger every turn, and rows the plugin adds were never taken out again. Every 10
 * minutes, for lanes whose dispatcher is idle, finished sessions' rows, older answered decisions and older completions
 * move to an archive file next to the ledger. A ledger edited meanwhile is left for the next round.
 */
async function slimLedgers(): Promise<void> {
  if (!watchPaseo || !existsSync(layout.statePath) || Date.now() - lastSlimAt < SLIM_EVERY_MS) return;
  lastSlimAt = Date.now();
  const paseo = watchPaseo;
  const queued = new Set(loadWatch().notices.filter((notice) => notice.kind === "reply").map((notice) => notice.parentAgentId));
  const lanes = allLanes(loadState(layout))
    .map(({ lane }) => lane)
    .filter((lane) => !lane.pendingHandoff && existsSync(lane.ledgerPath));
  for (const lane of lanes) {
    if ((await agentStatus(paseo, lane.agentId)) !== "idle") continue;
    const before = readFileSync(lane.ledgerPath, "utf8");
    const ids = runningTableAgents(before);
    const done = await mapLimit(ids, ARCHIVE_CONCURRENCY, (id) => sessionFinished(paseo, id));
    const archivePath = path.join(path.dirname(lane.ledgerPath), "archive", path.basename(lane.ledgerPath));
    await exclusive(async () => {
      const current = readFileSync(lane.ledgerPath, "utf8");
      if (current !== before) return;
      const result = slimLedger(current, {
        finished: new Set(ids.filter((_, index) => done[index])),
        archiveDecisions: !queued.has(lane.agentId),
        archivePath,
      });
      if (result.archived.length === 0) return;
      mkdirSync(path.dirname(archivePath), { recursive: true });
      appendFileSync(archivePath, `\n${archiveBlock(result.archived, new Date())}`);
      writeAtomic(lane.ledgerPath, result.ledger);
      const moved = result.archived.map((part) => `${part.heading} ${part.lines.length} 行`).join("，");
      logWatch(`台账瘦身 ${lane.id}：${moved}，${before.length} → ${result.ledger.length} 字`);
    });
  }
}

let decisionTimer: ReturnType<typeof setInterval> | null = null;
const decisionClockFile = () => path.join(watchDir(), "decision-clock.json");

/**
 * The user's 10-minute rule for 待用户拍板: an item left unanswered gets its recommendation, or the dispatcher is told
 * to ask the architect. The clock is on disk, so a reload neither restarts nor skips anyone's 10 minutes. Items rule 1.3
 * reserves for the user are left alone.
 */
async function timeOutDecisions(): Promise<void> {
  if (!watchPaseo || !existsSync(layout.statePath)) return;
  const replies = await exclusive(async () => {
    let clock: DecisionClock = {};
    try {
      clock = JSON.parse(readFileSync(decisionClockFile(), "utf8"));
    } catch {
      // First run: every open item starts its 10 minutes now.
    }
    const before = JSON.stringify(clock);
    const now = Date.now();
    const open = new Map<string, ReturnType<typeof summarizeLedger>["decisions"]>();
    const out: { laneAgentId: string; text: string }[] = [];
    for (const { lane } of allLanes(loadState(layout))) {
      if (lane.pendingHandoff || !existsSync(lane.ledgerPath)) continue;
      let ledger = readFileSync(lane.ledgerPath, "utf8");
      // What the stage has settled is closed here, so the user never has to press 「已过时」 for it.
      const stale = staleDecisions(summarizeLedger(ledger).decisions, parseStage(ledger));
      if (stale.length > 0) {
        for (const reason of new Set(stale.map((item) => item.reason))) {
          const lines = stale.filter((item) => item.reason === reason).map((item) => item.decision.line);
          ledger = markDecisions(ledger, lines, reason, new Date(now), "已过时");
        }
        writeAtomic(lane.ledgerPath, ledger);
        laneEvent(lane.id, "auto_stale", { detail: `${stale.length} 条：${stale[0].reason}` });
        logWatch(`会话线 ${lane.id} 有 ${stale.length} 条待拍板已过时，插件已关闭：${stale[0].reason}`);
      }
      const { decisions } = summarizeLedger(ledger);
      open.set(lane.id, decisions);
      const due = dueDecisions(clock, lane.id, decisions, now);
      if (due.recommend.length > 0) {
        writeAtomic(lane.ledgerPath, markDecisions(ledger, due.recommend.map((item) => item.line), "按推荐（10 分钟未答）", new Date(now), "自动"));
        out.push({ laneAgentId: lane.agentId, text: recommendReply(due.recommend) });
        laneEvent(lane.id, "auto_answered", { detail: `${due.recommend.length} 条 10 分钟未答，按推荐` });
        logWatch(`会话线 ${lane.id} 有 ${due.recommend.length} 条待拍板 10 分钟未答，已按推荐答复`);
      }
      if (due.architect.length > 0) {
        out.push({ laneAgentId: lane.agentId, text: architectReply(due.architect) });
        logWatch(`会话线 ${lane.id} 有 ${due.architect.length} 条待拍板 10 分钟未答且没有推荐，已让调度员问架构师`);
      }
    }
    pruneClock(clock, open);
    if (JSON.stringify(clock) !== before) {
      mkdirSync(watchDir(), { recursive: true });
      writeAtomic(decisionClockFile(), `${JSON.stringify(clock, null, 2)}\n`);
    }
    return out;
  });
  for (const reply of replies) await runWatch(async (state, io) => queueReply(state, reply, io));
}

let retiring = false;

/**
 * Archives the dispatcher's execution sessions that are done: idle for 5 minutes, and the dispatcher has been told how
 * the turn went. Without it they pile up as open sessions until the provider's limit on open sessions is reached.
 */
async function retireFinishedWorkers(): Promise<void> {
  const paseo = watchPaseo;
  if (!paseo || retiring || !existsSync(layout.statePath)) return;
  retiring = true;
  try {
    const laneAgents = new Set(allLanes(loadState(layout)).map(({ lane }) => lane.agentId));
    const result = await paseo.agents.list({ filter: { statuses: ["idle", "closed"], includeBackground: true }, page: { limit: 200 } });
    const workers = result.entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.labels[PARENT_LABEL] && (agent.labels[LABEL_DISPATCHER] || laneAgents.has(agent.labels[PARENT_LABEL])));
    if (workers.length === 0) return;
    const watch = loadWatch();
    const held = new Set([...Object.keys(watch.workers), ...watch.notices.map((notice) => notice.workerId)]);
    const now = Date.now();
    const ids = finishedWorkers(
      workers.map((agent) => {
        const at = Date.parse(agent.updatedAt ?? "");
        return { id: agent.id, status: agent.status, archived: Boolean(agent.archivedAt), updatedAt: Number.isNaN(at) ? null : at };
      }),
      held,
      now,
    );
    const done = await mapLimit(ids, ARCHIVE_CONCURRENCY, async (id) => {
      try {
        await paseo.agents.ref(id).archive();
        return true;
      } catch (error) {
        logWatch(`归档做完的执行会话失败 ${id}：${(error as Error).message}`);
        return false;
      }
    });
    const archived = done.filter(Boolean).length;
    if (archived > 0) logWatch(`做完 5 分钟的执行会话已归档 ${archived} 个，腾出位置`);
  } finally {
    retiring = false;
  }
}

export function keepWatching(paseo: PaseoApi): void {
  watchPaseo = paseo;
  if (watchTimer) return;
  watchStartedAt = Date.now();
  watchTimer = setInterval(() => void runWatch(scanAndMark), SCAN_MS);
  watchTimer.unref?.();
  cleanupTimer = setInterval(() => void autoCleanup(), CLEANUP_CHECK_MS);
  cleanupTimer.unref?.();
  decisionTimer = setInterval(() => {
    void timeOutDecisions().catch((error) => logWatch(`待拍板超时检查出错：${(error as Error).message}`));
    void tickQueue(watchPaseo).catch((error) => logWatch(`排队检查出错：${(error as Error).message}`));
    void slimLedgers().catch((error) => logWatch(`台账瘦身出错：${(error as Error).message}`));
    void retireFinishedWorkers().catch((error) => logWatch(`归档做完的执行会话出错：${(error as Error).message}`));
  }, DECISION_CHECK_MS);
  decisionTimer.unref?.();
  logWatch("巡检已启动");
  void runWatch(scanWorkers);
  // A minute in, so opening the page is not slowed by a cleanup that happens to be due.
  setTimeout(() => void autoCleanup(), 60_000).unref?.();
}

export function stopWatching(): void {
  if (watchTimer) clearInterval(watchTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (decisionTimer) clearInterval(decisionTimer);
  watchTimer = null;
  cleanupTimer = null;
  decisionTimer = null;
  watchPaseo = null;
}

/** Runs after the hook returns, so delivering a notice never holds up the turn that just ended. */
export function onWorkerTurnEnded(
  paseo: PaseoApi,
  agent: { id: string; parentAgentId: string | null; provider: string },
  outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string },
): void {
  keepWatching(paseo);
  const message = outcome.kind === "failed" ? outcome.error.message : undefined;
  void runWatch(async (state, io) => {
    await recordTurnEnd(
      state,
      { workerId: agent.id, parentAgentId: agent.parentAgentId, provider: agent.provider, outcome: { kind: outcome.kind, message } },
      io,
    );
    await scanWorkers(state, io);
  });
  if (agent.parentAgentId) archiveIfOrphaned(paseo, agent.id, agent.parentAgentId);
}

/** Called only by the user's explicit manual-start action, never by a lifecycle hook. */
export function startSuccessor(paseo: PaseoApi, input: { dispatcherId: string; laneId: string }) {
  return exclusive(async () => {
    const registry = requireRegistry();
    const dispatcher = requireDispatcher(registry, input.dispatcherId);
    const state = loadState(layout);
    const entry = stateOf(state, input.dispatcherId);
    const lane = laneOf(entry, input.laneId);
    const pending = lane?.pendingHandoff;
    if (!lane || !pending) throw new Error("没有待接班的交接，请先准备交接");
    if (!handoffWritten(pending.handoffPath)) throw new Error("交接文件还未写出，请等旧调度员完成");
    const status = await agentStatus(paseo, lane.agentId);
    if (status && BUSY.has(status)) throw new Error("旧调度员仍在执行，请等本轮结束再启动接班");
    const result = await launchLane(paseo, registry, dispatcher, lane, successorPrompt({
      handoffPath: pending.handoffPath,
      lane,
      fromAgentId: pending.fromAgentId,
      boardPath: layout.laneIndexPath(input.dispatcherId),
    }), `手动接班（前任 ${pending.fromAgentId.slice(0, 8)}）`);
    const after = loadState(layout);
    const target = laneOf(stateOf(after, input.dispatcherId), lane.id);
    if (target) target.pendingHandoff = null;
    saveState(layout, after);
    writeBoards(registry, after);
    return result;
  });
}

export function cancelHandoff(input: { dispatcherId: string; laneId: string }) {
  return exclusive(async () => {
    const state = loadState(layout);
    const entry = stateOf(state, input.dispatcherId);
    const lane = laneOf(entry, input.laneId);
    if (!lane?.pendingHandoff) return { ok: false };
    const file = lane.pendingHandoff.handoffPath;
    lane.pendingHandoff = null;
    entry.lastError = `已手动取消会话线 ${lane.id} 的换班，旧调度员继续在岗${
      handoffWritten(file) ? `；已写出的交接保留在 ${file}` : ""
    }`;
    saveState(layout, state);
    return { ok: true };
  });
}

export function dismissError(input: { dispatcherId: string }) {
  return exclusive(async () => {
    const state = loadState(layout);
    const entry = stateOf(state, input.dispatcherId);
    if (!entry.lastError) return { ok: false };
    entry.lastError = null;
    entry.pushableKept = [];
    saveState(layout, state);
    return { ok: true };
  });
}

/**
 * Forgets archived dispatcher sessions on the page. The sessions stay archived in Paseo; only this list lets go.
 * Kept: predecessors on a lane that is still open (the lane's archive finds its workers through them), and ended lanes
 * with a worker not yet archived (a worker finishing later finds its gone dispatcher through them).
 */

export function archive(paseo: PaseoApi, input: { dispatcherId: string; agentId: string }) {
  return exclusive(async () => {
    const state = loadState(layout);
    const entry = stateOf(state, input.dispatcherId);
    if (!entry.history.some((item) => item.agentId === input.agentId))
      throw new Error("只能归档该调度员历史里的会话");
    if (entry.lanes.some((lane) => lane.agentId === input.agentId))
      throw new Error("该会话还在会话线上，先换班或归档这条会话线");
    if (entry.lanes.some((lane) => lane.pendingHandoff?.fromAgentId === input.agentId))
      throw new Error("换班进行中，等接班完成后再归档");
    const result = await paseo.agents.ref(input.agentId).archive();
    retiredStatusCache.set(input.agentId, { at: Date.now(), status: "archived" });
    return result;
  });
}

/** Named outright: leaving the filter out returned none of the finished workers, so nothing cascaded. */
const EVERY_LIVE_STATUS = ["initializing", "idle", "running", "closed", "error"] as const;

/** Every unarchived session, running or not. Pages through because callers act on them, not just count. */
async function liveAgents(paseo: PaseoApi) {
  const found = [];
  let cursor: string | undefined;
  do {
    const result = await paseo.agents.list({
      filter: { statuses: [...EVERY_LIVE_STATUS], includeBackground: true, includeInternal: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    found.push(...result.entries.map((entry) => entry.agent));
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return found;
}

/** Everything these parents ever started. A finished worker may already be archived while its workspace stays in the sidebar. */
async function allChildren(paseo: PaseoApi, parents: ReadonlySet<string>, laneKeys: ReadonlySet<string> = new Set()) {
  const found = [];
  let total = 0;
  let cursor: string | undefined;
  do {
    const result = await paseo.agents.list({
      filter: { statuses: [...EVERY_LIVE_STATUS], includeArchived: true, includeBackground: true, includeInternal: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    total += result.entries.length;
    found.push(...result.entries.map((entry) => entry.agent).filter((agent) => parents.has(agent.labels[PARENT_LABEL]) || startedByLane(agent.labels, laneKeys)));
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  const archived = found.filter((agent) => agent.archivedAt).length;
  logWatch(`查子会话：含已归档共 ${total} 个，属于这 ${parents.size} 个调度员的 ${found.length} 个，其中已归档 ${archived} 个`);
  return found;
}

const GIT_CHECKS_AT_ONCE = 6;

/** What the last check found ignored in each directory, so the env files can be copied out just before one is deleted. */
const ignoredByDirectory = new Map<string, readonly string[] | null>();

/**
 * A worktree that is about to be deleted takes its `.env` files with it, and they never reach the remote. Copies them to
 * `backups/worktree-env` first, once per directory. Throws when the copy fails, or, with `strict`, when the scan of
 * ignored files never finished, so the caller leaves the workspace alone. Returns where the copy went, if there was one.
 */
function backupEnvBeforeRemoval(item: WorkspaceItem, done: Map<string, string | null>, strict: boolean): string | null {
  if (!item.removesDirectory) return null;
  if (done.has(item.directory)) return done.get(item.directory) ?? null;
  const ignored = ignoredByDirectory.get(item.directory);
  if (ignored === undefined || ignored === null) {
    if (strict) throw new Error("没查完被忽略的文件，没法确认 .env 是否需要备份");
    done.set(item.directory, null);
    return null;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  // By project and branch, so one branch's .env is found in one place; a detached worktree falls back to its folder name.
  const label = path.join(safeSegment(item.project), safeSegment(item.branch ?? path.basename(item.directory)), stamp);
  const result = backupEnvFiles(item.directory, envFilesOf(ignored), path.join(path.dirname(layout.home), "backups", "worktree-env"), label);
  if (result) logWatch(`${result.unchanged ? "已有相同的 .env 备份" : "备份 .env 到"} ${result.directory}：${result.files.join("、")}`);
  else if (envFilesOf(ignored).length > 0) logWatch(`${item.directory} 的 ${envFilesOf(ignored).join("、")} 是符号链接或已不存在，不用备份（链接指向的原文件不在被删的目录里）`);
  done.set(item.directory, result?.directory ?? null);
  return result?.directory ?? null;
}

/**
 * `only` limits the Git checks, which can take seconds per worktree, to the workspaces that matter.
 */
async function assessWorkspaces(paseo: PaseoApi, only?: ReadonlySet<string>): Promise<WorkspaceItem[]> {
  const registry = requireRegistry();
  const state = loadState(layout);
  const keep = new Set(registry.keep ?? []);
  const lanes = new Map(allLanes(state).map(({ lane }) => [lane.workspaceId, lane.id]));
  const homes = new Set(Object.values(state.dispatchers).map((entry) => entry.workspaceId));
  const sessions = new Map<string, { live: number; running: number }>();
  for (const agent of await liveAgents(paseo)) {
    if (!agent.workspaceId) continue;
    const counts = sessions.get(agent.workspaceId) ?? { live: 0, running: 0 };
    counts.live += 1;
    if (BUSY.has(agent.status)) counts.running += 1;
    sessions.set(agent.workspaceId, counts);
  }

  const everyWorkspace = [];
  let cursor: string | undefined;
  do {
    const result = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    everyWorkspace.push(...result.entries.filter((workspace) => !workspace.archivingAt));
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  const workspaces = only ? everyWorkspace.filter((workspace) => only.has(workspace.id)) : everyWorkspace;

  // Counted over every workspace, even when only some are being re-checked.
  const onDirectory = new Map<string, number>();
  for (const workspace of everyWorkspace) {
    onDirectory.set(workspace.workspaceDirectory, (onDirectory.get(workspace.workspaceDirectory) ?? 0) + 1);
  }

  // Many workspaces can sit on one worktree, and a check can take seconds.
  const checks = new Map<string, Promise<CheckoutFacts | null>>();
  const checkOnce = (directory: string) => {
    const pending = checks.get(directory) ?? checkoutFacts(directory);
    checks.set(directory, pending);
    return pending;
  };

  const items: WorkspaceItem[] = [];
  for (let start = 0; start < workspaces.length; start += GIT_CHECKS_AT_ONCE) {
    const batch = workspaces.slice(start, start + GIT_CHECKS_AT_ONCE).map(async (workspace) => {
      let checkout: CheckoutFacts | null = null;
      let checkoutError: string | null = null;
      try {
        checkout = await checkOnce(workspace.workspaceDirectory);
      } catch (error) {
        checkoutError = (error as Error).message.split("\n")[0];
      }
      ignoredByDirectory.set(workspace.workspaceDirectory, checkoutError ? null : (checkout?.ignored ?? null));
      const counts = sessions.get(workspace.id);
      const assessment = assessWorkspace(
        {
          id: workspace.id,
          kind: workspace.workspaceKind,
          worktreeSlug: workspace.worktreeSlug ?? null,
          pinned: !!workspace.pinnedAt,
          setupRunning: workspace.setupStatus === "running",
          laneId: lanes.get(workspace.id) ?? null,
          dispatcherHome: homes.has(workspace.id),
          liveSessions: counts?.live ?? 0,
          runningSessions: counts?.running ?? 0,
          sharedWith: (onDirectory.get(workspace.workspaceDirectory) ?? 1) - 1,
          checkout,
          checkoutError,
        },
        keep,
      );
      return {
        id: workspace.id,
        name: workspace.title ?? workspace.name,
        project: workspace.projectCustomName ?? workspace.projectDisplayName,
        directory: workspace.workspaceDirectory,
        branch: checkout?.branch ?? null,
        activityAt: workspace.activityAt,
        ...assessment,
      };
    });
    items.push(...(await Promise.all(batch)));
  }
  return items;
}

export async function listWorkspaces(paseo: PaseoApi) {
  return { workspaces: await assessWorkspaces(paseo) };
}

/** Only what the user ticked, and only if it still passes now. Archiving may delete a worktree, so nothing else qualifies. */
export function archiveWorkspaces(paseo: PaseoApi, input: { ids: string[] }) {
  return exclusive(() => archiveCheckedWorkspaces(paseo, input.ids));
}

/**
 * For workspaces held back only because their branch exists nowhere else: push each branch once (several workspaces
 * often share one worktree), then archive under the usual checks. Anything else in the way still blocks; a failed push
 * archives nothing on that directory.
 */
export function pushAndArchiveWorkspaces(paseo: PaseoApi, input: { ids: string[]; dispatcherId?: string }) {
  return exclusive(async () => {
    const items = await assessWorkspaces(paseo, new Set(input.ids));
    const pushed: string[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];
    const failedOn = new Map<string, string>();
    const doneOn = new Set<string>();
    for (const item of items) {
      // Set only when nothing but the push stands in the way.
      if (!item.pushTo || !item.branch || doneOn.has(item.directory) || failedOn.has(item.directory)) continue;
      try {
        await pushCheckoutBranch(item.directory, { branch: item.branch, remote: item.pushTo });
        doneOn.add(item.directory);
        pushed.push(`${item.branch} → ${item.pushTo}`);
        logWatch(`推送分支 ${item.branch} 到 ${item.pushTo}（${item.directory}），为归档工作区`);
      } catch (error) {
        failedOn.set(item.directory, (error as Error).message);
        logWatch(`推送失败 ${item.directory}：${(error as Error).message}`);
      }
    }
    const tryIds: string[] = [];
    for (const id of input.ids) {
      const item = items.find((entry) => entry.id === id);
      const failed = item && failedOn.get(item.directory);
      if (item && failed) skipped.push({ id, name: item.name, reason: failed });
      else tryIds.push(id);
    }
    const result = tryIds.length > 0 ? await archiveCheckedWorkspaces(paseo, tryIds) : { archived: [], skipped: [] };
    const allSkipped = [...skipped, ...result.skipped];
    // Started from the dispatcher's notice: it is resolved once nothing it listed is left.
    if (input.dispatcherId) {
      const state = loadState(layout);
      const entry = state.dispatchers[input.dispatcherId];
      if (entry) {
        const left = new Set(allSkipped.map((item) => item.id));
        entry.pushableKept = entry.pushableKept.filter((id) => left.has(id));
        if (entry.pushableKept.length === 0 && allSkipped.length === 0) entry.lastError = null;
        else if (allSkipped.length > 0)
          entry.lastError = `推送并归档后还有 ${allSkipped.length} 个工作区留着：\n${allSkipped.map((item) => `· ${item.name}：${item.reason}`).join("\n")}`;
        saveState(layout, state);
      }
    }
    return { pushed, archived: result.archived, skipped: allSkipped };
  });
}

async function archiveCheckedWorkspaces(paseo: PaseoApi, ids: readonly string[]) {
  const items = new Map((await assessWorkspaces(paseo, new Set(ids))).map((item) => [item.id, item]));
  const archived: string[] = [];
  const backedUp = new Map<string, string | null>();
  const skipped: { id: string; name: string; reason: string }[] = [];
  for (const id of ids) {
    const item = items.get(id);
    if (!item) {
      skipped.push({ id, name: id, reason: "工作区已不存在" });
      continue;
    }
    if (item.blockers.length > 0) {
      skipped.push({ id, name: item.name, reason: item.blockers.join("；") });
      continue;
    }
    try {
      backupEnvBeforeRemoval(item, backedUp, false);
    } catch (error) {
      skipped.push({ id, name: item.name, reason: `备份 .env 没成功，不删：${(error as Error).message}` });
      continue;
    }
    try {
      const result = await paseo.workspaces.archive(id);
      if (result.error) throw new Error(result.error);
      archived.push(id);
      logWatch(`归档工作区 ${id}（${item.name}）${item.removesDirectory ? `，带 worktree ${item.directory}` : ""}`);
    } catch (error) {
      skipped.push({ id, name: item.name, reason: (error as Error).message });
      logWatch(`归档工作区失败 ${id}：${(error as Error).message}`);
    }
  }
  return { archived, skipped };
}

/**
 * Finished workers go now. Running ones are not interrupted: `onWorkerTurnEnded` archives them when they stop.
 * Their workspaces follow, each only if it passes the same checks as the cleanup list: the sidebar rows are workspaces,
 * so archiving the sessions alone leaves them all behind.
 */
function newCascadeCounts() {
  return {
    archived: 0,
    running: 0,
    failed: 0,
    workspacesArchived: 0,
    workspacesKept: [] as { id: string; name: string; reason: string; pushable: boolean }[],
  };
}

/**
 * Archives each workspace that passes the cleanup checks now; the rest are listed with their reasons. Sharing a worktree
 * blocks nothing: Paseo deletes it only with its last workspace, and every member is checked before it goes.
 */
async function archiveSafeWorkspaces(paseo: PaseoApi, workspaceIds: ReadonlySet<string>, counts: ReturnType<typeof newCascadeCounts>) {
  if (workspaceIds.size === 0) return;
  // Re-checked now, so a session just archived no longer counts against its workspace.
  const items = await assessWorkspaces(paseo, workspaceIds);
  const backedUp = new Map<string, string | null>();
  for (const item of items) {
    const blockers = [...item.blockers];
    if (blockers.length > 0) {
      counts.workspacesKept.push({ id: item.id, name: item.name, reason: blockers.join("；"), pushable: !!item.pushTo && blockers.length === 1 });
      logWatch(`工作区未归档 ${item.id}（${item.name}）：${blockers.join("；")}`);
      continue;
    }
    try {
      backupEnvBeforeRemoval(item, backedUp, true);
    } catch (error) {
      const reason = `备份 .env 没成功，不删：${(error as Error).message}`;
      counts.workspacesKept.push({ id: item.id, name: item.name, reason, pushable: false });
      logWatch(`工作区未归档 ${item.id}（${item.name}）：${reason}`);
      continue;
    }
    try {
      const result = await paseo.workspaces.archive(item.id);
      if (result.error) throw new Error(result.error);
      counts.workspacesArchived += 1;
      logWatch(`连带归档工作区 ${item.id}（${item.name}）${item.removesDirectory ? `，带 worktree ${item.directory}` : ""}`);
    } catch (error) {
      counts.failed += 1;
      logWatch(`连带归档工作区失败 ${item.id}（${item.name}）：${(error as Error).message}`);
    }
  }
}

async function archiveChildren(
  paseo: PaseoApi,
  parents: ReadonlySet<string>,
  ownWorkspaceIds: readonly string[] = [],
  laneKeys: ReadonlySet<string> = new Set(),
) {
  const counts = newCascadeCounts();
  const children = await allChildren(paseo, parents, laneKeys);
  const workspaceIds = new Set<string>(ownWorkspaceIds);
  const idle = children.filter((child) => !(BUSY.has(child.status) && !child.archivedAt));
  counts.running += children.length - idle.length;
  for (const child of idle) if (child.workspaceId) workspaceIds.add(child.workspaceId);
  await mapLimit(idle.filter((child) => !child.archivedAt), ARCHIVE_CONCURRENCY, async (child) => {
    try {
      await paseo.agents.ref(child.id).archive();
      counts.archived += 1;
    } catch (error) {
      counts.failed += 1;
      logWatch(`连带归档失败 ${child.id}：${(error as Error).message}`);
    }
  });
  await archiveSafeWorkspaces(paseo, workspaceIds, counts);
  return counts;
}

/** Workers left behind by dispatchers archived earlier, from before the cascade or when it missed them. */
export async function archiveLeftoverWorkers(paseo: PaseoApi) {
  const plan = await exclusive(async () => {
    const state = loadState(layout);
    const ended = Object.values(state.dispatchers).flatMap((entry) =>
      entry.history.map((item) => item.agentId).filter((agentId) => endedLaneParents(state, agentId)),
    );
    const statuses = await Promise.all(ended.map((agentId) => agentStatus(paseo, agentId)));
    const parents = new Set(ended.filter((_, index) => statuses[index] === "archived"));
    return { parents, laneKeys: endedLaneKeys(state, parents) };
  });
  const counts = await archiveChildren(paseo, plan.parents, [], plan.laneKeys);
  logWatch(`补归档遗留：会话 ${counts.archived}，工作区 ${counts.workspacesArchived}，留下 ${counts.workspacesKept.length}，在跑 ${counts.running}，失败 ${counts.failed}`);
  return counts;
}

interface UnlandedBranch {
  project: string;
  branch: string;
  landing: string;
}

/**
 * Branches the lane's workers were on whose work is not on the lane's landing branch yet. A worker's branch is read
 * from its checkout, else from the task card's 预期分支 it was labelled with; a branch already deleted is not counted.
 */
async function unlandedBranches(
  paseo: PaseoApi,
  dispatcherId: string,
  entry: DispatcherState,
  lane: Lane,
  /** Only this requirement's workers; workers from before requirements were labelled count as R1. */
  req?: string | null,
): Promise<UnlandedBranch[]> {
  const projects = lane.projects.filter((project) => landingOf(project) && existsSync(project.path));
  if (projects.length === 0) return [];
  const parents = new Set([lane.agentId, ...entry.history.filter((item) => item.laneId === lane.id).map((item) => item.agentId)]);
  const workers = await allChildren(paseo, parents, new Set([`${dispatcherId}/${lane.id}`]));
  const seen = new Set<string>();
  const found: UnlandedBranch[] = [];
  for (const worker of workers) {
    if (req && (worker.labels[REQ_LABEL] ?? "R1") !== req) continue;
    const present = !!worker.cwd && existsSync(worker.cwd);
    const branch = (present ? await currentBranch(worker.cwd).catch(() => null) : null) ?? worker.labels[BRANCH_LABEL] ?? null;
    if (!branch) continue;
    for (const project of projects) {
      const landing = landingOf(project)!;
      if (branch === landing || seen.has(`${project.key}\0${branch}`)) continue;
      if (present && !(await sameRepository(worker.cwd, project.path))) continue;
      seen.add(`${project.key}\0${branch}`);
      // null: the branch is not in this repository, or is gone.
      if ((await branchLandsOn(project.path, branch, landing).catch(() => null)) === false) found.push({ project: project.name, branch, landing });
    }
  }
  return found;
}

/** Asked before the page offers 归档: what still has to be merged into the landing branch. */
export async function laneLanding(paseo: PaseoApi, input: { dispatcherId: string; laneId: string; req?: string }) {
  const registry = requireRegistry();
  const state = loadState(layout);
  const entry = stateOf(state, input.dispatcherId);
  const lane = laneOf(entry, input.laneId);
  if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
  return {
    landings: lane.projects.flatMap((project) => {
      const landing = landingOf(project);
      return landing ? [{ project: project.name, landing }] : [];
    }),
    unlanded: await unlandedBranches(paseo, input.dispatcherId, entry, lane, input.req),
    toIntegrate: await notIntegrated(registry, lane),
  };
}

const SHARED_BRANCH = /^(dev|develop|main|master|test|staging|release([/-].*)?)$/;

/** Where a project's finished work is merged, deployed from and pushed: the registry's choice, else a local dev. */
async function integrationOf(registry: Registry, project: LaneProject): Promise<string | null> {
  const registered = registry.projects.find((item) => item.id === project.key);
  if (registered && registered.integrationBranch !== undefined) return registered.integrationBranch;
  if (!project.path || !existsSync(project.path)) return null;
  return (await hasLocalBranch(project.path, "dev")) ? "dev" : null;
}

/** What a deploy ships and a push sends: the integration branch when there is one, else the landing branch. */
async function shipBranchOf(registry: Registry, project: LaneProject): Promise<string | null> {
  return (await integrationOf(registry, project)) ?? landingOf(project) ?? null;
}

/** Landing branches whose work is not on their project's integration branch yet. */
async function notIntegrated(registry: Registry, lane: Lane) {
  const found: { project: string; landing: string; integration: string }[] = [];
  for (const project of lane.projects) {
    const landing = landingOf(project);
    const integration = await integrationOf(registry, project);
    if (!landing || !integration || landing === integration || !existsSync(project.path)) continue;
    if ((await branchLandsOn(project.path, landing, integration).catch(() => null)) === false)
      found.push({ project: project.name, landing, integration });
  }
  return found;
}

/** 让调度员收口: the user's go-ahead to merge the lane's branches back into its landing branch. Push stays a separate ask. */
export function landLane(paseo: PaseoApi, input: { dispatcherId: string; laneId: string; req?: string }) {
  return exclusive(async () => {
    const state = loadState(layout);
    const entry = stateOf(state, input.dispatcherId);
    const lane = laneOf(entry, input.laneId);
    if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
    if (lane.pendingHandoff) throw new Error("换班进行中，等接班完成后再收口");
    const review = reviewViewOf(lane.review);
    const item = requirementOf(lane, input.req);
    if (reviewHolds(review, item?.id) && review?.state === "needed")
      throw new Error(`这条需求有敏感改动（${review.kinds.join("、")}），还没审查，没有让调度员合回。先点「派审查」；确定不用审查，点「不用审查」。`);
    if (reviewHolds(review, item?.id)) throw new Error("审查还在跑，等审查结束再合回");
    const status = await agentStatus(paseo, lane.agentId);
    if (status && BUSY.has(status)) throw new Error("该会话线正在执行，等本轮结束再收口");
    if (!status || status === "archived") throw new Error("该会话线的调度员已不在，没法让它收口");
    const unlanded = await unlandedBranches(paseo, input.dispatcherId, entry, lane, item?.id);
    const toIntegrate = await notIntegrated(requireRegistry(), lane);
    if (unlanded.length === 0 && toIntegrate.length === 0) return { sent: false, unlanded, toIntegrate };
    const others = item ? requirementsOf(lane).filter((other) => other.id !== item.id && !other.done) : [];
    const steps = [
      unlanded.length > 0
        ? `合回收口分支：\n${unlanded.map((item) => `- 「${item.project}」${item.branch} → ${item.landing}`).join("\n")}`
        : "",
      toIntegrate.length > 0
        ? `再在本地合进集成分支（第 13 节的合入 dev，用户这一下就是点头）：\n${toIntegrate
            .map((item) => `- 「${item.project}」${item.landing} → ${item.integration}`)
            .join("\n")}${unlanded.length > 0 ? "\n先做完上面的合回，再合这一步。" : ""}`
        : "",
    ].filter(Boolean);
    const message = [
      item
        ? `收口需求 ${item.id}「${item.text.slice(0, 60)}」：用户在调度员页面点了这一项的「同意合回」，同意下面这些本地合并。只合这一项的分支${
            others.length > 0 ? `，${others.map((other) => other.id).join("、")} 的分支不合` : ""
          }。不推送：推送由用户在页面点「推送」，你不用推。`
        : "收口：用户在调度员页面点了「同意合回」，同意下面这些本地合并。不推送：推送由用户在页面点「推送」，你不用推。",
      ...steps,
      "按顺序做：① 每个分支先确认已验收，没验收的先验收或上报，不合；② 先把目标分支的新提交合进来，有冲突停下报告，禁止 -X theirs；③ 每合完一步，在目标分支上跑一次该项目的回归测试，写进台账；④ 撤掉这条线临时分支的 worktree，再删本地临时分支（远程分支要删先列给用户）；收口分支本身先留着，部署验证后再按第 13 节清理。",
      item
        ? `做完说一句「${item.id} 已收口」，列出最终分支的 SHA 和测试结果；把台账「需求清单」里 ${item.id} 改成【待部署】，不需要部署就写【待推送】。`
        : "做完说一句「已收口」，列出最终分支的 SHA 和测试结果；把台账「- 阶段：」改成「待部署」，不需要部署就写「待推送」。",
    ].join("\n");
    await withStageThenSend(lane, "合回中", "用户在页面同意合回", () => paseo.agents.ref(lane.agentId).send(message), item?.id);
    const detail = [
      ...unlanded.map((item) => `${item.branch} → ${item.landing}`),
      ...toIntegrate.map((item) => `${item.landing} → ${item.integration}`),
    ].join("、");
    laneEvent(lane.id, "merge_ok", { detail: item ? `${item.id}：${detail}` : detail });
    logWatch(`让会话线 ${lane.id} 收口：${detail}`);
    return { sent: true, unlanded, toIntegrate };
  });
}

/** 催一下: the user asks a lane that went quiet to carry on from its ledger. */
export function nudge(paseo: PaseoApi, input: { dispatcherId: string; laneId: string }) {
  return exclusive(async () => {
    const lane = laneOf(stateOf(loadState(layout), input.dispatcherId), input.laneId);
    if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
    if (lane.pendingHandoff) throw new Error("换班进行中，等接班完成后再催");
    const status = await agentStatus(paseo, lane.agentId);
    if (status && BUSY.has(status)) return { sent: false };
    if (!status || status === "archived") throw new Error("该会话线的调度员已不在，没法催");
    await paseo.agents
      .ref(lane.agentId)
      .send(
        "催办：用户在调度员页面点了「催一下」，这条线有一阵没有进展了。按「开工与恢复」核对本线台账「在跑」的执行会话（paseo ls、状态文件），按台账「下一步」继续推进；卡在只有用户能定的事，就写进「待用户拍板」。先回一句现在卡在哪、接下来做什么，并更新台账的「阶段」和「下一步」两行。",
      );
    laneEvent(lane.id, "nudged");
    logWatch(`催会话线 ${lane.id}`);
    return { sent: true };
  });
}

/**
 * 派审查: asks the dispatcher for the one review §9 wants of a sensitive change, with what the plugin found. Only while
 * it is idle; the stage goes back to 验收 until the review is in.
 */
export function requestReview(paseo: PaseoApi, input: { dispatcherId: string; laneId: string }) {
  return exclusive(async () => {
    const lane = laneOf(stateOf(loadState(layout), input.dispatcherId), input.laneId);
    if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
    if (lane.pendingHandoff) throw new Error("换班进行中，等接班完成后再派审查");
    const review = reviewViewOf(lane.review);
    if (!review) throw new Error("插件没在这条需求的任务卡上认出敏感改动，不用审查");
    if (review.state === "running") throw new Error("审查已经在跑了");
    if (review.state === "done") throw new Error("这条需求已经审查过了，第 9 节不重审");
    const status = await agentStatus(paseo, lane.agentId);
    if (status && BUSY.has(status)) throw new Error("调度员正在执行，等这一轮结束再点「派审查」");
    if (!status || status === "archived") throw new Error("该会话线的调度员已不在，没法派审查");
    const message = [
      "审查：用户在调度员页面点了「派审查」。插件在这条需求的任务卡上认出了第 9 节的敏感改动，要审查一次；审查结束前页面不放行合回。",
      `认出的地方：\n${review.hits.map((hit) => `- ${hit.kind}：${hit.text}（卡「${hit.card}」）`).join("\n")}`,
      "用 dispatch_work 派 review 角色只读审查一次：审查对象写本线各分支当前 HEAD 的完整 SHA，范围是上面这些改动。问题清单写进本线台账「待用户拍板」交用户，不返工、不重审。",
      "审查结束、你核验过它的状态文件后，把台账「- 阶段：」改回「待合回」。",
    ].join("\n");
    await withStageThenSend(lane, "验收", "用户在页面要求审查", () => paseo.agents.ref(lane.agentId).send(message));
    laneEvent(lane.id, "review_requested", { detail: review.kinds.join("、") });
    logWatch(`让会话线 ${lane.id} 派审查：${review.kinds.join("、")}`);
    return { sent: true };
  });
}

/** 不用审查: the user decides a change the plugin found sensitive needs no review. Recorded in the ledger. */
export function waiveReview(input: { dispatcherId: string; laneId: string }) {
  return exclusive(async () => {
    const state = loadState(layout);
    const lane = laneOf(stateOf(state, input.dispatcherId), input.laneId);
    if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
    const review = reviewViewOf(lane.review);
    if (!review || review.state === "done" || review.state === "waived") return { ok: true };
    lane.review = { ...lane.review!, waived: { at: new Date().toISOString() }, covered: requirementIds(lane) };
    saveState(layout, state);
    const ledger = readText(lane.ledgerPath);
    if (ledger)
      writeAtomic(lane.ledgerPath, withRecentDone(ledger, `- 不审查：插件认出的敏感改动（${review.kinds.join("、")}），用户在页面点了「不用审查」`));
    laneEvent(lane.id, "review_waived", { detail: review.kinds.join("、") });
    logWatch(`会话线 ${lane.id} 用户选不审查：${review.kinds.join("、")}`);
    return { ok: true };
  });
}

/** Sets the ledger's 阶段 line. Call inside `exclusive`. A lane without a ledger yet has nothing to mark. */
/** Moves the 阶段 line, or with `req` that requirement's line in 需求清单 (the 阶段 line when the lane holds only one). */
function setLedgerStage(lane: Lane, word: StageWord, note?: string, req?: string | null): void {
  const before = readText(lane.ledgerPath);
  if (!before) return;
  const after = (req ? withRequirementWord(before, req, word) : null) ?? withStage(before, word, note);
  if (after !== before) writeAtomic(lane.ledgerPath, after);
}

/** The lane's requirements, as its ledger lists them now. */
function requirementsOf(lane: Lane) {
  return parseRequirements(readText(lane.ledgerPath) ?? "");
}

/** The listed requirement a page action names; null for the whole lane (no `req`, or a lane holding one). */
function requirementOf(lane: Lane, req: string | undefined) {
  if (!req) return null;
  const item = requirementsOf(lane).find((entry) => entry.id === req);
  if (!item) throw new Error(`这条线的需求清单里没有 ${req}，刷新后再试`);
  return item.synthetic ? null : item;
}

/**
 * Marks the stage, then tells the dispatcher. In that order: the message starts its turn, and a ledger it reads before
 * our write would come back without the new stage. A failed send puts the ledger back as it was.
 */
async function withStageThenSend(lane: Lane, word: StageWord, note: string, send: () => Promise<unknown>, req?: string | null): Promise<void> {
  const before = readText(lane.ledgerPath);
  setLedgerStage(lane, word, note, req);
  try {
    await send();
  } catch (error) {
    if (before) writeAtomic(lane.ledgerPath, before);
    throw error;
  }
}

/** The user's correction of where a requirement stands. The dispatcher reads it from the ledger like any other line. */
export function setStage(input: { dispatcherId: string; laneId: string; word: StageWord; req?: string }) {
  return exclusive(async () => {
    const lane = laneOf(stateOf(loadState(layout), input.dispatcherId), input.laneId);
    if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
    if (!existsSync(lane.ledgerPath)) throw new Error("这条线还没有台账");
    const item = requirementOf(lane, input.req);
    setLedgerStage(lane, input.word, "用户在页面改", item?.id);
    laneEvent(lane.id, "stage_set", { detail: item ? `${item.id}：${input.word}` : input.word });
    return { ok: true };
  });
}

/** What 部署 would ship: per project, the landing branch's tip; plus branches not merged into it yet. */
export async function deployInfo(paseo: PaseoApi, input: { dispatcherId: string; laneId: string }) {
  const registry = requireRegistry();
  const entry = stateOf(loadState(layout), input.dispatcherId);
  const lane = laneOf(entry, input.laneId);
  if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
  const projects = await Promise.all(
    lane.projects.map(async (project) => {
      const landing = landingOf(project) ?? null;
      const branch = await shipBranchOf(registry, project);
      const head = branch && existsSync(project.path) ? await branchHead(project.path, branch).catch(() => null) : null;
      const registered = registry.projects.find((item) => item.id === project.key);
      return {
        key: project.key,
        name: registered?.name ?? project.name,
        landing,
        branch,
        sha: head?.sha ?? null,
        subject: head?.subject ?? null,
        committedAt: head?.committedAt || null,
        targets: registered?.deployTargets ?? [],
      };
    }),
  );
  return {
    projects,
    unlanded: await unlandedBranches(paseo, input.dispatcherId, entry, lane),
    toIntegrate: await notIntegrated(registry, lane),
  };
}

const MIGRATION_TEXT = {
  yes: "含迁移：按第 12 节分两张卡，第一张只做核查、备份、构建和隔离演练后停，写待拍板等用户",
  no: "不含迁移",
  unknown: "用户不确定：先让部署工位只读核查有没有迁移，有就按含迁移分两张卡",
} as const;

/**
 * 部署 from the page. The click names the service and the full SHA, which is what rule §1.4 and §12 ask of the user,
 * so the dispatcher can dispatch the deploy card without asking again. Only commits on the lane's landing branch:
 * anything else is said in the dispatcher's conversation, where the user can explain it.
 */
export function deploy(
  paseo: PaseoApi,
  input: {
    dispatcherId: string;
    laneId: string;
    projectKey: string;
    services: string[];
    sha: string;
    migration: "yes" | "no" | "unknown";
    req?: string;
  },
) {
  return exclusive(async () => {
    const lane = laneOf(stateOf(loadState(layout), input.dispatcherId), input.laneId);
    if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
    if (lane.pendingHandoff) throw new Error("换班进行中，等接班完成后再部署");
    const status = await agentStatus(paseo, lane.agentId);
    if (status && BUSY.has(status)) throw new Error("该会话线正在执行，等本轮结束再部署");
    if (!status || status === "archived") throw new Error("该会话线的调度员已不在，没法让它部署");
    const project = lane.projects.find((item) => item.key === input.projectKey);
    if (!project) throw new Error("这条线没有这个项目");
    const landing = await shipBranchOf(requireRegistry(), project);
    if (!landing) throw new Error(`「${project.name}」没有收口分支，不知道该部署哪条分支上的提交`);
    const sha = input.sha.trim().toLowerCase();
    if (!(await onBranch(project.path, sha, landing)))
      throw new Error(`${sha.slice(0, 12)} 不在「${project.name}」的 ${landing} 上。页面只部署 ${landing} 上的提交；要部署别的，请在调度员对话里说明`);
    const head = await branchHead(project.path, landing).catch(() => null);
    const services = [...new Set(input.services.map((item) => item.trim()).filter(Boolean))];
    const item = requirementOf(lane, input.req);
    const shipped = `${item ? `${item.id} ` : ""}${services.join("、")} @ ${sha.slice(0, 8)}`;
    const message = [
      `部署${item ? `需求 ${item.id}「${item.text.slice(0, 60)}」` : ""}：用户在调度员页面点了「部署」并确认，这就是用户明确说「部署」（第 1 节第 4 条、第 12 节），不用再问。`,
      `项目：${project.name}（${project.path}）`,
      `服务：${services.join("、")}。只动这些，没点名的不连带。`,
      `完整 SHA：${sha}，${landing}${head?.sha === sha ? ` 的当前 HEAD「${head.subject}」` : " 上的提交"}。`,
      `迁移：${MIGRATION_TEXT[input.migration]}。`,
      "按第 12 节派部署工位（deploy）：任务卡写明服务、完整 SHA、是否含迁移、部署手册对应章节；状态文件记旧镜像与回滚点、新镜像 ID、验收结果、未验证项。验收失败按手册回滚并上报，不自行重试。",
      item
        ? `部署验收通过后，把台账「需求清单」里 ${item.id} 改成【待推送】，并在「最近完成」写上部署结果。推送由用户在页面点「推送」，你不用推。`
        : "部署验收通过后，把台账「- 阶段：」改成「待推送」并写上部署结果。推送由用户在页面点「推送」，你不用推。",
    ].join("\n");
    await withStageThenSend(lane, "部署中", shipped, () => paseo.agents.ref(lane.agentId).send(message), item?.id);
    laneEvent(lane.id, "deploy_ok", { detail: shipped });
    logWatch(`会话线 ${lane.id} 部署：${project.name} ${shipped}`);
    return { queued: true };
  });
}

/** What 推送 would send: per project, its ship branch against the remote, after a fetch. */
export async function pushInfo(input: { dispatcherId: string; laneId: string }) {
  const registry = requireRegistry();
  const lane = laneOf(stateOf(loadState(layout), input.dispatcherId), input.laneId);
  if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
  const projects = await Promise.all(
    lane.projects.map(async (project) => {
      const branch = await shipBranchOf(registry, project);
      const state = branch && existsSync(project.path) ? await branchPushState(project.path, branch).catch(() => null) : null;
      return {
        key: project.key,
        name: registry.projects.find((item) => item.id === project.key)?.name ?? project.name,
        branch,
        remote: state?.remote ?? null,
        ahead: state?.ahead ?? 0,
        behind: state?.behind ?? 0,
        commits: state?.commits ?? [],
        shared: !!branch && SHARED_BRANCH.test(branch),
        fetchError: state?.fetchError ?? (branch && !state ? `本机没有分支 ${branch}` : null),
      };
    }),
  );
  return { projects, toIntegrate: await notIntegrated(registry, lane) };
}

/**
 * 推送 from the page: the plugin pushes the ship branch itself, never forced, and only while the dispatcher is not
 * mid-turn (it may be merging into that branch). Recorded in the ledger; the stage moves to 已完成 once nothing of
 * the lane is left unpushed.
 */
export function push(paseo: PaseoApi, input: { dispatcherId: string; laneId: string; projectKey: string; req?: string }) {
  return exclusive(async () => {
    const registry = requireRegistry();
    const lane = laneOf(stateOf(loadState(layout), input.dispatcherId), input.laneId);
    if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
    const status = await agentStatus(paseo, lane.agentId);
    if (status && BUSY.has(status)) throw new Error("调度员正在执行（可能还在合并），等本轮结束再推送");
    const project = lane.projects.find((item) => item.key === input.projectKey);
    if (!project) throw new Error("这条线没有这个项目");
    const branch = await shipBranchOf(registry, project);
    if (!branch) throw new Error(`不知道「${project.name}」该推哪个分支`);
    const before = await branchPushState(project.path, branch);
    if (!before) throw new Error(`本机没有分支 ${branch}`);
    if (!before.remote) throw new Error(`「${project.name}」的仓库没有远端`);
    if (before.behind > 0)
      throw new Error(`远端的 ${branch} 有 ${before.behind} 个本机没有的提交，没有推。先让调度员把 ${before.remote}/${branch} 合进来、跑一次回归，再推`);
    if (before.ahead > 0) await pushBranch(project.path, branch, before.remote);
    const sha = (await branchHead(project.path, branch))?.sha ?? "";
    // The rest of the lane: once nothing is left to push, a lane waiting on 推送 is done.
    let leftover = false;
    for (const other of lane.projects) {
      if (other.key === project.key) continue;
      const otherBranch = await shipBranchOf(registry, other);
      const state = otherBranch && existsSync(other.path) ? await branchPushState(other.path, otherBranch).catch(() => null) : null;
      if (state && state.ahead > 0) leftover = true;
    }
    const text = readText(lane.ledgerPath);
    if (text) {
      let next = before.ahead > 0
        ? withRecentDone(
            text,
            `- 已推送：「${project.name}」${branch} @ ${sha.slice(0, 8)} → ${before.remote}/${branch}（${before.ahead} 个提交，用户在页面点的）`,
          )
        : text;
      const item = requirementOf(lane, input.req);
      if (item) {
        // A lane holding several: this requirement is done once pushed; the 阶段 line belongs to the one being worked on.
        if (!leftover && item.word === "待推送") next = withRequirementWord(next, item.id, "已完成") ?? next;
      } else {
        const stage = parseStage(next);
        if (!leftover && stage?.step === "推送") next = withStage(next, "已完成", `已推送 ${branch} @ ${sha.slice(0, 8)}`);
      }
      if (next !== text) writeAtomic(lane.ledgerPath, next);
    }
    laneEvent(lane.id, "pushed", { detail: `${project.name} ${branch} @ ${sha.slice(0, 8)}，${before.ahead} 个提交` });
    logWatch(`会话线 ${lane.id} 推送：${project.name} ${branch} → ${before.remote}（${before.ahead} 个提交）`);
    return { branch, remote: before.remote, sha, commits: before.ahead };
  });
}

/** For the sidebar badge: lanes with something only the user can move. Reads ledgers and asks Paseo, nothing else. */
export async function attention(paseo: PaseoApi) {
  const { registry } = loadRegistry(layout);
  const nameOf = (key: string, fallback: string) => registry?.projects.find((project) => project.id === key)?.name ?? fallback;
  const state = loadState(layout);
  const workerCounts = await workerCountsByParent(paseo);
  const pendingByAgent = pendingNoticesByAgent();
  const lanes = await Promise.all(
    allLanes(state).map(async ({ dispatcherId, lane }) => {
      const ledger = ledgerInfo(lane.ledgerPath);
      const parents = laneParents(lane, stateOf(state, dispatcherId).history);
      const needs = laneNeeds({
        agent: await agentSnapshot(paseo, lane.agentId),
        ledger,
        stage: ledger.stage,
        pendingHandoff: lane.pendingHandoff ? { written: handoffWritten(lane.pendingHandoff.handoffPath) } : null,
        runningWorkers: workerCounts ? [...parents].reduce((sum, parent) => sum + (workerCounts.get(parent)?.length ?? 0), 0) : null,
        pendingNotices: [...parents].reduce((sum, parent) => sum + (pendingByAgent.get(parent) ?? 0), 0),
        review: reviewViewOf(lane.review),
      });
      const projects = lane.projects.map((project) => nameOf(project.key, project.name)).join(" + ");
      return {
        laneId: lane.id,
        dispatcherId,
        agentId: lane.agentId,
        title: requirementTitle(lane.summary) ?? (projects || `会话线 ${lane.id}`),
        stage: ledger.stage,
        needs,
      };
    }),
  );
  return { waiting: lanes.filter((lane) => needsUser(lane.needs)).length, lanes };
}

// ---------------------------------------------------------------------------
// Queue: requirements waiting for a free lane. First in, first out; one that cannot start yet (its project is full)
// lets the next one by. Checked every minute, after a lane is released, and whenever the page sees a free slot.

const waited = (since: string, now = Date.now()) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(since)) / 60_000));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
};

function readQueuedImages(item: Queued): PromptImage[] {
  return item.images.map((image) => {
    if (!existsSync(image.file)) throw new Error(`排队时附的图不见了：${image.file}`);
    return { name: image.name, mimeType: image.mimeType, data: readFileSync(image.file).toString("base64") };
  });
}

/** Puts a requirement in the queue; it starts at once when a slot opened meanwhile. Checks the input like assign. */
export async function enqueue(
  paseo: PaseoApi,
  input: {
    paths: string[];
    dispatcherId: string;
    task?: string;
    acceptance?: string;
    branches?: Record<string, { name: string; base?: string }>;
    images?: PromptImage[];
  },
) {
  const images = input.images ?? [];
  checkImages(images);
  const queued = await exclusive(async () => {
    const registry = requireRegistry();
    const dispatcher = requireDispatcher(registry, input.dispatcherId);
    // Resolved now, so a missing folder or a bad branch fails while the user is still looking.
    const { held } = await resolveAssignment(registry, dispatcher, input.paths, input.branches);
    const state = loadState(layout);
    const id = newQueueId(state);
    const files = saveImages(layout, dispatcher.id, `排队-${id}`, images);
    state.queue = [
      ...(state.queue ?? []),
      {
        id,
        dispatcherId: dispatcher.id,
        paths: [...input.paths],
        task: input.task?.trim() || null,
        branches: input.branches && Object.keys(input.branches).length > 0 ? input.branches : undefined,
        images: files.map((file, index) => ({ file, name: images[index]?.name, mimeType: images[index]?.mimeType ?? "image/png" })),
        acceptance: input.acceptance?.trim() || null,
        queuedAt: new Date().toISOString(),
        problem: null,
        paused: false,
      },
    ];
    saveState(layout, state);
    logWatch(`需求排队 ${id}（第 ${state.queue.length} 个）：${held.map((project) => project.name).join("、")}`);
    return { id, position: state.queue.length };
  });
  keepWatching(paseo);
  await tickQueue(paseo);
  const started = !(loadState(layout).queue ?? []).some((item) => item.id === queued.id);
  return { ...queued, started };
}

/** 取消, 提到最前, 重试 on a queued requirement. */
export async function queueAction(paseo: PaseoApi, input: { id: string; action: "cancel" | "front" | "retry" }) {
  await exclusive(async () => {
    const state = loadState(layout);
    const queue = state.queue ?? [];
    const item = queue.find((entry) => entry.id === input.id);
    if (!item) throw new Error("这个需求已经不在排队里了（可能刚刚开始了）");
    if (input.action === "cancel") state.queue = queue.filter((entry) => entry.id !== input.id);
    else if (input.action === "front") state.queue = [item, ...queue.filter((entry) => entry.id !== input.id)];
    else state.queue = queue.map((entry) => (entry.id === input.id ? { ...entry, paused: false, problem: null } : entry));
    saveState(layout, state);
    logWatch(`排队 ${input.id}：${{ cancel: "取消", front: "提到最前", retry: "重试" }[input.action]}`);
  });
  if (input.action !== "cancel") await tickQueue(paseo);
  return { ok: true };
}

/** Starts every queued requirement that fits now, in order. */
export function tickQueue(paseo: PaseoApi | null): Promise<void> {
  if (!paseo) return Promise.resolve();
  return exclusive(async () => {
    const initial = loadState(layout);
    if ((initial.queue ?? []).length === 0) return;
    const { registry } = loadRegistry(layout);
    if (!registry) return;
    await settleArchivedLanes(paseo, registry, initial);
    const limits = limitsOf(registry);
    const outcome = new Map<string, { problem: string | null; paused?: boolean }>();
    const started: string[] = [];
    for (const item of initial.queue ?? []) {
      if (item.paused) continue;
      // Each start saves the state, so the next check reads it fresh.
      const state = loadState(layout);
      if (allLanes(state).length >= limits.sessions) break;
      const dispatcher = registry.dispatchers.find((entry) => entry.id === item.dispatcherId);
      if (!dispatcher) {
        outcome.set(item.id, { problem: `调度员 ${item.dispatcherId} 已不在登记里` });
        continue;
      }
      let plan: Awaited<ReturnType<typeof resolveAssignment>>;
      let route: ReturnType<typeof planRoute>;
      let images: PromptImage[];
      try {
        plan = await resolveAssignment(registry, dispatcher, item.paths, item.branches);
        if (queueWait(state, plan.held, limits)) {
          outcome.set(item.id, { problem: null });
          continue;
        }
        route = planRoute({ state, dispatcherId: dispatcher.id, projects: plan.held, limits, newLane: true, confirmIndependent: true });
        images = readQueuedImages(item);
      } catch (error) {
        outcome.set(item.id, { problem: (error as Error).message });
        continue;
      }
      try {
        const launched = await openNewLane(paseo, registry, dispatcher, state, {
          ...plan,
          task: item.task ?? undefined,
          acceptance: item.acceptance ?? undefined,
          shared: route.shared,
          images,
          savedImages: item.images.map((image) => image.file),
          reason: "排队后开始",
        });
        started.push(item.id);
        laneEvent(launched.laneId, "queued_start", { detail: `排队 ${waited(item.queuedAt)}` });
        logWatch(`排队 ${item.id} 开始：会话线 ${launched.laneId}，排了 ${waited(item.queuedAt)}`);
      } catch (error) {
        outcome.set(item.id, { problem: `开线失败：${(error as Error).message}`, paused: true });
        logWatch(`排队 ${item.id} 开线失败，暂停：${(error as Error).message}`);
      }
    }
    const fresh = loadState(layout);
    const before = JSON.stringify(fresh.queue ?? []);
    fresh.queue = (fresh.queue ?? [])
      .filter((item) => !started.includes(item.id))
      .map((item) => {
        const result = outcome.get(item.id);
        return result ? { ...item, problem: result.problem, paused: result.paused ?? item.paused } : item;
      });
    if (JSON.stringify(fresh.queue) !== before) saveState(layout, fresh);
  });
}

/** The queue as the page shows it, with why each one waits. Read-only and cheap: no Git, no Paseo calls. */
function queueView(registry: Registry, state: State) {
  const limits = limitsOf(registry);
  return (state.queue ?? []).map((item, index) => {
    const targets = item.paths.map((folder) => resolveTarget(registry, folder));
    const held = targets
      .filter((target) => !target.owner || target.owner === item.dispatcherId)
      .map((target) => laneProject(target));
    const wait = item.problem ?? queueWait(state, held, limits);
    return {
      id: item.id,
      dispatcherId: item.dispatcherId,
      dispatcherName: registry.dispatchers.find((entry) => entry.id === item.dispatcherId)?.name ?? item.dispatcherId,
      task: item.task,
      summary: summarize(item.task ?? undefined),
      projects: targets.map((target) => target.name),
      images: item.images.length,
      queuedAt: item.queuedAt,
      position: index + 1,
      waiting: wait ?? "有空位，马上开始",
      problem: item.problem,
      paused: item.paused,
      ready: !wait && !item.paused,
    };
  });
}

/** The page's 归档 on a lane: the session, the lane's seat and projects, and every worker the lane started. */
/**
 * Only the lane itself is archived under the lock. Its workers and workspaces go outside it: dozens of archives and git
 * checks held the lock long enough that the page's 5-second overview polls timed out behind it.
 */
export async function archiveLane(paseo: PaseoApi, input: { dispatcherId: string; laneId: string; force?: boolean }) {
  const released = await exclusive(async () => {
    const registry = requireRegistry();
    const state = loadState(layout);
    const entry = stateOf(state, input.dispatcherId);
    const lane = laneOf(entry, input.laneId);
    if (!lane) throw new Error(`没有会话线 ${input.laneId}`);
    if (lane.pendingHandoff) throw new Error("换班进行中，等接班完成或取消换班后再归档");
    if (!input.force) {
      const unlanded = await unlandedBranches(paseo, input.dispatcherId, entry, lane);
      if (unlanded.length > 0)
        throw new Error(`还有 ${unlanded.length} 个分支没合回收口分支：${unlanded.map((item) => `${item.branch} → ${item.landing}`).join("、")}。先让调度员收口，或确认不要后选「仍然归档」`);
    }
    const status = await agentStatus(paseo, lane.agentId);
    if (status && BUSY.has(status)) throw new Error("该会话线正在执行，等本轮结束再归档");
    // A session that is already gone or archived has nothing to archive; the lane still has to give back its seat.
    cascadeOwned.add(lane.agentId);
    try {
      if (status && status !== "archived") await paseo.agents.ref(lane.agentId).archive();
    } catch (error) {
      cascadeOwned.delete(lane.agentId);
      throw error;
    }
    retiredStatusCache.set(lane.agentId, { at: Date.now(), status: "archived" });
    releaseLane(entry, lane.id, new Date());
    saveState(layout, state);
    writeBoards(registry, state);
    return {
      laneId: lane.id,
      agentId: lane.agentId,
      parents: new Set(endedLaneParents(state, lane.agentId) ?? [lane.agentId]),
      // The lane's own workspace goes too: its session was just archived, and nothing else shares it.
      workspaceIds: lane.workspaceId ? [lane.workspaceId] : [],
    };
  });
  // The seat is free now; a waiting requirement need not wait for the cascade below.
  void tickQueue(paseo).catch((error) => logWatch(`排队检查出错：${(error as Error).message}`));
  try {
    const counts = await archiveChildren(
      paseo,
      released.parents,
      released.workspaceIds,
      new Set([`${input.dispatcherId}/${released.laneId}`]),
    );
    logWatch(`归档会话线 ${released.laneId}：会话 ${counts.archived}，工作区 ${counts.workspacesArchived}，留下 ${counts.workspacesKept.length}，在跑 ${counts.running}，失败 ${counts.failed}`);
    return counts;
  } finally {
    cascadeOwned.delete(released.agentId);
  }
}

/**
 * Archived anywhere in Paseo. Runs after the hook returns: archive() may wait on this hook while holding `exclusive`.
 * Unlike the page's button, only workers of archived sessions go; a sibling the user kept keeps its own.
 */
export function onSessionArchived(paseo: PaseoApi, agentId: string): void {
  if (cascadeOwned.has(agentId)) return;
  void (async () => {
    const plan = await exclusive(async () => {
      const { registry } = loadRegistry(layout);
      if (!registry || !existsSync(layout.statePath)) return null;
      const state = loadState(layout);
      await settleArchivedLanes(paseo, registry, state);
      const parents = endedLaneParents(state, agentId);
      if (!parents) return null;
      const statuses = await Promise.all(parents.map((parent) => agentStatus(paseo, parent)));
      const archived = parents.filter((_, index) => statuses[index] === "archived");
      const done = new Set([agentId, ...archived]);
      return { done, laneKeys: endedLaneKeys(state, done) };
    });
    if (!plan) return;
    const counts = await archiveChildren(paseo, plan.done, [], plan.laneKeys);
    logWatch(`${agentId} 已归档：会话 ${counts.archived}，工作区 ${counts.workspacesArchived}，留下 ${counts.workspacesKept.length}，在跑 ${counts.running}，失败 ${counts.failed}`);
    if (counts.workspacesKept.length > 0) await exclusive(async () => noteKeptWorkspaces(agentId, counts.workspacesKept));
  })().catch((error) => logWatch(`连带归档失败 ${agentId}：${(error as Error).message}`));
}

/**
 * Archiving from outside the page has nowhere to show a toast, so workspaces the cascade refused are put on the
 * dispatcher's page, where its other problems already show. Without this the reason lived only in the watch log.
 */
function noteKeptWorkspaces(agentId: string, kept: readonly { id: string; name: string; reason: string; pushable: boolean }[]): void {
  const { registry } = loadRegistry(layout);
  if (!registry) return;
  const state = loadState(layout);
  const entry = Object.values(state.dispatchers).find((item) => item.history.some((hit) => hit.agentId === agentId));
  if (!entry) return;
  const lines = kept.map((item) => `· ${item.name}：${item.reason}`);
  const pushable = kept.filter((item) => item.pushable).map((item) => item.id);
  const next =
    pushable.length === kept.length
      ? "提交只在本地，点「推送并归档」把分支推到远端（不强推）后一起归档。"
      : pushable.length > 0
        ? `其中 ${pushable.length} 个点「推送并归档」即可；其余处理掉原因后，到「工作区清理」里归档。`
        : "处理掉原因后，到「工作区清理」里归档。";
  entry.lastError = `会话 ${agentId.slice(0, 8)} 已归档，但有 ${kept.length} 个工作区没有跟着归档：\n${lines.join("\n")}\n${next}`;
  entry.pushableKept = pushable;
  saveState(layout, state);
  writeBoards(registry, state);
}

/** A worker that outlived its archived dispatcher goes as soon as it stops. */
function archiveIfOrphaned(paseo: PaseoApi, workerId: string, parentAgentId: string): void {
  void exclusive(async () => {
    if (!existsSync(layout.statePath)) return;
    if (!endedLaneParents(loadState(layout), parentAgentId)) return;
    if ((await agentStatus(paseo, parentAgentId)) !== "archived") return;
    await paseo.agents.ref(workerId).archive();
    logWatch(`${workerId} 已结束，它的调度员已归档，连带归档`);
  }).catch((error) => logWatch(`连带归档失败 ${workerId}：${(error as Error).message}`));
}

/**
 * A dispatcher session's tool call asks for permission: approve it, so the page isn't a wall of prompts.
 * `request` carries the command in `input` or `detail`; whichever it is, it is matched as text.
 */
export async function autoApprovePermission(
  paseo: PaseoApi,
  agent: { id: string; cwd: string },
  request: { id: string; kind: string; name: string; input?: unknown; detail?: unknown },
): Promise<void> {
  const { registry } = loadRegistry(layout);
  if (!registry) return;
  const text = JSON.stringify([request.name, request.input ?? null, request.detail ?? null]).slice(0, 4000);
  const decision = decideApproval({ kind: request.kind, inDispatcherDir: dispatcherForCwd(layout, registry, agent.cwd) !== null, text });
  if (decision !== "allow") {
    if (request.kind === "tool" && dispatcherForCwd(layout, registry, agent.cwd)) logWatch(`交给你确认 ${agent.id.slice(0, 8)}：${request.name}`);
    return;
  }
  try {
    await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
    logWatch(`自动同意 ${agent.id.slice(0, 8)}：${request.name}`);
  } catch (error) {
    logWatch(`自动同意失败 ${agent.id.slice(0, 8)}：${(error as Error).message}`);
  }
}

/** Adds the role bootstrap to agents created inside a dispatcher directory; other agents pass through. */
export function bootstrapFor(cwd: string): { prompt: string } | null {
  const { registry } = loadRegistry(layout);
  if (!registry) return null;
  const dispatcher = dispatcherForCwd(layout, registry, cwd);
  if (!dispatcher) return null;
  const result = syncRules(registry);
  if (!result.hashes[dispatcher.id])
    throw new Error(`调度规则未就绪，已阻止创建调度员会话：${result.problems.join("；")}`);
  const lane = launching.get(dispatcher.id);
  return { prompt: [bootstrapPrompt(dispatcher, layout, lane ? { id: lane.laneId, ledgerPath: lane.ledgerPath } : null), readFileSync(path.join(layout.dispatcherDir(dispatcher.id), "AGENTS.md"), "utf8")].join("\n\n") };
}

/**
 * Top-level agents opened in a dispatcher directory. Agents the plugin launches are already bound to
 * their lane. Any other one (a second chat in the dispatcher workspace, a worker launched without
 * --cwd, a successor the dispatcher spawned itself) only becomes a lane when the dispatcher has none
 * and the session limit allows; otherwise it is left out and the user is told.
 */
export function onAgentCreated(paseo: PaseoApi, agent: { id: string; cwd: string; parentAgentId: string | null }) {
  return exclusive(async () => {
    if (agent.parentAgentId !== null) return;
    const { registry } = loadRegistry(layout);
    if (!registry) return;
    const dispatcher = dispatcherForCwd(layout, registry, agent.cwd);
    if (!dispatcher) return;
    const state = loadState(layout);
    if (laneByAgent(state, agent.id)) return;
    const entry = stateOf(state, dispatcher.id);
    const limits = limitsOf(registry);
    const alive = await Promise.all(entry.lanes.map(async (lane) => ALIVE.has((await agentStatus(paseo, lane.agentId)) ?? "")));
    if (entry.lanes.length === 0 && allLanes(state).length < limits.sessions) {
      const spec = newLaneSpec(state, dispatcher.id, [], undefined);
      if (!existsSync(spec.ledgerPath)) writeAtomic(spec.ledgerPath, renderLedger(dispatcher, spec));
      const lane: Lane = {
        ...spec,
        agentId: agent.id,
        startedAt: new Date().toISOString(),
        rulesHash: null,
        pendingHandoff: null,
      };
      entry.lanes.push(lane);
      recordLaneAgent(entry, lane, agent.id, "在调度工作区新建", new Date());
      saveState(layout, state);
      writeBoards(registry, state);
      return;
    }
    entry.lastError = `调度目录里新建了会话 ${agent.id.slice(0, 8)}，没有让它成为会话线（已有 ${entry.lanes.length} 条${
      alive.some(Boolean) ? "在岗" : ""
    }）。它不会收到页面上的指派，确认无用后可归档；要多开一条线，请在调度员页面「新建会话线」或「指派任务」。`;
    saveState(layout, state);
  });
}

/** Paseo records the creating agent under this label, so it identifies every sub-agent however it was started. */
const PARENT_LABEL = "paseo.parent-agent-id";
/** The task card's 预期分支, so the lane's archive can tell which branches it opened even after their worktree is gone. */
const BRANCH_LABEL = "dispatch-center/branch";
/** Which requirement of the lane's 需求清单 a worker works on (R1, R2…). Absent: the lane's only one, or from before. */
const REQ_LABEL = "dispatch-center/req";

/**
 * Which requirement of the lane a card works on. Required once two or more are open, so their merges, deploys and
 * pushes can be told apart; a lane holding one needs none. A building card may not write the landing branch while
 * another requirement, verified, waits to be merged, deployed or pushed: the two would ship together.
 */
async function cardRequirement(paseo: PaseoApi, card: WorkCard, lane: Lane, roleId: string, callerAgentId: string): Promise<string | null> {
  // Only a building card without req needs to know who opened the turn; the timeline is not read otherwise.
  const typedByUser =
    stepForRole(roleId) === "开发" && !card.req ? (await typedOpener(paseo, callerAgentId).catch(() => null)) !== null : false;
  const result = requirementForCard(parseRequirements(readText(lane.ledgerPath) ?? ""), {
    req: card.req,
    roleId,
    branch: card.branch,
    landings: lane.projects.map((project) => landingOf(project)).filter((item): item is string => !!item),
    typedByUser,
  });
  if ("problem" in result) throw new Error(`任务卡不合格，没有派出：${result.problem}`);
  return result.req;
}

/** §1.4 counts running sub-agents across all lanes, including any started without dispatch_work. */
async function runningChildren(paseo: PaseoApi) {
  const result = await paseo.agents.list({
    filter: { statuses: ["initializing", "running"], includeBackground: true },
    page: { limit: 200 },
  });
  return result.entries.map((entry) => entry.agent).filter((agent) => agent.labels[PARENT_LABEL]);
}

/**
 * Running workers a dispatcher sent out: tagged with the dispatcher label (dispatch_work and the rules' `paseo run`
 * both set it), or started by a lane's dispatcher session. Sub-agents of the user's own sessions don't count
 * against the dispatcher's caps.
 */
async function runningWorkers(paseo: PaseoApi) {
  const laneAgents = new Set(allLanes(loadState(layout)).map(({ lane }) => lane.agentId));
  const workers = (await runningChildren(paseo)).filter(
    (agent) => agent.labels[LABEL_DISPATCHER] || laneAgents.has(agent.labels[PARENT_LABEL]),
  );
  return {
    total: workers.length,
    claude: workers.filter((agent) => agent.provider.toLowerCase().includes("claude")).length,
  };
}

/**
 * Answers open decisions from the page. The ledger is ticked right away, so the count drops at once; the answer
 * reaches the lane's dispatcher through the notice queue, which waits until it is idle instead of interrupting it.
 */
export async function answerDecisions(
  paseo: PaseoApi,
  input: { dispatcherId: string; laneId: string; lines: string[]; answer: string },
) {
  const lane = await exclusive(async () => {
    const found = stateOf(loadState(layout), input.dispatcherId).lanes.find((item) => item.id === input.laneId);
    if (!found) throw new Error("这条会话线已经不在了");
    const ledger = existsSync(found.ledgerPath) ? readFileSync(found.ledgerPath, "utf8") : "";
    writeAtomic(found.ledgerPath, markDecisions(ledger, input.lines, input.answer, new Date()));
    laneEvent(found.id, "answered", { detail: `${input.lines.length} 条：${input.answer.trim().slice(0, 120)}` });
    return found;
  });
  const items = input.lines.map((line) => `- ${line.replace(/^\s*(?:[-*]|\d+\.)\s+\[ \]\s*/, "")}`);
  const text = [...items, `用户答复：${input.answer.trim()}`].join("\n");
  keepWatching(paseo);
  await runWatch(async (state, io) => queueReply(state, { laneAgentId: lane.agentId, text }, io));
  void runWatch(scanWorkers);
  return { queued: true };
}

/** The dispatch_work tool's description for a session in a dispatcher directory; null for every other session. */
export function workToolDescription(cwd: string): string | null {
  const { registry } = loadRegistry(layout);
  if (!registry || !dispatcherForCwd(layout, registry, cwd)) return null;
  return [
    "派一个执行会话。你只判断角色并写理由、交齐任务卡字段；模型、模式、thinking、额度预检、并行上限、建工作区、记台账由插件完成。",
    "卡要短：插件会在卡末自动追加「必守」（核对工作区根/分支/HEAD、读代码黑名单、写完状态文件就停、禁止再开子 agent），各栏不要再写这些；「改与不改」最多 3 行只写范围；「其他」只写前面没出现的；一件事只在一栏里说一次。在已有提交上复跑、验收、续做时把 SHA 填进 head，插件派出前会核对，不用在正文里再写核对 SHA。插件不改你写的字，只在派单结果里提示哪里可以删。",
    "角色表：",
    renderRoleGuide(rolesOf(registry)),
  ].join("\n");
}

const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** §5's reminder when a card opens yet another worktree for a lane that already holds several. Never blocks a dispatch. */
async function laneWorktreeNote(lane: Lane, directory: string): Promise<string | null> {
  try {
    const linked = await linkedWorktrees(directory);
    if (linked.length === 0) return null;
    const archive = path.join(path.dirname(lane.ledgerPath), "archive", path.basename(lane.ledgerPath));
    return worktreeNote(directory, linked, laneWorktrees(linked, [readText(lane.ledgerPath), readText(archive)]));
  } catch (error) {
    logWatch(`查 worktree 数出错：${(error as Error).message}`);
    return null;
  }
}

/**
 * Lanes on one project must not touch each other's files, and the plugin checks it rather than trusting the prompt.
 * For a card that writes, on a project another lane also holds: this lane's 改动范围 must already be written (the
 * read-only 拆分 pre-check comes first), and the card's 点名文件 must not overlap any other lane's 改动范围.
 * Returns the card's files, relative to the repository, for the plugin to add to this lane's 改动范围.
 */
async function scopeGate(card: WorkCard, roleName: string, found: { lane: Lane }, state: State, directory: string): Promise<string[]> {
  if (READ_ONLY_ROLES.has(card.role)) return [];
  const projects: LaneProject[] = [];
  for (const project of found.lane.projects) {
    if (!project.path) continue;
    const root = canonical(project.path);
    if (isInside(root, directory) || (await sameRepository(root, directory).catch(() => false))) projects.push(project);
  }
  const own = readText(found.lane.ledgerPath);
  const others = projects.flatMap((project) =>
    holdersOf(state, project.key, found.lane.id).map((holder) => ({ project, holder, ledger: readText(holder.lane.ledgerPath) })),
  );
  const roots = [
    directory,
    ...projects.map((project) => canonical(project.path)),
    ...runningCwds(own),
    ...others.flatMap((item) => runningCwds(item.ledger)),
  ];
  const mine = scopePaths(card.files, roots);
  if (others.length === 0 || card.overlapOk) return mine;

  const label = (lane: Lane) => `会话线 ${lane.id}${lane.summary ? `（${lane.summary.slice(0, 30)}）` : ""}`;
  const names = [...new Set(others.map((item) => `「${item.project.name}」`))].join("、");
  const lanes = [...new Map(others.map((item) => [item.holder.lane.id, item.holder.lane])).values()];
  const steps = `在本线台账「待用户拍板」写 \`- [ ] ${CONFLICT_MARK}…\`（重合的文件、两边各要做什么、可选做法），结束本轮等用户，插件不会替用户自动答复这一条。用户允许重合后，把用户原话写进任务卡 overlapOk 再派`;
  const stop = `停手：${steps}`;
  if (scopePaths(scopeText(own), roots).length === 0)
    throw new Error(
      [
        `${names}还有${lanes.map(label).join("、")}在做，本线台账「改动范围」还没写，「${roleName}」卡没有派出。`,
        `先用 dispatch_work 派 split（拆分）做只读预检：读本线需求和对方台账（${lanes.map((lane) => lane.ledgerPath).join("、")}）的「改动范围」，列出本线要改的文件（相对仓库根的路径），逐条判断和对方有没有交叉；方向未定就派 architect。`,
        `预检回来后把文件写进本线「改动范围」再派施工。有交叉就${steps}。`,
      ].join("\n"),
    );
  if (mine.length === 0)
    throw new Error(`${names}还有${lanes.map(label).join("、")}在做，这张卡「点名文件」没写出路径，没法核对是否重合，没有派出。写出要改的文件（相对仓库根）再派；确实说不清就${steps}。`);
  const clashes = lanes.flatMap((lane) => {
    const theirs = scopePaths(scopeText(others.find((item) => item.holder.lane.id === lane.id)?.ledger ?? ""), roots);
    const pairs = overlapping(mine, theirs);
    return pairs.length > 0 ? [{ lane, pairs }] : [];
  });
  if (clashes.length > 0)
    throw new Error(
      [
        "和别的会话线的改动范围重合，没有派出：",
        ...clashes.map(
          ({ lane, pairs }) =>
            `- ${label(lane)}，台账 ${lane.ledgerPath}：${pairs
              .slice(0, 6)
              .map(([a, b]) => (a === b ? `\`${a}\`` : `\`${a}\` ↔ \`${b}\``))
              .join("、")}${pairs.length > 6 ? ` 等 ${pairs.length} 处` : ""}`,
        ),
        `${stop}。`,
      ].join("\n"),
    );
  return mine;
}

/** The lane's requirement IDs from its ledger's 需求清单 (R1 alone when it has none). */
function requirementIds(lane: Lane): string[] {
  return parseRequirements(readText(lane.ledgerPath) ?? "").map((item) => item.id);
}

/**
 * The 点名文件 of cards dispatch_work sent out since the plugin loaded. The watch state keeps them too, but it is
 * written in the background, so a card sent a moment ago may not be there yet.
 */
const cardFiles = new Map<string, { title: string; files: string[] }>();

/**
 * §1.6 inside one lane: two cards running at once must not name the same files. Only cards still running count;
 * one that finished hands its files to the next card. A card the plugin knows no files for is not checked.
 */
async function laneGate(paseo: PaseoApi, laneId: string, mine: string[]): Promise<void> {
  const running = (await runningChildren(paseo)).filter((agent) => agent.labels["dispatch-center/lane"] === laneId);
  if (running.length === 0) return;
  const known = loadWatch().known ?? {};
  const cards = running.flatMap((agent) => {
    const card = cardFiles.get(agent.id) ?? (known[agent.id]?.files ? { title: known[agent.id].title, files: known[agent.id].files! } : null);
    return card ? [{ id: agent.id, title: card.title ?? agent.title ?? null, files: card.files }] : [];
  });
  const clashes = laneClashes(mine, cards);
  if (clashes.length === 0) return;
  throw new Error(
    [
      "和本线正在跑的卡点名了同样的文件，没有派出（第 1 节第 6 条：不改同一批文件才能并行）：",
      ...clashes.map(
        ({ id, title, pairs }) =>
          `- ${title ? `「${title}」` : ""}${id}：${pairs
            .slice(0, 6)
            .map(([a, b]) => (a === b ? `\`${a}\`` : `\`${a}\` ↔ \`${b}\``))
            .join("、")}${pairs.length > 6 ? ` 等 ${pairs.length} 处` : ""}`,
      ),
      `等它结束、验收后再派这张；要是本该是同一件事，合成一张卡。确实要同时改，在本线台账「待用户拍板」写 \`- [ ] ${CONFLICT_MARK}…\` 等用户，用户允许后把原话写进任务卡 overlapOk 再派。`,
    ].join("\n"),
  );
}

/**
 * Keeps what a dispatched card shows of §9's sensitive changes, and the review cards, on the lane. Returns what the
 * dispatcher should hear about it. Call inside `exclusive`.
 */
function recordReview(callerAgentId: string, card: WorkCard, roleId: string, agentId: string, declaredWritesCode?: boolean): string | null {
  const hits = writesCode(roleId, declaredWritesCode) ? sensitiveHits(card) : [];
  if (hits.length === 0 && roleId !== "review") return null;
  const state = loadState(layout);
  const lane = laneByAgent(state, callerAgentId)?.lane;
  if (!lane) return null;
  const now = new Date().toISOString();
  // A requirement added after the last review: its sensitive cards start a review round of their own.
  const newRound = hits.length > 0 && needsNewRound(lane.review, requirementIds(lane));
  if (newRound) lane.review = withNewRound(lane.review!, now);
  const before = reviewViewOf(lane.review);
  lane.review = withDispatchRecord(lane.review, {
    card: card.title,
    at: now,
    hits,
    reviewer: roleId === "review" ? agentId : null,
  });
  saveState(layout, state);
  const after = reviewViewOf(lane.review);
  if (hits.length === 0) return before && before.state !== "done" ? "这张审查卡算本线敏感改动的审查，它结束后页面放行合回。" : null;
  if (!before) laneEvent(lane.id, "review_needed", { title: card.title, detail: after?.kinds.join("、") ?? null });
  const found = hits.map((hit) => `${hit.kind}：${hit.text}`).join("；");
  if (newRound)
    return `插件认出这张卡是第 9 节的敏感改动（${found}）。本线上次审查之后「需求清单」里加了新需求，新需求要单独审查一次：验收时派 review 角色只读审查，问题清单交用户；审查结束前页面不放行合回，所以审查结束前不要写「待合回」。`;
  if (after?.state === "done") return `插件认出这张卡有敏感改动（${found}），本线已经审查过，第 9 节不重审。`;
  if (after?.state === "waived") return `插件认出这张卡有敏感改动（${found}），用户已在页面选了不审查。`;
  return `插件认出这张卡是第 9 节的敏感改动（${found}）。这条需求验收时要派 review 角色只读审查一次，问题清单交用户；审查结束前页面不放行合回，所以审查结束前不要写「待合回」。`;
}

export function dispatchWork(paseo: PaseoApi, card: WorkCard, callerAgentId: string) {
  return exclusive(async () => {
    const registry = requireRegistry();
    const found = laneByAgent(loadState(layout), callerAgentId);
    if (!found) throw new Error("当前会话不是在岗的调度员会话线，不能派单");
    const roles = rolesOf(registry);
    const role = roles.find((item) => item.id === card.role);
    if (!role) throw new Error(`没有角色「${card.role}」。可选：${roles.map((item) => item.id).join("、")}`);
    const problems = checkCard(card, layout.home);
    if (problems.length > 0) throw new Error(`任务卡不合格，没有派出：${problems.join("；")}`);

    const [profiles, catalog] = await Promise.all([loadProfiles(paseo).catch(() => []), tryCatalog(paseo)]);
    const quotas = await loadQuotas(registry.quotaUrl);
    const cooldowns = loadCooldowns();
    const { chosen, skipped } = pickCandidate(role, profiles, card.avoid ?? [], catalog, (config) => {
      const cooling = activeCooldown(cooldowns, config.family, Date.now());
      if (cooling) return cooldownReason(cooling);
      if (!quotas) return null;
      const quota = quotaState(quotas, config.family, config.provider, registry.quotaStopBelow);
      return quota.blocked ?? (writesCode(role.id, role.writesCode) ? quota.stopped : null);
    });
    const lowQuota = chosen && quotas ? quotaState(quotas, chosen.family, chosen.provider).low : null;
    const passedOver = skipped.map((item) => `${item.label}：${item.reason}`).join("；");
    if (!chosen) throw new Error(`角色「${role.name}」的备选都不可用，没有派出，请上报用户。${passedOver}`);
    const statusProblem = statusFileProblem(card.statusFile, chosen.provider, registry.readOnlyDirs);
    if (statusProblem) throw new Error(`任务卡不合格，没有派出：${statusProblem}`);

    const limits = limitsOf(registry);
    const running = await runningWorkers(paseo);
    if (running.total >= limits.agents)
      throw new Error(`在跑的执行会话已有 ${running.total} 个，到上限 ${limits.agents}，没有派出。结束本轮排队，有空位再派`);
    if (chosen.family === "claude" && running.claude >= limits.claudeAgents)
      throw new Error(`在跑的 Claude 已有 ${running.claude} 个，到上限 ${limits.claudeAgents}，没有派出。结束本轮排队，有空位再派`);

    const directory = canonical(expandHome(card.cwd));
    const source = await directoryWorkspaceSource({
      directory,
      projects: (await paseo.projects.list()).projects,
      registry,
      dispatcherId: found.dispatcherId,
      laneProjects: found.lane.projects,
    });
    // Checked here, so a card on the wrong commit never starts a worker that would only stop and report it.
    if (card.head) {
      const actual = await headCommit(directory);
      if (!actual || !actual.toLowerCase().startsWith(card.head.toLowerCase()))
        throw new Error(`任务卡不合格，没有派出：预期 HEAD ${card.head}，${card.cwd} 实际是 ${actual?.slice(0, 12) ?? "不是 Git 目录"}`);
    }
    const requirement = await cardRequirement(paseo, card, found.lane, role.id, callerAgentId);
    const claimed = await scopeGate(card, role.name, found, loadState(layout), directory);
    if (claimed.length > 0 && !card.overlapOk) await laneGate(paseo, found.lane.id, claimed);
    // Read before the ledger gets this card's row, which would make the new worktree look like an old one.
    const worktreeWarning = await laneWorktreeNote(found.lane, directory);
    // The dispatcher's own config describes the dispatcher (only triage, never test), not the worker borrowing it.
    const dispatcherProfiles = new Set(
      [registry.defaultProfileId, ...registry.dispatchers.map((item) => item.profileId)].filter(Boolean) as string[],
    );
    const profileNotes = chosen.profileId && dispatcherProfiles.has(chosen.profileId) ? undefined : chosen.notes;
    const workPrompt = renderWorkPrompt(card, role, registry.workerMust ?? [], profileNotes);
    const workspace = await paseo.workspaces.create({ source, title: card.title });
    let agentId: string;
    try {
      const agent = await workspace.agents.create({
        config: {
          provider: chosen.provider,
          modeId: chosen.modeId,
          thinkingOptionId: chosen.thinkingOptionId,
          featureValues: chosen.featureValues,
        },
        title: card.title,
        prompt: workPrompt,
        parent: callerAgentId,
        labels: {
          [WORK_ROLE_LABEL]: role.id,
          [LABEL_DISPATCHER]: found.dispatcherId,
          "dispatch-center/lane": found.lane.id,
          [BRANCH_LABEL]: card.branch,
          ...(requirement ? { [REQ_LABEL]: requirement } : {}),
        },
      });
      agentId = agent.id;
    } catch (error) {
      await paseo.workspaces.archive(workspace.id).catch(() => undefined);
      throw new Error(`拉起执行会话失败，没有派出：${(error as Error).message}`);
    }
    if (claimed.length > 0) cardFiles.set(agentId, { title: card.title, files: claimed });
    const dispatched = {
      id: agentId,
      provider: chosen.provider,
      parentAgentId: callerAgentId,
      title: card.title,
      statusFile: card.statusFile,
      files: claimed,
    };
    void runWatch(async (state, io) => recordDispatched(state, dispatched, io));
    laneEvent(found.lane.id, "dispatched", { workerId: agentId, title: card.title });
    const reviewNote = recordReview(callerAgentId, card, role.id, agentId, role.writesCode);
    // The dispatcher used to write this row itself, and lost it whenever its turn was cut off mid-dispatch.
    let ledgerNote = "把这个会话写进本线台账。";
    try {
      const ledgerPath = found.lane.ledgerPath;
      const project =
        found.lane.projects.find((item) => isInside(canonical(item.path), directory))?.name ?? workspace.id;
      const before = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
      let text =
        withRunningRow(before, {
          agentId,
          workspaceId: workspace.id,
          project,
          cwd: directory,
          branch: card.branch,
          statusFile: card.statusFile,
        }) ?? before;
      if (claimed.length > 0) text = withScopePaths(text, claimed, card.title);
      const current = parseStage(text);
      const movedTo = stageAfterDispatch(current, role.id);
      const reopened = movedTo && current && !(["计划", "开发", "验收"] as string[]).includes(current.step) ? current.word : null;
      if (movedTo) text = withStage(text, movedTo, reopened ? `之前是${reopened}，又派了开发卡` : undefined);
      // The card's own requirement moves along its line the same way.
      const row = requirement ? parseRequirements(text).find((item) => item.id === requirement && !item.synthetic) : undefined;
      const rowMoved = row ? stageAfterDispatch(requirementStage(row), role.id) : null;
      if (row && rowMoved) text = withRequirementWord(text, row.id, rowMoved) ?? text;
      if (text !== before) writeAtomic(ledgerPath, text);
      ledgerNote = `插件已把它写进本线台账「在跑执行会话」${
        claimed.length > 0 ? "，点名文件也记进了「改动范围」" : ""
      }${movedTo ? `，阶段改成了「${movedTo}」` : ""}，你不用再写；核验后更新阶段和下一步。${
        reopened
          ? `本线原来是「${reopened}」：这张卡要是在做一个新需求，在台账「需求清单」加一行 \`- R<下一个号>【开发】一句话需求\`，原来那项标成它实际的阶段；是返工就不用加。`
          : ""
      }`;
    } catch (error) {
      ledgerNote = `插件没能写进台账（${(error as Error).message}），请你写进本线台账。`;
    }
    return {
      agentId,
      workspaceId: workspace.id,
      role: role.id,
      config: chosen.label,
      skipped,
      text: [
        `已派出 ${agentId}，角色「${role.name}」，配置 ${chosen.label}。`,
        passedOver ? `跳过的备选：${passedOver}。` : null,
        lowQuota ? `注意：${lowQuota}。` : null,
        ledgerNote,
        reviewNote,
        worktreeWarning,
        cardFeedback({ 任务: card.task, 改与不改: card.scope, 其他: card.notes }, workPrompt),
        "派完结束本轮，等插件的执行会话状态通知，不用建心跳。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });
}

/** The role table and dispatcher launch configs, resolved against the real Agent configs and providers right now. */
export async function rolesView(paseo: PaseoApi) {
  const registry = requireRegistry();
  let profiles: Profile[] = [];
  let profilesError: string | null = null;
  try {
    profiles = await loadProfiles(paseo);
  } catch (error) {
    profilesError = (error as Error).message;
  }
  let catalog: ProviderCatalog | null = null;
  let catalogError: string | null = null;
  try {
    catalog = await loadCatalog(paseo);
  } catch (error) {
    catalogError = (error as Error).message;
  }
  const used = new Set<string>();
  const view = (resolved: ResolvedConfig | { problem: string }, fallback: string) => {
    if ("problem" in resolved) return { label: fallback, ok: false, problem: resolved.problem };
    if (resolved.profileId) used.add(resolved.profileId);
    return { label: resolved.label, ok: true, problem: null };
  };
  const roles = rolesOf(registry).map((role) => {
    const auto =
      role.candidates.length === 0
        ? (() => {
            const chosen = autoConfig(catalog);
            return chosen
              ? { label: chosen.label, ok: true, problem: null }
              : { label: "自动", ok: false, problem: catalog ? "没有就绪的 provider" : "读不到 provider 列表" };
          })()
        : null;
    return {
      id: role.id,
      name: role.name,
      when: role.when,
      must: role.must ?? [],
      auto,
      candidates: role.candidates.map((candidate) => ({
        ...view(resolveCandidate(candidate, profiles, catalog), candidate.profile ?? candidate.provider ?? "?"),
        source: candidate as CandidateInput,
      })),
    };
  });
  const dispatchers = await Promise.all(
    registry.dispatchers.map(async (dispatcher) => {
      let launch: { label: string; ok: boolean; problem: string | null };
      try {
        launch = view(await resolveLaunch(paseo, registry, dispatcher, profiles), describeLaunch(registry, dispatcher));
      } catch (error) {
        launch = { label: describeLaunch(registry, dispatcher), ok: false, problem: (error as Error).message };
      }
      return {
        id: dispatcher.id,
        name: dispatcher.name,
        source: {
          provider: dispatcher.provider ?? null,
          profileId: dispatcher.profileId ?? registry.defaultProfileId ?? null,
          modeId: dispatcher.modeId ?? null,
          thinkingOptionId: dispatcher.thinkingOptionId ?? null,
        },
        launch,
      };
    }),
  );
  const limits = limitsOf(registry);
  return {
    roles,
    customRoles: Boolean(registry.roles),
    dispatchers,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name ?? profile.id,
      provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
      modeId: profile.modeId ?? null,
      thinkingOptionId: profile.thinkingOptionId ?? null,
    })),
    unusedProfiles: profiles
      .filter((profile) => !used.has(profile.id))
      .map((profile) => ({ id: profile.id, name: profile.name ?? profile.id })),
    profileCount: profiles.length,
    profilesError,
    catalogError,
    running: await runningWorkers(paseo).catch(() => null),
    limits: { agents: limits.agents, claudeAgents: limits.claudeAgents },
  };
}

type DispatcherLaunchInput = {
  id: string;
  provider: string | null;
  profileId: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
};

/**
 * Saves the 「Agent 分工」 editor into 项目登记.json. Running sessions keep the config they launched with; the next
 * dispatch_work and the next dispatcher session use the new one.
 */
export function saveAgents(input: {
  roles: { id: string; name: string; when: string; candidates: CandidateInput[] }[] | null;
  dispatchers: DispatcherLaunchInput[];
}) {
  return exclusive(async () => {
    if (input.roles) {
      const ids = new Set<string>();
      for (const role of input.roles) {
        if (ids.has(role.id)) throw new Error(`角色 ID 重复：${role.id}`);
        ids.add(role.id);
      }
      if (input.roles.length === 0) throw new Error("至少要留一个角色；要回到内置分工表，用「恢复默认」");
    }
    updateRegistry(layout, (raw) => {
      if (input.roles === null) delete raw.roles;
      else
        raw.roles = input.roles.map((role) => ({
          id: role.id,
          name: role.name,
          when: role.when,
          candidates: role.candidates.map(compact),
        }));
      const list = Array.isArray(raw.dispatchers) ? (raw.dispatchers as Record<string, unknown>[]) : [];
      if (input.dispatchers.length === 0) return;
      // `defaultProfileId` would bring back a profile for a dispatcher set to "auto", so each dispatcher that
      // relied on it gets it written out and the registry-wide fallback goes.
      const fallback = typeof raw.defaultProfileId === "string" ? raw.defaultProfileId : null;
      if (fallback) {
        for (const item of list) if (!item.provider && !item.profileId) item.profileId = fallback;
        delete raw.defaultProfileId;
      }
      for (const change of input.dispatchers) {
        const target = list.find((item) => item.id === change.id);
        if (!target) throw new Error(`未登记的调度员：${change.id}`);
        for (const key of ["provider", "profileId", "modeId", "thinkingOptionId"] as const) {
          const value = change[key]?.trim();
          if (value) target[key] = value;
          else delete target[key];
        }
      }
    });
    catalogCache = null;
    return { ok: true as const };
  });
}

function compact(candidate: CandidateInput): CandidateInput {
  return Object.fromEntries(Object.entries(candidate).filter(([, value]) => typeof value === "string" && value.trim())) as CandidateInput;
}

export function prepareHome(): string[] {
  const { registry, problems } = loadRegistry(layout);
  if (!registry) return problems;
  try {
    const seeded = seedRules(layout, registry, pluginRoot && path.join(pluginRoot, "templates", "rules.md"));
    if (seeded) console.log(`[dispatch-center] 还没有调度规则，已从插件模板生成 ${seeded}，按需修改`);
  } catch (error) {
    problems.push(`从模板生成调度规则失败：${(error as Error).message}`);
  }
  const result = syncRules(registry);
  try {
    const state = loadState(layout);
    for (const line of adoptRegistered(state, registry)) console.log(`[dispatch-center] ${line}`);
    saveState(layout, state); // persists the single-seat → lane migration and the adopted project keys
    writeBoards(registry, state);
  } catch (error) {
    problems.push((error as Error).message);
  }
  return [...problems, ...result.problems];
}
