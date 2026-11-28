import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LaneView } from "../shared/contracts";
import { laneNeeds, type Need } from "../shared/needs";
import { DecidedForYou, Decisions } from "./decisions";
import { LaneActivity } from "./lane-activity";
import { LaneReports } from "./reports";
import { ReviewLine } from "./review";
import { focusRequirement, requirementTitle } from "../shared/lane-text";
import { RequirementList } from "./requirements";
import { StagePipeline } from "./stage";
import { Banner, Button, Chip, Glyph, StatusPill, duration, relativeTime, shortId, span, statusOf, tint, toneColor, useKit, type Tone } from "./ui";

const HANDOFF_SLOW_MS = 15 * 60_000;
const BUSY = new Set(["running", "initializing"]);

export interface CardActions {
  openAgent?: (agentId: string) => void;
  handoff: (lane: LaneView) => void;
  startSuccessor: (lane: LaneView) => void;
  cancelHandoff: (lane: LaneView) => void;
  archiveLane: (lane: LaneView) => void;
  dismissError: () => void;
  archive: (agentId: string) => void;
  openDoc: (path: string, title: string) => void;
  /** The user's go-ahead to merge the lane's branches back into the landing branch. */
  agreeMerge: (lane: LaneView, req?: string) => void;
  deploy: (lane: LaneView, req?: string) => void;
  pickStage: (lane: LaneView) => void;
  /** 催一下: a quiet lane's dispatcher picks up from its ledger. */
  nudge: (lane: LaneView) => void;
  push: (lane: LaneView, req?: string) => void;
  /** 不用部署: straight on to 推送. */
  skipDeploy: (lane: LaneView, req?: string) => void;
  /** 派审查: the dispatcher sends the one review a sensitive change needs before 合回. */
  requestReview: (lane: LaneView) => void;
  /** 不用审查: the user lets a sensitive change be merged back unreviewed. Asks first. */
  waiveReview: (lane: LaneView) => void;
  busy: boolean;
}

const NEED_ICON: Record<Need["kind"], string> = {
  conflict: "GitPullRequestClosed",
  error: "CircleAlert",
  permission: "ShieldAlert",
  gone: "Ghost",
  decision: "Gavel",
  reply: "MessageCircleReply",
  blocked: "Hand",
  stalled: "Hourglass",
  handoff: "ArrowRightLeft",
  review: "ShieldAlert",
  merge: "GitMerge",
  deploy: "Rocket",
  push: "Upload",
  archive: "CircleCheck",
};

function Step({ done, active, label }: { done: boolean; active: boolean; label: string }) {
  const { theme, s } = useKit();
  const color = done ? theme.colors.statusSuccess : active ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return (
    <View style={[s.row, { gap: 6 }]}>
      <Glyph name={done ? "CircleCheck" : active ? "LoaderCircle" : "Circle"} size={14} color={color} />
      <Text style={{ color: done || active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12 }}>
        {label}
      </Text>
    </View>
  );
}

export function projectNames(lane: Pick<LaneView, "projects">): string {
  return lane.projects.map((project) => project.name).join(" + ");
}

/**
 * A lane is named by its requirement — the one it is on now, when it took on several — and the projects it holds are
 * the fallback.
 */
export function laneLabel(lane: Pick<LaneView, "projects" | "summary" | "id"> & { ledger?: Pick<LaneView["ledger"], "requirements"> }): string {
  const focus = focusRequirement(lane.ledger?.requirements);
  return requirementTitle(focus?.text ?? lane.summary) ?? (projectNames(lane) || `会话线 ${lane.id}`);
}

/**
 * What the 部署 / 推送 dialog is about: the lane, or one requirement of a lane holding several. A sensitive change
 * counts as unreviewed only when the review it waits for is not one that already covered this requirement.
 */
