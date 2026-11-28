import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { answerDecisionsRpc, type LaneView } from "../shared/contracts";
import { ATTENTION_KEY } from "./briefs";
import { splitDecision } from "./decision-text";
import { Button, Checkbox, Glyph, errorText, tint, useKit } from "./ui";

export const STALE_ANSWER = "已过时，不用了";

/**
 * A lane's open `- [ ]` decisions, answerable in place. Answering ticks them in the ledger at once; the dispatcher
 * gets the answer when it is next idle, so a running turn is never interrupted.
 */
export function Decisions({ lane, dispatcherId }: { lane: LaneView; dispatcherId: string }) {
  const { theme, s } = useKit();
  const c = theme.colors;
  const queryClient = useQueryClient();
  const answer = useRpc(answerDecisionsRpc);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const mutation = useMutation({
    mutationFn: (input: { lines: string[]; answer: string }) => answer({ dispatcherId, laneId: lane.id, ...input }),
    onSuccess: () => {
      setSelected([]);
      setText("");
      setSent(true);
    },
    // Settled, not only success: the ledger may be ticked even when the reply to the dispatcher failed.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["dispatch-center", "overview"] });
      void queryClient.invalidateQueries({ queryKey: ATTENTION_KEY });
    },
  });
  const { decisions, unmarkedDecisions } = lane.ledger;
  if (decisions.length === 0 && unmarkedDecisions === 0 && !sent) return null;

  const toggle = (line: string) =>
    setSelected((list) => (list.includes(line) ? list.filter((item) => item !== line) : [...list, line]));
  const allSelected = decisions.length > 0 && selected.length === decisions.length;
  const picked = selected.filter((line) => decisions.some((item) => item.line === line));
  // A single open decision needs no ticking: the answer can only be for it. With several, the user picks.
  const live = picked.length > 0 ? picked : decisions.length === 1 ? [decisions[0].line] : [];
  const needsPick = live.length === 0 && decisions.length > 1;

  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: decisions.length > 0 ? tint(c.statusWarning, 0.4) : c.border,
        backgroundColor: decisions.length > 0 ? tint(c.statusWarning, 0.06) : c.surface2,
      }}
    >
      <View style={s.spread}>
        <View style={s.row}>
          <Glyph name="Gavel" size={13} tone={decisions.length > 0 ? "warning" : "neutral"} />
          <Text style={s.h3}>待你拍板 {decisions.length}</Text>
        </View>
        {decisions.length > 1 ? (
          <Button
            small
            variant="ghost"
            label={allSelected ? "取消全选" : "全选"}
            onPress={() => setSelected(allSelected ? [] : decisions.map((item) => item.line))}
          />
        ) : null}
      </View>

      {decisions.map((item) => {
        const checked = selected.includes(item.line);
        const open = expanded.includes(item.line);
        const { question, recommendation } = splitDecision(item.text);
        const conflict = question.includes("【冲突】");
        return (
          <View
            key={item.line}
            style={[
              s.row,
              { alignItems: "flex-start" },
              conflict ? { padding: 8, marginHorizontal: -4, borderRadius: 8, backgroundColor: tint(c.statusDanger, 0.08) } : null,
            ]}
          >
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              accessibilityLabel={`选中：${question}`}
              onPress={() => toggle(item.line)}
              style={({ pressed }) => ({ paddingTop: 1, opacity: pressed ? 0.7 : 1 })}
            >
              <Checkbox checked={checked} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={open ? "收起全文" : "展开全文"}
              onPress={() =>
                setExpanded((list) => (list.includes(item.line) ? list.filter((line) => line !== item.line) : [...list, item.line]))
              }
              style={({ pressed }) => ({ flex: 1, gap: 2, opacity: pressed ? 0.7 : 1 })}
            >
              <Text style={[s.small, { lineHeight: 18 }]} numberOfLines={open ? undefined : 1} selectable={open}>
                {conflict ? <Text style={{ color: c.statusDanger, fontWeight: "600" }}>两条线改动重合 · </Text> : null}
                {conflict ? question.replace("【冲突】", "").trim() : question}
              </Text>
              {recommendation ? (
                <Text style={s.muted} numberOfLines={open ? undefined : 1}>
                  推荐：{recommendation}
                </Text>
              ) : null}
            </Pressable>
            {item.hasRecommendation ? (
              <Button
                small
                label="按推荐"
                disabled={mutation.isPending}
                onPress={() => mutation.mutate({ lines: [item.line], answer: "按推荐" })}
              />
            ) : null}
            <Button
              small
              variant="ghost"
              label="已过时"
              disabled={mutation.isPending}
              onPress={() => mutation.mutate({ lines: [item.line], answer: STALE_ANSWER })}
            />
          </View>
        );
      })}

      {decisions.length > 0 ? (
        <View style={{ gap: 6 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={live.length > 0 ? `答复${picked.length > 0 ? "选中的 " : ""}${live.length} 条，如：按推荐，改成…` : "先勾选要答复的条目"}
            placeholderTextColor={c.foregroundMuted}
            style={[s.input, { minHeight: 56 }]}
          />
          {needsPick ? (
            <Text style={{ color: c.statusWarning, fontSize: 12 }}>
              有 {decisions.length} 条待拍板，先在上面勾选要答复的条目，「答复」才能点。
            </Text>
          ) : null}
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            {picked.length > 0 ? (
              <Button
                small
                variant="ghost"
                label="选中的都按推荐"
                disabled={mutation.isPending}
                onPress={() => mutation.mutate({ lines: picked, answer: "按推荐" })}
              />
            ) : null}
            <Button
              small
              variant="primary"
              icon="Send"
              label="答复"
              loading={mutation.isPending}
              disabled={live.length === 0 || !text.trim()}
              onPress={() => mutation.mutate({ lines: live, answer: text.trim() })}
            />
          </View>
        </View>
      ) : null}

      {unmarkedDecisions > 0 ? (
        <Text style={s.muted}>
          台账「待用户拍板」里还有 {unmarkedDecisions} 条没标状态（不带 [ ]），不计数。点「台账」查看；还没定的让调度员改成「- [ ]」。
        </Text>
      ) : null}
      {sent && !mutation.isPending && !mutation.error ? (
        <Text style={s.muted}>已记进台账。约 20 秒内连续的答复会合成一条，等调度员空闲时发给它，不会打断它正在做的事。</Text>
      ) : null}
      {mutation.error ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{errorText(mutation.error)}</Text> : null}
    </View>
  );
}

