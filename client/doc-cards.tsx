import { Markdown, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { bodyOf, cardTitle, groupSections, preview, type DocSection } from "./doc-sections";
import { Button, Chip, Glyph, tint, useKit } from "./ui";

/**
 * A long rules file as cards: group tabs on top, one card per rule, collapsed to a title and a line of summary until
 * tapped. Search looks across every group. With `fill` the toolbar stays put and only the cards scroll.
 */
export function DocCards({ sections, fill }: { sections: DocSection[]; fill: boolean }) {
  const { theme, s } = useKit();
  const c = theme.colors;
  const accent = c.accent ?? c.foreground;
  const groups = useMemo(() => groupSections(sections), [sections]);
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const current = tab < groups.length ? tab : 0;
  const all = groups.flatMap((group, g) => group.cards.map((card, i) => ({ key: `${g}:${i}`, group, card })));
  const q = query.trim().toLowerCase();
  const shown = q ? all.filter(({ card }) => `${card.title}\n${card.markdown}`.toLowerCase().includes(q)) : all.filter(({ group }) => group === groups[current]);
  // A search with a few hits is for reading them, so they open on their own.
  const autoOpen = q !== "" && shown.length <= 3;
  const isOpen = (key: string) => autoOpen || open.has(key);
  const allOpen = shown.length > 0 && shown.every(({ key }) => isOpen(key));
  const toggle = (key: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const toolbar = (
    <View style={{ gap: 10 }}>
      <View style={[s.wrap, { gap: 8 }]}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, flex: 1, minWidth: 260 }}>
          {q ? (
            <Text style={s.muted}>搜索「{query.trim()}」：{shown.length} 条</Text>
          ) : (
            groups.map((group, g) => <Chip key={group.title} label={group.label} trailing={String(group.cards.length)} selected={g === current} onPress={() => setTab(g)} />)
          )}
        </View>
        <TextInput
          accessibilityLabel="搜索规则"
          placeholder="搜索规则"
          placeholderTextColor={c.foregroundMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          style={[s.singleInput, { width: 200 }]}
        />
        <Button
          small
          variant="ghost"
          icon={allOpen ? "ChevronsDownUp" : "ChevronsUpDown"}
          label={allOpen ? "全部收起" : "全部展开"}
          onPress={() => setOpen(allOpen ? new Set() : new Set(shown.map(({ key }) => key)))}
        />
      </View>
    </View>
  );

  const cards =
    shown.length === 0 ? (
      <Text style={s.muted}>没有匹配的规则。</Text>
    ) : (
      <View style={[s.wrap, { gap: 10, alignItems: "flex-start" }]}>
        {shown.map(({ key, group, card }) => {
          const expanded = isOpen(key);
          const title = cardTitle(card.title);
          return (
            <View
              key={key}
              style={{
                flexGrow: 1,
                flexBasis: expanded ? "100%" : 340,
                minWidth: 260,
                maxWidth: "100%",
                borderRadius: 12,
                borderWidth: 1,
                borderColor: expanded ? tint(accent, 0.55) : c.border,
                backgroundColor: c.surface1,
                overflow: "hidden",
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => toggle(key)}
                style={({ pressed }) =>
                  [{ padding: 14, gap: 6, backgroundColor: pressed ? c.surface2 : "transparent", outlineStyle: "none" }] as unknown as object
                }
              >
                <View style={[s.row, { gap: 8 }]}>
                  {title.number ? (
                    <View style={{ minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: "center", justifyContent: "center", backgroundColor: tint(accent, 0.16) }}>
                      <Text style={{ color: accent, fontSize: 12, fontWeight: "600" }}>{title.number}</Text>
                    </View>
                  ) : null}
                  <Text style={{ flex: 1, color: c.foreground, fontSize: 14, fontWeight: "600" }} numberOfLines={expanded ? 3 : 1}>
                    {title.text}
                  </Text>
                  {q ? <Chip label={group.label} /> : null}
                  <Glyph name={expanded ? "ChevronUp" : "ChevronDown"} size={14} />
                </View>
                {expanded ? null : (
                  <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }} numberOfLines={2}>
                    {preview(bodyOf(card)) || "（空）"}
                  </Text>
                )}
              </Pressable>
              {expanded ? (
                <View style={{ paddingHorizontal: 16, paddingBottom: 14, borderTopWidth: 1, borderTopColor: c.border }}>
                  <Markdown>{bodyOf(card)}</Markdown>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    );

  if (!fill)
    return (
      <View style={{ gap: 12 }}>
        {toolbar}
        {cards}
      </View>
    );
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
      {toolbar}
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 12 }}>
        {cards}
      </ScrollView>
    </View>
  );
}
