// Pure logic for the dispatch center: registry, generated rule files, ledger, state.
// No Paseo imports, so it can be tested with plain Node.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ResolvedBranch } from "./workspace-project";

export const LABEL_ROLE = "dispatch-center/role";
export const LABEL_DISPATCHER = "dispatch-center/dispatcher";
const GENERATED_MARK = "<!-- dispatcher:generated -->";
const RULE_FILE_LIMIT = 22_000;

const slug = z.string().regex(/^[a-z][a-z0-9-]*$/, "只能用小写字母、数字和连字符，且以字母开头");

export const registrySchema = z.object({
  version: z.literal(1),
  rulesFile: z.string().min(1),
  defaultProfileId: z.string().optional(),
  dispatchers: z
    .array(
      z.object({
        id: slug,
        name: z.string().min(1),
        profileId: z.string().optional(),
        provider: z.string().optional(),
        modeId: z.string().optional(),
        thinkingOptionId: z.string().optional(),
      }),
    )
    .min(1),
  projects: z.array(
    z.object({
      id: slug,
      name: z.string().min(1),
      owner: z.string(),
      repos: z.array(z.string()).min(1),
      projectDoc: z.string().nullable(),
      statusDir: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
  /**
   * Parallel dispatcher sessions ("会话线"): defaults 5 in total, 2 per project.
   * Running worker sessions across all lanes (§1.4): defaults 3 in total, 2 of them Claude.
   */
  limits: z
    .object({
      sessions: z.number().int().min(1).optional(),
      sessionsPerProject: z.number().int().min(1).optional(),
      agents: z.number().int().min(1).optional(),
      claudeAgents: z.number().int().min(0).optional(),
    })
    .optional(),
  /** Workspace IDs and branch names the cleanup list must never offer: a branch in progress can look finished. */
  keep: z.array(z.string().min(1)).optional(),
  /** Who does what: each role's candidates, in the order dispatch_work tries them. Defaults come from §3. */
  roles: z
    .array(
      z.object({
        id: slug,
        name: z.string().min(1),
        when: z.string().min(1),
        candidates: z
          .array(
            z
              .object({
                profile: z.string().optional(),
                provider: z.string().optional(),
                modeId: z.string().optional(),
                thinkingOptionId: z.string().optional(),
              })
              .refine((item) => Boolean(item.profile) !== Boolean(item.provider), "profile 和 provider 只能且必须写一个"),
          )
          // Empty means "the first ready provider", so a role works before anyone picks a model for it.
          .default([]),
      }),
    )
    .optional(),
  /**
   * Directories a provider sees read-only (e.g. mounted `:ro` into a container). dispatch_work refuses a task card
   * whose status file sits inside one for that provider, since the worker would only fail when it reports back.
   */
  readOnlyDirs: z
    .array(
      z.object({
        /** Matched as a substring of the worker's `provider/model`. */
        provider: z.string().min(1),
        dirs: z.array(z.string().min(1)).min(1),
        /** Where to write status files instead, shown in the refusal. */
        statusDir: z.string().optional(),
      }),
    )
    .optional(),
});
export type Registry = z.infer<typeof registrySchema>;
export type DispatcherDef = Registry["dispatchers"][number];
export type ProjectDef = Registry["projects"][number];
export type RoleDef = NonNullable<Registry["roles"]>[number];

export interface Limits {
  sessions: number;
  sessionsPerProject: number;
  agents: number;
  claudeAgents: number;
}
export function limitsOf(registry: Registry): Limits {
  return {
    sessions: registry.limits?.sessions ?? 5,
    sessionsPerProject: registry.limits?.sessionsPerProject ?? 2,
    agents: registry.limits?.agents ?? 3,
    claudeAgents: registry.limits?.claudeAgents ?? 2,
  };
}

const historySchema = z.object({
  agentId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  reason: z.string(),
  laneId: z.string().optional(),
});
const handoffSchema = z.object({ fromAgentId: z.string(), handoffPath: z.string(), requestedAt: z.string() });
export type PendingHandoff = z.infer<typeof handoffSchema>;
const laneProjectSchema = z.object({
  /** Registry project ID, or `dir:<canonical path>` for an unregistered folder. */
  key: z.string(),
  name: z.string(),
  path: z.string(),
  /** Only known when the user picked one on the page. */
  branch: z.string().optional(),
});
export type LaneProject = z.infer<typeof laneProjectSchema>;
/**
 * One parallel dispatcher session ("会话线"). The lane outlives a handoff: the successor agent takes
 * over the same lane, projects and ledger.
 */
const laneSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** The workspace this lane owns. Null means it sits in a shared one, which must never be archived with the lane. */
  workspaceId: z.string().nullable().default(null),
  projects: z.array(laneProjectSchema),
  summary: z.string().nullable(),
  ledgerPath: z.string(),
  startedAt: z.string(),
  rulesHash: z.string().nullable(),
  pendingHandoff: handoffSchema.nullable(),
});
export type Lane = z.infer<typeof laneSchema>;
const dispatcherStateSchema = z.object({
  workspaceId: z.string().nullable(),
  lanes: z.array(laneSchema).default([]),
  lastError: z.string().nullable(),
  history: z.array(historySchema),
  // Single-seat fields from before lanes existed; migrated into a lane by loadState.
  currentAgentId: z.string().nullable().optional(),
  rulesHash: z.string().nullable().optional(),
  pendingHandoff: handoffSchema.nullable().optional(),
});
export type DispatcherState = z.infer<typeof dispatcherStateSchema>;
const stateSchema = z.object({
  version: z.literal(1),
  dispatchers: z.record(z.string(), dispatcherStateSchema),
});
export type State = z.infer<typeof stateSchema>;

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function canonical(input: string): string {
  const resolved = path.resolve(expandHome(input));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export interface Layout {
  home: string;
  registryPath: string;
  statePath: string;
  handoffDir: string;
  dispatcherDir(id: string): string;
  /** The single ledger from before lanes; migrated into the "main" lane. */
  ledgerPath(id: string): string;
  laneLedgerPath(id: string, laneId: string): string;
  laneIndexPath(id: string): string;
}

export function layoutFor(home: string): Layout {
  const root = path.resolve(expandHome(home));
  return {
    home: root,
    registryPath: path.join(root, "项目登记.json"),
    statePath: path.join(root, ".state", "dispatch-state.json"),
    handoffDir: path.join(root, "交接"),
    dispatcherDir: (id) => path.join(root, "调度员", id),
    ledgerPath: (id) => path.join(root, "调度员", id, "台账.md"),
    laneLedgerPath: (id, laneId) => path.join(root, "调度员", id, "台账", `${laneId}.md`),
    laneIndexPath: (id) => path.join(root, "调度员", id, "会话线.md"),
  };
}

/**
 * `PASEO_DISPATCH_HOME`, else `~/Paseo调度中心`. Resolved through symlinks, so pointing the default at an
 * existing directory with a symlink keeps every stored path unchanged.
 */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return canonical(env.PASEO_DISPATCH_HOME || path.join(os.homedir(), "Paseo调度中心"));
}

/** The dispatcher code of conduct lives next to the registry by default. */
export const DEFAULT_RULES_FILE = "调度员.md";

/** Resolves the registry's rulesFile; relative paths are relative to the dispatch home. */
export function rulesPath(layout: Layout, registry: Registry): string {
  const file = expandHome(registry.rulesFile);
  return path.isAbsolute(file) ? file : path.join(layout.home, file);
}

/**
 * First-run registry: one dispatcher, no projects. The dispatcher and every role launch on the first ready
 * provider until a model is set in 「Agent 分工」 → 「设置」.
 */
export function seedRegistry(): Registry {
  return {
    version: 1,
    rulesFile: DEFAULT_RULES_FILE,
    dispatchers: [{ id: "global", name: "全局调度员" }],
    projects: [],
  };
}

export function writeAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, file);
}

