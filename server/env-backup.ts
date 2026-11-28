import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** `.env`, `.env.local`, `.env.production`: the files that hold secrets and never reach the remote. Templates are tracked, not ignored. */
const ENV_FILE = /^\.env(\..+)?$/;
const TEMPLATE = /\.(example|sample|template|dist)$/;

/** The ignored paths git reported that are env files. Directories are never matched, so a folder named `.env` is left alone. */
export function envFilesOf(ignored: readonly string[]): string[] {
  return ignored.filter((item) => {
    const name = path.posix.basename(item);
    return ENV_FILE.test(name) && !TEMPLATE.test(name);
  });
}

export interface EnvBackup {
  directory: string;
  files: string[];
  /** An earlier backup of this branch already held exactly these files, so nothing new was written. */
  unchanged: boolean;
}

/** One path segment from a branch or project name: `feat/x` must not become a folder inside a folder. */
export function safeSegment(name: string): string {
  return name.replace(/[\\/:]/g, "__").replace(/^\.+/, "_").trim() || "_";
}

/** The newest earlier backup next to `destination` (same project and branch), if its files and contents all match. */
function sameAsLatest(destination: string, copies: { from: string; relative: string }[]): string | null {
  const parent = path.dirname(destination);
  if (!existsSync(parent)) return null;
  const latest = readdirSync(parent).filter((name) => name !== path.basename(destination)).sort().pop();
  if (!latest) return null;
  const previous = path.join(parent, latest);
  const kept = readdirSyncRecursive(previous);
  if (kept.length !== copies.length) return null;
  for (const { from, relative } of copies) {
    const old = path.join(previous, relative);
    if (!existsSync(old) || !readFileSync(from).equals(readFileSync(old))) return null;
  }
  return previous;
}

function readdirSyncRecursive(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? readdirSyncRecursive(path.join(directory, entry.name), path.join(prefix, entry.name)) : [path.join(prefix, entry.name)],
  );
}

/**
 * Copies the env files out of a directory that is about to be deleted, keeping their relative paths and keeping them
 * readable by the owner only. `label` may hold slashes: the layout is project/branch/time. Throws unless every copy is
 * verified, because the caller must not delete after a failure. null when there was nothing to copy.
 */
export function backupEnvFiles(source: string, files: readonly string[], destinationRoot: string, label: string): EnvBackup | null {
  const root = realpathSync(source);
  const copies: { from: string; to: string; relative: string }[] = [];
  const destination = path.join(destinationRoot, label);
  for (const relative of files) {
    const from = path.join(root, relative);
    let stat;
    try {
      stat = lstatSync(from);
    } catch {
      continue; // gone since the scan: nothing left to lose
    }
    if (!stat.isFile()) continue; // a symlink could point anywhere; a directory is not an env file
    if (!realpathSync(from).startsWith(root + path.sep)) continue;
    copies.push({ from, to: path.join(destination, relative), relative });
  }
  if (copies.length === 0) return null;
  const same = sameAsLatest(destination, copies);
  if (same) return { directory: same, files: copies.map((item) => item.relative), unchanged: true };
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  chmodSync(destinationRoot, 0o700);
  for (const { from, to } of copies) {
    mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
    chmodSync(to, 0o600);
    if (!readFileSync(from).equals(readFileSync(to))) throw new Error(`备份校验失败：${to}`);
  }
  return { directory: destination, files: copies.map((item) => item.relative), unchanged: false };
}
