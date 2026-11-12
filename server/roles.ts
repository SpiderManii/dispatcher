import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProviderCatalog } from "../shared/contracts";
import { canonical, expandHome, isInside, type Registry, type RoleDef } from "./core";
import { mustBlock } from "./work-card-text";

export { cardFeedback } from "./work-card-text";


/**
 * The role table when 项目登记.json has no `roles`. No models are named here: every role starts on the first ready
 * provider, and the 「Agent 分工」 editor writes the real choices back into the registry.
 */
export const DEFAULT_ROLES: RoleDef[] = [
  { id: "split", name: "拆分", when: "新需求、多步骤、多文件：先出计划再派施工", candidates: [] },
  {
    id: "backend",
    name: "后端",
    when: "后端与运维：写后端代码；启动或重启后端服务、搭环境、连库；排查 500、SQL、日志、健康检查、端口、容器",
    candidates: [],
  },
  {
    id: "frontend",
    name: "前端",
    when: "前端：写和改页面、组件、样式；把原型图落成代码；检查页面、定位前端问题",
    candidates: [],
  },
  { id: "design", name: "设计", when: "只出 HTML 原型图（静态稿），不写业务逻辑", candidates: [] },
  {
    id: "test",
    name: "测试",
    when: "跑和写自动化测试、合并前独立接口测试；零碎小改；进度整理、决策记录。不接其他角色强项内的活",
    candidates: [],
  },
  { id: "review", name: "审查", when: "只读审查，不改代码", candidates: [] },
  { id: "architect", name: "架构", when: "L 级：架构、选型、方向未定", candidates: [] },
];

export function rolesOf(registry: Registry): RoleDef[] {
  return registry.roles ?? DEFAULT_ROLES;
}

export interface Profile {
  id: string;
  name?: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes?: string;
}

export interface ResolvedConfig {
  label: string;
  /** `provider/model`, the form Paseo's agent config takes. */
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  family: string | null;
  profileId: string | null;
}

/** Quota families from §4, plus Claude for the §1.4 cap. */
export function familyOf(provider: string): string | null {
  const text = provider.toLowerCase();
  if (text.includes("claude")) return "claude";
  if (text.includes("codex")) return "codex";
  if (text.includes("grok") || text.includes("cursor")) return "grok";
  if (text.includes("antigravity") || text.includes("gemini")) return "antigravity";
  return null;
}

/** Exact ID or name first, then a name containing the reference, as §3 names profiles loosely. */
export function matchProfile(profiles: Profile[], reference: string): Profile | string {
  const exact = profiles.find((item) => item.id === reference || item.name === reference);
  if (exact) return exact;
  const partial = profiles.filter((item) => item.name?.includes(reference));
  if (partial.length === 1) return partial[0];
  return partial.length > 1
    ? `「${reference}」对应多个 Agent 配置：${partial.map((item) => item.name).join("、")}`
    : `Agent 配置里没有「${reference}」`;
}

type Candidate = RoleDef["candidates"][number];

/** `codex/gpt-6.1-sol` → `codex`; model IDs may contain slashes themselves. */
export function providerIdOf(reference: string): string {
  return reference.split("/")[0];
}

/**
 * Whether the daemon can launch this `provider[/model]` right now. Without a catalog (it could not be read) every
 * reference passes, so a slow provider listing never blocks a dispatch.
 */
export function availability(reference: string, catalog: ProviderCatalog | null): string | null {
  if (!catalog) return null;
  const id = providerIdOf(reference);
  const entry = catalog.find((item) => item.id === id);
  if (!entry) return `Paseo 里没有 provider「${id}」`;
  if (!entry.enabled) return `${entry.label} 没有启用`;
  if (entry.status !== "ready") return `${entry.label} 当前不可用（${entry.status}）`;
  const model = reference.slice(id.length + 1);
  if (model && entry.models.length > 0 && !entry.models.some((item) => item.id === model))
    return `${entry.label} 没有模型「${model}」`;
  return null;
}

export function resolveCandidate(
  candidate: Candidate,
  profiles: Profile[],
  catalog: ProviderCatalog | null = null,
): ResolvedConfig | { problem: string } {
  const describe = (provider: string, thinking?: string) => (thinking ? `${provider} ${thinking}` : provider);
  if (candidate.provider) {
    const problem = availability(candidate.provider, catalog);
    if (problem) return { problem };
    return {
      label: describe(candidate.provider, candidate.thinkingOptionId),
      provider: candidate.provider,
      modeId: candidate.modeId,
      thinkingOptionId: candidate.thinkingOptionId,
      family: familyOf(candidate.provider),
      profileId: null,
    };
  }
  const match = matchProfile(profiles, candidate.profile ?? "");
  if (typeof match === "string") return { problem: match };
  const provider = match.model ? `${match.provider}/${match.model}` : match.provider;
  const problem = availability(provider, catalog);
  if (problem) return { problem: `${match.name ?? match.id}：${problem}` };
  const thinking = candidate.thinkingOptionId ?? match.thinkingOptionId;
  return {
    label: `${match.name ?? match.id}（${describe(provider, thinking)}）`,
    provider,
    modeId: candidate.modeId ?? match.modeId,
    thinkingOptionId: thinking,
    featureValues: match.featureValues,
    family: familyOf(provider),
    profileId: match.id,
  };
}

/**
 * The stand-in for a role (or dispatcher) with no model set: the first ready provider not avoided, on its default
 * model and thinking level.
 */
