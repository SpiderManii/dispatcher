// Pure helpers for adding project folders; no React Native imports, so they run under plain Node tests.

/** A dropped folder. `path` is null when the client only learns its name. */
export interface DroppedFolder {
  name: string;
  path: string | null;
}

/**
 * Reads paths pasted one per line, as Finder's "Copy as Pathname" (⌥⌘C) gives them for several folders.
 * Accepts quoted paths and file:// URLs; blank lines are skipped.
 */
export function parsePastedPaths(text: string): string[] {
  const paths = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(['"])(.*)\1$/, "$2"))
    .filter(Boolean)
    .map((line) => {
      if (!line.startsWith("file://")) return line;
      try {
        return decodeURIComponent(line.slice("file://".length));
      } catch {
        return line.slice("file://".length);
      }
    })
    .map((line) => (line.length > 1 ? line.replace(/\/+$/, "") : line));
  return [...new Set(paths)];
}

/**
 * When the client only learns a dropped folder's name, matches it against folders the plugin already knows.
 * A name that matches none, or several, stays unresolved for the user to paste instead.
 */
export function resolveByName(
  folders: DroppedFolder[],
  known: string[],
): { paths: string[]; unresolved: string[] } {
  const paths: string[] = [];
  const unresolved: string[] = [];
  for (const folder of folders) {
    if (folder.path) {
      paths.push(folder.path);
      continue;
    }
    const matches = [...new Set(known.filter((item) => item.replace(/\/+$/, "").split("/").pop() === folder.name))];
    if (matches.length === 1) paths.push(matches[0]);
    else unresolved.push(folder.name);
  }
  return { paths, unresolved };
}
