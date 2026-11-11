import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { rolesRpc } from "../shared/contracts";
import { AgentsEditor } from "./agents-editor";
import { modelName } from "./model-name";
import { Banner, Button, Chip, Section, errorText, useKit } from "./ui";

const readable = (label: string) => {
  const { name, effort } = modelName(label);
  return effort ? `${name} · ${effort}` : name;
};

interface RoleDetails {
  when: string;
  fallbacks: string[];
  problems: string[];
}

/**
 * One role as a tag: who, which model right now, how hard it thinks, how many fallbacks stand behind it.
 * With `details` the tag grows into a box and carries the role's use, its fallbacks and what was skipped inside it.
 */
function RoleTag({
  name,
  model,
  fallbacks,
  problems,
  details,
}: {
  name: string;
  model: { name: string; effort: string | null } | null;
  fallbacks: number;
  problems: number;
  details?: RoleDetails;
}) {
  const { theme } = useKit();
  const c = theme.colors;
  const broken = !model;
  const warn = !broken && problems > 0;
  const accent = broken ? c.statusDanger : warn ? c.statusWarning : null;
  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{name}</Text>
      {model ? (
        <>
          <Text style={{ color: c.foreground, fontSize: 12 }}>{model.name}</Text>
          {model.effort ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{model.effort}</Text> : null}
        </>
      ) : (
        <Text style={{ color: c.statusDanger, fontSize: 12 }}>派不出去</Text>
      )}
      {fallbacks > 0 ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>+{fallbacks}</Text> : null}
      {warn ? <Text style={{ color: c.statusWarning, fontSize: 11 }}>{problems} 个失效</Text> : null}
    </View>
  );
  const frame = {
    borderWidth: 1,
    borderColor: accent ?? c.border,
    backgroundColor: c.surface2,
  } as const;
  if (!details) {
    return <View style={{ ...frame, minHeight: 34, paddingHorizontal: 12, justifyContent: "center", borderRadius: 999 }}>{header}</View>;
  }
  return (
    <View style={{ ...frame, gap: 6, padding: 12, borderRadius: 14, flexGrow: 1, flexBasis: 260, maxWidth: "100%" }}>
      {header}
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{details.when}</Text>
      {details.fallbacks.length > 0 ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>备选：{details.fallbacks.join("、")}</Text>
      ) : null}
      {details.problems.map((problem) => (
        <Text key={problem} style={{ color: c.statusWarning, fontSize: 12 }}>
          已跳过：{problem}
        </Text>
      ))}
    </View>
  );
}

/** The config dispatch_work would use right now, one tag per role. Details are a tap away. */
export function RolesPanel() {
  const { theme, s } = useKit();
  const load = useRpc(rolesRpc);
  const [details, setDetails] = useState(false);
  const [editing, setEditing] = useState(false);
  const data = useQuery({
    queryKey: ["dispatch-center", "roles"],
    queryFn: () => load({}),
    refetchInterval: 30_000,
  });
  const view = data.data;
  if (!view) {
    return data.error ? (
      <Section title="Agent 分工" icon="Network">
        <Banner tone="danger" icon="TriangleAlert" title="读取分工表失败">
          <Text style={s.small}>{errorText(data.error)}</Text>
        </Banner>
      </Section>
    ) : null;
  }
  const subtitle = view.running
    ? `在跑 ${view.running.total}/${view.limits.agents}，其中 Claude ${view.running.claude}/${view.limits.claudeAgents}`
    : `上限 ${view.limits.agents} 个，其中 Claude ${view.limits.claudeAgents} 个`;
  return (
    <Section
      title="Agent 分工"
      icon="Network"
      subtitle={subtitle}
      trailing={
        <View style={s.row}>
          <Button small icon="SlidersHorizontal" label="设置" onPress={() => setEditing(true)} />
          <Button
            small
            variant="ghost"
            icon={details ? "ChevronUp" : "ChevronDown"}
            label={details ? "收起" : "详情"}
            onPress={() => setDetails((value) => !value)}
          />
        </View>
      }
    >
      <AgentsEditor view={view} open={editing} onClose={() => setEditing(false)} />
      {view.profilesError ? (
        <Banner tone="danger" icon="TriangleAlert" title="读不到 Agent 配置">
          <Text style={s.small}>{view.profilesError}</Text>
        </Banner>
      ) : view.profileCount === 0 && view.roles.some((role) => role.candidates.some((candidate) => candidate.source.profile)) ? (
        <Banner tone="warning" icon="TriangleAlert" title="没有读到任何 Paseo Agent 配置">
          <Text style={s.small}>引用 Agent 配置的备选都会被跳过。点「设置」直接给这些角色选模型。</Text>
        </Banner>
      ) : null}
      {view.catalogError ? (
        <Banner tone="warning" icon="TriangleAlert" title="读不到 provider 列表">
          <Text style={s.small}>{view.catalogError}。没设模型的角色派不出去，设了的不预检可用性。</Text>
        </Banner>
      ) : null}
      <View style={[s.card, { gap: 10 }]}>
        <View style={[s.wrap, { gap: 8, alignItems: "stretch" }]}>
          {view.roles.map((role) => {
            const usable = role.auto ? [role.auto] : role.candidates;
            const [active, ...fallbacks] = usable.filter((candidate) => candidate.ok);
            const problems = usable.flatMap((candidate) => (candidate.problem ? [candidate.problem] : []));
            const model = active ? modelName(active.label) : null;
            return (
              <RoleTag
                key={role.id}
                name={role.name}
                model={model}
                fallbacks={fallbacks.length}
                problems={problems.length}
                details={details ? { when: role.when, fallbacks: fallbacks.map((candidate) => readable(candidate.label)), problems } : undefined}
              />
            );
          })}
        </View>
        {details ? (
          <View style={{ gap: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: s.divider.backgroundColor }}>
            <Text style={s.muted}>调度员自己用的模型</Text>
            {view.dispatchers.map((dispatcher) => (
              <Text key={dispatcher.id} style={{ color: dispatcher.launch.ok ? theme.colors.foreground : theme.colors.statusWarning, fontSize: 12 }}>
                {dispatcher.name}：{dispatcher.launch.ok ? readable(dispatcher.launch.label) : dispatcher.launch.problem}
              </Text>
            ))}
          </View>
        ) : null}
        {details && view.unusedProfiles.length > 0 ? (
          <View style={{ gap: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: s.divider.backgroundColor }}>
            <Text style={s.muted}>分工表没有用到的 Paseo Agent 配置</Text>
            <View style={s.wrap}>
              {view.unusedProfiles.map((profile) => (
                <Chip key={profile.id} label={profile.name} />
              ))}
            </View>
          </View>
        ) : null}
      </View>
    </Section>
  );
}
