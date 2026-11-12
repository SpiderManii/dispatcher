import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const handoffInfo = z.object({
  fromAgentId: z.string(),
  handoffPath: z.string(),
  requestedAt: z.string(),
  /** The old dispatcher has already written a non-empty handoff file. */
  written: z.boolean(),
});

const historyEntry = z.object({
  agentId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  reason: z.string(),
  laneId: z.string().nullable(),
  /** Live status for retired sessions, so they can be archived from the center. */
  status: z.string().nullable(),
});

export const agentInfo = z.object({
  id: z.string(),
  status: z.string().nullable(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  runningSince: z.string().nullable(),
  requiresAttention: z.boolean(),
  attentionReason: z.string().nullable(),
  pendingPermissions: z.number(),
  lastError: z.string().nullable(),
});
export type AgentInfo = z.infer<typeof agentInfo>;

export const projectView = z.object({
  id: z.string(),
  name: z.string(),
  repos: z.array(z.string()),
  projectDoc: z.string().nullable(),
  docExists: z.boolean(),
  statusDir: z.string().nullable(),
  note: z.string().nullable(),
});
export type ProjectView = z.infer<typeof projectView>;

const ledgerView = z.object({
  path: z.string(),
  exists: z.boolean(),
  updatedAt: z.string().nullable(),
  pendingDecisions: z.number(),
  /** Open `- [ ]` items under 待用户拍板. */
  decisions: z.array(z.object({ line: z.string(), text: z.string(), hasRecommendation: z.boolean() })),
  /** Plain items there, with no checkbox: not counted, shown so nothing open hides behind the old format. */
  unmarkedDecisions: z.number(),
});

export const laneProjectView = z.object({
  key: z.string(),
  name: z.string(),
  path: z.string(),
  branch: z.string().optional(),
  /** 收口分支: where the lane's work ends up. */
  landing: z.string().optional(),
});
export type LaneProjectView = z.infer<typeof laneProjectView>;

/** One parallel dispatcher session ("会话线"). */
export const laneView = z.object({
  id: z.string(),
  agentId: z.string(),
  agent: agentInfo.nullable(),
  projects: z.array(laneProjectView),
  summary: z.string().nullable(),
  startedAt: z.string(),
  rulesHash: z.string().nullable(),
  ledger: ledgerView,
  /** Asked of Paseo, not read from the ledger, whose rows outlive the sessions. null when Paseo couldn't answer. */
  runningWorkers: z.number().nullable(),
  pendingHandoff: handoffInfo.nullable(),
});
export type LaneView = z.infer<typeof laneView>;

export const dispatcherView = z.object({
  id: z.string(),
  name: z.string(),
  directory: z.string(),
  workspaceId: z.string().nullable(),
  launch: z.string(),
  projects: z.array(projectView),
  lanes: z.array(laneView),
  rulesStale: z.boolean(),
  agentsPath: z.string(),
  boardPath: z.string(),
  lastError: z.string().nullable(),
  /** Workspace IDs in `lastError` that a push would let go; the banner offers 「推送并归档」. */
  pushableKept: z.array(z.string()),
  history: z.array(historyEntry),
});
export type DispatcherView = z.infer<typeof dispatcherView>;

export const handoffFile = z.object({
  path: z.string(),
  name: z.string(),
  dispatcherId: z.string().nullable(),
  laneId: z.string().nullable(),
  modifiedAt: z.string(),
  size: z.number(),
});
export type HandoffFile = z.infer<typeof handoffFile>;

const overviewOutput = z.object({
  home: z.string(),
  registryPath: z.string(),
  rulesFile: z.string().nullable(),
  rulesHash: z.string().nullable(),
  limits: z.object({ sessions: z.number(), sessionsPerProject: z.number() }),
  problems: z.array(z.string()),
  dispatchers: z.array(dispatcherView),
  handoffs: z.array(handoffFile),
  checkedAt: z.string(),
  /** The worker watch that wakes dispatchers in place of heartbeats. */
  watch: z.object({ startedAt: z.string().nullable(), lastScanAt: z.string().nullable(), error: z.string().nullable() }),
});
export type Overview = z.infer<typeof overviewOutput>;

export const overviewRpc = defineRpc({
  name: "dispatch.overview",
  input: z.object({}),
  output: overviewOutput,
});

const option = z.object({ id: z.string(), label: z.string() });

/** What the daemon can launch, trimmed to what the role editor needs. */
export const providerCatalog = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    enabled: z.boolean(),
    status: z.string(),
    models: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        isDefault: z.boolean(),
        thinking: z.array(option),
        defaultThinking: z.string().nullable(),
      }),
    ),
    modes: z.array(option),
    defaultModeId: z.string().nullable(),
  }),
);
export type ProviderCatalog = z.infer<typeof providerCatalog>;

