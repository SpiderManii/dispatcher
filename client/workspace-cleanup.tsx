import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { archiveWorkspacesRpc, workspacesRpc, type WorkspaceItem } from "../shared/contracts";
import { ConfirmDialog, type ConfirmRequest } from "./dialogs";
import { Banner, Button, Checkbox, Chip, Glyph, Section, errorText, relativeTime, useKit } from "./ui";

function Row({ item, selected, onToggle }: { item: WorkspaceItem; selected?: boolean; onToggle?: () => void }) {
  const { theme, s } = useKit();
  const body = (
    <>
      {onToggle ? <Checkbox checked={!!selected} /> : null}
      <View style={{ flex: 1, gap: 3 }}>
        <View style={s.wrap}>
          <Text style={s.small} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={s.muted}>{item.project}</Text>
          {item.branch ? <Chip icon="GitBranch" label={item.branch} /> : null}
          {item.removesDirectory ? <Chip icon="FolderX" label="带 worktree" tone="warning" /> : null}
          {item.activityAt ? <Text style={s.muted}>活跃于 {relativeTime(item.activityAt)}</Text> : null}
        </View>
        {item.blockers.length > 0 ? <Text style={s.muted}>{item.blockers.join("；")}</Text> : null}
        {item.warnings.map((warning) => (
          <Text key={warning} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
            {warning}
          </Text>
        ))}
      </View>
    </>
  );
  const rowStyle = [
    s.row,
    {
      alignItems: "flex-start" as const,
      padding: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: selected ? theme.colors.accent ?? theme.colors.border : theme.colors.border,
      backgroundColor: selected ? theme.colors.surface2 : "transparent",
      // Two columns when the panel is wide enough, one when it is not.
      flexGrow: 1,
      flexBasis: 320,
      maxWidth: "100%" as const,
    },
  ];
  return onToggle ? (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: !!selected }} onPress={onToggle} style={rowStyle}>
      {body}
    </Pressable>
  ) : (
    <View style={rowStyle}>{body}</View>
  );
}

/** Nothing is checked until opened, and nothing is archived until the user ticks it and confirms. */
export function WorkspaceCleanup() {
  const { s } = useKit();
  const toast = useToast();
  const load = useRpc(workspacesRpc);
  const callArchive = useRpc(archiveWorkspacesRpc);
  const [open, setOpen] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const data = useQuery({
    queryKey: ["dispatch-center", "workspaces"],
    queryFn: () => load({}),
    enabled: open,
    staleTime: 0,
  });
  const archive = useMutation({
    mutationFn: callArchive,
    onSuccess: ({ archived, skipped }) => {
      setSelected(new Set());
      if (skipped.length > 0) {
        const detail = skipped.map((item) => `${item.name}：${item.reason}`).join("\n");
        toast.show(`已归档 ${archived.length} 个，${skipped.length} 个没有归档\n${detail}`, { variant: "warning" });
      } else toast.show(`已归档 ${archived.length} 个工作区`, { variant: "success" });
      void data.refetch();
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const items = data.data?.workspaces ?? [];
  const ready = items.filter((item) => item.blockers.length === 0);
  const blocked = items.filter((item) => item.blockers.length > 0);
  const chosen = ready.filter((item) => selected.has(item.id));
  const allChosen = ready.length > 0 && chosen.length === ready.length;
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const askArchive = () => {
    const worktrees = chosen.filter((item) => item.removesDirectory);
    setConfirm({
      title: `归档 ${chosen.length} 个工作区？`,
      message:
        worktrees.length > 0
          ? `其中 ${worktrees.length} 个带 worktree（${worktrees.map((item) => item.name).join("、")}），归档可能删除这些目录。已确认没有未提交的文件，提交也都在其他分支上；被忽略的文件不会保留。`
          : "这些工作区没有 worktree，也没有未归档的会话，归档只是从侧边栏移走。",
      confirmLabel: "归档",
      danger: worktrees.length > 0,
      onConfirm: () => archive.mutate({ ids: chosen.map((item) => item.id) }),
    });
  };

  return (
    <Section
      title="工作区清理"
      icon="Archive"
      subtitle={open && data.data ? `可清理 ${ready.length} 个` : undefined}
      trailing={
        <View style={s.row}>
          {open ? <Button small icon="RefreshCw" hint="重新检查" loading={data.isFetching} onPress={() => void data.refetch()} /> : null}
          <Button
            small
            variant="ghost"
            icon={open ? "ChevronUp" : "ChevronDown"}
            label={open ? "收起" : "检查"}
            hint="检查哪些工作区可以安全归档，不会自动归档"
            onPress={() => setOpen((value) => !value)}
          />
        </View>
      }
    >
      {open && data.isError ? (
        <Banner tone="danger" icon="CircleAlert" title="检查工作区失败">
          <Text style={s.small}>{errorText(data.error)}</Text>
        </Banner>
      ) : null}
      {open && data.data ? (
        <View style={[s.card, { gap: 6 }]}>
          {ready.length > 0 ? (
            <View style={[s.wrap, { gap: 8, alignItems: "stretch" }]}>
              {ready.map((item) => (
                <Row key={item.id} item={item} selected={selected.has(item.id)} onToggle={() => toggle(item.id)} />
              ))}
            </View>
          ) : (
            <Text style={s.muted}>没有可以清理的工作区。</Text>
          )}
          {ready.length > 0 ? (
            <View style={s.row}>
              <Button
                small
                variant="ghost"
                icon={allChosen ? "X" : "Check"}
                label={allChosen ? "取消全选" : `全选（${ready.length}）`}
                onPress={() => setSelected(allChosen ? new Set() : new Set(ready.map((item) => item.id)))}
              />
              <Button small variant="primary" icon="Archive" label={`归档选中（${chosen.length}）`} disabled={chosen.length === 0} loading={archive.isPending} onPress={askArchive} />
            </View>
          ) : null}
          {blocked.length > 0 ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showBlocked }} onPress={() => setShowBlocked((value) => !value)} style={[s.spread, { paddingVertical: 2 }]}>
              <Text style={s.muted}>不能清理的 {blocked.length} 个</Text>
              <Glyph name={showBlocked ? "ChevronUp" : "ChevronDown"} size={14} />
            </Pressable>
          ) : null}
          {showBlocked ? (
            <View style={[s.wrap, { gap: 8, alignItems: "stretch" }]}>
              {blocked.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </Section>
  );
}
