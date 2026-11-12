import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { DispatcherView } from "../shared/contracts";
import type { CardActions } from "./lane-row";
import { StyleSheet } from "react-native";
import { Button, Chip, Glyph, clock, shortId, statusOf, useKit } from "./ui";

type HistoryEntry = DispatcherView["history"][number];

/** History minus the sessions on a lane. Archived or vanished ones are only a record: no seat, no assignments. */
export function retiredSessions(item: DispatcherView): { unarchived: HistoryEntry[]; archived: HistoryEntry[] } {
  const onLane = new Set(item.lanes.map((lane) => lane.agentId));
  const retired = item.history.filter((entry) => !onLane.has(entry.agentId));
  const isRecord = (entry: HistoryEntry) => !entry.status || entry.status === "archived";
  return { unarchived: retired.filter((entry) => !isRecord(entry)), archived: retired.filter(isRecord) };
}

function SessionLine({ entry }: { entry: HistoryEntry }) {
  const { s } = useKit();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <View style={s.wrap}>
        <Text style={s.mono}>{shortId(entry.agentId)}</Text>
        {entry.laneId ? <Text style={s.mono}>{entry.laneId}</Text> : null}
        <Text style={s.small}>{entry.reason}</Text>
        <Text style={s.muted}>{statusOf(entry.status).label}</Text>
      </View>
      <Text style={s.muted}>
        {clock(entry.startedAt)} → {entry.endedAt ? clock(entry.endedAt) : "至今"}
      </Text>
    </View>
  );
}

/** Sessions that left their lane but are not archived. They stay openable after a handoff. */
export function RetiredSessions({
  item,
  actions,
  dispatcherName,
}: {
  item: DispatcherView;
  actions: CardActions;
  /** Shown only when several dispatchers share the list. */
  dispatcherName?: string;
}) {
  const { s } = useKit();
  const [open, setOpen] = useState(false);
  const { unarchived } = retiredSessions(item);
  if (unarchived.length === 0) return null;

  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={[s.spread, { paddingVertical: 2 }]}
      >
        <View style={s.row}>
          <Glyph name="History" size={13} />
          <Text style={s.muted}>
            旧会话 {unarchived.length} 个未归档
            {dispatcherName ? ` · ${dispatcherName}` : ""}
          </Text>
        </View>
        <Glyph name={open ? "ChevronUp" : "ChevronDown"} size={14} />
      </Pressable>
      {open
        ? unarchived.map((entry) => (
            <View key={`${entry.agentId}-${entry.startedAt}`} style={s.spread}>
              <SessionLine entry={entry} />
              <View style={s.row}>
                {actions.openAgent ? (
                  <Button small variant="ghost" icon="SquareArrowOutUpRight" hint="打开该会话" onPress={() => actions.openAgent?.(entry.agentId)} />
                ) : null}
                <Button small icon="Archive" label="归档" onPress={() => actions.archive(entry.agentId)} />
              </View>
            </View>
          ))
        : null}
    </View>
  );
}

/** One archived session: id and lane on the left, how long it ran on the right. Every row is archived, so no status column. */
function ArchivedRow({ entry, first }: { entry: HistoryEntry; first: boolean }) {
  const { s, theme } = useKit();
  return (
    <View
      style={[
        s.spread,
        { paddingVertical: 9, alignItems: "flex-start" },
        first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border },
      ]}
    >
      <View style={[s.wrap, { flex: 1, gap: 10 }]}>
        <Text style={[s.mono, { minWidth: 72 }]}>{shortId(entry.agentId)}</Text>
        {entry.laneId ? <Chip icon="GitFork" label={entry.laneId} /> : null}
        <Text style={s.small}>{entry.reason}</Text>
      </View>
      <Text style={s.muted}>
        {clock(entry.startedAt)} → {entry.endedAt ? clock(entry.endedAt) : "至今"}
      </Text>
    </View>
  );
}

/** Shown only after tapping the 已归档 tag next to the session count. */
export function ArchivedSessions({
  entries,
  onArchiveLeftovers,
  busy,
  onClear,
  clearing,
}: {
  entries: HistoryEntry[];
  onArchiveLeftovers: () => void;
  busy: boolean;
  onClear: () => void;
  clearing: boolean;
}) {
  const { s } = useKit();
  return (
    <View style={[s.card, { gap: 4 }]}>
      <View style={[s.spread, { paddingBottom: 10, flexWrap: "wrap" }]}>
        <View style={s.row}>
          <Glyph name="Archive" size={14} />
          <Text style={s.h3}>已归档的调度员会话</Text>
          <Text style={s.muted}>{entries.length} 个</Text>
        </View>
        <View style={s.row}>
          <Button
            small
            icon="Archive"
            label="清理它们留下的会话和工作区"
            hint="调度员已归档、侧边栏还留着记录时用；在跑的不打断"
            loading={busy}
            onPress={onArchiveLeftovers}
          />
          <Button
            small
            variant="ghost"
            icon="Trash2"
            label="清空列表"
            hint="不再显示这些已归档的会话；Paseo 里的归档记录不动"
            loading={clearing}
            onPress={onClear}
          />
        </View>
      </View>
      {entries.map((entry, index) => (
        <ArchivedRow key={`${entry.agentId}-${entry.startedAt}`} entry={entry} first={index === 0} />
      ))}
    </View>
  );
}
