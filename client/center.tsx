import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  archiveLaneRpc,
  archiveRpc,
  cancelHandoffRpc,
  dismissErrorRpc,
  handoffRpc,
  landLaneRpc,
  laneLandingRpc,
  overviewRpc,
  pushArchiveWorkspacesRpc,
  nudgeRpc,
  queueActionRpc,
  requestReviewRpc,
  setStageRpc,
  startSuccessorRpc,
  syncRpc,
  waiveReviewRpc,
  type CascadeResult,
  type DispatcherView,
  type LaneView,
  type Overview,
} from "../shared/contracts";
import { laneNeeds, needRank, needsUser } from "../shared/needs";
import { AssignPanel } from "./assign-panel";
import { DeployDialog, type DeployTarget } from "./deploy-dialog";
import { mergeRequest } from "./merge-request";
import { waiveRequest } from "./review";
import { PushDialog, type PushTarget } from "./push-dialog";
import { QueueList } from "./queue-list";
import { StagePicker } from "./stage";
import { ConfirmDialog, DocViewer, type ConfirmRequest, type DocTarget } from "./dialogs";
import { LaneRow, laneLabel, shipTarget, type CardActions } from "./lane-row";
import { RetiredSessions } from "./retired-sessions";
import { RolesPanel } from "./roles-panel";
import { WorkspaceCleanup } from "./workspace-cleanup";
import { Banner, Button, Chip, Glyph, KitProvider, Section, StatStrip, basename, errorText, relativeTime, shortId, tint, useKit } from "./ui";

/** The watch replaces heartbeats, so say so when it errors or has stopped scanning. */
function watchProblem(overview: Overview): string | null {
  const { startedAt, lastScanAt, error } = overview.watch;
  if (error) return `巡检出错：${error}`;
  const now = Date.now();
  if (!startedAt || now - Date.parse(startedAt) < 60_000) return null;
  if (!lastScanAt) return "巡检启动后一次都没跑完";
  if (now - Date.parse(lastScanAt) > 90_000) return `上次巡检是 ${Math.round((now - Date.parse(lastScanAt)) / 60_000)} 分钟前`;
  return null;
}

export function DispatchCenterScreen(props: PluginScreenProps) {
  return (
    <KitProvider theme={props.theme} compact={props.layout.compact}>
      <Center {...props} />
    </KitProvider>
  );
}

