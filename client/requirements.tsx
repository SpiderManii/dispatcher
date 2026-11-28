import { Text, View } from "react-native";
import type { LaneView } from "../shared/contracts";
import { focusRequirement } from "../shared/lane-text";
import { Glyph, useKit } from "./ui";

const MAX_SHOWN = 6;

/**
 * The requirements a lane took on one after another in the same conversation: each with its own stage, the one
 * being pushed now marked. Nothing for a lane with a single requirement, which the stage bar already describes.
 */
export function RequirementList({ lane }: { lane: Pick<LaneView, "ledger"> }) {
  const { theme, s } = useKit();
  const items = lane.ledger.requirements;
  const focus = focusRequirement(items);
  if (!focus) return null;
  const done = items.filter((item) => item.done).length;
  // Open ones first in the cut, so a long history of finished ones never hides what is still going.
  const shown = items.length > MAX_SHOWN ? [...items.filter((item) => !item.done), ...items.filter((item) => item.done)].slice(0, MAX_SHOWN) : items;
  const order = new Map(items.map((item, index) => [item.id, index]));
  shown.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.muted}>
        需求 · 共 {items.length} 项，{done} 项已完成
      </Text>
      {shown.map((item) => {
        const current = item.id === focus.id;
        const color = item.done ? theme.colors.foregroundMuted : theme.colors.foreground;
        return (
          <View key={item.id} style={[s.row, { alignItems: "flex-start", gap: 6 }]}>
            <View style={{ paddingTop: 2 }}>
              <Glyph
                name={item.done ? "CircleCheck" : current ? "LoaderCircle" : "Circle"}
                size={12}
                color={item.done ? theme.colors.statusSuccess : current ? theme.colors.statusWarning : theme.colors.foregroundMuted}
              />
            </View>
            <Text
              style={[
                s.small,
                { flex: 1, lineHeight: 18, color, textDecorationLine: item.done ? "line-through" : "none", fontWeight: current ? "600" : "400" },
              ]}
              numberOfLines={2}
            >
              {item.id}【{item.word ?? "?"}】{item.text}
            </Text>
          </View>
        );
      })}
      {items.length > shown.length ? <Text style={s.muted}>…另 {items.length - shown.length} 项已完成，见台账</Text> : null}
    </View>
  );
}