/** One fallback as stored in 项目登记.json: a Paseo Agent config by name, or a `provider/model` set right here. */
export const candidateInput = z
  .object({
    profile: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    modeId: z.string().trim().min(1).optional(),
    thinkingOptionId: z.string().trim().min(1).optional(),
  })
  .refine((item) => Boolean(item.profile) !== Boolean(item.provider), "profile 和 provider 只能且必须写一个");
export type CandidateInput = z.infer<typeof candidateInput>;

/** A launch config shown on the page: what it resolves to now, or why it can't be used. */
const resolvedView = z.object({ label: z.string(), ok: z.boolean(), problem: z.string().nullable() });

export const rolesOutput = z.object({
  roles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      when: z.string(),
      /** In the order dispatch_work tries them. */
      candidates: z.array(resolvedView.extend({ source: candidateInput })),
      /** Set when the role has no candidates and runs on the first ready provider. */
      auto: resolvedView.nullable(),
    }),
  ),
  /** False while the registry has no `roles` and the built-in table applies. */
  customRoles: z.boolean(),
  dispatchers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** The registry's own fields; `profileId` falls back to `defaultProfileId`. */
      source: z.object({
        provider: z.string().nullable(),
        profileId: z.string().nullable(),
        modeId: z.string().nullable(),
        thinkingOptionId: z.string().nullable(),
      }),
      launch: resolvedView,
    }),
  ),
  profiles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      provider: z.string(),
      modeId: z.string().nullable(),
      thinkingOptionId: z.string().nullable(),
    }),
  ),
  unusedProfiles: z.array(z.object({ id: z.string(), name: z.string() })),
  profileCount: z.number(),
  profilesError: z.string().nullable(),
  catalogError: z.string().nullable(),
  running: z.object({ total: z.number(), claude: z.number() }).nullable(),
  limits: z.object({ agents: z.number(), claudeAgents: z.number() }),
});
export type RolesView = z.infer<typeof rolesOutput>;

export const rolesRpc = defineRpc({
  name: "dispatch.roles",
  input: z.object({}),
  output: rolesOutput,
});

export const providerCatalogRpc = defineRpc({
  name: "dispatch.provider-catalog",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({ providers: providerCatalog, error: z.string().nullable() }),
});

const roleSlug = z.string().regex(/^[a-z][a-z0-9-]*$/, "角色 ID 只能用小写字母、数字和连字符，且以字母开头");

/** Writes the role table and dispatcher launch configs from the 「Agent 分工」 editor into 项目登记.json. */
export const saveAgentsRpc = defineRpc({
  name: "dispatch.save-agents",
  input: z.object({
    /** Null removes `roles` from the registry, putting the built-in table back. */
    roles: z
      .array(
        z.object({
          id: roleSlug,
          name: z.string().trim().min(1),
          when: z.string().trim().min(1),
          candidates: z.array(candidateInput),
        }),
      )
      .nullable(),
    dispatchers: z.array(
      z.object({
        id: z.string(),
        /** Null for each field clears it from the registry. */
        provider: z.string().nullable(),
        profileId: z.string().nullable(),
        modeId: z.string().nullable(),
        thinkingOptionId: z.string().nullable(),
      }),
    ),
  }),
  output: z.object({ ok: z.literal(true) }),
});

/** Answers open decisions from the page: ticks them in the ledger, then tells the lane's dispatcher once it is idle. */
export const answerDecisionsRpc = defineRpc({
  name: "dispatch.answer-decisions",
  input: z.object({
    dispatcherId: z.string().min(1),
    laneId: z.string().min(1),
    /** Ledger lines exactly as the page showed them. */
    lines: z.array(z.string().min(1)).min(1),
    answer: z.string().trim().min(1).max(4000),
  }),
  output: z.object({ queued: z.boolean() }),
});

export const startRpc = defineRpc({
  name: "dispatch.start",
  input: z.object({
    dispatcherId: z.string().min(1),
    task: z.string().optional(),
  }),
  output: z.object({ agentId: z.string(), workspaceId: z.string(), laneId: z.string() }),
});

