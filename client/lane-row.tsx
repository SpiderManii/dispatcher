import { Pressable, Text, View } from "react-native";
import type { LaneView } from "../shared/contracts";
import { Banner, Button, Chip, Glyph, StatusPill, duration, relativeTime, shortId, statusOf, toneColor, useKit } from "./ui";

const HANDOFF_SLOW_MS = 15 * 60_000;
const BUSY = new Set(["running", "initializing"]);

export interface CardActions {
  openAgent?: (agentId: string) => void;
  handoff: (lane: LaneView) => void;
  startSuccessor: (lane: LaneView) => void;
  cancelHandoff: (lane: LaneView) => void;
  archiveLane: (lane: LaneView) => void;
  dismissError: () => void;
  archive: (agentId: string) => void;
  openDoc: (path: string, title: string) => void;
  busy: boolean;
}

function Step({ done, active, label }: { done: boolean; active: boolean; label: string }) {
  const { theme, s } = useKit();
  const color = done ? theme.colors.statusSuccess : active ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return (
    <View style={[s.row, { gap: 6 }]}>
      <Glyph name={done ? "CircleCheck" : active ? "LoaderCircle" : "Circle"} size={14} color={color} />
      <Text style={{ color: done || active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12 }}>
        {label}
      </Text>
    </View>
  );
}

export function laneLabel(lane: LaneView): string {
  return lane.projects.length > 0 ? lane.projects.map((project) => project.name).join(" + ") : `会话线 ${lane.id}`;
}

export function LaneRow({
  lane,
  actions,
  dispatcherName,
}: {
  lane: LaneView;
  actions: CardActions;
  /** Shown only when several dispatchers share the list. */
  dispatcherName?: string;
}) {
  const { theme, s } = useKit();
  const agent = lane.agent;
  const status = agent?.status ?? null;
  const tone = statusOf(status).tone;
  const accent = toneColor(theme, tone);
  const pending = lane.pendingHandoff;
  const busy = status !== null && BUSY.has(status);
  const elapsed = pending ? Date.now() - Date.parse(pending.requestedAt) : 0;

  return (
    <View style={[s.card, { gap: 8, borderLeftWidth: 3, borderLeftColor: accent }]}>
      <View style={[s.spread, { alignItems: "flex-start" }]}>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={s.wrap}>
            <Glyph name={lane.projects.length > 1 ? "Layers" : "GitBranch"} size={14} color={accent} />
            <Text style={s.h3} numberOfLines={1}>
              {laneLabel(lane)}
            </Text>
            <Text style={s.mono}>
              {lane.id} · {shortId(lane.agentId)}
            </Text>
            {dispatcherName ? <Text style={s.muted}>{dispatcherName}</Text> : null}
            {lane.projects.map((project) =>
              project.branch ? <Chip key={project.key} icon="GitBranch" label={project.branch} /> : null,
            )}
          </View>
          {lane.summary ? (
            <Text style={s.small} numberOfLines={2}>
              {lane.summary}
            </Text>
          ) : null}
        </View>
        <StatusPill status={status} />
      </View>

      <View style={s.wrap}>
        {agent?.runningSince ? (
          <Chip label={`本轮已 ${duration(agent.runningSince)}`} icon="Timer" tone="accent" />
        ) : agent?.lastActivityAt ? (
          <Chip label={`活跃于 ${relativeTime(agent.lastActivityAt)}`} icon="Clock" />
        ) : null}
        {agent && agent.pendingPermissions > 0 ? (
          <Chip label={`待授权 ${agent.pendingPermissions}`} icon="ShieldAlert" tone="warning" />
        ) : agent?.requiresAttention ? (
          <Chip
            label={agent.attentionReason === "error" ? "需要处理" : "等你查看"}
            icon="BellRing"
            tone={agent.attentionReason === "error" ? "danger" : "warning"}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="查看本线台账"
          onPress={() => actions.openDoc(lane.ledger.path, `台账 · ${laneLabel(lane)}`)}
          style={({ pressed }) => [s.row, { gap: 10, opacity: pressed ? 0.6 : 1 }]}
        >
          <View style={s.row}>
            <Glyph name="Activity" size={13} tone={lane.runningWorkers ? "accent" : "neutral"} />
            <Text style={s.small}>在跑 {lane.runningWorkers ?? "—"}</Text>
          </View>
          <View style={s.row}>
            <Glyph name="Gavel" size={13} tone={lane.ledger.pendingDecisions > 0 ? "warning" : "neutral"} />
            <Text style={s.small}>待拍板 {lane.ledger.pendingDecisions}</Text>
          </View>
          <Text style={s.muted}>台账 {lane.ledger.exists ? relativeTime(lane.ledger.updatedAt) : "未生成"}</Text>
        </Pressable>
      </View>

      {agent?.lastError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }} numberOfLines={2}>
          {agent.lastError}
        </Text>
      ) : null}
      {!agent ? (
        <Text style={s.muted}>会话已不存在。可以在「指派任务」里发给这条线，会从本线台账重启；或者直接归档这条线。</Text>
      ) : null}

      {pending ? (
        <Banner
          tone="warning"
          icon="ArrowRightLeft"
          title={`${pending.written && !busy ? "交接就绪 · 等待手动接班" : "准备交接中"} · 已 ${duration(pending.requestedAt)}`}
          actions={
            <>
              {pending.written ? (
                <Button small icon="FileText" label="查看交接" onPress={() => actions.openDoc(pending.handoffPath, "交接")} />
              ) : null}
              {pending.written ? (
                <Button small variant="primary" icon="Play" label="手动启动接班" disabled={actions.busy || busy} onPress={() => actions.startSuccessor(lane)} />
              ) : null}
              <Button small variant="danger" icon="X" label="取消换班" onPress={() => actions.cancelHandoff(lane)} />
            </>
          }
        >
          <View style={{ gap: 4 }}>
            <Step done active={false} label={`已通知 ${shortId(pending.fromAgentId)} 写交接`} />
            <Step done={pending.written} active={!pending.written} label="旧调度员写交接、更新本线台账" />
            <Step done={false} active={pending.written} label="交接就绪后，由你手动启动接班（沿用本线项目与台账）" />
          </View>
          {elapsed > HANDOFF_SLOW_MS && (!pending.written || busy) ? (
            <Text style={s.small}>等得有点久了。打开旧会话看看是否卡住；确认它不会再写交接时，取消换班后归档或重新指派。</Text>
          ) : null}
        </Banner>
      ) : null}

      <View style={s.wrap}>
        {actions.openAgent && agent && status !== "archived" ? (
          <Button small variant="primary" icon="SquareArrowOutUpRight" label="打开" onPress={() => actions.openAgent?.(lane.agentId)} />
        ) : null}
        {agent && status !== "archived" ? (
          <Button
            small
            icon="ArrowRightLeft"
            label="准备交接"
            disabled={actions.busy || !!pending || busy}
            onPress={() => actions.handoff(lane)}
          />
        ) : null}
        <Button small icon="NotebookText" label="台账" onPress={() => actions.openDoc(lane.ledger.path, `台账 · ${laneLabel(lane)}`)} />
        {status !== "archived" ? (
          <Button
            small
            variant="ghost"
            icon="Archive"
            label="归档"
            hint="归档这个调度员会话和它派出的执行会话，释放名额和项目"
            disabled={actions.busy || !!pending || busy}
            onPress={() => actions.archiveLane(lane)}
          />
        ) : null}
      </View>
    </View>
  );
}
