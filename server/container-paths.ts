import os from "node:os";
import path from "node:path";

/** One `readOnlyDirs` entry from 项目登记.json. */
export interface ReadOnlyRule {
  provider: string;
  dirs: string[];
  statusDir?: string;
}

/**
 * Caught at dispatch: otherwise the worker finishes the job and only then fails to report it. A provider sees
 * `dirs` read-only (for example mounted `:ro` into its container), so a status file in there cannot be written.
 */
export function statusFileProblem(
  statusFile: string,
  provider: string,
  rules: ReadOnlyRule[] = [],
  home: string = os.homedir(),
): string | null {
  const resolve = (input: string) => path.resolve(input.replace(/^~(?=\/|$)/, home));
  const file = resolve(statusFile);
  for (const rule of rules) {
    if (!provider.includes(rule.provider)) continue;
    const blocked = rule.dirs.some((dir) => {
      const relative = path.relative(resolve(dir), file);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!blocked) continue;
    const instead = rule.statusDir ? `改写到 ${rule.statusDir}/ 下，结束后再拷回` : "换一个它能写的位置";
    return `状态文件 ${statusFile} 对 ${provider} 是只读的，写不进去。${instead}`;
  }
  return null;
}
