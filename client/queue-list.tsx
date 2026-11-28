import { Text, View } from "react-native";
import type { QueuedView } from "../shared/contracts";
import { requirementTitle } from "../shared/lane-text";
import { Button, Glyph, relativeTime, tint, useKit } from "./ui";

/** Requirements waiting for a free lane, next first. Each starts on its own when its slot frees up. */
export function QueueList(props: {
  items: QueuedView[];
  showDispatcher: boolean;
  busy: boolean;
  onFront: (item: QueuedView) => void;
  onRetry: (item: QueuedView) => void;
  onCancel: (item: QueuedView) => void;
}) {
  const { theme, s } = useKit();
  const c = theme.colors;
  if (props.items.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      <View style={s.row}>
        <Glyph name="Clock" size={14} />
        <Text style={s.h3}>排队中 {props.items.length}</Text>
        <Text style={s.muted}>有空位按顺序自动开始</Text>
      </View>
      {props.items.map((item) => {
        const title = requirementTitle(item.summary) ?? (item.projects.join(" + ") || "（没写需求）");
        const tone = item.problem ? c.statusDanger : item.ready ? c.accent : c.foregroundMuted;
        return (
          <View
            key={item.id}
            style={[
              s.card,
              { gap: 8, paddingVertical: 12, borderStyle: "dashed" },
              item.problem ? { borderColor: tint(c.statusDanger, 0.5) } : null,
            ]}
          >
            <View style={[s.spread, { alignItems: "flex-start" }]}>
              <View style={[s.row, { flex: 1, alignItems: "flex-start", gap: 10 }]}>
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: tint(c.foregroundMuted, 0.15),
                  }}
                >
                  <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "700" }}>{item.position}</Text>
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={[s.h3, { lineHeight: 20 }]} numberOfLines={2}>
                    {title}
                  </Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {[
                      item.projects.join(" + "),
                      `排队于 ${relativeTime(item.queuedAt)}`,
                      item.images > 0 ? `附图 ${item.images}` : "",
                      props.showDispatcher ? item.dispatcherName : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                  <View style={[s.row, { gap: 6, alignItems: "flex-start" }]}>
                    <View style={{ paddingTop: 2 }}>
                      <Glyph name={item.problem ? "CircleAlert" : item.ready ? "Play" : "Hourglass"} size={12} color={tone} />
                    </View>
                    <Text style={{ color: tone, fontSize: 12, lineHeight: 17, flex: 1 }} numberOfLines={3}>
                      {item.waiting}
                    </Text>
                  </View>
                </View>
              </View>
            </View>
            <View style={[s.row, { justifyContent: "flex-end" }]}>
              {item.paused ? (
                <Button small variant="primary" icon="RotateCw" label="重试" disabled={props.busy} onPress={() => props.onRetry(item)} />
              ) : null}
              {item.position > 1 ? (
                <Button small variant="ghost" icon="ArrowUpToLine" label="提到最前" disabled={props.busy} onPress={() => props.onFront(item)} />
              ) : null}
              <Button small variant="ghost" icon="X" label="取消排队" disabled={props.busy} onPress={() => props.onCancel(item)} />
            </View>
          </View>
        );
      })}
    </View>
  );
}
