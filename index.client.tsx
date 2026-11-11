import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DispatchCenterScreen } from "./client/center";
import { handoffRpc, startRpc } from "./shared/contracts";

function CenterItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Radar"
      active={currentScreen?.screenId === "center"}
      onPress={() => openScreen({ screenId: "center" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "center", title: "调度员", Component: DispatchCenterScreen });
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
  return () => {};
}
