import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  providerCatalogRpc,
  saveAgentsRpc,
  type CandidateInput,
  type ProviderCatalog,
  type RolesView,
} from "../shared/contracts";
import { WideModal } from "./wide-modal";
import { Banner, Button, Chip, Glyph, errorText, tint, useKit } from "./ui";

/**
 * One launch config being edited. `provider` here is the provider ID alone; the model sits apart and the two join
 * back into Paseo's `provider/model` form on save.
 */
interface LaunchDraft {
  kind: "auto" | "provider" | "profile";
  provider: string;
  model: string;
  thinking: string;
  mode: string;
  profile: string;
}

interface RoleDraft {
  key: string;
  id: string;
  /** Existing roles keep their ID: the dispatcher's rules and worker labels refer to it. */
  locked: boolean;
  name: string;
  when: string;
  candidates: (LaunchDraft & { key: string })[];
}

const ROLE_ID = /^[a-z][a-z0-9-]*$/;
let serial = 0;
const nextKey = () => `k${++serial}`;

const emptyLaunch = (kind: LaunchDraft["kind"]): LaunchDraft => ({
  kind,
  provider: "",
  model: "",
  thinking: "",
  mode: "",
  profile: "",
});

function splitReference(reference: string) {
  const slash = reference.indexOf("/");
  return slash < 0 ? { provider: reference, model: "" } : { provider: reference.slice(0, slash), model: reference.slice(slash + 1) };
}

function fromCandidate(source: CandidateInput): LaunchDraft {
  if (source.profile) return { ...emptyLaunch("profile"), profile: source.profile, thinking: source.thinkingOptionId ?? "", mode: source.modeId ?? "" };
  return {
    ...emptyLaunch("provider"),
    ...splitReference(source.provider ?? ""),
    thinking: source.thinkingOptionId ?? "",
    mode: source.modeId ?? "",
  };
}

function toCandidate(draft: LaunchDraft): CandidateInput {
  const extra = {
    ...(draft.thinking ? { thinkingOptionId: draft.thinking } : {}),
    ...(draft.mode ? { modeId: draft.mode } : {}),
  };
  if (draft.kind === "profile") return { profile: draft.profile, ...extra };
  return { provider: draft.model ? `${draft.provider}/${draft.model}` : draft.provider, ...extra };
}

function launchProblem(draft: LaunchDraft): string | null {
  if (draft.kind === "provider" && !draft.provider) return "没选 provider";
  if (draft.kind === "profile" && !draft.profile) return "没选 Agent 配置";
  return null;
}

interface Option {
  id: string;
  label: string;
  hint?: string;
}