/** Reads the registry, creating a seeded one when it is missing. Never overwrites an existing file. */
export function loadRegistry(layout: Layout): { registry: Registry | null; problems: string[] } {
  if (!existsSync(layout.registryPath)) {
    writeAtomic(layout.registryPath, `${JSON.stringify(seedRegistry(), null, 2)}\n`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(layout.registryPath, "utf8"));
  } catch (error) {
    return { registry: null, problems: [`项目登记.json 无法解析：${(error as Error).message}`] };
  }
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return { registry: null, problems: detail.map((line) => `项目登记.json 格式错误 ${line}`) };
  }
  return { registry: parsed.data, problems: validateRegistry(parsed.data) };
}

/**
 * Rewrites part of 项目登记.json from the page. Works on the raw JSON so fields this version does not know survive,
 * and refuses to write anything the schema would reject on the next load.
 */
export function updateRegistry(layout: Layout, change: (raw: Record<string, unknown>) => void): Registry {
  const raw = JSON.parse(readFileSync(layout.registryPath, "utf8")) as Record<string, unknown>;
  change(raw);
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；");
    throw new Error(`没有保存，登记格式不对：${detail}`);
  }
  writeAtomic(layout.registryPath, `${JSON.stringify(raw, null, 2)}\n`);
  return parsed.data;
}

/** Semantic checks. Problems listed here block nothing by themselves; callers decide. */
export function validateRegistry(registry: Registry): string[] {
  const problems: string[] = [];
  const dispatcherIds = new Set<string>();
  for (const dispatcher of registry.dispatchers) {
    if (dispatcherIds.has(dispatcher.id)) problems.push(`调度员 ID 重复：${dispatcher.id}`);
    dispatcherIds.add(dispatcher.id);
  }
  const projectIds = new Set<string>();
  const repoOwners = new Map<string, string>();
  for (const project of registry.projects) {
    if (projectIds.has(project.id)) problems.push(`项目 ID 重复：${project.id}`);
    projectIds.add(project.id);
    if (!dispatcherIds.has(project.owner))
      problems.push(`项目 ${project.id} 的负责调度员 ${project.owner} 未登记`);
    for (const repo of project.repos) {
      const key = canonical(repo);
      const other = repoOwners.get(key);
      if (other) problems.push(`仓库 ${repo} 同时登记在项目 ${other} 和 ${project.id}`);
      repoOwners.set(key, project.id);
    }
    if (project.projectDoc && !existsSync(expandHome(project.projectDoc)))
      problems.push(`项目 ${project.id} 的项目说明不存在：${project.projectDoc}`);
  }
  for (const dispatcher of registry.dispatchers) {
    if (!registry.projects.some((project) => project.owner === dispatcher.id))
      problems.push(`调度员 ${dispatcher.id} 当前没有负责的项目`);
  }
  return problems;
}

export function readRules(layout: Layout, registry: Registry): { text: string; hash: string } {
  const file = rulesPath(layout, registry);
  const text = readFileSync(file, "utf8");
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return { text, hash };
}