export function shipTarget(dispatcherId: string, lane: LaneView, req?: string) {
  const item = req ? lane.ledger.requirements.find((entry) => entry.id === req) : undefined;
  const missing = lane.review?.state === "needed" && !(req && lane.review.covered.includes(req));
  return {
    dispatcherId,
    laneId: lane.id,
    title: item ? `${item.id} ${requirementTitle(item.text) ?? item.text}` : laneLabel(lane),
    reviewMissing: missing ? lane.review!.kinds : null,
    req: item ? req : undefined,
  };
}

export function LaneRow({
  lane,
  dispatcherId,
  actions,
  dispatcherName,
}: {
  lane: LaneView;
  dispatcherId: string;
  actions: CardActions;
  /** Shown only when several dispatchers share the list. */
  dispatcherName?: string;
}) {
  const { theme, s } = useKit();
  const agent = lane.agent;
  const status = agent?.status ?? null;
  const tone = statusOf(status).tone;
  const accent = toneColor(theme, tone);
  const pending = lane.pendingHandoff;
  const busy = status !== null && BUSY.has(status);
  const elapsed = pending ? Date.now() - Date.parse(pending.requestedAt) : 0;

  const landings = [...new Set(lane.projects.flatMap((project) => (project.landing ?? project.branch ? [project.landing ?? project.branch] : [])))];
  const needs = laneNeeds(lane);
  const urgent = needs.some((need) => need.tone === "danger" || need.tone === "warning");
  const gate = needs.find((need) => need.kind === "merge" || need.kind === "deploy" || need.kind === "push" || need.kind === "archive");
  const stalled = needs.some((need) => need.kind === "stalled");
  const reviewDue = needs.some((need) => need.kind === "review");
  const openLedger = () => actions.openDoc(lane.ledger.path, `台账 · ${laneLabel(lane)}`);
  const live = !!agent && status !== "archived";
  const meta: { key: string; node: ReactNode }[] = [
    {
      key: "projects",
      node: (
        <View style={[s.row, { gap: 4 }]}>
          <Glyph name={lane.projects.length > 1 ? "Layers" : "FolderGit2"} size={12} />
          <Text style={s.muted}>{projectNames(lane) || "未绑定项目"}</Text>
        </View>
      ),
    },
    ...(landings.length > 0
      ? [
          {
            key: "landing",
            node: (
              <View style={[s.row, { gap: 4 }]} accessibilityHint="本线的改动最后都合回这个分支">
                <Glyph name="GitMerge" size={12} />
                <Text style={s.muted}>收口 {landings.join("、")}</Text>
              </View>
            ),
          },
        ]
      : []),
    ...(dispatcherName ? [{ key: "who", node: <Text style={s.muted}>{dispatcherName}</Text> }] : []),
    {
      key: "time",
      node: agent?.runningSince ? (
        <Text style={[s.muted, { color: accent }]}>本轮已 {duration(agent.runningSince)}</Text>
      ) : agent?.lastActivityAt ? (
        <Text style={s.muted}>活跃于 {relativeTime(agent.lastActivityAt)}</Text>
      ) : null,
    },
    {
      key: "effort",
      node: (
        <Text style={s.muted} accessibilityHint="这个需求开了多久、派了多少张卡、几张出了问题">
          已用 {span(lane.startedAt)} · 派单 {lane.effort.dispatched}
          {lane.effort.troubles > 0 ? <Text style={{ color: theme.colors.statusWarning }}>（出问题 {lane.effort.troubles}）</Text> : null}
        </Text>
      ),
    },
    { key: "id", node: <Text style={s.mono}>{lane.id}</Text> },
  ];

  return (
    <View style={[s.card, { gap: 12 }, urgent ? { borderColor: tint(theme.colors.statusWarning, 0.55) } : null]}>
      <View style={[s.spread, { alignItems: "flex-start" }]}>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={[s.h3, { fontSize: 15, lineHeight: 21 }]} numberOfLines={2}>
            {laneLabel(lane)}
          </Text>
          <View style={[s.wrap, { gap: 8, rowGap: 4 }]}>
            {meta
              .filter((item) => item.node)
              .map((item, index) => (
                <View key={item.key} style={[s.row, { gap: 8 }]}>
                  {index > 0 ? <View style={s.dot} /> : null}
                  {item.node}
                </View>
              ))}
          </View>
          {lane.summary && laneLabel(lane) !== lane.summary.trim() ? (
            <Text style={[s.muted, { lineHeight: 18 }]} numberOfLines={2}>
              {lane.summary}
            </Text>
          ) : null}
          {lane.ledger.acceptance ? (
            <View style={[s.row, { alignItems: "flex-start", gap: 6 }]}>
              <View style={{ paddingTop: 2 }}>
                <Glyph name="ClipboardCheck" size={12} />
              </View>
              <Text style={[s.muted, { flex: 1, lineHeight: 18 }]} numberOfLines={2}>
                验收：{lane.ledger.acceptance}
              </Text>
            </View>
          ) : null}
          <ReviewLine review={lane.review} />
        </View>
        <StatusPill status={status} />
      </View>

      <View style={{ gap: 8 }}>
        <View style={[s.row, { gap: 10 }]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <StagePipeline stage={lane.stage} />
          </View>
          {live ? <Button small variant="ghost" icon="ListChecks" hint="改阶段" onPress={() => actions.pickStage(lane)} /> : null}
        </View>
        <RequirementList lane={lane} />
        {lane.ledger.next || lane.stage?.note || !lane.stage ? (
          <View style={[s.row, { alignItems: "flex-start", gap: 6 }]}>
            <View style={{ paddingTop: 2 }}>
              <Glyph name="CornerDownRight" size={12} />
            </View>
            <Text style={[s.small, { flex: 1, lineHeight: 18 }]} numberOfLines={2}>
              {lane.ledger.next
                ? `下一步：${lane.ledger.next}`
                : lane.stage?.note
                  ? lane.stage.note
                  : "调度员还没在台账里写「阶段」，等它下次更新台账"}
            </Text>
          </View>
        ) : null}
      </View>

      {needs.length > 0 || lane.runningWorkers ? (
        <View style={[s.wrap, { gap: 6 }]}>
          {needs.map((need) => (
            <Chip key={need.kind} icon={NEED_ICON[need.kind]} label={need.label} tone={need.tone as Tone} />
          ))}
          {lane.runningWorkers ? (
            <Pressable accessibilityRole="button" accessibilityLabel="查看本线台账" onPress={openLedger}>
              <Chip icon="Activity" label={`在跑 ${lane.runningWorkers}`} tone="accent" />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <LaneReports reports={lane.reports} openDoc={actions.openDoc} />

      <LaneActivity lane={lane} openAgent={actions.openAgent} />

      <Decisions lane={lane} dispatcherId={dispatcherId} />
      <DecidedForYou lane={lane} openAgent={actions.openAgent} />

      {agent?.lastError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }} numberOfLines={2}>
          {agent.lastError}
        </Text>
      ) : null}
      {!agent ? (
        <Text style={s.muted}>调度员会话已不存在。在上面「新需求」里选这个需求补充一句，会从本线台账重启；或者直接归档。</Text>
      ) : null}

      {pending ? (
        <Banner
          tone="warning"
          icon="ArrowRightLeft"
          title={`${pending.written && !busy ? "交接就绪 · 等待手动接班" : "准备交接中"} · 已 ${duration(pending.requestedAt)}`}
          actions={
            <>
              {pending.written ? (
                <Button small icon="FileText" label="查看交接" onPress={() => actions.openDoc(pending.handoffPath, "交接")} />
              ) : null}
              {pending.written ? (
                <Button small variant="primary" icon="Play" label="手动启动接班" disabled={actions.busy || busy} onPress={() => actions.startSuccessor(lane)} />
              ) : null}
              <Button small variant="danger" icon="X" label="取消换班" onPress={() => actions.cancelHandoff(lane)} />
            </>
          }
        >
          <View style={{ gap: 4 }}>
            <Step done active={false} label={`已通知 ${shortId(pending.fromAgentId)} 写交接`} />
            <Step done={pending.written} active={!pending.written} label="旧调度员写交接、更新本线台账" />
            <Step done={false} active={pending.written} label="交接就绪后，由你手动启动接班（沿用本线项目与台账）" />
          </View>
          {elapsed > HANDOFF_SLOW_MS && (!pending.written || busy) ? (
            <Text style={s.small}>等得有点久了。打开旧会话看看是否卡住；确认它不会再写交接时，取消换班后归档或重新指派。</Text>
          ) : null}
        </Banner>
      ) : null}

      <View
        style={[
          s.spread,
          { flexWrap: "wrap", paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border },
        ]}
      >
        <View style={s.wrap}>
          {stalled && live ? (
            <Button small variant="primary" icon="BellRing" label="催一下" disabled={actions.busy || busy} onPress={() => actions.nudge(lane)} />
          ) : null}
          {reviewDue && live ? (
            <>
              <Button
                small
                variant="primary"
                icon="ShieldCheck"
                label="派审查"
                hint="让调度员派审查角色只读审查一次，问题清单交你"
                disabled={actions.busy || busy}
                onPress={() => actions.requestReview(lane)}
              />
              <Button small variant="ghost" icon="ShieldOff" label="不用审查" onPress={() => actions.waiveReview(lane)} />
            </>
          ) : null}
          {gate?.kind === "merge" && live ? (
            <Button small variant="primary" icon="GitMerge" label={gate.req ? `同意合回 ${gate.req}` : "同意合回"} disabled={actions.busy || busy} onPress={() => actions.agreeMerge(lane, gate.req)} />
          ) : null}
          {gate?.kind === "deploy" && live ? (
            <>
              <Button small variant="primary" icon="Rocket" label={gate.req ? `部署 ${gate.req}` : "部署"} disabled={actions.busy || busy} onPress={() => actions.deploy(lane, gate.req)} />
              <Button small variant="ghost" icon="SkipForward" label="不用部署" hint="跳过部署，直接到推送" onPress={() => actions.skipDeploy(lane, gate.req)} />
            </>
          ) : null}
          {gate?.kind === "push" ? (
            <Button small variant="primary" icon="Upload" label={gate.req ? `推送 ${gate.req}` : "推送"} disabled={actions.busy || busy} onPress={() => actions.push(lane, gate.req)} />
          ) : null}
          {gate?.kind === "archive" ? (
            <Button
              small
              variant="primary"
              icon="Archive"
              label="归档"
              hint="需求做完了：归档这个调度员会话和它派出的执行会话，释放名额和项目"
              disabled={actions.busy || !!pending || busy}
              onPress={() => actions.archiveLane(lane)}
            />
          ) : null}
          {actions.openAgent && live ? (
            <Button
              small
              variant={gate || stalled || reviewDue ? "secondary" : "primary"}
              icon="SquareArrowOutUpRight"
              label="打开"
              onPress={() => actions.openAgent?.(lane.agentId)}
            />
          ) : null}
          <Button small icon="NotebookText" label="台账" onPress={openLedger} />
          {live ? (
            <Button
              small
              variant="ghost"
              icon="ArrowRightLeft"
              label="换班"
              hint="让旧调度员写交接，接班由你手动启动"
              disabled={actions.busy || !!pending || busy}
              onPress={() => actions.handoff(lane)}
            />
          ) : null}
        </View>
        {status !== "archived" && gate?.kind !== "archive" ? (
          <Button
            small
            variant="ghost"
            icon="Archive"
            label="归档"
            hint="归档这个调度员会话和它派出的执行会话，释放名额和项目"
            disabled={actions.busy || !!pending || busy}
            onPress={() => actions.archiveLane(lane)}
          />
        ) : null}
      </View>
    </View>
  );
}