/** A labelled select that unfolds in place. Lists longer than eight get a filter box. */
function Picker(props: {
  label: string;
  value: string;
  options: Option[];
  onChange: (id: string) => void;
  /** Shown, and offered as the first option, when nothing is chosen. */
  noneLabel?: string;
  disabled?: boolean;
}) {
  const { theme, s } = useKit();
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const chosen = props.options.find((option) => option.id === props.value);
  const shown = chosen?.label ?? (props.value ? props.value : props.noneLabel ?? "请选择");
  const needle = filter.trim().toLowerCase();
  const options = needle
    ? props.options.filter((option) => `${option.id} ${option.label}`.toLowerCase().includes(needle))
    : props.options;
  const pick = (id: string) => {
    props.onChange(id);
    setOpen(false);
    setFilter("");
  };
  const row = (id: string, label: string, hint?: string) => (
    <Pressable
      key={id || "__none"}
      accessibilityRole="button"
      accessibilityState={{ selected: id === props.value }}
      onPress={() => pick(id)}
      style={({ pressed }) => ({
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 6,
        backgroundColor: id === props.value ? tint(c.accent, 0.12) : pressed ? c.surface2 : "transparent",
      })}
    >
      <Text style={{ color: id === props.value ? c.accent : c.foreground, fontSize: 13 }} numberOfLines={1}>
        {label}
      </Text>
      {hint ? (
        <Text style={s.muted} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
  return (
    <View style={{ gap: 4, flexGrow: 1, flexBasis: 180, minWidth: 150 }}>
      <Text style={s.muted}>{props.label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}：${shown}`}
        disabled={props.disabled}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          minHeight: 34,
          paddingHorizontal: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: open ? c.accent : c.border,
          backgroundColor: c.surface2,
          opacity: props.disabled ? 0.45 : pressed ? 0.75 : 1,
        })}
      >
        <Text style={{ flex: 1, color: chosen || props.value ? c.foreground : c.foregroundMuted, fontSize: 13 }} numberOfLines={1}>
          {shown}
        </Text>
        <Glyph name={open ? "ChevronUp" : "ChevronDown"} size={13} />
      </Pressable>
      {open ? (
        <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface1, padding: 4, gap: 4 }}>
          {props.options.length > 8 ? (
            <TextInput
              value={filter}
              onChangeText={setFilter}
              placeholder="筛选"
              placeholderTextColor={c.foregroundMuted}
              autoFocus
              style={[s.singleInput, { flex: 0 }]}
            />
          ) : null}
          <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
            {props.noneLabel !== undefined && !needle ? row("", props.noneLabel) : null}
            {options.map((option) => row(option.id, option.label, option.hint))}
            {options.length === 0 ? <Text style={[s.muted, { padding: 8 }]}>没有匹配的选项</Text> : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

/** Provider → model → thinking → mode, or a Paseo Agent config by name. */
function LaunchFields(props: {
  draft: LaunchDraft;
  onChange: (next: LaunchDraft) => void;
  catalog: ProviderCatalog;
  profiles: RolesView["profiles"];
}) {
  const { draft, onChange, catalog, profiles } = props;
  const provider = catalog.find((item) => item.id === draft.provider);
  const model = provider?.models.find((item) => item.id === draft.model);
  const defaultModel = provider?.models.find((item) => item.isDefault) ?? provider?.models[0];
  const thinkingSource = model ?? (draft.model ? undefined : defaultModel);
  const providerOptions: Option[] = catalog.map((item) => ({
    id: item.id,
    label: item.label,
    hint: !item.enabled ? "未启用" : item.status !== "ready" ? `不可用（${item.status}）` : `${item.models.length} 个模型`,
  }));
  if (draft.provider && !provider) providerOptions.push({ id: draft.provider, label: draft.provider, hint: "Paseo 里没有这个 provider" });
  const modelOptions: Option[] = (provider?.models ?? []).map((item) => ({
    id: item.id,
    label: item.label,
    hint: item.id === item.label ? undefined : item.id,
  }));
  if (draft.model && !model) modelOptions.push({ id: draft.model, label: draft.model, hint: "当前列表里没有" });
  const thinkingOptions: Option[] = (thinkingSource?.thinking ?? []).map((item) => ({ id: item.id, label: item.label }));
  if (draft.thinking && !thinkingOptions.some((item) => item.id === draft.thinking))
    thinkingOptions.push({ id: draft.thinking, label: draft.thinking });
  const modeOptions: Option[] = (provider?.modes ?? []).map((item) => ({ id: item.id, label: item.label }));
  if (draft.mode && !modeOptions.some((item) => item.id === draft.mode)) modeOptions.push({ id: draft.mode, label: draft.mode });
  const defaultMode = provider?.modes.find((item) => item.id === provider.defaultModeId);

  if (draft.kind === "profile") {
    const profileOptions = profiles.map((item) => ({ id: item.id, label: item.name, hint: item.provider }));
    if (draft.profile && !profiles.some((item) => item.id === draft.profile || item.name === draft.profile))
      profileOptions.push({ id: draft.profile, label: draft.profile, hint: "Paseo 里找不到" });
    const matched = profiles.find((item) => item.id === draft.profile || item.name === draft.profile);
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
        <Picker
          label="Paseo Agent 配置"
          value={matched?.id ?? draft.profile}
          options={profileOptions}
          onChange={(profile) => onChange({ ...draft, profile })}
        />
        {matched ? (
          <Button
            small
            icon="Wand2"
            label="改成直接选模型"
            hint="把这个 Agent 配置的 provider、模型、思考强度和模式抄过来，以后不再依赖它"
            onPress={() =>
              onChange({
                ...emptyLaunch("provider"),
                ...splitReference(matched.provider),
                thinking: draft.thinking || matched.thinkingOptionId || "",
                mode: draft.mode || matched.modeId || "",
              })
            }
          />
        ) : null}
      </View>
    );
  }
  if (draft.kind === "auto") return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      <Picker
        label="Provider"
        value={draft.provider}
        options={providerOptions}
        onChange={(id) => onChange({ ...draft, provider: id, model: "", thinking: "", mode: "" })}
      />
      <Picker
        label="模型"
        value={draft.model}
        options={modelOptions}
        noneLabel={defaultModel ? `默认（${defaultModel.label}）` : "默认"}
        disabled={!draft.provider}
        onChange={(id) => onChange({ ...draft, model: id, thinking: "" })}
      />
      <Picker
        label="思考强度"
        value={draft.thinking}
        options={thinkingOptions}
        noneLabel={thinkingSource?.defaultThinking ? `默认（${thinkingSource.defaultThinking}）` : "默认"}
        disabled={!draft.provider || thinkingOptions.length === 0}
        onChange={(id) => onChange({ ...draft, thinking: id })}
      />
      <Picker
        label="模式"
        value={draft.mode}
        options={modeOptions}
        noneLabel={defaultMode ? `默认（${defaultMode.label}）` : "默认"}
        disabled={!draft.provider || modeOptions.length === 0}
        onChange={(id) => onChange({ ...draft, mode: id })}
      />
    </View>
  );
}

function rolesFrom(view: RolesView): RoleDraft[] {
  return view.roles.map((role) => ({
    key: nextKey(),
    id: role.id,
    locked: true,
    name: role.name,
    when: role.when,
    candidates: role.candidates.map((candidate) => ({ key: nextKey(), ...fromCandidate(candidate.source) })),
  }));
}

function dispatchersFrom(view: RolesView): Record<string, LaunchDraft> {
  return Object.fromEntries(
    view.dispatchers.map((dispatcher) => {
      const { provider, profileId, modeId, thinkingOptionId } = dispatcher.source;
      const base = { thinking: thinkingOptionId ?? "", mode: modeId ?? "" };
      if (provider) return [dispatcher.id, { ...emptyLaunch("provider"), ...splitReference(provider), ...base }];
      if (profileId) return [dispatcher.id, { ...emptyLaunch("profile"), profile: profileId, ...base }];
      return [dispatcher.id, { ...emptyLaunch("auto"), ...base }];
    }),
  );
}

function freshRoleId(roles: RoleDraft[]): string {
  for (let index = 1; ; index += 1) {
    const id = `role-${index}`;
    if (!roles.some((role) => role.id === id)) return id;
  }
}

/** Sets every role's models and every dispatcher's launch config in place, written back to 项目登记.json. */
export function AgentsEditor({ view, open, onClose }: { view: RolesView; open: boolean; onClose: () => void }) {
  const { theme, s } = useKit();
  const c = theme.colors;
  const queryClient = useQueryClient();
  const loadCatalog = useRpc(providerCatalogRpc);
  const save = useRpc(saveAgentsRpc);
  const [refresh, setRefresh] = useState(false);
  const catalog = useQuery({
    queryKey: ["dispatch-center", "provider-catalog", refresh],
    queryFn: () => loadCatalog({ refresh }),
    enabled: open,
    staleTime: 30_000,
  });
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const [dispatchers, setDispatchers] = useState<Record<string, LaunchDraft>>({});
  const [resetRoles, setResetRoles] = useState(false);

  // Each opening starts from what is saved now, not from an abandoned draft.
  useEffect(() => {
    if (!open) return;
    setRoles(rolesFrom(view));
    setDispatchers(dispatchersFrom(view));
    setResetRoles(false);
  }, [open]);

  const providers = catalog.data?.providers ?? [];
  const problems = useMemo(() => {
    const found: string[] = [];
    if (!resetRoles) {
      const ids = new Set<string>();
      for (const role of roles) {
        const name = role.name.trim() || role.id;
        if (!ROLE_ID.test(role.id)) found.push(`角色「${name}」的 ID 只能用小写字母、数字和连字符，且以字母开头`);
        if (ids.has(role.id)) found.push(`角色 ID 重复：${role.id}`);
        ids.add(role.id);
        if (!role.name.trim()) found.push(`角色 ${role.id} 没写名称`);
        if (!role.when.trim()) found.push(`角色「${name}」没写适用场景`);
        role.candidates.forEach((candidate, index) => {
          const problem = launchProblem(candidate);
          if (problem) found.push(`角色「${name}」第 ${index + 1} 个模型${problem}`);
        });
      }
      if (roles.length === 0) found.push("至少要留一个角色");
    }
    for (const dispatcher of view.dispatchers) {
      const draft = dispatchers[dispatcher.id];
      const problem = draft ? launchProblem(draft) : null;
      if (problem) found.push(`调度员「${dispatcher.name}」${problem}`);
    }
    return found;
  }, [roles, dispatchers, resetRoles, view.dispatchers]);

  const mutation = useMutation({
    mutationFn: () =>
      save({
        roles: resetRoles
          ? null
          : roles.map((role) => ({
              id: role.id,
              name: role.name.trim(),
              when: role.when.trim(),
              candidates: role.candidates.map(toCandidate),
            })),
        dispatchers: view.dispatchers.map((dispatcher) => {
          const draft = dispatchers[dispatcher.id] ?? emptyLaunch("auto");
          const candidate = draft.kind === "auto" ? null : toCandidate(draft);
          return {
            id: dispatcher.id,
            provider: candidate?.provider ?? null,
            profileId: candidate?.profile ?? null,
            modeId: draft.mode || null,
            thinkingOptionId: draft.thinking || null,
          };
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dispatch-center", "roles"] });
      onClose();
    },
  });

  const updateRole = (key: string, change: (role: RoleDraft) => RoleDraft) =>
    setRoles((list) => list.map((role) => (role.key === key ? change(role) : role)));
  const moveCandidate = (role: RoleDraft, index: number, by: number) => {
    const list = [...role.candidates];
    const [item] = list.splice(index, 1);
    list.splice(index + by, 0, item);
    updateRole(role.key, (current) => ({ ...current, candidates: list }));
  };
  const hasProfiles = view.profiles.length > 0;

  const card = { gap: 10, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 } as const;

  return (
    <WideModal title="设置 Agent 分工" open={open} onClose={onClose} width={1080}>
      <Text style={[s.muted, { lineHeight: 18 }]}>
        直接在这里给每个角色选 provider、模型和思考强度，不用先去 Paseo 设置里建 Agent 配置。一个角色可以排几个模型，派单时按顺序用第一个可用的；一个都不设就用第一个就绪的 provider。保存后写进项目登记.json，下一次派单生效，在跑的会话不受影响。
      </Text>

      {catalog.isLoading ? <Text style={s.muted}>正在读取 provider 和模型列表…</Text> : null}
      {catalog.error || catalog.data?.error ? (
        <Banner tone="warning" icon="TriangleAlert" title="读不到 provider 列表">
          <Text style={s.small}>{catalog.data?.error ?? errorText(catalog.error)}</Text>
        </Banner>
      ) : null}
      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button
          small
          variant="ghost"
          icon="RefreshCw"
          label="重新检测 provider"
          loading={catalog.isFetching}
          onPress={() => (refresh ? void catalog.refetch() : setRefresh(true))}
        />
      </View>

      <Text style={s.h3}>调度员</Text>
      {view.dispatchers.map((dispatcher) => {
        const draft = dispatchers[dispatcher.id] ?? emptyLaunch("auto");
        const set = (next: LaunchDraft) => setDispatchers((all) => ({ ...all, [dispatcher.id]: next }));
        return (
          <View key={dispatcher.id} style={card}>
            <View style={s.spread}>
              <Text style={s.h3}>{dispatcher.name}</Text>
              <Text style={s.muted}>现在：{dispatcher.launch.ok ? dispatcher.launch.label : dispatcher.launch.problem}</Text>
            </View>
            <View style={s.wrap}>
              <Chip label="自动" selected={draft.kind === "auto"} onPress={() => set({ ...emptyLaunch("auto") })} hint="用第一个就绪的 provider" />
              <Chip label="直接选模型" selected={draft.kind === "provider"} onPress={() => set({ ...emptyLaunch("provider") })} />
              {hasProfiles || draft.kind === "profile" ? (
                <Chip label="Paseo Agent 配置" selected={draft.kind === "profile"} onPress={() => set({ ...emptyLaunch("profile") })} />
              ) : null}
            </View>
            <LaunchFields draft={draft} onChange={set} catalog={providers} profiles={view.profiles} />
          </View>
        );
      })}

      <View style={[s.spread, { marginTop: 4 }]}>
        <Text style={s.h3}>角色</Text>
        {resetRoles ? (
          <Button small variant="ghost" icon="Undo2" label="不恢复了" onPress={() => setResetRoles(false)} />
        ) : view.customRoles ? (
          <Button small variant="ghost" icon="RotateCcw" label="恢复默认分工表" onPress={() => setResetRoles(true)} />
        ) : null}
      </View>
      {resetRoles ? (
        <Banner tone="warning" icon="RotateCcw" title="保存后回到内置分工表">
          <Text style={s.small}>项目登记.json 里的 roles 会被删掉，七个内置角色都先用第一个就绪的 provider。</Text>
        </Banner>
      ) : (
        <>
          {roles.map((role) => (
            <View key={role.key} style={card}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
                <View style={{ gap: 4, flexGrow: 1, flexBasis: 160 }}>
                  <Text style={s.muted}>名称</Text>
                  <TextInput
                    value={role.name}
                    onChangeText={(name) => updateRole(role.key, (current) => ({ ...current, name }))}
                    placeholder="如：后端"
                    placeholderTextColor={c.foregroundMuted}
                    style={[s.singleInput, { flex: 0 }]}
                  />
                </View>
                <View style={{ gap: 4, flexGrow: 1, flexBasis: 160 }}>
                  <Text style={s.muted}>ID{role.locked ? "（调度员按它派单，不能改）" : ""}</Text>
                  {role.locked ? (
                    <Text style={[s.mono, { minHeight: 34, paddingTop: 9 }]}>{role.id}</Text>
                  ) : (
                    <TextInput
                      value={role.id}
                      onChangeText={(id) => updateRole(role.key, (current) => ({ ...current, id: id.trim() }))}
                      autoCapitalize="none"
                      placeholder="如：backend"
                      placeholderTextColor={c.foregroundMuted}
                      style={[s.singleInput, { flex: 0 }]}
                    />
                  )}
                </View>
                <Button
                  small
                  variant="danger"
                  icon="Trash2"
                  label="删除角色"
                  onPress={() => setRoles((list) => list.filter((item) => item.key !== role.key))}
                />
              </View>
              <View style={{ gap: 4 }}>
                <Text style={s.muted}>适用场景（调度员靠这句判断活归谁）</Text>
                <TextInput
                  value={role.when}
                  onChangeText={(when) => updateRole(role.key, (current) => ({ ...current, when }))}
                  multiline
                  placeholder="如：写后端代码、排查接口和日志"
                  placeholderTextColor={c.foregroundMuted}
                  style={[s.input, { minHeight: 56 }]}
                />
              </View>
              <Text style={s.muted}>模型（按顺序尝试，前一个不可用或被调度员避开时用下一个）</Text>
              {role.candidates.length === 0 ? (
                <Text style={s.small}>未设置：派单时用第一个就绪的 provider。</Text>
              ) : null}
              {role.candidates.map((candidate, index) => (
                <View
                  key={candidate.key}
                  style={{ gap: 8, padding: 10, borderRadius: 10, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border }}
                >
                  <View style={s.spread}>
                    <Text style={s.small}>{index === 0 ? "首选" : `备选 ${index}`}</Text>
                    <View style={s.row}>
                      <Button small variant="ghost" icon="ArrowUp" hint="上移" disabled={index === 0} onPress={() => moveCandidate(role, index, -1)} />
                      <Button
                        small
                        variant="ghost"
                        icon="ArrowDown"
                        hint="下移"
                        disabled={index === role.candidates.length - 1}
                        onPress={() => moveCandidate(role, index, 1)}
                      />
                      <Button
                        small
                        variant="ghost"
                        icon="X"
                        hint="移除"
                        onPress={() =>
                          updateRole(role.key, (current) => ({
                            ...current,
                            candidates: current.candidates.filter((item) => item.key !== candidate.key),
                          }))
                        }
                      />
                    </View>
                  </View>
                  <LaunchFields
                    draft={candidate}
                    catalog={providers}
                    profiles={view.profiles}
                    onChange={(next) =>
                      updateRole(role.key, (current) => ({
                        ...current,
                        candidates: current.candidates.map((item) => (item.key === candidate.key ? { ...next, key: item.key } : item)),
                      }))
                    }
                  />
                </View>
              ))}
              <View style={s.wrap}>
                <Button
                  small
                  icon="Plus"
                  label={role.candidates.length === 0 ? "选模型" : "加一个备选"}
                  onPress={() =>
                    updateRole(role.key, (current) => ({
                      ...current,
                      candidates: [...current.candidates, { key: nextKey(), ...emptyLaunch("provider") }],
                    }))
                  }
                />
                {hasProfiles ? (
                  <Button
                    small
                    variant="ghost"
                    icon="Plus"
                    label="用 Paseo Agent 配置"
                    onPress={() =>
                      updateRole(role.key, (current) => ({
                        ...current,
                        candidates: [...current.candidates, { key: nextKey(), ...emptyLaunch("profile") }],
                      }))
                    }
                  />
                ) : null}
              </View>
            </View>
          ))}
          <View style={s.row}>
            <Button
              icon="Plus"
              label="添加角色"
              onPress={() =>
                setRoles((list) => [...list, { key: nextKey(), id: freshRoleId(list), locked: false, name: "", when: "", candidates: [] }])
              }
            />
          </View>
        </>
      )}

      {problems.length > 0 ? (
        <Banner tone="warning" icon="TriangleAlert" title="还不能保存">
          {problems.map((problem) => (
            <Text key={problem} style={s.small}>
              {problem}
            </Text>
          ))}
        </Banner>
      ) : null}
      {mutation.error ? (
        <Banner tone="danger" icon="TriangleAlert" title="保存失败">
          <Text style={s.small}>{errorText(mutation.error)}</Text>
        </Banner>
      ) : null}
      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button label="取消" variant="ghost" onPress={onClose} />
        <Button
          label="保存"
          variant="primary"
          icon="Check"
          loading={mutation.isPending}
          disabled={problems.length > 0}
          onPress={() => mutation.mutate()}
        />
      </View>
    </WideModal>
  );
}
