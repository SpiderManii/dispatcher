// The review §9 wants of a sensitive change, as the lane card and the panel beside a session show it.
import { Text, View } from "react-native";
import type { LaneView } from "../shared/contracts";
import type { ConfirmRequest } from "./dialogs";
import { Glyph, useKit, type Tone } from "./ui";

type Review = NonNullable<LaneView["review"]>;

const LOOK: Record<Review["state"], { text: string; icon: string; tone: Tone }> = {
  needed: { text: "还没审查，合回前要审", icon: "ShieldAlert", tone: "warning" },
  running: { text: "审查中", icon: "Shield", tone: "accent" },
  done: { text: "已审查", icon: "ShieldCheck", tone: "success" },
  waived: { text: "你选了不审查", icon: "ShieldOff", tone: "neutral" },
};

/** One line: which sensitive changes the plugin found, and where their review stands. Nothing when none were found. */
export function ReviewLine({ review }: { review: LaneView["review"] }) {
  const { s } = useKit();
  if (!review) return null;
  const look = LOOK[review.state];
  return (
    <View style={[s.row, { alignItems: "flex-start", gap: 6 }]}>
      <View style={{ paddingTop: 2 }}>
        <Glyph name={look.icon} size={12} tone={look.tone} />
      </View>
      <Text style={[s.muted, { flex: 1, lineHeight: 18 }]} numberOfLines={2}>
        敏感改动：{review.kinds.join("、")} · {look.text}
      </Text>
    </View>
  );
}

/** 不用审查 asks first, listing what the plugin found, since it lets an unreviewed change be merged back. */
export function waiveRequest(review: Review, waive: () => void): ConfirmRequest {
  const found = review.hits.map((hit) => `· ${hit.kind}：${hit.text}（${hit.card}）`).join("\n");
  return {
    title: "这条需求不审查？",
    message: `插件在任务卡上认出这些敏感改动：\n${found}\n\n按规则第 9 节，这类改动要审查一次再合回。选不审查就直接放行合回，台账「最近完成」会记一行「不审查」。`,
    confirmLabel: "不审查，放行合回",
    danger: true,
    onConfirm: waive,
  };
}
