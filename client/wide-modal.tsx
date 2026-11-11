import { Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, type ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { Button, tint, useKit } from "./ui";
import { isWeb } from "./web-drop";

/**
 * Paseo's own Modal is a fixed 520px sheet on desktop and offers no width. On the web build this draws the dialog
 * itself, over the whole window, at the width asked for. Phones keep Paseo's sheet, which is already full width there.
 */
export function WideModal(props: {
  title: string;
  open: boolean;
  onClose: () => void;
  width?: number;
  /** A tall dialog whose body lays out its own scrolling panes instead of scrolling as one page. */
  fill?: boolean;
  children: ReactNode;
}) {
  const { theme, s } = useKit();
  const { open, onClose } = props;

  useEffect(() => {
    if (!isWeb || !open) return;
    const target = (globalThis as { document?: { addEventListener(type: string, fn: (event: { key: string }) => void): void; removeEventListener(type: string, fn: (event: { key: string }) => void): void } }).document;
    if (!target) return;
    const onKey = (event: { key: string }) => {
      if (event.key === "Escape") onClose();
    };
    target.addEventListener("keydown", onKey);
    return () => target.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!isWeb) {
    return (
      <Modal title={props.title} open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
        <Modal.Content>{props.children}</Modal.Content>
      </Modal>
    );
  }
  if (!open) return null;
  const c = theme.colors;
  // `fixed` is web-only, so it is not in React Native's types.
  const overlay = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
  } as unknown as ViewStyle;
  return (
    <View style={overlay} accessibilityViewIsModal>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <View
        style={{
          width: "100%",
          maxWidth: props.width ?? 960,
          maxHeight: "100%",
          ...(props.fill ? { height: "100%", maxHeight: 900 } : null),
          borderRadius: 16,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.surface0,
          overflow: "hidden",
        }}
      >
        <View style={[s.spread, { paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: tint(c.border, 1) }]}>
          <Text style={[s.h2, { flex: 1 }]} numberOfLines={1}>
            {props.title}
          </Text>
          <Button small variant="ghost" icon="X" hint="关闭" onPress={onClose} />
        </View>
        {props.fill ? (
          <View style={{ flex: 1, minHeight: 0, padding: 20, gap: 12 }}>{props.children}</View>
        ) : (
          <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: 20, gap: 14 }}>
            {props.children}
          </ScrollView>
        )}
      </View>
    </View>
  );
}
