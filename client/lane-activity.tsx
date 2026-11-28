import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { LaneView } from "../shared/contracts";
import { Glyph, duration, relativeTime, useKit, type Tone } from "./ui";

const EVENT_LOOK: Record<string, { label: string; icon: string; tone: Tone }> = {
  dispatched: { label: "派出", icon: "Send", tone: "accent" },
  ended: { label: "完成", icon: "CircleCheck", tone: "success" },
  failed: { label: "失败", icon: "CircleX", tone: "danger" },
  interrupted: { label: "中断", icon: "Unplug", tone: "warning" },
  stuck: { label: "疑似卡住", icon: "Hourglass", tone: "warning" },
  gone: { label: "会话不见了", icon: "Ghost", tone: "warning" },
  canceled: { label: "已取消", icon: "Ban", tone: "neutral" },
  answered: { label: "你答复了", icon: "Gavel", tone: "accent" },
  auto_answered: { label: "超时自动答复", icon: "TimerReset", tone: "warning" },
  auto_stale: { label: "自动关了过时的待拍板", icon: "CheckCheck", tone: "neutral" },
  merge_ok: { label: "你同意合回", icon: "GitMerge", tone: "accent" },
  deploy_ok: { label: "你点了部署", icon: "Rocket", tone: "accent" },
  stage_set: { label: "你改了阶段", icon: "ListChecks", tone: "neutral" },
  queued_start: { label: "排队后开始", icon: "Clock", tone: "accent" },
  nudged: { label: "你催了一下", icon: "BellRing", tone: "neutral" },
  pushed: { label: "你推送了", icon: "Upload", tone: "accent" },
  review_needed: { label: "认出敏感改动", icon: "ShieldAlert", tone: "warning" },
  review_requested: { label: "你要了审查", icon: "ShieldCheck", tone: "accent" },
  review_waived: { label: "你选了不审查", icon: "ShieldOff", tone: "neutral" },
};

const COLLAPSED = 3;

/** What the lane is doing now and what happened lately, without opening the dispatcher's conversation. */
export function LaneActivity({ lane, openAgent }: { lane: LaneView; openAgent?: (agentId: string) => void }) {
  const { s } = useKit();
  const [expanded, setExpanded] = useState(false);
  if (lane.running.length === 0 && lane.events.length === 0) return null;
  const events = expanded ? lane.events : lane.events.slice(0, COLLAPSED);

  return (
    <View style={[s.inset, { gap: 6, paddingVertical: 10 }]} testID="lane-activity">
      {lane.running.map((card) => (
        <Pressable
          key={card.id}
          accessibilityRole="button"
          accessibilityLabel={`打开 ${card.title ?? card.id}`}
          disabled={!openAgent}
          onPress={() => openAgent?.(card.id)}
          style={({ pressed }) => [s.row, { gap: 6, opacity: pressed ? 0.6 : 1 }]}
        >
          <Glyph name="LoaderCircle" size={13} tone="accent" />
          <Text style={[s.small, { flex: 1 }]} numberOfLines={1}>
            {card.title ?? card.id}
          </Text>
          <Text style={s.muted}>{card.since ? `已跑 ${duration(card.since)}` : "在跑"}</Text>
        </Pressable>
      ))}
      {events.length > 0 ? (
        <View style={{ gap: 3 }}>
          {events.map((event, index) => {
            const look = EVENT_LOOK[event.kind] ?? { label: event.kind, icon: "Dot", tone: "neutral" as Tone };
            const subject = event.title ?? event.detail ?? "";
            return (
              <View key={`${event.at}-${index}`} style={[s.row, { gap: 6 }]}>
                <Glyph name={look.icon} size={12} tone={look.tone} />
                <Text style={[s.small, { flex: 1 }]} numberOfLines={1}>
                  {look.label}
                  {subject ? ` · ${subject}` : ""}
                </Text>
                <Text style={s.muted}>{relativeTime(event.at)}</Text>
              </View>
            );
          })}
          {lane.events.length > COLLAPSED ? (
            <Pressable accessibilityRole="button" onPress={() => setExpanded((open) => !open)}>
              <Text style={s.muted}>{expanded ? "收起" : `更多动态（${lane.events.length - COLLAPSED}）`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
