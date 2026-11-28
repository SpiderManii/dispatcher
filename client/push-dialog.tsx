import { useRpc } from "@getpaseo/plugin/client";
import { Loading, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { pushInfoRpc, pushRpc } from "../shared/contracts";
import { Banner, Button, Chip, errorText, useKit } from "./ui";
import { WideModal } from "./wide-modal";

export interface PushTarget {
  dispatcherId: string;
  laneId: string;
  title: string;
  /** Sensitive changes found on the lane's cards that were never reviewed, when there are some. */
  reviewMissing?: readonly string[] | null;
  /** The requirement this is for, on a lane holding several. */
  req?: string;
}

/**
 * 推送: shows what each project's ship branch (dev, else the landing branch) would send, then the plugin pushes it.
 * Never forced: a remote that moved on is shown and the push waits for the dispatcher to merge it in.
 */
export function PushDialog(props: {
  target: PushTarget | null;
  onClose: () => void;
  onDone: () => void;
  onMerge: () => void;
  onReview?: () => void;
}) {
  const { theme, s } = useKit();
  const c = theme.colors;
  const toast = useToast();
  const loadInfo = useRpc(pushInfoRpc);
  const callPush = useRpc(pushRpc);
  const target = props.target;
  const info = useQuery({
    queryKey: ["dispatch-center", "push-info", target?.dispatcherId, target?.laneId],
    queryFn: () => loadInfo({ dispatcherId: target!.dispatcherId, laneId: target!.laneId }),
    enabled: target !== null,
  });
  const push = useMutation({
    mutationFn: (projectKey: string) => callPush({ dispatcherId: target!.dispatcherId, laneId: target!.laneId, projectKey, req: target!.req }),
    onSuccess: (result) => {
      toast.show(
        result.commits > 0 ? `已把 ${result.branch} 推到 ${result.remote}（${result.commits} 个提交）` : `${result.branch} 没有要推的提交`,
        { variant: "success" },
      );
      void info.refetch();
      props.onDone();
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const projects = info.data?.projects ?? [];
  const toIntegrate = info.data?.toIntegrate ?? [];

  return (
    <WideModal title={`推送 · ${target?.title ?? ""}`} open={target !== null} onClose={props.onClose} width={640}>
      {info.isPending ? <Loading /> : null}
      {info.isError ? (
        <Banner tone="danger" icon="CircleAlert" title="读不到要推送的提交">
          <Text style={s.small}>{errorText(info.error)}</Text>
        </Banner>
      ) : null}
      {target?.reviewMissing?.length ? (
        <Banner
          tone="warning"
          icon="ShieldAlert"
          title={`敏感改动还没审查：${target.reviewMissing.join("、")}`}
          actions={
            props.onReview ? (
              <Button
                small
                icon="ShieldCheck"
                label="先派审查"
                onPress={() => {
                  props.onClose();
                  props.onReview?.();
                }}
              />
            ) : undefined
          }
        >
          <Text style={s.small}>按规则第 9 节，这类改动要先审查一次；推上去同事就会拉到。</Text>
        </Banner>
      ) : null}
      {toIntegrate.length > 0 ? (
        <Banner
          tone="warning"
          icon="GitMerge"
          title="还没合进 dev"
          actions={
            <Button
              small
              icon="GitMerge"
              label="先同意合回"
              onPress={() => {
                props.onClose();
                props.onMerge();
              }}
            />
          }
        >
          <Text style={s.small}>
            {toIntegrate.map((item) => `「${item.project}」${item.landing} → ${item.integration}`).join("、")}。推送的是 dev，这些改动现在推不上去。
          </Text>
        </Banner>
      ) : null}
      {projects.map((project) => {
        const blocked = project.behind > 0 || !project.remote || !project.branch;
        return (
          <View key={project.key} style={[s.inset, { gap: 8 }]}>
            <View style={s.wrap}>
              <Text style={s.h3}>{project.name}</Text>
              <Text style={s.muted}>
                {project.branch ?? "（不知道推哪个分支）"} → {project.remote ? `${project.remote}/${project.branch}` : "没有远端"}
              </Text>
              {project.shared ? <Chip icon="Users" label="共享分支，同事会拉到" tone="warning" /> : null}
            </View>
            {project.fetchError ? (
              <Text style={{ color: c.statusWarning, fontSize: 12 }}>没连上远端（{project.fetchError}），下面的数字按上次拉取算。</Text>
            ) : null}
            {project.behind > 0 ? (
              <Text style={{ color: c.statusDanger, fontSize: 12, lineHeight: 18 }}>
                远端有 {project.behind} 个本机没有的提交（同事推过）。不会强推：先让调度员把远端的合进来、跑一次回归，再推。
              </Text>
            ) : null}
            {project.ahead === 0 ? (
              <Text style={s.muted}>没有要推的提交，远端已是最新。</Text>
            ) : (
              <View style={{ gap: 2 }}>
                <Text style={s.muted}>
                  要推 {project.ahead} 个提交{project.ahead > project.commits.length ? `，最新 ${project.commits.length} 个：` : "："}
                </Text>
                {project.commits.map((commit) => (
                  <Text key={commit.sha} style={[s.small, { lineHeight: 18 }]} numberOfLines={1}>
                    <Text style={{ fontFamily: "Menlo, Consolas, monospace", color: c.foregroundMuted }}>{commit.sha}</Text> {commit.subject}
                  </Text>
                ))}
              </View>
            )}
            <View style={[s.row, { justifyContent: "flex-end" }]}>
              <Button
                small
                variant={project.shared ? "danger" : "primary"}
                icon="Upload"
                label={project.ahead > 0 ? `推送 ${project.branch}（${project.ahead} 个提交）` : "标记已推送"}
                disabled={blocked || push.isPending}
                loading={push.isPending && push.variables === project.key}
                onPress={() => push.mutate(project.key)}
              />
            </View>
          </View>
        );
      })}
      {projects.length > 0 ? (
        <Text style={[s.muted, { lineHeight: 18 }]}>
          由插件直接执行 git push，不强推；推完在台账「最近完成」记一行。整条线都推完后，阶段改成「已完成」。
        </Text>
      ) : null}
      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button label="关闭" variant="ghost" onPress={props.onClose} />
      </View>
    </WideModal>
  );
}
