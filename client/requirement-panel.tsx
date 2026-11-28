import { useAgent, useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  landLaneRpc,
  laneLandingRpc,
  nudgeRpc,
  overviewRpc,
  requestReviewRpc,
  setStageRpc,
  waiveReviewRpc,
  type LaneView,
} from "../shared/contracts";
import { laneNeeds } from "../shared/needs";
import { ATTENTION_KEY, DISPATCHER_LABEL, LANE_LABEL, ROLE_LABEL } from "./briefs";
import { DecidedForYou, Decisions } from "./decisions";
import { DeployDialog, type DeployTarget } from "./deploy-dialog";
import { mergeRequest } from "./merge-request";
import { PushDialog, type PushTarget } from "./push-dialog";
import { ConfirmDialog, DocViewer, type ConfirmRequest, type DocTarget } from "./dialogs";
import { LaneActivity } from "./lane-activity";
import { LaneReports } from "./reports";
import { ReviewLine, waiveRequest } from "./review";
import { laneLabel, projectNames, shipTarget } from "./lane-row";
import { RequirementList } from "./requirements";
import { StagePipeline } from "./stage";
import { Banner, Button, Chip, Glyph, KitProvider, errorText, useKit, type Tone } from "./ui";

/** Beside a dispatcher's or a worker's conversation: the requirement it belongs to, without going back to the page. */
export function RequirementPanel(props: PluginAgentPanelProps) {
  return (
    <KitProvider theme={props.theme} compact={props.layout.compact}>
      <Panel {...props} />
    </KitProvider>
  );
}

