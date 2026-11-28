import { Pressable, Text, View } from "react-native";
import type { LaneView } from "../shared/contracts";
import { Glyph, relativeTime, useKit } from "./ui";

/** The newest status files the lane's workers wrote, each with its conclusion: results without reading the chats. */
export function LaneReports({ reports, openDoc }: { reports: LaneView["reports"]; openDoc: (path: string, title: string) => void }) {
  const { s, compact } = useKit();
  if (reports.length === 0) return null;
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.muted}>最近交付</Text>
      {reports.map((report) => (
        <Pressable
          key={report.path}
          accessibilityRole="button"
          accessibilityLabel={`查看 ${report.name}`}
          onPress={() => openDoc(report.path, report.name)}
          style={({ pressed }) => [s.row, { alignItems: "flex-start", gap: 6, paddingVertical: 2, opacity: pressed ? 0.6 : 1 }]}
        >
          <View style={{ paddingTop: 2 }}>
            <Glyph name="FileCheck" size={12} />
          </View>
          <View style={{ flex: 1, flexDirection: compact ? "column" : "row", gap: compact ? 1 : 8, minWidth: 0 }}>
            <Text style={[s.small, { fontWeight: "600", flexShrink: 0 }]} numberOfLines={1}>
              {report.name}
            </Text>
            {report.headline ? (
              <Text style={[s.muted, { flex: 1 }]} numberOfLines={1}>
                {report.headline}
              </Text>
            ) : null}
          </View>
          <Text style={s.muted}>{relativeTime(report.modifiedAt)}</Text>
        </Pressable>
      ))}
    </View>
  );
}