export function bootstrapPrompt(
  dispatcher: DispatcherDef,
  layout: Layout,
  lane: { id: string; ledgerPath: string } | null,
): string {
  return [
    `你是 Paseo 常驻调度员「${dispatcher.name}」（ID: ${dispatcher.id}）${lane ? `的会话线 ${lane.id}` : ""}。`,
    `完整调度规则已直接注入下方系统上下文，无需重复读取规则文件；规则缺失或用户要求刷新时，可读 ${path.join(layout.dispatcherDir(dispatcher.id), "AGENTS.md")}。`,
    lane
      ? `开工先读本会话线台账 ${lane.ledgerPath}。同一项目有另一条线时，才读会话线看板 ${layout.laneIndexPath(dispatcher.id)}。`
      : `你不是插件拉起的会话线：先读会话线看板 ${layout.laneIndexPath(dispatcher.id)}，回报用户后等待指令，不要派单。`,
  ].join("\n");
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderAgentsFile(input: {
  registry: Registry;
  dispatcher: DispatcherDef;
  layout: Layout;
  rules: { text: string; hash: string };
  generatedAt: string;
}): string {
  const { registry, dispatcher, layout, rules, generatedAt } = input;
  const owned = registry.projects.filter((project) => project.owner === dispatcher.id);
  const others = registry.projects.filter((project) => project.owner !== dispatcher.id);
  const nameOf = (id: string) => registry.dispatchers.find((item) => item.id === id)?.name ?? id;
  const lines: string[] = [
    GENERATED_MARK,
    `<!-- 由 dispatcher 插件生成，请勿手改。改 ${layout.registryPath} 或规则原文后，在「调度员」页面点「同步规则」。 -->`,
    `<!-- 规则版本 ${rules.hash}，生成于 ${generatedAt} -->`,
    "",
    `# 调度员身份：${dispatcher.name}（ID: ${dispatcher.id}）`,
    "",
    "你是 Paseo 常驻调度员，只在本调度工作区工作。你派出的执行会话在各项目的仓库或 worktree 里运行，它们不是调度员，也不受下面「调度员」身份约束。",
    "",
    "## 负责的项目（只为这些项目派单）",
    "",
  ];
  if (owned.length === 0) {
    lines.push("当前没有登记给你的项目。收到任何项目需求都先回报用户，不要接单。", "");
  } else {
    lines.push("| 项目 ID | 名称 | 仓库 | 项目说明 | 状态目录 | 备注 |", "|---|---|---|---|---|---|");
    for (const project of owned) {
      lines.push(
        `| ${cell(project.id)} | ${cell(project.name)} | ${cell(project.repos.join("<br>"))} | ${cell(
          project.projectDoc ?? "**未配置**",
        )} | ${cell(project.statusDir ?? "—")} | ${cell(project.note ?? "")} |`,
      );
    }
    lines.push(
      "",
      "- 处理哪个项目，才读哪个项目的说明；不要一次读完全部项目。",
      "- 项目说明「未配置」时，先请用户补齐，不得借用其他项目的说明或交接。",
      "",
    );
  }
  if (others.length > 0) {
    lines.push("## 不归你负责的项目", "");
    for (const project of others)
      lines.push(`- ${project.name}（${project.id}）由「${nameOf(project.owner)}」负责：不派单，转告用户。`);
    lines.push("");
  }
  const limits = limitsOf(registry);
  const board = layout.laneIndexPath(dispatcher.id);
  lines.push(
    "未登记的项目也不接单，回报用户。同一项目只由它的负责调度员派单（可有多条会话线，见「并行会话线」）。",
    "",
    "## 并行会话线（以本节为准）",
    "",
    `- 你可能只是本调度员同时在岗的多条「会话线」之一：全部调度员合计最多 ${limits.sessions} 条，同一项目最多 ${limits.sessionsPerProject} 条。看板 ${board} 列出每条线的会话 ID、占用项目、需求摘要和台账。`,
    "- 每条会话线有自己的台账，只管首条消息和后续指派交给它的项目与需求；别的线的需求不接、不碰它们派出的执行会话。",
    "- 同一项目有另一条线时，派单前读看板和对方台账的「改动范围」，按 §1.1、§5 确认互不影响；有交叉或拿不准就停手，回报用户。",
    "- 本线的「改动范围」（文件或模块、分支、worktree）在首次派单前写进台账，范围变了立即更新。",
    "- §1.4 的并行上限是全部会话线合计：派单前用 `paseo ls` 数全部在跑的子 agent，到上限就排队。",
    "",
    "## 开工与恢复（新会话、上下文压缩后都要做）",
    "",
    "1. 读首条消息点名的本会话线台账；没点名时，按会话 ID 在看板里找到自己的线和台账，找不到就回报用户，不要派单。",
    "2. 首条消息点名了交接文件时，读那一份；不要自行搜索「最新交接」。",
    "3. 核对本线台账里「在跑」的执行会话（`paseo ls`、状态文件），继续跟进，不要重复派单。",
    "",
    "## 会话边界（以本节为准）",
    "",
    "- 只跟进、send、归档本线台账里登记的、由本线（含前任）派出的执行会话。`paseo ls` 里的其他会话（用户自己开的、其他会话线或调度员的、来历不明的）一律不 send、不归档、不接管、不写进本线台账；看起来相关时，列出会话 ID 回报用户确认。",
    "- 派单必须用 `--cwd` 指向目标项目的仓库或 worktree，禁止在本调度目录里开执行会话，也不要在这里另开调度员会话；要多一条会话线，由用户在调度员页面开。",
    "",
    "## 台账",
    "",
    "每次派单、核验完成、遇到阻塞后立即更新本线台账：执行会话 ID、项目、cwd、分支、状态文件、阶段、下一步、待拍板，以及改动范围。执行会话核验完就从「在跑」表移到「最近完成」。不要等到换班才整理。不要写别的线的台账。",
    "",
    "## 手动接班",
    "",
    "换班按会话线进行，照「换班」指令和第 11 节办；不要归档自己。接班沿用本线项目和台账。",
    "",
    "## 派单工具（以本节为准）",
    "",
    "- 你的核心工作：看用户这句话属于哪个角色的强项，就派给它；跨多个强项就拆开分别派。不亲自做，也不把拿不准的活都归给测试。",
    "- 派执行会话用 `dispatch_work` 工具。你只判断活归哪个角色并写一句理由，再交齐任务卡字段；模型、模式、thinking、并行上限、建工作区由插件完成。第 3 节的具体模型以工具返回为准，分工表在调度员页面查看。",
    "- 额度仍按第 4 节查，不够或撞限流的家写进 `avoid`，工具会换下一个备选。",
    "- 工具拒绝（到并行上限、任务卡不合格、备选都不可用）时不绕过：排队或上报。只有会话里没有这个工具时，才按第 5 节用 `paseo run`，并在回报里说明。",
    "- 派出后仍按第 6 节建心跳，并更新本线台账。",
    "",
    "## 页面指派（以本节为准）",
    "",
    `- 消息以「${TARGET_MARK}」开头时，是用户在调度员页面选好的目标项目，不用再问改哪个项目。`,
    "- 块里列出多个项目时是协同任务：先派拆分工位出计划，写明接口约定、改动顺序和联调方式，再分别派单；台账里把这几个执行会话记为同一组。",
    "- 块里标注「由其他调度员负责」的项目：不为它派单；只整理它需要配合的接口与时间点，回报用户转交负责调度员。",
    "- 块里标注「未登记」或项目说明「未配置」的项目：按通用规则第 2 节处理，停手上报用户，不读 README、不搜索；其余项目照常推进。",
    "- 块里写了分支时，是用户选定的，优先于 PROJECT.md 的当前专项，不用再问用哪个分支。",
    "- 本节只说明目标从哪里来，不放宽下方通用规则的任何一条。",
    "",
    `# 通用调度规则（原文快照，来源：${rulesPath(layout, registry)}）`,
    "",
    rules.text.trim(),
    "",
  );
  return lines.join("\n");
}

export function renderLedger(
  dispatcher: DispatcherDef,
  lane?: { id: string; projects: LaneProject[]; summary: string | null },
): string {
  return [
    lane
      ? `# 台账：${dispatcher.name}（${dispatcher.id}）· 会话线 ${lane.id}`
      : `# 台账：${dispatcher.name}（${dispatcher.id}）`,
    "",
    "> 每次派单、核验、阻塞后更新。接班调度员从这里恢复。只写本线的内容。",
    "",
    ...(lane
      ? [
          `- 项目：${lane.projects.map((project) => project.name).join("、") || "（未绑定）"}`,
          `- 需求：${lane.summary ?? "（见首条消息）"}`,
          "",
        ]
      : []),
    "## 改动范围",
    "",
    "<!-- 首次派单前写：会改的文件或模块、分支、worktree。同项目的另一条会话线派单前会读这里。 -->",
    "",
    "## 在跑执行会话",
    "",
    "| 会话 ID | 项目 | cwd | 分支 | 状态文件 | 阶段 | 下一步 |",
    "|---|---|---|---|---|---|---|",
    "",
    "## 待用户拍板",
    "",
    "## 最近完成",
    "",
  ].join("\n");
}

export interface SyncResult {
  written: string[];
  problems: string[];
  hashes: Record<string, string>;
}

/** Regenerates every dispatcher's AGENTS.md and creates missing ledgers. */
export function syncFiles(
  layout: Layout,
  registry: Registry,
  now: Date = new Date(),
  /** The size limit is Antigravity's. A dispatcher on another provider isn't held to it. Default: applies to everyone. */
  options: { limitApplies?: (dispatcher: DispatcherDef) => boolean } = {},
): SyncResult {
  const result: SyncResult = { written: [], problems: [], hashes: {} };
  let rules: { text: string; hash: string };
  try {
    rules = readRules(layout, registry);
  } catch (error) {
    result.problems.push(`读取规则原文失败（${rulesPath(layout, registry)}）：${(error as Error).message}`);
    return result;
  }
  mkdirSync(layout.handoffDir, { recursive: true });
  for (const dispatcher of registry.dispatchers) {
    const dir = layout.dispatcherDir(dispatcher.id);
    mkdirSync(dir, { recursive: true });
    const agentsPath = path.join(dir, "AGENTS.md");
    if (existsSync(agentsPath) && !readFileSync(agentsPath, "utf8").startsWith(GENERATED_MARK)) {
      result.problems.push(`${agentsPath} 不是插件生成的文件，已跳过，未覆盖`);
      continue;
    }
    const content = renderAgentsFile({
      registry,
      dispatcher,
      layout,
      rules,
      generatedAt: now.toISOString(),
    });
    const size = Buffer.byteLength(content, "utf8");
    if (size > RULE_FILE_LIMIT && (options.limitApplies?.(dispatcher) ?? true))
      result.problems.push(
        `${dispatcher.id} 的 AGENTS.md 有 ${size} 字节，接近 Antigravity 单文件约 24KB 的上限（超过会被截断），请精简规则`,
      );
    writeAtomic(agentsPath, content);
    result.written.push(agentsPath);
    result.hashes[dispatcher.id] = rules.hash;
  }
  return result;
}

export function emptyDispatcherState(): DispatcherState {
  return {
    workspaceId: null,
    lanes: [],
    lastError: null,
    history: [],
  };
}

/** Project keys named in the "在跑执行会话" table of a pre-lane ledger, so a migrated lane keeps holding them. */
export function ledgerProjects(text: string): string[] {
  const keys = new Set<string>();
  let inRunning = false;
  let row = 0;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inRunning = heading[1].includes("在跑");
      row = 0;
      continue;
    }
    if (!inRunning || !line.trim().startsWith("|")) continue;
    row += 1;
    if (row <= 2) continue;
    const cells = line.split("|").map((value) => value.trim());
    if (cells[2]) keys.add(cells[2]);
  }
  return [...keys];
}

