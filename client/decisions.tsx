import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { answerDecisionsRpc, type LaneView } from "../shared/contracts";
import { Button, Checkbox, Glyph, errorText, tint, useKit } from "./ui";

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
  const mutation = useMutation({
    mutationFn: (input: { lines: string[]; answer: string }) => answer({ dispatcherId, laneId: lane.id, ...input }),
    onSuccess: async () => {
      setSelected([]);
      setText("");
      setSent(true);
      await queryClient.invalidateQueries({ queryKey: ["dispatch-center", "overview"] });
    },
  });
  const { decisions, unmarkedDecisions } = lane.ledger;
  if (decisions.length === 0 && unmarkedDecisions === 0 && !sent) return null;

  const toggle = (line: string) =>
    setSelected((list) => (list.includes(line) ? list.filter((item) => item !== line) : [...list, line]));
  const allSelected = decisions.length > 0 && selected.length === decisions.length;
  const live = selected.filter((line) => decisions.some((item) => item.line === line));

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
        return (
          <View key={item.line} style={[s.row, { alignItems: "flex-start" }]}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              accessibilityLabel={item.text}
              onPress={() => toggle(item.line)}
              style={({ pressed }) => [s.row, { flex: 1, alignItems: "flex-start", opacity: pressed ? 0.7 : 1 }]}
            >
              <View style={{ paddingTop: 1 }}>
                <Checkbox checked={checked} />
              </View>
              <Text style={[s.small, { flex: 1, lineHeight: 18 }]} selectable>
                {item.text}
              </Text>
            </Pressable>
            {item.hasRecommendation ? (
              <Button
                small
                label="按推荐"
                disabled={mutation.isPending}
                onPress={() => mutation.mutate({ lines: [item.line], answer: "按推荐" })}
              />
            ) : null}
          </View>
        );
      })}

      {decisions.length > 0 ? (
        <View style={{ gap: 6 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={live.length > 0 ? `答复选中的 ${live.length} 条，如：按推荐，第 2 条改成…` : "先勾选要答复的条目"}
            placeholderTextColor={c.foregroundMuted}
            style={[s.input, { minHeight: 56 }]}
          />
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            {live.length > 0 ? (
              <Button
                small
                variant="ghost"
                label="选中的都按推荐"
                disabled={mutation.isPending}
                onPress={() => mutation.mutate({ lines: live, answer: "按推荐" })}
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