export function autoConfig(catalog: ProviderCatalog | null, avoid: string[] = []): ResolvedConfig | null {
  const avoided = new Set(avoid.map((item) => item.toLowerCase()));
  for (const entry of catalog ?? []) {
    if (!entry.enabled || entry.status !== "ready") continue;
    const model = entry.models.find((item) => item.isDefault) ?? entry.models[0];
    const provider = model ? `${entry.id}/${model.id}` : entry.id;
    const family = familyOf(provider);
    if (family && avoided.has(family)) continue;
    const thinking = model?.defaultThinking ?? undefined;
    return {
      label: `自动（${thinking ? `${provider} ${thinking}` : provider}）`,
      provider,
      thinkingOptionId: thinking,
      family,
      profileId: null,
    };
  }
  return null;
}

/** First usable candidate in the role's order; everything passed over is reported back to the dispatcher. */
export function pickCandidate(
  role: RoleDef,
  profiles: Profile[],
  avoid: string[],
  catalog: ProviderCatalog | null = null,
  /** Why this config can't take work right now (e.g. its quota is used up); null when it can. */
  blocked: (config: ResolvedConfig) => string | null = () => null,
) {
  const skipped: { label: string; reason: string }[] = [];
  if (role.candidates.length === 0) {
    const chosen = autoConfig(catalog, avoid);
    if (!chosen) skipped.push({ label: "自动", reason: catalog ? "没有就绪的 provider" : "读不到 provider 列表" });
    return { chosen, skipped };
  }
  const avoided = new Set(avoid.map((item) => item.toLowerCase()));
  for (const candidate of role.candidates) {
    const resolved = resolveCandidate(candidate, profiles, catalog);
    if ("problem" in resolved) {
      skipped.push({ label: candidate.profile ?? candidate.provider ?? "?", reason: resolved.problem });
    } else if (resolved.family && avoided.has(resolved.family)) {
      skipped.push({ label: resolved.label, reason: `调度员要求避开 ${resolved.family}` });
    } else if (blocked(resolved)) {
      skipped.push({ label: resolved.label, reason: blocked(resolved) as string });
    } else {
      return { chosen: resolved, skipped };
    }
  }
  return { chosen: null, skipped };
}

const required = (description: string) => z.string().trim().min(1).describe(description);

/** Every field §5 says a task card cannot go out without, minus what the plugin fills in itself. */
export const workCardSchema = z.object({
  role: required("角色 ID，见工具说明里的角色表"),
  reason: required("一句话：这活为什么归这个角色"),
  title: required("「角色-任务-页/模块」，同时作工作区名和会话名"),
  cwd: required("目标 worktree 的绝对路径"),
  branch: required("预期分支"),
  task: required("要做什么，验收口径是什么"),
  scope: required("改什么、不改什么，最多 3 行，只写范围，不重复「任务」里的步骤"),
  files: required("点名文件，没有写「无」"),
  testCommand: required("测试命令原文，不跑写「无」"),
  commitCommand: required("提交命令原文（含 §5 要求的提交身份和提交前步骤），不提交写「无」"),
  statusFile: required("状态文件绝对路径"),
  notes: z.string().optional().describe("其他要交代的，只写前面各栏没有的信息，可不填"),
  head: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i, "预期 HEAD 要写提交 SHA")
    .optional()
    .describe("预期 HEAD SHA。在已有提交上复跑、验收、续做时填；插件派出前核对 cwd 的 HEAD，并写进卡头"),
  avoid: z
    .array(z.string())
    .optional()
    .describe("本次要避开的家：codex、grok、antigravity、claude。额度插件已查；只在撞了限流或用户点名避开时填"),
});
export type WorkCard = z.infer<typeof workCardSchema>;

export function checkCard(card: WorkCard, dispatchHome: string): string[] {
  const problems: string[] = [];
  if (!card.title.includes("-")) problems.push(`标题「${card.title}」不符合「角色-任务-页/模块」`);
  if (/^(ui(-.*)?|test|新会话)$/i.test(card.title)) problems.push(`标题「${card.title}」是 §5 禁用的名字`);
  const cwd = expandHome(card.cwd);
  if (!path.isAbsolute(cwd)) problems.push(`cwd 要写绝对路径：${card.cwd}`);
  else if (!existsSync(cwd)) problems.push(`cwd 不存在：${card.cwd}`);
  else if (isInside(canonical(dispatchHome), canonical(cwd)))
    problems.push("cwd 不能在调度目录里，要指向目标项目的仓库或 worktree");
  if (!path.isAbsolute(expandHome(card.statusFile))) problems.push(`状态文件要写绝对路径：${card.statusFile}`);
  return problems;
}

export function renderWorkPrompt(card: WorkCard, role: RoleDef): string {
  const notes = card.notes?.trim() ?? "";
  return [
    `# 任务卡：${card.title}`,
    `角色：${role.name}`,
    `cwd：${canonical(expandHome(card.cwd))}`,
    `预期分支：${card.branch}`,
    card.head ? `预期 HEAD：${card.head}` : null,
    `## 任务\n${card.task}`,
    `## 改与不改\n${card.scope}`,
    `## 点名文件\n${card.files}`,
    `## 测试命令（原文）\n${card.testCommand}`,
    `## 提交命令（原文）\n${card.commitCommand}`,
    `## 状态文件\n${card.statusFile}`,
    notes ? `## 其他\n${notes}` : null,
    mustBlock(card.head),
  ]
    .filter(Boolean)
    .join("\n\n");
}


export function renderRoleGuide(roles: RoleDef[]): string {
  return roles.map((role) => `- ${role.id}（${role.name}）：${role.when}`).join("\n");
}