/** Turns the old single "current agent" seat into the first lane. Idempotent. */
export function migrateState(layout: Layout, state: State, now: Date = new Date()): boolean {
  let changed = false;
  for (const [id, entry] of Object.entries(state.dispatchers)) {
    if (entry.currentAgentId && entry.lanes.length === 0) {
      const ledgerPath = layout.ledgerPath(id);
      let keys: string[] = [];
      try {
        keys = ledgerProjects(readFileSync(ledgerPath, "utf8"));
      } catch {
        // No ledger yet: the lane simply holds no project until the next assignment.
      }
      const started = [...entry.history].reverse().find((item) => item.agentId === entry.currentAgentId);
      entry.lanes.push({
        id: "main",
        agentId: entry.currentAgentId,
        workspaceId: null,
        projects: keys.map((key) => ({ key, name: key, path: "" })),
        summary: null,
        ledgerPath,
        startedAt: started?.startedAt ?? now.toISOString(),
        rulesHash: entry.rulesHash ?? null,
        pendingHandoff: entry.pendingHandoff ?? null,
      });
      if (started) started.laneId = "main";
    }
    if (entry.currentAgentId !== undefined || entry.rulesHash !== undefined || entry.pendingHandoff !== undefined) {
      delete entry.currentAgentId;
      delete entry.rulesHash;
      delete entry.pendingHandoff;
      changed = true;
    }
  }
  return changed;
}

export function loadState(layout: Layout): State {
  if (!existsSync(layout.statePath)) return { version: 1, dispatchers: {} };
  const parsed = stateSchema.safeParse(JSON.parse(readFileSync(layout.statePath, "utf8")));
  if (!parsed.success) throw new Error(`状态文件损坏：${layout.statePath}`);
  migrateState(layout, parsed.data);
  return parsed.data;
}

