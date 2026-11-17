import { execFileSync } from "node:child_process";

export interface PluginBuild {
  commit: string | null;
  /** Tracked files differ from that commit, so what runs is not exactly it. */
  dirty: boolean;
  loadedAt: string;
}

/** Read once when the plugin loads, so the page can show which code a reload actually picked up. */
export function readPluginBuild(directory: string | null, now = new Date()): PluginBuild {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: directory ?? undefined, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!directory) return { commit: null, dirty: false, loadedAt: now.toISOString() };
  try {
    return {
      commit: run(["rev-parse", "--short", "HEAD"]),
      dirty: run(["status", "--porcelain", "--untracked-files=no"]) !== "",
      loadedAt: now.toISOString(),
    };
  } catch {
    return { commit: null, dirty: false, loadedAt: now.toISOString() };
  }
}
