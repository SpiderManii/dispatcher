import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import {
  assignRpc,
  enqueueRpc,
  resolveTargetsRpc,
  type BranchChoice,
  type LaneView,
  type Overview,
  type TargetView,
} from "../shared/contracts";
import { BranchPicker } from "./branch-picker";
import { laneLabel } from "./lane-row";
import { FolderPicker } from "./folder-picker";
import { Banner, Button, Chip, Glyph, basename, errorText, shortId, useKit } from "./ui";
import { chooseImages, isWeb, readImage, resolveByName, useFileDrop, type Dropped, type PickedImage } from "./web-drop";

/** Mirrors IMAGE_LIMITS on the server, which has the final say. */
const IMAGE_MAX = { count: 6, bytes: 5 * 1024 * 1024, totalBytes: 12 * 1024 * 1024 };

const BUSY = new Set(["running", "initializing"]);

type Mode = { kind: "lane"; laneId: string } | { kind: "new" };

const keyOf = (target: TargetView) => target.projectId ?? `dir:${target.path}`;

/**
 * The main entry: pick one or more project folders and optionally their branches, pick the dispatcher,
 * describe the task, and open a new lane for it — or hand it to an existing lane if the user picks one.
 */
export function AssignPanel(props: {
  data: Overview;
  onAssigned: (result: { agentId: string }) => void;
  refresh: () => void;
}) {
  const { theme, s } = useKit();
  const toast = useToast();
  const callResolve = useRpc(resolveTargetsRpc);
  const callAssign = useRpc(assignRpc);
  const callEnqueue = useRpc(enqueueRpc);

  const [selected, setSelected] = useState<string[]>([]);
  const [chosenDispatcher, setChosenDispatcher] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [acceptance, setAcceptance] = useState("");
  // Optional, and folded away until asked for: most requirements go out without one.
  const [showAcceptance, setShowAcceptance] = useState(false);
  // New work opens a new lane; carrying on in an existing one is an explicit choice.
  const [mode, setMode] = useState<Mode>({ kind: "new" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [branchChoices, setBranchChoices] = useState<Record<string, BranchChoice>>({});
  const [images, setImages] = useState<PickedImage[]>([]);
  const [dropHover, setDropHover] = useState(false);
  const panelRef = useRef<View>(null);

  const resolved = useQuery({
    queryKey: ["dispatch-center", "resolve", [...selected].sort(), props.data.checkedAt],
    queryFn: () => callResolve({ paths: selected }),
    enabled: selected.length > 0,
    placeholderData: keepPreviousData,
  });
  const targets: TargetView[] = selected.length > 0 ? (resolved.data?.targets ?? []) : [];
  const dispatcherId =
    chosenDispatcher ?? resolved.data?.suggestedDispatcherId ?? props.data.dispatchers[0]?.id ?? null;
  const dispatcher = props.data.dispatchers.find((item) => item.id === dispatcherId) ?? null;
  const lanes = dispatcher?.lanes ?? [];
  const totalLanes = props.data.dispatchers.reduce((sum, item) => sum + item.lanes.length, 0);
  const { sessions: maxLanes, sessionsPerProject: maxPerProject } = props.data.limits;

  const registered = useMemo(
    () =>
      props.data.dispatchers.flatMap((owner) =>
        owner.projects.flatMap((project) =>
          project.repos.map((repo) => ({
            key: `${project.id}:${repo}`,
            label: project.repos.length > 1 ? `${project.name} · ${basename(repo)}` : project.name,
            path: repo,
          })),
        ),
      ),
    [props.data.dispatchers],
  );

  const addImageFiles = async (files: Dropped["images"]) => {
    if (files.length === 0) return;
    const room = IMAGE_MAX.count - images.length;
    if (room <= 0) return toast.error(`最多附 ${IMAGE_MAX.count} 张图`);
    const tooBig = files.filter((file) => file.size > IMAGE_MAX.bytes);
    const accepted = files.filter((file) => file.size <= IMAGE_MAX.bytes).slice(0, room);
    try {
      const read = await Promise.all(accepted.map(readImage));
      setImages((list) => {
        const next = [...list, ...read];
        const total = next.reduce((sum, image) => sum + image.bytes, 0);
        if (total > IMAGE_MAX.totalBytes) {
          toast.error(`图片合计超过 ${IMAGE_MAX.totalBytes / 1024 / 1024}MB，未加入`);
          return list;
        }
        return next;
      });
    } catch (error) {
      toast.error(errorText(error));
    }
    const skipped = [
      ...tooBig.map((file) => `${file.name}（超过 ${IMAGE_MAX.bytes / 1024 / 1024}MB）`),
      ...(files.length - tooBig.length > room ? [`超出 ${IMAGE_MAX.count} 张的部分`] : []),
    ];
    if (skipped.length > 0) toast.error(`未加入：${skipped.join("、")}`);
  };

  // Dropping on the panel: images attach to the task, folders join the selection.
  useFileDrop(panelRef, {
    onHover: setDropHover,
    onPaste: (dropped) => void addImageFiles(dropped.images),
    onDrop: (dropped) => {
      void addImageFiles(dropped.images);
      const { paths, unresolved } = resolveByName(dropped.folders, registered.map((item) => item.path));
      const fresh = paths.filter((folder) => !isSelected(folder));
      if (fresh.length > 0) changeSelection([...selected, ...fresh]);
      if (unresolved.length > 0)
        toast.error(`${unresolved.join("、")} 拿不到完整路径，请点「添加项目」把它拖进去或粘贴路径`);
      if (dropped.others.length > 0) toast.error(`只收图片和文件夹，已忽略：${dropped.others.join("、")}`);
    },
  });

  // --- Routing preview (mirrors planRoute on the server, which has the final say) ---
  const held = targets.filter((target) => !target.owner || target.owner === dispatcherId);
  const heldKeys = held.map(keyOf);
  const covering = lanes.filter((lane) => heldKeys.every((key) => lane.projects.some((p) => p.key === key)));
  const effective = mode;
  const lane: LaneView | null = effective.kind === "lane" ? (lanes.find((l) => l.id === effective.laneId) ?? null) : null;
  const incoming = lane ? held.filter((target) => !lane.projects.some((p) => p.key === keyOf(target))) : held;
  const others = (target: TargetView) => target.holders.filter((holder) => holder.laneId !== lane?.id);
  const full = incoming.filter((target) => others(target).length >= maxPerProject);
  const shared = incoming.filter((target) => others(target).length > 0);
  const laneBusy = !!lane?.agent?.status && BUSY.has(lane.agent.status);
  const missing = targets.filter((target) => !target.exists);
  const crossOwner = targets.filter((target) => target.owner && target.owner !== dispatcherId);
  const unregistered = targets.filter((target) => !target.projectId);
  const unconfigured = targets.filter((target) => target.projectId && !target.configured);

  // Only folders this dispatcher may work on carry a branch; a stale choice for a removed folder is ignored.
  const chosenBranches = Object.fromEntries(
    held.flatMap((target) => (branchChoices[target.path] ? [[target.path, branchChoices[target.path]] as const] : [])),
  );
  const unnamedBranch = held.find((target) => branchChoices[target.path]?.name.trim() === "");
  // Another lane on the same branch is allowed: this lane then works on a temporary branch cut from it.
  const sameBranchHolders = (target: TargetView) =>
    others(target).filter((holder) => holder.branch && holder.branch === branchChoices[target.path]?.name);
  const sameBranch = held.filter((target) => sameBranchHolders(target).length > 0);
  const toConfirm = [...shared, ...sameBranch.filter((target) => !shared.includes(target))];

  let blocker: string | null = null;
  // A new requirement that only lacks a free slot is queued instead of refused; it starts when one frees up.
  let queueReason: string | null = null;
  if (!dispatcher) blocker = "没有可用的调度员";
  else if (missing.length > 0) blocker = "有文件夹不存在";
  else if (unnamedBranch) blocker = `请填写 ${unnamedBranch.name} 的新分支名`;
  else if (effective.kind === "new" && totalLanes >= maxLanes) queueReason = `并行已满（${totalLanes}/${maxLanes}）`;
  else if (full.length > 0 && effective.kind === "new")
    queueReason = `${full.map((t) => t.name).join("、")} 已有 ${maxPerProject} 个需求在做`;
  else if (full.length > 0)
    blocker = `${full.map((t) => t.name).join("、")} 已有 ${maxPerProject} 个需求在做，先归档做完的，或补充到其中一个`;
  else if (lane?.pendingHandoff) blocker = `会话线 ${lane.id} 正在换班`;
  else if (laneBusy) blocker = `需求「${laneLabel(lane!)}」的调度员正在执行，等本轮结束再补充`;
  const queueing = !blocker && queueReason !== null;
  const queueAhead = props.data.queue.length;
  const needsConfirm = !blocker && toConfirm.length > 0;
  // No tick-box any more: the new lane runs a read-only 拆分 pre-check first and the plugin refuses overlapping cards.
  const blocked = !!blocker;

  const routeText = !dispatcher
    ? ""
    : effective.kind === "lane" && lane
      ? `补充到需求「${laneLabel(lane)}」（${lane.id} · ${shortId(lane.agentId)}）${
          incoming.length > 0 ? `，这条线新增 ${incoming.map((t) => t.name).join("、")}` : ""
        }`
      : queueing
        ? `${queueReason}：先排队${queueAhead > 0 ? `，前面还有 ${queueAhead} 个` : ""}，有空位自动开始`
        : effective.kind === "new"
          ? `开一条新会话线做这个需求（现有 ${totalLanes}/${maxLanes}）`
          : "";

  const reset = () => {
    setMode({ kind: "new" });
  };

  const assign = useMutation({
    mutationFn: callAssign,
    onSuccess: (result) => {
      toast.show(
        result.delivery === "sent"
          ? `已发给会话线 ${result.laneId}（${shortId(result.agentId)}）`
          : `已开会话线 ${result.laneId}（${shortId(result.agentId)}）并交付`,
        { variant: "success" },
      );
      setTask("");
      setAcceptance("");
      setShowAcceptance(false);
      setBranchChoices({});
      setImages([]);
      reset();
      props.onAssigned(result);
      props.refresh();
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const enqueue = useMutation({
    mutationFn: callEnqueue,
    onSuccess: (result) => {
      toast.show(result.started ? "刚好有空位，已经开始" : `已排队，第 ${result.position} 个；有空位自动开始`, { variant: "success" });
      setTask("");
      setAcceptance("");
      setShowAcceptance(false);
      setBranchChoices({});
      setImages([]);
      reset();
      props.refresh();
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const changeSelection = (next: string[]) => {
    setSelected(next);
    reset();
  };
  const isSelected = (folder: string) =>
    selected.includes(folder) || targets.some((target) => target.path === folder);
  const toggle = (folder: string) => {
    if (isSelected(folder)) {
      const canonical = targets.find((target) => target.path === folder)?.path;
      changeSelection(selected.filter((item) => item !== folder && item !== canonical));
    } else changeSelection([...selected, folder]);
  };
  const removeTarget = (target: TargetView) => {
    const next = selected.filter((item) => item !== target.path);
    if (next.length !== selected.length) return changeSelection(next);
    // The raw path may differ from the canonical one (symlinks, "~"); drop whichever resolved to it.
    const index = targets.findIndex((item) => item.path === target.path);
    changeSelection(selected.filter((_, i) => i !== index));
  };

  return (
    <View
      ref={panelRef}
      style={[s.card, { gap: 14 }, dropHover ? { borderColor: theme.colors.accent ?? theme.colors.foreground } : null]}
    >
      <View style={s.spread}>
        <View style={s.row}>
          <Glyph name="Send" size={16} tone="accent" />
          <Text style={s.h2}>新需求</Text>
        </View>
        <Text style={s.muted}>
          并行 {totalLanes}/{maxLanes} · 同一项目最多 {maxPerProject} 个
        </Text>
      </View>

      <View style={{ gap: 6 }}>
        <View style={s.row}>
          <Glyph name="BookMarked" size={13} />
          <Text style={s.muted}>{registered.length > 0 ? "已登记项目（可多选）" : "项目文件夹"}</Text>
        </View>
        <View style={s.wrap}>
          {registered.map((item) => (
            <Chip key={item.key} label={item.label} icon="FolderGit2" selected={isSelected(item.path)} onPress={() => toggle(item.path)} />
          ))}
          <Button small icon="FolderPlus" label="添加项目" onPress={() => setPickerOpen(true)} />
        </View>
      </View>

      {targets.length > 0 ? (
        <View style={[s.inset, { gap: 10 }]}>
          <View style={s.spread}>
            <Text style={s.h3}>
              本次目标 {targets.length} 个{targets.length > 1 ? " · 协同任务" : ""}
            </Text>
            <Button small variant="ghost" icon="X" label="清空" onPress={() => changeSelection([])} />
          </View>
          {targets.map((target) => (
            <View key={target.path} style={[s.row, { alignItems: "flex-start" }]}>
              <View style={{ paddingTop: 2 }}>
                <Glyph name={target.isGit ? "FolderGit2" : "Folder"} tone={target.exists ? "accent" : "danger"} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={s.wrap}>
                  <Text style={s.text}>{target.name}</Text>
                  {target.projectId ? <Chip label={target.projectId} icon="Tag" /> : <Chip label="未登记" icon="CircleHelp" tone="warning" />}
                  {target.projectId && !target.configured ? <Chip label="说明未配置" tone="warning" /> : null}
                  {target.owner && target.owner !== dispatcherId ? (
                    <Chip label={`由 ${target.ownerName} 负责`} icon="UserRound" tone="warning" />
                  ) : null}
                  {target.holders.length > 0 ? (
                    <Chip
                      label={`${target.holders.length} 条线在做`}
                      icon="GitBranch"
                      tone={target.holders.length >= maxPerProject ? "warning" : "accent"}
                    />
                  ) : null}
                  {!target.exists ? <Chip label="不存在" tone="danger" /> : null}
                </View>
                <Text style={s.mono} numberOfLines={1} selectable>
                  {target.path}
                </Text>
                {held.includes(target) ? (
                  <BranchPicker
                    target={target}
                    value={branchChoices[target.path] ?? null}
                    holders={others(target)}
                    onChange={(value) =>
                      setBranchChoices(({ [target.path]: _previous, ...rest }) =>
                        value ? { ...rest, [target.path]: value } : rest,
                      )
                    }
                  />
                ) : null}
              </View>
              <Button small variant="ghost" icon="X" hint={`移除 ${target.name}`} onPress={() => removeTarget(target)} />
            </View>
          ))}
        </View>
      ) : null}

      {crossOwner.length > 0 ? (
        <Banner tone="warning" icon="Users" title="部分项目不归所选调度员负责">
          <Text style={s.small}>
            {crossOwner.map((t) => `${t.name}（${t.ownerName}）`).join("、")}
            ：所选调度员不会为它派单，只整理需要配合的接口回报给你转交。要统一派单，请改选负责调度员或调整登记。
          </Text>
        </Banner>
      ) : null}
      {unregistered.length > 0 || unconfigured.length > 0 ? (
        <Banner tone="warning" icon="TriangleAlert" title="有项目缺少项目说明">
          <Text style={s.small}>
            {[...unregistered, ...unconfigured].map((t) => t.name).join("、")}
            ：调度员按规则会先停手上报，等你补齐 PROJECT.md 或在「registry.json」里登记后再推进这部分。
          </Text>
        </Banner>
      ) : null}

      {props.data.dispatchers.length > 1 ? (
        <View style={{ gap: 6 }}>
          <Text style={s.muted}>交给</Text>
          <View style={s.wrap}>
            {props.data.dispatchers.map((item) => (
              <Chip
                key={item.id}
                label={item.name}
                icon="Radar"
                selected={item.id === dispatcherId}
                trailing={item.id === resolved.data?.suggestedDispatcherId ? "推荐" : undefined}
                onPress={() => {
                  setChosenDispatcher(item.id);
                  reset();
                }}
              />
            ))}
          </View>
        </View>
      ) : null}

      {targets.length > 0 && dispatcher ? (
        <View style={{ gap: 6 }}>
          <Text style={s.muted}>新需求，还是补充到进行中的需求</Text>
          <View style={s.wrap}>
            {lanes.map((item) => (
              <Chip
                key={item.id}
                icon={item.projects.length > 1 ? "Layers" : "GitBranch"}
                label={laneLabel(item)}
                trailing={covering.some((c) => c.id === item.id) ? "同项目" : item.id}
                selected={effective.kind === "lane" && effective.laneId === item.id}
                onPress={() => {
                  setMode({ kind: "lane", laneId: item.id });
                }}
              />
            ))}
            <Chip
              icon="Plus"
              label="新需求"
              trailing={`${totalLanes}/${maxLanes}`}
              tone={totalLanes >= maxLanes ? "warning" : "neutral"}
              selected={effective.kind === "new"}
              onPress={() => setMode({ kind: "new" })}
            />
          </View>
        </View>
      ) : null}

      {needsConfirm ? (
        <Banner tone="accent" icon="GitFork" title="同一项目将有多条会话线并行">
          {toConfirm.map((target) => (
            <Text key={target.path} style={s.small}>
              · {target.name}：
              {others(target)
                .map((holder) => `会话线 ${holder.laneId}${holder.summary ? `在做「${holder.summary}」` : ""}`)
                .join("；")}
              {sameBranch.includes(target)
                ? `。两条线都在分支 ${branchChoices[target.path].name} 上：本线会从它拉临时分支施工，验收后合回（合回要你点头）`
                : ""}
            </Text>
          ))}
          <Text style={s.muted}>
            开工前先派「拆分」只读预检改动范围；和别的线改同一批文件时，插件会拒派并停下来问你，不会自动替你答复。
          </Text>
        </Banner>
      ) : null}

      <TextInput
        accessibilityLabel="本次需求"
        placeholder={
          targets.length > 1
            ? "描述这次协同的需求，例如：后端新增 /api/orders 接口，前端订单页接入并联调"
            : "描述本次需求（可留空，调度员会先回报项目现状）"
        }
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
        value={task}
        onChangeText={setTask}
        style={s.input}
      />
      {showAcceptance ? (
        <TextInput
          accessibilityLabel="验收标准"
          placeholder="验收标准：怎样算做完，一行一条。如：列表页能按分类筛选；单测通过；线上能看到新列"
          placeholderTextColor={theme.colors.foregroundMuted}
          multiline
          autoFocus
          value={acceptance}
          onChangeText={setAcceptance}
          style={[s.input, { minHeight: 52 }]}
        />
      ) : null}

      <View style={{ gap: 6 }}>
        <View style={s.row}>
          <Button
            small
            variant="ghost"
            icon={showAcceptance ? "X" : "ClipboardCheck"}
            label={showAcceptance ? "不写验收标准" : "验收标准"}
            hint={showAcceptance ? "收起并清空验收标准" : "可选：写怎样算做完，调度员按它验收"}
            onPress={() => {
              if (showAcceptance) setAcceptance("");
              setShowAcceptance(!showAcceptance);
            }}
          />
          {isWeb ? (
            <>
              <Button
                small
                variant="ghost"
                icon="ImagePlus"
                label={images.length > 0 ? `图片 ${images.length}/${IMAGE_MAX.count}` : "图片"}
                hint={`添加图片，最多 ${IMAGE_MAX.count} 张；也可以 ⌘V 粘贴或拖进来`}
                disabled={images.length >= IMAGE_MAX.count}
                onPress={() => void chooseImages().then(addImageFiles)}
              />
              {images.length === 0 ? <Text style={s.muted}>可粘贴或拖入</Text> : null}
            </>
          ) : null}
        </View>
        {isWeb && images.length > 0 ? (
          <View style={[s.wrap, { gap: 10, paddingTop: 6, paddingRight: 6 }]}>
            {images.map((image) => (
              <View key={image.id} style={{ width: 72, height: 56 }}>
                <Image
                  source={{ uri: image.uri }}
                  accessibilityLabel={image.name}
                  style={{ width: 72, height: 56, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border }}
                  resizeMode="cover"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`移除 ${image.name}`}
                  hitSlop={6}
                  onPress={() => setImages((list) => list.filter((item) => item.id !== image.id))}
                  style={({ pressed }) => ({
                    position: "absolute",
                    top: -6,
                    right: -6,
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: theme.colors.surface1,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Glyph name="X" size={11} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <View style={[s.spread, { flexWrap: "wrap" }]}>
        <View style={[s.row, { flexShrink: 1, flexWrap: "wrap" }]}>
          <Glyph
            name={blocker ? "CircleSlash" : queueing ? "Clock" : "ArrowRight"}
            size={13}
            tone={blocker || queueing ? "warning" : "neutral"}
          />
          <Text style={[s.muted, { flexShrink: 1 }]}>
            {targets.length === 0 ? "先选项目" : (blocker ?? routeText)}
          </Text>
        </View>
        <Button
          variant="primary"
          icon={queueing ? "ListPlus" : effective.kind === "lane" ? "Send" : "Plus"}
          label={`${queueing ? "加入排队" : effective.kind === "lane" ? "补充到这个需求" : "开始新需求"}${targets.length > 1 ? `（${targets.length} 个项目）` : ""}`}
          disabled={targets.length === 0 || blocked || resolved.isFetching}
          loading={assign.isPending || enqueue.isPending}
          onPress={() => {
            if (!dispatcher) return;
            const common = {
              paths: targets.map((target) => target.path),
              dispatcherId: dispatcher.id,
              task: task.trim() || undefined,
              acceptance: acceptance.trim() || undefined,
              branches: Object.keys(chosenBranches).length > 0 ? chosenBranches : undefined,
              images: images.length > 0 ? images.map(({ name, mimeType, data }) => ({ name, mimeType, data })) : undefined,
            };
            if (queueing) enqueue.mutate(common);
            else
              assign.mutate({
                ...common,
                laneId: effective.kind === "lane" ? effective.laneId : undefined,
                newLane: effective.kind === "new" || undefined,
                confirmIndependent: needsConfirm || undefined,
              });
          }}
        />
      </View>
      {resolved.isError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{errorText(resolved.error)}</Text> : null}

      <FolderPicker
        open={pickerOpen}
        initialSelection={targets.map((target) => target.path)}
        known={registered.map((item) => item.path)}
        onClose={() => setPickerOpen(false)}
        onDone={(paths) => {
          changeSelection(paths);
          setPickerOpen(false);
        }}
      />
    </View>
  );
}