export const targetView = z.object({
  path: z.string(),
  name: z.string(),
  projectId: z.string().nullable(),
  owner: z.string().nullable(),
  ownerName: z.string().nullable(),
  configured: z.boolean(),
  isGit: z.boolean(),
  exists: z.boolean(),
  /** Lanes currently holding this project (any dispatcher). */
  holders: z.array(
    z.object({
      dispatcherId: z.string(),
      laneId: z.string(),
      agentId: z.string(),
      summary: z.string().nullable(),
      branch: z.string().nullable(),
    }),
  ),
});
export type TargetView = z.infer<typeof targetView>;

/** Local branches of a picked folder, for choosing what to work on. Read-only. */
export const branchesRpc = defineRpc({
  name: "dispatch.branches",
  input: z.object({ path: z.string().min(1) }),
  output: z.object({
    branches: z.array(z.object({ name: z.string(), worktree: z.string().nullable(), current: z.boolean() })),
  }),
});

/** `base` means the branch is to be created from it; without one the branch must already exist. */
export const branchChoice = z.object({
  name: z.string().trim().min(1),
  base: z.string().trim().min(1).optional(),
});
export type BranchChoice = z.infer<typeof branchChoice>;

/** Resolves picked folders to registered projects and suggests the lead dispatcher. */
export const resolveTargetsRpc = defineRpc({
  name: "dispatch.resolve-targets",
  input: z.object({ paths: z.array(z.string().min(1)).min(1) }),
  output: z.object({
    targets: z.array(targetView),
    suggestedDispatcherId: z.string().nullable(),
  }),
});

/** Sends a task with one or more target folders to a dispatcher, starting a session when none is on duty. */
export const assignRpc = defineRpc({
  name: "dispatch.assign",
  input: z.object({
    paths: z.array(z.string().min(1)).min(1),
    dispatcherId: z.string().min(1),
    task: z.string().optional(),
    /** Per selected folder; a folder left out lets the dispatcher decide as before. */
    branches: z.record(z.string(), branchChoice).optional(),
    /** Send to this lane (it takes on any selected project it does not hold yet). */
    laneId: z.string().optional(),
    /** Open a new lane even when an existing one already holds every selected project. */
    newLane: z.boolean().optional(),
    /** The user confirmed this work does not touch what other lanes on the same projects are doing. */
    confirmIndependent: z.boolean().optional(),
    /** Screenshots or mockups for the task, base64 without the `data:` prefix. Limits are checked on the server. */
    images: z
      .array(z.object({ name: z.string().optional(), mimeType: z.string().min(1), data: z.string().min(1) }))
      .optional(),
  }),
  output: z.object({
    dispatcherId: z.string(),
    laneId: z.string(),
    agentId: z.string(),
    workspaceId: z.string().nullable(),
    delivery: z.enum(["sent", "started"]),
  }),
});

export const browseRpc = defineRpc({
  name: "dispatch.browse",
  input: z.object({ path: z.string().optional(), showHidden: z.boolean().optional() }),
  output: z.object({
    path: z.string(),
    parent: z.string().nullable(),
    home: z.string(),
    isGit: z.boolean(),
    truncated: z.boolean(),
    entries: z.array(z.object({ name: z.string(), path: z.string(), isGit: z.boolean() })),
    /** Shortcuts: registered repos and folders Paseo already knows as projects. */
    shortcuts: z.array(
      z.object({ label: z.string(), path: z.string(), source: z.enum(["registry", "paseo", "home"]) }),
    ),
  }),
});

export const readDocRpc = defineRpc({
  name: "dispatch.read-doc",
  input: z.object({ path: z.string().min(1) }),
  output: z.object({
    path: z.string(),
    content: z.string(),
    modifiedAt: z.string(),
    truncated: z.boolean(),
  }),
});

export const handoffRpc = defineRpc({
  name: "dispatch.handoff",
  input: z.object({
    dispatcherId: z.string().optional(),
    laneId: z.string().optional(),
    agentId: z.string().optional(),
  }),
  output: z.object({
    dispatcherId: z.string(),
    laneId: z.string(),
    fromAgentId: z.string(),
    handoffPath: z.string(),
  }),
});

export const startSuccessorRpc = defineRpc({
  name: "dispatch.start-successor",
  input: z.object({ dispatcherId: z.string().min(1), laneId: z.string().min(1) }),
  output: z.object({ agentId: z.string(), workspaceId: z.string(), laneId: z.string() }),
});

