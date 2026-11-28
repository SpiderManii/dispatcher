import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { DispatcherView } from "../shared/contracts";
import type { CardActions } from "./lane-row";
import { Button, Glyph, clock, shortId, statusOf, useKit } from "./ui";

type HistoryEntry = DispatcherView["history"][number];

/**
 * History minus the sessions on a lane, and minus archived or vanished ones: those are only a record the plugin keeps
 * to archive their workers once they finish. Not shown; nothing to do with them.
 */
function unarchivedRetired(item: DispatcherView): HistoryEntry[] {
  const onLane = new Set(item.lanes.map((lane) => lane.agentId));
  return item.history.filter((entry) => !onLane.has(entry.agentId) && !!entry.status && entry.status !== "archived");
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
  const unarchived = unarchivedRetired(item);
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
