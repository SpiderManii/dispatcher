import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { branchesRpc, type BranchChoice, type TargetView } from "../shared/contracts";
import { Chip, errorText, useKit } from "./ui";

const SHOWN = 6;

/** Which branch to work on for one target. Leaving it unset lets the dispatcher decide from the project's docs. */
export function BranchPicker(props: {
  target: TargetView;
  value: BranchChoice | null;
  onChange: (value: BranchChoice | null) => void;
  /** Lanes a choice would collide with; the lane being sent to is already left out. */
  holders: TargetView["holders"];
}) {
  const { theme, s } = useKit();
  const call = useRpc(branchesRpc);
  const [showAll, setShowAll] = useState(false);
  const { target, value, onChange, holders } = props;

  const query = useQuery({
    queryKey: ["dispatch-center", "branches", target.path],
    queryFn: () => call({ path: target.path }),
    enabled: target.exists && target.isGit,
    staleTime: 30_000,
  });
  const branches = query.data?.branches ?? [];
  if (query.isError) return <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>读取分支失败：{errorText(query.error)}</Text>;
  if (branches.length === 0) return null;

  const creating = value?.base !== undefined;
  const fallbackBase = branches[0].name;
  // The chosen branch stays visible even when it is past the cut-off.
  const shown = showAll ? branches : branches.filter((item, index) => index < SHOWN || item.name === value?.name);
  const heldBy = (name: string) => holders.find((holder) => holder.branch === name);

  return (
    <View style={{ gap: 6 }}>
      <View style={s.wrap}>
        <Text style={s.muted}>分支</Text>
        <Chip label="不指定" selected={!value} hint="由调度员按项目说明决定" onPress={() => onChange(null)} />
        {shown.map((item) => {
          const holder = heldBy(item.name);
          return (
            <Chip
              key={item.name}
              icon="GitBranch"
              label={item.name}
              tone={holder ? "warning" : "neutral"}
              trailing={holder ? `会话线 ${holder.laneId} 占用` : item.current ? "当前" : item.worktree ? "有 worktree" : undefined}
              selected={!creating && value?.name === item.name}
              onPress={() => onChange({ name: item.name })}
            />
          );
        })}
        {branches.length > SHOWN ? (
          <Chip label={showAll ? "收起" : `全部 ${branches.length} 个`} onPress={() => setShowAll((current) => !current)} />
        ) : null}
        <Chip
          icon="Plus"
          label="新建分支"
          selected={creating}
          onPress={() => onChange({ name: "", base: value?.base ?? fallbackBase })}
        />
      </View>
      {creating ? (
        <View style={{ gap: 6 }}>
          <TextInput
            accessibilityLabel="新分支名"
            placeholder="新分支名，例如 feat/usage-page"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            value={value?.name ?? ""}
            onChangeText={(name) => onChange({ name, base: value?.base })}
            style={[s.input, { minHeight: 36 }]}
          />
          <View style={s.wrap}>
            <Text style={s.muted}>基于</Text>
            {shown.map((item) => (
              <Chip
                key={item.name}
                label={item.name}
                selected={value?.base === item.name}
                onPress={() => onChange({ name: value?.name ?? "", base: item.name })}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
