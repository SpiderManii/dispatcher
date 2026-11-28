import { Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Modal as NativeModal, Pressable, Text, View } from "react-native";
import { Button, KitBridge, tint, useKit } from "./ui";
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
  const kit = useKit();
  const { theme, s } = kit;
  const { open, onClose } = props;

  if (!isWeb) {
    return (
      <Modal title={props.title} open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
        {/* The phone sheet mounts outside the plugin's tree, where KitProvider no longer reaches. */}
        <Modal.Content>
          <KitBridge kit={kit}>{props.children}</KitBridge>
        </Modal.Content>
      </Modal>
    );
  }
  if (!open) return null;
  const c = theme.colors;
  // Drawn inside the screen, a `fixed` backdrop was caught by the scroll view above it: it covered only part of the
  // window and scrolled away with the page. React Native's Modal mounts at the top of the page on the web instead,
  // and closes on Escape.
  return (
    <NativeModal visible transparent animationType="none" onRequestClose={onClose}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "rgba(0, 0, 0, 0.55)" }} accessibilityViewIsModal>
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
    </NativeModal>
  );
}
