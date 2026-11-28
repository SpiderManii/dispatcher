import { useRpc } from "@getpaseo/plugin/client";
import { Loading, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { deployInfoRpc, deployRpc } from "../shared/contracts";
import { Banner, Button, Chip, errorText, relativeTime, useKit } from "./ui";
import { WideModal } from "./wide-modal";

export interface DeployTarget {
  dispatcherId: string;
  laneId: string;
  title: string;
  /** Sensitive changes found on the lane's cards that were never reviewed, when there are some. */
  reviewMissing?: readonly string[] | null;
  /** The requirement this is for, on a lane holding several. */
  req?: string;
}

type Migration = "no" | "yes" | "unknown";
const MIGRATION: { id: Migration; label: string }[] = [
  { id: "unknown", label: "不确定，先查" },
  { id: "no", label: "不含迁移" },
  { id: "yes", label: "含迁移" },
];

const splitServices = (text: string) =>
  text
    .split(/[\s,，、；;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * 部署 from the page: the landing branch's tip is prefilled, the user names the services. The dispatcher gets service
 * and full SHA in one message, which is what its rules ask of the user before a deploy card goes out.
 */
export function DeployDialog(props: {
  target: DeployTarget | null;
  onClose: () => void;
  onDone: () => void;
  onMerge: () => void;
  onReview?: () => void;
}) {
  const { theme, s } = useKit();
  const c = theme.colors;
  const toast = useToast();
  const loadInfo = useRpc(deployInfoRpc);
  const callDeploy = useRpc(deployRpc);
  const target = props.target;
  const info = useQuery({
    queryKey: ["dispatch-center", "deploy-info", target?.dispatcherId, target?.laneId],
    queryFn: () => loadInfo({ dispatcherId: target!.dispatcherId, laneId: target!.laneId }),
    enabled: target !== null,
  });
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [extra, setExtra] = useState("");
  const [sha, setSha] = useState("");
  const [migration, setMigration] = useState<Migration>("unknown");

  const projects = info.data?.projects ?? [];
  const project = projects.find((item) => item.key === projectKey) ?? projects.find((item) => item.sha) ?? projects[0] ?? null;

  useEffect(() => {
    if (!target) return;
    setProjectKey(null);
    setPicked([]);
    setExtra("");
    setMigration("unknown");
  }, [target?.laneId]);
  useEffect(() => setSha(project?.sha ?? ""), [project?.key, project?.sha]);

  const services = useMemo(() => [...new Set([...picked, ...splitServices(extra)])], [picked, extra]);
  const shaOk = /^[0-9a-f]{40}$/i.test(sha.trim());
  const deploy = useMutation({
    mutationFn: () =>
      callDeploy({
        dispatcherId: target!.dispatcherId,
        laneId: target!.laneId,
        projectKey: project!.key,
        services,
        sha: sha.trim(),
        migration,
        req: target!.req,
      }),
    onSuccess: () => {
      toast.show(`已让调度员部署 ${services.join("、")} @ ${sha.trim().slice(0, 8)}`, { variant: "success" });
      props.onDone();
      props.onClose();
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const unlanded = info.data?.unlanded ?? [];
  const toIntegrate = info.data?.toIntegrate ?? [];
  const pending = [
    ...unlanded.map((item) => `${item.branch} → ${item.landing}`),
    ...toIntegrate.map((item) => `${item.landing} → ${item.integration}`),
  ];

  return (
    <WideModal title={`部署 · ${target?.title ?? ""}`} open={target !== null} onClose={props.onClose} width={640}>
      {info.isPending ? <Loading /> : null}
      {info.isError ? (
        <Banner tone="danger" icon="CircleAlert" title="读不到要部署的提交">
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
          <Text style={s.small}>按规则第 9 节，这类改动要先审查一次。仍要部署也可以，只发你点名的服务和 SHA。</Text>
        </Banner>
      ) : null}
      {pending.length > 0 ? (
        <Banner
          tone="warning"
          icon="GitMerge"
          title={`还有 ${pending.length} 处没合好`}
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
          <Text style={s.small}>{pending.join("、")}。部署只发下面这条分支上的提交，这些改动不会带上。</Text>
        </Banner>
      ) : null}

      {info.data ? (
        <>
          {projects.length > 1 ? (
            <View style={{ gap: 6 }}>
              <Text style={s.muted}>项目</Text>
              <View style={s.wrap}>
                {projects.map((item) => (
                  <Chip key={item.key} icon="FolderGit2" label={item.name} selected={item.key === project?.key} onPress={() => setProjectKey(item.key)} />
                ))}
              </View>
            </View>
          ) : null}

          {project ? (
            <View style={[s.inset, { gap: 6 }]}>
              <View style={s.wrap}>
                <Text style={s.h3}>{project.name}</Text>
                <Text style={s.muted}>
                  部署 {project.branch ?? "未定"}
                  {project.branch && project.landing && project.branch !== project.landing ? `（收口分支 ${project.landing} 合进来之后）` : ""}
                </Text>
              </View>
              {project.sha ? (
                <Text style={s.small} numberOfLines={2}>
                  HEAD {project.sha.slice(0, 8)} · {project.subject}
                  {project.committedAt ? ` · ${relativeTime(project.committedAt)}` : ""}
                </Text>
              ) : (
                <Text style={{ color: c.statusDanger, fontSize: 12 }}>找不到 {project.branch ?? "这条分支"} 的提交，没法从页面部署。</Text>
              )}
              <TextInput
                accessibilityLabel="完整 SHA"
                value={sha}
                onChangeText={setSha}
                placeholder="40 位完整 SHA"
                placeholderTextColor={c.foregroundMuted}
                style={[s.singleInput, { flex: 0, fontFamily: "Menlo, Consolas, monospace", fontSize: 12 }]}
              />
              {!shaOk && sha.trim() ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>要完整的 40 位 SHA</Text> : null}
            </View>
          ) : null}

          <View style={{ gap: 6 }}>
            <Text style={s.muted}>服务</Text>
            {project && project.targets.length > 0 ? (
              <View style={s.wrap}>
                {project.targets.map((item) => (
                  <Chip
                    key={item}
                    icon="Server"
                    label={item}
                    selected={picked.includes(item)}
                    onPress={() => setPicked((list) => (list.includes(item) ? list.filter((value) => value !== item) : [...list, item]))}
                  />
                ))}
              </View>
            ) : null}
            <TextInput
              accessibilityLabel="其他服务"
              value={extra}
              onChangeText={setExtra}
              placeholder={project && project.targets.length > 0 ? "其他服务，用逗号隔开" : "要部署的服务，用逗号隔开"}
              placeholderTextColor={c.foregroundMuted}
              style={[s.singleInput, { flex: 0 }]}
            />
            {project && project.targets.length === 0 ? (
              <Text style={s.muted}>在项目登记里给这个项目加 `deployTargets`，下次直接点选。</Text>
            ) : null}
          </View>

          <View style={{ gap: 6 }}>
            <Text style={s.muted}>数据库迁移</Text>
            <View style={s.wrap}>
              {MIGRATION.map((item) => (
                <Chip key={item.id} label={item.label} selected={migration === item.id} onPress={() => setMigration(item.id)} />
              ))}
            </View>
          </View>

          <Text style={[s.small, { lineHeight: 20 }]}>
            调度员会按规则派部署工位：按部署手册核查、备份、构建、保留旧容器切换、验收，失败回滚。只动点名的服务，不 push。
          </Text>
        </>
      ) : null}

      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button label="取消" variant="ghost" onPress={props.onClose} />
        <Button
          variant="primary"
          icon="Rocket"
          label={services.length > 0 && shaOk ? `部署 ${services.join("、")} @ ${sha.trim().slice(0, 8)}` : "部署"}
          disabled={!project || !shaOk || services.length === 0}
          loading={deploy.isPending}
          onPress={() => deploy.mutate()}
        />
      </View>
    </WideModal>
  );
}