function Center({ navigation }: PluginScreenProps) {
  const { s, compact, theme } = useKit();
  const toast = useToast();
  const queryClient = useQueryClient();
  const loadOverview = useRpc(overviewRpc);
  const callHandoff = useRpc(handoffRpc);
  const callSuccessor = useRpc(startSuccessorRpc);
  const callCancel = useRpc(cancelHandoffRpc);
  const callDismiss = useRpc(dismissErrorRpc);
  const callPushArchive = useRpc(pushArchiveWorkspacesRpc);
  const callArchive = useRpc(archiveRpc);
  const callArchiveLane = useRpc(archiveLaneRpc);
  const callLaneLanding = useRpc(laneLandingRpc);
  const callLandLane = useRpc(landLaneRpc);
  const callSync = useRpc(syncRpc);
  const callSetStage = useRpc(setStageRpc);
  const callQueueAction = useRpc(queueActionRpc);
  const callNudge = useRpc(nudgeRpc);
  const callRequestReview = useRpc(requestReviewRpc);
  const callWaiveReview = useRpc(waiveReviewRpc);

  const [doc, setDoc] = useState<DocTarget | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  // Roles and workspace cleanup are looked at now and then, not every day: folded away until asked for.
  const [showTools, setShowTools] = useState(false);
  const [deployTarget, setDeployTarget] = useState<DeployTarget | null>(null);
  const [pushTarget, setPushTarget] = useState<PushTarget | null>(null);
  const [stageTarget, setStageTarget] = useState<{ dispatcherId: string; lane: LaneView } | null>(null);

  const data = useQuery({
    queryKey: ["dispatch-center", "overview"],
    queryFn: () => loadOverview({}),
    refetchInterval: 5000,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["dispatch-center", "overview"] });
    // The sidebar badge counts the same things; clear it as soon as the user acts here.
    void queryClient.invalidateQueries({ queryKey: ["dispatch-center", "attention"] });
  };
  const report = (error: unknown) => toast.error(errorText(error));
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;

  const handoff = useMutation({
    mutationFn: callHandoff,
    onSuccess: (result) => {
      toast.show(`已通知会话线 ${result.laneId} 写交接，写完后等待你手动启动接班`, { variant: "info" });
      refresh();
    },
    onError: report,
  });
  const successor = useMutation({
    mutationFn: callSuccessor,
    onSuccess: (result) => {
      toast.show(`已手动启动接班会话 ${shortId(result.agentId)}`, { variant: "success" });
      refresh();
      openAgent?.(result.agentId);
    },
    onError: report,
  });
  const cancel = useMutation({ mutationFn: callCancel, onSuccess: refresh, onError: report });
  const dismiss = useMutation({ mutationFn: callDismiss, onSuccess: refresh, onError: report });
  const landLane = useMutation({
    mutationFn: callLandLane,
    onSuccess: ({ sent, unlanded }) => {
      toast.show(sent ? `已让调度员把 ${unlanded.length} 个分支合回收口分支，它说「已收口」后再归档` : "分支都已合回收口分支，可以归档", {
        variant: "success",
      });
      refresh();
    },
    onError: report,
  });
  const checkLanding = useMutation({ mutationFn: callLaneLanding, onError: report });
  const nudge = useMutation({
    mutationFn: callNudge,
    onSuccess: ({ sent }) => {
      toast.show(sent ? "已催调度员，它会先回一句卡在哪" : "调度员正在执行，不用催", { variant: sent ? "success" : "info" });
      refresh();
    },
    onError: report,
  });
  const requestReview = useMutation({
    mutationFn: callRequestReview,
    onSuccess: () => {
      toast.show("已让调度员派审查，审查结束前不能合回", { variant: "success" });
      refresh();
    },
    onError: report,
  });
  const waiveReview = useMutation({
    mutationFn: callWaiveReview,
    onSuccess: () => {
      toast.show("已记下不审查，可以同意合回了", { variant: "success" });
      refresh();
    },
    onError: report,
  });
  const queueAct = useMutation({
    mutationFn: callQueueAction,
    onSuccess: (_result, input) => {
      if (input.action === "cancel") toast.show("已取消排队", { variant: "success" });
      refresh();
    },
    onError: report,
  });
  const setStage = useMutation({
    mutationFn: callSetStage,
    onSuccess: (_result, input) => {
      toast.show(`阶段改成了「${input.word}」`, { variant: "success" });
      refresh();
    },
    onError: report,
  });
  const pushArchive = useMutation({
    mutationFn: callPushArchive,
    onSuccess: ({ pushed, archived, skipped }) => {
      const head = `已推送 ${pushed.length} 个分支（${pushed.join("、") || "无"}），归档 ${archived.length} 个工作区`;
      toast.show(skipped.length > 0 ? `${head}，${skipped.length} 个没有归档，原因见页面提示` : head, {
        variant: skipped.length > 0 ? "warning" : "success",
      });
      refresh();
    },
    onError: report,
  });
  const archive = useMutation({
    mutationFn: callArchive,
    onSuccess: () => {
      toast.show("旧会话已归档", { variant: "success" });
      refresh();
    },
    onError: report,
  });
  const showCascade = (lead: string, result: CascadeResult) => {
    const kept = result.workspacesKept;
    const reasons = [...new Set(kept.map((item) => item.reason))].slice(0, 3).join("\n");
    const parts = [
      `${lead}，执行会话 ${result.archived} 个${result.archived === 0 ? "（没有未归档的）" : ""}，工作区 ${result.workspacesArchived} 个`,
      result.running > 0 ? `${result.running} 个在跑，结束后自动归档` : "",
      result.failed > 0 ? `${result.failed} 个失败` : "",
      kept.length > 0 ? `${kept.length} 个工作区留着：\n${reasons}` : "",
    ];
    toast.show(parts.filter(Boolean).join("，"), { variant: result.failed > 0 || kept.length > 0 ? "warning" : "success" });
  };
  const archiveLane = useMutation({
    mutationFn: callArchiveLane,
    onSuccess: (result) => {
      showCascade("已归档会话线：调度员会话 1 个", result);
      refresh();
    },
    onError: report,
  });
  const sync = useMutation({
    mutationFn: callSync,
    onSuccess: (result) => {
      if (result.problems.length > 0) toast.show(result.problems.join("\n"), { variant: "warning" });
      else toast.show(`已同步 ${result.written.length} 个文件`, { variant: "success" });
      refresh();
    },
    onError: report,
  });
  const busy = handoff.isPending || successor.isPending || cancel.isPending || archive.isPending || archiveLane.isPending;

  const actionsFor = (item: DispatcherView): CardActions => ({
    busy,
    openAgent,
    openDoc: (path, title) => setDoc({ path, title }),
    handoff: (lane) =>
      setConfirm({
        title: `让会话线「${laneLabel(lane)}」换班？`,
        message:
          "旧调度员会写交接并更新本线台账，然后结束本轮。交接就绪后由你点击「手动启动接班」，沿用本线的项目和台账；旧会话保留。",
        confirmLabel: "准备交接",
        onConfirm: () => handoff.mutate({ dispatcherId: item.id, laneId: lane.id }),
      }),
    startSuccessor: (lane) =>
      setConfirm({
        title: "手动启动接班？",
        message: "现在创建接班调度员，读取本线交接和台账继续工作。旧会话与工作区保留。",
        confirmLabel: "启动接班",
        onConfirm: () => successor.mutate({ dispatcherId: item.id, laneId: lane.id }),
      }),
    cancelHandoff: (lane) =>
      setConfirm({
        title: "取消换班？",
        message: "只清除调度员的换班状态，旧调度员继续在岗。如果它还在写交接，写出的文件会保留。",
        confirmLabel: "取消换班",
        danger: true,
        onConfirm: () => cancel.mutate({ dispatcherId: item.id, laneId: lane.id }),
      }),
    archiveLane: (lane) =>
      checkLanding.mutate(
        { dispatcherId: item.id, laneId: lane.id },
        {
          onSuccess: ({ landings, unlanded }) => {
            const archiveIt = (force: boolean) => archiveLane.mutate({ dispatcherId: item.id, laneId: lane.id, force });
            if (unlanded.length > 0) {
              setConfirm({
                title: `还有 ${unlanded.length} 个分支没合回收口分支`,
                message: `这条线开出的分支里，下面这些的改动还不在收口分支上：\n${unlanded
                  .map((entry) => `· 「${entry.project}」${entry.branch} → ${entry.landing}`)
                  .join("\n")}\n\n「让调度员收口」：调度员先确认验收，再合回收口分支、跑回归、撤 worktree 并删本地分支，有冲突就停下报告；不推送。它说「已收口」后再来归档。\n确定不要这些改动，才选「仍然归档」，分支和 worktree 会照常按安全检查留着。`,
                confirmLabel: "让调度员收口",
                onConfirm: () => landLane.mutate({ dispatcherId: item.id, laneId: lane.id }),
                alternative: { label: "仍然归档", danger: true, onPress: () => archiveIt(true) },
              });
              return;
            }
            const landed = landings.length > 0 ? `改动都已在收口分支（${landings.map((entry) => entry.landing).join("、")}）上。` : "";
            setConfirm({
              title: `归档会话线「${laneLabel(lane)}」？`,
        message: `这个调度员会话和这条线派出的全部执行会话都会归档，名额和项目随之释放，台账保留。这条线自己的工作区和执行会话的工作区，过了安全检查的（含带 worktree 的：无未提交文件、提交已在别的分支、不在 keep 里）一起归档，其余留着并说明原因。调度员公用的工作区不归档。${
          lane.runningWorkers ? `其中 ${lane.runningWorkers} 个还在跑，不会被打断，结束后自动归档。` : ""
        }你自己开的会话不受影响。${landed}`,
              confirmLabel: "归档",
              danger: !!lane.runningWorkers,
              onConfirm: () => archiveIt(false),
            });
          },
        },
      ),
    dismissError: () => dismiss.mutate({ dispatcherId: item.id }),
    agreeMerge: (lane, req) =>
      checkLanding.mutate(
        { dispatcherId: item.id, laneId: lane.id, req },
        {
          onSuccess: (check) =>
            setConfirm(
              mergeRequest(
                check,
                () => landLane.mutate({ dispatcherId: item.id, laneId: lane.id, req }),
                () => setStage.mutate({ dispatcherId: item.id, laneId: lane.id, word: "待部署", req }),
              ),
            ),
        },
      ),
    deploy: (lane, req) => setDeployTarget(shipTarget(item.id, lane, req)),
    pickStage: (lane) => setStageTarget({ dispatcherId: item.id, lane }),
    nudge: (lane) => nudge.mutate({ dispatcherId: item.id, laneId: lane.id }),
    push: (lane, req) => setPushTarget(shipTarget(item.id, lane, req)),
    requestReview: (lane) => requestReview.mutate({ dispatcherId: item.id, laneId: lane.id }),
    waiveReview: (lane) => {
      if (lane.review) setConfirm(waiveRequest(lane.review, () => waiveReview.mutate({ dispatcherId: item.id, laneId: lane.id })));
    },
    skipDeploy: (lane, req) => setStage.mutate({ dispatcherId: item.id, laneId: lane.id, word: "待推送", req }),
    archive: (agentId) =>
      setConfirm({
        title: "归档旧调度员会话？",
        message: `会话 ${shortId(agentId)} 将被归档，不再出现在会话列表里。${
          item.lanes.some((lane) => lane.id === item.history.find((entry) => entry.agentId === agentId)?.laneId)
            ? "这条线还在继续，它派出的执行会话不动。"
            : "它派出的执行会话也会一起归档，在跑的结束后再归档。"
        }`,
        confirmLabel: "归档",
        onConfirm: () => archive.mutate({ dispatcherId: item.id, agentId }),
      }),
  });

  const overview: Overview | undefined = data.data;

  const lanes = overview?.dispatchers.flatMap((d) => d.lanes) ?? [];
  const totals = overview
    ? {
        lanes: lanes.length,
        running: lanes.filter((lane) => lane.agent?.status === "running").length,
        handoffs: lanes.filter((lane) => lane.pendingHandoff).length,
        workers: lanes.some((lane) => lane.runningWorkers === null)
          ? "—"
          : lanes.reduce((sum, lane) => sum + (lane.runningWorkers ?? 0), 0),
        waiting: lanes.filter((lane) => needsUser(laneNeeds(lane))).length,
        queued: overview.queue.length,
        stale: overview.dispatchers.filter((d) => d.rulesStale).length,
      }
    : null;

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <View style={[s.spread, { flexWrap: "wrap", alignItems: "center" }]}>
        <View style={[s.row, { gap: 12, flexShrink: 1 }]}>
          <View
            style={{
              width: compact ? 34 : 40,
              height: compact ? 34 : 40,
              borderRadius: 10,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: tint(theme.colors.accent, 0.12),
            }}
          >
            <Glyph name="Radar" size={compact ? 18 : 20} tone="accent" />
          </View>
          <View style={{ gap: 2, flexShrink: 1 }}>
            <Text style={s.h1}>调度员</Text>
            {overview ? (
              <Text style={s.muted} numberOfLines={1} selectable>
                {overview.home}
                {"  ·  "}插件 {overview.plugin.commit ?? "版本未知"}
                {overview.plugin.dirty ? "*" : ""} · 更新于 {relativeTime(overview.checkedAt)}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={s.row}>
          <Button
            small
            variant="ghost"
            icon="RefreshCw"
            hint={overview ? `刷新（插件加载于 ${relativeTime(overview.plugin.loadedAt)}${overview.plugin.dirty ? "，含未提交改动" : ""}）` : "刷新"}
            loading={data.isFetching && !data.isPending}
            onPress={refresh}
          />
          <Button
            small
            icon="FileCog"
            label={compact ? undefined : "登记"}
            hint="查看项目登记"
            disabled={!overview}
            onPress={() => overview && setDoc({ path: overview.registryPath, title: "registry.json" })}
          />
          <Button
            small
            icon="RefreshCcwDot"
            label="同步规则"
            variant={totals && totals.stale > 0 ? "primary" : "secondary"}
            loading={sync.isPending}
            onPress={() => sync.mutate({})}
          />
        </View>
      </View>

      {data.isPending ? <Loading /> : null}
      {data.isError ? (
        <Banner tone="danger" icon="CircleAlert" title="读取调度员失败" actions={<Button small icon="RotateCw" label="重试" onPress={refresh} />}>
          <Text style={s.small}>{errorText(data.error)}</Text>
        </Banner>
      ) : null}

      {overview && totals ? (
        <>
          <StatStrip
            items={[
              {
                icon: "Rows3",
                label: "并行需求",
                value: `${totals.lanes}/${overview.limits.sessions}`,
                tone: totals.lanes >= overview.limits.sessions ? "warning" : "neutral",
              },
              { icon: "Hand", label: "等你处理", value: totals.waiting, tone: totals.waiting > 0 ? "warning" : "neutral" },
              ...(totals.queued > 0 ? [{ icon: "Clock", label: "排队", value: totals.queued }] : []),
              { icon: "Activity", label: "在跑执行会话", value: totals.workers, tone: totals.workers ? "accent" : "neutral" },
              ...(totals.handoffs > 0 ? [{ icon: "ArrowRightLeft", label: "换班中", value: totals.handoffs, tone: "warning" as const }] : []),
            ]}
          />

          {watchProblem(overview) ? (
            <Banner tone="danger" icon="EyeOff" title="执行会话巡检没在正常运行">
              <Text style={s.small}>
                {watchProblem(overview)}。调度员现在收不到执行会话结束的通知。重新打开本页或重载插件；一时恢复不了，就让调度员临时建心跳兜底。
              </Text>
            </Banner>
          ) : null}
          {overview.problems.length > 0 ? (
            <Banner
              tone="warning"
              icon="TriangleAlert"
              title={`登记或规则有 ${overview.problems.length} 个问题`}
              actions={
                <>
                  <Button
                    small
                    variant="ghost"
                    icon={showProblems ? "ChevronUp" : "ChevronDown"}
                    label={showProblems ? "收起" : "展开"}
                    onPress={() => setShowProblems((v) => !v)}
                  />
                  <Button small icon="FileCog" label="查看登记" onPress={() => setDoc({ path: overview.registryPath, title: "registry.json" })} />
                </>
              }
            >
              {(showProblems ? overview.problems : overview.problems.slice(0, 1)).map((problem) => (
                <Text key={problem} style={s.small}>
                  · {problem}
                </Text>
              ))}
            </Banner>
          ) : null}
          {totals.stale > 0 ? (
            <Banner tone="accent" icon="ScrollText" title="规则有更新，尚未同步">
              <Text style={s.small}>
                登记或「{overview.rulesFile ? basename(overview.rulesFile) : "规则原文"}」改过了。点「同步规则」重新生成 AGENTS.md；在岗会话线要换班或新开后才会读到新规则。
              </Text>
            </Banner>
          ) : null}

          <AssignPanel data={overview} refresh={refresh} onAssigned={(result) => openAgent?.(result.agentId)} />

          <Section
            title="需求"
            icon="Rows3"
            subtitle={`${totals.lanes}/${overview.limits.sessions} 个并行${totals.waiting > 0 ? ` · ${totals.waiting} 个等你` : ""}${
              totals.queued > 0 ? ` · ${totals.queued} 个排队` : ""
            }`}
            trailing={
              <View style={s.wrap}>
                {overview.dispatchers.map((item) => {
                  const suffix = overview.dispatchers.length > 1 ? ` · ${item.name}` : "";
                  return (
                    <View key={item.id} style={s.wrap}>
                      <Button small variant="ghost" icon="LayoutList" label={`看板${suffix}`} onPress={() => setDoc({ path: item.boardPath, title: `会话线看板 · ${item.name}` })} />
                      <Button
                        small
                        variant="ghost"
                        icon="ScrollText"
                        label={`${item.rulesStale ? "规则待同步" : "规则"}${suffix}`}
                        onPress={() => setDoc({ path: item.agentsPath, title: `AGENTS.md · ${item.name}` })}
                      />
                    </View>
                  );
                })}
              </View>
            }
          >
            {overview.dispatchers.map((item) =>
              item.lastError ? (
                <Banner
                  key={item.id}
                  tone="danger"
                  icon="CircleAlert"
                  title={overview.dispatchers.length > 1 ? `${item.name}：上次操作没有完成` : "上次操作没有完成"}
                  actions={
                    <View style={s.row}>
                      {item.pushableKept.length > 0 ? (
                        <Button
                          small
                          icon="Upload"
                          label={`推送并归档（${item.pushableKept.length}）`}
                          hint="把只在本地的分支推到远端同名分支（不强推），再归档这些工作区"
                          loading={pushArchive.isPending}
                          onPress={() =>
                            setConfirm({
                              title: `推送并归档 ${item.pushableKept.length} 个工作区？`,
                              message:
                                "先把这些工作区的分支推到远端同名分支，不强推，远端有本地没有的提交就停下。推送成功后按同样的检查归档，带 worktree 的目录可能删除，被忽略的文件不会保留。",
                              confirmLabel: "推送并归档",
                              danger: true,
                              onConfirm: () => pushArchive.mutate({ ids: item.pushableKept, dispatcherId: item.id }),
                            })
                          }
                        />
                      ) : null}
                      <Button small variant="ghost" icon="Check" label="知道了" onPress={actionsFor(item).dismissError} />
                    </View>
                  }
                >
                  <Text style={s.small} selectable>
                    {item.lastError}
                  </Text>
                </Banner>
              ) : null,
            )}
            {totals.lanes > 0 ? (
              <View style={{ gap: 8 }}>
                {overview.dispatchers
                  .flatMap((item) => item.lanes.map((lane, order) => ({ item, lane, order, rank: needRank(laneNeeds(lane)) })))
                  .sort((a, b) => a.rank - b.rank || a.order - b.order)
                  .map(({ item, lane }) => (
                    <LaneRow
                      key={`${item.id}:${lane.id}`}
                      lane={lane}
                      dispatcherId={item.id}
                      actions={actionsFor(item)}
                      dispatcherName={overview.dispatchers.length > 1 ? item.name : undefined}
                    />
                  ))}
              </View>
            ) : (
              <Text style={s.muted}>没有进行中的需求。在上面「新需求」选好项目、写需求，点「开始新需求」。</Text>
            )}
            <QueueList
              items={overview.queue}
              showDispatcher={overview.dispatchers.length > 1}
              busy={queueAct.isPending}
              onFront={(item) => queueAct.mutate({ id: item.id, action: "front" })}
              onRetry={(item) => queueAct.mutate({ id: item.id, action: "retry" })}
              onCancel={(item) =>
                setConfirm({
                  title: "取消这个排队的需求？",
                  message: `「${item.summary ?? item.projects.join(" + ")}」会从队列里拿掉，不会开线。需求原文不会保留，要做时重新填一次。`,
                  confirmLabel: "取消排队",
                  danger: true,
                  onConfirm: () => queueAct.mutate({ id: item.id, action: "cancel" }),
                })
              }
            />
            {overview.dispatchers.map((item) => (
              <RetiredSessions
                key={item.id}
                item={item}
                actions={actionsFor(item)}
                dispatcherName={overview.dispatchers.length > 1 ? item.name : undefined}
              />
            ))}
          </Section>

          <View style={{ gap: 12 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showTools }}
              onPress={() => setShowTools((value) => !value)}
              style={({ pressed }) => [s.spread, { paddingVertical: 4, opacity: pressed ? 0.6 : 1 }]}
            >
              <View style={s.row}>
                <Glyph name="Wrench" size={15} />
                <Text style={s.h2}>维护</Text>
                <Text style={s.muted}>Agent 分工 · 工作区清理</Text>
              </View>
              <Glyph name={showTools ? "ChevronUp" : "ChevronDown"} size={14} />
            </Pressable>
            {showTools ? (
              <>
                <RolesPanel />
                <WorkspaceCleanup />
              </>
            ) : null}
          </View>

        </>
      ) : null}

      <DocViewer target={doc} onClose={() => setDoc(null)} />
      <DeployDialog
        target={deployTarget}
        onClose={() => setDeployTarget(null)}
        onDone={refresh}
        onMerge={() => {
          const target = deployTarget;
          const item = overview?.dispatchers.find((entry) => entry.id === target?.dispatcherId);
          const lane = item?.lanes.find((entry) => entry.id === target?.laneId);
          if (item && lane) actionsFor(item).agreeMerge(lane);
        }}
        onReview={() => {
          const target = deployTarget;
          if (target) requestReview.mutate({ dispatcherId: target.dispatcherId, laneId: target.laneId });
        }}
      />
      <PushDialog
        target={pushTarget}
        onClose={() => setPushTarget(null)}
        onDone={refresh}
        onMerge={() => {
          const target = pushTarget;
          const item = overview?.dispatchers.find((entry) => entry.id === target?.dispatcherId);
          const lane = item?.lanes.find((entry) => entry.id === target?.laneId);
          if (item && lane) actionsFor(item).agreeMerge(lane);
        }}
        onReview={() => {
          const target = pushTarget;
          if (target) requestReview.mutate({ dispatcherId: target.dispatcherId, laneId: target.laneId });
        }}
      />
      <StagePicker
        open={stageTarget !== null}
        current={stageTarget?.lane.stage?.source === "ledger" ? stageTarget.lane.stage.word : null}
        title={stageTarget ? laneLabel(stageTarget.lane) : ""}
        onClose={() => setStageTarget(null)}
        onPick={(word) => stageTarget && setStage.mutate({ dispatcherId: stageTarget.dispatcherId, laneId: stageTarget.lane.id, word })}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </ScrollView>
  );
}
