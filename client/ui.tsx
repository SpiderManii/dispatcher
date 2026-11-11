// Small themed building blocks shared by the dispatch center screens.
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

export type Theme = PluginHostProps["theme"];
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

/** Mixes a theme colour with transparency; falls back to the raw colour for formats we do not parse. */
export function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const full = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const value = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
      .toString(16)
      .padStart(2, "0");
    return `#${full}${value}`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((part) => part.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

export function toneColor(theme: Theme, tone: Tone): string {
  switch (tone) {
    case "accent":
      return theme.colors.accent;
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  idle: { label: "空闲待命", tone: "success" },
  running: { label: "执行中", tone: "accent" },
  initializing: { label: "启动中", tone: "accent" },
  closed: { label: "已关闭 · 可恢复", tone: "warning" },
  error: { label: "出错", tone: "danger" },
  archived: { label: "已归档", tone: "neutral" },
};

export function statusOf(status: string | null | undefined): { label: string; tone: Tone } {
  if (!status) return { label: "已不存在", tone: "neutral" };
  return STATUS[status] ?? { label: status, tone: "neutral" };
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(at).toLocaleDateString();
}

export function duration(fromIso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function clock(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function basename(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? file;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.surface0 },
    content: { padding: compact ? 14 : 24, gap: compact ? 14 : 18, maxWidth: 1280, width: "100%", alignSelf: "center" },
    h1: { color: c.foreground, fontSize: compact ? 20 : 24, fontWeight: "700" },
    h2: { color: c.foreground, fontSize: 15, fontWeight: "600" },
    h3: { color: c.foreground, fontSize: 14, fontWeight: "600" },
    text: { color: c.foreground, fontSize: 14 },
    small: { color: c.foreground, fontSize: 12 },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    mono: { color: c.foregroundMuted, fontSize: 12, fontFamily: "Menlo, Consolas, monospace" },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
    spread: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    card: {
      padding: compact ? 14 : 16,
      gap: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface1,
    },
    inset: {
      padding: 12,
      gap: 8,
      borderRadius: 10,
      backgroundColor: c.surface2,
    },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    input: {
      minHeight: 84,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      color: c.foreground,
      backgroundColor: c.surface2,
      textAlignVertical: "top",
      fontSize: 14,
    },
    singleInput: {
      flex: 1,
      minHeight: 36,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      color: c.foreground,
      backgroundColor: c.surface2,
      fontSize: 13,
    },
  });
}

export type Styles = ReturnType<typeof makeStyles>;

interface Kit {
  theme: Theme;
  compact: boolean;
  s: Styles;
}

const KitContext = createContext<Kit | null>(null);

export function KitProvider({ theme, compact, children }: { theme: Theme; compact: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ theme, compact, s: makeStyles(theme, compact) }), [theme, compact]);
  return <KitContext.Provider value={value}>{children}</KitContext.Provider>;
}

export function useKit(): Kit {
  const kit = useContext(KitContext);
  if (!kit) throw new Error("KitProvider missing");
  return kit;
}

export function Glyph({ name, size = 14, color, tone }: { name: string; size?: number; color?: string; tone?: Tone }) {
  const { theme } = useKit();
  return <Icon name={name} size={size} color={color ?? toneColor(theme, tone ?? "neutral")} />;
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button(props: {
  label?: string;
  icon?: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  hint?: string;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useKit();
  const c = theme.colors;
  const variant = props.variant ?? "secondary";
  const disabled = props.disabled || props.loading;
  const fg =
    variant === "primary" ? c.accentForeground : variant === "danger" ? c.statusDanger : c.foreground;
  const bg =
    variant === "primary"
      ? c.accent
      : variant === "danger"
        ? tint(c.statusDanger, 0.1)
        : variant === "ghost"
          ? "transparent"
          : c.surface2;
  const border = variant === "secondary" ? c.border : variant === "danger" ? tint(c.statusDanger, 0.35) : "transparent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.hint ?? props.label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          minHeight: props.small ? 28 : 34,
          paddingHorizontal: props.label ? (props.small ? 10 : 14) : props.small ? 6 : 9,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: bg,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
        props.style,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : props.icon ? (
        <Icon name={props.icon} size={props.small ? 13 : 15} color={fg} />
      ) : null}
      {props.label ? (
        <Text style={{ color: fg, fontSize: props.small ? 12 : 13, fontWeight: "600" }}>{props.label}</Text>
      ) : null}
    </Pressable>
  );
}

