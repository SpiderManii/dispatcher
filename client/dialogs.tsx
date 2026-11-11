import { useRpc } from "@getpaseo/plugin/client";
import { Loading, Markdown, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { readDocRpc } from "../shared/contracts";
import { DocCards } from "./doc-cards";
import { splitSections } from "./doc-sections";
import { Banner, Button, basename, errorText, relativeTime, useKit } from "./ui";
import { isWeb } from "./web-drop";
import { WideModal } from "./wide-modal";

export interface DocTarget {
  path: string;
  title?: string;
}

const ALL = -1;

/** Shows a ledger, handoff, AGENTS.md or registry file from the dispatch home as rendered Markdown. */
export function DocViewer({ target, onClose }: { target: DocTarget | null; onClose: () => void }) {
  const { theme, s } = useKit();
  const toast = useToast();
  const read = useRpc(readDocRpc);
  const [picked, setPicked] = useState(0);
  const doc = useQuery({
    queryKey: ["dispatch-center", "doc", target?.path],
    queryFn: () => read({ path: target!.path }),
    enabled: target !== null,
    refetchInterval: 10_000,
  });
  useEffect(() => setPicked(0), [target?.path]);
  const isJson = target?.path.endsWith(".json") ?? false;
  const content = doc.data?.content ?? "";
  // A long rules file is read one section at a time; a short note or a JSON file is shown whole.
  const sections = useMemo(() => (isJson ? [] : splitSections(content)), [content, isJson]);
  const split = sections.length >= 3;
  const index = picked >= sections.length ? 0 : picked;
  const shown = !split || picked === ALL ? content : sections[index].markdown;
  const c = theme.colors;
  const body = (
    <View style={{ padding: 18, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
      <Markdown>{isJson ? "```json\n" + shown + "\n```" : shown}</Markdown>
    </View>
  );
  const meta = doc.data
    ? `更新于 ${relativeTime(doc.data.modifiedAt)}${content ? ` · ${Math.max(1, Math.round(new TextEncoder().encode(content).length / 1024))} KB` : ""}${split ? ` · ${sections.length} 节` : ""}`
    : "";
  return (
    <WideModal title={target?.title ?? (target ? basename(target.path) : "")} open={target !== null} onClose={onClose} width={1120} fill={isWeb}>
      <View style={[s.row, { gap: 6 }]}>
        <Text style={[s.mono, { flexShrink: 1 }]} selectable numberOfLines={1}>
          {target?.path}
        </Text>
        {meta ? <Text style={s.muted}>· {meta}</Text> : null}
        <View style={{ flex: 1 }} />
        <Button
          small
          variant="ghost"
          icon="Copy"
          hint="复制路径"
          onPress={() => {
            if (!target) return;
            copyText(target.path).then(
              () => toast.show("已复制路径", { variant: "success" }),
              (error) => toast.error(errorText(error)),
            );
          }}
        />
      </View>
      {doc.isPending ? <Loading /> : null}
      {doc.isError ? (
        <Banner tone="danger" icon="CircleAlert" title="读取失败">
          <Text style={s.small}>{errorText(doc.error)}</Text>
        </Banner>
      ) : null}
      {doc.data ? (
        content.trim() === "" ? (
          <Text style={s.muted}>（空文件）</Text>
        ) : split ? (
          <DocCards sections={sections} fill={isWeb} />
        ) : isWeb ? (
          <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 12 }}>
            {body}
          </ScrollView>
        ) : (
          body
        )
      ) : null}
      {doc.data?.truncated ? <Text style={s.muted}>文件过长，只显示前 256KB。</Text> : null}
    </WideModal>
  );
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const { s } = useKit();
  return (
    <WideModal title={request?.title ?? ""} open={request !== null} onClose={onClose} width={640}>
      <Text style={[s.text, { lineHeight: 22 }]}>{request?.message}</Text>
      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button label="取消" variant="ghost" onPress={onClose} />
        <Button
          label={request?.confirmLabel ?? "确定"}
          variant={request?.danger ? "danger" : "primary"}
          onPress={() => {
            const action = request?.onConfirm;
            onClose();
            action?.();
          }}
        />
      </View>
    </WideModal>
  );
}
