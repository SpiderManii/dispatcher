import type { PluginButtonRegistration, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { LANE_LABEL, useAttention } from "./client/briefs";
import { DispatchCenterScreen } from "./client/center";
import { RequirementPanel } from "./client/requirement-panel";
import { handoffRpc, startRpc } from "./shared/contracts";

/** How many requirements wait on the user, polled lightly so the count is there while the user works elsewhere. */
function useWaiting(): number {
  return useAttention().data?.waiting ?? 0;
}

/**
 * A 「需求」 pill in the composer of every session that belongs to a requirement (its dispatcher and the workers it
 * sent), opening the requirement panel beside the conversation.
 */
function contributeRequirementPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const register = (agent: { id: string; workspaceId?: string | null; labels?: Readonly<Record<string, string>> }) => {
    if (lifetime.signal.aborted) return;
    const workspaceId = agent.workspaceId;
    if (!workspaceId || !agent.labels?.[LANE_LABEL]) {
      pills.get(agent.id)?.remove();
      pills.delete(agent.id);
      return;
    }
    if (pills.has(agent.id)) return;
    const agentId = agent.id;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "requirement",
        workspaceId,
        agentId,
        button: {
          title: "查看所属需求",
          icon: "ListChecks",
          label: "需求",
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel("requirement", { workspaceId, agentId });
            },
          },
        },
      }),
    );
  };
  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[dispatch-center] 订阅会话列表失败", error);
    });
  return () => {
    lifetime.abort();
    removeAll();
  };
}

function CenterItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const waiting = useWaiting();
  return (
    <SidebarRow
      icon="Radar"
      active={currentScreen?.screenId === "center"}
      onPress={() => openScreen({ screenId: "center" })}
      trailing={
        waiting > 0 ? (
          <View
            accessibilityLabel={`${waiting} 个需求等你处理`}
            style={{
              minWidth: 18,
              height: 18,
              paddingHorizontal: 5,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.colors.statusWarning,
            }}
          >
            <Text style={{ color: theme.colors.surface0, fontSize: 11, fontWeight: "700" }}>{waiting}</Text>
          </View>
        ) : undefined
      }
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "center", title: "调度员", Component: DispatchCenterScreen });
  client.addAgentPanel({ id: "requirement", title: "需求", icon: "ListChecks", Component: RequirementPanel });
  client.addCommandCenterItem({
    id: "open-requirement",
    title: "查看所属需求",
    icon: "ListChecks",
    keywords: ["需求", "阶段", "部署", "合回", "requirement"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("requirement");
    },
  });
  const stopPills = contributeRequirementPills(client);
  client.addSidebarHeaderItem({ id: "center", title: "调度员", Component: CenterItem });
  client.addCommandCenterItem({
    id: "open-center",
    title: "打开调度员",
    icon: "Radar",
    keywords: ["dispatch", "调度", "换班"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "center" });
    },
  });
  client.addSlashCommand({
    name: "dispatch",
    description: "为指定调度员新建会话，并把后面的文字作为本次需求",
    argumentHint: "<调度员ID> [需求]",
    context: "workspace",
    async onSubmit({ args, rpc, openScreen }) {
      const match = /^(\S+)\s*([\s\S]*)$/.exec(args.trim());
      if (!match) throw new Error("用法：/dispatch <调度员ID> [需求]");
      await rpc(startRpc, { dispatcherId: match[1], task: match[2].trim() || undefined });
      openScreen({ screenId: "center" });
    },
  });
  client.addSlashCommand({
    name: "dispatch-handoff",
    description: "让当前调度员准备交接，接班由你手动启动",
    argumentHint: "",
    context: "agent",
    async onSubmit({ agent, rpc, openScreen }) {
      await rpc(handoffRpc, { agentId: agent.id });
      openScreen({ screenId: "center" });
    },
  });
  return () => {
    stopPills();
  };
}