function Panel({ params, navigation }: PluginAgentPanelProps) {
  const { s } = useKit();
  const toast = useToast();
  const queryClient = useQueryClient();
  const loadOverview = useRpc(overviewRpc);
  const callLanding = useRpc(laneLandingRpc);
  const callLand = useRpc(landLaneRpc);
  const callSetStage = useRpc(setStageRpc);
  const callNudge = useRpc(nudgeRpc);
  const callRequestReview = useRpc(requestReviewRpc);
  const callWaiveReview = useRpc(waiveReviewRpc);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [deployTarget, setDeployTarget] = useState<DeployTarget | null>(null);
  const [pushTarget, setPushTarget] = useState<PushTarget | null>(null);
  const [doc, setDoc] = useState<DocTarget | null>(null);
  const labels = useAgent(params.agentId, (agent) => ({
    laneId: agent.labels[LANE_LABEL] ?? null,
    dispatcherId: agent.labels[DISPATCHER_LABEL] ?? null,
    isDispatcher: agent.labels[ROLE_LABEL] === "dispatcher",
  }));
  const data = useQuery({
    queryKey: ["dispatch-center", "overview"],
    queryFn: () => loadOverview({}),
    refetchInterval: 10_000,
    enabled: !!labels?.laneId,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["dispatch-center", "overview"] });
    void queryClient.invalidateQueries({ queryKey: ATTENTION_KEY });
  };
  const report = (error: unknown) => toast.error(errorText(error));
  const land = useMutation({
    mutationFn: callLand,
    onSuccess: ({ sent }) => {
      toast.show(sent ? "已让调度员合回，合回完它会改成「待部署」" : "分支都已在收口分支上", { variant: "success" });
      refresh();
    },
    onError: report,
  });
  const setStage = useMutation({ mutationFn: callSetStage, onSuccess: refresh, onError: report });
  const landing = useMutation({ mutationFn: callLanding, onError: report });
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
  const nudge = useMutation({
    mutationFn: callNudge,
    onSuccess: ({ sent }) => {
      toast.show(sent ? "已催调度员" : "调度员正在执行，不用催", { variant: sent ? "success" : "info" });
      refresh();
    },
    onError: report,
  });

  const found = data.data?.dispatchers.flatMap((item) => item.lanes.map((lane) => ({ dispatcherId: item.id, lane })));
  const match = found?.find(({ lane }) => lane.id === labels?.laneId) ?? null;

  if (!labels?.laneId)
    return (
      <View style={s.content}>
        <Text style={s.muted}>这个会话不是调度员开的，也不是调度员派出的，没有所属需求。</Text>
      </View>
    );
  if (data.isPending) return <Loading />;
  if (data.isError)
    return (
      <View style={s.content}>
        <Banner tone="danger" icon="CircleAlert" title="读取需求失败">
          <Text style={s.small}>{errorText(data.error)}</Text>
        </Banner>
      </View>
    );
  if (!match)
    return (
      <View style={s.content}>
        <Text style={s.muted}>所属的需求已经结束或归档了（会话线 {labels.laneId}）。</Text>
      </View>
    );

  const { dispatcherId, lane } = match;
  const needs = laneNeeds(lane);
  const gate = needs.find((need) => need.kind === "merge" || need.kind === "deploy" || need.kind === "push" || need.kind === "archive");
  const agreeMerge = (target: LaneView, req?: string) =>
    landing.mutate(
      { dispatcherId, laneId: target.id, req },
      {
        onSuccess: (check) =>
          setConfirm(
            mergeRequest(
              check,
              () => land.mutate({ dispatcherId, laneId: target.id, req }),
              () => setStage.mutate({ dispatcherId, laneId: target.id, word: "待部署", req }),
            ),
          ),
      },
    );

  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.content, { padding: 16, gap: 14 }]}>
      <View style={{ gap: 4 }}>
        <Text style={s.muted}>{labels.isDispatcher ? "这个调度员负责的需求" : "这个执行会话所属的需求"}</Text>
        <Text style={[s.h2, { lineHeight: 22 }]}>{laneLabel(lane)}</Text>
        <Text style={s.muted}>
          {projectNames(lane) || "未绑定项目"} · {lane.id}
        </Text>
        {lane.ledger.acceptance ? <Text style={[s.small, { lineHeight: 18 }]}>验收：{lane.ledger.acceptance}</Text> : null}
        <ReviewLine review={lane.review} />
      </View>

      <StagePipeline stage={lane.stage} />
      <RequirementList lane={lane} />
      {lane.ledger.next || lane.stage?.note ? (
        <View style={[s.row, { alignItems: "flex-start", gap: 6 }]}>
          <View style={{ paddingTop: 2 }}>
            <Glyph name="CornerDownRight" size={12} />
          </View>
          <Text style={[s.small, { flex: 1, lineHeight: 18 }]}>{lane.ledger.next ? `下一步：${lane.ledger.next}` : lane.stage?.note}</Text>
        </View>
      ) : null}

      {needs.length > 0 ? (
        <View style={s.wrap}>
          {needs.map((need) => (
            <Chip key={need.kind} label={need.label} tone={need.tone as Tone} />
          ))}
        </View>
      ) : null}

      <View style={s.wrap}>
        {needs.some((need) => need.kind === "stalled") ? (
          <Button small variant="primary" icon="BellRing" label="催一下" loading={nudge.isPending} onPress={() => nudge.mutate({ dispatcherId, laneId: lane.id })} />
        ) : null}
        {needs.some((need) => need.kind === "review") && lane.review ? (
          <>
            <Button
              small
              variant="primary"
              icon="ShieldCheck"
              label="派审查"
              loading={requestReview.isPending}
              onPress={() => requestReview.mutate({ dispatcherId, laneId: lane.id })}
            />
            <Button
              small
              variant="ghost"
              icon="ShieldOff"
              label="不用审查"
              onPress={() => setConfirm(waiveRequest(lane.review!, () => waiveReview.mutate({ dispatcherId, laneId: lane.id })))}
            />
          </>
        ) : null}
        {gate?.kind === "merge" ? <Button small variant="primary" icon="GitMerge" label={gate.req ? `同意合回 ${gate.req}` : "同意合回"} loading={landing.isPending} onPress={() => agreeMerge(lane, gate.req)} /> : null}
        {gate?.kind === "deploy" ? (
          <>
            <Button
              small
              variant="primary"
              icon="Rocket"
              label={gate.req ? `部署 ${gate.req}` : "部署"}
              onPress={() => setDeployTarget(shipTarget(dispatcherId, lane, gate.req))}
            />
            <Button small variant="ghost" icon="SkipForward" label="不用部署" onPress={() => setStage.mutate({ dispatcherId, laneId: lane.id, word: "待推送", req: gate.req })} />
          </>
        ) : null}
        {gate?.kind === "push" ? (
          <Button
            small
            variant="primary"
            icon="Upload"
            label={gate.req ? `推送 ${gate.req}` : "推送"}
            onPress={() => setPushTarget(shipTarget(dispatcherId, lane, gate.req))}
          />
        ) : null}
        {!labels.isDispatcher && navigation ? (
          <Button small icon="Radar" label="打开调度员" onPress={() => navigation.openAgent({ agentId: lane.agentId })} />
        ) : null}
        <Button small variant="ghost" icon="NotebookText" label="台账" onPress={() => setDoc({ path: lane.ledger.path, title: `台账 · ${laneLabel(lane)}` })} />
      </View>
      {gate?.kind === "archive" ? <Text style={s.muted}>需求做完了。到侧边栏「调度员」页归档，释放名额。</Text> : null}

      <Decisions lane={lane} dispatcherId={dispatcherId} />
      <DecidedForYou lane={lane} openAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined} />
      <LaneReports reports={lane.reports} openDoc={(path, title) => setDoc({ path, title })} />
      <LaneActivity lane={lane} openAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined} />

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <DeployDialog
        target={deployTarget}
        onClose={() => setDeployTarget(null)}
        onDone={refresh}
        onMerge={() => agreeMerge(lane)}
        onReview={() => requestReview.mutate({ dispatcherId, laneId: lane.id })}
      />
      <PushDialog
        target={pushTarget}
        onClose={() => setPushTarget(null)}
        onDone={refresh}
        onMerge={() => agreeMerge(lane)}
        onReview={() => requestReview.mutate({ dispatcherId, laneId: lane.id })}
      />
      <DocViewer target={doc} onClose={() => setDoc(null)} />
    </ScrollView>
  );
}
