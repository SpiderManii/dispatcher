import { Icon } from "@getpaseo/plugin/client/ui";
import { Fragment } from "react";
import { Pressable, Text, View } from "react-native";
import { STAGE_WORDS, STEPS, type LaneStageView, type StageWord } from "../shared/contracts";
import { tint, useKit } from "./ui";
import { WideModal } from "./wide-modal";

/** 计划 → 开发 → 验收 → 合回 → 部署 → 完成, with the requirement's step lit. Amber when the next move is the user's. */
export function StagePipeline({ stage }: { stage: LaneStageView | null }) {
  const { theme, compact } = useKit();
  const c = theme.colors;
  const current = stage ? STEPS.indexOf(stage.step) : -1;
  const finished = stage?.step === "完成";
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", flexWrap: "nowrap" }}
      accessibilityLabel={stage ? `阶段：${stage.word}` : "阶段未知"}
    >
      {STEPS.map((step, index) => {
        const done = index < current || (finished && index === current);
        const active = index === current && !finished;
        const color = done ? c.statusSuccess : active ? (stage?.waiting ? c.statusWarning : c.accent) : c.foregroundMuted;
        const showLabel = !compact || active || (finished && index === current);
        return (
          <Fragment key={step}>
            {index > 0 ? (
              <View
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                  minWidth: 6,
                  maxWidth: 40,
                  height: 2,
                  marginHorizontal: 4,
                  borderRadius: 1,
                  backgroundColor: index <= current ? tint(c.statusSuccess, 0.55) : tint(c.foregroundMuted, 0.25),
                }}
              />
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <View
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: done ? c.statusSuccess : active ? tint(color, 0.18) : "transparent",
                  borderWidth: done ? 0 : 1.5,
                  borderColor: active ? color : tint(c.foregroundMuted, 0.45),
                }}
              >
                {done ? (
                  <Icon name="Check" size={10} color={c.surface0} />
                ) : active ? (
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
                ) : null}
              </View>
              {showLabel ? (
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 12,
                    color: active ? color : done ? c.foreground : c.foregroundMuted,
                    fontWeight: active ? "700" : "400",
                  }}
                >
                  {active && stage && stage.word !== step ? stage.word : step}
                </Text>
              ) : null}
            </View>
          </Fragment>
        );
      })}
    </View>
  );
}

const MEANING: Record<StageWord, string> = {
  计划: "分诊、拆分或架构，还没开工",
  开发: "施工或返修中",
  验收: "测试、审查、三闸核验中",
  待合回: "验收都过了，等你同意合回收口分支",
  合回中: "调度员在合回、跑回归、清理分支",
  待部署: "已收口，等你点「部署」",
  部署中: "部署工位在发布和验收",
  待推送: "部署完了（或不用部署），等你点「推送」把 dev 或收口分支推到远端",
  已完成: "做完了，归档后释放名额",
};

/** Lets the user correct the stage when the dispatcher forgot to move it. */
export function StagePicker(props: {
  open: boolean;
  current: string | null;
  title: string;
  onPick: (word: StageWord) => void;
  onClose: () => void;
}) {
  const { theme, s } = useKit();
  const c = theme.colors;
  return (
    <WideModal title={`改阶段 · ${props.title}`} open={props.open} onClose={props.onClose} width={560}>
      <Text style={s.muted}>写进本线台账的「阶段」行，调度员下次读台账时就知道。一般不用改，调度员和插件会自己推进。</Text>
      <View style={{ gap: 6 }}>
        {STAGE_WORDS.map((word) => {
          const selected = props.current === word;
          return (
            <Pressable
              key={word}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => {
                props.onClose();
                if (!selected) props.onPick(word);
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: selected ? c.accent : c.border,
                backgroundColor: selected ? tint(c.accent, 0.1) : c.surface1,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={[s.h3, { width: 56 }]}>{word}</Text>
              <Text style={[s.muted, { flex: 1 }]}>{MEANING[word]}</Text>
              {selected ? <Icon name="Check" size={14} color={c.accent} /> : null}
            </Pressable>
          );
        })}
      </View>
    </WideModal>
  );
}
