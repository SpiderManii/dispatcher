// Drag-and-drop, paste and file picking for the desktop (web) client.
// The plugin's tsconfig has no DOM lib, so the few browser types used here are declared locally.
// Everything is a no-op on native clients, where `Platform.OS` is not "web".
import { useEffect, type RefObject } from "react";
import { Platform } from "react-native";
import type { DroppedFolder } from "./paths";

export { parsePastedPaths, resolveByName } from "./paths";

export const isWeb = Platform.OS === "web";

interface WebFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  /** Electron's absolute path for a file dropped from Finder; absent in newer Electron and in browsers. */
  readonly path?: string;
}
interface WebEntry {
  readonly isDirectory: boolean;
}
interface WebItem {
  readonly kind: string;
  getAsFile(): WebFile | null;
  webkitGetAsEntry?(): WebEntry | null;
}
interface WebDataTransfer {
  readonly items?: ArrayLike<WebItem>;
  readonly files?: ArrayLike<WebFile>;
  dropEffect?: string;
}
interface WebEvent {
  readonly dataTransfer?: WebDataTransfer | null;
  readonly clipboardData?: WebDataTransfer | null;
  preventDefault(): void;
  stopPropagation(): void;
}
interface WebNode {
  addEventListener(type: string, listener: (event: WebEvent) => void): void;
  removeEventListener(type: string, listener: (event: WebEvent) => void): void;
  contains?(other: unknown): boolean;
}

const web = globalThis as unknown as {
  document?: { createElement(tag: string): any };
  FileReader?: new () => { onload: (() => void) | null; onerror: (() => void) | null; result: unknown; readAsDataURL(file: WebFile): void };
};

/** An image ready to send: base64 without the `data:` prefix, plus a data URI for the thumbnail. */
export interface PickedImage {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  uri: string;
  bytes: number;
}

export interface Dropped {
  folders: DroppedFolder[];
  images: WebFile[];
  /** Names of dropped files that are neither folders nor images. */
  others: string[];
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function sortItems(transfer: WebDataTransfer | null | undefined): Dropped {
  const dropped: Dropped = { folders: [], images: [], others: [] };
  if (!transfer) return dropped;
  const items = Array.from(transfer.items ?? []);
  // Items carry the directory flag; fall back to the plain file list when a client gives no items.
  const entries =
    items.length > 0
      ? items.filter((item) => item.kind === "file").map((item) => ({ file: item.getAsFile(), entry: item.webkitGetAsEntry?.() ?? null }))
      : Array.from(transfer.files ?? []).map((file) => ({ file, entry: null }));
  for (const { file, entry } of entries) {
    if (!file) continue;
    if (entry?.isDirectory) dropped.folders.push({ name: file.name, path: file.path || null });
    else if (IMAGE_TYPES.has(file.type)) dropped.images.push(file);
    else dropped.others.push(file.name);
  }
  return dropped;
}

/**
 * Makes the node a drop target (and optionally a paste target) for files. `onHover` reports whether a drag
 * is over it, for highlighting. Must be called with a ref to a host View, which is a DOM node on web.
 */
export function useFileDrop(
  ref: RefObject<unknown>,
  handlers: { onDrop?: (dropped: Dropped) => void; onPaste?: (dropped: Dropped) => void; onHover?: (over: boolean) => void },
  enabled = true,
): void {
  useEffect(() => {
    const node = ref.current as WebNode | null;
    if (!isWeb || !enabled || !node || typeof node.addEventListener !== "function") return;
    const over = (event: WebEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      handlers.onHover?.(true);
    };
    const leave = (event: WebEvent & { relatedTarget?: unknown }) => {
      // Moving onto a child fires dragleave on the parent; only a real exit ends the hover.
      if (event.relatedTarget && node.contains?.(event.relatedTarget)) return;
      handlers.onHover?.(false);
    };
    const drop = (event: WebEvent) => {
      event.preventDefault();
      event.stopPropagation();
      handlers.onHover?.(false);
      handlers.onDrop?.(sortItems(event.dataTransfer));
    };
    const paste = (event: WebEvent) => {
      const dropped = sortItems(event.clipboardData);
      if (dropped.images.length === 0) return; // plain text pastes go to the text box as usual
      event.preventDefault();
      handlers.onPaste?.(dropped);
    };
    node.addEventListener("dragover", over);
    node.addEventListener("dragleave", leave);
    node.addEventListener("drop", drop);
    if (handlers.onPaste) node.addEventListener("paste", paste);
    return () => {
      node.removeEventListener("dragover", over);
      node.removeEventListener("dragleave", leave);
      node.removeEventListener("drop", drop);
      node.removeEventListener("paste", paste);
    };
  });
}

let nextId = 0;

export function readImage(file: WebFile): Promise<PickedImage> {
  return new Promise((resolve, reject) => {
    if (!web.FileReader) return reject(new Error("当前客户端不支持读取图片"));
    const reader = new web.FileReader();
    reader.onload = () => {
      const uri = String(reader.result);
      const comma = uri.indexOf(",");
      resolve({
        id: `img-${Date.now()}-${nextId++}`,
        name: file.name || "粘贴的图片",
        mimeType: file.type,
        data: uri.slice(comma + 1),
        uri,
        bytes: file.size,
      });
    };
    reader.onerror = () => reject(new Error(`读不了图片 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Opens the system file dialog for images. Resolves with nothing when cancelled or off the web. */
export function chooseImages(): Promise<WebFile[]> {
  return new Promise((resolve) => {
    if (!isWeb || !web.document) return resolve([]);
    const input = web.document.createElement("input");
    input.type = "file";
    input.accept = [...IMAGE_TYPES].join(",");
    input.multiple = true;
    input.onchange = () => resolve(Array.from((input.files ?? []) as ArrayLike<WebFile>));
    input.click();
  });
}