export function saveState(layout: Layout, state: State): void {
  writeAtomic(layout.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function stateOf(state: State, id: string): DispatcherState {
  const existing = state.dispatchers[id];
  if (existing) return existing;
  const created = emptyDispatcherState();
  state.dispatchers[id] = created;
  return created;
}

// ---------------------------------------------------------------------------
// Lanes: parallel dispatcher sessions.

const HISTORY_LIMIT = 30;

export function laneOf(entry: DispatcherState, laneId: string): Lane | null {
  return entry.lanes.find((lane) => lane.id === laneId) ?? null;
}

export function laneByAgent(state: State, agentId: string): { dispatcherId: string; lane: Lane } | null {
  for (const [dispatcherId, entry] of Object.entries(state.dispatchers)) {
    const lane = entry.lanes.find((item) => item.agentId === agentId);
    if (lane) return { dispatcherId, lane };
  }
  return null;
}

export function allLanes(state: State): { dispatcherId: string; lane: Lane }[] {
  return Object.entries(state.dispatchers).flatMap(([dispatcherId, entry]) =>
    entry.lanes.map((lane) => ({ dispatcherId, lane })),
  );
}

export function newLaneId(state: State, now: Date = new Date()): string {
  const taken = new Set(allLanes(state).map(({ lane }) => lane.id));
  for (let attempt = 0; ; attempt += 1) {
    const id = `l${(now.getTime() + attempt).toString(36).slice(-5)}`;
    if (!taken.has(id)) return id;
  }
}

/** Records an agent taking (or retaking) a lane in the dispatcher's history. */
export function recordLaneAgent(
  entry: DispatcherState,
  lane: Lane,
  agentId: string,
  reason: string,
  now: Date,
): void {
  const stamp = now.toISOString();
  for (const item of entry.history)
    if (item.endedAt === null && item.laneId === lane.id && item.agentId !== agentId) item.endedAt = stamp;
  if (!entry.history.some((item) => item.agentId === agentId && item.endedAt === null))
    entry.history.push({ agentId, startedAt: stamp, endedAt: null, reason, laneId: lane.id });
  if (entry.history.length > HISTORY_LIMIT) entry.history.splice(0, entry.history.length - HISTORY_LIMIT);
  lane.agentId = agentId;
}

/** Removes a lane; its ledger stays on disk. */
export function releaseLane(entry: DispatcherState, laneId: string, now: Date): Lane | null {
  const lane = laneOf(entry, laneId);
  if (!lane) return null;
  entry.lanes = entry.lanes.filter((item) => item.id !== laneId);
  const stamp = now.toISOString();
  for (const item of entry.history) if (item.endedAt === null && item.laneId === laneId) item.endedAt = stamp;
  return lane;
}

/** An archived session holds no seat and no project. A pending handoff keeps its lane: the successor still needs it. */
export function releaseArchivedLanes(state: State, archived: ReadonlySet<string>, now: Date): Lane[] {
  const released: Lane[] = [];
  for (const entry of Object.values(state.dispatchers)) {
    for (const lane of [...entry.lanes]) {
      if (!archived.has(lane.agentId) || lane.pendingHandoff) continue;
      if (releaseLane(entry, lane.id, now)) released.push(lane);
    }
  }
  return released;
}

/**
 * The sessions of a lane that has ended, whose workers can go with it. null when `agentId` is not one of ours,
 * or its lane is still running: after a handoff the successor carries on with the old session's workers.
 */
export function endedLaneParents(state: State, agentId: string): string[] | null {
  if (laneByAgent(state, agentId)) return null;
  for (const entry of Object.values(state.dispatchers)) {
    const hit = entry.history.find((item) => item.agentId === agentId);
    if (!hit) continue;
    if (!hit.laneId) return [agentId];
    if (laneOf(entry, hit.laneId)) return null;
    return [...new Set(entry.history.filter((item) => item.laneId === hit.laneId).map((item) => item.agentId))];
  }
  return null;
}

const WORK_ROLE_LABEL = "dispatch-center/work-role";
const LANE_LABEL = "dispatch-center/lane";

/** A worker is also tied to its lane by label. Sessions dispatched today carry no parent label, only this one. */
export function startedByLane(labels: Record<string, string>, laneKeys: ReadonlySet<string>): boolean {
  if (laneKeys.size === 0 || !labels[WORK_ROLE_LABEL]) return false;
  return laneKeys.has(`${labels[LABEL_DISPATCHER]}/${labels[LANE_LABEL]}`);
}

/** Lanes that have ended and whose every session is archived: their workers can go. Keys are `dispatcher/lane`. */
export function endedLaneKeys(state: State, archived: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const [dispatcherId, entry] of Object.entries(state.dispatchers)) {
    const byLane = new Map<string, string[]>();
    for (const item of entry.history) if (item.laneId) byLane.set(item.laneId, [...(byLane.get(item.laneId) ?? []), item.agentId]);
    for (const [laneId, agents] of byLane) {
      if (laneOf(entry, laneId)) continue;
      if (agents.every((agentId) => archived.has(agentId))) keys.add(`${dispatcherId}/${laneId}`);
    }
  }
  return keys;
}

/** The lane's sidebar row. The summary tells two lanes on the same project apart. */
export function laneTitle(lane: { id: string; projects: LaneProject[]; summary: string | null }): string {
  const names = lane.projects.map((project) => project.name).join("+");
  const summary = lane.summary && lane.summary.length > 16 ? `${lane.summary.slice(0, 16)}…` : lane.summary;
  return [names, summary].filter(Boolean).join("-") || `会话线-${lane.id}`;
}

/** null when the title never had the prefix, or nothing would be left without it. */
export function withoutDispatcherPrefix(title: string): string | null {
  return title.startsWith("调度员-") && title.length > "调度员-".length ? title.slice("调度员-".length) : null;
}

export function laneKey(target: TargetProject): string {
  return target.projectId ?? `dir:${target.path}`;
}

export function laneProject(target: TargetProject, branch?: string): LaneProject {
  return { key: laneKey(target), name: target.name, path: target.path, ...(branch ? { branch } : {}) };
}

export interface Holder {
  dispatcherId: string;
  lane: Lane;
}

/** The branch a lane recorded for a project, if the user picked one when assigning. */
export function branchHeld(holder: Holder, key: string): string | undefined {
  return holder.lane.projects.find((item) => item.key === key)?.branch;
}

export function holdersOf(state: State, key: string, exceptLaneId?: string): Holder[] {
  return allLanes(state).filter(
    ({ lane }) => lane.id !== exceptLaneId && lane.projects.some((project) => project.key === key),
  );
}

export type Route =
  | { kind: "send"; laneId: string; shared: { project: LaneProject; holder: Holder }[] }
  | { kind: "new"; shared: { project: LaneProject; holder: Holder }[] };

export class RouteError extends Error {
  constructor(
    message: string,
    readonly code: "needs-confirm" | "project-full" | "sessions-full" | "ambiguous" | "unknown-lane",
  ) {
    super(message);
  }
}

/**
 * Decides where an assignment goes. Enforces the lane limits: `sessions` lanes in total and
 * `sessionsPerProject` lanes per project, and a second lane on a project only with the user's
 * confirmation that the two pieces of work do not touch each other.
 */
export function planRoute(input: {
  state: State;
  dispatcherId: string;
  projects: LaneProject[];
  limits: Limits;
  laneId?: string;
  newLane?: boolean;
  confirmIndependent?: boolean;
}): Route {
  const entry = stateOf(input.state, input.dispatcherId);
  const label = (holder: Holder) =>
    `会话线 ${holder.lane.id}${holder.lane.summary ? `（${holder.lane.summary.slice(0, 30)}）` : ""}`;
  /**
   * Adds the other lanes on the same branch of a project to `shared`. Allowed once the user confirms the
   * work is independent: the later lane works on a temporary branch cut from it and merges back (§1.1).
   */
  const withSameBranch = (shared: { project: LaneProject; holder: Holder }[], exceptLaneId?: string) => {
    const extra = input.projects.flatMap((project) =>
      project.branch
        ? holdersOf(input.state, project.key, exceptLaneId)
            .filter((holder) => branchHeld(holder, project.key) === project.branch)
            .filter((holder) => !shared.some((item) => item.project.key === project.key && item.holder.lane.id === holder.lane.id))
            .map((holder) => ({ project, holder }))
        : [],
    );
    if (extra.length > 0 && !input.confirmIndependent)
      throw new RouteError(
        `${extra
          .map(({ project, holder }) => `「${project.name}」的分支 ${project.branch} 正由${label(holder)}在做`)
          .join("；")}。同一分支可以并行：本线从该分支拉临时分支施工，验收后合回。请确认两边的改动互不影响后再发`,
        "needs-confirm",
      );
    return [...shared, ...extra];
  };
  /** Capacity and independence checks for projects a lane would newly take on. */
  const admit = (projects: LaneProject[], exceptLaneId?: string) => {
    for (const project of projects) {
      const holders = holdersOf(input.state, project.key, exceptLaneId);
      if (holders.length >= input.limits.sessionsPerProject)
        throw new RouteError(
          `项目「${project.name}」已有 ${holders.length} 条会话线（上限 ${input.limits.sessionsPerProject}）：${holders
            .map(label)
            .join("、")}。请发给其中一条，或先归档一条`,
          "project-full",
        );
    }
    const shared = projects.flatMap((project) =>
      holdersOf(input.state, project.key, exceptLaneId).map((holder) => ({ project, holder })),
    );
    if (shared.length > 0 && !input.confirmIndependent)
      throw new RouteError(
        `${shared.map(({ project, holder }) => `「${project.name}」正由${label(holder)}在做`).join("；")}。请确认两边的改动互不影响后再开`,
        "needs-confirm",
      );
    return shared;
  };

  if (input.laneId) {
    const lane = laneOf(entry, input.laneId);
    if (!lane) throw new RouteError(`会话线 ${input.laneId} 已不存在`, "unknown-lane");
    const added = input.projects.filter((project) => !lane.projects.some((item) => item.key === project.key));
    return { kind: "send", laneId: lane.id, shared: withSameBranch(admit(added, lane.id), lane.id) };
  }

  if (!input.newLane) {
    const keys = input.projects.map((project) => project.key);
    const covering = entry.lanes.filter((lane) => keys.every((key) => lane.projects.some((p) => p.key === key)));
    if (covering.length === 1) {
      return { kind: "send", laneId: covering[0].id, shared: withSameBranch([], covering[0].id) };
    }
    if (covering.length > 1)
      throw new RouteError(
        `有 ${covering.length} 条会话线都在做这些项目：${covering.map((lane) => lane.id).join("、")}。请选择发给哪一条`,
        "ambiguous",
      );
  }

  const total = allLanes(input.state).length;
  if (total >= input.limits.sessions)
    throw new RouteError(
      `已有 ${total} 条会话线（上限 ${input.limits.sessions}）。请发给现有会话线，或先归档一条`,
      "sessions-full",
    );
  // admit() already lists every lane on these projects, same branch or not.
  return { kind: "new", shared: admit(input.projects) };
}

export function handoffPathFor(layout: Layout, dispatcherId: string, now: Date, laneId?: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return path.join(layout.handoffDir, `${dispatcherId}${laneId ? `.${laneId}` : ""}-${stamp}.md`);
}

export function handoffWritten(file: string): boolean {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

export function dispatcherForCwd(layout: Layout, registry: Registry, cwd: string): DispatcherDef | null {
  const target = canonical(cwd);
  return (
    registry.dispatchers.find((dispatcher) => canonical(layout.dispatcherDir(dispatcher.id)) === target) ??
    null
  );
}

export const handoffInstruction = (handoffPath: string, ledgerPath: string) =>
  [
    "换班。请现在：",
    `1. 把交接写到 ${handoffPath}（≤60 行：现状、在跑执行会话 ID 与状态文件、改动范围、下一步、遗留、待拍板）。`,
    `2. 同步更新本会话线台账 ${ledgerPath}。`,
    "3. 写完就停止派单、结束本轮。不要拉起接班会话，也不要归档自己；等待用户手动启动接班，交接后不再推进任务。",
  ].join("\n");

export const successorPrompt = (input: {
  handoffPath: string;
  lane: Lane;
  fromAgentId: string;
  boardPath: string;
}) =>
  [
    `你是会话线 ${input.lane.id} 的接班调度员，前任会话 ${input.fromAgentId}。`,
    input.lane.projects.length > 0 ? `本线占用项目：${input.lane.projects.map((p) => p.name).join("、")}。` : "",
    `先读交接 ${input.handoffPath}、本线台账 ${input.lane.ledgerPath} 和会话线看板 ${input.boardPath}。`,
    "逐个核对本线在跑的执行会话（paseo ls、状态文件），继续跟进，不要重复派单；别的线的会话不碰。",
    "核对完简短回报：接班完成、在跑任务、待拍板事项。",
  ]
    .filter(Boolean)
    .join("\n");

/** Lines telling a lane that another lane is working on the same project. */
export function sharedNotice(shared: { project: LaneProject; holder: Holder }[]): string {
  if (shared.length === 0) return "";
  return [
    "【并行提示】以下项目还有别的会话线在做，用户已确认两边的改动互不影响：",
    ...shared.map(({ project, holder }) => {
      const line = `- ${project.name}：会话线 ${holder.lane.id}（会话 ${holder.lane.agentId.slice(0, 8)}）${
        holder.lane.summary ? `在做「${holder.lane.summary}」` : ""
      }，台账 ${holder.lane.ledgerPath}`;
      const branch = project.branch;
      if (!branch || branchHeld(holder, project.key) !== branch) return line;
      return `${line}\n  两条线都在分支 ${branch} 上：本线不直接改 ${branch}。从 ${branch} 当前提交拉临时分支 \`${branch}-<本线 ID>\`，按第 5 节单独建 worktree 施工，任务卡的预期分支写临时分支；验收后先把 ${branch} 的新提交合进临时分支，再按第 13 节 squash 合回 ${branch}（须用户点头，两条线不同时合入，有冲突停下报告），合回后清理临时分支和 worktree。`;
    }),
    "派单前读对方台账的「改动范围」：不改同一批文件，不用同一 worktree，不同时合入同一目标分支。有交叉就停手回报用户。",
  ].join("\n");
}

/** The shared board every lane reads before dispatching. */
export function renderLaneIndex(
  registry: Registry,
  dispatcher: DispatcherDef,
  state: State,
  generatedAt: string,
): string {
  const limits = limitsOf(registry);
  const own = stateOf(state, dispatcher.id).lanes;
  const lines = [
    GENERATED_MARK,
    `<!-- 由 dispatcher 插件维护，请勿手改。更新于 ${generatedAt} -->`,
    "",
    `# 会话线看板：${dispatcher.name}（${dispatcher.id}）`,
    "",
    `全部调度员合计最多 ${limits.sessions} 条会话线，同一项目最多 ${limits.sessionsPerProject} 条；现有 ${allLanes(state).length} 条。`,
    "",
  ];
  if (own.length === 0) lines.push("（当前没有会话线）", "");
  else {
    lines.push("| 会话线 | 会话 ID | 占用项目 | 需求摘要 | 台账 |", "|---|---|---|---|---|");
    for (const lane of own)
      lines.push(
        `| ${lane.id} | ${lane.agentId} | ${cell(lane.projects.map((p) => p.name).join("、") || "（未绑定）")} | ${cell(
          lane.summary ?? "",
        )} | ${cell(lane.ledgerPath)} |`,
      );
    lines.push("");
  }
  const others = allLanes(state).filter((item) => item.dispatcherId !== dispatcher.id);
  if (others.length > 0) {
    lines.push("## 其他调度员的会话线（只读参考，计入总数）", "");
    for (const { dispatcherId, lane } of others)
      lines.push(`- ${dispatcherId} / ${lane.id}：${lane.projects.map((p) => p.name).join("、") || "（未绑定）"}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Project targets picked in the dispatch center (one or many folders per assignment).

export const TARGET_MARK = "【本次目标项目】";

export interface TargetProject {
  /** Canonical folder the user picked. */
  path: string;
  name: string;
  projectId: string | null;
  owner: string | null;
  projectDoc: string | null;
  statusDir: string | null;
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Maps a picked folder to the registered project whose repo contains it, if any. */
export function resolveTarget(registry: Registry, folder: string): TargetProject {
  const target = canonical(folder);
  let best: { project: ProjectDef; depth: number } | null = null;
  for (const project of registry.projects) {
    for (const repo of project.repos) {
      const root = canonical(repo);
      if (!isInside(root, target)) continue;
      const depth = root.split(path.sep).length;
      if (!best || depth > best.depth) best = { project, depth };
    }
  }
  if (!best) {
    return {
      path: target,
      name: path.basename(target) || target,
      projectId: null,
      owner: null,
      projectDoc: null,
      statusDir: null,
    };
  }
  const { project } = best;
  return {
    path: target,
    name: project.name,
    projectId: project.id,
    owner: project.owner,
    projectDoc: project.projectDoc,
    statusDir: project.statusDir ?? null,
  };
}

/** The dispatcher owning most of the registered targets; ties go to registry order. */
export function suggestLead(registry: Registry, targets: TargetProject[]): string | null {
  const counts = new Map<string, number>();
  for (const target of targets) if (target.owner) counts.set(target.owner, (counts.get(target.owner) ?? 0) + 1);
  let lead: string | null = null;
  let max = 0;
  for (const dispatcher of registry.dispatchers) {
    const count = counts.get(dispatcher.id) ?? 0;
    if (count > max) {
      lead = dispatcher.id;
      max = count;
    }
  }
  return lead;
}

function branchPart(branch: ResolvedBranch): string {
  if (branch.base) return `新建分支 ${branch.name}（基于 ${branch.base}，按第 5 节建 worktree）`;
  return branch.worktree
    ? `分支 ${branch.name}（worktree ${branch.worktree}）`
    : `分支 ${branch.name}（还没有 worktree，按第 5 节建）`;
}

export function targetBlock(
  registry: Registry,
  targets: TargetProject[],
  dispatcherId: string,
  branches?: ReadonlyMap<string, ResolvedBranch>,
): string {
  const nameOf = (id: string) => registry.dispatchers.find((item) => item.id === id)?.name ?? id;
  const lines = [TARGET_MARK];
  if (targets.length > 1)
    lines.push(`本次涉及 ${targets.length} 个项目，需要协同推进（例如前后端同时改、跨项目联调）：`);
  for (const target of targets) {
    const parts = [
      target.projectId ? `${target.name}（ID: ${target.projectId}）` : `${target.name}（未登记）`,
      `目录 ${target.path}`,
    ];
    const branch = branches?.get(target.path);
    if (branch) parts.push(branchPart(branch));
    if (target.projectId) parts.push(`项目说明 ${target.projectDoc ?? "未配置"}`);
    if (target.statusDir) parts.push(`状态目录 ${target.statusDir}`);
    if (target.owner && target.owner !== dispatcherId) parts.push(`由其他调度员「${nameOf(target.owner)}」负责`);
    lines.push(`- ${parts.join("｜")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Images attached to an assignment.

export interface PromptImage {
  name?: string;
  mimeType: string;
  /** Base64 without the `data:` prefix. */
  data: string;
}

/** Kept well under the 32 MB relay frame, which carries the images base64-encoded. */
export const IMAGE_LIMITS = { count: 6, bytes: 5 * 1024 * 1024, totalBytes: 12 * 1024 * 1024 };

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const imageBytes = (image: PromptImage) => Math.floor((image.data.length * 3) / 4);

/** Throws a message for the user when the images can't be sent as they are. */
export function checkImages(images: PromptImage[]): void {
  if (images.length > IMAGE_LIMITS.count) throw new Error(`最多附 ${IMAGE_LIMITS.count} 张图，现在 ${images.length} 张`);
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  for (const image of images) {
    if (!IMAGE_EXTENSIONS[image.mimeType])
      throw new Error(`不支持的图片格式 ${image.mimeType}${image.name ? `（${image.name}）` : ""}，请用 PNG、JPEG、GIF 或 WebP`);
    if (imageBytes(image) > IMAGE_LIMITS.bytes)
      throw new Error(`图片${image.name ? `「${image.name}」` : ""}有 ${mb(imageBytes(image))}，单张上限 ${mb(IMAGE_LIMITS.bytes)}`);
  }
  const total = images.reduce((sum, image) => sum + imageBytes(image), 0);
  if (total > IMAGE_LIMITS.totalBytes) throw new Error(`图片合计 ${mb(total)}，上限 ${mb(IMAGE_LIMITS.totalBytes)}`);
}

/** Saves the images under the dispatcher's 附件/<lane>/, so task cards can point workers at them. */
export function saveImages(layout: Layout, dispatcherId: string, laneId: string, images: PromptImage[], now = new Date()): string[] {
  if (images.length === 0) return [];
  const dir = path.join(layout.dispatcherDir(dispatcherId), "附件", laneId);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return images.map((image, index) => {
    const stem = (image.name ?? "").replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40);
    const file = path.join(dir, `${stamp}-${index + 1}${stem ? `-${stem}` : ""}.${IMAGE_EXTENSIONS[image.mimeType]}`);
    writeFileSync(file, Buffer.from(image.data, "base64"));
    return file;
  });
}

/** Tells the dispatcher where the attached images are, so it hands paths to workers instead of describing them. */
export function imagesNote(files: string[]): string {
  if (files.length === 0) return "";
  return [
    `【附图】用户随需求附了 ${files.length} 张图，已随本消息发给你，也存在本地：`,
    ...files.map((file) => `- ${file}`),
    "派单时把相关图片的路径写进任务卡的点名文件，让 worker 自己看图；不要把图转述成大段文字。",
  ].join("\n");
}

export function assignmentPrompt(input: {
  registry: Registry;
  targets: TargetProject[];
  dispatcherId: string;
  task?: string;
  fresh: boolean;
  branches?: ReadonlyMap<string, ResolvedBranch>;
}): string {
  const sections = [targetBlock(input.registry, input.targets, input.dispatcherId, input.branches)];
  if (input.fresh) sections.push("开工：按 AGENTS.md 读台账恢复状态。");
  const task = input.task?.trim();
  sections.push(
    task
      ? `需求：\n${task}`
      : input.targets.length > 1
        ? "先读上述项目的说明与状态，理清它们之间的依赖，简短回报现状，然后等待指令。"
        : "先读该项目的说明与状态，简短回报现状，然后等待指令。",
  );
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Folder browsing (runs on the daemon host, so it works from phone clients too).

export interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function isGitRoot(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "dist", "build", "target", ".git"]);

export function listDirectory(input: string, showHidden = false, limit = 500) {
  const dir = canonical(input);
  if (!isDirectory(dir)) throw new Error(`不是文件夹：${input}`);
  const entries: DirEntry[] = [];
  let truncated = false;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (!showHidden && item.name.startsWith(".")) continue;
    if (SKIPPED_DIRS.has(item.name)) continue;
    const full = path.join(dir, item.name);
    if (!(item.isDirectory() || (item.isSymbolicLink() && isDirectory(full)))) continue;
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    entries.push({ name: item.name, path: full, isGit: isGitRoot(full) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, isGit: isGitRoot(dir), entries, truncated };
}

// ---------------------------------------------------------------------------
// Read-only views used by the dispatch center screen.

/** "- 无" and "- 无（已全部确认）" say there is nothing pending; "- 无法确定用哪个方案" is a real item. */
const NOTHING_PENDING = /^(?:无|暂无|没有|none)(?=$|[\s（(，,。.:：;；])/i;

/** One per decision: bullets nested under a decision are its details, so only the outermost level counts. */
export function summarizeLedger(text: string): { pendingDecisions: number } {
  let inDecisions = false;
  const items: { indent: number; text: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inDecisions = heading[1].includes("拍板");
      continue;
    }
    const item = /^(\s*)(?:[-*]|\d+\.)\s+(\S.*)$/.exec(line);
    if (inDecisions && item) items.push({ indent: item[1].length, text: item[2] });
  }
  const outermost = Math.min(...items.map((item) => item.indent));
  return {
    pendingDecisions: items.filter((item) => item.indent === outermost && !NOTHING_PENDING.test(item.text)).length,
  };
}

export function ledgerInfo(file: string) {
  try {
    const stat = statSync(file);
    return {
      path: file,
      exists: true,
      updatedAt: stat.mtime.toISOString(),
      ...summarizeLedger(readFileSync(file, "utf8")),
    };
  } catch {
    return { path: file, exists: false, updatedAt: null, pendingDecisions: 0 };
  }
}

/** True when the AGENTS.md on disk no longer matches what the registry and rules would generate now. */
export function agentsFileStale(
  layout: Layout,
  registry: Registry,
  dispatcher: DispatcherDef,
  rules: { text: string; hash: string },
): boolean {
  const file = path.join(layout.dispatcherDir(dispatcher.id), "AGENTS.md");
  let onDisk: string;
  try {
    onDisk = readFileSync(file, "utf8");
  } catch {
    return true;
  }
  const body = (text: string) => text.split("\n").slice(3).join("\n");
  const fresh = renderAgentsFile({ registry, dispatcher, layout, rules, generatedAt: "" });
  return body(onDisk) !== body(fresh);
}

export function listHandoffs(layout: Layout, limit = 12) {
  let names: string[];
  try {
    names = readdirSync(layout.handoffDir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const file = path.join(layout.handoffDir, name);
      try {
        const stat = statSync(file);
        const match = /^([^.]+)(?:\.([a-z0-9]+))?-\d{8}-\d{6}\.md$/.exec(name);
        return {
          path: file,
          name,
          dispatcherId: match?.[1] ?? null,
          laneId: match?.[2] ?? null,
          modifiedAt: stat.mtime.toISOString(),
          size: stat.size,
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, limit);
}

const DOC_LIMIT = 256 * 1024;

/** Reads a text file that lives inside the dispatch home; refuses anything outside it. */
export function readDocument(layout: Layout, file: string) {
  const target = canonical(file);
  if (!isInside(canonical(layout.home), target)) throw new Error(`只能查看调度目录内的文件：${file}`);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`不是文件：${file}`);
  const raw = readFileSync(target, "utf8");
  return {
    path: target,
    modifiedAt: stat.mtime.toISOString(),
    truncated: raw.length > DOC_LIMIT,
    content: raw.length > DOC_LIMIT ? raw.slice(0, DOC_LIMIT) : raw,
  };
}