export const cancelHandoffRpc = defineRpc({
  name: "dispatch.cancel-handoff",
  input: z.object({ dispatcherId: z.string().min(1), laneId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export const dismissErrorRpc = defineRpc({
  name: "dispatch.dismiss-error",
  input: z.object({ dispatcherId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export const archiveRpc = defineRpc({
  name: "dispatch.archive",
  input: z.object({ dispatcherId: z.string().min(1), agentId: z.string().min(1) }),
  output: z.object({ archivedAt: z.string() }),
});

export const workspaceItem = z.object({
  id: z.string(),
  name: z.string(),
  project: z.string(),
  directory: z.string(),
  branch: z.string().nullable(),
  activityAt: z.string().nullable(),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  removesDirectory: z.boolean(),
  /** The remote a push would save the branch to, when its commits exist nowhere else. */
  pushTo: z.string().nullable(),
});
export type WorkspaceItem = z.infer<typeof workspaceItem>;

/** Checked only when asked for: it runs Git in every workspace. */
export const workspacesRpc = defineRpc({
  name: "dispatch.workspaces",
  input: z.object({}),
  output: z.object({ workspaces: z.array(workspaceItem) }),
});

/** Re-checks each one first, so a workspace that changed since the list was drawn is skipped, not archived. */
export const archiveWorkspacesRpc = defineRpc({
  name: "dispatch.archive-workspaces",
  input: z.object({ ids: z.array(z.string().min(1)).min(1) }),
  output: z.object({
    archived: z.array(z.string()),
    skipped: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string() })),
  }),
});

/** Drops archived dispatcher sessions from the page. Paseo keeps them archived; entries still needed stay. */
export const clearArchivedRpc = defineRpc({
  name: "dispatch.clear-archived",
  input: z.object({}),
  output: z.object({ cleared: z.number(), workersLeft: z.number(), laneOpen: z.number() }),
});

/** Pushes each branch whose commits exist only locally, never forced, then archives under the same re-checks. */
export const pushArchiveWorkspacesRpc = defineRpc({
  name: "dispatch.push-archive-workspaces",
  input: z.object({ ids: z.array(z.string().min(1)).min(1), dispatcherId: z.string().min(1).optional() }),
  output: z.object({
    pushed: z.array(z.string()),
    archived: z.array(z.string()),
    skipped: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string() })),
  }),
});

const cascadeResult = z.object({
  archived: z.number(),
  running: z.number(),
  failed: z.number(),
  workspacesArchived: z.number(),
  /** Left in place because archiving them could cost work; each says why. */
  workspacesKept: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type CascadeResult = z.infer<typeof cascadeResult>;

/** Archives a lane's session and the workers it started, and frees its seat. The ledger stays. */
export const archiveLaneRpc = defineRpc({
  name: "dispatch.archive-lane",
  /** `force` archives although some branch is not merged into the landing branch yet. */
  input: z.object({ dispatcherId: z.string().min(1), laneId: z.string().min(1), force: z.boolean().optional() }),
  output: cascadeResult,
});

const unlandedBranch = z.object({ project: z.string(), branch: z.string(), landing: z.string() });

/** The lane's landing branches, and the branches its workers left that are not merged into them yet. Read-only. */
export const laneLandingRpc = defineRpc({
  name: "dispatch.lane-landing",
  input: z.object({ dispatcherId: z.string().min(1), laneId: z.string().min(1) }),
  output: z.object({ landings: z.array(z.object({ project: z.string(), landing: z.string() })), unlanded: z.array(unlandedBranch) }),
});

/** Tells the lane's dispatcher to merge those branches back, with the user's go-ahead. */
export const landLaneRpc = defineRpc({
  name: "dispatch.land-lane",
  input: z.object({ dispatcherId: z.string().min(1), laneId: z.string().min(1) }),
  output: z.object({ sent: z.boolean(), unlanded: z.array(unlandedBranch) }),
});

/** Workers and their workspaces whose dispatcher was archived. Running ones are left to finish. */
export const archiveLeftoversRpc = defineRpc({
  name: "dispatch.archive-leftovers",
  input: z.object({}),
  output: cascadeResult,
});

export const syncRpc = defineRpc({
  name: "dispatch.sync",
  input: z.object({}),
  output: z.object({ written: z.array(z.string()), problems: z.array(z.string()) }),
});
