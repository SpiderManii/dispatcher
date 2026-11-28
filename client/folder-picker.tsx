import { useRpc } from "@getpaseo/plugin/client";
import { Loading, TextInput } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { browseRpc } from "../shared/contracts";
import { Banner, Button, Checkbox, Chip, Glyph, basename, errorText, useKit } from "./ui";
import { isWeb, parsePastedPaths, resolveByName, useFileDrop } from "./web-drop";
import { WideModal } from "./wide-modal";

/**
 * Adds project folders. Where dragging works, drop several from Finder at once and that is all. Clients that can't
 * drag (phones) keep the paste box and a folder browser on the daemon host; browsing runs over RPC.
 */
export function FolderPicker(props: {
  open: boolean;
  initialSelection: string[];
  /** Folders the plugin already knows (registered repos), for drops that only carry a folder name. */
  known?: string[];
  onClose: () => void;
  onDone: (paths: string[]) => void;
}) {
  const { theme, s } = useKit();
  const browse = useRpc(browseRpc);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [showHidden, setShowHidden] = useState(false);
  const [picked, setPicked] = useState<string[]>(props.initialSelection);
  const [jump, setJump] = useState("");
  const [pasted, setPasted] = useState("");
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [others, setOthers] = useState<string[]>([]);
  const [hover, setHover] = useState(false);
  const dropRef = useRef<View>(null);

  useEffect(() => {
    if (props.open) {
      setPicked(props.initialSelection);
      setPasted("");
      setUnresolved([]);
      setOthers([]);
    }
    // Only reset when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const listing = useQuery({
    queryKey: ["dispatch-center", "browse", current ?? "~", showHidden],
    queryFn: () => browse({ path: current, showHidden }),
    enabled: props.open,
    placeholderData: keepPreviousData,
  });

  const toggle = (folder: string) =>
    setPicked((list) => (list.includes(folder) ? list.filter((item) => item !== folder) : [...list, folder]));
  const add = (folders: string[]) => setPicked((list) => [...list, ...folders.filter((folder) => !list.includes(folder))]);

  const data = listing.data;
  const here = data?.path;

  useFileDrop(
    dropRef,
    {
      onHover: setHover,
      onDrop: (dropped) => {
        const known = [
          ...(props.known ?? []),
          ...(data?.shortcuts.map((item) => item.path) ?? []),
          ...(data?.entries.map((item) => item.path) ?? []),
        ];
        const { paths, unresolved: names } = resolveByName(dropped.folders, known);
        add(paths);
        setUnresolved(names);
        setOthers([...dropped.others, ...dropped.images.map((image) => image.name)]);
      },
    },
    props.open,
  );
  const pastedPaths = parsePastedPaths(pasted);
  // Where dragging works, it is the one way in. The paste box comes back only when a drop carried names but no full path.
  const showPaste = !isWeb || unresolved.length > 0;

  return (
    <WideModal title="添加项目" open={props.open} onClose={props.onClose} width={760}>
      <>
        <Text style={s.muted}>可一次加多个：前后端同时改、跨项目联调时把相关仓库一起加上。</Text>

        {isWeb ? (
          <View
            ref={dropRef}
            style={[
              s.inset,
              {
                alignItems: "center",
                gap: 6,
                paddingVertical: 22,
                borderWidth: 1.5,
                borderStyle: "dashed",
                borderColor: hover ? (theme.colors.accent ?? theme.colors.foreground) : theme.colors.border,
              },
            ]}
          >
            <Glyph name="FolderInput" size={22} tone={hover ? "accent" : "neutral"} />
            <Text style={s.text}>把项目文件夹从访达拖到这里</Text>
            <Text style={s.muted}>可以一次选中多个文件夹一起拖</Text>
          </View>
        ) : null}
        {unresolved.length > 0 ? (
          <Banner tone="warning" icon="TriangleAlert" title="有文件夹拿不到完整路径">
            <Text style={s.small}>
              {unresolved.join("、")}
              ：拖放只带来了文件夹名，没认出是哪个目录。请在访达里选中它们按 ⌥⌘C 拷贝路径，粘贴到下面。
            </Text>
          </Banner>
        ) : null}
        {others.length > 0 ? (
          <Text style={[s.small, { color: theme.colors.statusWarning }]}>
            只收文件夹，已忽略：{others.join("、")}
          </Text>
        ) : null}

        {showPaste ? (
        <View style={{ gap: 6 }}>
          <Text style={s.muted}>{isWeb ? "粘贴路径" : "或粘贴路径"}（访达里选中多个文件夹，按 ⌥⌘C 拷贝路径名，一行一个）</Text>
          <TextInput
            accessibilityLabel="粘贴项目路径"
            placeholder={"~/code/shop-backend\n~/code/shop-frontend"}
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline
            value={pasted}
            onChangeText={setPasted}
            autoCapitalize="none"
            autoCorrect={false}
            style={s.input}
          />
          {pastedPaths.length > 0 ? (
            <View style={[s.row, { justifyContent: "flex-end" }]}>
              <Button
                small
                icon="FolderPlus"
                label={`加入这 ${pastedPaths.length} 个`}
                onPress={() => {
                  add(pastedPaths);
                  setPasted("");
                }}
              />
            </View>
          ) : null}
        </View>
        ) : null}

        {!isWeb ? (
          <>
        <Text style={s.muted}>或在下面浏览：点文件夹名进入，点勾选框选中。</Text>

        {data && data.shortcuts.length > 0 ? (
          <View style={{ gap: 6 }}>
            <Text style={s.muted}>快捷位置</Text>
            <View style={s.wrap}>
              {data.shortcuts.map((item) => (
                <Chip
                  key={item.path}
                  label={item.label}
                  icon={item.source === "registry" ? "BookMarked" : item.source === "paseo" ? "FolderGit2" : "House"}
                  selected={picked.includes(item.path)}
                  onPress={() => (item.source === "home" ? setCurrent(item.path) : toggle(item.path))}
                  hint={item.source === "home" ? "打开主目录" : `勾选 ${item.path}`}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View style={s.row}>
          <TextInput
            accessibilityLabel="输入路径跳转"
            placeholder="输入路径跳转，如 ~/code"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={jump}
            onChangeText={setJump}
            onSubmitEditing={() => {
              if (jump.trim()) setCurrent(jump.trim());
            }}
            autoCapitalize="none"
            autoCorrect={false}
            style={s.singleInput}
          />
          <Button small icon="CornerDownLeft" label="前往" disabled={!jump.trim()} onPress={() => setCurrent(jump.trim())} />
        </View>

        <View style={[s.inset, { gap: 4 }]}>
          <View style={s.spread}>
            <View style={[s.row, { flex: 1 }]}>
              <Button
                small
                icon="ArrowUp"
                hint="上一级"
                disabled={!data?.parent}
                onPress={() => data?.parent && setCurrent(data.parent)}
              />
              <Text style={[s.mono, { flex: 1 }]} numberOfLines={1} selectable>
                {here ?? "…"}
              </Text>
            </View>
            <Chip
              label="隐藏文件夹"
              icon={showHidden ? "Eye" : "EyeOff"}
              selected={showHidden}
              onPress={() => setShowHidden((value) => !value)}
            />
          </View>
          {here ? (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: picked.includes(here) }}
              onPress={() => toggle(here)}
              style={[s.row, { paddingVertical: 6 }]}
            >
              <Checkbox checked={picked.includes(here)} />
              <Text style={s.small}>选中当前文件夹「{basename(here)}」</Text>
              {data?.isGit ? <Chip label="git" icon="GitBranch" tone="success" /> : null}
            </Pressable>
          ) : null}
        </View>

        {listing.isError ? (
          <Banner tone="danger" icon="CircleAlert" title="无法打开">
            <Text style={s.small}>{errorText(listing.error)}</Text>
          </Banner>
        ) : null}
        {listing.isPending ? <Loading /> : null}

        {data ? (
          <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden" }}>
            {data.entries.length === 0 ? (
              <Text style={[s.muted, { padding: 12 }]}>没有子文件夹</Text>
            ) : (
              data.entries.map((entry, index) => {
                const checked = picked.includes(entry.path);
                return (
                  <View
                    key={entry.path}
                    style={[
                      s.row,
                      {
                        paddingHorizontal: 10,
                        minHeight: 40,
                        borderTopWidth: index === 0 ? 0 : 1,
                        borderTopColor: theme.colors.border,
                        backgroundColor: checked ? theme.colors.surface2 : "transparent",
                      },
                    ]}
                  >
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={`勾选 ${entry.name}`}
                      accessibilityState={{ checked }}
                      hitSlop={8}
                      onPress={() => toggle(entry.path)}
                    >
                      <Checkbox checked={checked} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`打开 ${entry.name}`}
                      onPress={() => setCurrent(entry.path)}
                      style={({ pressed }) => [s.row, { flex: 1, paddingVertical: 10, opacity: pressed ? 0.6 : 1 }]}
                    >
                      <Glyph name={entry.isGit ? "FolderGit2" : "Folder"} tone={entry.isGit ? "success" : "neutral"} />
                      <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>
                        {entry.name}
                      </Text>
                      <Glyph name="ChevronRight" size={14} />
                    </Pressable>
                  </View>
                );
              })
            )}
          </View>
        ) : null}
        {data?.truncated ? <Text style={s.muted}>文件夹过多，只列出前 500 个，可输入路径跳转。</Text> : null}
          </>
        ) : null}

        {picked.length > 0 ? (
          <View style={{ gap: 6 }}>
            <Text style={s.muted}>已选 {picked.length} 个</Text>
            <View style={s.wrap}>
              {picked.map((folder) => (
                <Chip key={folder} label={basename(folder)} icon="Folder" selected onRemove={() => toggle(folder)} />
              ))}
            </View>
          </View>
        ) : null}

        <View style={[s.row, { justifyContent: "flex-end" }]}>
          <Button label="取消" variant="ghost" onPress={props.onClose} />
          <Button
            label={picked.length > 0 ? `确定（${picked.length}）` : "确定"}
            icon="Check"
            variant="primary"
            onPress={() => props.onDone(picked)}
          />
        </View>
      </>
    </WideModal>
  );
}