/** Rounded label; pass onPress to make it a toggle/filter chip. */
export function Chip(props: {
  label: string;
  icon?: string;
  tone?: Tone;
  selected?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  hint?: string;
  trailing?: string;
}) {
  const { theme } = useKit();
  const c = theme.colors;
  const color = props.selected ? c.accent : toneColor(theme, props.tone ?? "neutral");
  const body = (
    <>
      {props.icon ? <Icon name={props.icon} size={12} color={props.selected ? c.accent : color} /> : null}
      <Text
        numberOfLines={1}
        style={{ color: props.tone && props.tone !== "neutral" && !props.selected ? color : c.foreground, fontSize: 12 }}
      >
        {props.label}
      </Text>
      {props.trailing ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{props.trailing}</Text> : null}
    </>
  );
  const frame: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    maxWidth: "100%",
    paddingLeft: 9,
    paddingRight: props.onRemove ? 4 : 9,
    minHeight: 26,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: props.selected ? c.accent : props.tone && props.tone !== "neutral" ? tint(color, 0.4) : c.border,
    backgroundColor: props.selected ? tint(c.accent, 0.12) : props.tone && props.tone !== "neutral" ? tint(color, 0.08) : c.surface2,
  };
  const remove = props.onRemove ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`移除 ${props.label}`}
      hitSlop={6}
      onPress={props.onRemove}
      style={{ padding: 3 }}
    >
      <Icon name="X" size={12} color={c.foregroundMuted} />
    </Pressable>
  ) : null;
  if (!props.onPress)
    return (
      <View style={frame}>
        {body}
        {remove}
      </View>
    );
  return (
    <View style={frame}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.hint ?? props.label}
        accessibilityState={{ selected: !!props.selected }}
        onPress={props.onPress}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          flexShrink: 1,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {body}
      </Pressable>
      {remove}
    </View>
  );
}

export function StatusPill({ status }: { status: string | null | undefined }) {
  const { theme } = useKit();
  const { label, tone } = statusOf(status);
  const color = toneColor(theme, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 9,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: tint(color, 0.12),
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Banner(props: {
  tone: Tone;
  icon?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const { theme } = useKit();
  const color = toneColor(theme, props.tone);
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 10,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: tint(color, 0.35),
        backgroundColor: tint(color, 0.08),
      }}
    >
      <View style={{ paddingTop: 1 }}>
        <Icon name={props.icon ?? "Info"} size={16} color={color} />
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{props.title}</Text>
        {props.children}
        {props.actions ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{props.actions}</View> : null}
      </View>
    </View>
  );
}

export function Section(props: {
  title: string;
  icon?: string;
  subtitle?: string;
  /** Sits right after the subtitle, e.g. a filter tag. */
  badge?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const { s } = useKit();
  return (
    <View style={{ gap: 10 }}>
      <View style={s.spread}>
        <View style={[s.row, { flexShrink: 1 }]}>
          {props.icon ? <Glyph name={props.icon} size={16} /> : null}
          <Text style={s.h2}>{props.title}</Text>
          {props.subtitle ? <Text style={s.muted}>{props.subtitle}</Text> : null}
          {props.badge}
        </View>
        {props.trailing}
      </View>
      {props.children}
    </View>
  );
}

export function Stat(props: { label: string; value: string | number; icon: string; tone?: Tone; style?: StyleProp<ViewStyle> }) {
  const { theme, s } = useKit();
  const color = toneColor(theme, props.tone ?? "neutral");
  return (
    <View style={[s.card, { gap: 6, paddingVertical: 12, flexGrow: 1, flexBasis: 120 }, props.style]}>
      <View style={s.row}>
        <Icon name={props.icon} size={14} color={color} />
        <Text style={s.muted}>{props.label}</Text>
      </View>
      <Text style={{ color: props.tone && props.tone !== "neutral" ? color : theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>
        {props.value}
      </Text>
    </View>
  );
}

/** Key/value line with an icon, used for compact metadata. */
export function Meta(props: { icon: string; label: string; children: ReactNode }) {
  const { s } = useKit();
  return (
    <View style={[s.row, { alignItems: "flex-start" }]}>
      <View style={{ paddingTop: 1 }}>
        <Glyph name={props.icon} size={13} />
      </View>
      <Text style={[s.muted, { width: 56 }]}>{props.label}</Text>
      <View style={{ flex: 1 }}>{props.children}</View>
    </View>
  );
}

export function Checkbox({ checked }: { checked: boolean }) {
  const { theme } = useKit();
  const c = theme.colors;
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 5,
        borderWidth: 1.5,
        borderColor: checked ? c.accent : c.border,
        backgroundColor: checked ? c.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked ? <Icon name="Check" size={12} color={c.accentForeground} /> : null}
    </View>
  );
}