/**
 * What the dispatcher went ahead with on its own recommendation instead of asking. Folded: it is a record, not a
 * question. To overrule one, the user tells the dispatcher in its conversation.
 */
export function DecidedForYou({ lane, openAgent }: { lane: LaneView; openAgent?: (agentId: string) => void }) {
  const { s } = useKit();
  const [open, setOpen] = useState(false);
  const { count, recent } = lane.ledger.byRecommendation;
  if (count === 0) return null;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [s.row, { gap: 6, opacity: pressed ? 0.6 : 1 }]}
      >
        <Glyph name="CheckCheck" size={12} />
        <Text style={s.muted}>按推荐直接做了 {count} 条，没问你</Text>
        <Glyph name={open ? "ChevronUp" : "ChevronDown"} size={12} />
      </Pressable>
      {open ? (
        <View style={{ gap: 3, paddingLeft: 18 }}>
          {count > recent.length ? <Text style={s.muted}>最近 {recent.length} 条：</Text> : null}
          {recent.map((item, index) => (
            <Text key={`${index}-${item}`} style={[s.small, { lineHeight: 18 }]} selectable>
              · {item}
            </Text>
          ))}
          <View style={[s.row, { gap: 8 }]}>
            <Text style={[s.muted, { flex: 1 }]}>要改哪条，在调度员对话里直接说，以你说的为准。</Text>
            {openAgent ? <Button small variant="ghost" icon="SquareArrowOutUpRight" label="打开" onPress={() => openAgent(lane.agentId)} /> : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
